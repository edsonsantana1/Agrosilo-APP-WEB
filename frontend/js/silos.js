// js/silos.js
// Tela de Silos - Agrosilo
//
// Responsável por:
// - Garantir autenticação
// - Preencher header (usuário / menu / alertas)
// - Carregar silos + summaries de sensores
// - Renderizar cards dos silos
// - Auto-refresh dos dados
// - Abrir/fechar modal "Adicionar Silo"
// - Criar silo + sensores via API
// - Exibir notificações locais

// ================= ESTADO GLOBAL =================
let silosData = [];       // Lista de silos do usuário
let latestSummaries = {}; // Map: { [siloId]: { sensors: [...] } }
let refreshHandle = null; // Handler do setInterval

// ================= BOOT DA PÁGINA =================
document.addEventListener('DOMContentLoaded', () => {
  // Garante que o usuário está autenticado
  if (!requireAuth()) return;

  // Header (nome, papel, menu, badge de alertas)
  setupHeaderUI();

  // Setup do modal + CRUD (submit do form, clique fora do modal)
  setupCrudEventHandlers();

  // Carga inicial dos dados
  initSilosPage();
});

// Inicialização principal da tela de Silos
async function initSilosPage() {
  try {
    await loadSilosAndSummaries(); // Busca silos + últimos summaries dos sensores
    renderSilosGrid();             // Desenha os cards de silo
    setupAutoRefresh();            // Liga o loop de atualização automática
  } catch (err) {
    console.error('[silos] init erro:', err);
    showLoadError();
  }
}

// ================= HEADER / USUÁRIO / ALERTAS =================

// Preenche informações de usuário e menu
function setupHeaderUI() {
  const user = getCurrentUser?.() || {};
  setTextSafe('userName', user.name || 'Usuário');
  setTextSafe('userRole', user.role === 'admin' ? 'Administrador' : 'Usuário');

  // Mostra menu de Usuários se for admin
  if (typeof isAdmin === 'function' && isAdmin()) {
    const um = document.getElementById('usersMenuItem');
    if (um) um.style.display = 'flex';
  }

  // Atualiza badge de alertas
  updateAlertBadge().catch(() => {});
}

// Atualiza badge de quantidade de alertas ativos
async function updateAlertBadge() {
  try {
    const resp = await authManager.makeRequest('/alerts/active');
    const items = Array.isArray(resp) ? resp : (resp?.alerts || []);
    const badge = document.getElementById('alertCount');
    if (badge) {
      const total = items.length || 0;
      badge.textContent = total;
      badge.style.display = total > 0 ? 'inline-block' : 'none';
    }
  } catch (_) {
    // silencioso
  }
}

// ================= CARGA DE DADOS (SILOS + SUMMARY) =================

// Busca silos do usuário + summary de sensores de cada silo
async function loadSilosAndSummaries() {
  // 1) Silos do usuário
  const res = await authManager.makeRequest('/silos');
  silosData = Array.isArray(res) ? res : (res?.silos || []);
  if (!Array.isArray(silosData)) silosData = [];

  // 2) Summary dos sensores por silo
  latestSummaries = {};
  for (const silo of silosData) {
    try {
      const summary = await authManager.makeRequest(
        `/sensors/silo/${silo._id}/summary`
      );
      // Esperado: { sensors: [{ _id, type, lastValue, lastTimestamp }, ...] }
      latestSummaries[silo._id] = summary || { sensors: [] };
    } catch (e) {
      console.warn('[silos] summary falhou p/ silo', silo._id, e);
      latestSummaries[silo._id] = { sensors: [] };
    }
  }
}

// ================= RENDERIZAÇÃO DA GRADE =================

function renderSilosGrid() {
  const grid = document.getElementById('silosGrid');
  if (!grid) return;

  // Nenhum silo cadastrado
  if (!silosData.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-warehouse"></i>
        <h3>Nenhum silo cadastrado</h3>
        <p>Adicione seu primeiro silo para começar o monitoramento</p>
      </div>`;
    return;
  }

  // Renderizar cards
  grid.innerHTML = '';
  for (const silo of silosData) {
    const sensors = latestSummaries[silo._id]?.sensors || [];

    const readings = sensors.length
      ? sensors
          .map((s) => {
            const valueNum =
              s.lastValue != null && s.lastValue !== ''
                ? Number(s.lastValue)
                : null;
            const valueTxt =
              valueNum != null && Number.isFinite(valueNum)
                ? valueNum.toFixed(1)
                : '--';

            const unit = getUnitSafe(s.type);
            const icon = getIconSafe(s.type);
            const level = getLevelSafe(s.type, s.lastValue);

            return `
            <div class="sensor-reading">
              <div class="sensor-info">
                <div class="sensor-icon ${s.type}">
                  <i class="${icon}"></i>
                </div>
                <span class="sensor-name">
                  ${getDisplayNameSafe(s.type)}
                </span>
              </div>
              <div class="sensor-value">
                <span class="value-number">${valueTxt}${unit}</span>
                <div class="value-status ${level}"></div>
              </div>
            </div>`;
          })
          .join('')
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
          <i class="fas fa-map-marker-alt"></i>
          ${silo.location || 'Localização não informada'}
        </div>
      </div>
      <div class="silo-sensors">
        ${readings}
      </div>`;

    grid.appendChild(card);
  }
}

// ================= AUTO-REFRESH =================

function setupAutoRefresh() {
  const interval =
    (window.CHART_CONFIG && CHART_CONFIG.refreshInterval) || 15000;

  if (refreshHandle) clearInterval(refreshHandle);

  refreshHandle = setInterval(async () => {
    try {
      // (Opcional) sincroniza ThingSpeak -> Mongo
      try {
        await authManager.makeRequest('/thingspeak/sync-all', {
          method: 'POST',
        });
      } catch (_) {
        // se a rota não existir, ignoramos
      }

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

// ================= CRUD: MODAL + CRIAÇÃO DE SILO =================

// Registra eventos do CRUD (submit do form + clique fora do modal)
function setupCrudEventHandlers() {
  const form = document.getElementById('addSiloForm');
  if (form) {
    form.addEventListener('submit', handleAddSilo);
  }

  // Fecha modal ao clicar fora do conteúdo
  window.addEventListener('click', (ev) => {
    const modal = document.getElementById('addSiloModal');
    if (ev.target === modal) {
      closeAddSiloModal();
    }
  });
}

// Handler de submit do formulário de novo silo
async function handleAddSilo(event) {
  event.preventDefault();

  const fd = new FormData(event.target);

  const siloData = {
    name: fd.get('name'),
    location: fd.get('location'),
  };

  const selectedSensors = Array.from(fd.getAll('sensors'));

  if (!selectedSensors.length) {
    showNotification('warning', 'Selecione pelo menos um tipo de sensor');
    return;
  }

  try {
    // 1. Cria o silo
    const silo = await authManager.makeRequest('/silos', {
      method: 'POST',
      body: JSON.stringify(siloData),
    });

    // 2. Cria os sensores associados
    for (const sensorType of selectedSensors) {
      await authManager.makeRequest(`/sensors/${silo._id}`, {
        method: 'POST',
        body: JSON.stringify({ type: sensorType }),
      });
    }

    // 3. Notifica sucesso (AGORA EXISTE showNotification AQUI)
    showNotification('success', 'Silo adicionado com sucesso!');

    // 4. FECHA O MODAL ANTES DE RECARREGAR
    closeAddSiloModal();

    // 5. Recarrega lista de silos (se alguma falhar, o modal já está fechado)
    await loadSilosAndSummaries();
    renderSilosGrid();
    updateAlertBadge().catch(() => {});
  } catch (error) {
    console.error('Erro ao adicionar silo:', error);
    showNotification('error', 'Erro ao adicionar silo');
  }
}

// Abre o modal
function showAddSiloModal() {
  const m = document.getElementById('addSiloModal');
  if (m) {
    m.style.display = 'block';
  }
}

// Fecha o modal e reseta o form
function closeAddSiloModal() {
  const m = document.getElementById('addSiloModal');
  if (m) {
    m.style.display = 'none';
  }

  const f = document.getElementById('addSiloForm');
  if (f) {
    f.reset();
  }
}

// Disponibiliza funções para o HTML (onclick)
window.showAddSiloModal = showAddSiloModal;
window.closeAddSiloModal = closeAddSiloModal;

// ================= NOTIFICAÇÕES LOCAIS =================

// Versão simplificada do showNotification, igual conceito do dashboard
function showNotification(type, message) {
  const container = document.getElementById('notificationContainer');

  // Se não tiver container, faz um fallback simples
  if (!container) {
    console.log(`[${type}] ${message}`);
    return;
  }

  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;">
      <i class="${getNotificationIcon(type)}"></i>
      <span>${message}</span>
    </div>
  `;

  container.appendChild(el);

  const duration =
    (window.NOTIFICATION_CONFIG && NOTIFICATION_CONFIG.duration) || 3000;

  setTimeout(() => {
    el.remove();
  }, duration);
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

// ================= HELPERS GENÉRICOS =================

function getDisplayNameSafe(type) {
  if (window.Utils?.getSensorDisplayName)
    return Utils.getSensorDisplayName(type);

  const map = {
    temperature: 'Temperatura',
    humidity: 'Umidade',
    pressure: 'Pressão',
    co2: 'CO2',
  };
  return map[type] || type;
}

function getUnitSafe(type) {
  if (window.Utils?.getSensorUnit) return Utils.getSensorUnit(type);

  return type === 'temperature'
    ? '°C'
    : type === 'humidity'
    ? '%'
    : type === 'pressure'
    ? 'hPa'
    : type === 'co2'
    ? 'ppm'
    : '';
}

function getIconSafe(type) {
  if (window.Utils?.getSensorIcon) return Utils.getSensorIcon(type);

  return type === 'temperature'
    ? 'fas fa-thermometer-half'
    : type === 'humidity'
    ? 'fas fa-tint'
    : type === 'pressure'
    ? 'fas fa-gauge-high'
    : type === 'co2'
    ? 'fas fa-smog'
    : 'fas fa-circle';
}

function getLevelSafe(type, value) {
  // Se existir lógica centralizada em Utils, usa ela
  if (window.Utils?.getAlertLevel) return Utils.getAlertLevel(type, value);
  // Fallback simples: tudo normal
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
