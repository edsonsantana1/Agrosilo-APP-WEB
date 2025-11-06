// models/reading.js
const mongoose = require('mongoose');

/**
 * Cria a coleção "readings" como Time Series (se ainda não existir)
 * e garante o índice único { sensor, ts } para evitar duplicatas.
 */
async function ensureTimeSeries() {
  const db = mongoose.connection.db;

  // cria como time-series com metaField = 'sensor'
  const exists = await db.listCollections({ name: 'readings' }).toArray();
  if (!exists.length) {
    await db.createCollection('readings', {
      timeseries: {
        timeField: 'ts',
        metaField: 'sensor',
        granularity: 'minutes'
      }
    });
  }

  // garante índice único correto (sensor+ts)
 
  await db.collection('readings').createIndex(
    { sensor: 1, ts: 1 },
    { unique: true }
  );
}

const ReadingSchema = new mongoose.Schema(
  {
    sensor: { type: mongoose.Schema.Types.ObjectId, ref: 'Sensor', index: true },
    ts:     { type: Date, required: true, index: true },
    value:  { type: Number, required: true }
  },
  { versionKey: false }
);

const Reading = mongoose.model('Reading', ReadingSchema, 'readings');
module.exports = { Reading, ensureTimeSeries };
