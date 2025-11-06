"""
dtos.py
Modelos Pydantic: contratos de entrada/saída (I/O) da API de análises.

Princípio SOLID (S): cada classe tem uma responsabilidade clara (tipagem e validação).
"""

from typing import List, Optional, Literal, Tuple
from pydantic import BaseModel, Field
from datetime import datetime

# ---------------------------
# Requests (query parameters)
# ---------------------------

Granularity = Literal["minute", "hour", "day"]


class HistoryQuery(BaseModel):
    siloId: str = Field(..., description="ID do silo")
    type: Literal["temperature", "humidity", "pressure", "co2"] = Field(..., description="Tipo de sensor")
    start: Optional[datetime] = Field(None, description="Início (ISO8601). Se vazio, considera range pré-definido.")
    end: Optional[datetime] = Field(None, description="Fim (ISO8601). Default: agora")
    limit: int = Field(20000, ge=1, le=100000, description="Limite de pontos")


class AggregateQuery(HistoryQuery):
    gran: Granularity = Field("hour", description="Granularidade de agregação")
    ma: Optional[int] = Field(None, ge=2, le=2000, description="Janela de média móvel (opcional)")


class ScatterQuery(BaseModel):
    siloId: str
    start: Optional[datetime] = None
    end: Optional[datetime] = None
    limit: int = Field(50000, ge=100, le=150000)


# ---------------------------
# Responses
# ---------------------------

class Point(BaseModel):
    t: datetime
    v: float


class SeriesResponse(BaseModel):
    sensorType: str
    points: List[Point]


class SummaryStats(BaseModel):
    n: int
    min: float
    mean: float
    median: float
    p95: float
    max: float
    stddev: float


class BandBreakdown(BaseModel):
    normal_ms: int
    caution_ms: int
    warning_ms: int
    critical_ms: int


class AnalysisSummary(BaseModel):
    stats: SummaryStats
    bands: BandBreakdown
    last: Point
    delta24: Optional[float] = None  # variação em 24h (se houver dado suficiente)


class AggregateBucket(BaseModel):
    t: datetime
    avg: float
    min: float
    max: float
    count: int
    ma: Optional[float] = None


class AggregateResponse(BaseModel):
    sensorType: str
    gran: Granularity
    buckets: List[AggregateBucket]


class ScatterPoint(BaseModel):
    x: float  # temperatura
    y: float  # umidade
    t: datetime


class ScatterResponse(BaseModel):
    pairs: List[ScatterPoint]
