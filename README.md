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

A solução é organizada em uma arquitetura distribuída composta por módulos independentes, com dois fluxos de dados principais: o Fluxo de Monitoramento IoT e o Fluxo de Interação IA.

### Fluxo de Dados

*    A[ESP32 + DHT11 (Coleta Local)] --> B(ThingSpeak - Buffer IoT);
*    B --> C(FastAPI - ETL + Predict);
*    C(FastAPI) <--> D(MongoDB - Time-Series) (Consulta de dados);
*    D --> E(Backend Node.js - Auth, Alertas);
*    E --> F(Frontend - STT/TTS) <--> C(FastAPI - ETL + Predict - /ia/query);


**Componentes do Fluxo:**

*   **ESP32 + DHT11:** Camada de coleta de dados (sensores de temperatura e umidade).
*   **ThingSpeak:** Plataforma intermediária de buffer IoT (utiliza protocolo MQTT).
*   **FastAPI – ETL + Predict:** Serviço de processamento que realiza limpeza, normalização e *forecast* (previsão).
*   **MongoDB (Time-Series):** Camada de persistência otimizada para dados sequenciais.
*   **Backend Node.js:** Camada de API Gateway, responsável por autenticação (auth), MFA, alertas e exposição dos dados para o frontend.
*   **Frontend (HTML/CSS/JS):** Interface de usuário, incluindo as funcionalidades de Reconhecimento de Fala (STT) e Síntese de Fala (TTS) para o Ícaro.


## 4. 🧩 Arquitetura Completa do Sistema

*    A arquitetura do sistema segue um fluxo modular e sequencial:

*   Fluxo de Monitoramento
*            A[IoT (ESP32/DHT11)] --> B(ThingSpeak);
*            B --> C(FastAPI - ETL Pipeline);
*            C --> D(MongoDB - Time-series + índices);
*           D --> E(Node.js Backend);
*            E --> F(Frontend);
*    Fluxo de Interação IA (Ícaro)
*            F --> G(FastAPI - /ia/query);
*            G --> D;
*            D --> G;
*            G --> F;
*    FastAPI - ETL
*            C --> C1(limpeza/normalização);
*            C --> C2(cálculos estatísticos);
*            C --> C3(agregações / degrau térmico);
*            C --> C4(Previsão - Modelo Linear);

## 5. 🛠 Tecnologias Utilizadas

### 5.1 Frontend – HTML, CSS e JavaScript (Netlify)

O Frontend é construído com tecnologias web padrão (Vanilla), garantindo leveza e alta compatibilidade.

*   **HTML5 e CSS3:** Estrutura e estilização da interface.
*   **JavaScript (ES6+):** Lógica de interação e manipulação do DOM.
*   **Axios:** Biblioteca para consumo assíncrono da API (Backend Node.js e Pipeline ETL).
*   **Recharts:** Biblioteca para geração de gráficos analíticos e visualização de dados.
*   **JWT Authentication:** Gerenciamento de sessão e controle de acesso.
*   **QR Code View:** Implementação de visualização para o Multi-Factor Authentication (MFA).
*   **Layout:** Design responsivo para acesso em diferentes dispositivos.

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


## 🤖 Assistente de Voz IA – Ícaro

O **Ícaro** é o assistente de voz integrado ao Frontend, projetado para fornecer informações e relatórios sobre os silos de forma interativa e natural.

### 5.5 Funcionamento e Tecnologias

O Ícaro utiliza uma arquitetura de processamento de linguagem natural (NLP) e síntese de voz (TTS) para interagir com o usuário:

| Componente | Tecnologia | Finalidade |
| :--- | :--- | :--- |
| **Reconhecimento de Fala (STT)** | Web Speech API | Converte a voz do usuário em texto (comando). |
| **Síntese de Fala (TTS)** | `SpeechSynthesisUtterance` | Converte a resposta do sistema em voz (Voz do Ícaro). |
| **Processamento de Comando** | FastAPI (`/ia/query`) | Recebe o comando em texto e o processa. |
| **Inteligência** | Dados Consolidados + Groq (LLM) | Utiliza dados de `grain_assessments` e `alerts` para gerar respostas e relatórios técnicos. |

### 5.6 Exemplos de Comandos

O Ícaro pode ser acionado por voz ou texto para realizar consultas complexas, como:

*   "Ícaro, qual a temperatura e umidade do silo TESTE SILO?"
*   "Ícaro, me fale os alertas da última hora do silo TESTE SILO."
*   "Ícaro, gere um relatório técnico do silo TESTE SILO."

### 6.3 Fluxo Icaro no Sistema

                 🎤 Comando de Voz
                          ↓
               Icaro (STT + Interpretador)
                          ↓
      Backend Node.js (análises, alertas, PDFs)
                          ↓
            ETL FastAPI (previsões + estatística)
                          ↓
                     MongoDB
                          ↓
                Dashboard + TTS

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

## 📁 Estrutura do Projeto
Agrosilo-APP-WEB-MAIN/
├── .vscode/                              # Configurações do VS Code
├── agrosilo-ts-pipeline/                 # Pipeline ETL - FastAPI
│   ├── backend/
│   │   ├── app/
│   │   │   ├── analysis/                # Análises de dados
│   │   │   ├── auth/                    # Autenticação
│   │   │   ├── forescast_spark/         # Previsões com Spark
│   │   │   ├── ia/                      # Inteligência Artificial
│   │   │   ├── mfa/                     # Autenticação Multi-Fator
│   │   │   └── ...                      # Outros módulos
│   │   ├── .env                         # Variáveis de ambiente
│   │   ├── package-lock.json
│   │   ├── package.json
│   │   ├── requirements.txt             # Dependências Python
│   │   └── run.py                       # Ponto de entrada
│   └── ...
├── backend/                              # Backend Principal - Node.js
│   ├── assets/                          # Recursos estáticos
│   ├── config/                          # Configurações
│   ├── jobs/                            # Tarefas agendadas
│   ├── middleware/                      # Middlewares
│   ├── models/                          # Modelos de dados
│   ├── node_modules/                    # Dependências Node.js
│   ├── routes/                          # Rotas da API
│   ├── services/                        # Serviços de negócio
│   ├── .env                             # Variáveis de ambiente
│   ├── package-lock.json
│   ├── package.json
│   └── server.js                        # Ponto de entrada
├── frontend/                            # Frontend - React.js
│   ├── css/                             # Estilos CSS
│   ├── images/                          # Imagens e ícones
│   ├── js/                              # Scripts JavaScript
│   ├── pages/                           # Páginas da aplicação
│   └── index.html                       # Página principal
├── .gitignore                           # Arquivos ignorados pelo Git
└── README.md                            # Documentação principal

## 12. 🏁 Conclusão

O Agrosilo constitui uma solução completa para monitoramento inteligente de silos agrícolas, combinando IoT, ETL, análise de dados, previsões, segurança e interface moderna. A arquitetura modular permite expansão futura para:

*   Monitoramento de CO₂
*   Integração com modelos de machine learning mais avançados
*   Suporte a novos tipos de sensores
*   Previsões sazonais e térmicas mais robustas (Spark MLlib)

O sistema está pronto para uso acadêmico, demonstração comercial e evolução para produção.

