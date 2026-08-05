import http from 'http';

const LIGAS_DEFAULT = [
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.copa_do_brazil/scoreboard'
];

const FIREBASE_DB_URL = 'https://termosm-6fed5-default-rtdb.firebaseio.com';
const RENDER_PUBLIC_URL = 'https://derkfutoverlay.onrender.com';
const LINEUP_KEY = "d721754541caf9f268719979490cd4471ebb48d8203e954a316e7225ab5a1c6a";

const eventosEnviados = new Set();
let ultimoAlvoId = '';

// ==========================================
// CONTROLE DE ENERGIA DO SISTEMA
// ==========================================
let systemActive = false;
let mainLoopTimer = null;
let keepAliveTimer = null;

function startKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
        fetch(RENDER_PUBLIC_URL).catch(() => {});
        console.log('⏰ [KEEP-ALIVE] Ping interno enviado.');
    }, 10 * 60 * 1000);
}

function stopKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    console.log('💤 [SLEEP] Auto-ping desativado. O Render vai hibernar.');
}

async function atualizarFirebase(endpoint, payload) {
    if (!systemActive && endpoint !== 'tv/system') return; // Bloqueia escritas se estiver OFF
    try { 
        await fetch(`${FIREBASE_DB_URL}/${endpoint}.json`, { 
            method: 'PUT', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ ...payload, timestamp: Date.now() }) 
        }); 
    } catch (e) {}
}

async function registrarLog(mensagem, tipo = 'info') {
    if (!systemActive) return;
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
    if (!systemActive) return 30000;

    try {
        const config = await lerConfiguracaoAlvo();

        if (config.alvo !== ultimoAlvoId) {
            eventosEnviados.clear();
            ultimoAlvoId = config.alvo;
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
            if (config.tipo === 'id' && String(evento.id) === String(config.alvo)) { jogoEncontrado = evento; break; } 
            else if (config.tipo === 'time') {
                const nomes = evento.competitions[0].competitors.map(c => c.team.name.toLowerCase());
                if (nomes.some(n => n.includes(config.alvo.toLowerCase()))) { jogoEncontrado = evento; break; }
            }
        }

        await atualizarFirebase('tv/debug', { alvoBuscado: config.alvo, jogosEncontradosNaAPI: todosEventos.length, jogoAchado: jogoEncontrado ? `${jogoEncontrado.name} (${jogoEncontrado.status.type.state})` : "NÃO ACHOU", timestamp: Date.now() });

        if (!jogoEncontrado) { await atualizarFirebase('tv/placar', { status: 'off' }); return 10000; }

        const comp = jogoEncontrado.competitions[0];
        const timeCasa = comp.competitors.find(c => c.homeAway === 'home');
        const timeFora = comp.competitors.find(c => c.homeAway === 'away');
        const estadoJogo = comp.status?.type?.state || 'pre'; 
        const isHalftime = comp.status?.type?.name === 'STATUS_HALFTIME' || comp.status?.type?.detail === 'HT';

        if (estadoJogo === 'post') {
            const tempoAtual = Date.now();
            if (!config.endedAt) {
                await atualizarFirebase('tv/config', { ...config, endedAt: tempoAtual });
            } else if (tempoAtual - config.endedAt > 60 * 60 * 1000) {
                await fetch(`${FIREBASE_DB_URL}/tv.json`, { method: 'DELETE' });
                await fetch(`${FIREBASE_DB_URL}/substituicao.json`, { method: 'DELETE' });
                ultimoAlvoId = '';
                return 30000;
            }
            await atualizarFirebase('tv/placar', { status: 'post', homeAbbr: timeCasa.team.abbreviation, awayAbbr: timeFora.team.abbreviation, homeScore: parseInt(timeCasa.score) || 0, awayScore: parseInt(timeFora.score) || 0, clock: 'FIM DE JOGO' });
            return 30000;
        } else {
            if (config.endedAt) {
                const { endedAt, ...configLimpa } = config;
                await fetch(`${FIREBASE_DB_URL}/tv/config.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(configLimpa) });
            }
        }

        if (estadoJogo === 'pre') {
            await atualizarFirebase('tv/placar', { status: 'pre', homeAbbr: timeCasa.team.abbreviation, awayAbbr: timeFora.team.abbreviation, homeScore: 0, awayScore: 0, clock: 'PRÉ-JOGO', period: 1 });
            return 10000;
        } else if (estadoJogo === 'in') {
            const relogio = (comp.status?.displayClock || "00:00").split('+')[0].replace(/'/g, ''); 
            await atualizarFirebase('tv/placar', { status: isHalftime ? 'halftime' : 'in', homeAbbr: timeCasa.team.abbreviation, awayAbbr: timeFora.team.abbreviation, homeScore: parseInt(timeCasa.score) || 0, awayScore: parseInt(timeFora.score) || 0, clock: isHalftime ? 'INT' : relogio, period: comp.status?.period || 1 });

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

                    if (tipoTexto.includes('substitution') || evento.type?.id === '80') { atualizarFirebase('substituicao', { team: siglaTime, out: { nome: evento.participants?.[1]?.athlete?.displayName || 'X', num: '--' }, in: { nome: evento.participants?.[0]?.athlete?.displayName || 'Y', num: '--' }, hide: false }); registrarLog(`🔄 Sub (${siglaTime})`); eventosEnviados.add(idUnico); } 
                    else if (evento.type?.id === '1') { atualizarFirebase('tv/gol', { teamAbbr: siglaTime, jogador: evento.participants?.[0]?.athlete?.displayName || 'GOL', numero: '--' }); registrarLog(`⚽ GOL! (${siglaTime})`, 'success'); eventosEnviados.add(idUnico); } 
                    else if (tipoTexto.includes('card')) { const cor = tipoTexto.includes('red') ? 'vermelho' : 'amarelo'; atualizarFirebase('tv/cartao', { teamAbbr: siglaTime, jogador: evento.participants?.[0]?.athlete?.displayName || 'Card', numero: '--', tipo: cor }); registrarLog(`🟨 Cartão ${cor.toUpperCase()}`); eventosEnviados.add(idUnico); }
                });
            } catch (err) {}
            return 10000;
        } 
    } catch (e) {
        return 30000;
    }
}

function simplificarNome(nome) { return nome ? nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split("-")[0].split(" ")[0] : ""; }

async function buscarEscalacaoAutomatica(homeName, awayName, gameDateISO) {
    if (!systemActive) return { sucesso: false, mensagem: "Sistema Desligado." };
    const agora = new Date(); const dataJogo = new Date(gameDateISO); const difMinutos = (dataJogo - agora) / (1000 * 60);
    if (difMinutos > 20) return { sucesso: false, mensagem: `Faltam ${Math.ceil(difMinutos)} min.` };

    try {
        const datasParaTestar = [];
        for (let i = -1; i <= 1; i++) { const d = new Date(dataJogo); d.setDate(d.getDate() + i); datasParaTestar.push(d.toISOString().split('T')[0]); }

        let matchId = null; const hKey = simplificarNome(homeName); const aKey = simplificarNome(awayName);

        for (const dateStr of datasParaTestar) {
            const fixRes = await fetch(`https://live-football-api.com/api/v1/matches?key=${LINEUP_KEY}&date=${dateStr}`);
            const fixData = await fixRes.json();
            if (fixData.status && fixData.data) {
                const match = fixData.data.find(m => {
                    const homeLive = simplificarNome(m.home_team?.name || m.home_name); const awayLive = simplificarNome(m.away_team?.name || m.away_name);
                    return (homeLive.includes(hKey) || hKey.includes(homeLive)) && (awayLive.includes(aKey) || aKey.includes(awayLive));
                });
                if (match) { matchId = match.id || match.match_id; break; }
            }
        }

        if (!matchId) return { sucesso: false, mensagem: `Jogo não encontrado na API.` };

        const lineupRes = await fetch(`https://live-football-api.com/api/v1/lineups?key=${LINEUP_KEY}&match_id=${matchId}`);
        const json = await lineupRes.json();

        if (json.status && json.data) {
            await atualizarFirebase('tv/escalacao', { home: json.data.home || json.data.localteam, away: json.data.away || json.data.visitorteam, timestamp: Date.now() });
            return { sucesso: true, mensagem: "Escalação salva!", dadosBrutos: json.data };
        } else return { sucesso: false, mensagem: json.message || "Escalação indisponível." };

    } catch (error) { return { sucesso: false, mensagem: "Erro na API." }; }
}

async function start() { 
    if (!systemActive) return;
    clearTimeout(mainLoopTimer);
    let timeout = await buscarERodarJogo(); 
    if (systemActive) mainLoopTimer = setTimeout(start, timeout); 
}

// Inicializa checando se estava ligado ou desligado no Firebase
async function boot() {
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/tv/system/state.json`);
        const state = await res.json();
        if (state === 'on') {
            systemActive = true;
            console.log("[RENDER LOG] Boot: Sistema ON. Ligando motores...");
            startKeepAlive();
            start();
        } else {
            console.log("[RENDER LOG] Boot: Sistema OFF. Modo Dorminhoco.");
        }
    } catch(e) {}
}

const PORT = process.env.PORT || 10000;

http.createServer(async (req, res) => { 
    res.setHeader('Access-Control-Allow-Origin', '*');

    // NOVA ROTA DE ENERGIA (ON / OFF)
    if (req.url.startsWith('/power')) {
        const state = new URLSearchParams(req.url.split('?')[1]).get('state');
        if (state === 'on') {
            systemActive = true;
            await fetch(`${FIREBASE_DB_URL}/tv/system/state.json`, { method: 'PUT', body: JSON.stringify('on') });
            console.log("🟢 COMANDO RECEBIDO: SISTEMA LIGADO");
            startKeepAlive();
            start();
        } else {
            systemActive = false;
            await fetch(`${FIREBASE_DB_URL}/tv/system/state.json`, { method: 'PUT', body: JSON.stringify('off') });
            console.log("🔴 COMANDO RECEBIDO: SISTEMA DESLIGADO");
            stopKeepAlive();
            clearTimeout(mainLoopTimer);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: systemActive ? 'on' : 'off' }));
        return;
    }

    if (req.url.startsWith('/escalacao')) {
        const p = new URLSearchParams(req.url.split('?')[1]);
        const resultado = await buscarEscalacaoAutomatica(p.get('home'), p.get('away'), p.get('gameDate'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
        return;
    }

    res.writeHead(200); 
    res.end('Servidor Ativo'); 
}).listen(PORT, () => { 
    console.log(`[RENDER LOG] Servidor web montado na porta ${PORT}`);
    boot(); 
});
