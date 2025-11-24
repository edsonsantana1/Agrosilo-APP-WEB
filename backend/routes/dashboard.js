// routes/dashboard.js
const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

// Helper para acessar diretamente as coleções do MongoDB
function readingsCollection() {
  return mongoose.connection.collection('readings'); // nome da coleção no Mongo
}

function alertsCollection() {
  return mongoose.connection.collection('alerts');   // nome da coleção no Mongo
}

// GET /api/dashboard/overview
router.get('/overview', async (req, res) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const { siloId } = req.query;

    // Filtro base para readings
    const matchReadings = {
      timestamp: { $gte: sevenDaysAgo, $lte: now },
    };
    if (siloId) matchReadings.siloId = siloId;

    // 1) Buscar documentos da coleção "readings"
    const readingsCursor = readingsCollection()
      .find(matchReadings)
      .sort({ timestamp: 1 });

    const readings = await readingsCursor.toArray();

    // Filtro base para alerts
    const matchAlerts = {
      createdAt: { $gte: sevenDaysAgo, $lte: now },
    };
    if (siloId) matchAlerts.siloId = siloId;

    // 2) Buscar documentos da coleção "alerts"
    const alertsCursor = alertsCollection()
      .find(matchAlerts)
      .sort({ createdAt: 1 });

    const alerts = await alertsCursor.toArray();

    return res.json({
      window: { from: sevenDaysAgo, to: now },
      readings,
      alerts,
    });
  } catch (err) {
    console.error('[GET /api/dashboard/overview] error:', err);
    return res.status(500).json({ error: 'Erro ao carregar overview' });
  }
});

module.exports = router;
