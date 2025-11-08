require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

// Rotas (Node)
const authRoutes        = require('./routes/auth');
const userRoutes        = require('./routes/users');
const siloRoutes        = require('./routes/silos');
const sensorRoutes      = require('./routes/sensors');
const alertRoutes       = require('./routes/alerts');
const reportRoutes      = require('./routes/reports');
const thingSpeakRoutes  = require('./routes/thingspeak');
const telegramRoutes    = require('./routes/telegram');
// const analysisRoutes  = require('./routes/analysisRoutes'); // ← FastAPI assume /analysis
const iotRoutes         = require('./routes/iot');
const thresholdsRoutes  = require('./routes/thresholds');

// Jobs
const { run: runAlertFromAssessment } = require('./jobs/alertFromAssessment');
setInterval(runAlertFromAssessment, 60 * 1000); // a cada 1 minuto

const { startAlertNotifierJob } = require('./jobs/alertNotifier');

// Garantia de time-series
const { ensureTimeSeries } = require('./models/reading');

// Middlewares de auth
const { auth, adminAuth } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 4000;

// ========= Middlewares globais =========
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ========= Conexão MongoDB =========
mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB');

    try {
      await ensureTimeSeries();
      console.log('Time Series collection "readings" pronta.');
    } catch (e) {
      console.error('Falha ao preparar time series:', e);
    }

    startAlertNotifierJob();
  })
  .catch((error) => {
    console.error('MongoDB connection error:', error);
  });

// ========= Rotas =========

// IoT pública (proteja por x-api-key no próprio router, se aplicável)
app.use('/api/iot', iotRoutes);

// Auth pública
app.use('/api/auth', authRoutes);

// Rotas protegidas por JWT
app.use('/api/users', auth, adminAuth, userRoutes);
app.use('/api/silos', auth, siloRoutes);
app.use('/api/sensors', auth, sensorRoutes);
app.use('/api/alerts', auth, alertRoutes);
app.use('/api/reports', auth, reportRoutes);
app.use('/api/thingspeak', auth, thingSpeakRoutes);
app.use('/api/telegram', telegramRoutes); // adicione 'auth' se desejar
app.use('/api/thresholds', auth, thresholdsRoutes);
app.use('/api/policy', require('./routes/policy'));

// ========= Proxy para FastAPI (/api/analysis → FASTAPI_TARGET/analysis) =========
const FASTAPI_TARGET = process.env.FASTAPI_TARGET || 'http://127.0.0.1:8000';

app.use(
  '/api/analysis',
  auth, // mantém proteção JWT no gateway
  createProxyMiddleware({
    target: FASTAPI_TARGET,
    changeOrigin: true,
    // /api/analysis/... → /analysis/...
    pathRewrite: { '^/api': '' },
    // encaminha o header Authorization para a FastAPI
    onProxyReq: (proxyReq, req) => {
      const authHeader = req.headers['authorization'];
      if (authHeader) proxyReq.setHeader('authorization', authHeader);
      proxyReq.setHeader('x-forwarded-host', req.headers.host || '');
      proxyReq.setHeader('x-forwarded-proto', req.protocol || 'http');
    },
    // aumenta tolerância para agregações/relatórios
    proxyTimeout: 30_000,
    timeout: 30_000,
    // logs úteis de debug
    logLevel: 'warn',
    onError(err, req, res) {
      console.error('[analysis-proxy] error:', err?.message || err);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Bad Gateway (analysis proxy)' });
      }
    },
  })
);

// Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

// ========= Subida =========
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`FastAPI target for /api/analysis → ${FASTAPI_TARGET}`);
});

// ========= Encerramento gracioso =========
function gracefulShutdown(signal) {
  console.log(`[${signal}] closing server...`);
  server.close(() => {
    mongoose.connection.close(false, () => {
      console.log('Mongo connection closed.');
      process.exit(0);
    });
  });
}
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => gracefulShutdown(sig)));
