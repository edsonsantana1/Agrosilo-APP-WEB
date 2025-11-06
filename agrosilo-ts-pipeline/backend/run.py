# agrosilo-ts-pipeline/backend/run.py 

import os
import uvicorn
from dotenv import load_dotenv
from app.api import create_app

# --- CORREÇÃO: Força o load_dotenv a procurar no diretório atual ---
# Garante que o arquivo .env seja carregado a partir da pasta deste script (backend),
# evitando depender do diretório de execução do processo (cwd) e prevenindo
# variáveis ausentes em execuções via serviços/containers/IDE.
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

# O agendador deve ser movido para um handler de lifespan do FastAPI...
# Nota: a observação acima remete a uma boa prática de FastAPI:
# usar eventos de ciclo de vida (startup/shutdown ou lifespan) para inicializar
# e finalizar recursos assíncronos (ex.: tasks em background), mantendo clareza
# e evitando vazamentos de recursos.

def main():
    # Cria a aplicação FastAPI usando a fábrica de composição (DIP).
    # A função create_app encapsula a injeção de dependências e o registro de middlewares/rotas.
    app = create_app()
    
    # ... (restante do código main) ...
    # uvicorn.run inicia o servidor ASGI incorporado, ideal para desenvolvimento local.
    # Em produção, normalmente usa-se um process manager (ex.: gunicorn + uvicorn workers).
    uvicorn.run(
        app, 
        host=os.getenv("API_HOST", "0.0.0.0"),  # 0.0.0.0 expõe em todas as interfaces (necessário em containers)
        port=int(os.getenv("API_PORT", "8000")),  # porta configurável via ENV, com default seguro para dev
        log_level="info"  # nível de log padrão; ajuste conforme necessidade de observabilidade
    )

if __name__ == "__main__":
    # Guarda convencional para permitir:
    # - execução direta do script (python run.py) -> chama main()
    # - importação do módulo sem efeitos colaterais (não inicia servidor ao ser importado)
    main()
