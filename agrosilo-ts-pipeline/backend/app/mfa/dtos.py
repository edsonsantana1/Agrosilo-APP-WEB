# app/mfa/dtos.py
from pydantic import BaseModel

class ProvisionResponse(BaseModel):
    secret: str
    qrCodeDataUri: str

class ConfirmRequest(BaseModel):
    token: str

class VerifyRequest(BaseModel):
    email: str
    token: str

class LoginOK(BaseModel):
    token: str
    user: dict
