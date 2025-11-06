// js/dashboard.js (ATUALIZADO)
// ------------------------------------------------------------------
// Rotas usadas agora:
//  - GET /api/silos
//  - GET /api/sensors/silo/:siloId/summary
//  - GET /api/sensors/:sensorId/history?limit=N
//  - GET /api/alerts/active               -> alertas ATIVOS (dashboard)
//  - GET /api/alerts?limit=5&page=1       -> últimos 5 do HISTÓRICO (recentes)
// ------------------------------------------------------------------

let temperatureChart = null;
let humidityChart    = null;
let refreshInterval  = null;

let silosData        = [];
let alertsData       = []; // ATIVOS (para o card e badge)
let latestSummaries  = {}; // { [siloId]: { sensors: [...] } }

document.addEventListener('DOMContentLoaded', () => {
  if (!requireAuth()) return;
  initializeDashboard();
});

async function initializeDashboard() {
  try {
    setupUserInterface();
    await loadDashboardData();
    await buildOrUpdateCharts();
    setupAutoRefresh();
    setupEventHandlers();
    showNotification('success', 'Dashboard carregado com sucesso!');
  } catch (error) {
    console.error('Erro ao inicializar dashboard:', error);
    showNotification('error', 'Erro ao carregar dashboard');
  }
}

function setupUserInterface() {
  const user = getCurrentUser() || {};
  setText('userName', user.name || 'Usuário');
  setText('userRole', user.role === 'admin' ? 'Administrador' : 'Usuário');
  if (typeof isAdmin === 'function' && isAdmin()) {
    const item = document.getElementById('usersMenuItem');
    if (item) item.style.display = 'flex';
  }
  updateLastUpdateTime();
}

// ---------------- Helpers "Últimas 24h" p/ cards -------------------

function last24hWindow() {
  const now = Date.now();
  return { from: now - 24 * 60 * 60 * 1000, to: now };
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

// --------------------- Carregamento Geral --------------------------

async function loadDashboardData() {
  await loadSilosAndSummaries();
  await loadActiveAlerts();          // <- agora busca /alerts/active
  await updateStatusCardsFromHistory();
  updateSilosOverview();
  await updateRecentAlerts();        // <- agora busca do histórico /alerts?limit=5
}

async function loadSilosAndSummaries() {
  try {
    const res = await authManager.makeRequest('/silos');
    silosData = Array.isArray(res) ? res : (res?.silos || []);
    if (!Array.isArray(silosData)) silosData = [];

    latestSummaries = {};
    for (const silo of silosData) {
      try {
        const summary = await authManager.makeRequest(`/sensors/silo/${silo._id}/summary`);
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

/** Busca alertas ATIVOS (último estado por sensor) para o card e badge */
async function loadActiveAlerts() {
  try {
    const response = await authManager.makeRequest('/alerts/active');
    alertsData = Array.isArray(response) ? response : (response?.alerts || []);
  } catch (error) {
    console.warn('Erro ao carregar alertas ativos:', error);
    alertsData = [];
  }
}

/** Atualiza cards (Temp/Umidade via histórico 24h + contadores) */
async function updateStatusCardsFromHistory() {
  const statsBase = calculateDashboardStats();

  const [tempLast, humLast] = await Promise.all([
    getLastValueFromHistory('temperature'),
    getLastValueFromHistory('humidity')
  ]);

  setText('avgTemperature', tempLast != null ? `${tempLast.toFixed(1)}°C` : '--°C');
  setText('avgHumidity',    humLast  != null ? `${humLast.toFixed(1)}%`  : '--%');
  setText('activeSilos',    statsBase.activeSilos);
  setText('totalSensors',   `${statsBase.totalSensors} sensores`);
  setText('activeAlerts',   statsBase.activeAlerts);

  const badge = document.getElementById('alertCount');
  if (badge) {
    badge.textContent = statsBase.activeAlerts;
    badge.style.display = statsBase.activeAlerts > 0 ? 'inline-block' : 'none';
  }
}

/** Contadores gerais (silos/sensores/alertas ativos) */
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
    activeAlerts: alertsData.length || 0 // ATIVOS (via /alerts/active)
  };
}

// --------------------- Visão geral por silo ------------------------

function updateSilosOverview() {
  const grid = document.getElementById('silosGrid');
  if (!grid) return;

  if (silosData.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-warehouse"></i>
        <h3>Nenhum silo cadastrado</h3>
        <p>Adicione seu primeiro silo para começar o monitoramento</p>
      </div>`;
    return;
  }

  grid.innerHTML = '';
  for (const silo of silosData) {
    const sensors = latestSummaries[silo._id]?.sensors || [];

    const readings = sensors.length
      ? sensors.map(s => {
          const unit  = getUnit(s.type);
          const icon  = getIcon(s.type);
          const value = (s.lastValue != null && s.lastValue !== '') ? Number(s.lastValue).toFixed(1) : '--';
          const level = (window.Utils?.getAlertLevel) ? Utils.getAlertLevel(s.type, s.lastValue) : 'normal';
          return `
            <div class="sensor-reading">
              <div class="sensor-info">
                <div class="sensor-icon ${s.type}"><i class="${icon}"></i></div>
                <span class="sensor-name">${getDisplayName(s.type)}</span>
              </div>
              <div class="sensor-value">
                <span class="value-number">${value}${unit}</span>
                <div class="value-status ${level}"></div>
              </div>
            </div>`;
        }).join('')
      : '<div class="empty-state"><p>Nenhum sensor com leituras</p></div>';

    const card = document.createElement('div');
    card.className = 'silo-card';
    card.innerHTML = `
      <div class="silo-header">
        <div class="silo-title">
          <h4>${silo.name || 'Silo'}</h4>
          <span class="silo-status ${sensors.length ? 'online' : 'offline'}">
            ${sensors.length ? 'Online' : 'Offline'}
          </span>
        </div>
        <div class="silo-location">
          <i class="fas fa-map-marker-alt"></i> ${silo.location || 'Localização não informada'}
        </div>
      </div>
      <div class="silo-sensors">${readings}</div>`;
    grid.appendChild(card);
  }
}

function getDisplayName(type) {
  return ({ temperature:'Temperatura', humidity:'Umidade', pressure:'Pressão', co2:'CO2' }[type]) || type;
}
function getUnit(type)   { return type === 'temperature' ? '°C' : type === 'humidity' ? '%' : type === 'pressure' ? 'hPa' : type === 'co2' ? 'ppm' : ''; }
function getIcon(type)   {
  return type === 'temperature' ? 'fas fa-thermometer-half'
       : type === 'humidity'    ? 'fas fa-tint'
       : type === 'pressure'    ? 'fas fa-gauge-high'
       : type === 'co2'         ? 'fas fa-smog'
       : 'fas fa-sensor';
}

// --------------------- Alertas Recentes (HISTÓRICO) ----------------

/**
 * Busca os 5 últimos alertas do HISTÓRICO persistido (ordenado por timestamp desc)
 * e renderiza no bloco "Alertas Recentes".
 */
async function updateRecentAlerts() {
  const list = document.getElementById('recentAlertsList');
  if (!list) return;

  try {
    const res = await authManager.makeRequest('/alerts?limit=5&page=1');
    const items = res.items || res.alerts || [];

    if (!items.length) {
      list.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-check-circle"></i>
          <h3>Nenhum alerta ativo</h3>
          <p>Todos os sistemas estão funcionando normalmente</p>
        </div>`;
      return;
    }

    list.innerHTML = items.map(a => {
      const level   = a.level || a.alert?.level || 'info';
      const message = a.message || a.alert?.message || '';
      const silo    = a.siloName || a.silo || 'Silo';
      const sensor  = a.sensorType || a.sensor || 'sensor';
      const when    = a.timestamp
        ? new Date(a.timestamp).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' })
        : '--';

      return `
        <div class="alert-item">
          <div class="alert-icon ${level}"><i class="fas fa-exclamation-triangle"></i></div>
          <div class="alert-content">
            <h4 class="alert-title">${silo} - ${getDisplayName(sensor)}</h4>
            <p class="alert-description">${message}</p>
          </div>
          <div class="alert-time">${when}</div>
        </div>`;
    }).join('');
  } catch (e) {
    console.error('[dashboard] recent alerts:', e);
    list.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-exclamation-triangle"></i>
        <h3>Não foi possível carregar os alertas</h3>
        <p>Tente novamente em instantes.</p>
      </div>`;
  }
}

// --------------------- Gráficos ------------------------

async function buildOrUpdateCharts() {
  const tempId = findFirstSensorId('temperature');
  const humId  = findFirstSensorId('humidity');

  const tempData = tempId ? await fetchHistory(tempId) : null;
  const humData  = humId  ? await fetchHistory(humId)  : null;

  const labels = (tempData?.points?.length ? tempData.points : humData?.points || [])
    .map(p => new Date(p.t).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' }));

  const tempValues = tempData?.points?.map(p => p.v) || [];
  const humValues  = humData?.points?.map(p => p.v)  || [];

  renderOrUpdateLineChart('temperatureChart', 'Temperatura (°C)', labels, tempValues, 'temperature');
  renderOrUpdateLineChart('humidityChart',    'Umidade (%)',      labels, humValues,  'humidity');
}

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
    return await authManager.makeRequest(`/sensors/${sensorId}/history?limit=500`);
  } catch (e) {
    console.error('Erro ao buscar histórico:', e);
    return null;
  }
}

function renderOrUpdateLineChart(canvasId, label, labels, values, colorKey) {
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;

  const palette = (window.CHART_CONFIG && CHART_CONFIG.colors) || {
    temperature: '#ff6384',
    humidity:    '#36a2eb'
  };
  const color = palette[colorKey];

  const dataset = {
    label,
    data: values,
    borderColor: color,
    backgroundColor: color + '20',
    tension: 0.3,
    fill: true,
    pointRadius: 0
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { x: { grid: { display: false } }, y: { beginAtZero: false } },
    animation: false
  };

  if (canvasId === 'temperatureChart') {
    if (!temperatureChart) {
      temperatureChart = new Chart(ctx, { type: 'line', data: { labels, datasets: [dataset] }, options });
    } else {
      temperatureChart.data.labels = labels;
      temperatureChart.data.datasets[0].data = values;
      temperatureChart.update('none');
    }
  } else {
    if (!humidityChart) {
      humidityChart = new Chart(ctx, { type: 'line', data: { labels, datasets: [dataset] }, options });
    } else {
      humidityChart.data.labels = labels;
      humidityChart.data.datasets[0].data = values;
      humidityChart.update('none');
    }
  }
}

// --------------------- Auto-Refresh --------------------

function setupAutoRefresh() {
  const interval = (window.CHART_CONFIG && CHART_CONFIG.refreshInterval) || 15000;

  refreshInterval = setInterval(async () => {
    try {
      // opcional: sincroniza ThingSpeak -> Mongo se existir a rota
      try {
        await authManager.makeRequest('/thingspeak/sync-all', { method: 'POST' });
      } catch (_) {}

      await loadDashboardData();
      await buildOrUpdateCharts();
      updateLastUpdateTime();
    } catch (error) {
      console.error('Erro na atualização automática:', error);
    }
  }, interval);
}

function updateLastUpdateTime() {
  const now = new Date();
  setText('lastUpdate', now.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' }));
}

// --------------------- Eventos / UI --------------------

function setupEventHandlers() {
  const form = document.getElementById('addSiloForm');
  if (form) form.addEventListener('submit', handleAddSilo);

  window.addEventListener('click', (ev) => {
    const modal = document.getElementById('addSiloModal');
    if (ev.target === modal) closeAddSiloModal();
  });
}

async function handleAddSilo(event) {
  event.preventDefault();
  const fd = new FormData(event.target);

  const siloData = { name: fd.get('name'), location: fd.get('location') };
  const selectedSensors = Array.from(fd.getAll('sensors'));

  if (!selectedSensors.length) {
    showNotification('warning', 'Selecione pelo menos um tipo de sensor');
    return;
  }

  try {
    const silo = await authManager.makeRequest('/silos', {
      method: 'POST',
      body: JSON.stringify(siloData)
    });

    for (const sensorType of selectedSensors) {
      await authManager.makeRequest(`/sensors/${silo._id}`, {
        method: 'POST',
        body: JSON.stringify({ type: sensorType })
      });
    }

    showNotification('success', 'Silo adicionado com sucesso!');
    closeAddSiloModal();

    await loadDashboardData();
    await buildOrUpdateCharts();
  } catch (error) {
    console.error('Erro ao adicionar silo:', error);
    showNotification('error', 'Erro ao adicionar silo');
  }
}

function showAddSiloModal()  { const m = document.getElementById('addSiloModal'); if (m) m.style.display = 'block'; }
function closeAddSiloModal() { const m = document.getElementById('addSiloModal'); if (m) m.style.display = 'none'; const f = document.getElementById('addSiloForm'); if (f) f.reset(); }

function refreshChart(type) {
  buildOrUpdateCharts().then(() => {
    showNotification('info', `Gráfico de ${type === 'temperature' ? 'temperatura' : 'umidade'} atualizado`);
  });
}

// --------------------- Notificações --------------------

function showNotification(type, message) {
  const container = document.getElementById('notificationContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.innerHTML = `<div style="display:flex;align-items:center;gap:12px;"><i class="${getNotificationIcon(type)}"></i><span>${message}</span></div>`;
  container.appendChild(el);
  const duration = (window.NOTIFICATION_CONFIG && NOTIFICATION_CONFIG.duration) || 3000;
  setTimeout(() => el.remove(), duration);
}

function getNotificationIcon(type) {
  return ({
    success: 'fas fa-check-circle',
    error:   'fas fa-exclamation-circle',
    warning: 'fas fa-exclamation-triangle',
    info:    'fas fa-info-circle'
  }[type]) || 'fas fa-info-circle';
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

window.addEventListener('beforeunload', () => { if (refreshInterval) clearInterval(refreshInterval); });
