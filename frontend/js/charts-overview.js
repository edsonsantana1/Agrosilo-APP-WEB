// js/charts-overview.js
// ------------------------------------------------------
// Gráficos da tela de Dashboard (baseado Embrapa Soja)
// ------------------------------------------------------
//
// Gráficos gerados:
//
// 1) productEvolutionChart (topo)
//    -> Linha do NÍVEL DE RISCO (1=Ideal, 2=Moderado, 3=Crítico) ao longo do tempo
//       com faixas coloridas (Ideal/Moderado/Crítico)
//
// 2) overviewChart (topo)
//    -> Temperatura (°C), Umidade (%) e Nível de Risco em degraus
//
// 3) productEvolutionChartSecondary (baixo)
//    -> Barra com quantidade de leituras em cada nível de risco
//
// 4) overviewChartSecondary (baixo)
//    -> Barra com quantidade de alertas em cada nível de risco
//
// Fontes de dados:
//    - readings  (via findFirstSensorId() + fetchHistory())
//    - alerts    (via GET /api/alerts?limit=200&page=1)
//
// Lógica de risco (Embrapa Soja):
//    Umidade do grão:
//      Ideal    < 13%
//      Moderado 13–16%
//      Crítico  > 16%
//
//    Temperatura da massa:
//      Ideal    ~15 °C
//      Moderado 20–30 °C
//      Crítico  >= 40 °C
// ------------------------------------------------------

// Instâncias dos 4 gráficos
let productEvolutionChart         = null; // topo
let overviewChart                 = null; // topo
let productEvolutionChartSecondary = null; // baixo
let overviewChartSecondary         = null; // baixo

// Labels, cores e textos explicativos por nível de risco
const RISK_LABEL = {
  1: "Ideal",
  2: "Moderado",
  3: "Crítico",
};

const RISK_COLORS = {
  1: "#4CAF50", // Verde
  2: "#FFC107", // Amarelo
  3: "#F44336", // Vermelho
};

// Textos baseados no resumo da Embrapa (simplificados)
const RISK_INFO = {
  1: "Armazenamento seguro (<13% de umidade e T baixa). Crescimento fúngico lento.",
  2: "Crescimento fúngico médio/rápido (13–16% de umidade ou 20–30°C). Exige vigilância e aeração.",
  3: "Condição crítica (>16% de umidade ou T >= 40°C). Alto risco de deterioração; agir imediatamente.",
};

// ------------------------------------------------------------------
// 1. Classificação de risco (Embrapa)
// ------------------------------------------------------------------

/**
 * Classifica risco com base em temperatura (°C) e umidade (%)
 * Regra:
 *  - Crítico:   T >= 40°C ou U > 16%
 *  - Moderado:  20–30°C ou 13–16%
 *  - Ideal:     abaixo disso
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

  // Temperatura
  for (const p of tempPoints) {
    const d   = new Date(p.t);
    const key = d.getTime();
    const obj = byTs.get(key) || { ts: d, temp: null, hum: null };
    obj.temp  = typeof p.v === "number" ? p.v : parseFloat(p.v);
    byTs.set(key, obj);
  }

  // Umidade
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
//     Usado no gráfico de Evolução do Produto (topo)
// ------------------------------------------------------------------

const riskBandsPlugin = {
  id: "riskBands",
  beforeDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales?.y) return;

    const y = scales.y;
    const { left, right } = chartArea;

    ctx.save();

    // Faixa Ideal (1)
    const yIdealTop    = y.getPixelForValue(1.5);
    const yIdealBottom = y.getPixelForValue(0);
    ctx.fillStyle = "rgba(76, 175, 80, 0.05)";
    ctx.fillRect(left, yIdealTop, right - left, yIdealBottom - yIdealTop);

    // Faixa Moderada (2)
    const yModTop      = y.getPixelForValue(2.5);
    const yModBottom   = y.getPixelForValue(1.5);
    ctx.fillStyle = "rgba(255, 193, 7, 0.05)";
    ctx.fillRect(left, yModTop, right - left, yModBottom - yModTop);

    // Faixa Crítica (3)
    const yCritTop     = y.getPixelForValue(4);
    const yCritBottom  = y.getPixelForValue(2.5);
    ctx.fillStyle = "rgba(244, 67, 54, 0.05)";
    ctx.fillRect(left, yCritTop, right - left, yCritBottom - yCritTop);

    ctx.restore();
  },
};

// ------------------------------------------------------------------
// 5. GRÁFICOS TEMPORAIS (topo)
// ------------------------------------------------------------------

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
          borderColor: (ctx) => {
            const v = ctx.raw;
            return RISK_COLORS[v] || "#9c27b0";
          },
          backgroundColor: (ctx) => {
            const v = ctx.raw;
            const base = RISK_COLORS[v] || "#9c27b0";
            return base + "33"; // ~20% de opacidade
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
            label(item) {
              const v = item.raw;
              const label = RISK_LABEL[v] || "Nível " + v;
              return `${label} (nível ${v})`;
            },
            afterBody(items) {
              const v = items[0].raw;
              const info = RISK_INFO[v];
              return info ? `\n${info}` : "";
            },
          },
        },
      },
    },
  });
}

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
          label: "Nível de Risco (1=Ideal, 2=Moderado, 3=Crítico)",
          data: risks,
          yAxisID: "yRisk",
          borderColor: (ctx) => {
            const v = ctx.raw;
            return RISK_COLORS[v] || "#9c27b0";
          },
          backgroundColor: (ctx) => {
            const v = ctx.raw;
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
      interaction: {
        mode: "index",
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
            afterBody(items) {
              const index = items[0].dataIndex;
              const riskLevel = risks[index];
              const label = RISK_LABEL[riskLevel] || `Nível ${riskLevel}`;
              const info  = RISK_INFO[riskLevel] || "";
              return `\nRisco: ${label} (nível ${riskLevel})\n${info}`;
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

// 6.1 Resumo de leituras por nível de risco
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
              const lvl = item.dataIndex + 1;
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

// 6.2 Resumo de alertas por nível de risco
async function renderOverviewChartBottom() {
  const canvasId = "overviewChartSecondary";
  const canvas   = document.getElementById(canvasId);
  if (!canvas) return;

  let items = [];
  try {
    // Usa mesma rota dos alertas recentes, mas com limit maior
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
    // Backend normalmente guarda level / alert.level como 1,2,3
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
              const lvl  = item.dataIndex + 1;
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
