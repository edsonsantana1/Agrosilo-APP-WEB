import os
import asyncio
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

from .thingspeak_client import ThingSpeakClient
from .repositories import SensorRepository, ReadingRepository
from .services import IngestService
from .assessments import AssessmentRepository

# Carrega .env a partir da pasta do backend
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

# ===== Estado global (injeção no startup) ====================================
mongo_client: Optional[AsyncIOMotorClient] = None
sensor_repo: Optional[SensorRepository] = None
reading_repo: Optional[ReadingRepository] = None
ts_client: Optional[ThingSpeakClient] = None
ingestion_service: Optional[IngestService] = None
assessment_repo: Optional[AssessmentRepository] = None
polling_task: Optional[asyncio.Task] = None

POLL_SECONDS = int(os.getenv("POLL_SECONDS", "15"))


# ===== Tarefa periódica (scheduler simples) ==================================
async def periodic_poll(svc: IngestService):
    while True:
        try:
            print("--- [SCHEDULER] Iniciando ciclo de polling ---")
            await svc.sync_all()
            print(f"--- [SCHEDULER] Fim do ciclo. Aguardando {POLL_SECONDS}s ---")
            await asyncio.sleep(POLL_SECONDS)
        except asyncio.CancelledError:
            print("[SCHEDULER] Cancelado.")
            raise
        except Exception as e:
            print(f"[SCHEDULER] ERRO: {e}")
            await asyncio.sleep(POLL_SECONDS * 2)


# ===== Fábrica do app ========================================================
def create_app() -> FastAPI:
    app = FastAPI(title="Agrosilo Pipeline")

    # CORS (restrinja em produção)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.on_event("startup")
    async def _startup():
        global mongo_client, sensor_repo, reading_repo, ts_client
        global ingestion_service, assessment_repo, polling_task

        mongo_uri = os.getenv("MONGODB_URI")
        mongo_db = os.getenv("MONGODB_DB", "test")
        if not mongo_uri:
            raise RuntimeError("MONGODB_URI não definido no ambiente.")

        # Conecta Mongo e expõe no app.state
        mongo_client = AsyncIOMotorClient(mongo_uri, serverSelectionTimeoutMS=6000)
        db = mongo_client[mongo_db]
        app.state.db = db  # <- usado pelo analysis.router via Request

        # Repositórios
        sensor_repo = SensorRepository(db)
        reading_repo = ReadingRepository(db)

        # Assessments (garante índices sem falhar o startup se der erro)
        assessment_repo = AssessmentRepository(db)
        try:
            await assessment_repo.ensure_indexes()
        except Exception as e:
            print(f"[STARTUP] Falha ao garantir índices de assessments: {e}")

        # Cliente de coleta + serviço de ingestão
        ts_client = ThingSpeakClient()
        ingestion_service = IngestService(
            ts_client=ts_client,
            sensor_repo=sensor_repo,
            reading_repo=reading_repo,
        )
        ingestion_service.set_assessment_repo(assessment_repo)

        # Scheduler
        polling_task = asyncio.create_task(periodic_poll(ingestion_service))
        print(f"[STARTUP] Polling iniciado a cada {POLL_SECONDS}s.")

    @app.on_event("shutdown")
    async def _shutdown():
        global mongo_client, polling_task
        if polling_task:
            polling_task.cancel()
            try:
                await polling_task
            except asyncio.CancelledError:
                pass
            print("[SHUTDOWN] Polling task cancelada.")
        if mongo_client:
            mongo_client.close()
            print("[SHUTDOWN] Conexão MongoDB fechada.")

    # ---- Disparo manual da ingestão (opcional/útil em testes) ---------------
    @app.post("/trigger-sync")
    async def trigger_sync():
        if not ingestion_service:
            return {"ok": False, "error": "IngestionService indisponível"}
        return await ingestion_service.sync_all()

    # ---- Router de Análises (import depois do startup configurado) ----------
    from .analysis.router import router as analysis_router
    app.include_router(analysis_router)

    return app


# Ponto de entrada para Uvicorn/Gunicorn
app = create_app()
