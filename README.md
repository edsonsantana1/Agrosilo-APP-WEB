# 🚀 Agrosilo – Plataforma de Monitoramento de Silos Inteligentes

**Sistema de coleta, análise e monitoramento de temperatura e umidade em silos agrícolas.**

## Deploys

| Serviço | URL |
| :--- | :--- |
| **Frontend (Netlify)** | [https://agrosilo-monitoramento-de-silos.netlify.app/](https://agrosilo-monitoramento-de-silos.netlify.app/) |
| **Repositório GitHub** | [https://github.com/edsonsantana1/Agrosilo-APP-WEB](https://github.com/edsonsantana1/Agrosilo-APP-WEB) |

## 📝 Visão Geral do Projeto

O Agrosilo é uma plataforma digital desenvolvida para produtores rurais monitorarem, em tempo real, as condições internas de seus silos — especialmente temperatura e umidade, fatores que determinam perdas, proliferação de fungos e variações na qualidade dos grãos.

O sistema integra os seguintes componentes:

*   Dispositivo IoT (DHT11 + ESP32)
*   ThingSpeak (coleta intermediária)
*   FastAPI Pipeline (ETL e limpeza de dados)
*   Node.js (backend principal + alertas + controle de usuários)
*   React.js (frontend responsivo)
*   MongoDB (time-series para armazenamento dos dados)
*   Sistema MFA (2FA)

## 🧩 Arquitetura Completa do Sistema

A arquitetura do sistema segue um fluxo modular e sequencial:

```
IoT (ESP32/DHT11) → ThingSpeak → FastAPI (ThingSpeakClient)
                              → (FastAPI – ETL Pipeline - agrosilo-ts-pipeline) → (limpeza/normalização) + (cálculos estatísticos) + (agregações / degrau térmico)
                              → (MongoDB - Time‑series + índices)
                              → (Node.js Backend - autenticação, alertas, MFA, email)
Frontend (React.js Frontend - Netlify)
```

## 🛠 Tecnologias Utilizadas

### Frontend (React.js – Netlify)

*   Axios
*   Recharts (gráficos)
*   Styled Components
*   Context API
*   JWT Auth
*   Dashboard Responsivo

### Backend Node.js

*   Node.js 22
*   Express
*   Axios (proxy para FastAPI)
*   JWT / Middleware de autenticação
*   Nodemailer (envio de emails)
*   Bcrypt (hash de senhas)
*   Scheduler (notificações)
*   MFA 2FA via TOTP (Google Authenticator)

### FastAPI – ETL Pipeline

*   FastAPI 0.115
*   Motor (MongoDB client)
*   Python Dotenv
*   Pandas, NumPy
*   PyOTP (2FA)
*   QrCode PIL
*   Relatórios: ReportLab
*   Previsão: Scikit-Learn / PySpark

### Banco de Dados

*   MongoDB Atlas
*   **Coleções:**
    *   `readings` (Time-Series)
    *   `alerts`
    *   `users`
    *   `grain_assessments`
    *   `sensors`
    *   `silos`

## 📊 Gráficos Utilizados nas Telas

| Tela | Gráfico | Componentes/Detalhes |
| :--- | :--- | :--- |
| **Dashboard – Tela Inicial** | LineChart – Temperatura x Tempo | Tooltip, CartesianGrid, XAxis, YAxis, Legend |
| | LineChart – Umidade x Tempo | |
| **Análises Avançadas** | ScatterChart – Correlação T/U | |
| | BarChart – Médias Mensais | |
| | AreaChart – Perfil Sazonal | |
| | LineChart (multiline) – Picos e variações | |
| **Alertas** | Lista dinâmica com níveis | Normal, Atenção, Crítico. Cores por risco. Telas de detalhes. |
| **Usuários / Login / MFA** | Telas responsivas | QR Code para MFA (Google Authenticator). Flow completo de registro → ativação → verificação. |

## 🖼 Telas do Sistema

*   ✔ Login e Registro (com MFA)
*   ✔ Dashboard Principal
*   ✔ Análises
*   ✔ Histórico por Silo
*   ✔ Alertas
*   ✔ Perfil do Usuário

> **Observação:** As telas Usuários, Análise e Alertas ainda não estão totalmente responsivas para mobile.

## 🧪 Funcionalidades Implementadas

*   ✔ Coleta automática via IoT
*   ✔ ETL com tratamento de dados
*   ✔ Previsão de comportamento térmico (FastAPI)
*   ✔ Relatórios em PDF
*   ✔ CSV export
*   ✔ Notificações automáticas
*   ✔ MFA via Google Authenticator
*   ✔ Sistema de login + JWT
*   ✔ Painel de tendências
*   ✔ Alertas Inteligentes

## Variáveis de Ambiente (Exemplo)

Crie `backend/.env` e `agrosilo-ts-pipeline/backend/.env` com as seguintes variáveis:

\`\`\`dotenv
# Mongo
MONGODB_URI=mongodb+srv://usuario:senha@host/db?retryWrites=true&w=majority
MONGODB_DB=agrosilo

# ThingSpeak
THINGSPEAK_CHANNEL_ID=123456
THINGSPEAK_READ_API_KEY=SEU_API_KEY
TS_FIELD_TEMP=1
TS_FIELD_HUM=2
# TS_FIELD_PRESS=3           # opcional
TS_FETCH_RESULTS=100

# Se usar Gmail (cota baixa; em produção prefira SendGrid/SES)
# Gmail
EMAIL_ENABLED=true
EMAIL_USER=agrosilo2025@gmail.com
EMAIL_PASS=ydud ududu dudud ouid
##EMAIL_MIN_INTERVAL_MS=120000     # 2 minutos

# ===== Janelas por nível (e-mail) =====
EMAIL_INTERVAL_CRITICAL_MS=120000      # 2 min
EMAIL_INTERVAL_WARNING_MS=300000       # 5 min
EMAIL_INTERVAL_CAUTION_MS=1800000      # 30 min

# ===== Notifier =====
ALERT_NOTIFIER_TICK_MS=60000           # verifica a cada 1 min


# Execução
POLL_SECONDS=15
SILO_ID=64f0...c9a          # ObjectId do silo no Mongo
API_HOST=0.0.0.0
API_PORT=8000
\`\`\`

## 🔧 Instalação e Execução (Desenvolvedores)

| Serviço | Comandos |
| :--- | :--- |
| **Frontend** | \`\`\`bash\ncd frontend\nnpm install\nnpm start\n\`\`\` |
| **Backend Node** | \`\`\`bash\ncd backend\nnpm install\nnpm start\n\`\`\` |
| **Pipeline FastAPI** | \`\`\`bash\ncd agrosilo-ts-pipeline\npip install -r requirements.txt\npython run.py\n\`\`\` |

## 📚 Equipe

**Projeto Acadêmico – Faculdade Estácio**
**Grupo 2 – Agrosilo**

*   Edson
*   Juliana
*   Patricia
*   Ricardo
*   Nycole

## 🏁 Conclusão

O Agrosilo é um sistema completo para monitoramento inteligente de silos, unindo IoT, análise de dados, previsões, alertas e uma interface amigável. A arquitetura modular permite evoluções rápidas e integrações com novos sensores e algoritmos.

