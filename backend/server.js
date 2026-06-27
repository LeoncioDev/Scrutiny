/**
 * server.js — Scrutiny API
 *
 * Rotas:
 *   GET  /           → index.html
 *   GET  /sobre      → sobre.html
 *   GET  /api/status → health check
 *   POST /analisar-perfil → analisa perfil GitHub
 */

import 'dotenv/config';
import express  from 'express';
import cors     from 'cors';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

import { buscarDadosGithub, extrairUsername } from './github-service.js';
import { gerarAnalise } from './groq-service.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = join(__dirname, 'frontend');
const PORT         = process.env.PORT || 8000;

const app = express();
app.use(cors());
app.use(express.json());
app.use('/static', express.static(FRONTEND_DIR));
app.use(express.static(FRONTEND_DIR));

app.get('/',      (req, res) => res.sendFile(join(FRONTEND_DIR, 'index.html')));
app.get('/sobre', (req, res) => res.sendFile(join(FRONTEND_DIR, 'sobre.html')));

/**
 * POST /analisar-perfil
 * Body: { usernameOrUrl, jobDescription? }
 */
app.post('/analisar-perfil', async (req, res) => {
  const { usernameOrUrl, jobDescription } = req.body;

  if (!usernameOrUrl) {
    return res.status(400).json({ detail: 'usernameOrUrl é obrigatório.' });
  }

  const username = extrairUsername(usernameOrUrl);

  try {
    /* Busca dados do GitHub — só READMEs e linguagens, sem código */
    const dados = await buscarDadosGithub(username);

    /* Gera análise com IA baseada apenas na documentação */
    const resultado = await gerarAnalise({
      nome:           dados.nome,
      bio:            dados.bio,
      linguagens:     dados.linguagens,
      readme_text:    dados.readme_text,
      login:          dados.login,
      jobDescription: jobDescription || null,
      repos:          dados.repos,
    });

    /* Retorna análise + dados estruturados dos repos para o frontend */
    res.json({
      analise:    resultado.analise,
      repos:      dados.repos,       /* cards de projetos */
      linguagens: dados.linguagens,  /* tags de tecnologias */
      perfil: {
        nome:     dados.nome,
        login:    dados.login,
        bio:      dados.bio,
        avatar:   dados.avatar,
        html_url: dados.html_url,
      },
    });

  } catch (err) {
    console.error('[/analisar-perfil]', err.message);

    if (err.status === 404) {
      return res.status(404).json({ detail: 'Usuário não encontrado no GitHub.' });
    }
    if (err.status === 403) {
      return res.status(429).json({ detail: 'Limite de requisições do GitHub atingido. Tente novamente em breve.' });
    }

    res.status(500).json({ detail: err.message || 'Erro interno do servidor.' });
  }
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', version: '3.0.0' });
});

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`\n🚀 Scrutiny rodando em http://localhost:${PORT}`);
  console.log(`   Frontend: ${FRONTEND_DIR}\n`);
});

process.on('SIGINT', () => {
  console.log('\n[Server] Encerrando...');
  server.close(() => process.exit(0));
});