// ------------------------------------------------------------------
// Dashboard principal do Agrosilo
// - Status cards (temperatura, umidade, silos, alertas)
// - Gráficos rápidos (temp/umidade 24h)
// - Overview Charts (Temperatura, Umidade e Risco) via charts-overview.js
// - NÃO cuida de modal / cadastro de silos nem de listagem de alertas
// ------------------------------------------------------------------
//
// Rotas usadas aqui:
//  - GET /silos
//  - GET /sensors/silo/:siloId/summary
//  - GET /sensors/:sensorId/history?limit=N
//  - GET /alerts/active                -> alertas ATIVOS (badge/menu)
//  - GET /alerts?limit=500&page=1      -> alertas (HISTÓRICO) p/ últimas 24h
// ------------------------------------------------------------------

let temperatureChart = null;
let humidityChart    = null;
let refreshInterval  = null;

// Dados de base vindos da API
let silosData       = [];   // para contagem de silos/sensores e históricos
let alertsData      = [];   // alertas ATIVOS (para badge de menu)
let latestSummaries = {};   // { [siloId]: { sensors: [...] } }

// Estatística de alertas das últimas 24h (para o CARD)
let alertsLast24hStats = {
  total:    0,
  moderate: 0,
  critical: 0,
};

document.addEventListener('DOMContentLoaded', () => {
  if (!requireAuth()) return;
  initializeDashboard();
});

async function initializeDashboard() {
  try {
    setupUserInterface();
    await loadDashboardData();          // silos + summaries + alertas (ativos + 24h)
    await buildOrUpdateCharts();        // gráficos de temperatura/umidade 24h
    await initializeOverviewCharts();   // gráficos Overview (charts-overview.js)
    setupAutoRefresh();                 // loop de atualização automática
    showNotification('success', 'Dashboard carregado com sucesso!');
  } catch (error) {
    console.error('Erro ao inicializar dashboard:', error);
    showNotification('error', 'Erro ao carregar dashboard');
  }
}

// --------------------- UI / Usuário ---------------------

function setupUserInterface() {
  const user = getCurrentUser() || {};
  setText('userName', user.name || 'Usuário');
  setText('userRole', user.role === 'admin' ? 'Administrador' : 'Usuário');

  // Exibe menu de usuários somente para admin
  if (typeof isAdmin === 'function' && isAdmin()) {
    const item = document.getElementById('usersMenuItem');
    if (item) item.style.display = 'flex';
  }

  updateLastUpdateTime();
}

// ---------------- Helpers "Últimas 24h" -----------------

function last24hWindow() {
  const now = Date.now();
  return {
    from: now - 24 * 60 * 60 * 1000,
    to:   now,
  };
}

function pickLatestInWindow(points, from, to) {
  if (!Array.isArray(points)) return null;
  const inWin = points.filter(p => {
    const t = new Date(p.t).getTime();
    return Number.isFinite(t) && t >= from && t <= to;
  });
  if (!inWin.length) return null;
  return inWin.reduce((a, b) => (new Date(a.t) > new Date(b.t) ? a : b));
}

// Busca o último valor (janela 24h) para um tipo de sensor
async function getLastValueFromHistory(sensorType) {
  const sensorId = findFirstSensorId(sensorType);
  if (!sensorId) return null;

  const history = await fetchHistory(sensorId);
  const { from, to } = last24hWindow();
  const latest = pickLatestInWindow(history?.points || [], from, to);
  if (!latest) return null;

  const v = typeof latest.v === 'number' ? latest.v : parseFloat(latest.v);
  return Number.isFinite(v) ? v : null;
}

// --------------------- Carregamento Geral ---------------

async function loadDashboardData() {
  // 1) Silos + summaries (necessário para contagem e gráficos)
  await loadSilosAndSummaries();

  // 2) Alertas ativos (para badge do menu)
  await loadActiveAlerts();

  // 3) Estatística de alertas das últimas 24h (card)
  await loadAlertsLast24hStats();

  // 4) Atualizar cards de status (usa histórico 24h + stats de alertas)
  await updateStatusCardsFromHistory();
}

// Carrega silos + summaries para stats e gráficos
async function loadSilosAndSummaries() {
  try {
    const res = await authManager.makeRequest('/silos');
    silosData = Array.isArray(res) ? res : (res?.silos || []);
    if (!Array.isArray(silosData)) silosData = [];

    latestSummaries = {};
    for (const silo of silosData) {
      try {
        const summary = await authManager.makeRequest(
          `/sensors/silo/${silo._id}/summary`
        );
        latestSummaries[silo._id] = summary || { sensors: [] };
      } catch (e) {
        console.warn('[dashboard] summary falhou p/ silo', silo._id, e);
        latestSummaries[silo._id] = { sensors: [] };
      }
    }
  } catch (error) {
    console.error('Erro ao carregar silos/summaries:', error);
    silosData = [];
    latestSummaries = {};
  }
}

/**
 * Busca alertas ATIVOS (último estado por sensor) para o badge do menu.
 */
async function loadActiveAlerts() {
  try {
    const response = await authManager.makeRequest('/alerts/active');
    alertsData = Array.isArray(response) ? response : (response?.alerts || []);
  } catch (error) {
    console.warn('Erro ao carregar alertas ativos:', error);
    alertsData = [];
  }
}

/**
 * Calcula estatística de alertas nas ÚLTIMAS 24h
 * usando o histórico: /alerts?limit=500&page=1
 */
async function loadAlertsLast24hStats() {
  try {
    const res = await authManager.makeRequest('/alerts/stats?timeWindow=24h');
    const stats = res?.stats || {};

    alertsLast24hStats = {
      total:    Number(stats.total)    || 0,
      critical: Number(stats.critical) || 0,
      moderate: Number(stats.moderate) || 0,
    };
  } catch (error) {
    console.warn('Erro ao carregar estatísticas de alertas 24h:', error);
    alertsLast24hStats = { total: 0, moderate: 0, critical: 0 };
  }
}


/**
 * Atualiza cards (Temperatura / Umidade via histórico 24h
 * + contadores de silos/sensores
 * + estatística de alertas das últimas 24h).
 */
async function updateStatusCardsFromHistory() {
  const statsBase = calculateDashboardStats();

  const [tempLast, humLast] = await Promise.all([
    getLastValueFromHistory('temperature'),
    getLastValueFromHistory('humidity'),
  ]);

  setText(
    'avgTemperature',
    tempLast != null ? `${tempLast.toFixed(1)}°C` : '--°C'
  );
  setText('avgHumidity', humLast != null ? `${humLast.toFixed(1)}%` : '--%');
  setText('activeSilos', statsBase.activeSilos);
  setText('totalSensors', `${statsBase.totalSensors} sensores`);

  // 🔥 Card de alertas: TOTAL nas últimas 24h
setText('activeAlerts', alertsLast24hStats.total);

const breakdownEl = document.getElementById('alertsBreakdown');
if (breakdownEl) {
  breakdownEl.textContent =
    `Críticos: ${alertsLast24hStats.critical} · ` +
    `Moderados: ${alertsLast24hStats.moderate}`;
}


  // Badge do menu continua mostrando qtd. de alertas ATIVOS
  const badge = document.getElementById('alertCount');
  if (badge) {
    badge.textContent = statsBase.activeAlerts;
    badge.style.display = statsBase.activeAlerts > 0 ? 'inline-block' : 'none';
  }
}

/** Contadores gerais (silos, sensores, alertas ATIVOS) */
function calculateDashboardStats() {
  let totalSensors = 0;
  for (const silo of silosData) {
    const sensors = latestSummaries[silo._id]?.sensors || [];
    totalSensors += sensors.length;
  }
  return {
    avgTemperature: null,
    avgHumidity: null,
    activeSilos: silosData.length,
    totalSensors,
    activeAlerts: alertsData.length || 0, // ATIVOS (badge)
  };
}

// --------------------- Gráficos Temp/Umidade ------------- 

async function buildOrUpdateCharts() {
  const tempId = findFirstSensorId('temperature');
  const humId  = findFirstSensorId('humidity');

  const tempData = tempId ? await fetchHistory(tempId) : null;
  const humData  = humId  ? await fetchHistory(humId)  : null;

  const labels = (tempData?.points?.length ? tempData.points : humData?.points || [])
    .map(p =>
      new Date(p.t).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
      })
    );

  const tempValues = tempData?.points?.map(p => p.v) || [];
  const humValues  = humData?.points?.map(p => p.v)  || [];

  renderOrUpdateLineChart(
    'temperatureChart',
    'Temperatura (°C)',
    labels,
    tempValues,
    'temperature'
  );
  renderOrUpdateLineChart(
    'humidityChart',
    'Umidade (%)',
    labels,
    humValues,
    'humidity'
  );
}

// Localiza o primeiro sensor de um tipo, a partir dos summaries
function findFirstSensorId(type) {
  for (const silo of silosData) {
    const sensors = latestSummaries[silo._id]?.sensors || [];
    const found = sensors.find(s => s.type === type);
    if (found) return found._id;
  }
  return null;
}

async function fetchHistory(sensorId) {
  try {
    return await authManager.makeRequest(
      `/sensors/${sensorId}/history?limit=500`
    );
  } catch (e) {
    console.error('Erro ao buscar histórico:', e);
    return null;
  }
}

function renderOrUpdateLineChart(canvasId, label, labels, values, colorKey) {
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;

  const palette =
    (window.CHART_CONFIG && CHART_CONFIG.colors) || {
      temperature: '#ff6384',
      humidity: '#36a2eb',
    };
  const color = palette[colorKey];

  const dataset = {
    label,
    data: values,
    borderColor: color,
    backgroundColor: color + '20',
    tension: 0.3,
    fill: true,
    pointRadius: 0,
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false } },
      y: { beginAtZero: false },
    },
    animation: false,
  };

  if (canvasId === 'temperatureChart') {
    if (!temperatureChart) {
      temperatureChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets: [dataset] },
        options,
      });
    } else {
      temperatureChart.data.labels = labels;
      temperatureChart.data.datasets[0].data = values;
      temperatureChart.update('none');
    }
  } else {
    if (!humidityChart) {
      humidityChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets: [dataset] },
        options,
      });
    } else {
      humidityChart.data.labels = labels;
      humidityChart.data.datasets[0].data = values;
      humidityChart.update('none');
    }
  }
}

// Permite atualizar manualmente um dos gráficos via botão
function refreshChart(type) {
  buildOrUpdateCharts().then(() => {
    showNotification(
      'info',
      `Gráfico de ${
        type === 'temperature' ? 'temperatura' : 'umidade'
      } atualizado`
    );
  });
}

// --------------------- Auto-Refresh ----------------------

function setupAutoRefresh() {
  const interval =
    (window.CHART_CONFIG && CHART_CONFIG.refreshInterval) || 15000;

  refreshInterval = setInterval(async () => {
    try {
      // opcional: sincroniza ThingSpeak -> Mongo se a rota existir
      try {
        await authManager.makeRequest('/thingspeak/sync-all', {
          method: 'POST',
        });
      } catch (_) {
        // rota pode não existir em dev -> ignoramos
      }

      await loadDashboardData();
      await buildOrUpdateCharts();
      await updateOverviewCharts(); // Atualiza Overview Charts (charts-overview.js)
      updateLastUpdateTime();
    } catch (error) {
      console.error('Erro na atualização automática:', error);
    }
  }, interval);
}

function updateLastUpdateTime() {
  const now = new Date();
  setText(
    'lastUpdate',
    now.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  );
}

// --------------------- Notificações ----------------------

function showNotification(type, message) {
  const container = document.getElementById('notificationContainer');
  if (!container) return;

  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;">
      <i class="${getNotificationIcon(type)}"></i>
      <span>${message}</span>
    </div>`;

  container.appendChild(el);

  const duration =
    (window.NOTIFICATION_CONFIG && NOTIFICATION_CONFIG.duration) || 3000;
  setTimeout(() => el.remove(), duration);
}

function getNotificationIcon(type) {
  return (
    {
      success: 'fas fa-check-circle',
      error: 'fas fa-exclamation-circle',
      warning: 'fas fa-exclamation-triangle',
      info: 'fas fa-info-circle',
    }[type] || 'fas fa-info-circle'
  );
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// Limpa interval ao sair da página
window.addEventListener('beforeunload', () => {
  if (refreshInterval) clearInterval(refreshInterval);
});
