/**
 * alerts.js
 * Página de Alertas do Agrosilo (versão PRO)
 *
 * Funcionalidades:
 *  - Carregar alertas do backend com filtros server-side (nível, silo, período)
 *  - Paginação real (page/limit)
 *  - Exibir lista normalizada (independe do formato exato da API)
 *  - Marcar alerta como lido (acknowledge) com atualização da UI
 *  - Fallbacks para Utils e NOTIFICATION_CONFIG, evitando quebre de página
 *
 * Requisitos no backend:
 *   GET  /api/alerts?level=&siloId=&start=&end=&page=&limit=
 *     -> { success, items, page, limit, total, totalPages }
 *   PUT  /api/alerts/:id/acknowledge
 *
 * Dependências existentes no front:
 *   - authManager.makeRequest(path, { method, body })
 *   - requireAuth(), getCurrentUser(), isAdmin()
 *   - (opcional) Utils.getSensorDisplayName(), Utils.formatDate()
 */

// ===========================
// ======= CONFIG/STATE ======
// ===========================

// Paginação gerenciada pelo servidor
let serverPage = 1;
let serverTotalPages = 1;
let serverLimit = 10; // ajuste se quiser mais itens por página

// Guarda o último conjunto de filtros enviados (útil para refresh)
let lastQuery = null;

// Fallback para tempo das notificações caso NOTIFICATION_CONFIG não exista
const NOTIF_DURATION = (window.NOTIFICATION_CONFIG && typeof NOTIFICATION_CONFIG.duration === 'number')
  ? NOTIFICATION_CONFIG.duration
  : 3000;

// ===========================
// ========= BOOT ============
// ===========================

document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth()) return;

  setupUserInterface();
  await loadSilosForFilter();
  await fetchAndRenderAlerts(); // primeira carga
  setupEventHandlers();
});

// ===========================
// ======== UI HEADER ========
// ===========================

function setupUserInterface() {
  const user = getCurrentUser() || {};
  const nameEl = document.getElementById('userName');
  const roleEl = document.getElementById('userRole');
  if (nameEl) nameEl.textContent = user.name || 'Usuário';
  if (roleEl) roleEl.textContent = user.role === 'admin' ? 'Administrador' : 'Usuário';
  if (typeof isAdmin === 'function' && isAdmin()) {
    const item = document.getElementById('usersMenuItem');
    if (item) item.style.display = 'flex';
  }
}

// ===========================
// ======== SILOS/FILTER =====
// ===========================

/**
 * Carrega opções de silos para o filtro <select id="siloFilter">
 */
async function loadSilosForFilter() {
  try {
    const res = await authManager.makeRequest('/silos');
    const silos = Array.isArray(res) ? res : (res?.silos || []);
    const sel = document.getElementById('siloFilter');
    if (!sel) return;

    sel.innerHTML = '<option value="all">Todos os Silos</option>';
    silos.forEach(s => {
      if (!s || !s._id) return;
      const op = document.createElement('option');
      op.value = String(s._id);
      op.textContent = s.name || 'Silo';
      sel.appendChild(op);
    });
  } catch (e) {
    console.error('Erro ao carregar silos para filtro:', e);
    showNotification('error', 'Erro ao carregar silos para filtro.');
  }
}

/**
 * Constrói período (start/end) em ISO a partir do valor do filtro
 * Valores aceitos: "all" | "today" | "last7days" | "last30days"
 */
function buildDateRange(range) {
  const now = new Date();
  let start = null, end = null;

  switch (range) {
    case 'today': {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      start = d.toISOString();
      end = now.toISOString();
      break;
    }
    case 'last7days': {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      start = d.toISOString();
      end = now.toISOString();
      break;
    }
    case 'last30days': {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      start = d.toISOString();
      end = now.toISOString();
      break;
    }
    case 'all':
    default:
      // Sem start/end => todo o histórico
      break;
  }
  return { start, end };
}

/**
 * Lê valores dos filtros atuais na UI
 */
function readCurrentFilters() {
  const level = document.getElementById('alertLevelFilter')?.value || 'all';
  const siloId = document.getElementById('siloFilter')?.value || 'all';
  const dateRange = document.getElementById('dateRangeFilter')?.value || 'all';
  const { start, end } = buildDateRange(dateRange);

  return { level, siloId, start, end, page: serverPage, limit: serverLimit };
}

// ===========================
// ======== FETCH/API ========
// ===========================

/**
 * Busca alertas do backend com os filtros server-side e renderiza
 */
async function fetchAndRenderAlerts() {
  try {
    const q = readCurrentFilters();
    lastQuery = q;

    // Monta querystring
    const params = new URLSearchParams();
    if (q.level && q.level !== 'all') params.set('level', q.level);
    if (q.siloId && q.siloId !== 'all') params.set('siloId', q.siloId);
    if (q.start) params.set('start', q.start);
    if (q.end)   params.set('end', q.end);
    params.set('page', q.page || 1);
    params.set('limit', q.limit || 10);

    // Chamada autenticada
    const resp = await authManager.makeRequest(`/alerts?${params.toString()}`);

    // Suporta {items: [...], page, totalPages} ou array direto
    const items = Array.isArray(resp) ? resp : (resp.items || resp.alerts || []);
    serverPage = Number(resp?.page || 1);
    serverTotalPages = Number(resp?.totalPages || 1);
    serverLimit = Number(resp?.limit || q.limit || 10);

    renderAlerts(items);
    renderPagination();
    updateAlertCount(items); // atualiza badge com base na página atual
  } catch (e) {
    console.error('Erro ao buscar alertas:', e);
    const list = document.getElementById('allAlertsList');
    if (list) {
      list.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-exclamation-triangle"></i>
          <h3>Não foi possível carregar os alertas</h3>
          <p>Verifique sua conexão ou tente novamente mais tarde.</p>
        </div>`;
    }
  }
}

// ===========================
// ======== RENDER UI ========
// ===========================

/**
 * Normaliza um item de alerta para a camada de UI
 * Aceita formatos:
 *   - persistido (Alert): { _id, level, message, siloName, sensorType, timestamp, ... }
 *   - calculado on-the-fly: { alert:{level,message}, silo, sensor, timestamp, ... }
 */
function normalizeAlertItem(a) {
  if (!a) return null;

  const id = a._id || a.id || '';
  const level = a.level || a.alert?.level || 'info';
  const message = a.message || a.alert?.message || '';
  const siloName = a.siloName || a.silo || 'Silo';
  const sensorType = a.sensorType || a.sensor || 'sensor';
  const whenISO = a.timestamp || a.createdAt || a.date || null;

  return {
    id,
    level,
    message,
    siloName,
    sensorType,
    timestamp: whenISO
  };
}

/**
 * Renderiza a lista de alertas
 */
function renderAlerts(items) {
  const list = document.getElementById('allAlertsList');
  if (!list) return;

  if (!items || !items.length) {
    list.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-bell-slash"></i>
        <h3>Nenhum alerta encontrado</h3>
        <p>Nenhum alerta corresponde aos filtros selecionados.</p>
      </div>`;
    return;
  }

  const html = items.map(raw => {
    const a = normalizeAlertItem(raw);
    if (!a) return '';

    // Usa Utils se existir; se não, fallback para toLocaleString
    const sensorName = (window.Utils?.getSensorDisplayName
      ? Utils.getSensorDisplayName(a.sensorType)
      : a.sensorType);

    const when = (window.Utils?.formatDate
      ? Utils.formatDate(a.timestamp, { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
      : (a.timestamp ? new Date(a.timestamp).toLocaleString('pt-BR') : '--'));

    return `
      <div class="alert-item ${a.level}">
        <div class="alert-icon ${a.level}">
          <i class="fas fa-exclamation-triangle"></i>
        </div>
        <div class="alert-content">
          <h4 class="alert-title">${a.siloName} - ${sensorName}</h4>
          <p class="alert-description">${a.message}</p>
        </div>
        <div class="alert-time">${when}</div>
        <div class="alert-actions">
          <button class="btn btn-sm btn-outline" onclick="acknowledgeAlert('${a.id}')">
            <i class="fas fa-check"></i> Marcar como Lido
          </button>
        </div>
      </div>`;
  }).join('');

  list.innerHTML = html;
}

/**
 * Renderiza os controles de paginação
 */
function renderPagination() {
  const el = document.getElementById('paginationControls');
  if (!el) return;

  el.innerHTML = '';
  if (serverTotalPages <= 1) return;

  const prev = document.createElement('button');
  prev.className = 'btn btn-outline';
  prev.innerHTML = '<i class="fas fa-chevron-left"></i> Anterior';
  prev.disabled = serverPage <= 1;
  prev.onclick = () => { serverPage = Math.max(1, serverPage - 1); fetchAndRenderAlerts(); };
  el.appendChild(prev);

  const span = document.createElement('span');
  span.className = 'page-info';
  span.textContent = `Página ${serverPage} de ${serverTotalPages}`;
  el.appendChild(span);

  const next = document.createElement('button');
  next.className = 'btn btn-outline';
  next.innerHTML = 'Próximo <i class="fas fa-chevron-right"></i>';
  next.disabled = serverPage >= serverTotalPages;
  next.onclick = () => { serverPage = Math.min(serverTotalPages, serverPage + 1); fetchAndRenderAlerts(); };
  el.appendChild(next);
}

// ===========================
// ===== ACKNOWLEDGE/UX ======
// ===========================

/**
 * Marca um alerta como lido no backend e recarrega a página atual
 */
async function acknowledgeAlert(id) {
  if (!id) { showNotification('info', 'Sem ID de alerta.'); return; }

  try {
    await authManager.makeRequest(`/alerts/${id}/acknowledge`, { method: 'PUT' });
    showNotification('success', 'Alerta marcado como lido.');
    await fetchAndRenderAlerts(); // mantém filtros e página
  } catch (e) {
    console.error('Erro ao marcar alerta como lido:', e);
    showNotification('error', 'Erro ao marcar alerta como lido.');
  }
}

/**
 * Atualiza a badge no menu com base nos itens atuais (página carregada).
 * Obs.: para contar o total global não lido, o ideal é uma rota específica (ex.: GET /api/alerts/count?ack=false).
 */
function updateAlertCount(items) {
  const badge = document.getElementById('alertCount');
  if (!badge) return;

  const active = (items || []).filter(x => !x.acknowledged).length;
  badge.textContent = active;
  badge.style.display = active > 0 ? 'inline-block' : 'none';
}

// ===========================
// ======== EVENTOS UI =======
// ===========================

function setupEventHandlers() {
  const level = document.getElementById('alertLevelFilter');
  const silo  = document.getElementById('siloFilter');
  const date  = document.getElementById('dateRangeFilter');

  const onChange = () => { serverPage = 1; fetchAndRenderAlerts(); };

  if (level) level.addEventListener('change', onChange);
  if (silo)  silo.addEventListener('change', onChange);
  if (date)  date.addEventListener('change', onChange);
}

/**
 * Botão "Atualizar"
 */
function refreshAlerts() {
  fetchAndRenderAlerts();
  showNotification('info', 'Alertas atualizados.');
}

// ===========================
// ===== NOTIFICAÇÕES UI =====
// ===========================

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

  setTimeout(() => el.remove(), NOTIF_DURATION);
}

function getNotificationIcon(type) {
  const icons = {
    success: 'fas fa-check-circle',
    error:   'fas fa-exclamation-circle',
    warning: 'fas fa-exclamation-triangle',
    info:    'fas fa-info-circle'
  };
  return icons[type] || icons.info;
}

// ============== EXPORT HELPERS ==============

// Lê filtros atuais (já existe, mas aqui reaproveito)
function getCurrentQueryForExport() {
  const level = document.getElementById('alertLevelFilter')?.value || 'all';
  const siloId = document.getElementById('siloFilter')?.value || 'all';
  const dateRange = document.getElementById('dateRangeFilter')?.value || 'all';
  const { start, end } = buildDateRange(dateRange);
  return { level, siloId, start, end };
}

// Busca TODAS as páginas do endpoint /api/alerts para exportação
async function fetchAllAlertsForExport() {
  const q = getCurrentQueryForExport();

  const params = new URLSearchParams();
  if (q.level !== 'all') params.set('level', q.level);
  if (q.siloId !== 'all') params.set('siloId', q.siloId);
  if (q.start) params.set('start', q.start);
  if (q.end)   params.set('end', q.end);

  // puxe em lotes maiores p/ export (ex.: 500 por página)
  const perPage = 500;
  let page = 1;
  let all = [];

  while (true) {
    const p = new URLSearchParams(params);
    p.set('page', page);
    p.set('limit', perPage);
    const resp = await authManager.makeRequest(`/alerts?${p.toString()}`);
    const items = Array.isArray(resp) ? resp : (resp.items || []);
    all = all.concat(items);
    const totalPages = Number(resp?.totalPages || 1);
    if (page >= totalPages) break;
    page += 1;
  }

  return all;
}

// Converte itens em CSV
function alertsToCSV(items) {
  const header = [
    'Data/Hora',
    'Silo',
    'Tipo de Sensor',
    'Nível',
    'Valor',
    'Mensagem',
    'Recomendação',
    'ID Alerta'
  ];

  const rows = items.map(a => {
    const when = a.timestamp || a.createdAt || a.date;
    const dt = when ? new Date(when).toLocaleString('pt-BR') : '';
    const silo = a.siloName || a.silo || '';
    const tipo = a.sensorType || a.sensor || '';
    const nivel = a.level || a.alert?.level || '';
    const valor = (typeof a.value === 'number') ? String(a.value).replace('.', ',') : (a.value ?? '');
    const msg = a.message || a.alert?.message || '';
    const rec = a.recommendation || a.alert?.recommendation || '';
    const id  = a._id || a.id || '';
    // Sanitize aspas/virgulas
    const esc = (t) => `"${String(t ?? '').replaceAll('"','""')}"`;
    return [dt, silo, tipo, nivel, valor, msg, rec, id].map(esc).join(',');
  });

  return [header.join(','), ...rows].join('\r\n');
}

function triggerDownload(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ============== AÇÃO: CSV ==============
async function downloadAlertsCSV() {
  try {
    showNotification('info', 'Gerando CSV...');
    const items = await fetchAllAlertsForExport();
    if (!items.length) {
      showNotification('warning', 'Não há alertas para exportar.');
      return;
    }

    const csv = alertsToCSV(items);
    const q = getCurrentQueryForExport();
    const period = q.start && q.end
      ? `${q.start.substring(0,10)}_a_${q.end.substring(0,10)}`
      : 'completo';
    triggerDownload(`agrosilo-alertas_${period}.csv`, 'text/csv;charset=utf-8', csv);
    showNotification('success', 'CSV gerado com sucesso.');
  } catch (e) {
    console.error('CSV export error:', e);
    showNotification('error', 'Falha ao gerar CSV.');
  }
}

// ============== AÇÃO: PDF ==============
// ============== AÇÃO: PDF (Relatório Técnico de Alertas) ==============
//
// Gera PDF A4 com: cabeçalho + logo (direita, proporcional), metadados
// (Nível, Silo, Período, Gerado em, Total), resumos e tabela paginada.
// ======================================================================

let _pdfLibsLoaded = false;
async function ensureJsPDFLoaded() {
  if (_pdfLibsLoaded && window.jspdf?.jsPDF?.API?.autoTable) return;

  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error(`Falha ao carregar: ${src}`));
    document.head.appendChild(s);
  });

  await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
  await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js');

  if (!window.jspdf?.jsPDF?.API?.autoTable) throw new Error('jsPDF/autotable indisponível');
  _pdfLibsLoaded = true;
}

// ---- util: formatação pt-BR consistente (usa Date -> string) ----
function formatDateTimeBR(d) {
  return new Date(d).toLocaleString('pt-BR');
}

// ---- carrega logo como DataURL (evita CORS) ----
// OBS: arquivo tem espaço no nome => usar %20
async function fetchLogoAsDataURL(path) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    return await new Promise((ok) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn('Logo indisponível (seguindo sem ela):', e);
    return null;
  }
}

// ---- mede largura/altura reais da imagem para manter proporção ----
function getImageNaturalSize(dataURL) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
    img.src = dataURL;
  });
}

// ---- deduz o período [início -> agora] quando não vier start/end ----
function computePeriodRange(q) {
  if (q.start && q.end) return { start: new Date(q.start), end: new Date(q.end) };

  const sel = document.getElementById('dateRangeFilter');
  const val = sel?.value || 'all';
  const now = new Date();
  let start = null;

  if (val === 'today') {
    start = new Date(now); start.setHours(0,0,0,0);
    return { start, end: now };
  }
  if (val === 'last7days') {
    start = new Date(now); start.setDate(start.getDate() - 7);
    return { start, end: now };
  }
  if (val === 'last30days') {
    start = new Date(now); start.setDate(start.getDate() - 30);
    return { start, end: now };
  }
  return null; // todo o período
}

// ---- string "Período:" padronizada (usa ASCII "->" para evitar problemas) ----
function prettyPeriod(q) {
  const range = computePeriodRange(q);
  if (!range) return 'Todo o período';
  return `${formatDateTimeBR(range.start)} -> ${formatDateTimeBR(range.end)}`;
}

// ---- coleta todos os alertas com filtros atuais (paginado no backend) ----
async function fetchAllAlertsForExport() {
  const q = getCurrentQueryForExport();
  const params = new URLSearchParams();
  if (q.level && q.level !== 'all') params.set('level', q.level);
  if (q.siloId && q.siloId !== 'all') params.set('siloId', q.siloId);
  if (q.start) params.set('start', q.start);
  if (q.end)   params.set('end', q.end);

  let page = 1, limit = 200, out = [];
  while (true) {
    params.set('page', page); params.set('limit', limit);
    const resp = await authManager.makeRequest(`/alerts?${params.toString()}`);
    const items = Array.isArray(resp) ? resp : (resp.items || []);
    out = out.concat(items);
    const totalPages = Number(resp?.totalPages || 1);
    if (page >= totalPages) break;
    page++;
  }
  return out;
}

// ---- ação principal: gerar e baixar o PDF ----
async function downloadAlertsPDF() {
  try {
    showNotification('info', 'Gerando PDF técnico...');
    await ensureJsPDFLoaded();

    const items = await fetchAllAlertsForExport();
    if (!items.length) {
      showNotification('warning', 'Não há alertas para exportar.');
      return;
    }

    // contagens para resumos
    const byLevel = { caution:0, warning:0, critical:0 };
    const byType  = {};
    for (const a of items) {
      const lvl = (a.level || a.alert?.level || '').toLowerCase();
      if (byLevel[lvl] != null) byLevel[lvl] += 1;
      const t = (a.sensorType || a.sensor || 'sensor').toLowerCase();
      byType[t] = (byType[t] || 0) + 1;
    }

    // filtros (metadados)
    const q = getCurrentQueryForExport();
    const filtroNivel   = q.level === 'all' ? 'Todos' : q.level;
    const filtroSiloTxt = document.querySelector('#siloFilter option:checked')?.textContent || 'Todos os Silos';
    const filtroPeriodo = prettyPeriod(q);

    // doc A4
    const { jsPDF } = window.jspdf;
    const margin = 40;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    let y = margin;

    // ---------- Cabeçalho ----------
    // título
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text('Relatório Técnico de Alertas - Agrosilo', margin, y + 28);

    // logo: mantém proporção, alinha no topo-direito
    const logoData = await fetchLogoAsDataURL('../images/logo%20copy.png');
    if (logoData) {
      try {
        const natural = await getImageNaturalSize(logoData);
        const maxW = 120, maxH = 48; // mais alto para não “achatar”
        // escala proporcional
        const ratio = Math.min(maxW / natural.w, maxH / natural.h);
        const w = Math.round(natural.w * ratio);
        const h = Math.round(natural.h * ratio);
        const x = pageW - margin - w; // à direita
        const yLogo = margin;         // topo
        doc.addImage(logoData, 'PNG', x, yLogo, w, h);
      } catch (e) {
        console.warn('Falha ao desenhar logo:', e);
      }
    }

    // avança abaixo do cabeçalho
    y += 70;

    // ---------- Metadados ----------
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(0,0,0); // garante cor padrão
    const metaLines = [
      `Nível: ${filtroNivel}`,
      `Silo: ${filtroSiloTxt}`,
      `Período: ${filtroPeriodo}`,
      `Gerado em: ${formatDateTimeBR(new Date())}`,
      `Total de alertas: ${items.length}`
    ];
    for (const line of metaLines) {
      doc.text(line, margin, y);
      y += 16;
    }
    y += 6;

    // ---------- Resumo por Nível ----------
    const lvlRows = [
      ['Atenção moderada', byLevel.caution],
      ['Atenção',           byLevel.warning],
      ['Crítico',           byLevel.critical],
    ];
    doc.autoTable({
      head: [['Resumo por Nível', 'Qtde']],
      body: lvlRows,
      startY: y,
      margin: { left: margin, right: margin },
      theme: 'grid',
      styles: { fontSize: 10 },
      headStyles: { fillColor: [51,122,85] }
    });
    y = doc.lastAutoTable.finalY + 12;

    // ---------- Resumo por Sensor ----------
    const typeRows = Object.keys(byType).map(k => [k, byType[k]]);
    doc.autoTable({
      head: [['Resumo por Sensor', 'Qtde']],
      body: typeRows.length ? typeRows : [['—', 0]],
      startY: y,
      margin: { left: margin, right: margin },
      theme: 'grid',
      styles: { fontSize: 10 },
      headStyles: { fillColor: [51,122,85] }
    });
    y = doc.lastAutoTable.finalY + 16;

    // ---------- Tabela principal ----------
    const body = items.map(a => {
      const when = a.timestamp || a.createdAt || a.date;
      const dt   = when ? formatDateTimeBR(when) : '';
      const silo = a.siloName || a.silo || '';
      const sens = a.sensorType || a.sensor || '';
      const lvl  = a.level || a.alert?.level || '';
      const val  = (typeof a.value === 'number') ? String(a.value).replace('.', ',') : (a.value ?? '');
      const msg  = a.message || a.alert?.message || '';
      return [dt, silo, sens, lvl, val, msg];
    });

    const columnStyles = {
      0: { cellWidth: 110 }, // Data/Hora
      1: { cellWidth: 95  }, // Silo
      2: { cellWidth: 75  }, // Sensor
      3: { cellWidth: 60  }, // Nível
      4: { cellWidth: 45  }, // Valor
      5: { cellWidth: 'auto' } // Mensagem
    };

    const addFooter = (data) => {
      doc.setFontSize(9);
      doc.text(`Página ${data.pageNumber}`, pageW - margin, pageH - 14, { align: 'right' });
    };

    doc.autoTable({
      head: [['Data/Hora','Silo','Sensor','Nível','Valor','Mensagem']],
      body,
      startY: y,
      margin: { left: margin, right: margin },
      styles: { fontSize: 9, cellPadding: 4, overflow: 'linebreak' },
      headStyles: { fillColor: [51,122,85] },
      columnStyles,
      didDrawPage: addFooter
    });

    // ---------- Nome do arquivo ----------
    const range = computePeriodRange(q);
    const asISO = (d) => new Date(d).toISOString().slice(0,10);
    const filename = range
      ? `agrosilo-alertas-tecnico_${asISO(range.start)}_a_${asISO(range.end)}.pdf`
      : `agrosilo-alertas-tecnico_completo.pdf`;

    doc.save(filename);
    showNotification('success', 'PDF técnico gerado com sucesso.');
  } catch (e) {
    console.error('[PDF] erro ao gerar:', e);
    showNotification('error', 'Falha ao gerar PDF.');
  }
}
