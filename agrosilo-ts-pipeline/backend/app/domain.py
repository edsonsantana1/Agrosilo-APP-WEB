from typing import Protocol, List, Optional, Dict
from datetime import datetime
from pydantic import BaseModel, Field

# ------- Entidades (Domínio) -------
# Modelos de domínio tipados com Pydantic (BaseModel):
# - Validam/normalizam dados na criação
# - Oferecem .dict()/.json() para serialização
# - Mantêm o domínio independente de infraestrutura (SRP/DIP)

class Reading(BaseModel):
    # Identificador lógico do sensor (string; normalmente aponta para ObjectId serializado)
    sensor_id: str
    # Timestamp da leitura (datetime timezone-aware preferível na origem); base para time-series
    ts: datetime
    # Valor numérico da leitura já convertido/validado
    value: float

class Sensor(BaseModel):
    # Identificador do documento do sensor (string compatível com ObjectId serializado)
    id: str
    # Referência ao silo (também string compatível com ObjectId serializado)
    silo_id: str
    # Tipo de sensor (ex.: "temperature", "humidity", "pressure"...)
    type: str  # "temperature" | "humidity" | ...

# ------- Ports (Interfaces) -------
# Definição de portas/contratos via typing.Protocol (PEP 544):
# - Explicitam o conjunto mínimo de operações que o caso de uso precisa
# - Permitem trocar implementações (Mongo, mock, in-memory) sem alterar o consumidor
# - Suportam LSP/ISP/DIP (substituição, interfaces focadas e inversão de dependência)

class IThingSpeakClient(Protocol):
    async def fetch_field(self, channel_id: str, field_number: int, api_key: str, results: int) -> List[Dict]:
        """Retorna lista de feeds do campo (cada feed é um dict com created_at, fieldX, etc.)."""
        # Assinatura assíncrona (I/O bound). Retorna registros no formato bruto da API (Dict).
        # Mantém o domínio desacoplado do cliente HTTP concreto.

class ISensorRepository(Protocol):
    # Repositório do agregado "Sensor" com operações estritamente necessárias
    async def get_or_create(self, silo_id: str, sensor_type: str) -> Sensor: ...
    async def get_by_type(self, silo_id: str, sensor_type: str) -> Optional[Sensor]: ...
    # Interface pequena e coesa (ISP): não expõe operações que o caso de uso não utiliza.

class IReadingRepository(Protocol):
    # Repositório de leituras com foco em time-series
    async def ensure_time_series(self) -> None: ...
    # Obtém o último timestamp persistido (útil para sincronizações incrementais)
    async def get_last_ts(self, sensor_id: str) -> Optional[datetime]: ...
    # Upsert em lote para idempotência e performance (bulk)
    async def upsert_many(self, readings: List[Reading]) -> int: ...
    # Consulta paginada/limitada para gráficos/históricos
    async def get_history(self, sensor_id: str, limit: int) -> List[Reading]: ...
