// ---------------- VARIÁVEIS DE ESTADO ----------------

// Indica se o microfone está ouvindo o usuário (STT ligado)
let isListening = false;
// Indica se o Ícaro está falando (TTS em andamento)
let isSpeaking  = false;
// Utterance atual do speechSynthesis
let currentUtterance = null;

// Último payload estruturado retornado pela API do Ícaro.
// Usamos para exibir o relatório em tela e gerar o PDF.
let lastIaData = null;

// Referências aos elementos da página
const micButton       = document.getElementById('micButton');
const muteButton      = document.getElementById('muteButton');
const statusText      = document.getElementById('statusText');
const iaResponseText  = document.getElementById('iaResponseText');
const userCommandText = document.getElementById('userCommandText');
const examplesList    = document.getElementById('iaExamplesList');

// Entrada por texto
const textInput   = document.getElementById('iaTextInput');
const sendButton  = document.getElementById('iaSendButton');

// Área onde mostramos o relatório técnico completo
const reportBox   = document.getElementById('iaReportBox');
// Botão para baixar o PDF do relatório
const downloadBtn = document.getElementById('iaDownloadPdf');

// URL DIRETA da rota da IA no FastAPI (pipeline)
const FASTAPI_IA_URL =
  window.FASTAPI_IA_URL || 'http://127.0.0.1:8000/ia/query';

// Web Speech API (STT)
let recognition = null;
let hasSpeechRecognition = false;

// Voz do Ícaro (TTS)
let icaroVoice = null;

// Exemplos de comandos exibidos na tela
const ICARO_EXAMPLES = [
  'Ícaro, qual a temperatura e umidade do silo TESTE SILO?',
  'Ícaro, me fale os alertas da última hora do silo TESTE SILO.',
  'Ícaro, qual o status geral do silo TESTE SILO?',
  'Ícaro, gere um relatório técnico do silo TESTE SILO.',
];

// -------------- INICIALIZAÇÃO DA PÁGINA --------------
document.addEventListener('DOMContentLoaded', () => {
  // Garante que o usuário está logado; se não estiver, redireciona
  if (!requireAuth()) return;

  setupHeaderUI();         // Nome e papel do usuário no header
  initSpeechRecognition(); // Configura reconhecimento de fala
  initIcaroVoice();        // Seleciona voz do Ícaro
  renderExamples();        // Lista de exemplos

  // Mic: inicia/para escuta OU interrompe fala do Ícaro
  if (micButton) {
    micButton.addEventListener('click', toggleListeningOrStopSpeaking);
  }

  // Botão de "mudo": cancela qualquer fala em andamento
  if (muteButton) {
    muteButton.addEventListener('click', () => {
      stopIcaroVoice();
      statusText.textContent = 'Voz do Ícaro silenciada.';
    });
  }

  // Entrada por texto
  if (sendButton && textInput) {
    // Clique no botão "Enviar"
    sendButton.addEventListener('click', () => {
      const command = textInput.value.trim();
      if (!command) {
        statusText.textContent = 'Digite um comando antes de enviar.';
        return;
      }
      processRecognizedCommand(command);
    });

    // Atalho: Ctrl+Enter (ou Command+Enter) envia o comando
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendButton.click();
      }
    });
  }

  // Botão de download do PDF
  if (downloadBtn) {
    downloadBtn.addEventListener('click', downloadIaReportPdf);
  }

  statusText.textContent =
    'Pronto. Clique no microfone ou digite um comando para falar com o Ícaro.';
});

// -------------- HEADER (NOME DO USUÁRIO) --------------

function setupHeaderUI() {
  const user = getCurrentUser() || {};
  setText('userName', user.name || 'Usuário');
  setText('userRole', user.role === 'admin' ? 'Administrador' : 'Usuário');
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// -------------- EXEMPLOS DE COMANDOS --------------

function renderExamples() {
  if (!examplesList) return;

  examplesList.innerHTML = '';
  ICARO_EXAMPLES.forEach((ex) => {
    const li = document.createElement('li');
    li.textContent = ex;
    examplesList.appendChild(li);
  });
}

// -------------- CONFIGURAÇÃO STT (RECONHECIMENTO) --------------

function initSpeechRecognition() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    console.warn('SpeechRecognition não suportado. Usando fallback com prompt().');
    hasSpeechRecognition = false;
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'pt-BR';
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onstart = () => {
    isListening = true;
    if (micButton) micButton.classList.add('listening');
    statusText.textContent = 'Ouvindo... Fale seu comando.';
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    console.log('Reconhecido:', transcript);
    processRecognizedCommand(transcript);
  };

  recognition.onerror = (event) => {
    console.error('Erro no reconhecimento de fala:', event.error);
    statusText.textContent = 'Não consegui entender. Tente novamente.';
    isListening = false;
    if (micButton) micButton.classList.remove('listening');
  };

  recognition.onend = () => {
    isListening = false;
    if (micButton) micButton.classList.remove('listening');
    if (!statusText.textContent.startsWith('Resposta')) {
      statusText.textContent =
        'Pronto. Clique no microfone ou digite um comando novamente.';
    }
  };

  hasSpeechRecognition = true;
  console.log('SpeechRecognition inicializado com sucesso.');
}

// -------------- CONFIGURAÇÃO TTS (VOZ DO ÍCARO) --------------

function initIcaroVoice() {
  if (!('speechSynthesis' in window)) {
    console.warn('speechSynthesis não suportado.');
    return;
  }

  function selectIcaroVoice() {
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return;

    // Preferência: vozes pt-BR (normalmente femininas/masculinas em pt-BR)
    const ptVoices = voices.filter(
      (v) => v.lang && v.lang.toLowerCase().startsWith('pt-br')
    );

    icaroVoice = ptVoices[0] || voices[0] || null;

    if (icaroVoice) {
      console.log('Voz do Ícaro selecionada:', icaroVoice.name, icaroVoice.lang);
    }
  }

  window.speechSynthesis.onvoiceschanged = selectIcaroVoice;
  selectIcaroVoice();
}

// -------------- FALLBACK STT (PROMPT) ----------------

function fallbackPromptSTT() {
  const command = prompt(
    'Fale seu comando (ex: "Ícaro, qual a temperatura e umidade do silo TESTE SILO?"):'
  );
  return command;
}

// -------------- CONTROLE DE FALA (TTS) ----------------

function stopIcaroVoice() {
  // Se o navegador não suportar speechSynthesis, não faz nada
  if (!('speechSynthesis' in window)) return;

  // Cancela qualquer fala em andamento
  window.speechSynthesis.cancel();
  isSpeaking = false;
  currentUtterance = null;

  // Remove o efeito visual de "falando" do microfone
  if (micButton) {
    micButton.classList.remove('speaking');
  }
}

function simulateTTS(text) {
  console.log('Ícaro diz:', text);
  iaResponseText.textContent = text;

  if (!('speechSynthesis' in window)) return;

  // Se já estiver falando algo, cancela antes da nova fala
  stopIcaroVoice();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'pt-BR';

  if (icaroVoice) {
    utterance.voice = icaroVoice;
  }

  // Ajuste leve de tom e velocidade
  utterance.pitch = 1.1;  // um pouco mais agudo
  utterance.rate  = 0.98; // fala levemente mais pausada

  utterance.onstart = () => {
    isSpeaking = true;
    statusText.textContent = 'Ícaro está falando...';

    if (micButton) {
      micButton.classList.add('speaking');
    }
  };

  utterance.onend = () => {
    isSpeaking = false;
    currentUtterance = null;

    if (micButton) {
      micButton.classList.remove('speaking');
    }

    if (!isListening) {
      statusText.textContent =
        'Pronto. Clique no microfone ou digite outro comando.';
    }
  };

  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

// ------------------ LÓGICA PRINCIPAL ------------------

// Mic agora faz duas coisas:
// - Se Ícaro está falando -> para a fala.
// - Se não está falando -> alterna escuta (start/stop mic).
async function toggleListeningOrStopSpeaking() {
  // 1) Se Ícaro estiver falando, este clique serve como STOP da fala
  if (isSpeaking) {
    stopIcaroVoice();
    statusText.textContent =
      'Fala interrompida. Clique novamente para falar com o Ícaro.';
    return;
  }

  // 2) Caso contrário, controla o microfone (como antes)
  if (isListening) {
    if (recognition) recognition.stop();
    isListening = false;
    if (micButton) micButton.classList.remove('listening');
    statusText.textContent =
      'Pronto. Clique no microfone para começar a falar.';
    return;
  }

  if (hasSpeechRecognition && recognition) {
    try {
      recognition.start();
    } catch (e) {
      console.error('Erro ao iniciar o reconhecimento:', e);
      statusText.textContent =
        'Não consegui acessar o microfone. Verifique as permissões.';
    }
  } else {
    const command = fallbackPromptSTT();
    if (command && command.trim().length > 0) {
      processRecognizedCommand(command);
    } else {
      statusText.textContent = 'Comando cancelado ou vazio.';
      simulateTTS('Por favor, diga seu comando novamente.');
    }
  }
}

/**
 * Tratamento comum para qualquer comando reconhecido (voz ou texto digitado).
 */
async function processRecognizedCommand(command) {
  statusText.textContent = 'Processando comando...';
  userCommandText.textContent = `Você disse: "${command}"`;
  userCommandText.style.display = 'block';

  await sendCommandToIA(command);
}

/**
 * Envia o comando em texto para o backend FastAPI (rota /ia/query).
 * Atualiza:
 *  - fala do Ícaro (reply)
 *  - bloco de relatório em tela
 *  - estado para geração de PDF
 */
async function sendCommandToIA(command) {
  try {
    const response = await fetch(FASTAPI_IA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: command }),
    });

    if (!response.ok) {
      throw new Error(`Erro HTTP: ${response.status}`);
    }

    const data = await response.json();
    console.log('Resposta estruturada do Ícaro:', data);

    statusText.textContent = 'Resposta do Ícaro:';

    const replyText = data.reply || 'Não recebi uma resposta do Ícaro.';
    simulateTTS(replyText);

    // -------- Atualiza dados estruturados (relatório, métricas, etc.) --------
    lastIaData = data.data || null;

    // Exibe o relatório técnico agronômico (se existir)
    if (lastIaData && lastIaData.report_text) {
      if (reportBox) {
        reportBox.textContent = lastIaData.report_text;
      }
      if (downloadBtn) {
        // Mostra botão de download do PDF
        downloadBtn.style.display = 'inline-flex';
      }
    } else {
      // Nenhum relatório retornado para este comando
      if (reportBox) {
        reportBox.textContent =
          'Nenhum relatório técnico retornado para este comando.\n' +
          'Peça, por exemplo: "Ícaro, gere um relatório técnico do silo TESTE SILO."';
      }
      if (downloadBtn) {
        downloadBtn.style.display = 'none';
      }
    }
  } catch (error) {
    console.error('Erro ao comunicar com a API da IA (FastAPI):', error);
    statusText.textContent = 'Erro de comunicação.';
    simulateTTS(
      'Desculpe, não consegui me comunicar com o servidor da IA. Verifique a conexão.'
    );

    lastIaData = null;
    if (downloadBtn) {
      downloadBtn.style.display = 'none';
    }
  }
}

// ------------------ GERAÇÃO DE PDF ------------------

/**
 * Gera um PDF no padrão inspirado no seu layout:
 *  - Título: "Relatório Técnico de Alertas – Agrosilo"
 *  - Nível: Todos
 *  - Silo, Período (última hora), Gerado em e Total de alertas
 *  - Corpo: texto completo de report_text retornado pelo Ícaro
 */
function downloadIaReportPdf() {
  if (!lastIaData || !lastIaData.report_text) {
    alert('Nenhum relatório técnico disponível para download.');
    return;
  }

  if (!window.jspdf || !window.jspdf.jsPDF) {
    console.error('jsPDF não carregado.');
    alert('Biblioteca jsPDF não carregada.');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({
    unit: 'pt',
    format: 'a4',
  });

  const marginLeft = 40;
  let y = 60;
  const lineHeight = 16;
  const maxWidth = 515;

  const siloName  = lastIaData.silo_name || 'Silo não informado';
  const tsRecife  = lastIaData.ts_recife ? new Date(lastIaData.ts_recife) : null;
  const nowStr    = new Date().toLocaleString('pt-BR');
  const alertsArr = Array.isArray(lastIaData.alerts_last_hour)
    ? lastIaData.alerts_last_hour
    : [];
  const totalAlerts = alertsArr.length;

  // ---- Cabeçalho (título padrão) ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  const title = 'Relatório Técnico de Alertas – Agrosilo';
  doc.text(title, marginLeft, y);
  y += 30;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);

  // Nível (simplificado; aqui você pode melhorar se quiser)
  doc.text('Nível: Todos', marginLeft, y);
  y += lineHeight;

  // Silo correto
  doc.text(`Silo: ${siloName}`, marginLeft, y);
  y += lineHeight;

  // Período: última hora com base em ts_recife, se disponível
  if (tsRecife instanceof Date && !isNaN(tsRecife)) {
    const endStr = tsRecife.toLocaleString('pt-BR');
    const startDate = new Date(tsRecife.getTime() - 60 * 60 * 1000);
    const startStr = startDate.toLocaleString('pt-BR');
    doc.text(`Período: ${startStr} -> ${endStr}`, marginLeft, y);
    y += lineHeight;
  }

  // Data/hora de geração do PDF
  doc.text(`Gerado em: ${nowStr}`, marginLeft, y);
  y += lineHeight;

  // Total de alertas (usando alerts_last_hour)
  doc.text(`Total de alertas (última hora): ${totalAlerts}`, marginLeft, y);
  y += lineHeight * 2;

  // Corpo do relatório técnico (texto vindo do Ícaro – report_text)
  const bodyLines = doc.splitTextToSize(lastIaData.report_text, maxWidth);
  doc.text(bodyLines, marginLeft, y);

  // Nome do arquivo: normaliza o nome do silo
  const safeSilo = siloName.toString().replace(/[^\w\-]+/g, '_');
  doc.save(`relatorio_tecnico_${safeSilo}.pdf`);
}
