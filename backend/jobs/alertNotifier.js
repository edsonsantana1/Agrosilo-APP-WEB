// backend/jobs/alertNotifier.js
const User = require('../models/user');
const AlertDispatch = require('../models/alertDispatch');
const { getActiveAlerts } = require('../services/alertService');
const { formatAlertMessage, sendTelegramMessage } = require('../services/telegramService');
const { sendAlertEmail } = require('../services/emailService');

// janelas por nível (ms) — ajustáveis via .env
const EMAIL_INTERVALS = {
  critical: Number(process.env.EMAIL_INTERVAL_CRITICAL_MS || 2 * 60 * 1000),   // 2 min
  warning:  Number(process.env.EMAIL_INTERVAL_WARNING_MS  || 5 * 60 * 1000),   // 5 min
  caution:  Number(process.env.EMAIL_INTERVAL_CAUTION_MS  || 30 * 60 * 1000),  // 30 min
};

const TELEGRAM_ENABLED = String(process.env.TELEGRAM_ENABLED || 'true').toLowerCase() !== 'false';
const EMAIL_ENABLED    = String(process.env.EMAIL_ENABLED    || 'true').toLowerCase() !== 'false';

// tick do agendador (com que frequência verificamos alertas)
const BASE_TICK_MS = Number(process.env.ALERT_NOTIFIER_TICK_MS || 60 * 1000); // 1 min por padrão

async function shouldSendAndStamp(userId, sensorId, level, channel, value, minIntervalMs) {
  const now = new Date();
  const key = { user: userId, sensor: sensorId, level, channel };

  let doc = await AlertDispatch.findOne(key);
  if (!doc) {
    doc = new AlertDispatch({ ...key, lastValue: value, lastSentAt: new Date(0) });
  }

  const elapsed = now - (doc.lastSentAt || 0);
  if (elapsed >= minIntervalMs) {
    doc.lastSentAt = now;
    doc.lastValue = value;
    await doc.save();
    return true;
  }
  return false;
}

async function runOnce() {
  const users = await User.find({ notificationsEnabled: { $ne: false } });

  for (const user of users) {
    const chatId = user.telegramChatId || process.env.TELEGRAM_CHAT_ID;

    // Deve retornar: { sensorId, silo, sensor, value, timestamp, alert:{ level,message,recommendation } }
    // eslint-disable-next-line no-await-in-loop
    const alerts = await getActiveAlerts(user._id);

    for (const a of alerts) {
      const level = a.alert?.level || 'caution';

      // TELEGRAM (janela única; se quiser por nível, crie um map como o de e-mail)
      if (TELEGRAM_ENABLED && chatId) {
        const tgInterval = Number(process.env.TELEGRAM_MIN_INTERVAL_MS || 5 * 60 * 1000);
        // eslint-disable-next-line no-await-in-loop
        const canTg = await shouldSendAndStamp(user._id, a.sensorId, level, 'telegram', a.value, tgInterval);
        if (canTg) {
          try {
            const html = formatAlertMessage(user, a);
            // eslint-disable-next-line no-await-in-loop
            await sendTelegramMessage(chatId, html);
          } catch (err) {
            console.error('[Telegram] erro ao enviar:', err?.response?.data || err.message);
          }
        }
      }

      // E-MAIL (janelas por nível)
      if (EMAIL_ENABLED && user.email) {
        const emailInterval = EMAIL_INTERVALS[level] ?? EMAIL_INTERVALS.caution;
        // eslint-disable-next-line no-await-in-loop
        const canEmail = await shouldSendAndStamp(user._id, a.sensorId, level, 'email', a.value, emailInterval);
        if (canEmail) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await sendAlertEmail(user, a);
          } catch (err) {
            console.error('[Email] erro ao enviar:', err.message);
          }
        }
      }
    }
  }
}

let timer = null;
function startAlertNotifierJob() {
  runOnce().catch(console.error);
  timer = setInterval(() => runOnce().catch(console.error), BASE_TICK_MS);
  console.log(`[Notifier] agendado a cada ${Math.round(BASE_TICK_MS / 1000)}s.`);
}

module.exports = { startAlertNotifierJob, runOnce };
