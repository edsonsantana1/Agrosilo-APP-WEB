// js/silos.js (PROD) — carrega os mesmos cards do Dashboard em tempo real

// ======= Estado / referências =======
let silosData = [];               // lista de silos do usuário
let latestSummaries = {};         // { [siloId]: { sensors: [{ _id, type, lastValue, lastTimestamp }] } }
let refreshHandle = null;

// ======= Boot =======
document.addEventListener('DOMContentLoaded', () => {
  if (!requireAuth()) return;
  initSilosPage();
});

async function initSilosPage() {
  try {
    setupHeaderUI();
    await loadSilosAndSummaries();
    renderSilosGrid();
    setupAutoRefresh();
  } catch (err) {
    console.error('[silos] init erro:', err);
    showLoadError();
  }
}

// ======= UI Header =======
function setupHeaderUI() {
  const user = getCurrentUser?.() || {};
  setTextSafe('userName', user.name || 'Usuário');
  setTextSafe('userRole', user.role === 'admin' ? 'Administrador' : 'Usuário');

  if (typeof isAdmin === 'function' && isAdmin()) {
    const um = document.getElementById('usersMenuItem');
    if (um) um.style.display = 'flex';
  }

  // Atualiza o badge de alertas (opcional)
  updateAlertBadge().catch(() => {});
}

async function updateAlertBadge() {
  try {
    // Se tiver rota /api/alerts/active, usamos para o badge
    const resp = await authManager.makeRequest('/alerts/active');
    const items = Array.isArray(resp) ? resp : (resp?.alerts || []);
    const badge = document.getElementById('alertCount');
    if (badge) {
      badge.textContent = items.length || 0;
      badge.style.display = (items.length || 0) > 0 ? 'inline-block' : 'none';
    }
  } catch (_) {
    // silencioso
  }
}

// ======= Carregamento de dados =======
async function loadSilosAndSummaries() {
  // 1) Silos do usuário
  const res = await authManager.makeRequest('/silos');
  silosData = Array.isArray(res) ? res : (res?.silos || []);
  if (!Array.isArray(silosData)) silosData = [];

  // 2) Summary de cada silo
  latestSummaries = {};
  for (const silo of silosData) {
    try {
      const summary = await authManager.makeRequest(`/sensors/silo/${silo._id}/summary`);
      // Formato esperado: { sensors: [{ _id, type, lastValue, lastTimestamp }, ...] }
      latestSummaries[silo._id] = summary || { sensors: [] };
    } catch (e) {
      console.warn('[silos] summary falhou p/ silo', silo._id, e);
      latestSummaries[silo._id] = { sensors: [] };
    }
  }
}

// ======= Render =======
function renderSilosGrid() {
  const grid = document.getElementById('silosGrid');
  if (!grid) return;

  if (!silosData.length) {
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
          const valueNum = (s.lastValue != null && s.lastValue !== '') ? Number(s.lastValue) : null;
          const valueTxt = valueNum != null && Number.isFinite(valueNum) ? valueNum.toFixed(1) : '--';

          const unit  = getUnitSafe(s.type);
          const icon  = getIconSafe(s.type);
          const level = getLevelSafe(s.type, s.lastValue); // normal | caution | warning | critical

          return `
            <div class="sensor-reading">
              <div class="sensor-info">
                <div class="sensor-icon ${s.type}"><i class="${icon}"></i></div>
                <span class="sensor-name">${getDisplayNameSafe(s.type)}</span>
              </div>
              <div class="sensor-value">
                <span class="value-number">${valueTxt}${unit}</span>
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

// ======= Auto-Refresh =======
function setupAutoRefresh() {
  const interval = (window.CHART_CONFIG && CHART_CONFIG.refreshInterval) || 15000;
  if (refreshHandle) clearInterval(refreshHandle);

  refreshHandle = setInterval(async () => {
    try {
      // (opcional) sincroniza ThingSpeak -> Mongo se tiver a rota
      try { await authManager.makeRequest('/thingspeak/sync-all', { method: 'POST' }); } catch (_) {}

      await loadSilosAndSummaries();
      renderSilosGrid();
      await updateAlertBadge();
    } catch (err) {
      console.warn('[silos] refresh erro:', err);
    }
  }, interval);
}

window.addEventListener('beforeunload', () => {
  if (refreshHandle) clearInterval(refreshHandle);
});

// ======= Helpers (com fallback se Utils não existir) =======
function getDisplayNameSafe(type) {
  if (window.Utils?.getSensorDisplayName) return Utils.getSensorDisplayName(type);
  return ({ temperature: 'Temperatura', humidity: 'Umidade', pressure: 'Pressão', co2: 'CO2' }[type]) || type;
}
function getUnitSafe(type) {
  if (window.Utils?.getSensorUnit) return Utils.getSensorUnit(type);
  return type === 'temperature' ? '°C'
       : type === 'humidity'    ? '%'
       : type === 'pressure'    ? 'hPa'
       : type === 'co2'         ? 'ppm'
       : '';
}
function getIconSafe(type) {
  if (window.Utils?.getSensorIcon) return Utils.getSensorIcon(type);
  return type === 'temperature' ? 'fas fa-thermometer-half'
       : type === 'humidity'    ? 'fas fa-tint'
       : type === 'pressure'    ? 'fas fa-gauge-high'
       : type === 'co2'         ? 'fas fa-smog'
       : 'fas fa-circle';
}
function getLevelSafe(type, value) {
  if (window.Utils?.getAlertLevel) return Utils.getAlertLevel(type, value);
  // fallback simples: sem Utils, não classifica
  return 'normal';
}

function setTextSafe(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function showLoadError() {
  const grid = document.getElementById('silosGrid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="empty-state">
      <i class="fas fa-exclamation-triangle"></i>
      <h3>Não foi possível carregar os silos.</h3>
      <p>Tente novamente.</p>
    </div>`;
}
