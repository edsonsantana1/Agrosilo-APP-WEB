// ===================================================================================
// ARQUIVO: backend/services/emailService.js
// FUNÇÃO: Envio de alertas por e-mail (Otimizado para Gmail)
// ===================================================================================

const nodemailer = require('nodemailer');
const path = require('path');

// --- CONFIGURAÇÕES DE AMBIENTE ---
const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || 'true').toLowerCase() !== 'false';
const LOGO_CID = 'agrosilo_logo'; // Content ID para a logo

// --- 1. FUNÇÃO DE CRIAÇÃO DO TRANSPORTE (Apenas Gmail) ---
function buildTransport() {
  // Leitura das variáveis de ambiente com fallbacks seguros para Gmail
  const host = process.env.EMAIL_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.EMAIL_PORT || '465');
  // Se for a porta 465, 'secure' deve ser true. Se for a 587 (STARTTLS), 'secure' deve ser false.
  const secure = String(process.env.EMAIL_SECURE || 'true').toLowerCase() === 'true' && port === 465;

  return nodemailer.createTransport({
    host: host,
    port: port,
    secure: secure,
    auth: {
      user: process.env.EMAIL_USER,    // Seu e-mail
      pass: process.env.EMAIL_PASS     // Sua App Password do Gmail
    },
    // Adiciona timeouts de conexão para mitigar erros de rede como ETIMEDOUT no Render
    connectionTimeout: 30000, // 30 segundos para a conexão TCP
    greetingTimeout: 5000,    // 5 segundos para a saudação SMTP
  });
}

const transporter = buildTransport();

// --- 2. FUNÇÕES DE FORMATAÇÃO ---
function unitByType(type) {
  if (type === 'temperature') return '°C';
  if (type === 'humidity') return '%';
  if (type === 'pressure') return ' hPa';
  if (type === 'co2') return ' ppm';
  return '';
}

function sensorLabel(type) {
  return ({
    temperature: 'Temperatura',
    humidity: 'Umidade',
    pressure: 'Pressão',
    co2: 'CO₂'
  })[type] || type;
}

// --- 3. FUNÇÃO DE CONSTRUÇÃO DO HTML (Visual aprimorado) ---
function buildEmailHtml({ silo, sensorName, valueWithUnit, dateBR, alert }) {
  const colorByLevel = {
    critical: '#dc3545',
    warning:  '#ffc107',
    caution:  '#fd7e14'
  }[alert.level] || '#6c757d';

  return `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e9ecef; border-radius: 6px; overflow: hidden;">
    
    <div style="background: ${colorByLevel}; color: #fff; padding: 15px 20px; text-align: center; border-bottom: 5px solid ${colorByLevel};">
      <img src="cid:${LOGO_CID}" alt="Agrosilo Logo" style="max-height: 40px; margin-bottom: 10px; display: block; margin-left: auto; margin-right: auto;">
      <h1 style="margin: 0; font-size: 24px;">🚨 ALERTA: ${alert.level.toUpperCase()}</h1>
    </div>

    <div style="padding: 20px; background: #fff;">
      <h3 style="color: #343a40; border-bottom: 1px solid #dee2e6; padding-bottom: 10px;">Detalhes do Evento</h3>
      
      <p style="margin-bottom: 5px;"><strong style="color: #007bff;">Silo:</strong> ${silo}</p>
      <p style="margin-bottom: 5px;"><strong style="color: #007bff;">Sensor:</strong> ${sensorName}</p>
      <p style="margin-bottom: 5px;"><strong style="color: ${colorByLevel}; font-size: 1.2em;">Valor Encontrado:</strong> ${valueWithUnit}</p>
      <p style="margin-bottom: 20px;"><strong style="color: #6c757d;">Data/Hora:</strong> ${dateBR}</p>
      
      <div style="background: #f8f9fa; padding: 15px; border-left: 5px solid ${colorByLevel}; margin: 20px 0; border-radius: 4px;">
        <h4 style="margin-top: 0; color: ${colorByLevel};">Mensagem do Sistema:</h4>
        <p style="margin-bottom: 0;">${alert.message}</p>
      </div>
      
      <div style="background: #e8f4fd; padding: 15px; border-radius: 4px;">
        <h4 style="margin-top: 0; color: #007bff;">Recomendação de Ação:</h4>
        <p style="margin-bottom: 0;">${alert.recommendation}</p>
      </div>
    </div>

    <div style="padding: 10px; text-align: center; background: #343a40; color: #adb5bd; font-size: 0.8em;">
      <p style="margin: 0;">Este é um alerta automático do sistema Agrosilo.</p>
    </div>
  </div>`;
}

// --- 4. FUNÇÃO PRINCIPAL DE ENVIO (Com anexos) ---
async function sendAlertEmail(user, alertObj) {
  if (!EMAIL_ENABLED) return;
  if (!user?.email) return;

  const unit = unitByType(alertObj.sensor);
  const html = buildEmailHtml({
    silo: alertObj.silo,
    sensorName: sensorLabel(alertObj.sensor),
    valueWithUnit: `${alertObj.value}${unit}`,
    dateBR: new Date(alertObj.timestamp).toLocaleString('pt-BR'),
    alert: alertObj.alert
  });

  const mail = {
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: user.email,
    subject: `🚨 Agrosilo | ${alertObj.silo} | ${sensorLabel(alertObj.sensor)} | ${alertObj.alert.level.toUpperCase()}`,
    html: html,
    // Anexo da Logo via CID
    attachments: [
      {
        filename: 'logo.png',
        path: path.join(__dirname, '..', 'assets', 'logo.png'), 
        cid: LOGO_CID 
      }
    ]
  };

  try {
    const info = await transporter.sendMail(mail);
    console.log(`[EMAIL] Alerta enviado para ${user.email}. Mensagem ID: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error(`[EMAIL_ERRO] Falha ao enviar email para ${user.email}:`, error);
    throw error;
  }
}

module.exports = { sendAlertEmail, sensorLabel };