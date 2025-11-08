from typing import Optional, Dict, Any, List, Tuple
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query, HTTPException, Request
from fastapi.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from .dtos import SeriesResponse, AggregateResponse, ScatterResponse
from ..repositories import SensorRepository, ReadingRepository
from .services import AnalysisService

router = APIRouter(prefix="/analysis", tags=["analysis"])

# -------------------- helpers --------------------

_ALLOWED_TYPES = {"temperature", "humidity", "pressure", "co2"}

def _normalize_type(_type: Optional[str], _sensor_type: Optional[str]) -> str:
    """
    Aceita tanto 'type' (novo) quanto 'sensorType' (legado) e valida.
    """
    t = (_type or _sensor_type or "").strip()
    if t not in _ALLOWED_TYPES:
        raise HTTPException(status_code=422, detail="type inválido. Use: temperature|humidity|pressure|co2")
    return t

def _window_from_range(range_: Optional[str]) -> Tuple[Optional[datetime], Optional[datetime]]:
    """
    Converte '24h' | '7d' | '30d' | 'all' em (start, end) UTC.
    """
    if not range_ or range_ == "all":
        return None, None
    now = datetime.utcnow()
    if range_ == "24h":
        return now - timedelta(hours=24), now
    if range_ == "7d":
        return now - timedelta(days=7), now
    if range_ == "30d":
        return now - timedelta(days=30), now
    # valor desconhecido => considere "all"
    return None, None

def _label_from_range(range_: Optional[str], default_label: str = "Todo o período") -> str:
    mapping = {
        "24h": "Últimas 24h",
        "7d": "Últimos 7 dias",
        "30d": "Últimos 30 dias",
        "all": "Todo o período",
        None: default_label,
    }
    return mapping.get(range_, default_label)

# -------------------- deps --------------------

def get_db(request: Request) -> AsyncIOMotorDatabase:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=500, detail="Database não inicializado")
    return db

def get_service(db: AsyncIOMotorDatabase = Depends(get_db)) -> AnalysisService:
    sensors = SensorRepository(db)
    readings = ReadingRepository(db)
    return AnalysisService(sensors, readings)

# ========================= SILOS (para o <select>) =========================
@router.get("/silos", response_model=List[Dict[str, Any]])
async def list_silos(db: AsyncIOMotorDatabase = Depends(get_db)):
    """
    Retorna silos mínimos para preencher o combo da tela de análises.
    Saída: [{ "_id": "<id>", "name": "<nome>" }, ...]
    """
    cur = db.get_collection("silos").find({}, {"_id": 1, "name": 1}).sort("name", 1)
    out: List[Dict[str, Any]] = []
    async for doc in cur:
        out.append({"_id": str(doc["_id"]), "name": doc.get("name") or "Silo"})
    return out

# ========================= HISTORY (path params) =========================
@router.get("/history/{siloId}/{type}", response_model=list[dict])
async def get_history_path(
    siloId: str,
    type: str,
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    range: Optional[str] = Query(None, description="24h|7d|30d|all (frontend monta se custom)"),
    limit: int = Query(20000, ge=1, le=100000),
    svc: AnalysisService = Depends(get_service),
):
    # Se range veio, ele sobrescreve start/end
    if range is not None:
        s, e = _window_from_range(range)
        if s or e:
            start, end = s, e

    series = await svc.history(siloId, type, start, end, limit)
    # front espera array [{timestamp, value}] — devolvemos ISO 8601
    return [{"timestamp": p.t.isoformat(), "value": p.v} for p in series.points]

# ========================= HISTORY (query) =========================
@router.get("/history", response_model=SeriesResponse)
async def get_history_query(
    siloId: str = Query(...),
    type: Optional[str] = Query(None),
    sensorType: Optional[str] = Query(None, description="LEGADO: use 'type'"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    limit: int = Query(20000, ge=1, le=100000),
    svc: AnalysisService = Depends(get_service),
):
    stype = _normalize_type(type, sensorType)
    return await svc.history(siloId, stype, start, end, limit)

# ========================= AGGREGATE =========================
@router.get("/aggregate", response_model=AggregateResponse)
async def get_aggregate(
    siloId: str = Query(...),
    type: Optional[str] = Query(None),
    sensorType: Optional[str] = Query(None, description="LEGADO: use 'type'"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    limit: int = Query(100000, ge=1, le=150000),
    gran: str = Query("hour", pattern="^(minute|hour|day)$"),
    ma: Optional[int] = Query(None, ge=2, le=2000),
    svc: AnalysisService = Depends(get_service),
):
    stype = _normalize_type(type, sensorType)
    series = await svc.history(siloId, stype, start, end, limit)
    return await svc.aggregate(series, gran, ma)

# ========================= SCATTER =========================
@router.get("/scatter", response_model=ScatterResponse)
async def get_scatter(
    siloId: str = Query(...),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    limit: int = Query(50000, ge=100, le=150000),
    svc: AnalysisService = Depends(get_service),
):
    return await svc.scatter_temp_vs_hum(siloId, start, end, limit)

# ========================= MONTHLY (multi-ano) =========================
@router.get("/monthly")
async def get_monthly(
    siloId: str = Query(...),
    type: Optional[str] = Query(None),
    sensorType: Optional[str] = Query(None, description='LEGADO: use "type"'),
    years: Optional[str] = Query(None, description='CSV: "2023,2024,2025"'),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    last: Optional[int] = Query(3, ge=1, le=10),
    limit: int = Query(300000, ge=1, le=1000000),
    svc: AnalysisService = Depends(get_service),
) -> Dict[str, Any]:
    stype = _normalize_type(type, sensorType)

    payload = await svc.monthly_series(
        silo_id=siloId, sensor_type=stype,
        years_csv=years, start=start, end=end,
        last_years=last, limit=limit,
    )
    if not payload.get("years"):
        raise HTTPException(status_code=404, detail="Sem dados para o comparativo mensal")

    months = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"]
    series = [{"year": y, "values": [row.get(str(y)) for row in payload["rows"]]} for y in payload["years"]]
    table  = [{"month": row["label"], **{str(y): row.get(str(y)) for y in payload["years"]}} for row in payload["rows"]]
    return {
        "sensorType": stype,
        "years": payload["years"],
        "months": months,
        "series": series,
        "table": table
    }

# ========================= DAILY (datas específicas) =========================
@router.get("/daily/specific")
async def daily_specific(
    siloId: str = Query(...),
    type: Optional[str] = Query(None),
    sensorType: Optional[str] = Query(None, description="LEGADO: use 'type'"),
    dates: str = Query(..., description="CSV ISO: 2025-10-01,2025-11-01,2026-11-01"),
    gran: str = Query("hour", pattern="^(5min|hour)$"),
    windowH: int = Query(24, ge=1, le=72),
    weekday: Optional[int] = Query(None, ge=0, le=6),  # 0=Seg .. 6=Dom
    limit: int = Query(300000),
    svc: AnalysisService = Depends(get_service),
):
    stype = _normalize_type(type, sensorType)
    iso_dates = [d.strip() for d in dates.split(",") if d.strip()]
    payload = await svc.compare_specific_days(
        silo_id=siloId, sensor_type=stype, iso_dates=iso_dates,
        gran=gran, window_h=windowH, weekday=weekday, limit=limit
    )
    if not payload.get("series"):
        raise HTTPException(status_code=404, detail="Sem dados para as datas informadas")
    return payload

# ========================= SEASONAL PROFILE (perfil sazonal) =========================
@router.get("/seasonal/profile")
async def seasonal_profile(
    siloId: str = Query(...),
    type: Optional[str] = Query(None),
    sensorType: Optional[str] = Query(None, description="LEGADO: use 'type'"),
    month: int = Query(..., ge=1, le=12),
    day: int = Query(..., ge=1, le=31),
    yearStart: int = Query(...),
    yearEnd: int = Query(...),
    gran: str = Query("hour", pattern="^(5min|hour|day)$"),
    smooth: Optional[int] = Query(None, ge=2, le=48),
    showBands: bool = Query(True),
    limit: int = Query(600000),
    svc: AnalysisService = Depends(get_service),
):
    stype = _normalize_type(type, sensorType)
    payload = await svc.seasonal_profile_day(
        silo_id=siloId, sensor_type=stype, month=month, day=day,
        y0=yearStart, y1=yearEnd, gran=gran, smooth=smooth,
        show_bands=showBands, limit=limit
    )
    if not payload.get("series") and not payload.get("perYear"):
        raise HTTPException(status_code=404, detail="Sem dados para o perfil sazonal")
    return payload

# ========================= EXPORT CSV =========================
@router.get("/export.csv")
async def export_csv(
    siloId: str = Query(...),
    type: Optional[str] = Query(None),
    sensorType: Optional[str] = Query(None, description="LEGADO: use 'type'"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    range: Optional[str] = Query(None, description="24h|7d|30d|all"),
    limit: int = Query(100000, ge=1, le=150000),
    svc: AnalysisService = Depends(get_service),
):
    stype = _normalize_type(type, sensorType)

    # range sobrescreve start/end
    if range is not None:
        s, e = _window_from_range(range)
        if s or e:
            start, end = s, e

    series = await svc.history(siloId, stype, start, end, limit)
    csv_bytes = svc.to_csv(series)
    headers = {"Content-Disposition": f'attachment; filename="agrosilo_{stype}_history.csv"'}
    return StreamingResponse(iter([csv_bytes]), media_type="text/csv", headers=headers)

# ========================= REPORT PDF (compatível) =========================
async def _report_common(
    siloId: str, type_: str, start: Optional[datetime], end: Optional[datetime],
    limit: int, siloName: str, periodLabel: str, logoPath: Optional[str],
    svc: AnalysisService
):
    series = await svc.history(siloId, type_, start, end, limit)
    if not series.points:
        raise HTTPException(status_code=404, detail="Sem dados neste período")
    summary = await svc.summary(series)
    if not summary:
        raise HTTPException(status_code=404, detail="Sem dados para sumarizar")
    pdf_bytes = svc.to_pdf(series, summary, silo_name=siloName, period_label=periodLabel, logo_path=logoPath)
    headers = {"Content-Disposition": f'attachment; filename="agrosilo_{type_}_report.pdf"'}
    return StreamingResponse(iter([pdf_bytes]), media_type="application/pdf", headers=headers)

@router.get("/report")
async def report_pdf_noext(
    siloId: str = Query(...),
    type: Optional[str] = Query(None),
    sensorType: Optional[str] = Query(None, description="LEGADO: use 'type'"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    range: Optional[str] = Query(None, description="24h|7d|30d|all"),
    limit: int = Query(50000, ge=100, le=150000),
    siloName: str = Query("Silo"),
    periodLabel: str = Query("Todo o período"),
    logoPath: Optional[str] = Query(None),
    svc: AnalysisService = Depends(get_service),
):
    stype = _normalize_type(type, sensorType)

    # range sobrescreve start/end e ajusta label, se apropriado
    if range is not None:
        s, e = _window_from_range(range)
        if s or e:
            start, end = s, e
            if periodLabel == "Todo o período":
                periodLabel = _label_from_range(range, periodLabel)

    return await _report_common(siloId, stype, start, end, limit, siloName, periodLabel, logoPath, svc)

@router.get("/report.pdf")
async def report_pdf_ext(
    siloId: str = Query(...),
    type: Optional[str] = Query(None),
    sensorType: Optional[str] = Query(None, description="LEGADO: use 'type'"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    range: Optional[str] = Query(None, description="24h|7d|30d|all"),
    limit: int = Query(50000, ge=100, le=150000),
    siloName: str = Query("Silo"),
    periodLabel: str = Query("Todo o período"),
    logoPath: Optional[str] = Query(None),
    svc: AnalysisService = Depends(get_service),
):
    stype = _normalize_type(type, sensorType)

    if range is not None:
        s, e = _window_from_range(range)
        if s or e:
            start, end = s, e
            if periodLabel == "Todo o período":
                periodLabel = _label_from_range(range, periodLabel)

    return await _report_common(siloId, stype, start, end, limit, siloName, periodLabel, logoPath, svc)
