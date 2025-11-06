"""
thresholds.py
Faixas operacionais (Embrapa Soja) — seu documento é a FONTE DE VERDADE.

Princípio SOLID (O): se amanhã mudar uma faixa, alteramos só aqui.
"""

from dataclasses import dataclass
from typing import Tuple


@dataclass(frozen=True)
class HumidityBands:
    # valores em %
    ideal_max: float = 13.0
    moderate_max: float = 16.0  # (13–16)
    # >16 crítico


@dataclass(frozen=True)
class TemperatureBands:
    # °C — ideal ~15; moderado 20–30; crítico 40–55 (acima de 40 já é crítico)
    ideal_target: float = 15.0
    moderate_min: float = 20.0
    moderate_max: float = 30.0
    critical_min: float = 40.0  # >=40 crítico (e até 55 alta severidade)


@dataclass(frozen=True)
class CO2Bands:
    # ppm
    ideal_min: int = 400
    ideal_max: int = 600
    moderate_min: int = 600
    moderate_max: int = 1100
    critical_min: int = 5000  # >5000 crítico


HUM = HumidityBands()
TMP = TemperatureBands()
CARB = CO2Bands()


def classify_value(sensor_type: str, v: float) -> str:
    """
    Retorna uma banda: 'normal' | 'caution' | 'warning' | 'critical'
    (usamos os nomes para combinar com alertas existentes).
    """
    st = sensor_type.lower()

    if st == "humidity":
        if v <= HUM.ideal_max:
            return "normal"
        if v <= HUM.moderate_max:
            return "warning"  # (moderado ~ risco acelerado)
        return "critical"

    if st == "temperature":
        if v < TMP.moderate_min:
            return "normal"  # em torno de 15 °C
        if TMP.moderate_min <= v <= TMP.moderate_max:
            return "warning"
        if v >= TMP.critical_min:
            return "critical"
        return "normal"

    if st == "co2":
        if CARB.ideal_min <= v <= CARB.ideal_max:
            return "normal"
        if CARB.moderate_min <= v <= CARB.moderate_max:
            return "warning"
        if v >= CARB.critical_min:
            return "critical"
        # abaixo de 400 ppm (vento muito limpo) tratamos como normal
        return "normal"

    # pressure (sem faixas específicas => tratamos como normal)
    return "normal"


def airflow_recommendation(humidity: float) -> Tuple[float, float]:
    """
    Recomendação de vazão de aeração (m³/min·t) em função da umidade:
      - <13% => 0,10–0,25
      - 13–15% => 0,25–0,50
      - >15% => 0,50–1,00
    """
    if humidity < 13.0:
        return (0.10, 0.25)
    if humidity <= 15.0:
        return (0.25, 0.50)
    return (0.50, 1.00)
