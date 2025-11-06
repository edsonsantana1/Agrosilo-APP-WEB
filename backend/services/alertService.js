// =======================================================================
// backend/services/alertService.js
// =======================================================================

const Sensor   = require("../models/sensor");
const Silo     = require("../models/silo");
const { Reading } = require("../models/reading");
const Alert    = require("../models/Alert");
const Assessment = require("../models/Assessment");
const POLICY   = require("../config/policy");

// helpers
const p2 = x => Number(x).toFixed(2);
const p0 = x => Math.round(Number(x));

// ==============================
// REGRAS (centralizadas pela POLICY)
// ==============================
function checkHumidityAlert(h) {
  const H = POLICY.humidity;
  if (!Number.isFinite(h)) return null;

  if (h > H.fungus_risk)
    return {
      level: 'critical',
      message: `Umidade crítica: ${p0(h)}% — risco explosivo de fungos (>${H.fungus_risk}%)`,
      recommendation: 'Ação imediata para reduzir a umidade'
    };

  if (h > H.acceptable)
    return {
      level: 'warning',
      message: `Umidade elevada: ${p0(h)}% — acima do aceitável (${H.acceptable}%)`,
      recommendation: 'Monitorar e considerar aeração/secagem'
    };

  if (h > H.safe)
    return {
      level: 'caution',
      message: `Umidade moderada: ${p0(h)}% — acima do nível seguro (${H.safe}%)`,
      recommendation: 'Manter monitoramento'
    };

  return null;
}

function checkTemperatureAlert(t) {
  const T = POLICY.temperature;
  if (!Number.isFinite(t)) return null;

  if (t > T.high_risk_max)
    return {
      level: 'critical',
      message: `Temperatura extremamente alta: ${p2(t)}°C — acima de ${T.high_risk_max}°C`,
      recommendation: 'Ação emergencial imediata'
    };

  if (t >= T.high_risk_min && t <= T.high_risk_max)
    return {
      level: 'critical',
      message: `Temperatura crítica: ${p2(t)}°C — faixa de máximo desenvolvimento fúngico (${T.high_risk_min}–${T.high_risk_max}°C)`,
      recommendation: 'Reduzir temperatura (ventilação/aeração)'
    };

  if (t >= T.medium_growth_min && t <= T.medium_growth_max)
    return {
      level: 'warning',
      message: `Temperatura elevada: ${p2(t)}°C (${T.medium_growth_min}–${T.medium_growth_max}°C)`,
      recommendation: 'Monitorar de perto e considerar ventilação'
    };

  // abaixo de 15°C (slow_fungus): OK (sem alerta)
  return null;
}

// placeholders — ativar quando tiver sensores
function checkPressureAlert(_) { return null; }
function checkCO2Alert(_)      { return null;  }

// =======================================================================
// COMPAT: processa leitura e (se houver alerta) persiste no histórico
// =======================================================================
async function processSensorData(sensorId, value) {
  try {
    const sensor = await Sensor.findById(sensorId).populate({ path: "silo", populate: { path: "user" } });
    if (!sensor) throw new Error("Sensor não encontrado");

    let alert = null;
    if (sensor.type === "humidity")    alert = checkHumidityAlert(value);
    else if (sensor.type === "temperature") alert = checkTemperatureAlert(value);
    else if (sensor.type === "pressure")    alert = checkPressureAlert(value);
    else if (sensor.type === "co2")         alert = checkCO2Alert(value);

    if (alert) await createAlertFromReading(sensorId, value, new Date());

    return { success: true, alert, sensor, value };
  } catch (error) {
    console.error("[alertService][processSensorData] erro:", error);
    return { success: false, error: error.message };
  }
}

// =======================================================================
// ALERTAS ATIVOS (recalcula a partir do último reading de cada sensor)
// =======================================================================
async function getActiveAlerts(userId) {
  try {
    const silos = await Silo.find({ user: userId }).select("_id name").lean();
    const siloIds = silos.map(s => s._id);
    if (!siloIds.length) return [];

    const sensors = await Sensor.find({ silo: { $in: siloIds } }).select("_id type silo").lean();
    if (!sensors.length) return [];

    const sensorIds = sensors.map(s => s._id);
    const lastBySensor = await Reading.aggregate([
      { $match: { sensor: { $in: sensorIds } } },
      { $sort: { sensor: 1, ts: -1 } },
      { $group: { _id: "$sensor", ts: { $first: "$ts" }, value: { $first: "$value" } } }
    ]);

    const sensById = Object.fromEntries(sensors.map(s => [String(s._id), s]));
    const siloById = Object.fromEntries(silos.map(s => [String(s._id), s.name || "Silo"]));

    const alerts = [];
    for (const row of lastBySensor) {
      const sid = String(row._id);
      const sensor = sensById[sid];
      if (!sensor) continue;

      let alert = null;
      if (sensor.type === "humidity")       alert = checkHumidityAlert(row.value);
      else if (sensor.type === "temperature") alert = checkTemperatureAlert(row.value);
      else if (sensor.type === "pressure")    alert = checkPressureAlert(row.value);
      else if (sensor.type === "co2")         alert = checkCO2Alert(row.value);

      if (alert) {
        alerts.push({
          silo: siloById[String(sensor.silo)] || "Silo",
          siloId: sensor.silo,
          sensor: sensor.type,
          sensorId: sensor._id,
          value: row.value,
          timestamp: row.ts,
          alert
        });
      }
    }

    return alerts;
  } catch (error) {
    console.error("[alertService][getActiveAlerts] erro:", error);
    return [];
  }
}

// =======================================================================
// HISTÓRICO PERSISTIDO (anti-spam por level/sensor na janela)
// =======================================================================

const DUP_THROTTLE_MINUTES = 2;

async function createAlertFromReading(sensorId, value, ts = new Date()) {
  const sensor = await Sensor.findById(sensorId).populate("silo");
  if (!sensor || !sensor.silo) return null;

  const result =
    sensor.type === "humidity"    ? checkHumidityAlert(value) :
    sensor.type === "temperature" ? checkTemperatureAlert(value) :
    sensor.type === "pressure"    ? checkPressureAlert(value) :
    sensor.type === "co2"         ? checkCO2Alert(value) : null;

  if (!result) return null;

  const userId   = sensor.silo.user;
  const siloId   = sensor.silo._id;
  const siloName = sensor.silo.name || "Silo";

  const since = new Date(ts.getTime() - DUP_THROTTLE_MINUTES * 60 * 1000);
  const exists = await Alert.findOne({
    userId, sensorId, level: result.level, timestamp: { $gte: since }
  }).lean();
  if (exists) return exists;

  const doc = await Alert.create({
    userId, siloId, sensorId,
    siloName, sensorType: sensor.type,
    level: result.level, message: result.message,
    recommendation: result.recommendation || "",
    value, timestamp: ts, acknowledged: false
  });

  return doc.toObject();
}

async function listAlerts(userId, { level, siloId, start, end, page = 1, limit = 10 } = {}) {
  const q = { userId };
  if (level && level !== "all") q.level = level;
  if (siloId && siloId !== "all") q.siloId = siloId;
  if (start || end) {
    q.timestamp = {};
    if (start) q.timestamp.$gte = new Date(start);
    if (end)   q.timestamp.$lte = new Date(end);
  }

  const skip = (Math.max(1, +page) - 1) * Math.max(1, +limit);
  const [items, total] = await Promise.all([
    Alert.find(q).sort({ timestamp: -1 }).skip(skip).limit(+limit).lean(),
    Alert.countDocuments(q)
  ]);

  return {
    items,
    page: +page,
    limit: +limit,
    total,
    totalPages: Math.ceil(total / Math.max(1, +limit)) || 1
  };
}

// =======================================================================
// ALERTAS A PARTIR DO ÚLTIMO ASSESSMENT (recomendado)
// =======================================================================

function levelFromAssessmentStatus(st) {
  if (st === 'CRÍTICO') return 'critical';
  if (st === 'ALERTA')  return 'warning';
  if (st === 'ATENÇÃO') return 'caution';
  return 'normal';
}

async function persistAlertsFromAssessment(userId, siloId) {
  const silo = await Silo.findById(siloId).lean();
  if (!silo) return [];

  const a = await Assessment.findOne({ silo: siloId }).sort({ ts: -1 }).lean();
  if (!a) return [];

  const sensors = await Sensor.find({ silo: siloId }).lean();
  const byType = Object.fromEntries(sensors.map(s => [s.type, s]));

  const defs = [
    { key:'temperature', value:a.temp, unit:'°C',
      msg:v=>`Temperatura ${p2(v)}°C`,
      reco:v=>v>40?'Risco severo de fungos: ação imediata.':'Monitorar e considerar ventilação.' },
    { key:'humidity', value:a.hum, unit:'%',
      msg:v=>`Umidade ${p0(v)}%`,
      reco:v=>v>16?'Aeração intensiva e/ou secagem imediata.':'Aeração moderada a intensiva.' },
    { key:'pressure', value:a.pressure, unit:'hPa',
      msg:v=>`Pressão ${p0(v)} hPa`, reco:()=>'' },
    { key:'co2', value:a.co2, unit:'ppm',
      msg:v=>`CO₂ ${p0(v)} ppm`, reco:v=>v>1100?'Investigar atividade biológica; ventilar.':'Monitorar.' }
  ];

  const toCreate = [];
  for (const d of defs) {
    const st = a.status?.[d.key] || 'N/A';
    const lvl = levelFromAssessmentStatus(st);
    if (lvl === 'normal' || st === 'N/A') continue;
    const s = byType[d.key];
    if (!s) continue;

    toCreate.push({
      userId, siloId, sensorId: s._id,
      siloName: silo.name || 'Silo',
      sensorType: d.key,
      level: lvl,
      message: `${d.msg(d.value)} — Status: ${st}`,
      recommendation: d.reco(d.value),
      value: d.value ?? null,
      timestamp: a.ts,
      acknowledged: false
    });
  }

  if (!toCreate.length) return [];
  await Alert.insertMany(toCreate, { ordered: false });
  return toCreate;
}

// =======================================================================
// EXPORTS
// =======================================================================
module.exports = {
  // histórico
  createAlertFromReading,
  listAlerts,
  // compatibilidade com leitura direta
  processSensorData,
  getActiveAlerts,
  // via assessment (recomendado)
  persistAlertsFromAssessment,
  // utilitárias
  checkHumidityAlert,
  checkTemperatureAlert
};
