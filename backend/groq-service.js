/**
 * groq-service.js
 * Pipeline de IA do Scrutiny usando Groq (LLaMA 3.1 8B + LLaMA 3.3 70B).
 *
 * Arquitetura do pipeline:
 * ┌─────────────────────────────────────────────────────────────┐
 * │ 1. OLHEIRO (LLaMA 3.1 8B — rápido e barato)                │
 * │    Recebe lista de repos → seleciona os 5 mais relevantes   │
 * │                                                             │
 * │ 2. ANALISTA (LLaMA 3.3 70B — profundo e detalhado)         │
 * │    Recebe código real + perfil → gera análise HTML + score  │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Por que separar em dois modelos?
 * - O 8B é 10x mais rápido e usa menos tokens na pré-seleção
 * - O 70B tem mais capacidade para análise técnica profunda
 * - O score é gerado pelo próprio 70B junto com a análise (mais preciso)
 *   em vez de um modelo secundário tentando adivinhar a partir do HTML
 *
 * Por que system + user separados?
 * - O model foi treinado para tratar o "system" como constituição fixa
 * - Separar persona/regras (system) de dados (user) melhora a consistência
 * - O modelo respeita melhor as instruções quando estão no lugar certo
 */

import Groq from 'groq-sdk';

// Cliente Groq autenticado com a chave do arquivo .env
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Modelos utilizados
const MODEL_PRINCIPAL  = 'llama-3.3-70b-versatile'; // análise profunda
const MODEL_OLHEIRO    = 'llama-3.1-8b-instant';    // seleção de repos e scoring

// Limite de caracteres do README do perfil enviado para a IA
const README_MAX_CHARS = 2000;

// Estilos CSS inline dos cards HTML gerados pela IA
// Inline porque o HTML gerado é injetado diretamente no DOM pelo frontend
const CARD_STYLE       = 'border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px;';
const ERROR_CARD_STYLE = 'border:1px solid #f85149;border-radius:8px;padding:16px;margin-bottom:16px;background:rgba(248,81,73,0.08);';

// ── Instruções de tom humano ─────────────────────────────────────────────────
// Aplicadas em TODOS os system prompts para evitar linguagem robótica
// Proíbe explicitamente palavras e padrões que modelos LLM usam por padrão
const TOM_HUMANO = `
TOM E LINGUAGEM — OBRIGATÓRIO:
- Escreva como um profissional de verdade escreveria num e-mail ou Slack — direto, sem cerimônia.
- Use frases curtas quando quiser dar ênfase. Frases longas só quando precisar explicar algo complexo.
- NUNCA use: "Certamente", "Com prazer", "É importante notar", "Vale ressaltar", "Além disso", "Portanto", "Ademais", "Outrossim".
- NUNCA use: "robusto", "escalável", "performático", "elegante", "limpo", "organizado" sem evidência concreta.
- Não elogie o candidato genericamente. Se tem algo bom, diga o que é e por quê.
- Se tem problema, diga direto. Não suavize com "poderia melhorar" — diga "falta X" ou "isso está errado porque Y".
- Varie o ritmo. Alterne parágrafos curtos com análises mais detalhadas.
- Escreva na primeira pessoa quando der opinião: "Esse código me diz que..." / "Na minha visão..." / "O que eu vejo aqui é..."
- NUNCA avalie frequência de commits, quando foi o último push, ou quantidade de repositórios. Isso não diz nada sobre qualidade.
`.trim();

// ── Instruções de formato HTML ───────────────────────────────────────────────
// Garante que o output seja HTML válido e injetável no frontend
const FORMATO_HTML = `
FORMATO — OBRIGATÓRIO:
- Gere APENAS HTML. Zero Markdown, zero asteriscos, zero backticks.
- NÃO inclua <html>, <body>, <head>, <style> ou <script>.
- Use <h2> para títulos de seção, <h3> para nome de repo, <strong> para ênfase.
- Envolva cada seção em: <div style="${CARD_STYLE}">...</div>
- NUNCA use nome de repositório como apelido do dev.
- Baseie TODA análise no código real fornecido. NUNCA invente.
`.trim();

// ── System prompts (persona fixa — não muda entre chamadas) ─────────────────

/**
 * Persona para análise de recrutamento.
 * Simula um Head of Engineering avaliando um candidato para contratação.
 */
const SYSTEM_RECRUTAMENTO = `
Você é um Head of Engineering com 12 anos de experiência contratando desenvolvedores.
Já revisou centenas de portfólios no GitHub. Sabe exatamente o que separa um dev júnior mediano de um que chama atenção.
Você não tem tempo a perder com elogios genéricos. Vai direto ao ponto.

Você avalia APENAS:
- A qualidade do código que está escrito nos repositórios
- A documentação (README, comentários, descrições)
- A complexidade técnica do que foi construído

Você NUNCA avalia:
- Frequência de commits ou quando foi o último push
- Quantidade de repositórios ou estrelas
- Atividade no perfil ou histórico de contribuições

${TOM_HUMANO}

${FORMATO_HTML}
`.trim();

/**
 * Persona para autoanálise.
 * Simula um Tech Lead mentor dando feedback construtivo ao próprio dev.
 */
const SYSTEM_AUTOANALISE = `
Você é um Tech Lead Sênior com 15 anos de experiência em code review e mentoria.
O dev te pediu um feedback honesto para crescer. Você vai dar — sem papas na língua, mas de forma construtiva.

Você avalia APENAS:
- A qualidade do código que está escrito nos repositórios
- A documentação (README, comentários, descrições)
- A complexidade técnica do que foi construído

Você NUNCA avalia:
- Frequência de commits ou quando foi o último push
- Quantidade de repositórios ou estrelas
- Atividade no perfil ou histórico de contribuições

${TOM_HUMANO}

${FORMATO_HTML}
`.trim();

/**
 * Persona para análise com vaga específica.
 * Simula um Tech Lead avaliando fit técnico para uma vaga.
 */
const SYSTEM_COM_VAGA = `
Você é um Tech Lead avaliando um candidato para uma vaga específica.
Tem o código real na frente e os requisitos da vaga. Seu trabalho é dizer se encaixa ou não — sem rodeios.

Você avalia APENAS:
- A qualidade do código que está escrito nos repositórios
- A documentação (README, comentários, descrições)
- A complexidade técnica do que foi construído

Você NUNCA avalia:
- Frequência de commits ou quando foi o último push
- Quantidade de repositórios ou estrelas
- Atividade no perfil ou histórico de contribuições

${TOM_HUMANO}

${FORMATO_HTML}
`.trim();

/**
 * Persona do olheiro — usado pelo LLaMA 3.1 8B para selecionar repos.
 * Resposta deve ser JSON puro para facilitar o parse.
 */
const SYSTEM_OLHEIRO = `
Você é um Arquiteto de Software Sênior selecionando repositórios para análise técnica profunda.
Responda APENAS com JSON válido — sem texto antes ou depois.
`.trim();

// ── User prompts (dados variáveis — mudam a cada análise) ───────────────────

/**
 * Template para modo recrutamento.
 * Os placeholders {nome}, {login}, etc. são substituídos em gerarAnalise().
 *
 * O bloco SCORE_JSON no final instrui o modelo a gerar o score
 * diretamente no output, sem precisar de uma segunda chamada de API.
 * A função extrairScoreDoHTML() remove o JSON do HTML e o parseia.
 */
const USER_RECRUTAMENTO = `
CANDIDATO: {nome} (@{login})
Bio: {bio}
README do perfil: "{readme}"
Linguagens: {principais}

REPOSITÓRIOS COM CÓDIGO REAL:
{repos_com_codigo}

TAREFA — gere EXATAMENTE estas 3 seções HTML + o JSON de score no final:

1. <div> <h2>📊 Veredito</h2>
   - 2-3 parágrafos diretos sobre o perfil técnico real. Fala como você escreveria num e-mail pra um colega.
   - Veredito em <strong>: "✅ Recomendado para [cargo específico]" ou "⚠️ Com ressalvas para [cargo]" ou "❌ Não está pronto para [cargo] agora"
   - O que chamou atenção positivamente no código (cite arquivo ou função)
   - O que te preocupa no código (cite o problema específico que viu)

2. <div> <h2>🔍 Repositório por Repositório</h2>
   Para CADA repo:
   - <h3> nome exato
   - Parágrafo: o que é o projeto tecnicamente e o que o código revela sobre quem o fez
   - <ul> com 3 pontos: o que está bom no código, o que está ruim no código, o que falta na documentação — cada um com evidência concreta

3. <div> <h2>💼 Encaixa em qual vaga?</h2>
   - Estágio: ✅/⚠️/❌ + por quê em 1 frase baseada no código
   - Júnior Backend: ✅/⚠️/❌ + por quê em 1 frase baseada no código
   - Júnior Full Stack: ✅/⚠️/❌ + por quê em 1 frase baseada no código
   - Júnior Python: ✅/⚠️/❌ + por quê em 1 frase baseada no código

Depois das seções HTML, adicione EXATAMENTE este bloco JSON:
SCORE_JSON:{"score":0.0,"qualidade":0,"documentacao":0,"complexidade":0,"nivel":"","resumo":""}

Campos do JSON — baseie nos critérios abaixo:
- qualidade (0-10): legibilidade, nomenclatura, tratamento de erros, estrutura do código
- documentacao (0-10): README completo com instruções claras, comentários no código, descrições dos repos
- complexidade (0-10): o que o projeto faz de verdade — integração com APIs, WebSocket, IA, banco de dados, autenticação
- score: média dos três que você achar justa — use seu julgamento
- nivel: "Iniciante", "Júnior", "Júnior+", "Pleno", "Sênior" ou "Especialista"
- resumo: 1 frase honesta sobre o que o código revela
`.trim();

/** Template para modo autoanálise */
const USER_AUTOANALISE = `
DEV: {nome} (@{login})
Bio: {bio}
README do perfil: "{readme}"
Linguagens: {principais}

REPOSITÓRIOS COM CÓDIGO REAL:
{repos_com_codigo}

TAREFA — gere EXATAMENTE estas 3 seções HTML + JSON de score:

1. <div> <h2>🚀 O que está funcionando</h2>
   - 4-5 pontos com evidência direta no código. Cite arquivo ou função.
   - Compare com o que seria feito de forma amadora — mostre por que é um ponto forte de verdade.
   - PROIBIDO citar "código bem organizado" sem apontar o que exatamente.

2. <div> <h2>💡 Projeto a projeto</h2>
   Para CADA repo:
   - <h3> nome exato
   - Parágrafo curto: o que o projeto é e o que o código revela
   - <ul> 4 pontos: ponto forte no código, problema real no código, qualidade da documentação, próximo passo concreto

3. <div> <h2>🎯 O que fazer agora</h2>
   - Parágrafo direto: onde você está hoje tecnicamente baseado no código
   - 5 ações concretas priorizadas por impacto, com nome de arquivo quando possível

SCORE_JSON:{"score":0.0,"qualidade":0,"documentacao":0,"complexidade":0,"nivel":"","resumo":""}
`.trim();

/** Template para modo com vaga específica */
const USER_COM_VAGA = `
CANDIDATO: {nome} (@{login})
Bio: {bio}
Linguagens: {principais}

REPOSITÓRIOS COM CÓDIGO REAL:
{repos_com_codigo}

VAGA:
{job_description}

TAREFA — gere EXATAMENTE estas 3 seções HTML + JSON de score:

1. <div> <h2>📊 Encaixa na vaga?</h2>
   - Para cada requisito da vaga: ✅ tem evidência no código / ⚠️ parcialmente / ❌ não tem
   - Parágrafo final: sim, não, ou depende — e por quê

2. <div> <h2>🔍 O código frente à vaga</h2>
   - Para cada repo: o que demonstra (ou não) das habilidades pedidas
   - Seja específico — arquivo e função quando possível

3. <div> <h2>⭐ Decisão</h2>
   - Contratar / Chamar para entrevista / Não agora — direto
   - O que falta para ser contratado
   - 3 perguntas técnicas para entrevista baseadas no código real

SCORE_JSON:{"score":0.0,"qualidade":0,"documentacao":0,"complexidade":0,"nivel":"","resumo":""}
`.trim();

/** Template para o olheiro — seleção de repos pelo LLaMA 3.1 8B */
const USER_OLHEIRO = `
Repositórios do desenvolvedor:
{repos}

Selecione os 5 que melhor demonstram habilidade técnica real.

Priorize (nesta ordem):
1. Projetos com múltiplas tecnologias integradas
2. Projetos com backend, API ou servidor
3. Projetos com integrações externas (WebSocket, APIs de terceiros, banco de dados)
4. Projetos com descrição clara do que fazem
5. Projetos com maior complexidade aparente

NÃO leve em conta número de estrelas, frequência de commits ou quando foi o último push.
Ignore: repos sem descrição, exercícios simples (calculadora, lista de tarefas, hello world), repos com nome genérico.

Responda APENAS com JSON:
["nome-1", "nome-2", "nome-3", "nome-4", "nome-5"]
`.trim();

// ── Funções auxiliares ───────────────────────────────────────────────────────

/**
 * Faz uma chamada ao Groq com system + user separados.
 *
 * Por que separar system e user?
 * O modelo foi treinado para tratar o "system" como regras fixas de comportamento
 * e o "user" como o input que muda a cada interação. Misturar os dois no "user"
 * dilui a autoridade das instruções e o modelo as respeita menos.
 *
 * @param {string} systemPrompt - Persona e regras fixas (não muda entre chamadas)
 * @param {string} userPrompt   - Dados do dev e tarefa específica
 * @param {string} model        - Modelo Groq a usar
 * @param {number} maxTokens    - Máximo de tokens na resposta
 * @param {number} temperature  - 0.65 = mais opinativo, menos genérico
 * @returns {string} Resposta do modelo
 */
async function chamarGroq(systemPrompt, userPrompt, model = MODEL_PRINCIPAL, maxTokens = 4500, temperature = 0.65) {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    max_tokens:  maxTokens,
    temperature,
  });
  return response.choices[0].message.content.trim();
}

/**
 * Extrai o objeto JSON de score do output bruto da IA.
 *
 * O modelo insere o score no final do HTML assim:
 *   SCORE_JSON:{"score":7.2,"qualidade":8,...}
 *
 * Estratégia em dois passos:
 * 1. Procura pelo marcador "SCORE_JSON:" e parseia o JSON após ele
 * 2. Fallback: procura qualquer JSON com campo "score" no output inteiro
 *
 * @param {string} raw - Output bruto do modelo
 * @returns {object|null} Objeto de score ou null se não encontrado
 */
function extrairScoreDoHTML(raw) {
  const marker = 'SCORE_JSON:';
  const idx = raw.indexOf(marker);

  if (idx !== -1) {
    try {
      const after = raw.slice(idx + marker.length).trim();
      const start = after.indexOf('{');
      const end   = after.indexOf('}', start) + 1;
      if (start !== -1 && end > start) {
        return JSON.parse(after.slice(start, end));
      }
    } catch { /* continua pro fallback */ }
  }

  // Fallback: regex para encontrar qualquer JSON com campo "score"
  // Útil se o modelo formatar o JSON de forma diferente do esperado
  const matches = raw.match(/\{[^{}]*"score"\s*:\s*[\d.]+[^{}]*\}/g);
  if (matches) {
    try { return JSON.parse(matches[matches.length - 1]); } catch { /* */ }
  }

  return null; // score não encontrado — frontend usará fallback de 5.0
}

/**
 * Remove o bloco SCORE_JSON do HTML e limpa delimitadores Markdown.
 * O modelo às vezes envolve o output em ```html``` mesmo quando pedimos para não fazer isso.
 *
 * @param {string} raw - Output bruto do modelo
 * @returns {string} HTML limpo, pronto para ser injetado no DOM
 */
function limparHTML(raw) {
  // Remove o bloco de score para não aparecer no HTML renderizado
  raw = raw.replace(/SCORE_JSON:\s*\{[^}]*\}/g, '').trim();

  // Remove delimitadores Markdown se o modelo os inseriu
  if (raw.startsWith('```html')) raw = raw.slice(7);
  else if (raw.startsWith('```'))  raw = raw.slice(3);
  if (raw.endsWith('```'))         raw = raw.slice(0, -3);

  return raw.trim();
}

/**
 * Extrai as 3 linguagens mais usadas do objeto de linguagens.
 * O objeto vem no formato { Python: 3, JavaScript: 2, CSS: 1 }
 * onde o número representa em quantos repos aquela linguagem aparece.
 *
 * @param {object|Array} linguagens
 * @returns {string} Ex: "Python, JavaScript, CSS"
 */
function extrairPrincipais(linguagens) {
  if (!linguagens || typeof linguagens !== 'object') return 'N/A';
  if (Array.isArray(linguagens)) return linguagens.slice(0, 3).join(', ') || 'N/A';
  return Object.entries(linguagens)
    .sort((a, b) => b[1] - a[1]) // ordena do mais para o menos usado
    .slice(0, 3)
    .map(([l]) => l)
    .join(', ') || 'N/A';
}

/**
 * Formata os repos com código real para inserção no user prompt.
 * Usa delimitadores <<<>>> para que o modelo identifique claramente
 * onde começa e termina cada repositório.
 *
 * @param {Array} reposComCodigo - Array de { meta, codigo, commit_count }
 * @returns {string} String formatada para o prompt
 */
function formatarRepos(reposComCodigo) {
  if (!reposComCodigo?.length) return 'Nenhum repositório com código disponível.';
  return reposComCodigo.map(repo =>
    `<<<REPOSITÓRIO: ${repo.meta} | Commits: ${repo.commit_count}>>>\n${repo.codigo}\n<<<FIM>>>`
  ).join('\n\n');
}

// ── Funções exportadas (usadas pelo server.js) ───────────────────────────────

/**
 * Usa LLaMA 3.1 8B para selecionar os 5 repos mais relevantes da lista.
 * Chamado pelo github-service.js antes de ler o código real dos repos.
 *
 * Por que usar IA para isso em vez de heurística simples?
 * A IA consegue entender a descrição do repo e inferir complexidade técnica
 * melhor do que qualquer combinação de métricas numéricas.
 *
 * @param {string[]} reposLista - Lista de strings descritivas dos repos
 * @returns {string[]} Nomes dos repos selecionados
 */
export async function selecionarRepositoriosComIA(reposLista) {
  if (!reposLista?.length) return [];
  try {
    const userPrompt = USER_OLHEIRO.replace('{repos}', reposLista.join('\n'));
    const content = await chamarGroq(SYSTEM_OLHEIRO, userPrompt, MODEL_OLHEIRO, 300, 0.1);

    // Extrai o array JSON da resposta
    const j = content.indexOf('[');
    const k = content.lastIndexOf(']') + 1;
    if (j !== -1 && k > j) return JSON.parse(content.slice(j, k));
  } catch (e) {
    console.warn('[Groq] Olheiro falhou:', e.message);
  }

  // Fallback: retorna os primeiros 5 nomes da lista
  return reposLista.slice(0, 5).map(r => r.split(' ')[0]);
}

/**
 * Gera a análise HTML completa + score do desenvolvedor.
 *
 * O score é gerado pelo próprio LLaMA 3.3 70B junto com a análise
 * em uma única chamada de API — mais preciso do que um modelo secundário
 * tentando adivinhar o score a partir do HTML já gerado.
 *
 * @param {object} params
 * @param {string} params.nome           - Nome do desenvolvedor
 * @param {string} params.bio            - Bio do perfil GitHub
 * @param {object} params.linguagens     - Objeto com contagem de linguagens
 * @param {Array}  params.repos_detalhes - Array de strings descritivas dos repos
 * @param {string} params.readme_text    - README do perfil
 * @param {string} params.login          - Username do GitHub
 * @param {string} params.contexto       - "recrutamento" | "autoanalise"
 * @param {string} params.jobDescription - Descrição da vaga (opcional)
 * @param {Array}  params.repos_com_codigo - Repos com código real lido
 * @returns {object} { analise: string (HTML), score: object }
 */
export async function gerarAnalise({
  nome, bio, linguagens, repos_detalhes, readme_text = '',
  login = '', contexto = 'recrutamento',
  jobDescription = null, repos_com_codigo = [],
}) {
  try {
    const principais      = extrairPrincipais(linguagens);
    const readme          = (readme_text || '').slice(0, README_MAX_CHARS);
    const reposFormatados = formatarRepos(repos_com_codigo);

    // Seleciona o system prompt e user prompt baseado no modo de análise
    let systemPrompt;
    let userPrompt;

    if (jobDescription) {
      // Modo: comparação com vaga específica
      systemPrompt = SYSTEM_COM_VAGA;
      userPrompt   = USER_COM_VAGA
        .replace('{nome}',             nome)
        .replace('{login}',            login)
        .replace('{bio}',              bio)
        .replace('{principais}',       principais)
        .replace('{repos_com_codigo}', reposFormatados)
        .replace('{job_description}',  jobDescription);

    } else if (contexto === 'autoanalise') {
      // Modo: feedback para o próprio desenvolvedor
      systemPrompt = SYSTEM_AUTOANALISE;
      userPrompt   = USER_AUTOANALISE
        .replace('{nome}',             nome)
        .replace('{login}',            login)
        .replace('{bio}',              bio)
        .replace('{readme}',           readme)
        .replace('{principais}',       principais)
        .replace('{repos_com_codigo}', reposFormatados);

    } else {
      // Modo padrão: avaliação de recrutamento
      systemPrompt = SYSTEM_RECRUTAMENTO;
      userPrompt   = USER_RECRUTAMENTO
        .replace('{nome}',             nome)
        .replace('{login}',            login)
        .replace('{bio}',              bio)
        .replace('{readme}',           readme)
        .replace('{principais}',       principais)
        .replace('{repos_com_codigo}', reposFormatados);
    }

    // Chamada principal — LLaMA 3.3 70B gera análise + score de uma vez
    const rawOutput   = await chamarGroq(systemPrompt, userPrompt, MODEL_PRINCIPAL, 4500, 0.65);

    // Extrai o score do output antes de limpar o HTML
    const scoreData   = extrairScoreDoHTML(rawOutput);

    // Remove o bloco SCORE_JSON e delimitadores Markdown do HTML
    const analiseHtml = limparHTML(rawOutput);

    return {
      analise: analiseHtml,
      // Fallback se o parse do score falhar — valores neutros em vez de erros
      score: scoreData ?? {
        score: 5.0, qualidade: 5, documentacao: 5, complexidade: 5,
        nivel: 'Júnior',
        resumo: 'Score não pôde ser extraído da análise.',
      },
    };

  } catch (e) {
    console.error('[Groq] Erro na análise:', e.message);
    // Retorna um card de erro HTML para o frontend exibir
    return {
      analise: `<div style="${ERROR_CARD_STYLE}"><h2>❌ Erro</h2><p>${e.message}</p></div>`,
      score: null,
    };
  }
}
