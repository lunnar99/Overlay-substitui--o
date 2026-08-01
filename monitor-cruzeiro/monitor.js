import http from 'http';

const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard';
const SUMMARY_BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary?event=';
const FIREBASE_DB_URL = 'https://termosm-6fed5-default-rtdb.firebaseio.com';
const TIME_ALVO = 'Cruzeiro'; // Deixe vazio '' para monitorar QUALQUER jogo que estiver rolando

let ultimosEventos = { gol: [], cartao: [], sub: [] };

async function atualizarFirebase(endpoint, payload) {
    try { await fetch(`${FIREBASE_DB_URL}/${endpoint}.json`, { method: 'PUT', body: JSON.stringify({ ...payload, timestamp: Date.now() }) }); } catch (e) {}
}

async function registrarLog(mensagem, tipo = 'info') {
    try {
        console.log(`[LOG] ${mensagem}`);
        await fetch(`${FIREBASE_DB_URL}/tv/logs.json`, { method: 'POST', body: JSON.stringify({ mensagem, tipo, timestamp: Date.now() }) });
    } catch (e) {}
}

export async function buscarERodarJogo() {
    try {
        const res = await fetch(SCOREBOARD_URL);
        const data = await res.json();
        
        let jogoEncontrado = null;

        // Procura jogo do Cruzeiro. Se não achar, pode pegar o primeiro jogo 'in' (ao vivo) da lista.
        for (const evento of (data.events || [])) {
            const competidores = evento.competitions[0].competitors;
            const nomes = competidores.map(c => c.team.name);
            const statusType = evento.status.type.state;

            if (nomes.some(n => n.includes(TIME_ALVO))) {
                jogoEncontrado = evento;
                break;
            }
        }

        if (!jogoEncontrado) {
            atualizarFirebase('tv/placar', { status: 'off' });
            return 1800000; // Dorme 30 mins
        }

        const competidores = jogoEncontrado.competitions[0].competitors;
        const timeCasa = competidores.find(c => c.homeAway === 'home');
        const timeFora = competidores.find(c => c.homeAway === 'away');
        const estadoJogo = jogoEncontrado.status.type.state;

        if (estadoJogo === 'in') {
            // == 1. ATUALIZA O PLACAR E O TEMPO CONTINUAMENTE ==
            const clockText = jogoEncontrado.status.displayClock || "00:00";
            // Limpa o '+X' do relógio da ESPN para isolar o acréscimo
            const clockParts = clockText.split('+');
            const relogio = clockParts[0].replace(/'/g, ''); 
            const acrescimo = clockParts[1] ? clockParts[1].replace(/'/g, '') : null;

            await atualizarFirebase('tv/placar', {
                status: 'in',
                homeAbbr: timeCasa.team.abbreviation,
                awayAbbr: timeFora.team.abbreviation,
                homeScore: timeCasa.score,
                awayScore: timeFora.score,
                clock: relogio,
                added: acrescimo
            });

            // == 2. BUSCA GOLS E CARTÕES ==
            const summaryRes = await fetch(`${SUMMARY_BASE_URL}${jogoEncontrado.id}`);
            const summary = await summaryRes.json();
            
            // Lógica de Gols e Cartões...
            (summary.keyEvents || []).forEach(evento => {
                if(ultimosEventos.gol.includes(evento.id) || ultimosEventos.cartao.includes(evento.id)) return;
                
                const jogador = evento.participants?.[0]?.athlete?.displayName || 'Desconhecido';
                const numero = evento.participants?.[0]?.athlete?.jersey || '--';
                const teamID = evento.team?.id;
                const siglaTime = (teamID === timeCasa.team.id) ? timeCasa.team.abbreviation : timeFora.team.abbreviation;
                
                if (evento.type?.id === '1') { // Gol
                    atualizarFirebase('tv/gol', { teamAbbr: siglaTime, jogador, numero });
                    registrarLog(`⚽ GOL! ${jogador} (${siglaTime})`, 'success');
                    ultimosEventos.gol.push(evento.id);
                }
                if (evento.type?.text?.toLowerCase().includes('card')) { // Cartão
                    const tipo = evento.type.text.toLowerCase().includes('red') ? 'vermelho' : 'amarelo';
                    atualizarFirebase('tv/cartao', { teamAbbr: siglaTime, jogador, numero, tipo });
                    registrarLog(`🟨 Cartão ${tipo}: ${jogador} (${siglaTime})`, 'warning');
                    ultimosEventos.cartao.push(evento.id);
                }
            });

            return 15000; // Roda a cada 15 seg
        } else if (estadoJogo === 'post') {
            atualizarFirebase('tv/placar', { status: 'off' });
            registrarLog(`🏁 Fim de Jogo.`, 'info');
            return 1800000; // 30 mins
        } else {
            atualizarFirebase('tv/placar', { status: 'off' });
            return 1800000; // 30 mins
        }
    } catch (e) {
        atualizarFirebase('tv/placar', { status: 'erro' });
        registrarLog(`Erro na API ESPN`, 'danger');
        return 60000;
    }
}

async function start() {
    let timeout = await buscarERodarJogo();
    setTimeout(start, timeout);
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.writeHead(200); res.end('Ativo'); }).listen(PORT, () => {
    console.log(`Monitor rodando na porta ${PORT}`);
    start();
});