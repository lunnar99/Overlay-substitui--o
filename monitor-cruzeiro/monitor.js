import http from 'http';

const LIGAS_DEFAULT = [
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.copa_do_brazil/scoreboard'
];

const FIREBASE_DB_URL = 'https://termosm-6fed5-default-rtdb.firebaseio.com';
const eventosEnviados = new Set();
let ultimoAlvoId = '';

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

        if (config.alvo !== ultimoAlvoId) {
            eventosEnviados.clear();
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
        const periodoAtual = comp.status?.period || 1;

        const isHalftime = statusType === 'STATUS_HALFTIME' || comp.status?.type?.detail === 'HT';

        // 1. JOGO EM ANDAMENTO OU PRÉ-JOGO
        if (estadoJogo === 'in' || estadoJogo === 'pre') {
            const relogioExibicao = comp.status?.displayClock || "00:00";
            const clockParts = relogioExibicao.split('+');
            const relogio = clockParts[0].replace(/'/g, ''); 

            await atualizarFirebase('tv/placar', {
                status: isHalftime ? 'halftime' : 'in',
                homeAbbr: timeCasa.team.abbreviation,
                awayAbbr: timeFora.team.abbreviation,
                homeScore: parseInt(timeCasa.score) || 0,
                awayScore: parseInt(timeFora.score) || 0,
                clock: isHalftime ? 'INT' : relogio,
                period: periodoAtual
            });

            // PROCESSAMENTO DE EVENTOS (GOLS, CARTÕES E SUBSTITUIÇÕES)
            const summaryApiUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary?event=${jogoEncontrado.id}`;
            try {
                const summaryRes = await fetch(summaryApiUrl);
                const summary = await summaryRes.json();

                (summary.keyEvents || []).forEach(evento => {
                    const idUnico = `${jogoEncontrado.id}_${evento.id}`;
                    if (eventosEnviados.has(idUnico)) return;

                    const teamID = evento.team?.id;
                    const siglaTime = (teamID === timeCasa.team.id) ? timeCasa.team.abbreviation : timeFora.team.abbreviation;
                    const tipoTexto = evento.type?.text?.toLowerCase() || '';

                    if (tipoTexto.includes('substitution') || evento.type?.id === '80') {
                        const jogadorEntra = evento.participants?.[0]?.athlete?.displayName || 'Jogador Entra';
                        const jogadorSai = evento.participants?.[1]?.athlete?.displayName || 'Jogador Sai';

                        atualizarFirebase('substituicao', {
                            team: siglaTime,
                            out: { nome: jogadorSai, num: evento.participants?.[1]?.athlete?.jersey || '--' },
                            in: { nome: jogadorEntra, num: evento.participants?.[0]?.athlete?.jersey || '--' },
                            hide: false
                        });

                        registrarLog(`🔄 Substituição (${siglaTime}): Entra ${jogadorEntra} / Sai ${jogadorSai}`, 'info');
                        eventosEnviados.add(idUnico);
                    }
                    else if (evento.type?.id === '1') { 
                        const jogador = evento.participants?.[0]?.athlete?.displayName || 'Jogador';
                        const numero = evento.participants?.[0]?.athlete?.jersey || '--';

                        atualizarFirebase('tv/gol', { teamAbbr: siglaTime, jogador, numero });
                        registrarLog(`⚽ GOL! ${jogador} (${siglaTime})`, 'success');
                        eventosEnviados.add(idUnico);
                    }
                    else if (tipoTexto.includes('card')) { 
                        const jogador = evento.participants?.[0]?.athlete?.displayName || 'Jogador';
                        const numero = evento.participants?.[0]?.athlete?.jersey || '--';
                        const corCartao = tipoTexto.includes('red') ? 'vermelho' : 'amarelo';
                        
                        atualizarFirebase('tv/cartao', { teamAbbr: siglaTime, jogador, numero, tipo: corCartao });
                        registrarLog(`🟨 Cartão ${corCartao.toUpperCase()}: ${jogador} (${siglaTime})`, 'warning');
                        eventosEnviados.add(idUnico);
                    }
                });
            } catch (err) {}

            return 10000;
        } 
        // 2. JOGO ENCERRADO (MANTÉM O PLACAR COM FIM DE JOGO)
        else if (estadoJogo === 'post') {
            await atualizarFirebase('tv/placar', {
                status: 'post',
                homeAbbr: timeCasa.team.abbreviation,
                awayAbbr: timeFora.team.abbreviation,
                homeScore: parseInt(timeCasa.score) || 0,
                awayScore: parseInt(timeFora.score) || 0,
                clock: 'FIM DE JOGO'
            });
            return 30000;
        } else {
            await atualizarFirebase('tv/placar', { status: 'off' });
            return 30000;
        }

    } catch (e) {
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
