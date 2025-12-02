## 🚀 Agrosilo – Sistema de Monitoramento Inteligente de Silos Agrícolas

**Projeto Integrador – Faculdade SENAC**
**Equipe:** Edson Santana Alves, Juliana Reis, Nycole Jenifer, Patrícia Betânia, Ricardo Pereira
**Data:** Dezembro/2025

## 1. 🎯 Objetivo do Sistema

O Agrosilo é uma plataforma **IoT** (Internet das Coisas) desenvolvida para o monitoramento remoto de silos agrícolas. O sistema visa fornecer dados em tempo real e análises preditivas para a gestão da qualidade dos grãos, permitindo acompanhar:

*   Temperatura interna
*   Umidade relativa
*   Tendências térmicas
*   Histórico e análise temporal
*   Alertas inteligentes
*   Previsões futuras (modelo linear)

O sistema utiliza sensores conectados a dispositivos **ESP32** que enviam dados automaticamente para a nuvem, onde são tratados, analisados e disponibilizados ao usuário.

## 2. 🌐 Deploys do Sistema

| Serviço | URL |
| :--- | :--- |
| **Frontend (Netlify)** | [https://agrosilo-monitoramento-de-silos.netlify.app/](https://agrosilo-monitoramento-de-silos.netlify.app/) |
| **Pipeline ETL (FastAPI – Render)** | [https://agrosilo-ts-pipeline.onrender.com/docs](https://agrosilo-ts-pipeline.onrender.com/docs) |
| **Repositório GitHub** | [https://github.com/edsonsantana1/Agrosilo-APP-WEB](https://github.com/edsonsantana1/Agrosilo-APP-WEB) |

## 3. 🧱 Arquitetura Geral do Sistema

A solução é organizada em uma arquitetura distribuída composta por 4 camadas principais, seguindo um fluxo de dados sequencial e modular:

### Fluxo de Dados

*    A[ESP32 + DHT11 (Coleta Local)] --> B(ThingSpeak - Buffer IoT);
*    B --> C(FastAPI - ETL + Predict);
*    C --> D(MongoDB - Time-Series);
*    D --> E(Backend Node.js - Auth, Alertas);
*    E --> F(Frontend React);


**Componentes do Fluxo:**

*   **ESP32 + DHT11:** Camada de coleta de dados (sensores de temperatura e umidade).
*   **ThingSpeak:** Plataforma intermediária de buffer IoT (utiliza protocolo MQTT).
*   **FastAPI – ETL + Predict:** Serviço de processamento que realiza limpeza, normalização e *forecast* (previsão).
*   **MongoDB (Time-Series):** Camada de persistência otimizada para dados sequenciais.
*   **Backend Node.js:** Camada de API Gateway, responsável por autenticação (auth), MFA, alertas e exposição dos dados para o frontend.
*   **Frontend React:** Interface de usuário.


## 4. 🧩 Arquitetura Completa do Sistema

A arquitetura do sistema segue um fluxo modular e sequencial:


IoT (ESP32/DHT11) → ThingSpeak → FastAPI (ThingSpeakClient)
                              → (FastAPI – ETL Pipeline - agrosilo-ts-pipeline) → (limpeza/normalização) + (cálculos estatísticos) + (agregações / degrau térmico)
                              → (MongoDB - Time‑series + índices)
                              → (Node.js Backend - autenticação, alertas, MFA, email)
Frontend (React.js Frontend - Netlify)


## 5. 🛠 Tecnologias Utilizadas

### 5.1 Frontend – React.js (Netlify)

*   **React 18:** Framework principal.
*   **Axios:** Para consumo da API.
*   **Recharts:** Biblioteca para geração de gráficos analíticos.
*   **Styled Components:** Utilizado para o *design system*.
*   **React Router:** Para navegação.
*   **Context API:** Para gestão global de estado.
*   **JWT Authentication:** Para controle de sessão.
*   **QR Code View:** Para MFA.
*   **Layout:** Responsivo.

> **🏆 Responsável pela UI do Dashboard, telas de Análise, Alertas e Perfil.**

### 5.2 Backend Principal – Node.js (Render)

*   **Node.js 22:** Ambiente de execução.
*   **Express.js:** Framework web.
*   **Axios:** Utilizado como *proxy* para o serviço ETL/Pipeline (FastAPI).
*   **JWT + Bcrypt:** Para autenticação e *hash* de senhas.
*   **Nodemailer:** Para envio de alertas por e-mail.
*   **node-cron:** Para agendamento de coleta e alertas.
*   **http-proxy-middleware:** Para o *proxy* de MFA.
*   **PDFKit:** Para geração de relatórios PDF.
*   **MongoDB/Mongoose:** Para ORM e conexão com o banco de dados.

> **🏆 Camada que controla usuários, silos, sensores, leituras, alertas e relatórios.**

### 5.3 Pipeline ETL – FastAPI (Python 3.10)

*   **FastAPI 0.115:** Framework web de alta performance.
*   **Motor:** Cliente assíncrono do MongoDB.
*   **Pandas / NumPy:** Para manipulação e cálculo de dados.
*   **Scikit-Learn / PySpark MLlib:** Para modelos de regressão linear e previsão.
*   **Dotenv:** Para gestão de variáveis de ambiente.
*   **ReportLab:** Para geração de relatórios.
*   **PyOTP + QRCode:** Para MFA opcional.

> **🏆 Responsável por limpeza, transformação e previsão estatística dos dados.**

### 5.4 Banco de Dados – MongoDB Atlas

| Coleção | Tipo | Finalidade |
| :--- | :--- | :--- |
| `readings` | Time-Series | Leituras de Temperatura e Umidade por sensor. |
| `alerts` | Document | Alertas gerados pelo backend. |
| `silos` | Document | Dados de cada silo cadastrado. |
| `sensors` | Document | Configuração dos sensores. |
| `users` | Document | Credenciais + MFA Setup. |
| `grain_assessments` | Document | Análises adicionais. |

## 6. 📊 Gráficos Utilizados no Frontend

| Tela | Gráfico | Propósito |
| :--- | :--- | :--- |
| **Dashboard** | LineChart | Evolução de T° e Umidade em tempo real. |
| **Análises Avançadas** | ScatterChart | Correlação entre variáveis. |
| | BarChart | Média mensal (agregação temporal). |
| | AreaChart | Perfil sazonal dos silos. |
| | MultiLineChart | Picos térmicos e comportamento diário. |
| **Alertas** | Lista dinâmica | Classificação por zona de risco. |

## 7. 🔒 Segurança e MFA

O sistema implementa um robusto esquema de segurança:

*   **Hash de senhas:** Utiliza **Bcrypt**.
*   **Sessão Autenticada:** Gerenciada por **JWT** (JSON Web Tokens).
*   **MFA (TOTP):** Implementado via **Google Authenticator**, com o backend expondo *endpoints* para registro/verificação e geração dinâmica de **QR Code**.

## 8. ⚙️ Instalação e Execução do Projeto

### 8.1 Requisitos

*   **Node.js 18+**
*   **Python 3.10+**
*   **MongoDB Atlas** ou local

### 8.2 Instalação e Execução por Componente

| Componente | Diretório | Instalação | Execução |
| :--- | :--- | :--- | :--- |
| **Frontend** | `frontend` | `npm install` | `npm start` |
| **Backend Node.js** | `backend` | `npm install` | `npm start` |
| **ETL – FastAPI** | `agrosilo-ts-pipeline` | `pip install -r requirements.txt` | `python run.py` |

### 9. Variáveis de Ambiente (.env)

A solução utiliza dois ambientes independentes (`backend/.env` e `agrosilo-ts-pipeline/.env`).

#### 9.1 Backend (`backend/.env`)

dotenv
#### ===== MongoDB =====
MONGODB_URI=mongodb+srv://<usuario>:<senha>@host/Agrosilo
MONGODB_DB=agrosilo

#### ===== ThingSpeak =====
THINGSPEAK_CHANNEL_ID=111111
THINGSPEAK_READ_API_KEY=XXXXXX
TS_FIELD_TEMP=1
TS_FIELD_HUM=2
TS_FETCH_RESULTS=100

#### ===== Email =====
EMAIL_ENABLED=true
EMAIL_USER=xxxx@gmail.com
EMAIL_PASS=xxxx xxxx xxxx
EMAIL_INTERVAL_CRITICAL_MS=120000
EMAIL_INTERVAL_WARNING_MS=300000
EMAIL_INTERVAL_CAUTION_MS=1800000

#### ===== Notificador =====
ALERT_NOTIFIER_TICK_MS=60000

#### ===== Execução =====
POLL_SECONDS=15
API_PORT=8001
API_HOST=0.0.0.0

#### 9.2 ETL Pipeline (`agrosilo-ts-pipeline/.env`)

dotenv
#### ===== Mongo =====
MONGODB_URI=mongodb+srv://<usuario>:<senha>@host
MONGODB_DB=agrosilo

#### ===== ThingSpeak =====
THINGSPEAK_URL=https://api.thingspeak.com/channels
THINGSPEAK_CHANNEL_ID=111111
THINGSPEAK_READ_KEY=XXXXXX
THINGSPEAK_RESULTS=200

#### ===== Forecast =====
FORECAST_WINDOW_DAYS=14
FORECAST_MODEL=scikit  # ou spark

#### ===== Execução =====
API_HOST=0.0.0.0
API_PORT=8000


## 10. 🧪 Funcionalidades Técnicas Concluídas

*   ✔ IoT + coleta automática
*   ✔ Pipeline ETL com limpeza/normalização
*   ✔ Previsão térmica (modelo linear)
*   ✔ Exportação em PDF e CSV
*   ✔ CRUD completo de silos e sensores
*   ✔ Autenticação + MFA
*   ✔ Alertas automáticos (e-mail + níveis)
*   ✔ Dashboard interativo
*   ✔ Análises avançadas
*   ✔ Arquitetura escalável
*   ✔ Deploy CI/CD Render + Netlify

## ⚙️ Variáveis de Ambiente (Exemplo)

## 11. 🏁 Conclusão

O Agrosilo constitui uma solução completa para monitoramento inteligente de silos agrícolas, combinando IoT, ETL, análise de dados, previsões, segurança e interface moderna. A arquitetura modular permite expansão futura para:

*   Monitoramento de CO₂
*   Integração com modelos de machine learning mais avançados
*   Suporte a novos tipos de sensores
*   Previsões sazonais e térmicas mais robustas (Spark MLlib)

O sistema está pronto para uso acadêmico, demonstração comercial e evolução para produção.

