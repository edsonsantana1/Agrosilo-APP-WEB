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
      points.push({ timestamp: ts, value: Number(p.value), sensorId: s._id, sensorType: s.type });
    }
  }

  // 2) time-series (Model ou driver) — apenas se embedado vier vazio
  if (points.length === 0) {
    const ids = sensors.map(s => s._id);
    if (ids.length) {
      points = await collectFromTimeSeries({ ids, start, end, hardLimit });
      // Adicionar o tipo de sensor aos pontos coletados
      const sensorMap = sensors.reduce((acc, s) => { acc[s._id] = s.type; return acc; }, {});
      points = points.map(p => ({ ...p, sensorType: sensorMap[p.sensorId] }));
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



// Dados para o Overview Chart
router.get('/overview-data/:siloId', async (req,res)=>{
  try{
    const { siloId } = req.params;
    const { range='24h', start, end, limit } = req.query;

    await ensureSiloOwnership(siloId, req.user._id);

    const { start:s, end:e } = resolvePeriod({ range, start, end });
    const hardLimit = clampLimit(limit, 500, 2000); // Limite menor para o dashboard

    // 1. Coletar dados de Temperatura e Umidade
    const tempSensors = await Sensor.find({ silo:siloId, type:'temperature' }).select('_id data type').lean();
    const humSensors  = await Sensor.find({ silo:siloId, type:'humidity' }).select('_id data type').lean();

    const sensors = [...tempSensors, ...humSensors];
    if (!sensors.length) return res.json({ temperature: [], humidity: [] });

    const points = await collectPoints({ sensors, start:s, end:e, hardLimit });

    // 2. Mapear os dados para o formato do gráfico e calcular o risco
    const data = points.map(p => {
      let riskBand = 'normal';
      if (p.sensorType === 'humidity') {
        const p_hum = SAFETY_PARAMETERS.humidity;
        // > 16% = critical, 13-16% = warning, < 13% = normal/caution
        if (p.value > p_hum.fungus_risk) riskBand = 'critical'; // > 16%
        else if (p.value >= p_hum.acceptable) riskBand = 'warning'; // 14-16%
        else if (p.value >= p_hum.safe) riskBand = 'caution'; // 13-14%
      } else if (p.sensorType === 'temperature') {
        const p_temp = SAFETY_PARAMETERS.temperature;
        // 40-55°C = critical, 20-30°C = warning, ~15°C = normal/caution
        if (p.value >= p_temp.high_risk_max) riskBand = 'critical'; // >= 55°C
        else if (p.value >= p_temp.high_risk_min) riskBand = 'warning'; // 40-54.9°C
        else if (p.value >= p_temp.medium_growth_min) riskBand = 'caution'; // 20-39.9°C
      }

      return {
        t: p.timestamp.toISOString(),
        v: p.value,
        type: p.sensorType,
        risk: riskBand
      };
    });

    res.json({
      temperature: data.filter(p => p.type === 'temperature'),
      humidity: data.filter(p => p.type === 'humidity'),
    });

  }catch(err){
    console.error('[analysis/overview-data] erro:', err);
    res.status(err.status||500).json({ error: err.message || 'Erro ao carregar dados de overview' });
  }
});


module.exports = router;
