# app/repositories.py
from __future__ import annotations

from typing import List, Optional, Dict, Any, Iterable, Union
from datetime import datetime
from motor.motor_asyncio import AsyncIOMotorDatabase, AsyncIOMotorCollection
from bson import ObjectId

Number = Union[int, float]


def _as_oid(v: str) -> Optional[ObjectId]:
    try:
        return ObjectId(v)
    except Exception:
        return None


class SensorRepository:
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db: AsyncIOMotorDatabase = db
        self.col: AsyncIOMotorCollection = db.get_collection("sensors")

    async def ids_by_silo_and_type(self, silo_id: str, sensor_type: str) -> List[ObjectId]:
        """
        Aceita campos 'silo'/'siloId'/'silo_id' e 'type'/'sensorType', com valor do silo em string ou ObjectId.
        """
        ids: List[ObjectId] = []
        silo_field_opts = ["silo", "siloId", "silo_id"]
        type_field_opts = ["type", "sensorType"]

        or_terms: List[Dict[str, Any]] = []
        oid = _as_oid(silo_id)
        for sfield in silo_field_opts:
            for tfield in type_field_opts:
                if oid:
                    or_terms.append({sfield: oid, tfield: sensor_type})
                or_terms.append({sfield: silo_id, tfield: sensor_type})

        q = {"$or": or_terms}

        async for doc in self.col.find(q, {"_id": 1}):
            sid = doc.get("_id")
            if isinstance(sid, ObjectId):
                ids.append(sid)

        # uniq, preservando ordem
        seen = set()
        out: List[ObjectId] = []
        for x in ids:
            if x not in seen:
                seen.add(x)
                out.append(x)
        return out


class ReadingRepository:
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db: AsyncIOMotorDatabase = db
        self.col: AsyncIOMotorCollection = db.get_collection("readings")

    async def ensure_indexes(self) -> None:
        try:
            await self.col.create_index([("sensorId", 1), ("ts", 1)], name="sensor_ts")
        except Exception:
            pass

    def _sensor_match(self, sensor_ids: Iterable[ObjectId]) -> Dict[str, Any]:
        sids = list(sensor_ids)
        return {
            "$or": [
                {"sensorId": {"$in": sids}},
                {"sensor": {"$in": sids}},
            ]
        }

    async def get_readings(
        self,
        sensor_ids: Iterable[ObjectId],
        start: Optional[datetime],
        end: Optional[datetime],
        limit: int,
    ) -> List[Dict[str, Any]]:
        """
        Retorna [{ts: datetime, value: float}], ordenado por ts asc.
        Coalesce:
          - timestamp: ts | timestamp | time | createdAt (string ou Date)
          - value: value | v | val | reading | data.value
        Converte __ts para Date no próprio pipeline (via $convert/$toDate),
        evitando erros no pandas resample.
        """
        sids = list(sensor_ids)
        if not sids:
            return []

        match_sensor = self._sensor_match(sids)

        pipeline: List[Dict[str, Any]] = [
            {"$match": match_sensor},
            # Coalesce brutos
            {"$addFields": {
                "__ts_raw": {
                    "$ifNull": [
                        "$ts",
                        {"$ifNull": [
                            "$timestamp",
                            {"$ifNull": ["$time", "$createdAt"]}
                        ]}
                    ]
                },
                "__value_raw": {
                    "$ifNull": [
                        "$value",
                        {"$ifNull": [
                            "$v",
                            {"$ifNull": [
                                "$val",
                                {"$ifNull": ["$reading", "$data.value"]}
                            ]}
                        ]}
                    ]
                }
            }},
            # Conversão robusta do timestamp para Date
            {"$addFields": {
                "__ts": {
                    "$cond": [
                        {"$eq": [{"$type": "$__ts_raw"}, "date"]},
                        "$__ts_raw",
                        {"$convert": {"input": "$__ts_raw", "to": "date", "onError": None, "onNull": None}}
                    ]
                }
            }},
            # Value para número (float)
            {"$addFields": {
                "__value": {
                    "$cond": [
                        {"$in": [{"$type": "$__value_raw"}, ["double", "int", "long", "decimal"]]},
                        "$__value_raw",
                        {"$convert": {"input": "$__value_raw", "to": "double", "onError": None, "onNull": None}}
                    ]
                }
            }},
            # Filtra somente docs com __ts e __value válidos
            {"$match": {"__ts": {"$ne": None}, "__value": {"$ne": None}}},
        ]

        # Janela de tempo
        time_cond: Dict[str, Any] = {}
        if start:
            time_cond["$gte"] = start
        if end:
            time_cond["$lte"] = end
        if time_cond:
            pipeline.append({"$match": {"__ts": time_cond}})

        pipeline += [
            {"$sort": {"__ts": 1}},
            {"$limit": int(limit)},
            {"$project": {"_id": 0, "ts": "$__ts", "value": "$__value"}},
        ]

        out: List[Dict[str, Any]] = []
        async for doc in self.col.aggregate(pipeline, allowDiskUse=True):
            ts = doc.get("ts")
            val = doc.get("value")
            # val já é double pelo $convert; defensiva extra:
            try:
                val = float(val)
            except Exception:
                continue
            out.append({"ts": ts, "value": val})
        return out

    # Compat:
    async def fetch_points(
        self,
        sensor_ids: Iterable[ObjectId],
        start: Optional[datetime],
        end: Optional[datetime],
        limit: int,
    ) -> List[Dict[str, Any]]:
        return await self.get_readings(sensor_ids, start, end, limit)
