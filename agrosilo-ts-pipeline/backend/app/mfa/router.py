# app/mfa/router.py
from fastapi import APIRouter, Header, HTTPException, status
from .dtos import ProvisionResponse, ConfirmRequest, VerifyRequest, LoginOK
from .service import start_provisioning, confirm_provision, verify_login

router = APIRouter(prefix="/auth/mfa", tags=["mfa"])

@router.post("/provision", response_model=ProvisionResponse)
async def provision_mfa(authorization: str = Header(default="")):
    data = await start_provisioning(authorization)
    if not data:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
    return data

@router.post("/confirm")
async def confirm_mfa(req: ConfirmRequest, authorization: str = Header(default="")):
    ok = await confirm_provision(authorization, req.token)
    if not ok:
        raise HTTPException(status_code=400, detail="Código inválido ou sessão expirada")
    return {"ok": True}

@router.post("/verify", response_model=LoginOK)
async def verify_mfa(req: VerifyRequest):
    data = await verify_login(req.email, req.token)
    if not data:
        raise HTTPException(status_code=400, detail="Código inválido ou usuário sem 2FA")
    return data
