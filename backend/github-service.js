/**
 * github-service.js
 * Responsável por buscar todos os dados públicos de um usuário do GitHub.
 *
 * Usa a biblioteca @octokit/rest (cliente oficial do GitHub para Node.js).
 * Toda comunicação com a API do GitHub passa por aqui.
 *
 * Fluxo completo:
 * 1. Busca perfil do usuário (nome, bio, seguidores)
 * 2. Busca README do perfil (repo especial com mesmo nome do usuário)
 * 3. Lista até 30 repositórios públicos, ignorando forks
 * 4. Para cada repo: lê linguagens e conteúdo do README
 * 5. Envia lista de repos para IA selecionar os 5 mais relevantes
 * 6. Lê arquivos de código real de cada repo selecionado
 * 7. Conta commits de cada repo selecionado
 */

import { Octokit } from '@octokit/rest';
import { selecionarRepositoriosComIA } from './groq-service.js';

// Instância autenticada do cliente GitHub
// O GITHUB_TOKEN aumenta o rate limit de 60 para 5000 requisições/hora
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Extensões de arquivo que contêm código e valem a pena ser analisadas pela IA
// Arquivos de configuração, assets e docs são ignorados propositalmente
const EXTENSOES_CODIGO = new Set([
  '.py', '.js', '.ts', '.java', '.go', '.rs', '.cpp', '.c',
  '.cs', '.rb', '.php', '.kt', '.swift', '.scala', '.sh',
]);

// Limites de leitura de código — calibrados para não estourar o limite de
// tokens por minuto (TPM) do Groq no plano gratuito (12.000 TPM)
const MAX_REPOS_TO_SCAN    = 30;    // máximo de repos listados para pré-seleção
const MAX_CHARS_POR_ARQ    = 2000;  // máximo de caracteres lidos por arquivo
const MAX_ARQS_POR_REPO    = 3;     // máximo de arquivos lidos por repositório
const MAX_CHARS_TOTAL_REPO = 5000;  // teto total de caracteres por repositório

// Pastas que geralmente contêm o código principal do projeto
// São priorizadas na leitura de arquivos — evita ler testes ou configs primeiro
const PASTAS_PRIORITARIAS = new Set([
  'src', 'app', 'lib', 'core', 'api', 'backend', 'main',
  'server', 'services', 'controllers', 'routes', 'models',
]);

/**
 * Ponto de entrada principal do serviço.
 * Busca todos os dados públicos de um usuário e retorna um objeto completo
 * com perfil, linguagens, repos selecionados e código real.
 *
 * @param {string} username - Username do GitHub (ex: "torvalds")
 * @returns {object} Dados completos do perfil + repos com código
 */
export async function buscarDadosGithub(username) {
  // Busca dados básicos do perfil público
  const { data: user } = await octokit.users.getByUsername({ username });

  const nome        = user.name || username; // nome real ou username como fallback
  const bio         = user.bio  || 'Sem biografia.';
  const seguidores  = user.followers;
  const seguindo    = user.following;
  const publicRepos = user.public_repos;

  // Busca o README especial do perfil (repo com mesmo nome do usuário)
  // Exemplo: github.com/torvalds/torvalds → README.md do perfil
  const readmeText = await buscarReadmePerfil(username);

  // Mapeia todos os repos públicos do usuário com metadados e README
  const { linguagens, reposMap, reposParaSelecao, reposObjetos } =
    await mapearRepositorios(username, nome);

  // Usa LLaMA 3.1 8B para selecionar os 5 repos mais relevantes tecnicamente
  let reposSelecionadosNomes = [];
  if (reposParaSelecao.length > 0) {
    reposSelecionadosNomes = await selecionarRepositoriosComIA(reposParaSelecao);
  }

  // Fallback: se a IA não retornar nada, usa os 5 primeiros da lista
  if (!reposSelecionadosNomes.length) {
    reposSelecionadosNomes = Object.keys(reposObjetos).slice(0, 5);
  }

  // Para cada repo selecionado, lê o código real e conta commits
  const reposComCodigo = [];
  for (const nome_repo of reposSelecionadosNomes) {
    const repoObj = reposObjetos[nome_repo];
    if (!repoObj) continue; // pula se a IA retornou um nome que não existe

    const meta        = reposMap[nome_repo] || nome_repo;
    const codigo      = await lerCodigoRepo(username, nome_repo, repoObj.defaultBranch);
    const commitCount = await contarCommits(username, nome_repo);

    reposComCodigo.push({ meta, codigo, commit_count: commitCount });
  }

  return {
    nome,
    login:            user.login,
    html_url:         user.html_url,
    bio,
    seguidores,
    seguindo,
    public_repos:     publicRepos,
    linguagens,                                    // objeto { Python: 3, JS: 2, ... }
    repos_detalhes:   reposComCodigo.map(r => r.meta), // array de strings descritivas
    repos_com_codigo: reposComCodigo,              // array com código real para a IA
    readme_text:      readmeText,                  // README do perfil do usuário
  };
}

/**
 * Busca o README do repositório de perfil do usuário.
 * O GitHub permite criar um repo com o mesmo nome do usuário cujo README
 * aparece na página de perfil. Ex: github.com/LeoncioDev/LeoncioDev
 *
 * @param {string} username
 * @returns {string} Conteúdo do README ou mensagem padrão se não existir
 */
async function buscarReadmePerfil(username) {
  try {
    const { data } = await octokit.repos.getReadme({ owner: username, repo: username });
    // O conteúdo vem em Base64 — decodifica e limita para não desperdiçar tokens
    return Buffer.from(data.content, 'base64').toString('utf-8').slice(0, 1000);
  } catch {
    // Erro 404 = usuário não tem repo de perfil — não é um problema
    return 'Nenhum README de perfil público encontrado.';
  }
}

/**
 * Lista e mapeia todos os repositórios públicos do usuário.
 * Para cada repo: busca linguagens e lê o README (até 800 chars).
 *
 * Repositórios ignorados:
 * - Forks (não são código próprio do dev)
 * - Repo de perfil (mesmo nome do usuário — já lido em buscarReadmePerfil)
 *
 * @param {string} username
 * @param {string} nome - Nome real do usuário (para filtrar repo de perfil)
 * @returns {object} linguagens, reposMap, reposParaSelecao, reposObjetos
 */
async function mapearRepositorios(username, nome) {
  const linguagens       = {}; // { Python: 3, JavaScript: 2 } — contagem por linguagem
  const reposMap         = {}; // { "nome-repo": "string descritiva com README" }
  const reposParaSelecao = []; // lista de strings para o olheiro (LLaMA 3.1 8B)
  const reposObjetos     = {}; // { "nome-repo": { defaultBranch: "main" } }

  // Busca repos ordenados por data de push (mais recentes primeiro)
  const { data: repos } = await octokit.repos.listForUser({
    username,
    sort:      'pushed',
    direction: 'desc',
    per_page:  MAX_REPOS_TO_SCAN,
  });

  for (const repo of repos) {
    // Ignora forks e repo de perfil
    if (repo.fork || repo.name === nome || repo.name === username) continue;

    try {
      // Busca as linguagens usadas no repo (retorna objeto { Python: 12543, JS: 8432 })
      const { data: langs } = await octokit.repos.listLanguages({
        owner: username,
        repo:  repo.name,
      });

      const langStr = Object.keys(langs).join(', ') || 'sem linguagem';

      // Agrega as linguagens para o perfil geral do dev
      for (const lang of Object.keys(langs)) {
        linguagens[lang] = (linguagens[lang] || 0) + 1;
      }

      // Lê o conteúdo real do README do repo (não só verifica se existe)
      // Isso permite que a IA avalie a qualidade da documentação de verdade
      let temReadme = '❌ Sem README';
      let readmeConteudo = '';
      try {
        const { data: readmeData } = await octokit.repos.getReadme({ owner: username, repo: repo.name });
        readmeConteudo = Buffer.from(readmeData.content, 'base64').toString('utf-8').slice(0, 800);
        temReadme = '✅ README';
      } catch { /* repo sem README — não é erro, só não tem */ }

      const desc  = repo.description || 'Sem descrição';
      const stars = repo.stargazers_count;

      // Estrelas só aparecem no meta se o repo tiver pelo menos 1
      // Dev júnior não tem estrelas e não deve ser penalizado por isso
      const starsStr = stars > 0 ? ` - ⭐ ${stars} estrelas` : '';

      // String descritiva do repo — enviada para a IA junto com o código real
      const meta = readmeConteudo
        ? `${repo.name} (${langStr}) - ${temReadme}${starsStr} - ${desc}\nREADME:\n${readmeConteudo}`
        : `${repo.name} (${langStr}) - ${temReadme}${starsStr} - ${desc}`;

      reposMap[repo.name]     = meta;
      reposObjetos[repo.name] = { defaultBranch: repo.default_branch };

      // Versão resumida para a pré-seleção pelo olheiro (economiza tokens)
      reposParaSelecao.push(`${repo.name} - ${desc} (${langStr})`);

    } catch (err) {
      // Erro ao processar um repo específico não deve parar a análise inteira
      console.warn(`[GitHub] Erro ao processar repo ${repo.name}: ${err.message}`);
    }
  }

  return { linguagens, reposMap, reposParaSelecao, reposObjetos };
}

/**
 * Lê os arquivos de código mais relevantes de um repositório.
 *
 * Estratégia de priorização:
 * 1. Arquivos em pastas como src/, app/, services/ têm prioridade
 * 2. Arquivos na raiz vêm depois
 * 3. Para quando atingir MAX_ARQS_POR_REPO ou MAX_CHARS_TOTAL_REPO
 *
 * Usa a Git Trees API (mais eficiente que getContents recursivo)
 * pois retorna a estrutura completa do repo em uma única chamada.
 *
 * @param {string} owner - Username do dono do repo
 * @param {string} repo - Nome do repositório
 * @param {string} defaultBranch - Branch principal (main, master, etc)
 * @returns {string} Código formatado em Markdown ou mensagem de erro
 */
async function lerCodigoRepo(owner, repo, defaultBranch = 'main') {
  try {
    // Busca a árvore completa de arquivos do repo em uma única chamada
    const { data: tree } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha:  defaultBranch,
      recursive: '1', // inclui subpastas recursivamente
    });

    const arquivosPrioritarios = []; // arquivos em pastas como src/, app/
    const arquivosNormais      = []; // arquivos na raiz ou outras pastas

    for (const item of tree.tree) {
      if (item.type !== 'blob') continue; // ignora diretórios

      const partes = item.path.split('/');
      const ext    = '.' + (item.path.split('.').pop() || '').toLowerCase();

      // Ignora arquivos que não são código (configs, assets, docs, etc)
      if (!EXTENSOES_CODIGO.has(ext)) continue;

      // Classifica o arquivo por prioridade baseado na pasta pai
      if (partes.length > 1 && PASTAS_PRIORITARIAS.has(partes[0].toLowerCase())) {
        arquivosPrioritarios.push(item);
      } else {
        arquivosNormais.push(item);
      }
    }

    // Processa prioritários primeiro, depois normais
    const fila          = [...arquivosPrioritarios, ...arquivosNormais];
    const arquivosLidos = [];
    let totalChars      = 0;
    let processados     = 0;

    for (const item of fila) {
      // Para quando atingir os limites definidos
      if (processados >= MAX_ARQS_POR_REPO) break;
      if (totalChars  >= MAX_CHARS_TOTAL_REPO) break;

      try {
        // Busca o conteúdo do arquivo (vem em Base64)
        const { data: blob } = await octokit.repos.getContent({
          owner, repo, path: item.path,
        });

        if (!blob.content) continue; // arquivo vazio ou binário

        // Decodifica e trunca para não estourar os tokens do Groq
        const conteudo = Buffer.from(blob.content, 'base64')
          .toString('utf-8')
          .slice(0, MAX_CHARS_POR_ARQ);

        // Formata como bloco de código Markdown — facilita a leitura pela IA
        const ext = item.path.split('.').pop() || '';
        arquivosLidos.push(`### ${item.path}\n\`\`\`${ext}\n${conteudo}\n\`\`\``);
        totalChars += conteudo.length;
        processados++;

      } catch { /* arquivo inacessível (permissão, arquivo muito grande, etc) */ }
    }

    return arquivosLidos.length
      ? arquivosLidos.join('\n\n')
      : 'Nenhum arquivo de código acessível encontrado.';

  } catch (err) {
    console.warn(`[GitHub] Erro ao ler código de ${repo}: ${err.message}`);
    return 'Erro ao acessar conteúdo do repositório.';
  }
}

/**
 * Conta o número de commits de um repositório.
 * Limitado a 100 por performance — suficiente para avaliar atividade básica.
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {number} Número de commits (0 se falhar)
 */
async function contarCommits(owner, repo) {
  try {
    const { data } = await octokit.repos.listCommits({ owner, repo, per_page: 100 });
    return data.length;
  } catch {
    return 0; // falha silenciosa — commits não são críticos para a análise
  }
}

/**
 * Extrai o username puro de uma entrada que pode ser username ou URL do GitHub.
 *
 * Exemplos:
 *   "torvalds"                        → "torvalds"
 *   "https://github.com/torvalds"     → "torvalds"
 *   "https://github.com/torvalds/linux" → "torvalds"
 *
 * @param {string} valor - Username ou URL do GitHub
 * @returns {string} Username limpo
 */
export function extrairUsername(valor) {
  if (valor.includes('github.com/')) {
    return valor.split('github.com/')[1].split('/')[0].trim();
  }
  return valor.trim();
}
