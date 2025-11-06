// backend/routes/sensors.js
const express = require("express");
const router = express.Router();

const Sensor = require("../models/sensor");
const Silo   = require("../models/silo");
const { Reading } = require("../models/reading");
const { auth } = require("../middleware/auth");

// Helper: último ponto de um sensor
async function getLastPoint(sensorId) {
  const doc = await Reading.findOne({ sensor: sensorId })
    .sort({ ts: -1 })
    .select({ value: 1, ts: 1 })
    .lean();
  return doc ? { value: doc.value, timestamp: doc.ts } : null;
}

/**
 * GET /api/sensors/silo/:siloId/summary
 * Últimos valores por sensor do silo (para os cards)
 */
router.get("/silo/:siloId/summary", auth, async (req, res) => {
  try {
    const silo = await Silo.findOne({ _id: req.params.siloId, user: req.user._id }).lean();
    if (!silo) return res.status(404).send({ error: "Silo not found or not authorized" });

    const sensors = await Sensor.find({ silo: silo._id })
      .select("_id type silo updatedAt")
      .lean();

    const summarized = await Promise.all(
      sensors.map(async (s) => {
        const last = await getLastPoint(s._id);
        return {
          _id: s._id,
          type: s.type,
          lastValue: last ? last.value : null,
          lastTimestamp: last ? last.timestamp : null,
        };
      })
    );

    res.send({ siloId: silo._id, sensors: summarized });
  } catch (error) {
    console.error("[sensors][summary] erro:", error);
    res.status(500).send({ error: "Internal server error" });
  }
});

/**
 * GET /api/sensors/:sensorId/history
 * Série temporal do sensor para os gráficos
 */
router.get("/:sensorId/history", auth, async (req, res) => {
  try {
    const { sensorId } = req.params;
    const { limit, from, to } = req.query;

    const sensor = await Sensor.findById(sensorId).lean();
    if (!sensor) return res.status(404).send({ error: "Sensor not found" });

    const silo = await Silo.findOne({ _id: sensor.silo, user: req.user._id }).lean();
    if (!silo) return res.status(403).send({ error: "Access denied to this sensor" });

    if (limit) {
      const n = Math.min(parseInt(limit, 10) || 1000, 5000);
      const docs = await Reading.find({ sensor: sensorId })
        .sort({ ts: -1 })
        .limit(n)
        .select({ value: 1, ts: 1, _id: 0 })
        .lean();

      return res.send({
        sensorId: sensor._id,
        type: sensor.type,
        points: docs.reverse().map(d => ({ t: d.ts, v: d.value })),
      });
    }

    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 24 * 60 * 60 * 1000);

    const docs = await Reading.find({ sensor: sensorId, ts: { $gte: start, $lte: end } })
      .sort({ ts: 1 })
      .select({ value: 1, ts: 1, _id: 0 })
      .lean();

    res.send({
      sensorId: sensor._id,
      type: sensor.type,
      points: docs.map(d => ({ t: d.ts, v: d.value })),
    });
  } catch (error) {
    console.error("[sensors][history] erro:", error);
    res.status(500).send({ error: "Internal server error" });
  }
});

/* ---- CRUD / utilidades ---- */

// cria sensor no silo
router.post("/:siloId", auth, async (req, res) => {
  try {
    const silo = await Silo.findOne({ _id: req.params.siloId, user: req.user._id });
    if (!silo) return res.status(404).send({ error: "Silo not found or not authorized" });

    const sensor = new Sensor({ ...req.body, silo: req.params.siloId });
    await sensor.save();
    silo.sensors.push(sensor._id);
    await silo.save();
    res.status(201).send(sensor);
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

// ⚠️ Rota renomeada para evitar colisão com as acima
router.get("/by-silo/:siloId", auth, async (req, res) => {
  try {
    const silo = await Silo.findOne({ _id: req.params.siloId, user: req.user._id }).lean();
    if (!silo) return res.status(404).send({ error: "Silo not found or not authorized" });

    const sensors = await Sensor.find({ silo: req.params.siloId }).lean();
    res.send(sensors);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// detalhes de um sensor (metadado + último valor)
router.get("/details/:id", auth, async (req, res) => {
  try {
    const sensor = await Sensor.findById(req.params.id).lean();
    if (!sensor) return res.status(404).send();

    const silo = await Silo.findOne({ _id: sensor.silo, user: req.user._id }).lean();
    if (!silo) return res.status(403).send({ error: "Access denied to this sensor" });

    const last = await getLastPoint(sensor._id);
    res.send({ ...sensor, lastValue: last?.value ?? null, lastTimestamp: last?.timestamp ?? null });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// legacy: insere um ponto direto
router.post("/data/:id", async (req, res) => {
  try {
    const sensor = await Sensor.findById(req.params.id).lean();
    if (!sensor) return res.status(404).send();

    const { value } = req.body || {};
    if (typeof value !== "number") {
      return res.status(400).send({ error: "value deve ser number" });
    }

    await Reading.updateOne(
      { sensor: sensor._id, ts: new Date() },
      { $setOnInsert: { sensor: sensor._id, ts: new Date(), value } },
      { upsert: true }
    );

    res.send({ ok: true });
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

router.patch("/:id", auth, async (req, res) => {
  const updates = Object.keys(req.body);
  const allowed = ["type"];
  if (!updates.every(u => allowed.includes(u))) {
    return res.status(400).send({ error: "Invalid updates!" });
  }

  try {
    const sensor = await Sensor.findById(req.params.id);
    if (!sensor) return res.status(404).send();

    const silo = await Silo.findOne({ _id: sensor.silo, user: req.user._id }).lean();
    if (!silo) return res.status(403).send({ error: "Access denied to this sensor" });

    updates.forEach(u => (sensor[u] = req.body[u]));
    await sensor.save();
    res.send(sensor);
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

router.delete("/:id", auth, async (req, res) => {
  try {
    const sensor = await Sensor.findById(req.params.id);
    if (!sensor) return res.status(404).send();

    const silo = await Silo.findOne({ _id: sensor.silo, user: req.user._id });
    if (!silo) return res.status(403).send({ error: "Access denied to this sensor" });

    await sensor.remove();
    silo.sensors.pull(sensor._id);
    await silo.save();
    res.send({ message: "Sensor deleted successfully" });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

module.exports = router;
