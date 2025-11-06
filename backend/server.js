require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');

// Rotas
const authRoutes        = require('./routes/auth');
const userRoutes        = require('./routes/users');
const siloRoutes        = require('./routes/silos');
const sensorRoutes      = require('./routes/sensors');
const alertRoutes       = require('./routes/alerts');
const reportRoutes      = require('./routes/reports');
const thingSpeakRoutes  = require('./routes/thingspeak');
const telegramRoutes    = require('./routes/telegram');
const analysisRoutes    = require('./routes/analysisRoutes');
const iotRoutes         = require('./routes/iot');
const thresholdsRoutes  = require('./routes/thresholds');

// agendar job de alertas a partir do assessment
const { run: runAlertFromAssessment } = require('./jobs/alertFromAssessment');
setInterval(runAlertFromAssessment, 60 * 1000); // a cada 1 minuto

// Jobs
const { startAlertNotifierJob } = require('./jobs/alertNotifier');

// **Garantimos a coleção de leituras como Time Series + índice único**
// (é no models/reading.js que criamos a coleção "readings")
const { ensureTimeSeries } = require('./models/reading');

// Middlewares de auth
const { auth, adminAuth } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 4000;

/* ---------- Middlewares globais ---------- */
app.use(cors());
app.use(express.json({ limit: '1mb' })); // payload enxuto para IoT

/* ---------- Conexão MongoDB ---------- */
// Obs.: no Mongoose >= 6 não precisa dos options useNewUrlParser/useUnifiedTopology
mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB');

    // Cria (se não existir) a coleção timeseries "readings" + índice {sensor, ts} único
    try {
      await ensureTimeSeries();
      console.log('Time Series collection "readings" pronta.');
    } catch (e) {
      console.error('Falha ao preparar time series:', e);
    }

    // Inicia job de notificações
    startAlertNotifierJob();
  })
  .catch((error) => {
    console.error('MongoDB connection error:', error);
  });

// server.js (trecho de rotas)

// Rotas públicas IoT (proteção por x-api-key via iotAuth)
app.use('/api/iot', iotRoutes);

// 🔓 Rotas de autenticação DEVEM ser públicas!
app.use('/api/auth', authRoutes);

// 🔐 Rotas protegidas por JWT
app.use('/api/users', auth, adminAuth, userRoutes);
app.use('/api/silos', auth, siloRoutes);
app.use('/api/sensors', auth, sensorRoutes);
app.use('/api/alerts', auth, alertRoutes);
app.use('/api/reports', auth, reportRoutes);
app.use('/api/thingspeak', auth, thingSpeakRoutes);
app.use('/api/telegram', telegramRoutes); // se quiser, pode adicionar 'auth' aqui
app.use('/api/analysis', auth, analysisRoutes);
app.use('/api/thresholds', auth, thresholdsRoutes);
app.use('/api/policy', require('./routes/policy'));

// Healthcheck simples (útil p/ monitor/uptime)
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ---------- Subida do servidor ---------- */
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

/* ---------- Encerramento gracioso ---------- */
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
