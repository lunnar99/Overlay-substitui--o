import http from 'http';

const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard';
const SUMMARY_BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary?event=';
const FIREBASE_DB_URL = 'https://termosm-6fed5-default-rtdb.firebaseio.com';
const TIME_ALVO = 'Cruzeiro';

let ultimosEventosEnviados = { gol: [], cartao: [], sub: [] };
let jogoAtualStatus = 'nenhum'; // 'pre', 'in', 'post', 'nenhum'
let timeoutAtivo = null;

// ==========================================
// FUNÇÕES DE COMUNICAÇÃO (FIREBASE)
// ==========================================

async function enviarParaTV(endpoint, payload) {
    try {
        await fetch(`${FIREBASE_DB_URL}/tv/${endpoint}.json`, {
            method: 'PUT',
            body: JSON.stringify({ ...payload, timestamp: Date.now() })
        });
    } catch (e) { console.error("Erro TV:", e.message); }
}

async function registrarLog(mensagem, tipo = 'info') {
    try {
        console.log(`[LOG] ${mensagem}`);
        await fetch(`${FIREBASE_DB_URL}/tv/logs.json`, {
            method: 'POST', // Cria uma lista no Firebase
            body: JSON.stringify({ mensagem, tipo, timestamp: Date.now() })
        });
    } catch (e) { console.error("Erro LOG:", e.message); }
}

async function lerControles() {
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/tv/controle.json`);
        return await res.json() || { ativo: true, forcarBusca: false };
    } catch (e) { return { ativo: true, forcarBusca: false }; }
}

async function desativarForcarBusca() {
    try {
        await fetch(`${FIREBASE_DB_URL}/tv/controle.json`, {
            method: 'PATCH',
            body: JSON.stringify({ forcarBusca: false })
        });
    } catch (e) { }
}

// ==========================================
// LÓGICA DA ESPN
// ==========================================

export async function buscarJogoCruzeiro() {
    try {
        const res = await fetch(SCOREBOARD_URL);
        const data = await res.json();

        for (const evento of (data.events || [])) {
            const competidores = evento.competitions[0].competitors;

            if (competidores.some(c => c.team.name.includes(TIME_ALVO))) {
                const adversario = competidores.find(c => !c.team.name.includes(TIME_ALVO))?.team.name || 'Adversário';
                const idCruzeiro = competidores.find(c => c.team.name.includes(TIME_ALVO)).team.id;

                // Extraindo dados temporais cruciais da ESPN
                const estadoJogo = evento.status.type.state; // 'pre', 'in', 'post'
                const horarioData = new Date(evento.date);
                const horarioFormatado = horarioData.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                const dataFormatada = horarioData.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

                return {
                    eventId: evento.id,
                    cruzeiroId: idCruzeiro,
                    adversario,
                    estadoJogo,
                    horarioFormatado,
                    dataFormatada
                };
            }
        }
        return null;
    } catch (e) { return null; }
}

export async function buscarSummary(eventId) {
    try {
        const res = await fetch(`${SUMMARY_BASE_URL}${eventId}`);
        return await res.json();
    } catch (e) { return null; }
}

// === EXTRAÇÕES ===
// Exemplo atualizado para Cartões no monitor.js
export function extrairCartoes(summary, cruzeiroId) {
    const cartoes = (summary?.keyEvents || []).filter(e => e.type?.text?.toLowerCase().includes('card'));
    cartoes.forEach(cartao => {
        if (ultimosEventosEnviados.cartao.includes(cartao.id)) return;

        const atleta = cartao.participants?.[0]?.athlete;
        const jogador = atleta?.displayName || 'Desconhecido';
        const numeroCamisa = atleta?.jersey || '--'; // Pega o número da camisa!
        const minuto = cartao.clock?.displayValue || 'N/A'; // Pega o tempo (Ex: 44')

        const isCruzeiro = cartao.team?.id === cruzeiroId;
        const tipoCartao = cartao.type?.text?.toLowerCase().includes('red') ? 'vermelho' : 'amarelo';

        enviarParaTV('cartao', { jogador, isCruzeiro, tipo: tipoCartao });

        // Log ultra detalhado que aparecerá na sua tela
        registrarLog(`🟨 Cartão ${tipoCartao} para ${jogador} (Nº ${numeroCamisa}) aos ${minuto} (${isCruzeiro ? 'Cruzeiro' : 'Adversário'})`, 'warning');

        ultimosEventosEnviados.cartao.push(cartao.id);
    });
}

export function extrairGols(summary, cruzeiroId) {
    const gols = (summary?.keyEvents || []).filter(e => e.type?.text?.toLowerCase().includes('goal') || e.type?.id === '1');
    gols.forEach(gol => {
        if (ultimosEventosEnviados.gol.includes(gol.id)) return;

        const jogador = gol.participants?.[0]?.athlete?.displayName || 'Desconhecido';
        const isCruzeiro = gol.team?.id === cruzeiroId;

        enviarParaTV('gol', { jogador, isCruzeiro });
        registrarLog(`⚽ GOL de ${jogador} (${isCruzeiro ? 'Cruzeiro' : 'Adversário'})`, 'success');
        ultimosEventosEnviados.gol.push(gol.id);
    });
}

// ==========================================
// LOOP INTELIGENTE E CONTROLE DE ESTADO
// ==========================================

export async function iniciarLoop() {
    clearTimeout(timeoutAtivo);
    const controles = await lerControles();

    // 1. Verifica se o robô foi pausado pelo painel
    if (!controles.ativo && !controles.forcarBusca) {
        timeoutAtivo = setTimeout(iniciarLoop, 10000); // Checa o painel a cada 10s
        return;
    }

    if (controles.forcarBusca) {
        registrarLog("🔄 Busca forçada iniciada pelo painel...", "info");
        await desativarForcarBusca();
    }

    let proximaChecagemMs = 1800000; // Padrão: 30 minutos

    const jogo = await buscarJogoCruzeiro();

    if (jogo) {
        if (jogo.estadoJogo === 'pre') {
            if (jogoAtualStatus !== 'pre') registrarLog(`📅 PRÓXIMO JOGO: Cruzeiro x ${jogo.adversario} (${jogo.dataFormatada} às ${jogo.horarioFormatado})`, 'info');
            jogoAtualStatus = 'pre';
            proximaChecagemMs = 1800000; // 30 mins
        }
        else if (jogo.estadoJogo === 'in') {
            if (jogoAtualStatus !== 'in') registrarLog(`🔥 BOLA ROLANDO: Cruzeiro x ${jogo.adversario}! Monitoramento em tempo real ativado.`, 'success');
            jogoAtualStatus = 'in';
            proximaChecagemMs = 120000; // 2 minutos (em andamento)

            const summary = await buscarSummary(jogo.eventId);
            if (summary) {
                extrairGols(summary, jogo.cruzeiroId);
                extrairCartoes(summary, jogo.cruzeiroId);
            }
        }
        else if (jogo.estadoJogo === 'post') {
            if (jogoAtualStatus !== 'post') registrarLog(`🏁 FIM DE JOGO: Cruzeiro x ${jogo.adversario} encerrado.`, 'info');
            jogoAtualStatus = 'post';
            proximaChecagemMs = 1800000; // 30 mins
        }
    } else {
        if (jogoAtualStatus !== 'nenhum') registrarLog("❌ Nenhum jogo do Cruzeiro listado na ESPN atualmente.", "warning");
        jogoAtualStatus = 'nenhum';
        proximaChecagemMs = 1800000; // 30 mins
    }

    // Mantém a verificação dos controles rápida (10s), mas a API da ESPN obedece a variável `proximaChecagemMs` 
    // Para resolver isso sem travar a thread, verificamos a ESPN via timestamp:
    timeoutAtivo = setTimeout(iniciarLoop, controles.forcarBusca ? 0 : 10000);
}

// Variável para controlar quando bater na ESPN
let ultimaBuscaESPN = 0;
let intervaloESPNAtual = 0;

export async function loopGerenciador() {
    clearTimeout(timeoutAtivo);
    const controles = await lerControles();
    const agora = Date.now();

    if (!controles.ativo && !controles.forcarBusca) {
        timeoutAtivo = setTimeout(loopGerenciador, 5000); // Lê os botões a cada 5s
        return;
    }

    if (controles.forcarBusca || (agora - ultimaBuscaESPN > intervaloESPNAtual)) {
        if (controles.forcarBusca) {
            registrarLog("🔄 Busca forçada pelo usuário.", "info");
            await desativarForcarBusca();
        }

        const jogo = await buscarJogoCruzeiro();
        ultimaBuscaESPN = Date.now();

        if (jogo) {
            if (jogo.estadoJogo === 'pre') {
                if (jogoAtualStatus !== 'pre') registrarLog(`📅 PRÓXIMO JOGO: CRUZEIRO x ${jogo.adversario.toUpperCase()} - ${jogo.dataFormatada} às ${jogo.horarioFormatado}`, 'info');
                jogoAtualStatus = 'pre';
                intervaloESPNAtual = 1800000; // 30 min
            }
            else if (jogo.estadoJogo === 'in') {
                if (jogoAtualStatus !== 'in') registrarLog(`🔥 BOLA ROLANDO: Cruzeiro x ${jogo.adversario}`, 'success');
                jogoAtualStatus = 'in';
                intervaloESPNAtual = 120000; // 2 min

                const summary = await buscarSummary(jogo.eventId);
                if (summary) {
                    extrairGols(summary, jogo.cruzeiroId);
                    extrairCartoes(summary, jogo.cruzeiroId);
                }
            }
            else if (jogo.estadoJogo === 'post') {
                if (jogoAtualStatus !== 'post') registrarLog(`🏁 FIM DE JOGO encerrado.`, 'info');
                jogoAtualStatus = 'post';
                intervaloESPNAtual = 1800000; // 30 min
            }
        } else {
            if (jogoAtualStatus !== 'nenhum') registrarLog("❌ Nenhum jogo localizado.", "warning");
            jogoAtualStatus = 'nenhum';
            intervaloESPNAtual = 1800000; // 30 min
        }
    }

    timeoutAtivo = setTimeout(loopGerenciador, 5000); // Fica sempre lendo o Firebase (0 custo) de 5 em 5s
}

// Minisservidor para Render
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('⚽ Monitor ativo.');
}).listen(PORT, () => {
    console.log(`🌐 Servidor HTTP na porta ${PORT}`);
    loopGerenciador();
});