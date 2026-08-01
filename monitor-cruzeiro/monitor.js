import http from 'http';

const LIGAS_DEFAULT = [
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.copa_do_brazil/scoreboard'
];

const FIREBASE_DB_URL = 'https://termosm-6fed5-default-rtdb.firebaseio.com';

// Conjunto (Set) de IDs processados para evitar duplicações
const eventosProcessados = new Set();
let ultimoAlvoId = '';

async function atualizarFirebase(endpoint, payload) {
    try { 
        await fetch(`${FIREBASE_DB_URL}/${endpoint}.json`, { 
            method: 'PUT', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, timestamp: Date.now() }) 
        }); 
    } catch (e) {
        console.error("Erro Firebase:", e);
    }
}

async function registrarLog(mensagem, tipo = 'info') {
    try {
        console.log(`[LOG] ${mensagem}`);
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

        // Se trocou o jogo alvo, limpa os eventos antigos da memória
        if (config.alvo !== ultimoAlvoId) {
            eventosProcessados.clear();
            ultimoAlvoId = config.alvo;
        }

        const date = new Date();
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const datesParam = `?dates=${yyyy}${mm}${dd}-${yyyy}1231`;

        let urlsParaBuscar = config.urlLiga ? [`${config.urlLiga}${datesParam}`] : LIGAS_DEFAULT.map(u => `${u}${datesParam}`);

        let todosEventos = [];
        for (const url of urlsParaBuscar) {
            try {
                const res = await fetch(url);
                const data = await res.json();
                if (data.events) todosEventos.push(...data.events);
            } catch (err) {}
        }

        let jogoEncontrado = null;

        for (const evento of todosEventos) {
            if (config.tipo === 'id' && String(evento.id) === String(config.alvo)) {
                jogoEncontrado = evento;
                break;
            } else if (config.tipo === 'time') {
                const competidores = evento.competitions[0].competitors;
                const nomes = competidores.map(c => c.team.name.toLowerCase());
                if (nomes.some(n => n.includes(config.alvo.toLowerCase()))) {
                    jogoEncontrado = evento;
                    break;
                }
            }
        }

        if (!jogoEncontrado) {
            await atualizarFirebase('tv/placar', { status: 'off' });
            return 10000; 
        }

        const comp = jogoEncontrado.competitions[0];
        const competidores = comp.competitors;
        const timeCasa = competidores.find(c => c.homeAway === 'home');
        const timeFora = competidores.find(c => c.homeAway === 'away');
        
        const statusType = comp.status?.type?.name || '';
        const estadoJogo = comp.status?.type?.state || 'pre'; 

        // DETECÇÃO DO INTERVALO
        const isHalftime = statusType === 'STATUS_HALFTIME' || comp.status?.type?.detail === 'HT';

        if (estadoJogo === 'in' || estadoJogo === 'pre') {
            const relogioExibicao = comp.status?.displayClock || "00:00";
            const clockParts = relogioExibicao.split('+');
            const relogio = clockParts[0].replace(/'/g, ''); 
            const acrescimo = clockParts[1] ? clockParts[1].replace(/'/g, '') : null;

            await atualizarFirebase('tv/placar', {
                status: isHalftime ? 'halftime' : 'in',
                homeAbbr: timeCasa.team.abbreviation,
                awayAbbr: timeFora.team.abbreviation,
                homeScore: parseInt(timeCasa.score) || 0,
                awayScore: parseInt(timeFora.score) || 0,
                clock: isHalftime ? 'INT' : relogio,
                added: isHalftime ? null : acrescimo
            });

            // PROCESSAMENTO ÚNICO DE EVENTOS (CARTÕES/GOLS DO SUMMARY)
            const summaryApiUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary?event=${jogoEncontrado.id}`;
            try {
                const summaryRes = await fetch(summaryApiUrl);
                const summary = await summaryRes.json();

                (summary.keyEvents || []).forEach(evento => {
                    const idUnico = `${jogoEncontrado.id}_${evento.id}`;
                    
                    // Se já foi enviado para o OBS, ignora
                    if (eventosProcessados.has(idUnico)) return;

                    const jogador = evento.participants?.[0]?.athlete?.displayName || 'Jogador';
                    const numero = evento.participants?.[0]?.athlete?.jersey || '--';
                    const teamID = evento.team?.id;
                    const siglaTime = (teamID === timeCasa.team.id) ? timeCasa.team.abbreviation : timeFora.team.abbreviation;

                    if (evento.type?.id === '1') { 
                        atualizarFirebase('tv/gol', { teamAbbr: siglaTime, jogador, numero });
                        registrarLog(`⚽ GOL! ${jogador} (${siglaTime})`, 'success');
                        eventosProcessados.add(idUnico);
                    }
                    else if (evento.type?.text?.toLowerCase().includes('card')) { 
                        const corCartao = evento.type.text.toLowerCase().includes('red') ? 'vermelho' : 'amarelo';
                        
                        atualizarFirebase('tv/cartao', { teamAbbr: siglaTime, jogador, numero, tipo: corCartao });
                        registrarLog(`🟨 Cartão ${corCartao.toUpperCase()}: ${jogador} (${siglaTime})`, 'warning');
                        eventosProcessados.add(idUnico);
                    }
                });
            } catch (err) {}

            return 10000;
        } else {
            await atualizarFirebase('tv/placar', { status: 'off' });
            return 30000;
        }

    } catch (e) {
        console.error("Erro no loop principal:", e);
        await atualizarFirebase('tv/placar', { status: 'erro' });
        return 30000;
    }
}

async function start() {
    let timeout = await buscarERodarJogo();
    setTimeout(start, timeout);
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.writeHead(200); res.end('Monitor Ativo'); }).listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    start();
});
