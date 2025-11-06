from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI

def enable_cors(app: FastAPI):
    """
    Registra o middleware de CORS no aplicativo FastAPI.

    Observações de arquitetura:
    - CORS (Cross-Origin Resource Sharing) é necessário quando o frontend
      (origem A) acessa a API (origem B) via navegador.
    - Centralizar a habilitação de CORS nesta função mantém SRP e facilita
      ajustes em ambientes (dev/prod) sem espalhar configuração pelo código.
    - Em produção, recomenda-se restringir origens/métodos/headers conforme
      política de segurança da aplicação.
    """
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # Origem ampla (qualquer). Em produção, troque por lista de domínios confiáveis.
        allow_methods=["*"],  # Libera todos os métodos HTTP (GET/POST/PUT/DELETE/...). Restrinja se necessário.
        allow_headers=["*"],  # Autoriza quaisquer cabeçalhos personalizados (ex.: Authorization, Content-Type).
    )
