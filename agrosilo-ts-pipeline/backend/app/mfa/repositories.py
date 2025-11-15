# app/mfa/repositories.py
import os
from typing import Optional, Any, Dict
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from bson import ObjectId

_MONGO_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/agrosilo")
_DB_NAME   = os.getenv("MONGODB_DB",  "agrosilo")

_client: Optional[AsyncIOMotorClient] = None
_db: Optional[AsyncIOMotorDatabase] = None

def get_db() -> AsyncIOMotorDatabase:
    global _client, _db
    if _db is not None:
        return _db
    _client = AsyncIOMotorClient(_MONGO_URI)
    _db = _client.get_database(_DB_NAME)
    return _db

async def find_user_by_email(email: str) -> Optional[Dict[str, Any]]:
    db = get_db()
    return await db.users.find_one({"email": email})

async def find_user_by_id(user_id) -> Optional[Dict[str, Any]]:
    db = get_db()
    _id = ObjectId(user_id) if not isinstance(user_id, ObjectId) else user_id
    return await db.users.find_one({"_id": _id})

async def set_user_mfa_secret(user_id, secret: str) -> None:
    db = get_db()
    _id = ObjectId(user_id) if not isinstance(user_id, ObjectId) else user_id
    # Usar $set para atualizar campos específicos dentro do objeto 'mfa'
    # sem sobrescrever o objeto inteiro, caso já existam outros campos.
    await db.users.update_one({"_id": _id}, {"$set": {"mfa.enabled": False, "mfa.secret": secret}})

async def confirm_user_mfa(user_id) -> None:
    db = get_db()
    _id = ObjectId(user_id) if not isinstance(user_id, ObjectId) else user_id
    # O campo 'mfa' pode ter outros subcampos, como 'secret'.
    # A atualização deve ser feita com $set para manter o 'secret'
    # e garantir que 'enabled' seja True.
    await db.users.update_one({"_id": _id}, {"$set": {"mfa.enabled": True}})
