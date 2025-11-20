# app/forecast_spark/router.py
"""
Router da previsão.

Endpoint:
  GET /analysis/forecast/{silo_id}?type=temperature|humidity

Se o query param "type" não for enviado, assume "temperature".
"""

from fastapi import APIRouter, Query

from .service import run_full_forecast, DEFAULT_SENSOR_TYPE

router = APIRouter(prefix="/analysis", tags=["forecast"])


@router.get("/forecast/{silo_id}")
async def forecast_silo(
    silo_id: str,
    type: str = Query(
        DEFAULT_SENSOR_TYPE,
        description="Tipo de sensor: 'temperature' ou 'humidity'"
    ),
):
    # Apenas repassa o tipo para o serviço
    result = run_full_forecast(silo_id_str=silo_id, sensor_type=type)
    return result

