"""
Módulo principal FastAPI do pipeline Agrosilo.

Aqui nós:

- Carregamos variáveis de ambiente do .env.
- Criamos o objeto FastAPI com CORS liberado.
- Conectamos ao MongoDB usando Motor (async).
- Inicializamos repositórios (sensors, readings, assessments).
- Criamos o serviço de ingestão (IngestService) que lê do ThingSpeak
  e grava em `readings`.
- Disparamos uma tarefa assíncrona de polling periódico.
- Registramos os routers:
    - /analysis/*        (consultas, séries, relatórios)
    - /auth/mfa/*        (MFA)
    - /analysis/forecast/* (previsão com scikit-learn / PySpark-like)
"""

import os
import asyncio
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

# 🔑 Carrega o .env ANTES de importar routers/módulos que leem o ambiente
# (assim MONGODB_URI, MONGODB_DB, CHAVES, etc. já estarão disponíveis)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

from .thingspeak_client import ThingSpeakClient
from .repositories import SensorRepository, ReadingRepository
from .services import IngestService
from .assessments import AssessmentRepository

# Routers (importados depois de carregar o .env)
from .analysis.router import router as analysis_router
from .mfa.router import router as mfa_router
from .forecast_spark.router import router as forecast_router


# Objetos globais (serão inicializados no startup)
mongo_client: Optional[AsyncIOMotorClient] = None
sensor_repo: Optional[SensorRepository] = None
reading_repo: Optional[ReadingRepository] = None
ts_client: Optional[ThingSpeakClient] = None
ingestion_service: Optional[IngestService] = None
assessment_repo: Optional[AssessmentRepository] = None
polling_task: Optional[asyncio.Task] = None

# Intervalo padrão do polling (segundos) para buscar dados no ThingSpeak
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "15"))


# -------------------------------------------------------------------
# Tarefa periódica de polling (ThingSpeak -> MongoDB)
# -------------------------------------------------------------------
async def periodic_poll(svc: IngestService):
    """
    Loop assíncrono que chama `svc.sync_all()` em intervalo fixo.

    Enquanto o servidor está rodando, essa tarefa fica:
        - Iniciando ciclo de polling
        - Chamando svc.sync_all()
        - Aguardando POLL_SECONDS segundos
    """
    while True:
        try:
            print("--- [SCHEDULER] Iniciando ciclo de polling ---")
            await svc.sync_all()
            print(f"--- [SCHEDULER] Fim do ciclo. Aguardando {POLL_SECONDS}s ---")
            await asyncio.sleep(POLL_SECONDS)
        except asyncio.CancelledError:
            # Encerramento gracioso (shutdown do servidor)
            print("[SCHEDULER] Cancelado.")
            raise
        except Exception as e:
            # Em caso de erro, loga e espera um pouco mais antes de tentar de novo
            print(f"[SCHEDULER] ERRO: {e}")
            await asyncio.sleep(POLL_SECONDS * 2)


# -------------------------------------------------------------------
# Factory para criar a aplicação FastAPI
# -------------------------------------------------------------------
def create_app() -> FastAPI:
    """
    Cria e configura a aplicação FastAPI:

    - Define CORS aberto (pode ajustar depois).
    - Registra eventos de startup/shutdown.
    - Registra rotas /health e /trigger-sync.
    - Inclui routers de análise, MFA e forecast.
    """
    app = FastAPI(title="Agrosilo Pipeline")

    # Configuração básica de CORS (origens liberadas)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Endpoint simples de health check
    @app.get("/health")
    async def health():
        return {"ok": True}

    # ------------------------ STARTUP ------------------------
    @app.on_event("startup")
    async def _startup():
        """
        Configurações executadas quando o servidor inicia:

        - Conexão com MongoDB (Motor).
        - Cria repositórios (sensors, readings, assessments).
        - Configura ThingSpeakClient e IngestService.
        - Inicia a tarefa assíncrona de polling periódico.
        - Loga todas as rotas registradas (ajuda no debug).
        """
        global mongo_client, sensor_repo, reading_repo, ts_client
        global ingestion_service, assessment_repo, polling_task

        # Carrega variáveis de ambiente
        mongo_uri = os.getenv("MONGODB_URI")
        mongo_db = os.getenv("MONGODB_DB", "agrosilo")
        if not mongo_uri:
            raise RuntimeError("MONGODB_URI não definido no ambiente.")

        # Conexão async com MongoDB
        mongo_client = AsyncIOMotorClient(mongo_uri, serverSelectionTimeoutMS=6000)
        db = mongo_client[mongo_db]
        app.state.db = db  # deixa disponível para outros componentes, se necessário

        # Repositórios principais
        sensor_repo = SensorRepository(db)
        reading_repo = ReadingRepository(db)

        # Repositório das avaliações/assessments (faixas, etc.)
        assessment_repo = AssessmentRepository(db)
        try:
            await assessment_repo.ensure_indexes()
        except Exception as e:
            print(f"[STARTUP] Falha ao garantir índices de assessments: {e}")

        # Cliente ThingSpeak (lê canais e campos configurados)
        ts_client = ThingSpeakClient()

        # Serviço de ingestão, que usa ThingSpeak + repositórios para gravar leituras
        ingestion_service = IngestService(
            ts_client=ts_client,
            sensor_repo=sensor_repo,
            reading_repo=reading_repo,
        )
        ingestion_service.set_assessment_repo(assessment_repo)

        # Cria tarefa assíncrona para polling periódico
        polling_task = asyncio.create_task(periodic_poll(ingestion_service))
        print(f"[STARTUP] Polling iniciado a cada {POLL_SECONDS}s.")

        # Log das rotas registradas (útil para ver se /analysis/forecast está ok)
        for r in app.router.routes:
            try:
                print("[ROUTE]", r.methods, getattr(r, "path", None))
            except Exception:
                pass

    # ------------------------ SHUTDOWN ------------------------
    @app.on_event("shutdown")
    async def _shutdown():
        """
        Limpeza executada quando o servidor é encerrado:

        - Cancela a tarefa de polling.
        - Fecha a conexão com o MongoDB.
        """
        global mongo_client, polling_task

        # Cancela o loop de polling, se existir
        if polling_task:
            polling_task.cancel()
            try:
                await polling_task
            except asyncio.CancelledError:
                pass
            print("[SHUTDOWN] Polling task cancelada.")

        # Fecha conexão com o Mongo
        if mongo_client:
            mongo_client.close()
            print("[SHUTDOWN] Conexão MongoDB fechada.")

    # Endpoint manual para disparar uma sincronização (útil para debug)
    @app.post("/trigger-sync")
    async def trigger_sync():
        """
        Dispara manualmente o processo de ingestão de dados (ThingSpeak -> MongoDB).
        """
        if not ingestion_service:
            return {"ok": False, "error": "IngestionService indisponível"}
        return await ingestion_service.sync_all()

    # ------------------------ Routers ------------------------

    # Rotas de análise de dados (histórico, agregados, export, etc.)
    app.include_router(analysis_router)   # /analysis/*

    # Rotas de MFA (provisionar, confirmar, verificar TOTP)
    app.include_router(mfa_router)        # /auth/mfa/*

    # Rotas de previsão (forecast) – ex.: /analysis/forecast/{silo_id}
    # O router deve passar o sensor_type (query param "type") para run_full_forecast.
    app.include_router(forecast_router)   # /analysis/forecast/*

    return app


# Instância global usada pelo Uvicorn / Gunicorn
app = create_app()
