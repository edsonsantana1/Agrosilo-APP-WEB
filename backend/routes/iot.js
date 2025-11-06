// routes/iot.js
const express = require('express');
const router = express.Router();

const iotAuth = require('../middleware/iotAuth');
const Sensor = require('../models/sensor');
const { Reading } = require('../models/reading');
const { processSensorData } = require('../services/alertService'); // GARANTA QUE EXISTE

// Helpers
function toNumberOrNull(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * POST /api/iot/readings
 * Body: { deviceId?, siloId, temperature?, humidity?, timestamp? }
 * - Aceita números como string ("23.4")
 * - Cria Sensor automaticamente se não existir para o silo/tipo
 * - Upsert idempotente na coleção readings (bulkWrite)
 * - Dispara processamento de alertas (opcional)
 */
router.post('/readings', iotAuth, async (req, res) => {
  try {
    const { deviceId, siloId, temperature, humidity, timestamp } = req.body || {};

    if (!siloId) return res.status(400).json({ error: 'Campo obrigatório: siloId' });

    // Converte valores
    const tempVal = toNumberOrNull(temperature);
    const humVal  = toNumberOrNull(humidity);

    if (tempVal === null && humVal === null) {
      return res.status(400).json({ error: 'Envie ao menos temperature ou humidity' });
    }

    const ts = timestamp ? new Date(timestamp) : new Date();
    if (isNaN(ts.getTime())) {
      return res.status(400).json({ error: 'timestamp inválido' });
    }

    // Garante sensores para o silo (cria se não existirem)
    const neededTypes = [];
    if (tempVal !== null) neededTypes.push('temperature');
    if (humVal  !== null) neededTypes.push('humidity');

    const existing = await Sensor.find({ silo: siloId, type: { $in: neededTypes } })
      .select('_id type').lean();

    const byType = Object.fromEntries(existing.map(s => [s.type, s]));

    // Cria sensores faltantes
    const toCreate = neededTypes.filter(t => !byType[t]).map(t => ({ silo: siloId, type: t }));
    if (toCreate.length) {
      const created = await Sensor.insertMany(toCreate);
      for (const s of created) byType[s.type] = { _id: s._id, type: s.type };
      console.log('[iot/readings] Sensores criados para silo', siloId, '->', created.map(c => c.type));
    }

    // Monta operações para histórico + lista para processar alertas
    const ops = [];
    const toProcess = [];

    if (tempVal !== null && byType.temperature?._id) {
      ops.push({
        updateOne: {
          filter: { sensor: byType.temperature._id, ts },
          update: { $setOnInsert: { sensor: byType.temperature._id, ts, value: tempVal } },
          upsert: true
        }
      });
      toProcess.push({ sensor: byType.temperature._id, value: tempVal });
    }
    if (humVal !== null && byType.humidity?._id) {
      ops.push({
        updateOne: {
          filter: { sensor: byType.humidity._id, ts },
          update: { $setOnInsert: { sensor: byType.humidity._id, ts, value: humVal } },
          upsert: true
        }
      });
      toProcess.push({ sensor: byType.humidity._id, value: humVal });
    }

    if (!ops.length) {
      console.warn('[iot/readings] Nenhuma operação gerada (verifique siloId e tipos). Body:', req.body);
      return res.status(202).json({ ok: true, info: 'Nenhuma leitura gravada (sem sensores correspondentes)' });
    }

    // Escreve (idempotente)
    const result = await Reading.bulkWrite(ops, { ordered: false });
    console.log('[iot/readings] bulkWrite result:', JSON.stringify(result));

    // Dispara alertas (em sequência)
    for (const p of toProcess) {
      // eslint-disable-next-line no-await-in-loop
      await processSensorData(p.sensor, p.value);
    }

    return res.status(201).json({
      ok: true,
      deviceId: deviceId || null,
      storedAt: new Date().toISOString(),
      upserts: result.upsertedCount || 0,
      matched: result.matchedCount || 0
    });
  } catch (err) {
    console.error('[iot/readings] erro:', err);
    return res.status(500).json({ error: 'Erro ao salvar leitura' });
  }
});

module.exports = router;
