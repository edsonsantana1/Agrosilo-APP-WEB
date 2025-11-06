// backend/services/thingspeakservice.js
const axios = require('axios');
const Sensor = require('../models/sensor');
const { Reading } = require('../models/reading');
// usamos createAlertFromReading para persistir com o mesmo timestamp do feed
const { createAlertFromReading /*, processSensorData (se quiser manter) */ } = require('./alertService');

/**
 * Integração ThingSpeak
 * - Sincroniza incrementalmente com "readings" (time-series)
 * - Cria alertas persistidos em "alerts" para cada ponto novo que gere alerta
 */

const THINGSPEAK_CONFIG = {
  baseURL: 'https://api.thingspeak.com',
  readAPIKey: process.env.THINGSPEAK_READ_API_KEY,
  writeAPIKey: process.env.THINGSPEAK_WRITE_API_KEY,
  channelId: process.env.THINGSPEAK_CHANNEL_ID
};

/** Lê o canal completo (não usado na sync de campo, útil para debug) */
async function fetchChannelData(channelId, apiKey, results = 200) {
  try {
    const { data } = await axios.get(
      `${THINGSPEAK_CONFIG.baseURL}/channels/${channelId}/feeds.json`,
      { params: { api_key: apiKey, results } }
    );
    return { success: true, channel: data.channel, feeds: data.feeds };
  } catch (err) {
    console.error('[thingspeak] fetchChannelData:', err.message);
    return { success: false, error: err.message };
  }
}

/** Lê um campo específico; results aumentado para evitar perda de histórico */
async function fetchFieldData(channelId, fieldNumber, apiKey, results = 8000) {
  try {
    const { data } = await axios.get(
      `${THINGSPEAK_CONFIG.baseURL}/channels/${channelId}/fields/${fieldNumber}.json`,
      { params: { api_key: apiKey, results } }
    );
    return { success: true, feeds: data.feeds };
  } catch (err) {
    console.error(`[thingspeak] fetchFieldData f${fieldNumber}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Sincroniza dados de UM sensor (incremental) para "readings"
 * - Busca últimos N pontos do ThingSpeak
 * - Compara com o último ts salvo em readings
 * - Upsert dos novos (idempotente)
 * - Para cada novo, tenta criar alerta persistido com o MESMO timestamp
 */
async function syncSensorData(sensorId, channelId, fieldNumber, apiKey) {
  try {
    // 1) sensor existe?
    const sensor = await Sensor.findById(sensorId).select('_id type').lean();
    if (!sensor) throw new Error('Sensor não encontrado');

    // 2) último ts salvo
    const lastDoc = await Reading.findOne({ sensor: sensorId })
      .sort({ ts: -1 })
      .select({ ts: 1 })
      .lean();
    const lastTs = lastDoc?.ts || null;

    // 3) pega feeds do ThingSpeak
    const thing = await fetchFieldData(
      channelId,
      fieldNumber,
      apiKey || THINGSPEAK_CONFIG.readAPIKey,
      8000
    );
    if (!thing.success) throw new Error(thing.error);

    // 4) filtra só os novos
    const candidates = [];
    for (const feed of thing.feeds || []) {
      const raw = feed[`field${fieldNumber}`];
      if (raw === null || raw === undefined || raw === '') continue;

      const ts = new Date(feed.created_at); // UTC do ThingSpeak
      const val = Number(raw);
      if (!Number.isFinite(val)) continue;

      if (!lastTs || ts > lastTs) {
        candidates.push({ ts, value: val });
      }
    }

    if (!candidates.length) {
      return { success: true, sensorId, newDataPoints: 0, processedData: [] };
    }

    // 5) ordena por tempo
    candidates.sort((a, b) => a.ts - b.ts);

    // 6) upsert em readings (idempotente)
    const ops = candidates.map(p => ({
      updateOne: {
        filter: { sensor: sensorId, ts: p.ts },
        update: { $setOnInsert: { sensor: sensorId, ts: p.ts, value: p.value } },
        upsert: true
      }
    }));
    const result = await Reading.bulkWrite(ops, { ordered: false });

    // 7) cria alertas históricos usando o mesmo timestamp do ponto
    for (const p of candidates) {
      // eslint-disable-next-line no-await-in-loop
      await createAlertFromReading(sensorId, p.value, p.ts);
      // Se quiser manter avaliação "ao vivo" sem persistir extra, poderia chamar:
      // await processSensorData(sensorId, p.value, p.ts);
    }

    return {
      success: true,
      sensorId,
      newDataPoints: result.upsertedCount ?? candidates.length,
      processedData: candidates
    };
  } catch (error) {
    console.error('[thingspeak] syncSensorData erro:', error);
    return { success: false, error: error.message };
  }
}

/** Sincroniza todos os sensores configurados com ThingSpeak */
async function syncAllSensors() {
  try {
    const sensors = await Sensor.find({
      'thingSpeakConfig.channelId': { $exists: true, $ne: null },
      'thingSpeakConfig.fieldNumber': { $exists: true, $ne: null }
    }).select({ _id: 1, thingSpeakConfig: 1 }).lean();

    const out = [];
    for (const s of sensors) {
      const { channelId, fieldNumber, apiKey } = s.thingSpeakConfig || {};
      // eslint-disable-next-line no-await-in-loop
      const r = await syncSensorData(
        s._id,
        channelId,
        fieldNumber,
        apiKey || THINGSPEAK_CONFIG.readAPIKey
      );
      out.push(r);
    }
    return out;
  } catch (err) {
    console.error('[thingspeak] syncAllSensors erro:', err);
    return [];
  }
}

/** Envia dados (write) para ThingSpeak */
async function sendDataToThingSpeak(channelId, writeAPIKey, data) {
  try {
    const { data: entryId } = await axios.post(
      `${THINGSPEAK_CONFIG.baseURL}/update.json`,
      { api_key: writeAPIKey, ...data }
    );
    return { success: true, entryId };
  } catch (err) {
    console.error('[thingspeak] sendDataToThingSpeak:', err.message);
    return { success: false, error: err.message };
  }
}

/** Info do canal (útil para validar config) */
async function getChannelInfo(channelId, apiKey) {
  try {
    const { data } = await axios.get(
      `${THINGSPEAK_CONFIG.baseURL}/channels/${channelId}.json`,
      { params: { api_key: apiKey } }
    );
    return { success: true, channel: data };
  } catch (err) {
    console.error('[thingspeak] getChannelInfo:', err.message);
    return { success: false, error: err.message };
  }
}

/** Associa ThingSpeak a um sensor */
async function configureSensorThingSpeak(sensorId, thingSpeakConfig) {
  try {
    const sensor = await Sensor.findById(sensorId);
    if (!sensor) throw new Error('Sensor não encontrado');

    const { channelId, fieldNumber, apiKey } = thingSpeakConfig;
    if (!channelId || !fieldNumber) throw new Error('channelId e fieldNumber são obrigatórios');

    const test = await getChannelInfo(channelId, apiKey || THINGSPEAK_CONFIG.readAPIKey);
    if (!test.success) throw new Error('Não foi possível conectar ao canal: ' + test.error);

    sensor.thingSpeakConfig = { channelId, fieldNumber, apiKey, lastSync: new Date() };
    await sensor.save();

    return { success: true, message: 'Sensor configurado com sucesso para ThingSpeak', channelInfo: test.channel };
  } catch (err) {
    console.error('[thingspeak] configureSensorThingSpeak:', err);
    return { success: false, error: err.message };
  }
}

/** Remove configuração ThingSpeak de um sensor */
async function removeSensorThingSpeakConfig(sensorId) {
  try {
    const sensor = await Sensor.findById(sensorId);
    if (!sensor) throw new Error('Sensor não encontrado');

    sensor.thingSpeakConfig = undefined;
    await sensor.save();

    return { success: true, message: 'Configuração do ThingSpeak removida com sucesso' };
  } catch (err) {
    console.error('[thingspeak] removeSensorThingSpeakConfig:', err);
    return { success: false, error: err.message };
  }
}

module.exports = {
  fetchChannelData,
  fetchFieldData,
  syncSensorData,
  syncAllSensors,
  sendDataToThingSpeak,
  getChannelInfo,
  configureSensorThingSpeak,
  removeSensorThingSpeakConfig,
  THINGSPEAK_CONFIG
};
