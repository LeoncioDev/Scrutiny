/**
 * server.js — Scrutiny API
 * Servidor principal do backend. Usa Node.js + Express.
 *
 * Responsabilidades:
 * - Servir os arquivos do frontend (HTML, CSS, JS)
 * - Expor as rotas HTTP da API
 * - Orquestrar a busca de dados do GitHub e a geração de análise com IA
 *
 * Rotas disponíveis:
 *   GET  /               → Página principal (index.html)
 *   GET  /sobre          → Página sobre o projeto (sobre.html)
 *   GET  /api/status     → Verifica se o servidor está no ar
 *   POST /analisar-perfil → Analisa um perfil GitHub com IA
 */

// Carrega as variáveis de ambiente do arquivo .env (GITHUB_TOKEN, GROQ_API_KEY)
import 'dotenv/config';

import express from 'express';
import cors    from 'cors';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

// Serviços internos
import { buscarDadosGithub, extrairUsername } from './github-service.js';
import { gerarAnalise } from './groq-service.js';

// Em módulos ES, __dirname não existe por padrão — reconstruímos manualmente
const __dirname    = dirname(fileURLToPath(import.meta.url));

// Caminho absoluto para a pasta do frontend (dentro do próprio backend no deploy)
const FRONTEND_DIR = join(__dirname, 'frontend');

// Porta do servidor — usa variável de ambiente se disponível (Hostinger), senão 8000
const PORT = process.env.PORT || 8000;

// ── Configuração do Express ──────────────────────────────────────────────────

const app = express();

// Permite requisições de outras origens (necessário quando frontend e backend
// estão em portas ou domínios diferentes durante desenvolvimento)
app.use(cors());

// Interpreta o body das requisições POST como JSON
app.use(express.json());

// Serve os arquivos estáticos do frontend com prefixo /static/
// O HTML referencia os assets assim: href="/static/style.css"
app.use('/static', express.static(FRONTEND_DIR));

// Serve também sem prefixo — fallback para assets referenciados sem /static/
app.use(express.static(FRONTEND_DIR));

// ── Rotas de páginas HTML ────────────────────────────────────────────────────

// Página principal — abre ao acessar http://localhost:8000
app.get('/', (req, res) => {
  res.sendFile(join(FRONTEND_DIR, 'index.html'));
});

// Página "Sobre o projeto"
app.get('/sobre', (req, res) => {
  res.sendFile(join(FRONTEND_DIR, 'sobre.html'));
});

// ── Rota principal da API ────────────────────────────────────────────────────

/**
 * POST /analisar-perfil
 *
 * Recebe um username ou URL do GitHub e retorna uma análise técnica gerada por IA.
 *
 * Body esperado (JSON):
 *   {
 *     usernameOrUrl: string,       // ex: "torvalds" ou "https://github.com/torvalds"
 *     contexto: string,            // "recrutamento" | "autoanalise"
 *     jobDescription?: string      // descrição da vaga (opcional)
 *   }
 *
 * Resposta (JSON):
 *   {
 *     analise: string,   // HTML com a análise gerada pela IA
 *     score: object      // notas de qualidade, documentação e complexidade
 *   }
 */
app.post('/analisar-perfil', async (req, res) => {
  const { usernameOrUrl, contexto = 'recrutamento', jobDescription } = req.body;

  // Valida se o campo obrigatório foi enviado
  if (!usernameOrUrl) {
    return res.status(400).json({ detail: 'usernameOrUrl é obrigatório.' });
  }

  // Extrai o username puro caso o usuário cole a URL completa do GitHub
  const username = extrairUsername(usernameOrUrl);

  try {
    // Passo 1: busca dados públicos do GitHub
    // Inclui: perfil, repos, código real dos arquivos e seleção por IA
    const dados = await buscarDadosGithub(username);

    // Passo 2: gera análise com LLaMA 3.3 70B via Groq
    // Retorna HTML formatado + objeto de score
    const resultado = await gerarAnalise({
      nome:             dados.nome,
      bio:              dados.bio,
      linguagens:       dados.linguagens,
      repos_detalhes:   dados.repos_detalhes,
      readme_text:      dados.readme_text,
      login:            dados.login,
      contexto,
      jobDescription:   jobDescription || null,
      repos_com_codigo: dados.repos_com_codigo,
    });

    res.json({ analise: resultado.analise, score: resultado.score });

  } catch (err) {
    console.error('[/analisar-perfil]', err.message);

    // Usuário não encontrado no GitHub
    if (err.status === 404) {
      return res.status(404).json({ detail: 'Usuário não encontrado no GitHub.' });
    }

    // Rate limit da API do GitHub (429 Too Many Requests)
    if (err.status === 403) {
      return res.status(429).json({ detail: 'Limite de requisições do GitHub atingido. Tente novamente mais tarde.' });
    }

    // Erro genérico do servidor
    res.status(500).json({ detail: err.message || 'Erro interno do servidor.' });
  }
});

// ── Rota de status ───────────────────────────────────────────────────────────

// Útil para verificar se o servidor está rodando (health check)
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0-node' });
});

// ── Inicialização do servidor ────────────────────────────────────────────────

const server = createServer(app);

server.listen(PORT, () => {
  console.log(`\n🚀 Scrutiny rodando em http://localhost:${PORT}`);
  console.log(`   Frontend: ${FRONTEND_DIR}\n`);
});

// Encerramento gracioso ao pressionar Ctrl+C
// Garante que conexões abertas sejam finalizadas antes de sair
process.on('SIGINT', () => {
  console.log('\n[Server] Encerrando...');
  server.close(() => process.exit(0));
});