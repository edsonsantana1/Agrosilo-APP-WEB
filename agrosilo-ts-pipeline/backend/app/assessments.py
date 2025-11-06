# agrosilo-ts-pipeline/backend/app/assessments.py
from datetime import datetime, timezone
from typing import Dict, Any, List
from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

# Nome fixo para o índice único por (silo, ts). Ter um "alias" estável evita
# colisões com nomes antigos (ex.: "silo_1_ts_-1") e facilita migrações/idempotência.
UNIQ_INDEX_NAME = "uniq_silo_ts"   # evita conflito com nomes antigos

class AssessmentRepository:
    def __init__(self, db: AsyncIOMotorDatabase):
        # Guarda a referência ao database Motor (async) e seleciona a coleção
        # específica de avaliações do grão. A escolha por Motor mantém todo o
        # caminho de I/O assíncrono (coerência com FastAPI/httpx/motor).
        self.db = db
        self.col = db["grain_assessments"]

    async def _deduplicate_by_silo_ts(self) -> None:
        """
        Remove duplicatas por (silo, ts), mantendo o doc mais recente.
        Executa rápido em coleções pequenas; rode uma vez.
        """
        # Agrupamento por chave composta (silo, ts) para identificar duplicatas.
        cursor = self.col.aggregate([
            {
                "$group": {
                    "_id": {"silo": "$silo", "ts": "$ts"},
                    "ids": {"$push": "$_id"},
                    "count": {"$sum": 1}
                }
            },
            {"$match": {"count": {"$gt": 1}}}
        ])
        # Converte o cursor async para lista (aguardando todos os grupos).
        groups: List[dict] = await cursor.to_list(length=None)
        for g in groups:
            ids = g["ids"]
            # Estratégia de deduplicação: manter o documento com maior _id
            # (em ObjectId, _id maior tende a ser mais recente) e remover o resto.
            keep = max(ids)
            drop = [i for i in ids if i != keep]
            if drop:
                await self.col.delete_many({"_id": {"$in": drop}})

    async def ensure_indexes(self) -> None:
        """
        Garante índice único por (silo, ts), com migração segura:
        - se existir índice antigo com mesmo key pattern e não for único, remove
        - deduplica documentos para evitar DuplicateKeyError
        - cria índice único com nome estável (UNIQ_INDEX_NAME)
        """
        # Lê metadados de índices atuais da coleção.
        info = await self.col.index_information()
        # Detecta a presença de um índice antigo para a mesma chave (silo, ts).
        old_name = None
        for name, meta in info.items():
            if meta.get("key") == [("silo", 1), ("ts", -1)]:
                old_name = name
                # Se já for único, não é necessário recriar (idempotente).
                if meta.get("unique"):
                    return
                break

        # Se existe um índice antigo não-único, removemos antes de criar o novo
        # para evitar conflitos de nomes e garantir a unicidade.
        if old_name:
            await self.col.drop_index(old_name)

        # Antes de impor unicidade, deduplicamos os dados para evitar que a criação
        # do índice falhe com DuplicateKeyError.
        await self._deduplicate_by_silo_ts()

        # Cria o índice único com um nome estável (facilita futuras migrações/scripts).
        await self.col.create_index(
            [("silo", 1), ("ts", -1)],
            name=UNIQ_INDEX_NAME,
            unique=True,
        )

    async def insert(self, doc: Dict[str, Any]) -> str:
        """
        Upsert idempotente por (silo, ts). Sempre grava ts em UTC e converte silo para ObjectId.
        """
        # Se não vier 'ts', normaliza para o momento atual em UTC. Garantir UTC
        # evita ambiguidade de timezone e facilita comparações/ordenamentos.
        if "ts" not in doc:
            doc["ts"] = datetime.now(timezone.utc)
        # Normalização de tipos: garante que 'silo' seja um ObjectId na persistência.
        # Isso mantém consistência com referências em outras coleções (sensors, readings).
        if isinstance(doc.get("silo"), str):
            doc["silo"] = ObjectId(doc["silo"])

        # Upsert por (silo, ts): se existir, atualiza; se não, insere.
        # Este padrão torna a operação idempotente, importante para pipelines
        # que podem reprocessar ou reenfileirar mensagens sem duplicar registros.
        await self.col.update_one(
            {"silo": doc["silo"], "ts": doc["ts"]},
            {"$set": doc},
            upsert=True
        )
        return "ok"
