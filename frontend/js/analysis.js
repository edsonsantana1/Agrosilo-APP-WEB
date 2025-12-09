/**
 * analysis.js
 *
 * - Série temporal + KPIs
 * - Comparativo mensal multi-ano
 * - Previsão PySpark (histórico+futuro e real x previsto)
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
  let monthlyChart = null;
  let forecastHistChart = null;
  let forecastTestChart = null;

  // NOVO: guarda a última série bruta carregada na Série Temporal
  // (cada ponto: { t: timestampMs, v: valor })
  let lastHistorySeries = [];

  // ---------- Boot ----------
  document.addEventListener("DOMContentLoaded", () => {
  if (!requireAuth()) return;
  setupUserInterface();
  loadSilos();
  // loadAlertsCard();   // Análise não usa card de alertas 24h
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

    // ---------- Título dinâmico da Série Temporal ----------
    const seriesTitleEl = document.getElementById("seriesTitle");

    const sensorTitleMap = {
      temperature: "Série Temporal de Temperatura",
      humidity: "Série Temporal de Umidade",
      pressure: "Série Temporal de Pressão Atmosférica",
      co2: "Série Temporal de Gás CO₂"
    };

    function updateSeriesTitle() {
      const type = document.getElementById("sensorTypeSelect")?.value || "temperature";
      
      if (!seriesTitleEl) return; // <-- evita erro se não achar o elemento
      seriesTitleEl.textContent = sensorTitleMap[type] || "Série Temporal";
    }



  // ---------- UI ----------
  function wireUI() {
    const rangeSel = document.getElementById("dateRangeSelect");
        // Atualizar título quando trocar tipo de sensor
    const sensorSel = document.getElementById("sensorTypeSelect");
    sensorSel.addEventListener("change", updateSeriesTitle);
    const customDates = document.getElementById("customDates");
    rangeSel.addEventListener("change", () => {
      if (!customDates) return;
      customDates.style.display = rangeSel.value === "custom" ? "block" : "none";
    });

    document.getElementById("btnGenerate")?.addEventListener("click", onGenerate);
    document.getElementById("btnCSV")?.addEventListener("click", onExportCSV);
    document.getElementById("btnPDF")?.addEventListener("click", onExportPDF);

    // Comparativo multi-ano
    document.getElementById("btnYearly")?.addEventListener("click", loadMonthlyComparison);

    // Previsão PySpark
    document.getElementById("btnForecast")?.addEventListener("click", onForecast);

    // NOVO: filtro de ano para Série Temporal
    const yearSel = document.getElementById("yearSelect");
    if (yearSel) {
      yearSel.addEventListener("change", () => {
        if (!lastHistorySeries || !lastHistorySeries.length) return;
        const sensorType = document.getElementById("sensorTypeSelect")?.value || "temperature";

        // Filtra série pelo ano selecionado
        const filtered = filterSeriesBySelectedYear(lastHistorySeries);

        // KPIs apenas para o ano filtrado
        const stats = computeStats(filtered.map(p => p.v));
        renderKPIs(stats, sensorType);

        // Um dataset por mês (cores diferentes)
        const datasets = buildMonthlyDatasets(filtered, sensorType);
        hideChartEmptyState();
        renderLineChart(datasets, sensorType);
      });
    }
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


  // ======================== CARD DE ALERTAS 24H ========================

  async function loadAlertsCard() {
    try {
      // Chama o backend FastAPI via proxy Node (authManager já usa /api)
      const payload = await authManager.makeRequest("/analysis/alerts/24h");

      if (!payload || payload.ok === false) {
        console.warn("Resposta inválida para /analysis/alerts/24h:", payload);
        return;
      }

      const totalEl = document.getElementById("alertTotal");
      const attEl   = document.getElementById("alertAttention");
      const criEl   = document.getElementById("alertCritical");

      if (totalEl) totalEl.textContent = payload.total ?? 0;
      if (attEl)   attEl.textContent   = payload.attention ?? 0;
      if (criEl)   criEl.textContent   = payload.critical ?? 0;
    } catch (err) {
      console.error("Erro ao carregar card de alertas:", err);
      U.notify("error", "Falha ao carregar indicadores de alerta das últimas 24h.");
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

  // ---------- Série temporal ----------
  async function onGenerate() {
    const siloId = document.getElementById("siloSelect")?.value;
    const sensorType = document.getElementById("sensorTypeSelect")?.value;
    const compare = document.getElementById("compareToggle")?.value === "on";

    // Atualiza o título de acordo com o tipo de sensor escolhido
    updateSeriesTitle();


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

      // Guarda série bruta para reuso no filtro de ano
      lastHistorySeries = data.slice();

      // Se o período for "Todo o período" (all), aplicamos a visão por ano/mês
      if ((period.range || "24h") === "all") {
        // Preenche select de ano com base em todos os dados
        populateYearSelectFromData(lastHistorySeries);

        // Filtra para o ano selecionado (por padrão, ano atual)
        const filtered = filterSeriesBySelectedYear(lastHistorySeries);

        // KPIs do ano filtrado
        const stats = computeStats(filtered.map(p => p.v));
        renderKPIs(stats, sensorType);

        // Um dataset por mês, cada um com sua cor
        const datasets = buildMonthlyDatasets(filtered, sensorType);

        hideChartEmptyState();
        renderLineChart(datasets, sensorType);
        U.notify("success", "Dados carregados com sucesso!");
        return;
      }

      // Demais períodos (24h, 7d, 30d, custom) usam o comportamento antigo
      const mainDs = toLineDataset(data, sensorType, "Atual");
      const stats = computeStats(data.map(p => p.v));
      renderKPIs(stats, sensorType);

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
    const url = `${apiBase}/analysis/export.csv?siloId=${encodeURIComponent(siloId)}&type=${encodeURIComponent(sensorType)}${q}`;

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
    const url = `${apiBase}/analysis/report?siloId=${encodeURIComponent(siloId)}&type=${encodeURIComponent(sensorType)}${q}`;

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
    const url = `/analysis/history/${encodeURIComponent(siloId)}/${encodeURIComponent(sensorType)}?${queryString.replace(/^&/, "")}`;
    const raw = await authManager.makeRequest(url);
    if (!Array.isArray(raw)) return [];

    return raw
      .filter(p => p && p.timestamp && p.value != null)
      .map(p => ({
        t: new Date(p.timestamp).getTime(),
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

  // ---------- Chart série temporal ----------

  // Cores para cada mês (Jan..Dez)
  const MONTH_COLORS = [
    "rgb(255, 99, 132)",   // Jan
    "rgb(54, 162, 235)",   // Fev
    "rgb(255, 206, 86)",   // Mar
    "rgb(75, 192, 192)",   // Abr
    "rgb(153, 102, 255)",  // Mai
    "rgb(255, 159, 64)",   // Jun
    "rgb(201, 203, 207)",  // Jul
    "rgb(255, 99, 71)",    // Ago
    "rgb(46, 139, 87)",    // Set
    "rgb(123, 104, 238)",  // Out
    "rgb(210, 105, 30)",   // Nov
    "rgb(32, 178, 170)"    // Dez
  ];

  const MONTH_NAMES = [
    "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
    "Jul", "Ago", "Set", "Out", "Nov", "Dez"
  ];

  function toLineDataset(points, sensorType, label, dashed = false) {
    const cfg = U.getSensorConfig(sensorType);
    const rgb = cfg.color;
    const rgba = rgb.replace("rgb", "rgba").replace(")", ", 0.2)");
    return {
      label: label || `${cfg.displayName} (${cfg.unit})`,
      data: points.map(p => ({ x: p.t, y: p.v })),
      borderColor: rgb,
      backgroundColor: rgba,
      borderWidth: 2,
      pointRadius: 0,
      fill: true,
      tension: 0.25,
      borderDash: dashed ? [6, 6] : [],
      spanGaps: true
    };
  }

  // Agrupa pontos por ano
  function groupByYear(points) {
    const map = new Map(); // year -> array de pontos
    points.forEach(p => {
      const year = new Date(p.t).getFullYear();
      if (!map.has(year)) map.set(year, []);
      map.get(year).push(p);
    });
    return map;
  }

  // Preenche o select de ano com base nos dados disponíveis
  function populateYearSelectFromData(points) {
    const yearSel = document.getElementById("yearSelect");
    if (!yearSel) return;

    const yearMap = groupByYear(points);
    const years = Array.from(yearMap.keys()).sort((a, b) => a - b);
    const currentYear = new Date().getFullYear();

    yearSel.innerHTML = "";
    years.forEach(y => {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = (y === currentYear) ? `${y} (atual)` : String(y);
      yearSel.appendChild(opt);
    });

    if (years.includes(currentYear)) {
      yearSel.value = String(currentYear);
    } else if (years.length) {
      yearSel.value = String(years[years.length - 1]);
    }
  }

  // Filtra a série para o ano escolhido
  function filterSeriesBySelectedYear(points) {
    const yearSel = document.getElementById("yearSelect");
    if (!yearSel || !yearSel.value) return points;

    const targetYear = Number(yearSel.value);
    if (!Number.isFinite(targetYear)) return points;

    return points.filter(p => new Date(p.t).getFullYear() === targetYear);
  }

  // Cria um dataset por mês para o ano filtrado
  function buildMonthlyDatasets(points, sensorType) {
    const monthMap = new Map(); // monthIndex -> pontos
    points.forEach(p => {
      const d = new Date(p.t);
      const m = d.getMonth(); // 0..11
      if (!monthMap.has(m)) monthMap.set(m, []);
      monthMap.get(m).push(p);
    });

    const datasets = [];
    Array.from(monthMap.entries())
      .sort((a, b) => a[0] - b[0])
      .forEach(([m, pts]) => {
        const baseColor = MONTH_COLORS[m % MONTH_COLORS.length];
        const ds = toLineDataset(pts, sensorType, MONTH_NAMES[m]);
        ds.borderColor = baseColor;
        ds.backgroundColor = baseColor.replace("rgb", "rgba").replace(")", ", 0.2)");
        ds.fill = false; // apenas linha
        datasets.push(ds);
      });

    return datasets;
  }

  function unitByRange(r) {
    if (r === '24h') return 'hour';
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
        parsing: { xAxisKey: 'x', yAxisKey: 'y' },
        normalized: true,
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

  // =====================================================================
  // ===================== COMPARATIVO MENSAL MULTI-ANO ==================
  // =====================================================================

  const YEAR_COLORS = [
    "rgb(54, 162, 235)",
    "rgb(255, 99, 132)",
    "rgb(255, 159, 64)",
    "rgb(75, 192, 192)",
    "rgb(153, 102, 255)",
    "rgb(201, 203, 207)"
  ];

  async function fetchMonthlySeries(siloId, sensorType, yearsCSV = null, last = 3, startISO = null, endISO = null) {
    const params = new URLSearchParams({ siloId, type: sensorType });
    if (yearsCSV) params.set("years", yearsCSV);
    else params.set("last", String(last));
    if (startISO) params.set("start", startISO);
    if (endISO) params.set("end", endISO);

    return authManager.makeRequest(`/analysis/monthly?${params.toString()}`);
  }

  function renderMonthlyTable(payload) {
    const thead = document.getElementById("monthlyTableHead");
    const tbody = document.getElementById("monthlyTableBody");
    if (!thead || !tbody) return;

    const years = payload.years || [];
    thead.innerHTML = `
      <tr>
        <th style="text-align:left;padding:6px;border-bottom:1px solid #ddd;">Mês</th>
        ${years.map(y => `<th style="text-align:right;padding:6px;border-bottom:1px solid #ddd;">${y}</th>`).join("")}
      </tr>
    `;

    tbody.innerHTML = (payload.table || []).map(row => {
      const cols = years.map(y => {
        const v = row[String(y)];
        return `<td style="text-align:right;padding:6px;border-bottom:1px solid #f0f0f0;">${(v==null)? "—" : v.toFixed(2)}</td>`;
      }).join("");
      return `
        <tr>
          <td style="text-align:left;padding:6px;border-bottom:1px solid #f0f0f0;">${row.month}</td>
          ${cols}
        </tr>
      `;
    }).join("");
  }

  function renderMonthlyChart(payload) {
    const el = document.getElementById("monthlyChart");
    if (!el) return;
    const ctx = el.getContext("2d");
    if (monthlyChart) monthlyChart.destroy();

    const labels = payload.months || ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

    const datasets = (payload.series || []).map((s, idx) => {
      const color = YEAR_COLORS[idx % YEAR_COLORS.length];
      return {
        label: String(s.year),
        data: (s.values || []).map(v => (v == null ? null : Number(v))),
        borderColor: color,
        backgroundColor: color.replace("rgb", "rgba").replace(")", ", 0.15)"),
        borderWidth: 2,
        spanGaps: true,
        tension: 0.25,
        pointRadius: 0,
        fill: true
      };
    });

    monthlyChart = new Chart(ctx, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { title: { display: true, text: "Mês" } },
          y: { title: { display: true, text: `${(payload.sensorType||"valor")}` } }
        },
        plugins: {
          legend: { position: "top" },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const y = ctx.parsed.y;
                return `${ctx.dataset.label}: ${Number.isFinite(y) ? y.toFixed(2) : "—"}`;
              }
            }
          }
        },
        elements: { point: { radius: 0 } }
      }
    });
  }

  async function loadMonthlyComparison() {
    const siloId = document.getElementById("siloSelect")?.value;
    const sensorType = document.getElementById("sensorTypeSelect")?.value || "temperature";
    if (!siloId) { U.notify("warning", "Selecione um silo."); return; }

    try {
      U.notify("info", "Carregando comparativo mensal por ano...");
      const payload = await fetchMonthlySeries(siloId, sensorType, null, 3);
      if (!payload?.years?.length) {
        U.notify("info", "Sem dados para montar o comparativo.");
        return;
      }
      renderMonthlyTable(payload);
      renderMonthlyChart(payload);
      U.notify("success", "Comparativo carregado!");
    } catch (e) {
      console.error(e);
      U.notify("error", "Falha ao carregar o comparativo mensal.");
    }
  }

  // =====================================================================
  // ====================== PREVISÃO PYSPARK (NOVO) ======================
  // =====================================================================

  /**
   * Dispara a previsão no backend.
   * Agora suporta qualquer tipo de sensor que o backend aceite:
   *  - temperature
   *  - humidity
   *  - (outros, se você quiser no futuro)
   *
   * A diferença para a versão antiga é:
   *  - NÃO força mais o sensor para 'temperature'
   *  - Envia o tipo de sensor via query string: ?type=temperature|humidity
   */
    async function onForecast() {
    const siloId = document.getElementById("siloSelect")?.value;
    const sensorType = document.getElementById("sensorTypeSelect")?.value || "temperature";

    if (!siloId) {
      U.notify("warning", "Selecione um silo para rodar a previsão.");
      return;
    }

    try {
      U.notify("info", "Executando modelo PySpark (pode levar alguns segundos)...");

      // >>> Agora envia o tipo de sensor para o backend
      const payload = await authManager.makeRequest(
        `/analysis/forecast/${encodeURIComponent(siloId)}?type=${encodeURIComponent(sensorType)}`
      );

      if (!payload || !payload.ok) {
        U.notify("error", payload?.message || "Falha ao rodar previsão.");
        return;
      }

      // Renderiza cartões e gráficos usando o tipo retornado
      renderForecastCards(payload);
      renderForecastHistoryChart(payload);
      renderForecastTestChart(payload);

      U.notify("success", "Previsão gerada com sucesso!");
    } catch (e) {
      console.error(e);
      U.notify("error", "Erro ao executar previsões (PySpark).");
    }
  }


  /**
   * Preenche os cards de resumo da previsão.
   * Agora funciona tanto para TEMPERATURA quanto para UMIDADE.
   */
    function renderForecastCards(data) {
    const ins = data.insights || {};
    const met = data.metrics || {};
    const sensorType = (data.sensor_type || "temperature");

    // Pega unidade certa a partir do tipo de sensor
    const cfg = U.getSensorConfig(sensorType);
    const unit = cfg.unit || "";

    // Usa campos genéricos, com fallback pros específicos
    const last = Number(
      ins.last_value ??
      (sensorType === "temperature" ? ins.last_temperature : ins.last_humidity)
    );
    const mean = Number(
      ins.mean_value ??
      (sensorType === "temperature" ? ins.mean_temperature : ins.mean_humidity)
    );
    const vmin = Number(
      ins.min_value ??
      (sensorType === "temperature" ? ins.min_temperature : ins.min_humidity)
    );
    const vmax = Number(
      ins.max_value ??
      (sensorType === "temperature" ? ins.max_temperature : ins.max_humidity)
    );

    // Explica a correlação temperatura x umidade em texto humano
    function formatCorrelationText(corr) {
      if (corr == null || !Number.isFinite(corr)) {
        return "Sem correlação calculada para o período selecionado.";
      }

      const abs = Math.abs(corr);
      let intensidade;
      if (abs < 0.2)      intensidade = "muito fraca";
      else if (abs < 0.4) intensidade = "fraca";
      else if (abs < 0.7) intensidade = "moderada";
      else if (abs < 0.9) intensidade = "forte";
      else                intensidade = "muito forte";

      const sentido = corr > 0
        ? "positiva (quando a temperatura sobe, a umidade tende a subir também)"
        : "negativa (quando a temperatura sobe, a umidade tende a cair)";

      // Ex.: "0.37 – Correlação fraca, positiva (quando a temperatura sobe...)"
      return `${corr.toFixed(2)} – Correlação ${intensidade}, ${sentido}.`;
    }


    const rmse = Number(met.rmse);
    const r2   = Number(met.r2);
    const corr = (ins.temp_humi_correlation != null) ? Number(ins.temp_humi_correlation) : null;

    const fmtVal = (v) => Number.isFinite(v) ? `${v.toFixed(2)} ${unit}` : "—";

    const elLast  = document.getElementById("fcLastTemp");
    const elMean  = document.getElementById("fcMeanTemp");
    const elMM    = document.getElementById("fcMinMaxTemp");
    const elMet   = document.getElementById("fcMetrics");
    const elTrend = document.getElementById("fcTrend");
    const elCorr  = document.getElementById("fcCorr");

    if (elLast)  elLast.textContent  = fmtVal(last);
    if (elMean)  elMean.textContent  = fmtVal(mean);
    if (elMM)    elMM.textContent    = (Number.isFinite(vmin) && Number.isFinite(vmax))
      ? `${vmin.toFixed(2)} / ${vmax.toFixed(2)} ${unit}`
      : "—";
    if (elMet)   elMet.textContent   = (Number.isFinite(rmse) || Number.isFinite(r2))
      ? `RMSE: ${Number.isFinite(rmse)?rmse.toFixed(2):"—"} | R²: ${Number.isFinite(r2)?r2.toFixed(3):"—"}`
      : "—";
    if (elTrend) elTrend.textContent = ins.trend || "—";
    if (elCorr) {
      elCorr.textContent = formatCorrelationText(corr);
    }

  }


    /**
   * Gráfico combinado HISTÓRICO + FUTURO.
   * Agora respeita o tipo de sensor retornado pelo backend.
   */
    function renderForecastHistoryChart(payload) {
    const el = document.getElementById("forecastHistoryChart");
    if (!el) return;
    const ctx = el.getContext("2d");
    if (forecastHistChart) forecastHistChart.destroy();

    const sensorType = payload.sensor_type || "temperature";
    const cfg = U.getSensorConfig(sensorType);   // <<< unidade correta

    const histLabels = payload.history?.labels || [];
    const histValues = (payload.history?.values || []).map(v => Number(v));

    const future = payload.future_forecast || [];
    const futureLabels = future.map(p => p.date_label || p.date_iso || `+${p.step}`);
    const futureValues = future.map(p => Number(p.prediction));

    const labels = [...histLabels, ...futureLabels];

    const histData   = [...histValues, ...new Array(futureValues.length).fill(null)];
    const futureData = [...new Array(histValues.length).fill(null), ...futureValues];

    forecastHistChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Histórico",
            data: histData,
            borderColor: cfg.color,
            backgroundColor: cfg.color.replace("rgb", "rgba").replace(")", ", 0.15)"),
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25,
            fill: true,
            spanGaps: true
          },
          {
            label: "Previsão (próximos pontos)",
            data: futureData,
            borderColor: "rgb(54, 162, 235)",
            backgroundColor: "rgba(54, 162, 235, 0.15)",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25,
            fill: true,
            borderDash: [6, 6],
            spanGaps: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { title: { display: true, text: "Tempo (histórico + futuro)" } },
          y: { title: { display: true, text: `${cfg.displayName} (${cfg.unit})` } }
        },
        plugins: {
          legend: { position: "top" },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const y = ctx.parsed.y;
                return `${ctx.dataset.label}: ${Number.isFinite(y)?y.toFixed(2):"—"} ${cfg.unit}`;
              }
            }
          }
        },
        elements: { point: { radius: 0 } }
      }
    });
  }

  function renderForecastTestChart(payload) {
    const el = document.getElementById("forecastTestChart");
    if (!el) return;
    const ctx = el.getContext("2d");
    if (forecastTestChart) forecastTestChart.destroy();

    const sensorType = payload.sensor_type || "temperature";
    const cfg = U.getSensorConfig(sensorType);

    const labels = payload.test_predictions?.labels || [];
    const real   = (payload.test_predictions?.real || []).map(v => Number(v));
    const pred   = (payload.test_predictions?.predicted || []).map(v => Number(v));

    forecastTestChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Real (teste)",
            data: real,
            borderColor: cfg.color,
            backgroundColor: cfg.color.replace("rgb", "rgba").replace(")", ", 0.15)"),
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25,
            fill: false
          },
          {
            label: "Previsto",
            data: pred,
            borderColor: "rgb(54, 162, 235)",
            backgroundColor: "rgba(54, 162, 235, 0.15)",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25,
            fill: false,
            borderDash: [6, 6]
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { title: { display: true, text: "Tempo (conjunto de teste)" } },
          y: { title: { display: true, text: `${cfg.displayName} (${cfg.unit})` } }
        },
        plugins: {
          legend: { position: "top" },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const y = ctx.parsed.y;
                return `${ctx.dataset.label}: ${Number.isFinite(y)?y.toFixed(2):"—"} ${cfg.unit}`;
              }
            }
          }
        },
        elements: { point: { radius: 0 } }
      }
    });
  }


})();
