const axios = require('axios');

// unidade por tipo
function unitByType(type) {
  switch (type) {
    case 'temperature': return '°C';
    case 'humidity': return '%';
    case 'pressure': return ' hPa';
    case 'co2': return ' ppm';
    default: return '';
  }
}

function levelLabel(level) {
  if (level === 'critical') return 'CRÍTICO';
  if (level === 'warning')  return 'ALERTA';
  if (level === 'caution')  return 'ATENÇÃO';
  return 'INFO';
}

// Função auxiliar para escapar caracteres HTML em uma string
function escapeHtml(str) {
    if (!str) return '';
    // Escapa & primeiro, depois < e >
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
}

// Monta um texto HTML profissional pro Telegram
function formatAlertMessage(user, alertObj) {
  const { silo, sensor, value, timestamp, alert } = alertObj;
  const unit = unitByType(sensor);

  // Ex.: sensor: 'temperature' → 'Temperatura'
  const sensorName = ({
    temperature: 'Temperatura',
    humidity: 'Umidade',
    pressure: 'Pressão',
    co2: 'CO₂'
  })[sensor] || sensor;

  const level = levelLabel(alert.level);
  const date = new Date(timestamp).toLocaleString('pt-BR');

  // --- AQUI ESTÁ A CORREÇÃO ---
  // Escapamos o conteúdo da mensagem e recomendação
  const escapedMessage = escapeHtml(alert.message);
  const escapedRecommendation = escapeHtml(alert.recommendation);
  // ----------------------------

  return (
    `<b>🚨 Agrosilo | ${level}</b>\n` +
    `<b>Silo:</b> ${silo}\n` +
    `<b>Sensor:</b> ${sensorName}\n` +
    `<b>Valor:</b> <code>${value}${unit}</code>\n` +
    `<b>Data/Hora:</b> ${date}\n\n` +
    
    `<b>Mensagem:</b>\n${escapedMessage}\n\n` + // Usando o conteúdo escapado
    `<b>Recomendação:</b>\n${escapedRecommendation}\n\n` + // Usando o conteúdo escapado
    
    `<i>Alerta automático • Usuário:</i> ${user.name || user.email}`
  );
}

async function sendTelegramMessage(chatId, html) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN não configurado');

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  const res = await axios.post(url, payload);
  return res.data;
}

module.exports = {
  formatAlertMessage,
  sendTelegramMessage
};
