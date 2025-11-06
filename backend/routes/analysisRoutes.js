// backend/routes/analysisRoutes.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const mongoose = require('mongoose');

const Silo = require('../models/silo');
const Sensor = require('../models/sensor');

// ---------- Reading (time-series) com detecção robusta ----------
let Reading = null;
(function resolveReadingModel() {
  try {
    const mod = require('../models/reading');
    // Possíveis formas de export:
    // module.exports = ReadingModel
    // module.exports.Reading = ReadingModel
    // export default ReadingModel (transpilado)
    if (mod && typeof mod.find === 'function' && mod.modelName) {
      Reading = mod;
    } else if (mod?.Reading && typeof mod.Reading.find === 'function') {
      Reading = mod.Reading;
    } else if (mod?.default && typeof mod.default.find === 'function') {
      Reading = mod.default;
    }
  } catch (_) { /* ignora */ }

  // Último recurso: já registrado no mongoose?
  if (!Reading && mongoose.models?.Reading) {
    Reading = mongoose.models.Reading;
  }
})();

// ---------- Limites técnicos com fallback seguro ----------
let SAFETY_PARAMETERS = {
  humidity: { acceptable: 14, safe: 13, insect_limit: 10, fungus_risk: 16 },
  temperature: {
    slow_fungus: 15,
    medium_growth_min: 20, medium_growth_max: 30,
    high_risk_min: 40,     high_risk_max: 55
  }
};
try {
  const svc = require('../services/alertService');
  if (svc?.SAFETY_PARAMETERS) SAFETY_PARAMETERS = svc.SAFETY_PARAMETERS;
} catch { /* usa fallback */ }

// ==============================
// ====== Helpers genéricos =====
// ==============================
const fmtBRDateTime = (d) =>
  new Intl.DateTimeFormat('pt-BR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(d));

function parseISOOrNull(s) { if (!s) return null; const d = new Date(s); return Number.isNaN(+d) ? null : d; }
function clampLimit(v, def = 5000, max = 20000){ const n=Number(v); if(!Number.isFinite(n)||n<=0) return def; return Math.min(n,max); }
function addShortCache(res){ res.setHeader('Cache-Control','private, max-age=15, must-revalidate'); }

// ==============================
// ====== Domínio / Regras  =====
// ==============================
const SENSOR_LABEL = (t) => ({ temperature:'Temperatura', humidity:'Umidade', pressure:'Pressão Atmosférica', co2:'Gás CO2' }[t] || t);
const SENSOR_UNIT  = (t) => ({ temperature:'°C', humidity:'%', pressure:'hPa', co2:'ppm' }[t] || '');

function basicStats(values){
  const n = values.length || 0;
  if (!n) return { n:0, min:0, median:0, mean:0, p95:0, max:0, stddev:0 };
  const sorted = [...values].sort((a,b)=>a-b);
  const sum = values.reduce((a,b)=>a+b,0);
  const mean = sum/n;
  const median = (n%2) ? sorted[(n-1)/2] : (sorted[n/2-1]+sorted[n/2])/2;
  const p95 = sorted[Math.min(n-1, Math.floor(0.95*(n-1)))];
  const min = sorted[0], max = sorted[n-1];
  const variance = values.reduce((a,b)=>a+Math.pow(b-mean,2),0)/(n>1?(n-1):1);
  return { n, min, median, mean, p95, max, stddev: Math.sqrt(variance) };
}

function getRangeStart(range){
  const now=new Date(); const r=String(range||'24h').toLowerCase();
  if (r==='24h'){ const d=new Date(now); d.setHours(d.getHours()-24); return d; }
  if (r==='7d' ){ const d=new Date(now); d.setDate(d.getDate()-7); return d; }
  if (r==='30d'){ const d=new Date(now); d.setDate(d.getDate()-30); return d; }
  return null; // all
}

function resolvePeriod({ range, start, end }){
  const s = parseISOOrNull(start), e = parseISOOrNull(end);
  if (s && e && s <= e) return { start:s, end:e, label:`${fmtBRDateTime(s)} → ${fmtBRDateTime(e)}` };
  const rs = getRangeStart(range);
  return { start: rs, end: null, label: rs ? `${fmtBRDateTime(rs)} → ${fmtBRDateTime(new Date())}` : 'Todo o período' };
}

function complianceByBands(sensorType, points){
  if (points.length < 2) return { normal:0, caution:0, warning:0, critical:0 };
  let bands;
  if (sensorType==='humidity'){
    const p=SAFETY_PARAMETERS.humidity;
    bands = v => v<=p.safe ? 'normal' : (v<=p.acceptable ? 'caution' : (v<=p.fungus_risk ? 'warning' : 'critical'));
  } else if (sensorType==='temperature'){
    const p=SAFETY_PARAMETERS.temperature;
    bands = v => {
      if (v>=p.high_risk_min && v<=p.high_risk_max) return 'critical';
      if (v> p.high_risk_max) return 'critical';
      if (v>=p.medium_growth_min && v<=p.medium_growth_max) return 'warning';
      return 'normal';
    };
  } else {
    bands = () => 'normal';
  }
  const acc={normal:0,caution:0,warning:0,critical:0};
  for (let i=1;i<points.length;i++){
    const dt = new Date(points[i].timestamp) - new Date(points[i-1].timestamp);
    acc[bands(points[i-1].value)] += Math.max(0, dt);
  }
  return acc;
}

const msToHHMM = (ms) => {
  const h = Math.floor(ms/3600000);
  const m = Math.round((ms%3600000)/60000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
};

// ===============
// = Validação  =
// ===============
function assertSensorType(t){
  const allowed=['temperature','humidity','pressure','co2'];
  if (!allowed.includes(String(t))) { const e=new Error(`sensorType inválido. Use: ${allowed.join(', ')}`); e.status=400; throw e; }
}
async function ensureSiloOwnership(siloId, userId){
  const silo = await Silo.findOne({_id:siloId, user:userId}).select('_id name').lean();
  if (!silo){ const e=new Error('Silo não encontrado'); e.status=404; throw e; }
  return silo;
}

// ------------- Coleta: embedado + time-series (Model OU driver) -------------
async function collectFromTimeSeries({ ids, start, end, hardLimit }) {
  // Se houver Model válido, usa .find; senão tenta driver nativo.
  if (Reading && typeof Reading.find === 'function') {
    const match = { sensor: { $in: ids } };
    if (start) match.ts = Object.assign({}, match.ts, { $gte: start });
    if (end)   match.ts = Object.assign({}, match.ts, { $lte: end });
    const rows = await Reading.find(match, { _id:0, ts:1, value:1, sensor:1 })
      .sort({ ts: 1 })
      .limit(hardLimit)
      .lean();
    return rows.map(r => ({ timestamp:new Date(r.ts), value:Number(r.value), sensorId:r.sensor }));
  }

  // Sem Model: usa conexão nativa
  if (mongoose.connection?.db) {
    const coll = mongoose.connection.db.collection('readings'); // nome da coleção
    const match = { sensor: { $in: ids } };
    if (start) match.ts = Object.assign({}, match.ts, { $gte: start });
    if (end)   match.ts = Object.assign({}, match.ts, { $lte: end });
    const cursor = coll
      .find(match, { projection: { _id:0, ts:1, value:1, sensor:1 } })
      .sort({ ts: 1 })
      .limit(hardLimit);
    const rows = await cursor.toArray();
    return rows.map(r => ({ timestamp:new Date(r.ts), value:Number(r.value), sensorId:r.sensor }));
  }

  return [];
}

async function collectPoints({ sensors, start, end, hardLimit }){
  let points = [];

  // 1) embedado
  for (const s of sensors){
    const arr = Array.isArray(s.data) ? s.data : [];
    for (const p of arr){
      if (!p || p.value==null || !p.timestamp) continue;
      const ts = new Date(p.timestamp);
      if (start && ts < start) continue;
      if (end   && ts > end)   continue;
      points.push({ timestamp: ts, value: Number(p.value), sensorId: s._id });
    }
  }

  // 2) time-series (Model ou driver) — apenas se embedado vier vazio
  if (points.length === 0) {
    const ids = sensors.map(s => s._id);
    if (ids.length) {
      points = await collectFromTimeSeries({ ids, start, end, hardLimit });
    }
  }

  points.sort((a,b)=>a.timestamp-b.timestamp);
  if (points.length > hardLimit) points = points.slice(-hardLimit);
  return points;
}

// ==============================
// ========= Endpoints =========
// ==============================

// Lista de silos
router.get('/silos', async (req,res)=>{
  try{
    const silos = await Silo.find({ user:req.user._id }).select('_id name').lean();
    res.json(silos);
  }catch(err){
    console.error('[analysis/silos] erro:', err);
    res.status(500).json({ error: 'Erro ao carregar silos' });
  }
});

// Histórico (Chart.js)
router.get('/history/:siloId/:sensorType', async (req,res)=>{
  try{
    const { siloId, sensorType } = req.params;
    const { range='24h', start, end, limit } = req.query;

    assertSensorType(sensorType);
    await ensureSiloOwnership(siloId, req.user._id);

    const { start:s, end:e } = resolvePeriod({ range, start, end });
    const hardLimit = clampLimit(limit, 5000, 20000);

    const sensors = await Sensor.find({ silo:siloId, type:sensorType }).select('_id data').lean();
    if (!sensors?.length) return res.json([]);

    const points = await collectPoints({ sensors, start:s, end:e, hardLimit });
    res.json(points);
  }catch(err){
    console.error('[analysis/history] erro:', err);
    res.status(err.status||500).json({ error: err.message || 'Erro ao carregar histórico' });
  }
});

// Export CSV
router.get('/export.csv', async (req,res)=>{
  try{
    const { siloId, sensorType, range='24h', start, end, limit } = req.query;

    if (!siloId){ const e=new Error('siloId é obrigatório'); e.status=400; throw e; }
    assertSensorType(sensorType);
    await ensureSiloOwnership(siloId, req.user._id);

    const { start:s, end:e } = resolvePeriod({ range, start, end });
    const hardLimit = clampLimit(limit, 20000, 20000);

    const sensors = await Sensor.find({ silo:siloId, type:sensorType }).select('_id data').lean();
    const points = sensors?.length ? await collectPoints({ sensors, start:s, end:e, hardLimit }) : [];

    addShortCache(res);
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="agrosilo-analise.csv"');

    res.write('timestamp,value,sensorId\n');
    for (const p of points) res.write(`${p.timestamp.toISOString()},${p.value},${p.sensorId}\n`);
    res.end();
  }catch(err){
    console.error('[analysis/export.csv] erro:', err);
    res.status(err.status||500).json({ error: err.message || 'Falha ao gerar CSV' });
  }
});

// PDF técnico
router.get('/report', async (req,res)=>{
  try{
    const { siloId, sensorType, range='24h', start, end, limit, logoPath } = req.query;
    if (!siloId || !sensorType) return res.status(400).json({ error:'Parâmetros siloId e sensorType são obrigatórios' });
    assertSensorType(sensorType);
    const silo = await ensureSiloOwnership(siloId, req.user._id);

    const { start:s, end:e, label:periodLabel } = resolvePeriod({ range, start, end });
    const hardLimit = clampLimit(limit, 5000, 20000);

    const sensors = await Sensor.find({ silo:siloId, type:sensorType }).select('_id data type').lean();
    if (!sensors?.length) return res.status(404).json({ error:'Nenhum sensor para este tipo' });

    const points = await collectPoints({ sensors, start:s, end:e, hardLimit });
    if (!points.length) return res.status(404).json({ error:'Sem dados no período selecionado' });

    const values = points.map(p=>p.value);
    const stats  = basicStats(values);
    const last   = points[points.length-1];

    // delta 24h
    const t24 = new Date(last.timestamp); t24.setHours(t24.getHours()-24);
    const pivot = points.find(p=>p.timestamp>=t24) || points[0];
    const delta24 = last.value - pivot.value;

    addShortCache(res);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`inline; filename="agrosilo-relatorio-${Date.now()}.pdf"`);

    const doc = new PDFDocument({ size:'A4', margins:{ top:50, bottom:50, left:50, right:50 } });
    doc.pipe(res);

    const L = doc.page.margins.left, R = doc.page.margins.right, W = doc.page.width - L - R;

    const titleLeft = (txt)=>{ doc.fontSize(14).fillColor('#0c4a2e').text(txt,L,doc.y,{ underline:true, width:W }); doc.moveDown(0.5); doc.x=L; };

    // Cabeçalho
    (function drawHeader(){
      const LOGO_W=90, TITLE_Y=40, LOGO_Y=32; let hasLogo=false;
      function resolveLogoPath(){
        const c=[]; if (logoPath) c.push(path.resolve(logoPath));
        c.push(path.join(__dirname,'..','assets','logo.png'));
        c.push(path.join(process.cwd(),'backend','assets','logo.png'));
        c.push(path.join(process.cwd(),'assets','logo.png'));
        for (const p of c){ try{ if(fs.existsSync(p)) return p; } catch{} }
        return null;
      }
      const file = resolveLogoPath();
      if (file){
        try{ const buf=fs.readFileSync(file); const x=doc.page.width - R - LOGO_W; doc.image(buf,x,LOGO_Y,{ width:LOGO_W }); hasLogo=true; } catch {}
      }
      const titleWidth = hasLogo ? (W-LOGO_W-12) : W;
      doc.fillColor('#0c4a2e').fontSize(20).text('Relatório Técnico - Agrosilo', L, TITLE_Y, { width:titleWidth, align:'left' });
      doc.moveDown(1.2);
      doc.fillColor('#111').fontSize(12)
        .text(`Silo: ${silo.name}`, L, doc.y)
        .text(`Sensor: ${SENSOR_LABEL(sensorType)} (${sensorType})`, L, doc.y)
        .text(`Período: ${periodLabel}`, L, doc.y)
        .text(`Amostras: ${stats.n}`, L, doc.y)
        .text(`Gerado em: ${fmtBRDateTime(new Date())}`, L, doc.y)
        .moveDown(0.8);
    })();

    // Cards
    const startY=doc.y, cardW=250, cardH=66, gap=15, x1=L, x2=L+cardW+gap, unit=SENSOR_UNIT(sensorType);
    function card(x,y,title,value,color='#1f2937'){ doc.roundedRect(x,y,cardW,cardH,8).strokeColor('#e5e7eb').lineWidth(1).stroke(); doc.fillColor('#6b7280').fontSize(10).text(title,x+12,y+10); doc.fillColor(color).fontSize(18).text(value,x+12,y+30); doc.fillColor('#111'); }
    card(x1,startY,'Valor atual',`${last.value.toFixed(2)} ${unit}`,'#0ea5e9');
    card(x2,startY,'Variação 24h',`${delta24>=0?'+':''}${delta24.toFixed(2)} ${unit}`, delta24>=0?'#ef4444':'#22c55e');
    card(x1,startY+cardH+gap,'Mediana (p50)',`${stats.median.toFixed(2)} ${unit}`);
    card(x2,startY+cardH+gap,'p95',`${stats.p95.toFixed(2)} ${unit}`);
    doc.y = Math.max(doc.y, startY + (cardH*2 + gap) + 12);

    // 1. Estatísticas
    titleLeft('1. Estatísticas Descritivas');
    doc.fontSize(11).fillColor('#111')
      .text(`Mínimo:   ${stats.min.toFixed(2)} ${unit}`, L, doc.y)
      .text(`Média:    ${stats.mean.toFixed(2)} ${unit}`, L, doc.y)
      .text(`Mediana:  ${stats.median.toFixed(2)} ${unit}`, L, doc.y)
      .text(`p95:      ${stats.p95.toFixed(2)} ${unit}`, L, doc.y)
      .text(`Máximo:   ${stats.max.toFixed(2)} ${unit}`, L, doc.y)
      .text(`Desvio-padrão: ${stats.stddev.toFixed(2)} ${unit}`, L, doc.y)
      .moveDown(0.8);

    // 2. Faixas (agora definidas UMA vez aqui)
    const bandsMs = complianceByBands(sensorType, points);
    const totalMs = Object.values(bandsMs).reduce((a,b)=>a+b,0) || 1;
    const pct = (ms) => (ms/totalMs)*100;

    titleLeft('2. Distribuição por Faixas de Risco');
    drawTable(doc, [
      ['Faixa','Tempo (hh:mm)','%'],
      ['Normal',  msToHHMM(bandsMs.normal),  `${pct(bandsMs.normal).toFixed(1)}%`],
      ['Caution', msToHHMM(bandsMs.caution), `${pct(bandsMs.caution).toFixed(1)}%`],
      ['Warning', msToHHMM(bandsMs.warning), `${pct(bandsMs.warning).toFixed(1)}%`],
      ['Critical',msToHHMM(bandsMs.critical),`${pct(bandsMs.critical).toFixed(1)}%`],
    ], { x:L, y:doc.y, colWidths:[Math.floor(W*0.5),Math.floor(W*0.3),Math.floor(W*0.2)], rowH:22, headerRepeat:true, zebra:true });

    // 3. Série (amostra)
    titleLeft('3. Série Temporal (Amostra)');
    const chartBottomY = drawMiniChart(doc, points, { x:L, y:doc.y, w:W, h:160, unit });
    doc.y = chartBottomY + 16;

    // 4. Amostra de leituras
    titleLeft('4. Amostra de Leituras');
    const head = ['Data/Hora','Valor'];
    const sampleStart = points.slice(0,10).map(p=>[fmtBRDateTime(p.timestamp), `${p.value.toFixed(2)} ${unit}`]);
    const sampleEnd   = points.slice(-10).map(p=>[fmtBRDateTime(p.timestamp), `${p.value.toFixed(2)} ${unit}`]);
    drawTable(doc, [head, ...sampleStart, ...sampleEnd], { x:L, y:doc.y, colWidths:[Math.floor(W*0.65), Math.floor(W*0.30)], rowH:22, headerRepeat:true, zebra:true, preflight:false });

    // 5-6 Metodologia / Recomendações
    doc.addPage();
    titleLeft('5. Metodologia');
    doc.fontSize(11).fillColor('#111')
      .text('• Leituras agregadas do MongoDB; usa embedado e, se disponível, a coleção time-series.', L, doc.y)
      .text('• Estatísticas: mínimo, média, mediana (p50), p95, máximo e desvio-padrão.', L, doc.y)
      .text('• Conformidade por faixas baseada nos mesmos limites do módulo de alertas.', L, doc.y)
      .text('• Série temporal sem suavização (amostra).', L, doc.y)
      .moveDown(0.8);

    titleLeft('6. Recomendações Técnicas');
    const recLines = (() => {
      const lines = [];
      if (sensorType === 'humidity') {
        lines.push('- Umidade elevada aumenta risco de fungos; priorize aeração e secagem.');
        if (pct(bandsMs.critical) > 0) lines.push(`- Tempo em CRITICAL: ${pct(bandsMs.critical).toFixed(1)}%. Reduza imediatamente a umidade.`);
        if (pct(bandsMs.warning)  > 0) lines.push(`- Tempo em WARNING: ${pct(bandsMs.warning).toFixed(1)}%. Ajuste a aeração e monitore.`);
        lines.push(`- Variabilidade (σ): ${stats.stddev.toFixed(2)} — avalie oscilações e infiltração.`);
      } else if (sensorType === 'temperature') {
        lines.push('- Temperaturas altas aceleram fungos; revise ventilação e pontos quentes.');
        if (pct(bandsMs.critical) > 0) lines.push(`- Tempo em CRITICAL: ${pct(bandsMs.critical).toFixed(1)}%. Avalie resfriamento forçado.`);
        if (pct(bandsMs.warning)  > 0) lines.push(`- Tempo em WARNING: ${pct(bandsMs.warning).toFixed(1)}%. Melhore circulação de ar.`);
        lines.push(`- Variabilidade (σ): ${stats.stddev.toFixed(2)} — verifique estabilidade operacional.`);
      } else {
        lines.push('- Parâmetros dentro de faixas normativas na maior parte do tempo.');
      }
      return lines.join('\n');
    })();
    doc.fontSize(11).fillColor('#111').text(recLines, L, doc.y, { width: W });

    doc.end();
  }catch(err){
    console.error('[analysis/report] erro:', err);
    res.status(err.status||500).json({ error: err.message || 'Erro ao gerar relatório' });
  }
});

// ==============================
// ======== Desenho PDF =========
// ==============================
function drawTable(doc, rows, opts = {}){
  if (!rows?.length) return;
  let { x=doc.page.margins.left, y=doc.y, colWidths, rowH=22, headerRepeat=true, zebra=true, preflight=true } = opts;

  const L=doc.page.margins.left, R=doc.page.margins.right, W=doc.page.width-L-R;
  if (!Array.isArray(colWidths) || !colWidths.length){
    const n = rows[0]?.length ?? 1;
    const wEach = Math.floor(W/n);
    colWidths = Array.from({length:n}, ()=>wEach);
  }
  const totalWidth = colWidths.reduce((a,b)=>a+b,0);
  const pageBottom = () => doc.page.height - doc.page.margins.bottom;

  function drawRow(row, cy, isHeader, stripeOdd){
    let cx=x;
    if (isHeader) doc.rect(x,cy,totalWidth,rowH).fill('#f3f4f6');
    else if (zebra && stripeOdd) doc.rect(x,cy,totalWidth,rowH).fill('#fafafa');

    for (let c=0;c<row.length;c++){
      const w = colWidths[c] || 120;
      doc.rect(cx,cy,w,rowH).strokeColor('#e5e7eb').stroke();
      doc.fillColor(isHeader ? '#111' : '#374151').fontSize(isHeader?11:10).text(String(row[c] ?? ''), cx+6, cy+5, { width:w-12, ellipsis:true });
      cx += w;
    }
    doc.fillColor('#111');
  }

  function drawHeader(cy){ drawRow(rows[0],cy,true,false); return cy+rowH; }

  if (preflight){ if (y + rowH*2 > pageBottom()){ doc.addPage(); y = doc.y; } }

  let cy = y; cy = drawHeader(cy);
  let stripe = 0;
  for (let i=1;i<rows.length;i++){
    if (cy + rowH > pageBottom()){
      doc.addPage(); cy = doc.y; if (headerRepeat){ cy = drawHeader(cy); stripe = 0; }
    }
    drawRow(rows[i], cy, false, stripe % 2 === 1); stripe++; cy += rowH;
  }
  doc.y = cy + 8; doc.x = L;
}

function drawMiniChart(doc, points, { x, y, w, h, unit }){
  if (points.length < 2){ doc.text('Dados insuficientes para o gráfico.', x, y); return y + 14; }
  const vals = points.map(p=>p.value);
  const t0 = points[0].timestamp, t1 = points[points.length-1].timestamp;
  const min = Math.min(...vals), max = Math.max(...vals);
  const pad = 6;

  doc.rect(x,y,w,h).strokeColor('#e5e7eb').stroke();
  doc.moveTo(x+pad,y+h-pad).lineTo(x+w-pad,y+h-pad).strokeColor('#d1d5db').stroke();
  doc.moveTo(x+pad,y+pad).lineTo(x+pad,y+h-pad).strokeColor('#d1d5db').stroke();

  const sx = (ts) => x + pad + ((ts - t0) / (t1 - t0 || 1)) * (w - 2*pad);
  const sy = (v)  => y + h - pad - ((v - min) / ((max - min) || 1)) * (h - 2*pad);

  doc.moveTo(sx(points[0].timestamp), sy(points[0].value));
  for (let i=1;i<points.length;i++) doc.lineTo(sx(points[i].timestamp), sy(points[i].value));
  doc.strokeColor('#0ea5e9').lineWidth(1.2).stroke();

  doc.fontSize(9).fillColor('#6b7280')
    .text(`${min.toFixed(2)} ${unit}`, x+4, sy(min)-10, { width:80 })
    .text(`${max.toFixed(2)} ${unit}`, x+4, sy(max)-10, { width:80 });
  doc.fillColor('#111');

  return y + h;
}

module.exports = router;
