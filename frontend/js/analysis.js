/**
 * analysis.js (hotfix + boas práticas de série temporal)
 *
 * Melhorias principais:
 * - (GRÁFICO) Converte timestamp -> milissegundos em fetchHistory (melhor para Chart.js TimeScale)
 * - (GRÁFICO) Define parsing explícito { xAxisKey:'x', yAxisKey:'y' } e ativa decimação min-max
 * - (GRÁFICO) Usa spanGaps:true para evitar "buracos" desconexos no traçado
 * - (GRÁFICO) Ajusta time.unit dinamicamente (24h -> hour, 7d/30d/all -> day)
 * - KPIs seguros contra undefined/NaN (safeFmt) e computeStats robusto
 * - onGenerate limpa estado quando não há dados
 * - Export PDF/CSV tratam 404 com mensagem do servidor
 */

(function () {
  // ---------- Utils robustos ----------
  const U = (() => {
    const hasUtils = typeof window !== "undefined" && window.Utils && typeof window.Utils === "object";

    const formatDate = (d, opts = {}) => {
      try {
        const date = new Date(d);
        const base = {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        };
        return new Intl.DateTimeFormat("pt-BR", { ...base, ...opts }).format(date);
      } catch {
        return String(d);
      }
    };

    const getSensorConfig = (t) => {
      switch (t) {
        case "temperature": return { displayName: "Temperatura", unit: "°C",  color: "rgb(255,99,132)" };
        case "humidity":    return { displayName: "Umidade",     unit: "%",   color: "rgb(54,162,235)" };
        case "pressure":    return { displayName: "Pressão Atmosférica", unit: "hPa", color: "rgb(75,192,192)" };
        case "co2":         return { displayName: "Gás CO2",     unit: "ppm", color: "rgb(153,102,255)" };
        default:            return { displayName: t, unit: "",   color: "rgb(201,203,207)" };
      }
    };

    const notify = (type, msg) => {
      if (hasUtils && typeof window.Utils.showNotification === "function") {
        window.Utils.showNotification(type, msg);
      } else {
        console[type === "error" ? "error" : "log"](`[${type}] ${msg}`);
        if (type === "error" || type === "warning") alert(`${type.toUpperCase()}: ${msg}`);
      }
    };

    return { formatDate, getSensorConfig, notify };
  })();

  // ---------- Estado ----------
  let lineChart = null;

  // ---------- Boot ----------
  document.addEventListener("DOMContentLoaded", () => {
    if (!requireAuth()) return;
    setupUserInterface();
    loadSilos();
    wireUI();
    showChartEmptyState(true);
  });

  function setupUserInterface() {
    const user = getCurrentUser() || {};
    const nameEl = document.getElementById("userName");
    const roleEl = document.getElementById("userRole");
    if (nameEl) nameEl.textContent = user.name || "Usuário";
    if (roleEl) roleEl.textContent = user.role === "admin" ? "Administrador" : "Usuário";
    if (typeof isAdmin === "function" && isAdmin()) {
      const item = document.getElementById("usersMenuItem");
      if (item) item.style.display = "flex";
    }
  }

  // ---------- UI ----------
  function wireUI() {
    const rangeSel = document.getElementById("dateRangeSelect");
    const customDates = document.getElementById("customDates");
    rangeSel.addEventListener("change", () => {
      if (!customDates) return;
      customDates.style.display = rangeSel.value === "custom" ? "block" : "none";
    });

    document.getElementById("btnGenerate")?.addEventListener("click", onGenerate);
    document.getElementById("btnCSV")?.addEventListener("click", onExportCSV);
    document.getElementById("btnPDF")?.addEventListener("click", onExportPDF);
  }

  // ---------- Silos ----------
  async function loadSilos() {
    const select = document.getElementById("siloSelect");
    if (!select) return;
    select.innerHTML = '<option value="">Selecione um Silo</option>';
    try {
      const silos = await authManager.makeRequest("/analysis/silos");
      (silos || []).forEach(s => {
        const opt = document.createElement("option");
        opt.value = s._id;
        opt.textContent = s.name;
        select.appendChild(opt);
      });
      if (!silos || silos.length === 0) U.notify("info", "Você ainda não tem silos cadastrados.");
    } catch (e) {
      console.error(e);
      U.notify("error", "Erro ao carregar silos.");
    }
  }

  // ---------- Período ----------
  function getPeriodSelection() {
    const rangeSel = document.getElementById("dateRangeSelect");
    const range = rangeSel?.value || "24h";
    if (range !== "custom") return { range, start: null, end: null };

    const sEl = document.getElementById("startInput");
    const eEl = document.getElementById("endInput");
    const s = sEl?.value;
    const e = eEl?.value;

    const start = s ? new Date(s) : null;
    const end   = e ? new Date(e) : null;

    if (start && end && start > end) {
      U.notify("warning", "Data inicial maior que a final.");
      return { range: "24h", start: null, end: null };
    }
    return { range: "custom", start, end };
  }

  function toISOIfDate(d) {
    return d instanceof Date && !isNaN(d.valueOf()) ? d.toISOString() : null;
  }

  function normalizeWindow({ range, start, end }) {
    if (range === "custom" && start && end) {
      const s = start.getTime(), e = end.getTime();
      return { start, end, durMs: Math.max(0, e - s) };
    }
    const now = new Date();
    if (range === "24h") { const s = new Date(now); s.setHours(s.getHours() - 24); return { start: s, end: now, durMs: 24*3600e3 }; }
    if (range === "7d")  { const s = new Date(now); s.setDate(s.getDate() - 7);   return { start: s, end: now, durMs: 7*24*3600e3 }; }
    if (range === "30d") { const s = new Date(now); s.setDate(s.getDate() - 30);  return { start: s, end: now, durMs: 30*24*3600e3 }; }
    return { start: null, end: null, durMs: 0 }; // all
  }

  // ---------- Ações ----------
  async function onGenerate() {
    const siloId = document.getElementById("siloSelect")?.value;
    const sensorType = document.getElementById("sensorTypeSelect")?.value;
    const compare = document.getElementById("compareToggle")?.value === "on";

    if (!siloId) {
      U.notify("warning", "Selecione um silo.");
      return;
    }

    try {
      U.notify("info", "Carregando dados...");
      const period = getPeriodSelection();
      const params = buildQueryParams(period);
      const data = await fetchHistory(siloId, sensorType, params);

      if (!Array.isArray(data) || data.length === 0) {
        showChartEmptyState(true);
        clearKPIs();
        U.notify("info", "Nenhum dado encontrado para o período selecionado.");
        return;
      }

      // (Opcional) Log de sanidade:
      // console.log('[analysis] pontos:', data.length, 'primeiro:', data[0], 'último:', data[data.length-1]);

      // dataset principal
      const mainDs = toLineDataset(data, sensorType, "Atual");

      // KPIs
      const stats = computeStats(data.map(p => p.v));
      renderKPIs(stats, sensorType);

      // comparação (janela anterior)
      const datasets = [mainDs];
      if (compare) {
        const { start, end, durMs } = normalizeWindow(period);
        if (start && end && durMs > 0) {
          const prevStart = new Date(start.getTime() - durMs);
          const prevEnd   = new Date(end.getTime()   - durMs);
          const prevParams = buildQueryParams({ range: "custom", start: prevStart, end: prevEnd });
          const prevData = await fetchHistory(siloId, sensorType, prevParams);
          if (prevData?.length) datasets.push(toLineDataset(prevData, sensorType, "Período anterior", true));
        }
      }

      hideChartEmptyState();
      renderLineChart(datasets, sensorType);
      U.notify("success", "Dados carregados com sucesso!");
    } catch (err) {
      console.error(err);
      U.notify("error", "Erro ao carregar dados.");
      showChartEmptyState(true);
      clearKPIs();
    }
  }

  async function onExportCSV() {
    const siloId = document.getElementById("siloSelect")?.value;
    const sensorType = document.getElementById("sensorTypeSelect")?.value;
    if (!siloId) { U.notify("warning", "Selecione um silo."); return; }

    const q = buildQueryParams(getPeriodSelection());
    const apiBase = (window.API_CONFIG?.baseURL || "http://localhost:4000/api");
    const url = `${apiBase}/analysis/export.csv?siloId=${encodeURIComponent(siloId)}&sensorType=${encodeURIComponent(sensorType)}${q}`;

    try {
      U.notify("info", "Gerando CSV...");
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${authManager.getToken()}` } });
      if (!resp.ok) {
        if (resp.status === 404) {
          const j = await safeJson(resp);
          U.notify("info", j?.error || "Nenhum dado para exportar.");
          return;
        }
        throw new Error(`HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `agrosilo-${sensorType}-analise.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      U.notify("success", "CSV gerado.");
    } catch (e) {
      console.error(e);
      U.notify("error", "Falha ao gerar CSV.");
    }
  }

  async function onExportPDF() {
    const siloId = document.getElementById("siloSelect")?.value;
    const sensorType = document.getElementById("sensorTypeSelect")?.value;
    if (!siloId) { U.notify("warning", "Selecione um silo."); return; }

    const q = buildQueryParams(getPeriodSelection());
    const apiBase = (window.API_CONFIG?.baseURL || "http://localhost:4000/api");
    const url = `${apiBase}/analysis/report?siloId=${encodeURIComponent(siloId)}&sensorType=${encodeURIComponent(sensorType)}${q}`;

    try {
      U.notify("info", "Gerando PDF técnico...");
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${authManager.getToken()}` } });
      if (!resp.ok) {
        if (resp.status === 404) {
          const j = await safeJson(resp);
          U.notify("info", j?.error || "Sem dados no período selecionado para gerar PDF.");
          return;
        }
        throw new Error(`HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const fileURL = URL.createObjectURL(blob);
      window.open(fileURL);
      U.notify("success", "PDF técnico gerado.");
    } catch (e) {
      console.error(e);
      U.notify("error", "Falha ao gerar PDF.");
    }
  }

  async function safeJson(resp) {
    try { return await resp.json(); } catch { return null; }
  }

  // ---------- API ----------
  function buildQueryParams(period) {
    const params = new URLSearchParams();
    if (period.range && period.range !== "custom") params.set("range", period.range);
    if (period.range === "custom") {
      const sISO = toISOIfDate(period.start);
      const eISO = toISOIfDate(period.end);
      if (sISO) params.set("start", sISO);
      if (eISO) params.set("end", eISO);
    }
    const qs = params.toString();
    return qs ? `&${qs}` : "";
  }

  async function fetchHistory(siloId, sensorType, queryString) {
    // BACK: /analysis/history/:siloId/:sensorType?range=... OU ?start=&end=
    const url = `/analysis/history/${encodeURIComponent(siloId)}/${encodeURIComponent(sensorType)}?${queryString.replace(/^&/, "")}`;
    const raw = await authManager.makeRequest(url);
    if (!Array.isArray(raw)) return [];

    // Normaliza: timestamp/value -> { x:ms, y:number } (guardamos como t/v internamente)
    // IMPORTANTE: timestamp -> milissegundos (número) para o time scale do Chart.js
    return raw
      .filter(p => p && p.timestamp && p.value != null)
      .map(p => ({
        t: new Date(p.timestamp).getTime(), // ms
        v: Number(p.value)
      }))
      .filter(p => Number.isFinite(p.v) && Number.isFinite(p.t))
      .sort((a,b) => a.t - b.t);
  }

  // ---------- KPIs ----------
  function computeStats(values) {
    const nums = (values || [])
      .map(v => Number(v))
      .filter(v => Number.isFinite(v));

    const n = nums.length;
    if (!n) return { n: 0 };

    const sorted = [...nums].sort((a,b)=>a-b);
    const sum = nums.reduce((a,b)=>a+b,0);
    const mean = sum / n;
    const median = (n % 2) ? sorted[(n-1)/2] : (sorted[n/2 - 1] + sorted[n/2]) / 2;
    const p95 = sorted[Math.min(n-1, Math.floor(0.95*(n-1)))];
    const min = sorted[0], max = sorted[n-1];
    const variance = nums.reduce((a,b)=> a + Math.pow(b-mean,2), 0) / (n > 1 ? (n-1) : 1);
    const std = Math.sqrt(variance);
    return { n, min, mean, median, p95, max, std };
  }

  function renderKPIs(stats, sensorType) {
    const unit = U.getSensorConfig(sensorType).unit;
    const safeFmt = (x) => Number.isFinite(x) ? `${x.toFixed(2)} ${unit}` : '—';

    document.getElementById("kpiMin").textContent    = stats?.n ? safeFmt(stats.min)    : '—';
    document.getElementById("kpiMean").textContent   = stats?.n ? safeFmt(stats.mean)   : '—';
    document.getElementById("kpiMedian").textContent = stats?.n ? safeFmt(stats.median) : '—';
    document.getElementById("kpiP95").textContent    = stats?.n ? safeFmt(stats.p95)    : '—';
    document.getElementById("kpiMax").textContent    = stats?.n ? safeFmt(stats.max)    : '—';
    document.getElementById("kpiStd").textContent    = stats?.n ? safeFmt(stats.std)    : '—';
  }

  function clearKPIs() {
    ["kpiMin","kpiMean","kpiMedian","kpiP95","kpiMax","kpiStd"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });
  }

  // ---------- Chart ----------
  function toLineDataset(points, sensorType, label, dashed = false) {
    const cfg = U.getSensorConfig(sensorType);
    const rgb = cfg.color; // "rgb(r,g,b)"
    const rgba = rgb.replace("rgb", "rgba").replace(")", ", 0.2)");
    return {
      label: label || `${cfg.displayName} (${cfg.unit})`,
      // p.t já está em milissegundos; o Chart.js TimeScale entende números
      data: points.map(p => ({ x: p.t, y: p.v })),
      borderColor: rgb,
      backgroundColor: rgba,
      borderWidth: 2,
      pointRadius: 0,
      fill: true,
      tension: 0.25,
      borderDash: dashed ? [6, 6] : [],
      spanGaps: true // evita "quebras" em buracos da série
    };
  }

  // ajuda a escolher o time.unit
  function unitByRange(r) {
    if (r === '24h') return 'hour';
    // 7d, 30d, all/custom -> dia
    return 'day';
  }

  function renderLineChart(datasets, sensorType) {
    const el = document.getElementById("sensorChart");
    if (!el) return;
    const ctx = el.getContext("2d");
    if (lineChart) lineChart.destroy();

    const cfg = U.getSensorConfig(sensorType);
    const currentRange = document.getElementById("dateRangeSelect")?.value || '24h';

    lineChart = new Chart(ctx, {
      type: "line",
      data: { datasets },
      options: {
        // Dizer explicitamente quais chaves usar:
        parsing: { xAxisKey: 'x', yAxisKey: 'y' },
        normalized: true, // melhora performance em grandes séries
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            type: "time",
            time: {
              unit: unitByRange(currentRange),
              tooltipFormat: "dd/MM/yyyy HH:mm:ss"
            },
            title: { display: true, text: "Data/Hora" }
          },
          y: {
            title: { display: true, text: `${cfg.displayName} (${cfg.unit})` },
            ticks: { precision: 2 }
          }
        },
        plugins: {
          // Reduz pontos automaticamente em janelas longas preservando picos/vales
          decimation: { enabled: true, algorithm: 'min-max' },
          legend: { position: "top" },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const y = typeof ctx.parsed.y === "number" ? ctx.parsed.y.toFixed(2) : ctx.parsed.y;
                return `${ctx.dataset.label}: ${y} ${cfg.unit}`;
              }
            }
          }
        },
        elements: { point: { radius: 0 } }
      }
    });
  }

  // ---------- Empty state ----------
  function showChartEmptyState(on) {
    const c = document.getElementById("sensorChart");
    const e = document.getElementById("chartEmptyState");
    if (c) c.style.display = on ? "none" : "block";
    if (e) e.style.display = on ? "flex" : "none";
  }
  function hideChartEmptyState() { showChartEmptyState(false); }

})();
