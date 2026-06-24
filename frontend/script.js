/**
 * script.js — Frontend do Scrutiny
 * Responsável por toda a interação do usuário na página principal.
 *
 * Responsabilidades:
 * - Capturar o formulário de análise e enviar para a API
 * - Gerenciar o loader com steps animados durante a análise
 * - Renderizar o HTML da análise retornado pela IA
 * - Animar o card de score (número contando, barras deslizando)
 * - Exibir e esconder mensagens de erro
 * - Controlar o campo colapsável de descrição de vaga
 */

document.addEventListener("DOMContentLoaded", () => {

  // ── Referências aos elementos do DOM ────────────────────────────────────────

  const form        = document.getElementById("form");
  const inputUser   = document.getElementById("username");
  const btnRun      = document.getElementById("btn-run");
  const loader      = document.getElementById("loader");
  const loaderLabel = document.getElementById("loader-label");
  const loaderSub   = document.getElementById("loader-sub");
  const errorStrip  = document.getElementById("error-strip");
  const errorMsg    = document.getElementById("error-msg");
  const resultPanel = document.getElementById("result-panel");
  const resultBody  = document.getElementById("result-body");

  // Elementos do card de score
  const scoreCard   = document.getElementById("score-card");
  const scoreNumber = document.getElementById("score-number");
  const scoreLevel  = document.getElementById("score-level");
  const scoreResumo = document.getElementById("score-resumo");

  // Barras e valores do score (qualidade, atividade, documentação)
  const barQ = document.getElementById("bar-qualidade");
  const barA = document.getElementById("bar-atividade");
  const barD = document.getElementById("bar-documentacao");
  const valQ = document.getElementById("val-qualidade");
  const valA = document.getElementById("val-atividade");
  const valD = document.getElementById("val-documentacao");

  // Elementos do campo colapsável de vaga
  const jobToggleBtn  = document.getElementById("job-toggle-btn");
  const jobToggleIcon = document.getElementById("job-toggle-icon");
  const jobField      = document.getElementById("job-field");
  const jobTextarea   = document.getElementById("job-description");

  // ── Steps do loader ──────────────────────────────────────────────────────────
  // O loader alterna entre steps a cada 4.5 segundos para dar feedback
  // visual ao usuário enquanto a análise (que pode demorar 20-30s) acontece

  // Steps para análise sem vaga (recrutamento ou autoanálise)
  const STEPS_BASE = [
    ["Buscando dados do GitHub",   "Coletando repositórios e informações do perfil..."],
    ["IA selecionando projetos",   "Identificando os repositórios mais relevantes..."],
    ["Gerando análise técnica",    "Isso pode levar alguns segundos..."],
  ];

  // Steps para análise com vaga (inclui step de match)
  const STEPS_VAGA = [
    ["Buscando dados do GitHub",   "Coletando repositórios e informações do perfil..."],
    ["IA selecionando projetos",   "Identificando os repositórios mais relevantes..."],
    ["Avaliando match com a vaga", "Comparando requisitos da vaga com o perfil..."],
    ["Gerando relatório final",    "Isso pode levar alguns segundos..."],
  ];

  // Timer do loader — guardado para cancelar quando a análise terminar
  let stepTimer = null;

  // ── Campo de vaga colapsável ─────────────────────────────────────────────────
  // O campo de descrição de vaga é opcional e começa escondido

  let jobOpen = false; // controla se o campo está aberto

  jobToggleBtn.addEventListener("click", () => {
    jobOpen = !jobOpen;

    // Atualiza atributos de acessibilidade
    jobToggleBtn.setAttribute("aria-expanded", jobOpen);
    jobField.setAttribute("aria-hidden", !jobOpen);

    // Adiciona/remove classes CSS que animam a abertura/fechamento
    jobToggleBtn.classList.toggle("active", jobOpen);
    jobField.classList.toggle("open", jobOpen);

    if (jobOpen) {
      // Foca no textarea após a animação de abertura (300ms)
      setTimeout(() => jobTextarea.focus(), 300);
    } else {
      // Limpa o campo ao fechar para não enviar vaga antiga inadvertidamente
      jobTextarea.value = "";
    }
  });

  // ── Submit do formulário ─────────────────────────────────────────────────────

  form.addEventListener("submit", async (e) => {
    e.preventDefault(); // evita reload da página

    const username = inputUser.value.trim();
    const modo     = document.querySelector('input[name="modo"]:checked').value;
    const jobDesc  = jobOpen ? jobTextarea.value.trim() : null;

    // Validação básica — campo obrigatório
    if (!username) return showError("Digite um usuário ou cole uma URL do GitHub.");

    await run(username, modo, jobDesc);
  });

  /**
   * Orquestra a chamada à API e atualiza a UI com o resultado.
   *
   * @param {string} username       - Username ou URL do GitHub
   * @param {string} modo           - "recrutamento" | "autoanalise"
   * @param {string|null} jobDescription - Descrição da vaga ou null
   */
  async function run(username, modo, jobDescription) {
    const steps = jobDescription ? STEPS_VAGA : STEPS_BASE;

    // Prepara a UI para o estado de carregamento
    showLoader(steps);
    hideError();
    hideResult();
    btnRun.disabled = true; // evita duplo submit

    try {
      // Monta o body da requisição — jobDescription é opcional
      const body = { usernameOrUrl: username, contexto: modo };
      if (jobDescription) body.jobDescription = jobDescription;

      // Chama a API do backend
      const res = await fetch("/analisar-perfil", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });

      const data = await res.json();

      // Se o status HTTP não for 2xx, lança erro com a mensagem do backend
      if (!res.ok) throw new Error(data.detail || "Erro ao processar.");

      // Exibe o resultado (HTML da análise + score)
      showResult(data.analise, data.score);

    } catch (err) {
      showError(err.message);
    } finally {
      // Sempre esconde o loader e reabilita o botão, mesmo se der erro
      hideLoader();
      btnRun.disabled = false;
    }
  }

  // ── Funções de UI: Loader ────────────────────────────────────────────────────

  /**
   * Exibe o loader e inicia a rotação automática dos steps.
   * Cada step dura 4.5 segundos — calibrado para a duração média da análise.
   *
   * @param {Array} steps - Array de [label, sublabel] para cada step
   */
  function showLoader(steps) {
    loader.classList.add("visible");

    let i = 0;
    loaderLabel.textContent = steps[0][0];
    loaderSub.textContent   = steps[0][1];

    // Avança um step a cada 4.5 segundos, parando no último
    stepTimer = setInterval(() => {
      i = Math.min(i + 1, steps.length - 1);
      loaderLabel.textContent = steps[i][0];
      loaderSub.textContent   = steps[i][1];
    }, 4500);
  }

  /** Esconde o loader e cancela o timer de steps */
  function hideLoader() {
    loader.classList.remove("visible");
    clearInterval(stepTimer);
    stepTimer = null;
  }

  // ── Funções de UI: Erro ──────────────────────────────────────────────────────

  /** Exibe a faixa de erro com a mensagem recebida */
  function showError(msg) {
    errorMsg.textContent = msg;
    errorStrip.classList.add("visible");
  }

  /** Esconde a faixa de erro */
  function hideError() {
    errorStrip.classList.remove("visible");
  }

  // ── Funções de UI: Resultado ─────────────────────────────────────────────────

  /**
   * Exibe o painel de resultado com a análise HTML e o card de score.
   *
   * @param {string} html    - HTML da análise gerado pela IA
   * @param {object|null} score - Objeto com notas e nível do desenvolvedor
   */
  function showResult(html, score) {
    // Injeta o HTML da análise diretamente no DOM
    resultBody.innerHTML = html;
    resultPanel.classList.add("visible");

    if (score) {
      renderScore(score);
      scoreCard.style.display = "grid";
    } else {
      // Esconde o card de score se não vier na resposta
      scoreCard.style.display = "none";
    }

    // Scrola suavemente para o resultado após um pequeno delay
    // para garantir que o elemento já está visível no DOM
    setTimeout(
      () => resultPanel.scrollIntoView({ behavior: "smooth", block: "start" }),
      100,
    );
  }

  /** Limpa e esconde o painel de resultado */
  function hideResult() {
    resultPanel.classList.remove("visible");
    resultBody.innerHTML   = "";
    scoreCard.style.display = "none";
  }

  // ── Funções de UI: Score ─────────────────────────────────────────────────────

  /**
   * Renderiza o card de score com animações.
   * - Número principal conta de 0 até o valor final (easing ease-out)
   * - Barras deslizam da esquerda para a direita (com delay escalonado)
   * - Cores mudam baseadas no valor (verde ≥7, amarelo ≥5, vermelho <5)
   *
   * @param {object} score - { score, atividade, qualidade, documentacao, nivel, resumo }
   */
  function renderScore(score) {
    const { score: val, atividade, qualidade, documentacao, nivel, resumo } = score;

    // Define a classe de cor do número principal baseada na nota
    scoreNumber.classList.remove("high", "medium", "low");
    if (val >= 7)      scoreNumber.classList.add("high");
    else if (val >= 5) scoreNumber.classList.add("medium");
    else               scoreNumber.classList.add("low");

    // Anima o número contando de 0 até o valor final em 900ms
    animateNumber(scoreNumber, 0, val, 900);

    scoreLevel.textContent  = nivel  || "—";
    scoreResumo.textContent = resumo || "";

    // Anima as barras com delay escalonado para efeito visual cascata
    setTimeout(() => animateBar(barA, valA, atividade),    200);
    setTimeout(() => animateBar(barQ, valQ, qualidade),    400);
    setTimeout(() => animateBar(barD, valD, documentacao), 600);
  }

  /**
   * Anima um número de `from` até `to` em `duration` milissegundos.
   * Usa easing ease-out cúbico para desacelerar no final.
   *
   * @param {HTMLElement} el       - Elemento que exibe o número
   * @param {number}      from     - Valor inicial
   * @param {number}      to       - Valor final
   * @param {number}      duration - Duração em ms
   */
  function animateNumber(el, from, to, duration) {
    const start = performance.now();
    const range = to - from;

    function step(now) {
      const elapsed  = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased    = 1 - Math.pow(1 - progress, 3); // ease-out cubic

      el.textContent = (from + range * eased).toFixed(1);

      if (progress < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  }

  /**
   * Anima uma barra de progresso do score.
   * A largura da barra é proporcional ao valor (0-10 → 0%-100%).
   * A cor muda baseada no valor: verde ≥7, amarelo ≥5, vermelho <5.
   *
   * @param {HTMLElement} barEl - Elemento da barra (div que expande)
   * @param {HTMLElement} valEl - Elemento que exibe o valor numérico
   * @param {number}      value - Valor de 0 a 10
   */
  function animateBar(barEl, valEl, value) {
    const pct = Math.min(Math.max((value / 10) * 100, 0), 100);
    barEl.style.width = pct + "%";

    if (value >= 7)      barEl.style.background = "var(--green)";
    else if (value >= 5) barEl.style.background = "#d29922";
    else                 barEl.style.background = "var(--red)";

    valEl.textContent = value;
  }

});
