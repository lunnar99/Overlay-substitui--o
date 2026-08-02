import http from 'http';

const LIGAS_DEFAULT = [
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.copa_do_brazil/scoreboard'
];

const FIREBASE_DB_URL = 'https://termosm-6fed5-default-rtdb.firebaseio.com';
const RENDER_PUBLIC_URL = 'https://derkfutoverlay.onrender.com';

// KEY DA LIVE-FOOTBALL-API
const LINEUP_KEY = "d721754541caf9f268719979490cd4471ebb48d8203e954a316e7225ab5a1c6a";

const eventosEnviados = new Set();
let ultimoAlvoId = '';

// PING AUTOMÁTICO A CADA 10 MINUTOS PARA IMPEDIR QUE O RENDER ENTRE EM SLEEP
setInterval(() => {
    fetch(RENDER_PUBLIC_URL)
        .then(() => console.log('⏰ [KEEP-ALIVE] Ping enviado para manter Render ativo.'))
        .catch(() => {});
}, 10 * 60 * 1000);

async function atualizarFirebase(endpoint, payload) {
    try { 
        await fetch(`${FIREBASE_DB_URL}/${endpoint}.json`, { 
            method: 'PUT', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ ...payload, timestamp: Date.now() }) 
        }); 
    } catch (e) {}
}

async function registrarLog(mensagem, tipo = 'info') {
    try { 
        await fetch(`${FIREBASE_DB_URL}/tv/logs.json`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ mensagem, tipo, timestamp: Date.now() }) 
        }); 
    } catch (e) {}
}

async function lerConfiguracaoAlvo() {
    try { 
        const res = await fetch(`${FIREBASE_DB_URL}/tv/config.json`); 
        return await res.json() || { tipo: 'time', alvo: 'Cruzeiro' }; 
    } catch (e) { 
        return { tipo: 'time', alvo: 'Cruzeiro' }; 
    }
}

export async function buscarERodarJogo() {
    try {
        const config = await lerConfiguracaoAlvo();

        if (config.alvo !== ultimoAlvoId) {
            eventosEnviados.clear();
            ultimoAlvoId = config.alvo;
            console.log(`[RENDER LOG] Novo Alvo Selecionado: ${config.alvo}`);
        }

        let todosEventos = [];
        for (const url of LIGAS_DEFAULT) {
            try {
                const res = await fetch(url);
                const data = await res.json();
                if (data.events) {
                    const slugLiga = data.leagues?.[0]?.slug || (url.includes('copa_do_brazil') ? 'bra.copa_do_brazil' : 'bra.1');
                    data.events.forEach(e => { e.slugDaLigaParaBusca = slugLiga; todosEventos.push(e); });
                }
            } catch (err) {}
        }

        let jogoEncontrado = null;
        for (const evento of todosEventos) {
            if (config.tipo === 'id' && String(evento.id) === String(config.alvo)) { 
                jogoEncontrado = evento; 
                break; 
            } else if (config.tipo === 'time') {
                const nomes = evento.competitions[0].competitors.map(c => c.team.name.toLowerCase());
                if (nomes.some(n => n.includes(config.alvo.toLowerCase()))) { 
                    jogoEncontrado = evento; 
                    break; 
                }
            }
        }

        console.log(`[RENDER LOG] Alvo: ${config.alvo} | Status: ${jogoEncontrado ? jogoEncontrado.status.type.state : 'NÃO ACHOU'}`);

        await atualizarFirebase('tv/debug', { 
            alvoBuscado: config.alvo, 
            jogosEncontradosNaAPI: todosEventos.length, 
            jogoAchado: jogoEncontrado ? `${jogoEncontrado.name} (${jogoEncontrado.status.type.state})` : "NÃO ACHOU NA LISTA ATUAL", 
            timestamp: Date.now() 
        });

        if (!jogoEncontrado) { 
            await atualizarFirebase('tv/placar', { status: 'off' }); 
            return 10000; 
        }

        const comp = jogoEncontrado.competitions[0];
        const timeCasa = comp.competitors.find(c => c.homeAway === 'home');
        const timeFora = comp.competitors.find(c => c.homeAway === 'away');
        const estadoJogo = comp.status?.type?.state || 'pre'; 
        const isHalftime = comp.status?.type?.name === 'STATUS_HALFTIME' || comp.status?.type?.detail === 'HT';

        if (estadoJogo === 'pre') {
            await atualizarFirebase('tv/placar', { status: 'pre', homeAbbr: timeCasa.team.abbreviation, awayAbbr: timeFora.team.abbreviation, homeScore: 0, awayScore: 0, clock: 'PRÉ-JOGO', period: 1 });
            return 10000;
        }
        else if (estadoJogo === 'in') {
            const relogio = (comp.status?.displayClock || "00:00").split('+')[0].replace(/'/g, ''); 

            await atualizarFirebase('tv/placar', {
                status: isHalftime ? 'halftime' : 'in',
                homeAbbr: timeCasa.team.abbreviation,
                awayAbbr: timeFora.team.abbreviation,
                homeScore: parseInt(timeCasa.score) || 0,
                awayScore: parseInt(timeFora.score) || 0,
                clock: isHalftime ? 'INT' : relogio,
                period: comp.status?.period || 1
            });

            const slugFinal = jogoEncontrado.slugDaLigaParaBusca || 'bra.1';
            const summaryApiUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/${slugFinal}/summary?event=${jogoEncontrado.id}`;
            try {
                const summaryRes = await fetch(summaryApiUrl);
                const summary = await summaryRes.json();

                (summary.keyEvents || []).forEach(evento => {
                    const idUnico = `${jogoEncontrado.id}_${evento.id}`;
                    if (eventosEnviados.has(idUnico)) return;

                    const siglaTime = (evento.team?.id === timeCasa.team.id) ? timeCasa.team.abbreviation : timeFora.team.abbreviation;
                    const tipoTexto = evento.type?.text?.toLowerCase() || '';

                    if (tipoTexto.includes('substitution') || evento.type?.id === '80') {
                        atualizarFirebase('substituicao', { team: siglaTime, out: { nome: evento.participants?.[1]?.athlete?.displayName || 'X', num: '--' }, in: { nome: evento.participants?.[0]?.athlete?.displayName || 'Y', num: '--' }, hide: false });
                        registrarLog(`🔄 Substituição (${siglaTime})`, 'info');
                        eventosEnviados.add(idUnico);
                    } else if (evento.type?.id === '1') { 
                        atualizarFirebase('tv/gol', { teamAbbr: siglaTime, jogador: evento.participants?.[0]?.athlete?.displayName || 'GOL', numero: '--' });
                        registrarLog(`⚽ GOL! (${siglaTime})`, 'success');
                        eventosEnviados.add(idUnico);
                    } else if (tipoTexto.includes('card')) { 
                        const cor = tipoTexto.includes('red') ? 'vermelho' : 'amarelo';
                        atualizarFirebase('tv/cartao', { teamAbbr: siglaTime, jogador: evento.participants?.[0]?.athlete?.displayName || 'Card', numero: '--', tipo: cor });
                        registrarLog(`🟨 Cartão ${cor.toUpperCase()} (${siglaTime})`, 'warning');
                        eventosEnviados.add(idUnico);
                    }
                });
            } catch (err) {}

            return 10000;
        } 
        else if (estadoJogo === 'post') {
            await atualizarFirebase('tv/placar', { status: 'post', homeAbbr: timeCasa.team.abbreviation, awayAbbr: timeFora.team.abbreviation, homeScore: parseInt(timeCasa.score) || 0, awayScore: parseInt(timeFora.score) || 0, clock: 'FIM DE JOGO' });
            return 30000;
        }
    } catch (e) {
        await atualizarFirebase('tv/placar', { status: 'erro' });
        return 30000;
    }
}

// BUSCA AUTOMÁTICA DA ESCALAÇÃO VIA LIVE-FOOTBALL-API (1 CRÉDITO)
async function buscarEscalacaoAutomatica(homeName, awayName, gameDateISO) {
    const agora = new Date();
    const dataJogo = new Date(gameDateISO);
    const difMinutos = (dataJogo - agora) / (1000 * 60);

    if (difMinutos > 20) {
        return { sucesso: false, mensagem: `Faltam ${Math.ceil(difMinutos)} min. Liberado apenas 20 min antes do jogo.` };
    }

    try {
        // STEP 1: Busca partidas do dia na Live-Football-API (Grátis) para encontrar o match_id
        const dateStr = dataJogo.toISOString().split('T')[0];
        const fixturesUrl = `https://live-football-api.com/api/v1/matches?key=${LINEUP_KEY}&date=${dateStr}`;
        const fixRes = await fetch(fixturesUrl);
        const fixData = await fixRes.json();

        let matchId = null;

        if (fixData.status && fixData.data) {
            const h = homeName.toLowerCase();
            const a = awayName.toLowerCase();

            const match = fixData.data.find(m => {
                const homeLive = (m.home_team?.name || m.home_name || '').toLowerCase();
                const awayLive = (m.away_team?.name || m.away_name || '').toLowerCase();
                return (homeLive.includes(h) || h.includes(homeLive)) && (awayLive.includes(a) || a.includes(awayLive));
            });

            if (match) matchId = match.id || match.match_id;
        }

        if (!matchId) {
            return { sucesso: false, mensagem: `Não encontramos a partida na lista da Live-Football-API hoje.` };
        }

        // STEP 2: Chamada oficial do endpoint de Lineups (CONSUME 1 CRÉDITO)
        const lineupUrl = `https://live-football-api.com/api/v1/matches/${matchId}/lineups?key=${LINEUP_KEY}`;
        const lineupRes = await fetch(lineupUrl);
        const json = await lineupRes.json();

        if (json.status && json.data) {
            await atualizarFirebase('tv/escalacao', { 
                home: json.data.home || json.data.localteam, 
                away: json.data.away || json.data.visitorteam, 
                timestamp: Date.now() 
            });
            return { sucesso: true, mensagem: "Escalação obtida com sucesso e salva no Firebase!", dadosBrutos: json.data };
        } else {
            return { sucesso: false, mensagem: json.message || "Escalação ainda não divulgada oficialmente." };
        }

    } catch (error) {
        return { sucesso: false, mensagem: "Falha de comunicação com a Live-Football-API." };
    }
}

async function start() { 
    let timeout = await buscarERodarJogo(); 
    setTimeout(start, timeout); 
}

const PORT = process.env.PORT || 10000;

http.createServer(async (req, res) => { 
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.url.startsWith('/escalacao')) {
        const urlParams = new URLSearchParams(req.url.split('?')[1]);
        const homeName = urlParams.get('home');
        const awayName = urlParams.get('away');
        const gameDate = urlParams.get('gameDate');

        const resultado = await buscarEscalacaoAutomatica(homeName, awayName, gameDate);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
        return;
    }

    res.writeHead(200); 
    res.end('Servidor Ativo'); 
}).listen(PORT, () => { 
    console.log(`[RENDER LOG] Servidor rodando na porta ${PORT}`);
    start(); 
});
