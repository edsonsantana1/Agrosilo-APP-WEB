"""
repositories.py
Camada de acesso a dados (Mongo/Motor). Não contém regra de negócio.

Princípio SOLID (S e D): uma classe, uma responsabilidade. Serviços recebem
as dependências por injeção (Dependency Inversion).
"""

from typing import List, Optional, Dict, Any
from motor.motor_asyncio import AsyncIOMotorDatabase
from datetime import datetime


class SensorRepository:
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db
        self.col = db.get_collection("sensors")

    async def ids_by_silo_and_type(self, silo_id: str, sensor_type: str) -> List[str]:
        cur = self.col.find({"silo": silo_id, "type": sensor_type}, {"_id": 1})
        return [str(doc["_id"]) async for doc in cur]


class ReadingRepository:
    """
    Coleção time-series: readings
    Esperado índice: { sensor: 1, ts: 1 }
    Schema: { _id, sensor: ObjectId, ts: ISODate, value: Number }
    """
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db
        self.col = db.get_collection("readings")

    async def fetch_points(
        self,
        sensor_ids: List[str],
        start: Optional[datetime],
        end: Optional[datetime],
        limit: int = 20000,
        sort_asc: bool = True,
    ) -> List[Dict[str, Any]]:
        q: Dict[str, Any] = {"sensor": {"$in": sensor_ids}}
        if start or end:
            q["ts"] = {}
            if start:
                q["ts"]["$gte"] = start
            if end:
                q["ts"]["$lte"] = end

        sort_dir = 1 if sort_asc else -1

        cur = (
            self.col.find(q, {"_id": 0, "sensor": 1, "ts": 1, "value": 1})
            .sort("ts", sort_dir)
            .limit(limit)
        )

        return [doc async for doc in cur]
