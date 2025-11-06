 # Agrosilo — IoT Grain Silo Monitoring (FastAPI + MongoDB + ThingSpeak)

> **Agrosilo** é uma pipeline IoT para monitoramento de silos de grãos (temperatura, umidade e pressão opcional) usando **ESP32 + DHT11 → ThingSpeak → FastAPI → MongoDB (time‑series)**, com tratamento de dados, avaliações operacionais (*assessments*), e endpoints para histórico e análises. O projeto demonstra princípios **SOLID**, qualidade de dados e execução **assíncrona** ponta a ponta.

##  Principais recursos
- Coleta assíncrona do ThingSpeak com `httpx` e *polling* configurável
- Tratamento de dados: parsing, normalização de timestamps (UTC), validação por **faixas físicas**, **anti‑salto** (spike filter) e ordenação temporal
- Persistência em **MongoDB time‑series** com índice único `{sensor, ts}` e **upsert idempotente**
- **Assessments** por (silo, ts) com limiares configuráveis, recomendações de **aeração** e *notes* operacionais
- API FastAPI com `/health`, `/trigger-sync`, `/history` e rotas `/analysis/*` (hist/aggregate/scatter/export/report)
- Configuração via **variáveis de ambiente**; semântica estável para logs e composição de dependências
- Aplicação dos princípios **SOLID**: SRP, OCP, LSP, ISP, DIP

##  Arquitetura 
```
IoT (ESP32/DHT11) → ThingSpeak → FastAPI (ThingSpeakClient)
                              → IngestService (parse, validar, anti‑salto, upsert) 
                              → MongoDB (time‑series + índices)
                              → AssessmentRepository (regras + deduplicação)
Frontend/Node ← API (/history, /trigger-sync, /analysis/*)
```

##  Estrutura (resumo)
```
agrosilo-ts-pipeline/
  backend/
    app/
      analysis/                 # rotas de análise (hist/agg/scatter/export/report)
      assessments.py            # repo de assessments: índice único (silo, ts) + dedup + upsert
      domain.py                 # entidades e portas (Protocols)
      repositories.py           # SensorRepository / ReadingRepository (time-series)
      services.py               # IngestService (tratamento/negócio)
      thingspeak_client.py      # cliente httpx para ThingSpeak
      api.py                    # composição FastAPI + scheduler
      utils.py                  # utilitários (ex.: CORS)
    .env                        # variáveis de ambiente (NÃO versionar)
    run.py                      # entrypoint uvicorn
  frontend/                     # páginas estáticas (dashboard)
  backend/ (node-proxy opcional)# server.js + rotas (se aplicável)
```

##  Variáveis de ambiente (exemplo)
Crie `backend/.env` com:
```
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

# Execução
POLL_SECONDS=15
SILO_ID=64f0...c9a          # ObjectId do silo no Mongo
API_HOST=0.0.0.0
API_PORT=8000
```

##  Como rodar (backend FastAPI)
```bash
# 1) Entrar no diretório do backend
cd agrosilo-ts-pipeline/backend

# 2) Criar e ativar venv (Windows PowerShell)
python -m venv .venv
. .venv/Scripts/Activate.ps1

# 3) Instalar dependências
pip install -r requirements.txt

# 4) Configurar .env (ver seção acima) e iniciar
python run.py
# ou: uvicorn app.api:app --host 0.0.0.0 --port 8000 --reload
```

##  SOLID na prática
- **SRP** – cada arquivo tem uma responsabilidade clara (coleta, regra, persistência, análises, orquestração)
- **OCP** – adicionar novo sensor (ex.: CO₂) estende `sync_all()` via `_sync_one`, sem modificar lógica existente
- **LSP** – repositórios podem ser substituídos por *fakes* em testes; *ports* definem contratos
- **ISP** – interfaces mínimas (somente métodos necessários por caso de uso)
- **DIP** – composição concreta em `api.py`; `IngestService` depende de abstrações (`ISensorRepository`, `IReadingRepository`)

##  Segurança e boas práticas
- Não comitar `.env` (use esteio de secrets)
- Restringir CORS em produção (domínios confiáveis)
- Validar entradas e tratar erros de rede (timeouts, backoff)
- Privilégios mínimos no Mongo (usuário com permissões limitadas)

##  Observabilidade (sugestões)
- Logs estruturados (JSON) para polling e ingestão
- Métricas (contagem recebidos/armazenados/descartados, latência, lag)
- Tracing distribuído (OpenTelemetry) se houver múltiplos serviços

##  Roadmap (idéias)
- Suporte a CO₂ e eventos de alerta (Telegram/Email)
- Cache curto para `/history`
- Painéis com charts no frontend
- Dockerfiles & Compose para dev/produção

## 📝 Licença
MIT (sugestão). Ajuste conforme sua necessidade.

---

## 🚀 Como subir para o GitHub (passo a passo)

> Pré‑requisitos: **Git** instalado e conta no GitHub.

### 1) Inicializar o repositório local
```bash
# na raiz do projeto (onde está o README)
git init
git config user.name "Seu Nome"
git config user.email "seu-email@exemplo.com"
```

### 2) Criar .gitignore e confirmar arquivos
Crie um `.gitignore` (veja abaixo) e então:
```bash
git add .
git commit -m "chore: inicializa projeto Agrosilo com backend FastAPI e docs"
```

### 3) Criar o repositório remoto
Via navegador: GitHub → New repository → **agrosilo** (público/privado) → *Create*.

Ou via CLI (se tiver o GitHub CLI):
```bash
gh repo create agrosilo --public --source=. --remote=origin --push
```

### 4) Vincular e enviar (se criou pelo navegador)
```bash
git remote add origin https://github.com/<seu-usuario>/agrosilo.git
git branch -M main
git push -u origin main
```

### 5) Criar releases/tags (opcional)
```bash
git tag -a v1.0.0 -m "Primeira versão estável do pipeline"
git push origin v1.0.0
```

---

## 📄 .gitignore recomendado (trecho)
Veja o arquivo `.gitignore` neste repositório para Python + Node + VSCode + env.
