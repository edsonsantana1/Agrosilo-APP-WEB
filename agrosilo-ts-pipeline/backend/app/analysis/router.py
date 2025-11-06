"""
router.py
Exposição HTTP (FastAPI APIRouter).

SOLID (I): endpoints pequenos, usando serviços/repositórios injetados via dependência.
"""

from typing import Optional
from fastapi import APIRouter, Depends, Query, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from datetime import datetime
from motor.motor_asyncio import AsyncIOMotorDatabase

from .dtos import (
    HistoryQuery, AggregateQuery, ScatterQuery,
    SeriesResponse, AggregateResponse, ScatterResponse
)
from .repositories import SensorRepository, ReadingRepository
from .services import AnalysisService

router = APIRouter(prefix="/analysis", tags=["analysis"])


# --- dependency: obter DB do app.state ---
def get_db() -> AsyncIOMotorDatabase:
    from ..api import app  # import local para evitar ciclo
    return app.state.db  # definido no startup do api.py


def get_service(db: AsyncIOMotorDatabase = Depends(get_db)) -> AnalysisService:
    sensors = SensorRepository(db)
    readings = ReadingRepository(db)
    return AnalysisService(sensors, readings)


# ------------------------ endpoints ------------------------

@router.get("/history", response_model=SeriesResponse)
async def get_history(
    siloId: str = Query(...),
    type: str = Query(..., pattern="^(temperature|humidity|pressure|co2)$"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    limit: int = Query(20000, ge=1, le=100000),
    svc: AnalysisService = Depends(get_service),
):
    series = await svc.history(siloId, type, start, end, limit)
    return series


@router.get("/aggregate", response_model=AggregateResponse)
async def get_aggregate(
    siloId: str = Query(...),
    type: str = Query(..., pattern="^(temperature|humidity|pressure|co2)$"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    limit: int = Query(100000, ge=1, le=150000),
    gran: str = Query("hour", pattern="^(minute|hour|day)$"),
    ma: Optional[int] = Query(None, ge=2, le=2000),
    svc: AnalysisService = Depends(get_service),
):
    series = await svc.history(siloId, type, start, end, limit)
    agg = await svc.aggregate(series, gran, ma)
    return agg


@router.get("/scatter", response_model=ScatterResponse)
async def get_scatter(
    siloId: str = Query(...),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    limit: int = Query(50000, ge=100, le=150000),
    svc: AnalysisService = Depends(get_service),
):
    sc = await svc.scatter_temp_vs_hum(siloId, start, end, limit)
    return sc


@router.get("/export.csv")
async def export_csv(
    siloId: str = Query(...),
    type: str = Query(..., pattern="^(temperature|humidity|pressure|co2)$"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    limit: int = Query(100000, ge=1, le=150000),
    svc: AnalysisService = Depends(get_service),
):
    series = await svc.history(siloId, type, start, end, limit)
    csv_bytes = svc.to_csv(series)
    headers = {"Content-Disposition": f'attachment; filename="agrosilo_{type}_history.csv"'}
    return StreamingResponse(iter([csv_bytes]), media_type="text/csv", headers=headers)


@router.get("/report.pdf")
async def report_pdf(
    siloId: str = Query(...),
    type: str = Query(..., pattern="^(temperature|humidity|pressure|co2)$"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    limit: int = Query(50000, ge=100, le=150000),
    siloName: str = Query("Silo"),
    periodLabel: str = Query("Todo o período"),
    logoPath: Optional[str] = Query(None, description="Caminho absoluto opcional p/ logo (PNG/JPG)"),
    svc: AnalysisService = Depends(get_service),
):
    series = await svc.history(siloId, type, start, end, limit)
    if not series.points:
        raise HTTPException(status_code=404, detail="Sem dados neste período")

    summary = await svc.summary(series)
    if not summary:
        raise HTTPException(status_code=404, detail="Sem dados para sumarizar")

    pdf_bytes = svc.to_pdf(series, summary, silo_name=siloName, period_label=periodLabel, logo_path=logoPath)
    headers = {"Content-Disposition": f'attachment; filename="agrosilo_{type}_report.pdf"'}
    return StreamingResponse(iter([pdf_bytes]), media_type="application/pdf", headers=headers)
