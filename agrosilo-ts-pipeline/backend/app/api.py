import os, asyncio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient

from .thingspeak_client import ThingSpeakClient
from .repositories import SensorRepository, ReadingRepository
from .services import IngestService
from .assessments import AssessmentRepository

# Nota: o router de análise é importado dentro de create_app() para evitar import circular.
# (api.py -> analysis.router -> api.py)

# ===== Estado de módulo (referências injetadas no startup) ===================
# Mantém referências globais para objetos criados no ciclo de vida do app.
# Vantagem: acessíveis pelos endpoints; Cuidado: não usar fora do loop/eventos.
mongo_client = None
sensor_repo = None
reading_repo = None
ts_client = None
ingestion_service = None
assessment_repo = None
polling_task: asyncio.Task | None = None

# Intervalo do agendador (segundos). Leitura via ENV com default de "15".
# Boa prática: parametrizar via ambiente -> Open/Closed (config sem mudar código).
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "15"))

# ===== Tarefa periódica (Scheduler simples via asyncio) ======================
async def periodic_poll(svc: IngestService):
    """
    Loop infinito cooperativo que dispara a ingestão em intervalos fixos.
    - Usa await para não bloquear o event loop (I/O bound).
    - Captura CancelledError para encerrar graciosamente no shutdown.
    - Em erros genéricos, faz 'backoff' simples (dobro do intervalo) e continua.
    """
    while True:
        try:
            print("--- [SCHEDULER] Iniciando ciclo de polling ---")
            await svc.sync_all()  # coleta -> limpeza -> persistência -> assessment
            print("--- [SCHEDULER] Fim do ciclo. Aguardando... ---")
        except asyncio.CancelledError:
            # Propaga o cancelamento para o loop encerrar corretamente.
            raise
        except Exception as e:
            # Observabilidade básica; em produção: logger + métricas + tracing.
            print(f"ERRO no ciclo de polling: {e}")
            await asyncio.sleep(POLL_SECONDS * 2)  # backoff simples para aliviar pressão
            continue
        await asyncio.sleep(POLL_SECONDS)

# ===== Fábrica do aplicativo (composição de dependências) ====================
def create_app() -> FastAPI:
    """
    Ponto único de composição:
    - Cria FastAPI, configura CORS, injeta repositórios/serviços,
      prepara índices, e inicia a tarefa assíncrona de polling.
    - DIP (Dependency Inversion): IngestService depende de abstrações
      (interfaces/repositórios), e a composição concreta acontece aqui.
    """
    app = FastAPI(title="Agrosilo Pipeline")

    # CORS amplo (origens/metodos/headers). Em produção, restrinja allow_origins.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
    )

    # --------- Endpoints leves (healthcheck) ---------------------------------
    @app.get("/health")
    async def health():
        """
        Prova de vida do serviço (usado por orquestradores/monitoramento).
        Retorna dict serializável (FastAPI converte para JSON).
        """
        return {"ok": True}

    # --------- Hooks de ciclo de vida ----------------------------------------
    @app.on_event("startup")
    async def _startup():
        """
        Executa ao subir o servidor:
        - Abre conexão com MongoDB (Motor async)
        - Cria repositórios e cliente ThingSpeak
        - Garante índices e coleção time-series
        - Instancia IngestService e injeta AssessmentRepository
        - Agenda a tarefa periódica de ingestão
        """
        global mongo_client, sensor_repo, reading_repo, ts_client, ingestion_service, assessment_repo, polling_task

        # 1) Conexão Mongo (não bloqueante). Em produção: pool/tuning via URI.
        mongo_uri = os.getenv("MONGODB_URI")
        mongo_db  = os.getenv("MONGODB_DB", "test")
        mongo_client = AsyncIOMotorClient(mongo_uri)
        db = mongo_client[mongo_db]

        # Disponibiliza o DB para outros módulos/routers via app.state (inj. simples)
        app.state.db = db

        # 2) Repositórios (persistência) e cliente de coleta (HTTP ThingSpeak)
        sensor_repo  = SensorRepository(db)
        reading_repo = ReadingRepository(db)
        ts_client    = ThingSpeakClient()  # lê credenciais do ambiente internamente

        # 3) Repositório de assessments: garante índice único e deduplicação
        assessment_repo = AssessmentRepository(db)
        await assessment_repo.ensure_indexes()

        # 4) Coleção time-series + índice {sensor, ts} único (consistência temporal)
        await reading_repo.ensure_time_series()

        # 5) Serviço de ingestão (regras de negócio + tratamento de dados)
        ingestion_service = IngestService(
            ts_client=ts_client,
            sensor_repo=sensor_repo,
            reading_repo=reading_repo,
        )
        # Injeta repo de assessments (separação de responsabilidades)
        ingestion_service.set_assessment_repo(assessment_repo)

        # 6) Agendador assíncrono: inicia loop periódico em segundo plano
        polling_task = asyncio.create_task(periodic_poll(ingestion_service))
        print(f"INFO: Polling iniciado a cada {POLL_SECONDS} segundos.")

    @app.on_event("shutdown")
    async def _shutdown():
        """
        Executa ao encerrar o servidor:
        - Cancela a tarefa periódica (permitindo encerrar o loop com segurança)
        - Fecha a conexão com MongoDB (limpeza de recursos)
        """
        global mongo_client, polling_task
        if polling_task:
            polling_task.cancel()
            print("INFO: Polling Task cancelada.")
        if mongo_client:
            mongo_client.close()
            print("INFO: Conexão com MongoDB fechada.")

    # --------- Endpoints de negócio ------------------------------------------
    @app.post("/trigger-sync")
    async def trigger_sync():
        """
        Endpoint para disparo manual da ingestão (útil em demos e testes).
        Retorna o resumo do sync (recebidos/armazenados/descartados, last values e assessment).
        Observação: FastAPI serializa datetime automaticamente.
        """
        return await ingestion_service.sync_all()

    @app.get("/history")
    async def history(siloId: str, type: str, limit: int = 200):
        """
        Retorna histórico limpo de leituras para um silo/tipo específico.
        - get_or_create: registra sensor se ainda não existir (idempotente)
        - get_history: busca ordenada, limita N e devolve pronto para plot
        """
        sensor = await sensor_repo.get_or_create(siloId, type)
        data = await reading_repo.get_history(sensor.id, limit)
        return {
            "sensorId": sensor.id,
            "type": sensor.type,
            "points": [{"t": d.ts, "v": d.value} for d in data],
        }

    # --------- Router de análises (registrado no final para evitar ciclos) ----
    # Evita import circular: só aqui dentro, após create_app configurar 'app'.
    from .analysis.router import router as analysis_router
    app.include_router(analysis_router)
    # Endpoints expostos pelo módulo de análise (documentados para visibilidade):
    #   GET  /analysis/history
    #   GET  /analysis/aggregate
    #   GET  /analysis/scatter
    #   GET  /analysis/export.csv
    #   GET  /analysis/report.pdf

    return app

# Instancia o app (entrypoint do ASGI). Uvicorn/Gunicorn vão importar 'app'.
app = create_app()
