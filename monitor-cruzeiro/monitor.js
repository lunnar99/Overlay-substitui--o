// monitor.js
const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard';
const SUMMARY_BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary?event=';
const FIREBASE_DB_URL = 'https://termosm-6fed5-default-rtdb.firebaseio.com'; // Sua URL do Firebase
const TIME_ALVO = 'Cruzeiro';

// Variáveis para não repetir alertas enviados
let ultimosEventosEnviados = { gol: [], cartao: [], sub: [] };

export async function buscarJogoCruzeiro() {
    console.log('\n==============================\nConsultando ESPN...');
    try {
        const res = await fetch(SCOREBOARD_URL);
        const data = await res.json();
        
        for (const evento of (data.events || [])) {
            const competidores = evento.competitions[0].competitors;
            if (competidores.some(c => c.team.name.includes(TIME_ALVO))) {
                console.log(`✅ ${TIME_ALVO} encontrado. (ID: ${evento.id})`);
                return { 
                    eventId: evento.id, 
                    cruzeiroId: competidores.find(c => c.team.name.includes(TIME_ALVO)).team.id 
                };
            }
        }
        console.log(`❌ ${TIME_ALVO} não está jogando agora.`);
        return null;
    } catch (e) { return null; }
}

export async function buscarSummary(eventId) {
    try {
        const res = await fetch(`${SUMMARY_BASE_URL}${eventId}`);
        return await res.json();
    } catch (e) { return null; }
}

// === FUNÇÃO PARA ENVIAR PARA A TV (FIREBASE) ===
async function enviarParaTV(endpoint, payload) {
    try {
        await fetch(`${FIREBASE_DB_URL}/tv/${endpoint}.json`, {
            method: 'PUT', // Substitui o nó com o novo evento
            body: JSON.stringify({ ...payload, timestamp: Date.now() })
        });
        console.log(`📺 [TV] Animação de ${endpoint.toUpperCase()} enviada para o OBS!`);
    } catch (error) {
        console.log(`❌ Erro ao enviar para TV:`, error.message);
    }
}

// === EXTRAÇÕES ===
export function extrairCartoes(summary, cruzeiroId) {
    console.log('\n--- Cartões ---');
    const keyEvents = summary?.keyEvents || [];
    const cartoes = keyEvents.filter(e => e.type?.text?.toLowerCase().includes('card'));

    cartoes.forEach(cartao => {
        if (ultimosEventosEnviados.cartao.includes(cartao.id)) return; // Já enviou

        const jogador = cartao.participants?.[0]?.athlete?.displayName || 'Desconhecido';
        const isCruzeiro = cartao.team?.id === cruzeiroId; // Isola o time!
        const tipoCartao = cartao.type?.text?.toLowerCase().includes('red') ? 'vermelho' : 'amarelo';
        
        console.log(`✅ Cartão ${tipoCartao} para ${jogador} (${isCruzeiro ? 'Cruzeiro' : 'Adversário'})`);
        
        enviarParaTV('cartao', { jogador, isCruzeiro, tipo: tipoCartao });
        ultimosEventosEnviados.cartao.push(cartao.id);
    });
}

export function extrairGols(summary, cruzeiroId) {
    console.log('\n--- Gols ---');
    const keyEvents = summary?.keyEvents || [];
    const gols = keyEvents.filter(e => e.type?.text?.toLowerCase().includes('goal') || e.type?.id === '1');

    gols.forEach(gol => {
        if (ultimosEventosEnviados.gol.includes(gol.id)) return;

        const jogador = gol.participants?.[0]?.athlete?.displayName || 'Desconhecido';
        const isCruzeiro = gol.team?.id === cruzeiroId;
        
        console.log(`✅ GOL de ${jogador} (${isCruzeiro ? 'Cruzeiro' : 'Adversário'})`);
        
        enviarParaTV('gol', { jogador, isCruzeiro });
        ultimosEventosEnviados.gol.push(gol.id);
    });
}

// Você pode aplicar a mesma lógica de "ultimosEventosEnviados" nas substituições e acréscimos!

export async function iniciarLoop() {
    const jogo = await buscarJogoCruzeiro();
    if (jogo) {
        const summary = await buscarSummary(jogo.eventId);
        if (summary) {
            extrairGols(summary, jogo.cruzeiroId);
            extrairCartoes(summary, jogo.cruzeiroId);
            // extrairSubstituicoes(summary);
            // extrairAcrescimos(summary);
        }
        setTimeout(iniciarLoop, 15000);
    } else {
        setTimeout(iniciarLoop, 300000);
    }
}

import http from 'http';

// Servidor de suporte para manter o Render ativo
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('⚽ Monitor do Cruzeiro rodando com sucesso!');
}).listen(PORT, () => {
    console.log(`🌐 Servidor HTTP ativo na porta ${PORT}`);
});



iniciarLoop();