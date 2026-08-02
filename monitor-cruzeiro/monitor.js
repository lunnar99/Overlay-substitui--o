import http from 'http';

const LIGAS_DEFAULT = [
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.copa_do_brazil/scoreboard'
];

const FIREBASE_DB_URL = 'https://termosm-6fed5-default-rtdb.firebaseio.com';
const eventosEnviados = new Set();
let ultimoAlvoId = '';

async function atualizarFirebase(endpoint, payload) {
    try { await fetch(`${FIREBASE_DB_URL}/${endpoint}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, timestamp: Date.now() }) }); } catch (e) {}
}

async function registrarLog(mensagem, tipo = 'info') {
    try { await fetch(`${FIREBASE_DB_URL}/tv/logs.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mensagem, tipo, timestamp: Date.now() }) }); } catch (e) {}
}

async function lerConfiguracaoAlvo() {
    try { const res = await fetch(`${FIREBASE_DB_URL}/tv/config.json`); return await res.json() || { tipo: 'time', alvo: 'Cruzeiro' }; } 
    catch (e) { return { tipo: 'time', alvo: 'Cruzeiro' }; }
}

export async function buscarERodarJogo() {
    try {
        const config = await lerConfiguracaoAlvo();

        if (config.alvo !== ultimoAlvoId) {
            eventosEnviados.clear();
            ultimoAlvoId = config.alvo;
        }

        // SEM PARÂMETROS DE DATA COMPLEXOS QUE QUEBRAM A ESPN
        let urlsParaBuscar = LIGAS_DEFAULT;

        let todosEventos = [];
        for (const url of urlsParaBuscar) {
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
            if (config.tipo === 'id' && String(evento.id) === String(config.alvo)) { jogoEncontrado = evento; break; } 
            else if (config.tipo === 'time') {
                const nomes = evento.competitions[0].competitors.map(c => c.team.name.toLowerCase());
                if (nomes.some(n => n.includes(config.alvo.toLowerCase()))) { jogoEncontrado = evento; break; }
            }
        }

        // DEBUG NO CONSOLE
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

async function start() { let timeout = await buscarERodarJogo(); setTimeout(start, timeout); }
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.writeHead(200); res.end('Monitor Ativo'); }).listen(PORT, () => { start(); });
