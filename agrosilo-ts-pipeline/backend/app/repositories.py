from typing import Optional, List
from datetime import datetime
from motor.motor_asyncio import AsyncIOMotorDatabase
from bson import ObjectId
from .domain import ISensorRepository, IReadingRepository, Sensor, Reading

class SensorRepository(ISensorRepository):
    # Repositório responsável pela coleção "sensors".
    # Implementa o contrato ISensorRepository (ISP/DIP).

    def __init__(self, db: AsyncIOMotorDatabase):
        # Mantém referência ao DB assíncrono (Motor) e seleciona a coleção.
        self.db = db
        self.col = db["sensors"]

    async def get_by_type(self, silo_id: str, sensor_type: str) -> Optional[Sensor]:
        # Busca um sensor pelo par (silo, type). Usa ObjectId para filtrar por referência.
        doc = await self.col.find_one({"silo": ObjectId(silo_id), "type": sensor_type})
        if not doc:
            return None
        # Mapeia o documento MongoDB -> modelo de domínio (Pydantic).
        return Sensor(id=str(doc["_id"]), silo_id=str(doc["silo"]), type=doc["type"])

    async def get_or_create(self, silo_id: str, sensor_type: str) -> Sensor:
        # Idempotência de criação: se existir, retorna; senão, insere.
        found = await self.get_by_type(silo_id, sensor_type)
        if found:
            return found
        res = await self.col.insert_one({
            "silo": ObjectId(silo_id),
            "type": sensor_type,
            # Campos adicionais podem ser acrescentados no futuro sem quebrar o contrato (OCP).
        })
        return Sensor(id=str(res.inserted_id), silo_id=silo_id, type=sensor_type)


class ReadingRepository(IReadingRepository):
    # Repositório para time-series de leituras; cumpre IReadingRepository.

    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db
        self.col = db["readings"]

   # app/repositories.py: Definição do método ensure_time_series

async def ensure_time_series(self) -> None:
    """
    Garante que a coleção 'readings' seja uma Timeseries Collection e possui o índice.
    NOTA: Este método está indentado fora da classe 'ReadingRepository' no código fornecido.
          Assim, ele é uma função de nível de módulo que espera 'self' (não há alteração aqui).
          Em produção, a boa prática é mantê-lo como método da classe.
    """
    
    # Obtém cursor assíncrono de metadados das coleções do DB.
    cursor = self.db.list_collections()
    
    # Converte cursor em lista (await necessário, I/O não bloqueante).
    collections_data = await cursor.to_list(None)
    
    # Extração dos nomes das coleções existentes para checar presença de 'readings'.
    names = [c["name"] for c in collections_data]

    collection_exists = "readings" in names

    # Se a coleção ainda não existe, cria como time-series (otimizada para séries temporais).
    if not collection_exists:
        # Cria a coleção Timeseries com timeField/metaField/granularity.
        print("Criação da coleção 'readings' Timeseries...")
        await self.db.create_collection(
            "readings",
            timeseries={"timeField": "ts", "metaField": "sensor", "granularity": "minutes"}
        )
        print("Coleção 'readings' Timeseries criada.")
    
    # Garante índice composto único {sensor, ts} (idempotente).
    await self.col.create_index([("sensor", 1), ("ts", 1)], unique=True)
    print("Índice {sensor, ts} na coleção 'readings' garantido.")
        

    async def get_last_ts(self, sensor_id: str) -> Optional[datetime]:
        # Retorna o timestamp mais recente para um sensor (útil para sync incremental).
        doc = await self.col.find({"sensor": ObjectId(sensor_id)}).sort("ts", -1).limit(1).to_list(1)
        if not doc:
            return None
        return doc[0]["ts"]

    async def upsert_many(self, readings: List[Reading]) -> int:
        # Upsert em lote: idempotente e performático para grandes volumes.
        if not readings:
            return 0
        ops = []
        for r in readings:
            ops.append({
                "updateOne": {
                    # Chave de unicidade: (sensor, ts)
                    "filter": {"sensor": ObjectId(r.sensor_id), "ts": r.ts},
                    # $setOnInsert garante que só escreve na inserção (não sobrescreve existentes).
                    "update": {"$setOnInsert": {"sensor": ObjectId(r.sensor_id), "ts": r.ts, "value": r.value}},
                    "upsert": True
                }
            })
        # bulk_write reduz round-trips e melhora throughput; ordered=False tolera falhas isoladas.
        res = await self.col.bulk_write(ops, ordered=False)
        return len(ops)

    async def get_history(self, sensor_id: str, limit: int = 200) -> List[Reading]:
        # Consulta as leituras mais recentes (ordenadas desc), limita N e reverte para ordem cronológica.
        docs = await self.col.find({"sensor": ObjectId(sensor_id)}) \
                             .sort("ts", -1).limit(limit).to_list(limit)
        docs.reverse()
        # Mapeia documentos de volta para modelos de domínio (Pydantic).
        return [Reading(sensor_id=sensor_id, ts=d["ts"], value=float(d["value"])) for d in docs]
