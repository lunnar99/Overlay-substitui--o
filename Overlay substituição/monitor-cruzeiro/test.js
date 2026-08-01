// test.js
import { extrairTempo, extrairAcrescimos, extrairSubstituicoes, extrairGols } from './monitor.js';

// Vamos buscar qualquer jogo ao vivo que esteja acontecendo agora no Brasileirão/Mundo para testar as funções
async function testarComJogoAoVivo() {
    console.log('🧪 INICIANDO TESTE COM DADOS REAIS DE OUTRA PARTIDA...\n');
    
    try {
        // Busca a lista de jogos do Brasileirão
        const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard');
        const data = await res.json();
        
        if (!data.events || data.events.length === 0) {
            console.log('Nenhum jogo encontrado no Brasileirão hoje para testar.');
            return;
        }

        // Pega o ID do primeiro jogo disponível
        const testEventId = data.events[0].id;
        const time1 = data.events[0].competitions[0].competitors[0].team.shortDisplayName;
        const time2 = data.events[0].competitions[0].competitors[1].team.shortDisplayName;

        console.log(`🎮 Simulando partida com o Event ID: ${testEventId} (${time1} x ${time2})\n`);

        // Busca o Summary desse jogo
        const summaryRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary?event=${testEventId}`);
        const summaryData = await summaryRes.json();

        // Roda todas as suas funções criadas no monitor.js
        extrairTempo(summaryData);
        extrairAcrescimos(summaryData);
        extrairSubstituicoes(summaryData);
        extrairGols(summaryData);

    } catch (error) {
        console.error('Erro durante o teste:', error.message);
    }
}

testarComJogoAoVivo();