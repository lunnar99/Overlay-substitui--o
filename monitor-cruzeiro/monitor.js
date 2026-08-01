import http from 'http';

const LIGAS_DEFAULT = [
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.copa_do_brazil/scoreboard'
];

const FIREBASE_DB_URL = 'https://termosm-6fed5-default-rtdb.firebaseio.com';
let ultimosEventos = { gol: [], cartao: [], sub: [] };
let ultimoAlvoId = '';

async function atualizarFirebase(endpoint, payload) {
    try { 
        console.log(`[FIREBASE] Enviando para ${endpoint}:`, JSON.stringify(payload));
        await fetch(`${FIREBASE_DB_URL}/${endpoint}.json`, { 
            method: 'PUT', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, timestamp: Date.now() }) 
        }); 
    } catch (e) {
        console.error("❌ Erro ao atualizar Firebase:", e);
    }
}

async function registrarLog(mensagem, tipo = 'info') {
    try {
        console.log(`[LOG SISTEMA] ${mensagem}`);
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
        const data = await res.json();
        console.log("[CONFIG ALVO] Lido do Firebase:", data);
        return data || { tipo: 'time', alvo: 'Cruzeiro' }; 
    } catch (e) {
        console.error("❌ Erro ao ler configuracao de alvo:", e);
        return { tipo: 'time', alvo: 'Cruzeiro' };
    }
}

export async function buscarERodarJogo() {
    console.log("\n--------------------------------------------------");
    console.log(`[LOOP] Iniciando verificação às ${new Date().toLocaleTimeString('pt-BR')}`);
    
    try {
        const config = await lerConfiguracaoAlvo();

        if (config.alvo !== ultimoAlvoId) {
            console.log(`[NOVO ALVO DETECTADO] Mudou de '${ultimoAlvoId}' para '${config.alvo}'`);
            ultimosEventos = { gol: [], cartao: [], sub: [] };
            ultimoAlvoId = config.alvo;
        }

        const date = new Date();
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const datesParam = `?dates=${yyyy}${mm}${dd}-${yyyy}1231`;

        let urlsParaBuscar = config.urlLiga ? [`${config.urlLiga}${datesParam}`] : LIGAS_DEFAULT.map(u => `${u}${datesParam}`);
        console.log("[LIGAS CONSULTADAS]:", urlsParaBuscar);

        let todosEventos = [];
        for (const url of urlsParaBuscar) {
            try {
                const res = await fetch(url);
                const data = await res.json();
                if (data.events) {
                    const leagueSlug = data.leagues?.[0]?.slug || 'bra.1';
                    data.events.forEach(e => e.leagueSlug = leagueSlug);
                    todosEventos.push(...data.events);
                }
            } catch (err) {
                console.error(`❌ Erro ao buscar dados da URL ${url}:`, err);
            }
        }

        console.log(`[TOTAL DE JOGOS ENCONTRADOS NAS LIGAS]: ${todosEventos.length}`);
        
        let jogoEncontrado = null;

        for (const evento of todosEventos) {
            const comp = evento.competitions[0];
            const home = comp.competitors.find(c => c.homeAway === 'home').team.name;
            const away = comp.competitors.find(c => c.homeAway === 'away').team.name;
            
            console.log(`   -> Comparando Jogo ID [${evento.id}] (${home} x ${away}) com Alvo [${config.alvo}]`);

            if (config.tipo === 'id' && String(evento.id) === String(config.alvo)) {
                jogoEncontrado = evento;
                console.log(`   ✅ CORRESPONDÊNCIA ENCONTRADA POR ID! (${home} x ${away})`);
                break;
            } else if (config.tipo === 'time') {
                const nomes = [home.toLowerCase(), away.toLowerCase()];
                if (nomes.some(n => n.includes(config.alvo.toLowerCase()))) {
                    jogoEncontrado = evento;
                    console.log(`   ✅ CORRESPONDÊNCIA ENCONTRADA POR NOME DE TIME! (${home} x ${away})`);
                    break;
                }
            }
        }

        if (!jogoEncontrado) {
            console.log(`❌ NENHUM JOGO CORRESPONDENTE ENCONTRADO PARA O ALVO: '${config.alvo}'`);
            await atualizarFirebase('tv/placar', { status: 'off' });
            return 10000; 
        }

        const competidores = jogoEncontrado.competitions[0].competitors;
        const timeCasa = competidores.find(c => c.homeAway === 'home');
        const timeFora = competidores.find(c => c.homeAway === 'away');
        const estadoJogo = jogoEncontrado.status.type.state; 

        console.log(`[DADOS DO JOGO SELECIONADO]: ${timeCasa.team.name} (${timeCasa.team.abbreviation}) ${timeCasa.score} x ${timeFora.score} ${timeFora.team.name} (${timeFora.team.abbreviation}) | Estado: ${estadoJogo}`);

        if (estadoJogo === 'in' || estadoJogo === 'pre') {
            const clockText = jogoEncontrado.status.displayClock || "00:00";
            const clockParts = clockText.split('+');
            const relogio = clockParts[0].replace(/'/g, ''); 
            const acrescimo = clockParts[1] ? clockParts[1].replace(/'/g, '') : null;

            const payloadPlacar = {
                status: 'in',
                homeAbbr: timeCasa.team.abbreviation,
                awayAbbr: timeFora.team.abbreviation,
                homeScore: parseInt(timeCasa.score) || 0,
                awayScore: parseInt(timeFora.score) || 0,
                clock: relogio,
                added: acrescimo
            };

            console.log("🚀 ATUALIZANDO PLACAR NO FIREBASE COM DADOS AO VIVO:", payloadPlacar);
            await atualizarFirebase('tv/placar', payloadPlacar);

            // Resumo de eventos (Gols e Cartões)
            const leagueSlug = jogoEncontrado.leagueSlug || 'bra.1';
            const summaryApiUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/${leagueSlug}/summary?event=${jogoEncontrado.id}`;
            console.log(`[BUSCANDO EVENTOS DO JOGO]: ${summaryApiUrl}`);
            
            try {
                const summaryRes = await fetch(summaryApiUrl);
                const summary = await summaryRes.json();
                
                (summary.keyEvents || []).forEach(evento => {
                    if(ultimosEventos.gol.includes(evento.id) || ultimosEventos.cartao.includes(evento.id)) return;
                    
                    const jogador = evento.participants?.[0]?.athlete?.displayName || 'Desconhecido';
                    const numero = evento.participants?.[0]?.athlete?.jersey || '--';
                    const teamID = evento.team?.id;
                    const siglaTime = (teamID === timeCasa.team.id) ? timeCasa.team.abbreviation : timeFora.team.abbreviation;
                    
                    if (evento.type?.id === '1') { 
                        console.log(`⚽ EVENTO DETECTADO: GOL DE ${jogador}`);
                        atualizarFirebase('tv/gol', { teamAbbr: siglaTime, jogador, numero });
                        registrarLog(`⚽ GOL! ${jogador} (${siglaTime})`, 'success');
                        ultimosEventos.gol.push(evento.id);
                    }
                    if (evento.type?.text?.toLowerCase().includes('card')) { 
                        const tipo = evento.type.text.toLowerCase().includes('red') ? 'vermelho' : 'amarelo';
                        console.log(`🟨 EVENTO DETECTADO: CARTÃO ${tipo.toUpperCase()} PARA ${jogador}`);
                        atualizarFirebase('tv/cartao', { teamAbbr: siglaTime, jogador, numero, tipo });
                        registrarLog(`🟨 Cartão ${tipo}: ${jogador} (${siglaTime})`, 'warning');
                        ultimosEventos.cartao.push(evento.id);
                    }
                });
            } catch (err) {
                console.error("❌ Erro ao buscar resumo dos eventos:", err);
            }

            return 10000; 
        } else {
            console.log(`[JOGO ENCERRADO OU INATIVO]: Estado = ${estadoJogo}`);
            await atualizarFirebase('tv/placar', { status: 'off' });
            return 30000;
        }

    } catch (e) {
        console.error("❌ ERRO GERAL NO PROCESSAMENTO:", e);
        await atualizarFirebase('tv/placar', { status: 'erro' });
        return 30000;
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
