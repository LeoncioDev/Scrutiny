/**
 * github-service.js
 * Busca dados públicos de um usuário do GitHub.
 *
 * Estratégia simples e confiável:
 *  - Pega os 3 repos públicos mais recentes (não forks)
 *  - Lê README e linguagens de cada um
 *  - Lê README do perfil se existir
 *  - NÃO lê código — evita estourar tokens do Groq
 */

import { Octokit } from '@octokit/rest';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const MAX_README_PERFIL = 600;  /* chars do README do perfil */
const MAX_README_REPO   = 500;  /* chars do README de cada repo */

/**
 * Ponto de entrada principal.
 * @param {string} username
 */
export async function buscarDadosGithub(username) {

  /* 1. Perfil público */
  const { data: user } = await octokit.users.getByUsername({ username });

  /* 3. Lista repos públicos ordenados por push recente */
  const { data: todosRepos } = await octokit.repos.listForUser({
    username,
    sort:      'pushed',
    direction: 'desc',
    per_page:  30,
  });

  /* Filtra forks e repo de perfil (repo com mesmo nome do usuário ou do nome real) */
  const reposFiltrados = todosRepos.filter(r =>
    !r.fork &&
    r.name.toLowerCase() !== username.toLowerCase() &&
    r.name.toLowerCase() !== (user.login || '').toLowerCase()
  );

  /* Pega os 3 mais recentes */
  const reposSelecionados = reposFiltrados.slice(0, 3);

  /* 4. Para cada repo: linguagens + README */
  const linguagens = {};
  const reposDetalhes = [];

  for (const repo of reposSelecionados) {
    /* Linguagens */
    let langStr = '';
    try {
      const { data: langs } = await octokit.repos.listLanguages({
        owner: username,
        repo:  repo.name,
      });
      langStr = Object.keys(langs).join(', ');
      /* Agrega linguagens do perfil geral */
      for (const lang of Object.keys(langs)) {
        linguagens[lang] = (linguagens[lang] || 0) + 1;
      }
    } catch { /* sem linguagens detectadas */ }

    /* README do repo */
    let readme = '';
    try {
      const { data: readmeData } = await octokit.repos.getReadme({
        owner: username,
        repo:  repo.name,
      });
      readme = Buffer.from(readmeData.content, 'base64')
        .toString('utf-8')
        .slice(0, MAX_README_REPO);
    } catch { /* repo sem README */ }

    reposDetalhes.push({
      nome:        repo.name,
      descricao:   repo.description || '',
      linguagens:  langStr,
      stars:       repo.stargazers_count,
      readme,
      url:         repo.html_url,
    });
  }

  return {
    nome:         user.name || username,
    login:        user.login,
    bio:          user.bio || '',
    avatar:       user.avatar_url,
    html_url:     user.html_url,
    public_repos: user.public_repos,
    linguagens,
    readme_text:  '',   /* perfil README ignorado — IA lê só docs de projetos */
    repos:        reposDetalhes,
  };
}

/**
 * Busca o README do perfil do usuário.
 */
/**
 * Remove linhas que não agregam para a IA:
 * badges (![...]), links de imagem, linhas só com URLs,
 * tags HTML inline, linhas vazias em excesso.
 */
function limparReadme(texto) {
  return texto
    .split('\n')
    .filter(l => {
      const t = l.trim();
      if (!t) return false;                          /* linha vazia       */
      if (/^!\[.*\]\(/.test(t)) return false;      /* imagens/badges    */
      if (/^<img|^<a |^<div|^<p /i.test(t)) return false; /* HTML inline  */
      if (/^https?:\/\//.test(t)) return false;    /* URLs soltas       */
      if (/^\[.*\]:\s*https?/.test(t)) return false; /* referências MD  */
      return true;
    })
    .join('\n')
    .trim();
}

async function buscarReadmePerfil(username) {
  try {
    const { data } = await octokit.repos.getReadme({
      owner: username,
      repo:  username,
    });
    const raw = Buffer.from(data.content, 'base64').toString('utf-8');
    return limparReadme(raw).slice(0, MAX_README_PERFIL);
  } catch {
    return '';
  }
}

/**
 * Extrai username de URL ou string direta.
 */
export function extrairUsername(valor) {
  if (valor.includes('github.com/')) {
    return valor.split('github.com/')[1].split('/')[0].trim();
  }
  return valor.trim();
}