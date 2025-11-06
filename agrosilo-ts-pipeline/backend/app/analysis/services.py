"""
services.py
Regras de negócio/analítica (estatística, agregações, conformidade, CSV/PDF).

SOLID:
- S: cada método faz uma coisa só (estatística, agregação, scatter, etc).
- O: trocar faixas (thresholds) não exige alterar a lógica do serviço.
- L/D: dependemos de uma interface (repos) passada no __init__ (injeção).
"""

from __future__ import annotations

from typing import List, Optional, Dict, Any, Iterable, Tuple
from datetime import datetime, timedelta
from io import BytesIO

import numpy as np
import pandas as pd
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import cm

from .thresholds import classify_value, airflow_recommendation
from .dtos import (
    Point, SeriesResponse, SummaryStats, BandBreakdown, AnalysisSummary,
    AggregateBucket, AggregateResponse, ScatterPoint, ScatterResponse
)
from .repositories import SensorRepository, ReadingRepository


class AnalysisService:
    def __init__(self, sensors: SensorRepository, readings: ReadingRepository):
        self.sensors = sensors
        self.readings = readings

    # ------------------ helpers privados ------------------
    @staticmethod
    def _to_point_list(rows: List[Dict[str, Any]]) -> List[Point]:
        return [Point(t=row["ts"], v=float(row["value"])) for row in rows]

    @staticmethod
    def _basic_stats(values: Iterable[float]) -> SummaryStats:
        arr = np.array(list(values), dtype=float)
        n = int(arr.size)
        if n == 0:
            return SummaryStats(n=0, min=0, mean=0, median=0, p95=0, max=0, stddev=0)

        arr_sorted = np.sort(arr)
        return SummaryStats(
            n=n,
            min=float(arr_sorted[0]),
            mean=float(arr.mean()),
            median=float(np.median(arr)),
            p95=float(np.percentile(arr, 95)),
            max=float(arr_sorted[-1]),
            stddev=float(arr.std(ddof=1) if n > 1 else 0.0),
        )

    @staticmethod
    def _bands_time_weighted(sensor_type: str, points: List[Point]) -> BandBreakdown:
        if len(points) < 2:
            return BandBreakdown(0, 0, 0, 0)

        def band(v: float) -> str:
            return classify_value(sensor_type, v)

        acc = {"normal": 0, "caution": 0, "warning": 0, "critical": 0}
        for i in range(1, len(points)):
            prev, cur = points[i - 1], points[i]
            dt_ms = int((cur.t - prev.t).total_seconds() * 1000)
            bucket = band(prev.v)
            acc[bucket] += max(0, dt_ms)

        return BandBreakdown(
            normal_ms=acc["normal"],
            caution_ms=acc["caution"],
            warning_ms=acc["warning"],
            critical_ms=acc["critical"],
        )

    # ------------------ endpoints: domínio ------------------

    async def history(
        self,
        silo_id: str,
        sensor_type: str,
        start: Optional[datetime],
        end: Optional[datetime],
        limit: int,
    ) -> SeriesResponse:
        ids = await self.sensors.ids_by_silo_and_type(silo_id, sensor_type)
        if not ids:
            return SeriesResponse(sensorType=sensor_type, points=[])

        rows = await self.readings.fetch_points(ids, start, end, limit)
        points = self._to_point_list(rows)
        return SeriesResponse(sensorType=sensor_type, points=points)

    async def summary(self, series: SeriesResponse) -> Optional[AnalysisSummary]:
        points = series.points
        if not points:
            return None

        stats = self._basic_stats([p.v for p in points])
        last = points[-1]

        # delta 24h
        dt24 = None
        ref_time = last.t - timedelta(hours=24)
        for p in points:
            if p.t >= ref_time:
                dt24 = last.v - p.v
                break

        bands = self._bands_time_weighted(series.sensorType, points)
        return AnalysisSummary(stats=stats, bands=bands, last=last, delta24=dt24)

    async def aggregate(
        self,
        series: SeriesResponse,
        gran: str,
        ma_window: Optional[int],
    ) -> AggregateResponse:
        points = series.points
        if not points:
            return AggregateResponse(sensorType=series.sensorType, gran=gran, buckets=[])

        df = pd.DataFrame({"t": [p.t for p in points], "v": [p.v for p in points]})
        df = df.set_index("t").sort_index()

        rule = {"minute": "1min", "hour": "1H", "day": "1D"}[gran]
        agg = df["v"].resample(rule).agg(["mean", "min", "max", "count"]).dropna()

        if ma_window and ma_window > 1:
            agg["ma"] = agg["mean"].rolling(ma_window, min_periods=1).mean()
        else:
            agg["ma"] = np.nan

        buckets = [
            AggregateBucket(
                t=idx.to_pydatetime(),
                avg=float(row["mean"]),
                min=float(row["min"]),
                max=float(row["max"]),
                count=int(row["count"]),
                ma=(None if np.isnan(row["ma"]) else float(row["ma"])),
            )
            for idx, row in agg.iterrows()
        ]

        return AggregateResponse(sensorType=series.sensorType, gran=gran, buckets=buckets)

    async def scatter_temp_vs_hum(
        self,
        silo_id: str,
        start: Optional[datetime],
        end: Optional[datetime],
        limit: int,
    ) -> ScatterResponse:
        # temperatura
        s_temp = await self.history(silo_id, "temperature", start, end, limit)
        # umidade
        s_hum = await self.history(silo_id, "humidity", start, end, limit)

        if not s_temp.points or not s_hum.points:
            return ScatterResponse(pairs=[])

        df_t = pd.DataFrame({"t": [p.t for p in s_temp.points], "x": [p.v for p in s_temp.points]}).set_index("t")
        df_h = pd.DataFrame({"t": [p.t for p in s_hum.points], "y": [p.v for p in s_hum.points]}).set_index("t")

        # junta por “mesma janela de 5 minutos” para reduzir ruído
        df_t5 = df_t.resample("5min").mean()
        df_h5 = df_h.resample("5min").mean()
        df = df_t5.join(df_h5, how="inner").dropna()

        pairs = [
            ScatterPoint(x=float(row["x"]), y=float(row["y"]), t=idx.to_pydatetime())
            for idx, row in df.iterrows()
        ]
        return ScatterResponse(pairs=pairs)

    # ------------------ exportações ------------------

    @staticmethod
    def to_csv(series: SeriesResponse) -> bytes:
        if not series.points:
            return b"t,v\n"

        df = pd.DataFrame({"t": [p.t for p in series.points], "v": [p.v for p in series.points]})
        df["t"] = df["t"].dt.tz_localize(None)  # defensivo
        return df.to_csv(index=False).encode("utf-8")

    @staticmethod
    def _draw_header_pdf(c: canvas.Canvas, title: str, logo_path: Optional[str]):
        w, h = A4  # 595 x 842 pt
        margin = 40
        # logo topo-direito, mantendo proporção (fit)
        if logo_path:
            try:
                c.drawImage(logo_path, w - margin - 120, h - margin - 60, width=120, height=60, preserveAspectRatio=True, anchor='nw')
            except Exception:
                pass
        c.setFont("Helvetica-Bold", 16)
        c.drawString(margin, h - margin - 20, title)

    def to_pdf(
        self,
        series: SeriesResponse,
        summary: AnalysisSummary,
        silo_name: str,
        period_label: str,
        logo_path: Optional[str] = None,
    ) -> bytes:
        """
        Relatório técnico compacto (A4). Para relatórios longos, migrar p/ ReportLab platypus.
        """
        w, h = A4
        margin = 40
        buf = BytesIO()
        c = canvas.Canvas(buf, pagesize=A4)

        # Header
        self._draw_header_pdf(c, "Relatório Técnico de Análises - Agrosilo", logo_path)
        y = h - margin - 80

        # Metadados
        c.setFont("Helvetica", 11)
        lines = [
            f"Silo: {silo_name}",
            f"Sensor: {series.sensorType}",
            f"Período: {period_label}",
            f"Amostras: {summary.stats.n}",
        ]
        for ln in lines:
            c.drawString(margin, y, ln); y -= 14

        # Cards
        y -= 10
        c.setFont("Helvetica", 10)
        def card(x, y, title, value):
            c.roundRect(x, y - 30, 8*cm, 2*cm, 8, stroke=1, fill=0)
            c.drawString(x+10, y+5, title)
            c.setFont("Helvetica-Bold", 14)
            c.drawString(x+10, y-12, value)
            c.setFont("Helvetica", 10)

        card(margin, y, "Valor atual", f"{summary.last.v:.2f}")
        card(margin + 9*cm, y, "Δ 24h", f"{(summary.delta24 or 0):+.2f}")
        y -= 65

        # Estatísticas
        c.setFont("Helvetica-Bold", 12); c.drawString(margin, y, "1. Estatísticas Descritivas"); y -= 16
        c.setFont("Helvetica", 10)
        s = summary.stats
        for ln in [
            f"Mín: {s.min:.2f} | Média: {s.mean:.2f} | Mediana: {s.median:.2f} | p95: {s.p95:.2f} | Máx: {s.max:.2f}",
            f"Desvio-padrão: {s.stddev:.2f}"
        ]:
            c.drawString(margin, y, ln); y -= 14

        # Bandas
        y -= 6
        c.setFont("Helvetica-Bold", 12); c.drawString(margin, y, "2. Distribuição por Faixas de Risco"); y -= 16
        c.setFont("Helvetica", 10)
        total = max(1, summary.bands.normal_ms + summary.bands.caution_ms + summary.bands.warning_ms + summary.bands.critical_ms)
        def pct(ms): 
            return 100.0 * ms / total
        for label, ms in [
            ("Normal", summary.bands.normal_ms),
            ("Caution", summary.bands.caution_ms),
            ("Warning", summary.bands.warning_ms),
            ("Critical", summary.bands.critical_ms),
        ]:
            c.drawString(margin, y, f"{label:<8}  tempo={ms/3600000:.2f} h  ({pct(ms):.1f}%)"); y -= 14

        # Recomendação de vazão (quando sensorType = humidity)
        if series.sensorType == "humidity":
            flow = airflow_recommendation(summary.last.v)
            y -= 10
            c.setFont("Helvetica-Bold", 12); c.drawString(margin, y, "3. Recomendação de Aeração"); y -= 16
            c.setFont("Helvetica", 10)
            c.drawString(margin, y, f"Vazão alvo: {flow[0]:.2f}–{flow[1]:.2f} m³/min·t (segundo Embrapa/guia interno).")
            y -= 14

        c.setFont("Helvetica", 9)
        c.drawRightString(w - margin, margin, f"Gerado em: {datetime.now().strftime('%d/%m/%Y, %H:%M:%S')}")
        c.showPage()
        c.save()

        return buf.getvalue()
