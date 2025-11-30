// js/charts-overview.js
// ------------------------------------------------------
// Gráficos de risco da tela de Dashboard (baseado Embrapa Soja)
// ------------------------------------------------------
//
// Gráficos gerados:
//
// 1) productEvolutionChart (topo)
//    -> Linha do NÍVEL DE RISCO (1=Ideal, 2=Moderado, 3=Crítico) ao longo do tempo,
//       com cor verde/amarelo/vermelho e faixas de fundo.
//
// 2) overviewChart (topo)
//    -> Temperatura (°C), Umidade (%) e Nível de Risco em degraus,
//       com tooltip explicando o risco e recomendação operacional.
//
// 3) productEvolutionChartSecondary (baixo)
//    -> Barras com quantidade de leituras em cada nível de risco.
//
// 4) overviewChartSecondary (baixo)
//    -> Barras com quantidade de alertas em cada nível de risco.
//
// Fontes de dados:
//    - Leituras: findFirstSensorId() + fetchHistory()
//    - Alertas:  GET /api/alerts?limit=200&page=1
//
// Regras de risco (simplificadas a partir da Embrapa Soja):
//    Umidade do grão:
//      Ideal    < 13%
//      Moderado 13–16%
//      Crítico  > 16%
//
//    Temperatura da massa:
//      Ideal    ~15 °C (baixo crescimento fúngico)
//      Moderado 20–30 °C
//      Crítico  >= 40 °C
// ------------------------------------------------------

// Instâncias dos 4 gráficos
let productEvolutionChart          = null; // topo - risco x tempo
let overviewChart                  = null; // topo - temp/umidade/risco
let productEvolutionChartSecondary = null; // baixo - leituras por nível
let overviewChartSecondary         = null; // baixo - alertas por nível

// ------------------------------
// Labels / cores por nível de risco
// ------------------------------
const RISK_LABEL = {
  1: "Ideal",
  2: "Moderado",
  3: "Crítico",
};

// Cores base (usadas na linha de risco e nas barras)
const RISK_COLORS = {
  1: "#4CAF50", // Verde
  2: "#FFC107", // Amarelo
  3: "#F44336", // Vermelho
};

// Texto geral (resumo curto)
const RISK_INFO = {
  1: "Faixa ideal: massa estável, baixa atividade microbiana.",
  2: "Faixa moderada: deterioração incipiente; demanda vigilância reforçada.",
  3: "Faixa crítica: deterioração acelerada e risco elevado de perdas.",
};

// Descrição detalhada para tooltip (ligada ao nível de risco)
const RISK_DESCRIPTION = {
  1: "Risco: Ideal (nível 1) – Armazenamento seguro; umidade < 13% e temperatura próxima de 15 °C, com crescimento fúngico lento.",
  2: "Risco: Moderado (nível 2) – Umidade entre 13–16% e/ou temperatura entre 20–30 °C, favorecendo crescimento fúngico médio a rápido.",
  3: "Risco: Crítico (nível 3) – Umidade > 16% e/ou temperatura ≥ 40 °C, associadas a crescimento fúngico máximo e forte risco de deterioração.",
};

// Recomendações operacionais para tooltip
const RISK_RECOMMENDATION = {
  1: "Recomendação: Manter rotina de monitoramento (CO₂, termometria, umidade) e aeração de manutenção para preservar a estabilidade da massa.",
  2: "Recomendação: Intensificar aeração nas vazões recomendadas, acompanhar cabos de termometria e inspecionar hotspots para evitar migração da umidade e avanço para nível crítico.",
  3: "Recomendação: Acionar plano de intervenção: secagem/redistribuição da massa, correção de pontos de condensação e manejo de pragas, pois as perdas qualitativas e quantitativas tendem a se acelerar.",
};

// ------------------------------
// Descrições por FAIXA de Temperatura e Umidade
// (usadas diretamente nas linhas do tooltip)
// ------------------------------

function describeTemperatureBand(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return "";

  if (v >= 40 && v <= 55) {
    return "Faixa crítica (40–55 °C): desenvolvimento fúngico máximo e alto risco de deterioração da massa.";
  }
  if (v >= 20 && v < 40) {
    return "Faixa moderada (20–30 °C): crescimento fúngico de intensidade média; exige acompanhamento contínuo da termometria e da aeração.";
  }
  if (v >= 10 && v < 20) {
    return "Faixa ideal (~15 °C): crescimento fúngico lento, favorecendo estabilidade do lote ao longo do tempo.";
  }
  if (v < 10) {
    return "Temperatura abaixo do intervalo típico de armazenagem; avaliar risco de condensação e gradientes térmicos na massa.";
  }
  // >55 °C (caso extremo)
  return "Temperatura muito elevada (>55 °C): situação anormal com forte risco de dano térmico aos grãos.";
}

function describeHumidityBand(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return "";

  if (v > 16) {
    return "Faixa crítica (>16%): crescimento fúngico explosivo, com alto risco de perdas qualitativas e quantitativas.";
  }
  if (v >= 13 && v <= 16) {
    return "Faixa moderada (13–16%): favorece crescimento fúngico rápido; requer vigilância constante, aeração intensiva e, se necessário, secagem complementar.";
  }
  if (v < 13 && v >= 10) {
    return "Faixa ideal (<13%): adequada para armazenamento prolongado, com baixa atividade microbiana.";
  }
  if (v < 10) {
    return "Umidade muito baixa (<10%): além de segura para fungos, reduz o desenvolvimento da maioria dos insetos-praga de grãos armazenados.";
  }
  return "";
}

// ------------------------------------------------------------------
// 1. Classificação de risco (temperatura + umidade)
// ------------------------------------------------------------------

/**
 * Classifica o nível de risco com base em temperatura (°C) e umidade (%).
 *
 * Regras (resumo Embrapa):
 *  - Crítico:   T >= 40°C OU U > 16%
 *  - Moderado:  20–30°C OU 13–16%
 *  - Ideal:     Demais combinações (T baixa e U < 13%)
 */
function classifyRiskLevel(temp, hum) {
  const t = typeof temp === "number" ? temp : null;
  const h = typeof hum === "number" ? hum : null;

  if ((t != null && t >= 40) || (h != null && h > 16)) return 3; // crítico
  if ((t != null && t >= 20 && t <= 30) || (h != null && h >= 13 && h <= 16)) return 2; // moderado
  return 1; // ideal
}

// ------------------------------------------------------------------
// 2. Série unificada (tempo, temperatura, umidade, risco)
// ------------------------------------------------------------------

/**
 * Monta uma série única com base nas leituras de temperatura e umidade.
 * Resultado: [{ ts, label, temp, hum, risk }, ...]
 */
async function buildOverviewSeries() {
  if (typeof findFirstSensorId !== "function" || typeof fetchHistory !== "function") {
    console.warn("[charts-overview] funções findFirstSensorId/fetchHistory não disponíveis");
    return [];
  }

  const tempId = findFirstSensorId("temperature");
  const humId  = findFirstSensorId("humidity");

  if (!tempId && !humId) {
    console.warn("[charts-overview] nenhum sensor de temperatura/umidade encontrado");
    return [];
  }

  const [tempData, humData] = await Promise.all([
    tempId ? fetchHistory(tempId) : Promise.resolve(null),
    humId  ? fetchHistory(humId)  : Promise.resolve(null),
  ]);

  const tempPoints = tempData?.points || [];
  const humPoints  = humData?.points || [];

  if (!tempPoints.length && !humPoints.length) return [];

  const byTs = new Map();

  // Mescla temperatura
  for (const p of tempPoints) {
    const d   = new Date(p.t);
    const key = d.getTime();
    const obj = byTs.get(key) || { ts: d, temp: null, hum: null };
    obj.temp  = typeof p.v === "number" ? p.v : parseFloat(p.v);
    byTs.set(key, obj);
  }

  // Mescla umidade
  for (const p of humPoints) {
    const d   = new Date(p.t);
    const key = d.getTime();
    const obj = byTs.get(key) || { ts: d, temp: null, hum: null };
    obj.hum  = typeof p.v === "number" ? p.v : parseFloat(p.v);
    byTs.set(key, obj);
  }

  const series = Array.from(byTs.values())
    .sort((a, b) => a.ts - b.ts)
    .map((point) => {
      const risk = classifyRiskLevel(point.temp, point.hum);
      return {
        ts: point.ts,
        label: point.ts.toLocaleString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
        temp: point.temp,
        hum: point.hum,
        risk,
      };
    });

  return series;
}

// ------------------------------------------------------------------
// 3. Helpers de "sem dados"
// ------------------------------------------------------------------

function showChartEmpty(canvasId, message) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const container = canvas.parentElement;
  if (!container) return;

  canvas.style.display = "none";

  let msg = container.querySelector(".chart-empty-message");
  if (!msg) {
    msg = document.createElement("p");
    msg.className = "chart-empty-message";
    msg.style.padding = "16px";
    msg.style.color = "#777";
    container.appendChild(msg);
  }
  msg.textContent = message || "Sem dados disponíveis para este período.";
}

function clearChartEmpty(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const container = canvas.parentElement;
  if (!container) return;

  canvas.style.display = "block";
  const msg = container.querySelector(".chart-empty-message");
  if (msg) msg.remove();
}

// ------------------------------------------------------------------
// 4. Plugin para faixas de risco (Ideal / Moderado / Crítico)
//    Usado no gráfico productEvolutionChart (nível de risco x tempo)
// ------------------------------------------------------------------

const riskBandsPlugin = {
  id: "riskBands",
  beforeDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales?.y) return;

    const y = scales.y;
    const { left, right } = chartArea;

    ctx.save();

    // Faixa Ideal (nível 1)
    const yIdealTop    = y.getPixelForValue(1.5);
    const yIdealBottom = y.getPixelForValue(0);
    ctx.fillStyle = "rgba(76, 175, 80, 0.05)";
    ctx.fillRect(left, yIdealTop, right - left, yIdealBottom - yIdealTop);

    // Faixa Moderada (nível 2)
    const yModTop    = y.getPixelForValue(2.5);
    const yModBottom = y.getPixelForValue(1.5);
    ctx.fillStyle = "rgba(255, 193, 7, 0.05)";
    ctx.fillRect(left, yModTop, right - left, yModBottom - yModTop);

    // Faixa Crítica (nível 3)
    const yCritTop    = y.getPixelForValue(4);
    const yCritBottom = y.getPixelForValue(2.5);
    ctx.fillStyle = "rgba(244, 67, 54, 0.05)";
    ctx.fillRect(left, yCritTop, right - left, yCritBottom - yCritTop);

    ctx.restore();
  },
};

// ------------------------------------------------------------------
// 5. GRÁFICOS TEMPORAIS (topo)
// ------------------------------------------------------------------

/**
 * productEvolutionChart (topo) - apenas NÍVEL DE RISCO x tempo
 * Linha em degraus, colorida por nível (verde/amarelo/vermelho).
 */
async function renderProductEvolutionChartTop() {
  const canvasId = "productEvolutionChart";
  const canvas   = document.getElementById(canvasId);
  if (!canvas) return;

  const series = await buildOverviewSeries();
  if (!series.length) {
    if (productEvolutionChart) {
      productEvolutionChart.destroy();
      productEvolutionChart = null;
    }
    showChartEmpty(canvasId, "Sem dados disponíveis para este período.");
    return;
  }

  clearChartEmpty(canvasId);

  const labels = series.map((p) => p.label);
  const risks  = series.map((p) => p.risk);

  const ctx = canvas.getContext("2d");
  if (productEvolutionChart) {
    productEvolutionChart.destroy();
  }

  productEvolutionChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Nível de Risco (1=Ideal, 2=Moderado, 3=Crítico)",
          data: risks,
          // Linha de risco colorida por nível
          borderColor: (ctx) => {
            const v = ctx.raw;
            return RISK_COLORS[v] || "#9c27b0";
          },
          backgroundColor: (ctx) => {
            const v = ctx.raw;
            const base = RISK_COLORS[v] || "#9c27b0";
            return base + "33"; // ~20% opacidade
          },
          borderWidth: 2,
          stepped: true,
          pointRadius: 2,
          fill: true,
        },
      ],
    },
    plugins: [riskBandsPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          min: 0,
          max: 4,
          ticks: {
            stepSize: 1,
            callback(value) {
              if (value === 1) return "Ideal";
              if (value === 2) return "Moderado";
              if (value === 3) return "Crítico";
              return "";
            },
          },
          title: { display: true, text: "Risco de Deterioração" },
        },
      },
      plugins: {
        legend: { display: true },
        tooltip: {
          callbacks: {
            // Linha principal do tooltip
            label(item) {
              const v     = item.raw;
              const label = RISK_LABEL[v] || `Nível ${v}`;
              return `${label} (nível ${v})`;
            },
            // Corpo adicional: explicação + recomendação
            afterBody(items) {
              const v    = items[0].raw;
              const desc = RISK_DESCRIPTION[v];
              const rec  = RISK_RECOMMENDATION[v];
              const out  = [];
              if (desc) out.push(desc);
              if (rec)  out.push(rec);
              return out;
            },
          },
        },
      },
    },
  });
}

/**
 * overviewChart (topo) - Temperatura, Umidade e Nível de Risco
 * Tooltip segue o modelo:
 *
 * Data/hora: (Chart já mostra no título)
 * Temperatura (°C): X — [texto técnico da faixa]
 * Umidade (%): Y — [texto técnico da faixa]
 * Nível de Risco: Z — [descrição + recomendação]
 */
async function renderOverviewChartTop() {
  const canvasId = "overviewChart";
  const canvas   = document.getElementById(canvasId);
  if (!canvas) return;

  const series = await buildOverviewSeries();
  if (!series.length) {
    if (overviewChart) {
      overviewChart.destroy();
      overviewChart = null;
    }
    showChartEmpty(canvasId, "Sem dados disponíveis para este período.");
    return;
  }

  clearChartEmpty(canvasId);

  const labels = series.map((p) => p.label);
  const temps  = series.map((p) => p.temp);
  const hums   = series.map((p) => p.hum);
  const risks  = series.map((p) => p.risk);

  const ctx = canvas.getContext("2d");
  if (overviewChart) {
    overviewChart.destroy();
  }

  overviewChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Temperatura (°C)",
          data: temps,
          yAxisID: "yTemp",
          borderColor: "#ff6384",
          backgroundColor: "#ff638420",
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 0,
        },
        {
          label: "Umidade (%)",
          data: hums,
          yAxisID: "yHumi",
          borderColor: "#36a2eb",
          backgroundColor: "#36a2eb20",
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 0,
        },
        {
          // Linha de NÍVEL DE RISCO — colorida por nível
          label: "Nível de Risco (1=Ideal, 2=Moderado, 3=Crítico)",
          data: risks,
          yAxisID: "yRisk",
          borderColor: (ctx) => {
            const v = ctx.raw;
            return RISK_COLORS[v] || "#9c27b0";
          },
          backgroundColor: (ctx) => {
            const v    = ctx.raw;
            const base = RISK_COLORS[v] || "#9c27b0";
            return base + "33";
          },
          borderWidth: 2,
          stepped: true,
          pointRadius: 2,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,

      // Tooltip focado na linha mais próxima
      interaction: {
        mode: "nearest",
        intersect: false,
      },

      scales: {
        yTemp: {
          type: "linear",
          position: "left",
          title: { display: true, text: "Temperatura (°C)" },
        },
        yHumi: {
          type: "linear",
          position: "right",
          title: { display: true, text: "Umidade (%)" },
          grid: { drawOnChartArea: false },
          min: 0,
          max: 100,
        },
        // Eixo interno para o nível de risco (0–4), oculto
        yRisk: {
          type: "linear",
          position: "right",
          display: false,
          min: 0,
          max: 4,
        },
      },
      plugins: {
        legend: { display: true },
        tooltip: {
          callbacks: {
            // Título: data/hora formatada (já vem de labels)
            title(items) {
              return items[0].label;
            },

            // Cada linha do tooltip traz o seu próprio texto técnico
            label(item) {
              const datasetIndex = item.datasetIndex;
              const rawValue     = item.raw;
              const value        = item.formattedValue;

              // Temperatura
              if (datasetIndex === 0) {
                const desc = describeTemperatureBand(rawValue);
                return [
                  `Temperatura (°C): ${value}`,
                  desc,
                ];
              }

              // Umidade
              if (datasetIndex === 1) {
                const desc = describeHumidityBand(rawValue);
                return [
                  `Umidade (%): ${value}`,
                  desc,
                ];
              }

              // Nível de risco
              if (datasetIndex === 2) {
                const lvl  = Number(rawValue);
                const rot  = RISK_LABEL[lvl] || `Nível ${lvl}`;
                const desc = RISK_DESCRIPTION[lvl] || "";
                const rec  = RISK_RECOMMENDATION[lvl] || "";
                const lines = [
                  `Nível de Risco: ${lvl} (${rot})`,
                ];
                if (desc) lines.push(desc);
                if (rec)  lines.push(rec);
                return lines;
              }

              // Fallback genérico
              const datasetLabel = item.dataset.label || "";
              return `${datasetLabel}: ${value}`;
            },

            // afterBody agora só reforça o nível de risco do ponto
            // (usando o array risks baseado no índice)
            afterBody(items) {
              if (!items.length) return;

              const index     = items[0].dataIndex;
              const riskLevel = risks[index];

              const desc = RISK_DESCRIPTION[riskLevel];
              const rec  = RISK_RECOMMENDATION[riskLevel];

              const lines = [];

              lines.push(
                `Nível de Risco (1 = Ideal, 2 = Moderado, 3 = Crítico): ${riskLevel}`
              );

              if (desc) lines.push(desc);
              if (rec)  lines.push(rec);

              return lines;
            },
          },
        },
      },
    },
  });
}

// ------------------------------------------------------------------
// 6. GRÁFICOS DE RESUMO (baixo)
// ------------------------------------------------------------------

/**
 * productEvolutionChartSecondary - quantidade de LEITURAS em cada nível de risco
 */
async function renderProductEvolutionChartBottom() {
  const canvasId = "productEvolutionChartSecondary";
  const canvas   = document.getElementById(canvasId);
  if (!canvas) return;

  const series = await buildOverviewSeries();
  if (!series.length) {
    if (productEvolutionChartSecondary) {
      productEvolutionChartSecondary.destroy();
      productEvolutionChartSecondary = null;
    }
    showChartEmpty(canvasId, "Sem dados disponíveis para este período.");
    return;
  }

  clearChartEmpty(canvasId);

  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const p of series) {
    counts[p.risk] = (counts[p.risk] || 0) + 1;
  }

  const labels = [1, 2, 3].map((lvl) => RISK_LABEL[lvl]);
  const values = [1, 2, 3].map((lvl) => counts[lvl]);

  const ctx = canvas.getContext("2d");
  if (productEvolutionChartSecondary) {
    productEvolutionChartSecondary.destroy();
  }

  productEvolutionChartSecondary = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Quantidade de leituras por nível de risco",
          data: values,
          backgroundColor: [1, 2, 3].map((lvl) => RISK_COLORS[lvl]),
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: "Número de leituras" },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(item) {
              const lvl   = item.dataIndex + 1;
              const label = RISK_LABEL[lvl];
              const info  = RISK_INFO[lvl];
              return [
                `${label}: ${item.raw} leituras`,
                info,
              ];
            },
          },
        },
      },
    },
  });
}

/**
 * overviewChartSecondary - quantidade de ALERTAS em cada nível de risco
 */
async function renderOverviewChartBottom() {
  const canvasId = "overviewChartSecondary";
  const canvas   = document.getElementById(canvasId);
  if (!canvas) return;

  let items = [];
  try {
    // Usa a mesma rota dos alertas recentes, porém com limite maior
    const res = await authManager.makeRequest("/alerts?limit=200&page=1");
    items = res.items || res.alerts || [];
  } catch (e) {
    console.warn("[charts-overview] erro ao buscar alertas para resumo:", e);
  }

  if (!items.length) {
    if (overviewChartSecondary) {
      overviewChartSecondary.destroy();
      overviewChartSecondary = null;
    }
    showChartEmpty(canvasId, "Nenhum alerta registrado para o período.");
    return;
  }

  clearChartEmpty(canvasId);

  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const a of items) {
    // Backend normalmente envia level 1,2,3
    const lvl = a.level || a.alert?.level;
    if (lvl === 1 || lvl === 2 || lvl === 3) {
      counts[lvl] = (counts[lvl] || 0) + 1;
    }
  }

  const labels = [1, 2, 3].map((lvl) => RISK_LABEL[lvl]);
  const values = [1, 2, 3].map((lvl) => counts[lvl]);

  const ctx = canvas.getContext("2d");
  if (overviewChartSecondary) {
    overviewChartSecondary.destroy();
  }

  overviewChartSecondary = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Alertas por nível de risco",
          data: values,
          backgroundColor: [1, 2, 3].map((lvl) => RISK_COLORS[lvl]),
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: "Número de alertas" },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(item) {
              const lvl   = item.dataIndex + 1;
              const label = RISK_LABEL[lvl];
              const info  = RISK_INFO[lvl];
              return [
                `${label}: ${item.raw} alertas`,
                info,
              ];
            },
          },
        },
      },
    },
  });
}

// ------------------------------------------------------------------
// 7. Funções chamadas pelo dashboard.js
// ------------------------------------------------------------------

async function initializeOverviewCharts() {
  try {
    // Topo (séries temporais)
    await renderProductEvolutionChartTop();
    await renderOverviewChartTop();

    // Base (resumos)
    await renderProductEvolutionChartBottom();
    await renderOverviewChartBottom();
  } catch (error) {
    console.error("[charts-overview] erro ao inicializar gráficos:", error);
  }
}

async function updateOverviewCharts() {
  try {
    await renderProductEvolutionChartTop();
    await renderOverviewChartTop();

    await renderProductEvolutionChartBottom();
    await renderOverviewChartBottom();
  } catch (error) {
    console.error("[charts-overview] erro ao atualizar gráficos:", error);
  }
}
