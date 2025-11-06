const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { auth, adminAuth } = require('../middleware/auth');
const { runOnce } = require('../jobs/alertNotifier');
const { sendTelegramMessage } = require('../services/telegramService');

// 1) Ping simples (sem auth) para testar token/chatId do .env
router.post('/ping', async (req, res) => {
  try {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) return res.status(400).send({ ok: false, error: 'TELEGRAM_CHAT_ID não definido no .env' });

    await sendTelegramMessage(chatId, '<b>Agrosilo conectado ✅</b>');
    res.send({ ok: true, message: 'Ping enviado ao Telegram' });
  } catch (e) {
    console.error('[Telegram] ping error:', e?.response?.data || e.message);
    res.status(500).send({ ok: false, error: e.message });
  }
});

// 2) Salva o chatId no usuário logado
router.post('/set-chat', auth, async (req, res) => {
  try {
    const { chatId } = req.body;
    if (!chatId) return res.status(400).send({ success: false, error: 'chatId é obrigatório' });

    req.user.telegramChatId = String(chatId);
    await req.user.save();

    res.send({ success: true, message: 'Chat ID salvo com sucesso' });
  } catch (e) {
    res.status(500).send({ success: false, error: e.message });
  }
});

// 3) Liga/desliga notificações do usuário logado
router.post('/toggle', auth, async (req, res) => {
  try {
    const { enabled } = req.body; // true/false
    if (typeof enabled !== 'boolean') {
      return res.status(400).send({ success: false, error: 'Parâmetro "enabled" deve ser boolean' });
    }
    req.user.notificationsEnabled = enabled;
    await req.user.save();
    res.send({ success: true, notificationsEnabled: req.user.notificationsEnabled });
  } catch (e) {
    res.status(500).send({ success: false, error: e.message });
  }
});

// 4) Executa o job agora (somente admin)
router.post('/run-now', auth, adminAuth, async (req, res) => {
  try {
    await runOnce();
    res.send({ success: true, message: 'Job executado' });
  } catch (e) {
    res.status(500).send({ success: false, error: e.message });
  }
});

module.exports = router;
