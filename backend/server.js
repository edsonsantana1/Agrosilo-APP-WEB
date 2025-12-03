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

// ===== Rotas Node (Core API)
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

// ============================================================================
// ===== Integração com FastAPI (análises + MFA)
// ============================================================================

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
 * Usada por /api/auth/mfa/wake e também pelo retry do proxy MFA.
 */
async function wakeFastApiMfa() {
  const maxAttempts = 10;   // até ~50 segundos no total
  const delayMs     = 5000; // 5s entre as tentativas

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[MFA] Tentando acordar FastAPI (tentativa ${attempt}/${maxAttempts}) em`, FASTAPI_TARGET);
      const resp = await fastapiClient.get('/health', {
        validateStatus: () => true, // vamos inspecionar manualmente
      });

      if (resp.status >= 200 && resp.status < 300) {
        console.log('[MFA] FastAPI acordado com sucesso');
        return true;
      }

      console.warn(
        `[MFA] /health respondeu status ${resp.status}. Aguardando para tentar de novo...`
      );
    } catch (err) {
      console.warn(
        `[MFA] Erro ao chamar /health (tentativa ${attempt}):`,
        err?.message || err
      );
    }

    // Espera antes da próxima tentativa (menos na última)
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.error('[MFA] Não foi possível acordar o FastAPI dentro do tempo limite.');
  return false;
}


// ----- Proxy para /api/analysis → FastAPI -----
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

// ===== Proxy → IA (FastAPI - IARA)
app.use(
  '/api/ia',
  auth, // mesma proteção de auth das outras rotas do painel
  createProxyMiddleware({
    target: FASTAPI_TARGET,        // http://127.0.0.1:8000
    changeOrigin: true,
    pathRewrite: { '^/api': '' },  // /api/ia/query -> /ia/query
    onProxyReq: (proxyReq, req) => {
      const authHeader = req.headers['authorization'];
      if (authHeader) proxyReq.setHeader('authorization', authHeader);

      proxyReq.setHeader('x-forwarded-host', req.headers.host || '');
      proxyReq.setHeader('x-forwarded-proto', req.protocol || 'http');
    },
    logLevel: 'warn',
    onError(err, req, res) {
      console.error('[ia-proxy] error:', err?.message || err);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Bad Gateway (ia proxy)' });
      }
    },
  })
);



/**
 * Função auxiliar para fazer proxy das rotas MFA com retry.
 * - Chama POST /auth/mfa/{action} no FastAPI.
 * - Se der erro de conexão/timeout/5xx na primeira tentativa,
 *   chama wakeFastApiMfa() e tenta UMA segunda vez.
 */
async function proxyMfaRequest(action, req, res, hasRetried = false) {
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

    return res.status(response.status).send(response.data);
  } catch (error) {
    const status = error.response?.status;
    const code = error.code;

    console.error('[mfa-proxy-axios] error:', {
      message: error?.message,
      code,
      status,
    });

    // Condições em que vale a pena tentar acordar + re-tentar:
    const shouldRetry =
      !hasRetried &&
      (
        code === 'ECONNREFUSED' ||
        code === 'ECONNRESET' ||
        code === 'ECONNABORTED' || // timeout
        !status ||                  // sem resposta HTTP
        status >= 500               // 5xx do Render/FastAPI
      );

    if (shouldRetry) {
      console.log('[MFA] Tentativa MFA falhou, acordando FastAPI e refazendo requisição...');
      await wakeFastApiMfa();
      return proxyMfaRequest(action, req, res, true);
    }

    // Se chegou aqui, ou já tentamos retry, ou é erro 4xx permanente
    if (error.response) {
      return res.status(error.response.status).send(error.response.data);
    }

    if (code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Service Unavailable (FastAPI is down)' });
    }

    if (code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Gateway Timeout (MFA cold start)' });
    }

    return res.status(502).json({ error: 'Bad Gateway (mfa proxy axios)' });
  }
}

// ----- Rota de Proxy Manual para MFA (usada pelo frontend) -----
app.post('/api/auth/mfa/:action', (req, res) => {
  const { action } = req.params;
  proxyMfaRequest(action, req, res);
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

// ===== Health do próprio gateway Node
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

['SIGINT', 'SIGTERM'].forEach(sig =>
  process.on(sig, () => gracefulShutdown(sig))
);
