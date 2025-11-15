# app/auth/router.py
import os
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr
from motor.motor_asyncio import AsyncIOMotorDatabase
from passlib.hash import bcrypt
from jose import jwt

router = APIRouter(prefix="/auth", tags=["auth"])

JWT_SECRET = os.getenv("JWT_SECRET", "change_me")
JWT_ALG = "HS256"

def make_jwt(payload: dict, minutes: int = 120) -> str:
    exp = datetime.utcnow() + timedelta(minutes=minutes)
    payload = {**payload, "exp": exp}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)

def get_db(request: Request) -> AsyncIOMotorDatabase:
    return request.app.state.db

# --------- DTOs ----------
class LoginBody(BaseModel):
    email: EmailStr
    password: str
    role: str

class RegisterBody(BaseModel):
    name: str
    email: EmailStr
    password: str
    phoneNumber: Optional[str] = None
    role: str = "user"

# --------- Endpoints ----------
@router.post("/register")
async def register(body: RegisterBody, db: AsyncIOMotorDatabase = Depends(get_db)):
    exists = await db["users"].find_one({"email": body.email})
    if exists:
        raise HTTPException(status_code=400, detail="E-mail já cadastrado")

    user = {
        "name": body.name,
        "email": body.email,
        "passwordHash": bcrypt.hash(body.password),
        "phoneNumber": body.phoneNumber,
        "role": body.role or "user",
        "mfa_enabled": False,
        "mfa_secret": None,
        "createdAt": datetime.utcnow(),
    }
    await db["users"].insert_one(user)
    return {"ok": True}

@router.post("/login")
async def login(body: LoginBody, db: AsyncIOMotorDatabase = Depends(get_db)):
    user = await db["users"].find_one({"email": body.email})
    if not user or not bcrypt.verify(body.password, user.get("passwordHash", "")):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenciais inválidas")

    # Se já tem MFA habilitado, pede verificação
    if user.get("mfa_enabled") and user.get("mfa_secret"):
        return {"mfa": "verify", "email": body.email}

    # Se não tem MFA habilitado, exigir provisionamento e emitir token curto
    temp = make_jwt({"sub": str(user["_id"]), "stage": "mfa_provision"}, minutes=10)
    return {"mfa": "provision", "tempToken": temp}

    # Se quiser liberar sem MFA (opcional), comente os blocos acima e use:
    # token = make_jwt({"sub": str(user["_id"]), "role": user.get("role","user")}, minutes=120)
    # pub = {"name": user.get("name"), "email": user["email"], "role": user.get("role","user")}
    # return {"token": token, "user": pub}
