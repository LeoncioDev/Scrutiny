/**
 * script.js — Frontend do Scrutiny v3
 *
 * Responsabilidades:
 *  - Efeito de digitação no subtítulo do hero
 *  - Pulso no input ao focar
 *  - Loader estilo terminal com log lines e barra de progresso
 *  - Renderiza tags de tecnologias animadas
 *  - Renderiza cards dos 3 projetos mais recentes
 *  - Renderiza opinião da IA com entrada escalonada por bloco
 */

document.addEventListener('DOMContentLoaded', () => {

  /* ── Referências DOM ────────────────────────────────────── */
  const form        = document.getElementById('form');
  const inputUser   = document.getElementById('username');
  const btnRun      = document.getElementById('btn-run');
  const loader      = document.getElementById('loader');
  const errorStrip  = document.getElementById('error-strip');
  const errorMsg    = document.getElementById('error-msg');
  const resultPanel = document.getElementById('result-panel');
  const resultBody  = document.getElementById('result-body');
  const techWrap    = document.getElementById('tech-wrap');
  const reposWrap   = document.getElementById('repos-wrap');

  /* ── Efeito de digitação no subtítulo ───────────────────────
     Digita o texto letra por letra após 600ms.
     Simula um terminal exibindo o texto em tempo real.        */
  const heroSub = document.querySelector('.hero-sub');
  if (heroSub) {
    const text = heroSub.textContent.trim();
    heroSub.textContent = '';
    heroSub.style.cssText = 'opacity:1;transform:none;animation:none;';
    let ci = 0;
    setTimeout(function type() {
      heroSub.textContent = text.slice(0, ++ci);
      if (ci < text.length) setTimeout(type, 18);
    }, 600);
  }

  /* ── Pulso no input ao focar ────────────────────────────────
     Adiciona classe que dispara animação de pulso no CSS.
     Remove após 600ms para permitir nova ativação.            */
  inputUser.addEventListener('focus', () => {
    inputUser.classList.add('input-activated');
    setTimeout(() => inputUser.classList.remove('input-activated'), 600);
  });

  /* ── Submit do formulário ───────────────────────────────── */
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = inputUser.value.trim();
    if (!username) return showError('Digite um usuário ou cole uma URL do GitHub.');
    await run(username);
  });

  /**
   * Orquestra a chamada à API e atualiza a UI.
   * @param {string} username - Username ou URL do GitHub
   */
  async function run(username) {
    showLoader();
    hideError();
    hideResult();
    btnRun.disabled = true;

    try {
      const res = await fetch('/analisar-perfil', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ usernameOrUrl: username }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Erro ao processar.');

      showResult(data);

    } catch (err) {
      showError(err.message);
    } finally {
      hideLoader();
      btnRun.disabled = false;
    }
  }

  /* ── Loader estilo terminal ─────────────────────────────────
     Log lines aparecem uma a uma com delay realista.
     Barra de progresso avança junto com cada step.            */
  const LOG_LINES = [
    { label: '→ Conectando à API do GitHub...', delay: 0,    pct: 10 },
    { label: '→ Buscando perfil público...',    delay: 800,  pct: 25 },
    { label: '→ Lendo READMEs dos projetos...', delay: 2000, pct: 45 },
    { label: '→ Detectando tecnologias...',     delay: 3500, pct: 60 },
    { label: '→ Gerando opinião com IA...',     delay: 5000, pct: 80 },
    { label: '→ Formatando resultado...',       delay: 8000, pct: 95 },
  ];

  let logTimers = [];

  function showLoader() {
    loader.classList.add('visible');

    const logWrap = document.getElementById('loader-log');
    const bar     = document.getElementById('loader-bar-fill');
    logWrap.innerHTML = '';
    bar.style.width   = '0%';

    LOG_LINES.forEach(({ label, delay, pct }) => {
      const t = setTimeout(() => {
        /* Cria linha de log e anima entrada */
        const line = document.createElement('div');
        line.className   = 'log-line';
        line.textContent = label;
        logWrap.appendChild(line);
        requestAnimationFrame(() => line.classList.add('in'));
        logWrap.scrollTop = logWrap.scrollHeight;

        /* Avança barra de progresso */
        bar.style.width = pct + '%';
      }, delay);
      logTimers.push(t);
    });
  }

  function hideLoader() {
    /* Completa a barra antes de esconder */
    const bar = document.getElementById('loader-bar-fill');
    bar.style.width = '100%';
    setTimeout(() => {
      loader.classList.remove('visible');
      logTimers.forEach(clearTimeout);
      logTimers = [];
    }, 400);
  }

  /* ── Erro ────────────────────────────────────────────────── */
  function showError(msg) {
    errorMsg.textContent = msg;
    errorStrip.classList.add('visible');
  }

  function hideError() {
    errorStrip.classList.remove('visible');
  }

  /* ── Resultado ───────────────────────────────────────────── */
  function showResult(data) {
    resultPanel.classList.add('visible');
    renderTecnologias(data.linguagens);
    renderProjetos(data.repos);
    renderBodyAnimated(data.analise);

    /* Scroll suave até o resultado */
    setTimeout(
      () => resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      150
    );
  }

  function hideResult() {
    resultPanel.classList.remove('visible');
    resultBody.innerHTML = '';
    techWrap.innerHTML   = '';
    reposWrap.innerHTML  = '';
  }

  /**
   * Renderiza tags de tecnologias com entrada escalonada.
   * Cada tag entra com delay de 60ms — efeito de "impressão" progressiva.
   * Ordenadas por quantidade de repos onde aparecem.
   *
   * @param {object} linguagens - { JavaScript: 2, CSS: 1, ... }
   */
  function renderTecnologias(linguagens) {
    techWrap.innerHTML = '';

    if (!linguagens || !Object.keys(linguagens).length) {
      techWrap.innerHTML = '<span class="tech-empty">Nenhuma tecnologia detectada</span>';
      return;
    }

    const sorted = Object.entries(linguagens).sort((a, b) => b[1] - a[1]);

    sorted.forEach(([lang, count], i) => {
      const tag = document.createElement('span');
      tag.className    = 'tech-tag';
      tag.textContent  = lang;
      tag.title        = `Aparece em ${count} repositório${count > 1 ? 's' : ''}`;
      tag.style.cssText = 'opacity:0;transform:translateY(8px) scale(0.92);transition:opacity 0.35s ease,transform 0.35s ease;';
      techWrap.appendChild(tag);

      setTimeout(() => {
        tag.style.opacity   = '1';
        tag.style.transform = 'translateY(0) scale(1)';
      }, i * 60);
    });
  }

  /**
   * Renderiza cards dos 3 projetos mais recentes.
   * Cada card entra com delay de 150ms — cascata suave.
   *
   * @param {Array} repos - Array de { nome, descricao, linguagens, stars, readme }
   */
  function renderProjetos(repos) {
    reposWrap.innerHTML = '';
    if (!repos?.length) return;

    repos.forEach((repo, i) => {
      const card = document.createElement('div');
      card.className    = 'repo-card';
      card.style.cssText = 'opacity:0;transform:translateY(12px);transition:opacity 0.4s ease,transform 0.4s ease;';

      /* Trecho do README — remove caracteres Markdown */
      const readmeHtml = repo.readme
        ? `<p class="repo-readme">${repo.readme.slice(0, 180).replace(/[#*`[\]]/g, '').trim()}${repo.readme.length > 180 ? '...' : ''}</p>`
        : '<p class="repo-readme repo-no-readme">Sem documentação disponível.</p>';

      /* Estrelas — só exibe se tiver */
      const starsHtml = repo.stars > 0
        ? `<span class="repo-stars">★ ${repo.stars}</span>`
        : '';

      /* Tags de linguagens do repo */
      const langsHtml = repo.linguagens
        ? repo.linguagens.split(', ').map(l => `<span class="repo-lang-tag">${l}</span>`).join('')
        : '';

      card.innerHTML = `
        <div class="repo-card-header">
          <span class="repo-name">${repo.nome}</span>
          ${starsHtml}
        </div>
        ${repo.descricao ? `<p class="repo-desc">${repo.descricao}</p>` : ''}
        <div class="repo-langs">${langsHtml}</div>
        ${readmeHtml}
      `;

      reposWrap.appendChild(card);

      setTimeout(() => {
        card.style.opacity   = '1';
        card.style.transform = 'translateY(0)';
      }, i * 150);
    });
  }

  /**
   * Injeta HTML da IA e anima cada bloco filho com delay escalonado.
   * Parece que o relatório está sendo "impresso" em tempo real.
   *
   * @param {string} html - HTML gerado pela IA
   */
  function renderBodyAnimated(html) {
    resultBody.innerHTML = html;
    Array.from(resultBody.children).forEach((el, i) => {
      el.style.cssText = 'opacity:0;transform:translateY(10px);transition:opacity 0.4s ease,transform 0.4s ease;';
      setTimeout(() => {
        el.style.opacity   = '1';
        el.style.transform = 'translateY(0)';
      }, i * 130);
    });
  }

});