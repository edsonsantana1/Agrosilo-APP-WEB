/**
 * Agrosilo – API Gateway (Node/Express)
 */
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const axios = require('axios');

const authRoutes       = require('./routes/auth');
const userRoutes       = require('./routes/users');
const siloRoutes       = require('./routes/silos');
const sensorRoutes     = require('./routes/sensors');
const alertRoutes      = require('./routes/alerts');
const reportRoutes     = require('./routes/reports');
const thingSpeakRoutes = require('./routes/thingspeak');
const telegramRoutes   = require('./routes/telegram');
const iotRoutes        = require('./routes/iot');
const thresholdsRoutes = require('./routes/thresholds');
const dashboardRoutes  = require('./routes/dashboard');

const { run: runAlertFromAssessment } = require('./jobs/alertFromAssessment');
setInterval(runAlertFromAssessment, 60 * 1000);
const { startAlertNotifierJob } = require('./jobs/alertNotifier');

const { ensureTimeSeries } = require('./models/reading');
const { auth, adminAuth } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ===== Conexão MongoDB (força dbName)
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'test';

mongoose
  .connect(uri, { dbName })
  .then(async () => {
    console.log(`Connected to MongoDB (db = ${dbName} )`);
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

// ===== Rotas Node
app.use('/api/iot', iotRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', auth, adminAuth, userRoutes);
app.use('/api/silos', auth, siloRoutes);
app.use('/api/sensors', auth, sensorRoutes);
app.use('/api/alerts', auth, alertRoutes);
app.use('/api/reports', auth, reportRoutes);
app.use('/api/thingspeak', auth, thingSpeakRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/thresholds', auth, thresholdsRoutes);
app.use('/api/policy', require('./routes/policy'));
app.use('/api/dashboard', auth, dashboardRoutes);

// ===== Proxy → FastAPI (análise + MFA)
const FASTAPI_TARGET = process.env.FASTAPI_TARGET || 'http://127.0.0.1:8000';

/**
 * Cliente Axios dedicado para falar com o FastAPI.
 * Timeout maior para aguentar o cold start do Render.
 */
const fastapiClient = axios.create({
  baseURL: FASTAPI_TARGET,
  timeout: 60000, // 60 segundos
});

/**
 * Função para "acordar" o serviço FastAPI/MFA no Render.
 * É chamada pela rota /api/auth/mfa/wake.
 *
 * No FastAPI, já existe a rota GET /health (vista no log de startup).
 */
async function wakeFastApiMfa() {
  try {
    console.log('[MFA] Tentando acordar FastAPI em', FASTAPI_TARGET);
    await fastapiClient.get('/health');
    console.log('[MFA] FastAPI acordado com sucesso');
  } catch (err) {
    console.error(
      '[MFA] Erro ao acordar FastAPI (wakeFastApiMfa):',
      err?.message || err
    );
    // Não lança erro pra não quebrar o fluxo de login.
  }
}

// ===== Proxy para /api/analysis → FastAPI
app.use(
  '/api/analysis',
  auth,
  createProxyMiddleware({
    target: FASTAPI_TARGET,
    changeOrigin: true,
    pathRewrite: { '^/api': '' },
    onProxyReq: (proxyReq, req) => {
      const authHeader = req.headers['authorization'];
      if (authHeader) proxyReq.setHeader('authorization', authHeader);
      proxyReq.setHeader('x-forwarded-host', req.headers.host || '');
      proxyReq.setHeader('x-forwarded-proto', req.protocol || 'http');
    },
    proxyTimeout: 60000,
    timeout: 60000,
    logLevel: 'warn',
    onError(err, req, res) {
      console.error('[analysis-proxy] error:', err?.message || err);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Bad Gateway (analysis proxy)' });
      }
    },
  })
);

// ===== Rota de Proxy Manual para MFA
// (para evitar problemas de body-parsing com http-proxy-middleware)
app.post('/api/auth/mfa/:action', async (req, res) => {
  const { action } = req.params;
  const targetPath = `/auth/mfa/${action}`;

  try {
    const response = await fastapiClient.post(targetPath, req.body, {
      headers: {
        'Content-Type': req.headers['content-type'],
        'Authorization': req.headers['authorization'] || '',
        'x-forwarded-host': req.headers.host || '',
        'x-forwarded-proto': req.protocol || 'http',
      },
      // Não lançar erro para 4xx, deixa a API responder normalmente
      validateStatus: (status) => status >= 200 && status < 500,
    });

    res.status(response.status).send(response.data);
  } catch (error) {
    console.error('[mfa-proxy-axios] error:', error?.message || error);

    if (error.response) {
      res.status(error.response.status).send(error.response.data);
    } else if (error.code === 'ECONNREFUSED') {
      res.status(503).json({ error: 'Service Unavailable (FastAPI is down)' });
    } else if (error.code === 'ECONNABORTED') {
      res.status(504).json({ error: 'Gateway Timeout (MFA cold start)' });
    } else {
      res.status(502).json({ error: 'Bad Gateway (mfa proxy axios)' });
    }
  }
});

/**
 * Rota para "acordar" explicitamente o serviço de MFA/FastAPI.
 * Chamado pelo frontend logo após o login cair em fluxo MFA.
 */
app.get('/api/auth/mfa/wake', async (req, res) => {
  try {
    await wakeFastApiMfa();
    return res.json({ ok: true, message: 'MFA/FastAPI acordado' });
  } catch (err) {
    console.error('[MFA] Erro em /api/auth/mfa/wake:', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Falha ao acordar MFA' });
  }
});

// Health do próprio gateway Node
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`FastAPI target for /api/analysis and /api/auth/mfa → ${FASTAPI_TARGET}`);
});

// ===== Encerramento gracioso (Mongoose v7+)
async function gracefulShutdown(signal) {
  console.log(`[${signal}] closing server...`);
  server.close(async () => {
    try {
      await mongoose.connection.close();
      console.log('Mongo connection closed.');
    } catch (e) {
      console.error('Error closing Mongo connection:', e);
    } finally {
      process.exit(0);
    }
  });
}
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => gracefulShutdown(sig)));
