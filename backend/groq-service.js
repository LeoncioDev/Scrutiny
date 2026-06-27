/**
 * groq-service.js — Scrutiny v3
 * Prompts mínimos para caber em 12k TPM do Groq gratuito.
 */

import Groq from 'groq-sdk';

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = 'llama-3.3-70b-versatile';
const CARD  = 'border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px;';
const ERR   = 'border:1px solid #f85149;border-radius:8px;padding:16px;margin-bottom:16px;background:rgba(248,81,73,0.08);';

/* System curto */
const SYSTEM = `Dev sênior dando opinião honesta sobre um perfil GitHub.
Baseie-se apenas nos dados fornecidos. Se não tiver README, diga "sem documentação".
Não mencione commits, estrelas ou frequência de push.
FORMATO: apenas HTML. Sem markdown. Envolva seções em <div style="${CARD}">. Use <h2> e <p>.`.trim();

/* User prompt mínimo */
function buildPrompt({ nome, login, bio, readme_text, linguagens, repos, jobDescription }) {
  const langs = Object.keys(linguagens || {}).slice(0, 8).join(', ') || 'não identificadas';
  const readme = (readme_text || '').slice(0, 300);

  const reposStr = (repos || []).slice(0, 3).map(r =>
    `[${r.nome}] ${r.descricao || ''}\nREADME: ${(r.readme || 'sem readme').slice(0, 200)}`
  ).join('\n---\n');

  if (jobDescription) {
    return `Dev: ${nome} (@${login})\nLinguagens: ${langs}\nProjetos:\n${reposStr}\nVAGA:\n${jobDescription.slice(0, 400)}\n\nGere 2 seções HTML: "Perfil vs vaga" e "O que os projetos mostram".`;
  }

  return `Dev: ${nome} (@${login})\nBio: ${bio || ''}\nREADME perfil: ${readme}\nLinguagens: ${langs}\nProjetos:\n${reposStr}\n\nGere 2 seções HTML: "Impressão geral" (2 parágrafos) e "O que cada projeto faz" (1 parágrafo por projeto).`;
}

function limparHTML(raw) {
  if (raw.startsWith('```html')) raw = raw.slice(7);
  else if (raw.startsWith('```')) raw = raw.slice(3);
  if (raw.endsWith('```')) raw = raw.slice(0, -3);
  return raw.trim();
}

export async function gerarAnalise(params) {
  try {
    const userPrompt = buildPrompt(params);

    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM      },
        { role: 'user',   content: userPrompt  },
      ],
      max_tokens:  1200,
      temperature: 0.65,
    });

    const raw = response.choices[0].message.content.trim();
    return { analise: limparHTML(raw) };

  } catch (e) {
    console.error('[Groq]', e.message);
    return { analise: `<div style="${ERR}"><h2>❌ Erro</h2><p>${e.message}</p></div>` };
  }
}