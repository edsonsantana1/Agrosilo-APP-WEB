# agrosilo-ts-pipeline/backend/app/thingspeak_client.py
import httpx
import os
from typing import List, Dict, Any, Optional

class ThingSpeakClient:
    """
    Cliente de leitura para a API do ThingSpeak.
    Responsabilidade única: obter feeds (leituras) de um canal/campo específico
    usando credenciais de leitura definidas via variáveis de ambiente.
    """

    def __init__(self, base: str = "https://api.thingspeak.com"):
        # Base URL da API. Mantido configurável (OCP) para permitir troca de host se necessário.
        self.base = base
        # Ler configurações do .env/ambiente
        self.channel_id = os.getenv("THINGSPEAK_CHANNEL_ID")
        self.api_key = os.getenv("THINGSPEAK_READ_API_KEY")

        # Fail-fast: sem credenciais mínimas, o cliente não deve operar.
        if not self.channel_id or not self.api_key:
            raise ValueError(
                "THINGSPEAK_CHANNEL_ID ou THINGSPEAK_READ_API_KEY não definidos no ambiente."
            )

    async def fetch_field(self, field: int, results: int = 100) -> List[Dict[str, Any]]:
        """
        Extrai leituras de um campo específico do canal do ThingSpeak.
        - Parâmetros:
            field   : número do campo (ex.: 1=temperatura, 2=umidade)
            results : quantidade de amostras a retornar (limita o payload)
        - Retorno:
            Lista de dicts no formato bruto do ThingSpeak (contendo 'created_at', 'fieldX', etc.)
        Observações:
        - Método assíncrono (I/O bound) para não bloquear o event loop.
        - Em caso de status HTTP não 2xx, raise_for_status() propaga exceção.
        """
        url = f"{self.base}/channels/{self.channel_id}/fields/{field}.json"
        params = {"api_key": self.api_key, "results": results}
        
        # O cliente HTTPX deve ser gerenciado por async with para garantir que feche
        # Uso de timeout explícito protege o serviço de ficar pendurado em I/O externo.
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(url, params=params)
            r.raise_for_status()  # garante que erros HTTP sejam tratados no chamador
            return r.json()["feeds"]  # lista de pontos (feeds) no formato da API
