import http from 'http';

const LIGAS_DEFAULT = [
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.copa_do_brazil/scoreboard'
];

const FIREBASE_DB_URL = 'https://termosm-6fed5-default-rtdb.firebaseio.com';
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
        
        const date = new Date();
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const datesParam = `?dates=${yyyy}${mm}${dd}-${yyyy}1231`;

        // Determina as URLs de busca (Se houver liga específica salva na config, usa ela, senão busca em todas)
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
            // Ignora jogos encerrados
            if (evento.status.type.state === 'post') continue;

            if (config.tipo === 'id' && evento.id === config.alvo) {
                jogoEncontrado = evento;
                break;
            }
            else if (config.tipo === 'time') {
                const competidores = evento.competitions[0].competitors;
                const nomes = competidores.map(c => c.team.name.toLowerCase());
                if (nomes.some(n => n.includes(config.alvo.toLowerCase()))) {
                    jogoEncontrado = evento;
                    break;
                }
            }
        }

        if (!jogoEncontrado) {
            atualizarFirebase('tv/placar', { status: 'off' });
            registrarLog(`Buscando alvo: ${config.alvo}. Nenhum jogo em andamento/listado agora.`, 'warning');
            return 1800000; 
        }

        const competidores = jogoEncontrado.competitions[0].competitors;
        const timeCasa = competidores.find(c => c.homeAway === 'home');
        const timeFora = competidores.find(c => c.homeAway === 'away');
        const estadoJogo = jogoEncontrado.status.type.state; 

        if (estadoJogo === 'in') {
            const clockText = jogoEncontrado.status.displayClock || "00:00";
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

            // Extração de eventos do jogo
            const summaryBaseUrl = jogoEncontrado.links?.find(l => l.rel.includes('summary'))?.href || '';
            const summaryApiUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary?event=${jogoEncontrado.id}`;
            
            const summaryRes = await fetch(summaryApiUrl);
            const summary = await summaryRes.json();
            
            (summary.keyEvents || []).forEach(evento => {
                if(ultimosEventos.gol.includes(evento.id) || ultimosEventos.cartao.includes(evento.id)) return;
                
                const jogador = evento.participants?.[0]?.athlete?.displayName || 'Desconhecido';
                const numero = evento.participants?.[0]?.athlete?.jersey || '--';
                const teamID = evento.team?.id;
                const siglaTime = (teamID === timeCasa.team.id) ? timeCasa.team.abbreviation : timeFora.team.abbreviation;
                
                if (evento.type?.id === '1') { 
                    atualizarFirebase('tv/gol', { teamAbbr: siglaTime, jogador, numero });
                    registrarLog(`⚽ GOL! ${jogador} (${siglaTime})`, 'success');
                    ultimosEventos.gol.push(evento.id);
                }
                if (evento.type?.text?.toLowerCase().includes('card')) { 
                    const tipo = evento.type.text.toLowerCase().includes('red') ? 'vermelho' : 'amarelo';
                    atualizarFirebase('tv/cartao', { teamAbbr: siglaTime, jogador, numero, tipo });
                    registrarLog(`🟨 Cartão ${tipo}: ${jogador} (${siglaTime})`, 'warning');
                    ultimosEventos.cartao.push(evento.id);
                }
            });

            return 15000; 
        } 
        else if (estadoJogo === 'pre') {
            atualizarFirebase('tv/placar', { status: 'off' });
            registrarLog(`Aguardando início de: ${timeCasa.team.name} x ${timeFora.team.name}.`, 'info');
            return 300000; 
        } 
    } catch (e) {
        atualizarFirebase('tv/placar', { status: 'erro' });
        registrarLog(`Erro na API ESPN: ${e.message}`, 'danger');
        return 60000;
    }
}

async function start() {
    let timeout = await buscarERodarJogo();
    setTimeout(start, timeout);
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.writeHead(200); res.end('Monitor Multi-Ligas Ativo'); }).listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    start();
});