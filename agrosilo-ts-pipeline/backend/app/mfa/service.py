# app/mfa/service.py
import base64
import io
import os
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, Tuple

import jwt            # PyJWT
import pyotp
import qrcode
from fastapi import HTTPException, status
from bson import ObjectId

from .repositories import (
    find_user_by_email,
    find_user_by_id,
    set_user_mfa_secret,
    confirm_user_mfa,
)

# ---------------- util: JSON-safe ----------------
def _jsonify(obj):
    """Converte ObjectId/datetime e coleções aninhadas para tipos serializáveis em JSON."""
    if isinstance(obj, ObjectId):
        return str(obj)
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {k: _jsonify(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonify(v) for v in obj]
    return obj


# ---------------- JWT helpers ----------------
def _jwt_settings() -> Dict[str, Any]:
    return {
        "secret": os.getenv("JWT_SECRET", "changeme"),
        "alg": os.getenv("JWT_ALG", "HS256"),
        "exp_h": int(os.getenv("JWT_EXP_HOURS", "24")),
        "issuer": os.getenv("MFA_ISSUER", "Agrosilo"),
    }

def _jwt_decode(authorization_header: str) -> Optional[Dict[str, Any]]:
    if not authorization_header or not authorization_header.lower().startswith("bearer "):
        print("[MFA] Authorization ausente/sem Bearer")
        return None
    token = authorization_header.split(" ", 1)[1].strip()
    s = _jwt_settings()
    try:
        return jwt.decode(token, s["secret"], algorithms=[s["alg"]])
    except Exception as e:
        print(f"[MFA] Falha ao decodificar JWT: {e}")
        return None

def _jwt_issue(payload: Dict[str, Any]) -> str:
    s = _jwt_settings()
    now = datetime.utcnow()
    to_encode = {
        **payload,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=s["exp_h"])).timestamp()),
        "iss": s["issuer"],
    }
    return jwt.encode(to_encode, s["secret"], algorithm=s["alg"])


# ---------------- QR / TOTP helpers ----------------
def _make_qr_data_uri(otpauth_uri: str) -> str:
    img = qrcode.make(otpauth_uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{data}"

def _make_otpauth(secret: str, email: str) -> str:
    totp = pyotp.TOTP(secret, digits=6, interval=30)
    return totp.provisioning_uri(name=email, issuer_name=_jwt_settings()["issuer"])

def _generate_secret_and_qr(email: str) -> Tuple[str, str]:
    secret = pyotp.random_base32()
    otpauth = _make_otpauth(secret, email)
    return secret, _make_qr_data_uri(otpauth)


# ---------------- Flows ----------------
async def start_provisioning(authorization: str) -> Optional[dict]:
    """
    Inicia o provisionamento MFA para o usuário autenticado.
    Idempotente: se já existir mfa.secret (enabled=False), reusa-o (não cria novo).
    """
    claims = _jwt_decode(authorization)
    if not claims:
        return None

    user_id = claims.get("sub") or claims.get("userId") or claims.get("_id")
    if not user_id:
        print("[MFA] JWT sem sub/userId")
        return None

    user = await find_user_by_id(user_id)
    if not user:
        print(f"[MFA] Usuário não encontrado para id={user_id}")
        return None

    email = user.get("email") or f"user-{user_id}"
    mfa = user.get("mfa") or {}

    # 1) Se já estiver habilitado, apenas retorna o QR/secret atual (útil para reconfigurar no app).
    if mfa.get("enabled") and mfa.get("secret"):
        otpauth = _make_otpauth(mfa["secret"], email)
        return {"secret": mfa["secret"], "qrCodeDataUri": _make_qr_data_uri(otpauth)}

    # 2) Se já existe secret salvo mas ainda não habilitado, reusar para evitar troca a cada refresh.
    if (not mfa.get("enabled")) and mfa.get("secret"):
        otpauth = _make_otpauth(mfa["secret"], email)
        return {"secret": mfa["secret"], "qrCodeDataUri": _make_qr_data_uri(otpauth)}

    # 3) Não há secret salvo: gera e persiste (enabled=False)
    secret, data_uri = _generate_secret_and_qr(email)
    await set_user_mfa_secret(user["_id"], secret)
    return {"secret": secret, "qrCodeDataUri": data_uri}


async def confirm_provision(authorization: str, secret: str, token: str) -> bool:
    """
    Confirma o provisionamento validando o TOTP.
    Usa o secret salvo no usuário (mfa.secret); se não houver, aceita o 'secret' recebido como fallback.
    Ao confirmar, marca mfa.enabled=True.
    """
    claims = _jwt_decode(authorization)
    if not claims:
        return False

    user_id = claims.get("sub") or claims.get("userId") or claims.get("_id")
    user = await find_user_by_id(user_id)
    if not user:
        return False

    mfa = user.get("mfa") or {}
    saved_secret = mfa.get("secret") or secret
    if not saved_secret:
        print(f"[MFA CONFIRM] Secret não encontrado para user_id={user_id}")
        return False

    totp = pyotp.TOTP(saved_secret, digits=6, interval=30)
    ok = totp.verify(token, valid_window=1)

    if ok:
        try:
            await confirm_user_mfa(user["_id"])  # seta mfa.enabled=True (mantém o secret)
        except Exception as e:
            print(f"[MFA CONFIRM] ERRO ao salvar no DB para user_id={user_id}: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Falha interna ao salvar configuração 2FA"
            )

    return ok


async def verify_login(email: str, token: str) -> Optional[dict]:
    """
    Verifica o TOTP no login. Retorna JWT + user (JSON-safe) se válido.
    """
    user = await find_user_by_email(email)
    if not user:
        return None

    mfa = user.get("mfa") or {}
    if not (mfa.get("enabled") and mfa.get("secret")):
        return None

    totp = pyotp.TOTP(mfa["secret"], digits=6, interval=30)
    if not totp.verify(token, valid_window=1):
        return None

    payload = {
        "sub": str(user["_id"]),
        "userId": str(user["_id"]), 
        "email": user.get("email"),
        "role": user.get("role", "user"),
        "mfa": True,
    }
    token_jwt = _jwt_issue(payload)

    # remove campos sensíveis e torna o objeto seguro para JSON
    safe_user = {k: v for k, v in user.items() if k not in {"password", "passwordHash", "mfa", "salt"}}
    safe_user = _jsonify(safe_user)

    return {"token": token_jwt, "user": safe_user}
