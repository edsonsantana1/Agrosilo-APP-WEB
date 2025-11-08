# agrosilo-ts-pipeline/backend/run.py
import os
import uvicorn
from dotenv import load_dotenv
from app.api import create_app

# Carrega .env da pasta do backend
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

def main():
    app = create_app()
    uvicorn.run(
        app,
        host=os.getenv("API_HOST", "0.0.0.0"),
        port=int(os.getenv("API_PORT", "8000")),
        log_level="info"
    )

if __name__ == "__main__":
    main()
