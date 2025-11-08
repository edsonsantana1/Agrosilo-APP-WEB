"""
Regras de negócio/analítica (estatística, agregações, comparações sazonais, CSV/PDF).

SOLID:
- S: métodos com responsabilidade única (history, aggregate, seasonal_profile_day, etc.).
- O: thresholds/heurísticas e métricas podem evoluir sem quebrar a API do serviço.
- L/D: Repositórios são injetados no __init__ (injeção de dependência) e acessados por adaptadores tolerantes.
"""

from __future__ import annotations

from typing import List, Optional, Dict, Any, Iterable, Sequence, Union, Callable, Awaitable
from datetime import datetime, timedelta
from io import BytesIO
import os

import numpy as np
import pandas as pd
from bson import ObjectId
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from .thresholds import classify_value
from .dtos import (
    Point, SeriesResponse, SummaryStats, BandBreakdown, AnalysisSummary,
    AggregateBucket, AggregateResponse, ScatterPoint, ScatterResponse
)
from ..repositories import SensorRepository, ReadingRepository

SensorId = Union[str, ObjectId]


def _as_oid(v: str) -> Optional[ObjectId]:
    try:
        return ObjectId(v)
    except Exception:
        return None


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
            return BandBreakdown(normal_ms=0, caution_ms=0, warning_ms=0, critical_ms=0)

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

    # ------------------ util: obter IDs de sensores ------------------
    async def _sensor_ids_by_silo_and_type_fallback(self, silo_id: str, sensor_type: str) -> List[ObjectId]:
        col = getattr(self.sensors, "col", None)
        if col is None:
            db = getattr(self.sensors, "db", None)
            if db is None:
                return []
            col = db.get_collection("sensors")

        ids: List[ObjectId] = []
        queries: List[Dict[str, Any]] = []
        oid = _as_oid(silo_id)
        if oid:
            queries.append({"silo": oid, "type": sensor_type})
        queries.append({"silo": silo_id, "type": sensor_type})

        for q in queries:
            async for doc in col.find(q, {"_id": 1}):
                sid = doc.get("_id")
                if isinstance(sid, ObjectId):
                    ids.append(sid)
            if ids:
                break
        return ids

    async def _get_sensor_ids(self, silo_id: str, sensor_type: str) -> List[ObjectId]:
        if hasattr(self.sensors, "ids_by_silo_and_type"):
            # type: ignore
            return await getattr(self.sensors, "ids_by_silo_and_type")(silo_id, sensor_type)
        return await self._sensor_ids_by_silo_and_type_fallback(silo_id, sensor_type)

    # ------------------ util: adaptador de leituras ------------------
    async def _readings_adapter(
        self,
        ids: Sequence[ObjectId],
        start: Optional[datetime],
        end: Optional[datetime],
        limit: int
    ) -> List[Dict[str, Any]]:
        """
        Tenta métodos comuns do repositório; se não existirem, cai numa agregação Mongo robusta.
        Retorna [{ts: datetime, value: float}] ordenados por ts asc.
        """
        # 1) tenta métodos conhecidos
        for name in ("get_readings", "fetch_points", "fetch_series", "list_points"):
            if hasattr(self.readings, name):
                fn: Callable[..., Awaitable[List[Dict[str, Any]]]] = getattr(self.readings, name)  # type: ignore
                return await fn(ids, start, end, limit)

        # 2) fallback: agregação direta
        db = getattr(self.readings, "db", None)
        col = getattr(self.readings, "col", None)
        if col is None:
            if db is None:
                db = getattr(self.sensors, "db", None)
                if db is None:
                    return []
            col = db.get_collection("readings")

        sids = list(ids)
        if not sids:
            return []

        match_sensor = {
            "$or": [
                {"sensorId": {"$in": sids}},
                {"sensor": {"$in": sids}},
            ]
        }

        pipeline: List[Dict[str, Any]] = [
            {"$match": match_sensor},
            {"$addFields": {
                "__ts_raw": {
                    "$ifNull": [
                        "$ts",
                        {"$ifNull": [
                            "$timestamp",
                            {"$ifNull": ["$time", "$createdAt"]}
                        ]}
                    ]
                },
                "__value_raw": {
                    "$ifNull": [
                        "$value",
                        {"$ifNull": [
                            "$v",
                            {"$ifNull": [
                                "$val",
                                {"$ifNull": ["$reading", "$data.value"]}
                            ]}
                        ]}
                    ]
                }
            }},
            {"$addFields": {
                "__ts": {
                    "$cond": [
                        {"$eq": [{"$type": "$__ts_raw"}, "date"]},
                        "$__ts_raw",
                        {"$convert": {"input": "$__ts_raw", "to": "date", "onError": None, "onNull": None}}
                    ]
                }
            }},
            {"$addFields": {
                "__value": {
                    "$cond": [
                        {"$in": [{"$type": "$__value_raw"}, ["double", "int", "long", "decimal"]]},
                        "$__value_raw",
                        {"$convert": {"input": "$__value_raw", "to": "double", "onError": None, "onNull": None}}
                    ]
                }
            }},
            {"$match": {"__ts": {"$ne": None}, "__value": {"$ne": None}}},
        ]

        time_cond: Dict[str, Any] = {}
        if start:
            time_cond["$gte"] = start
        if end:
            time_cond["$lte"] = end
        if time_cond:
            pipeline.append({"$match": {"__ts": time_cond}})

        pipeline += [
            {"$sort": {"__ts": 1}},
            {"$limit": int(limit)},
            {"$project": {"_id": 0, "ts": "$__ts", "value": "$__value"}},
        ]

        out: List[Dict[str, Any]] = []
        async for doc in col.aggregate(pipeline, allowDiskUse=True):
            ts, val = doc.get("ts"), doc.get("value")
            try:
                val = float(val)
            except Exception:
                continue
            out.append({"ts": ts, "value": val})
        return out

    # ------------------ endpoints: domínio ------------------
    async def history(
        self,
        silo_id: str,
        sensor_type: str,
        start: Optional[datetime],
        end: Optional[datetime],
        limit: int,
    ) -> SeriesResponse:
        ids = await self._get_sensor_ids(silo_id, sensor_type)
        if not ids:
            return SeriesResponse(sensorType=sensor_type, points=[])

        rows = await self._readings_adapter(ids, start, end, limit)
        points = self._to_point_list(rows)
        return SeriesResponse(sensorType=sensor_type, points=points)

    async def summary(self, series: SeriesResponse) -> Optional[AnalysisSummary]:
        points = series.points
        if not points:
            return None

        stats = self._basic_stats([p.v for p in points])
        last = points[-1]

        dt24 = None
        ref_time = last.t - timedelta(hours=24)
        for p in points:
            if p.t >= ref_time:
                dt24 = last.v - p.v
                break

        bands = self._bands_time_weighted(series.sensorType, points)
        return AnalysisSummary(stats=stats, bands=bands, last=last, delta24=dt24)

    def _normalize_index_tz(self, df: pd.DataFrame) -> pd.DataFrame:
        """Remove timezone do índice datetime, defensivamente."""
        try:
            if getattr(df.index, "tz", None) is not None:
                df.index = df.index.tz_convert("UTC").tz_localize(None)
        except Exception:
            try:
                df.index = df.index.tz_localize(None)
            except Exception:
                pass
        return df

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
        df = self._normalize_index_tz(df)

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
        s_temp = await self.history(silo_id, "temperature", start, end, limit)
        s_hum = await self.history(silo_id, "humidity", start, end, limit)

        if not s_temp.points or not s_hum.points:
            return ScatterResponse(pairs=[])

        df_t = pd.DataFrame({"t": [p.t for p in s_temp.points], "x": [p.v for p in s_temp.points]}).set_index("t")
        df_h = pd.DataFrame({"t": [p.t for p in s_hum.points], "y": [p.v for p in s_hum.points]}).set_index("t")

        df_t = self._normalize_index_tz(df_t)
        df_h = self._normalize_index_tz(df_h)

        df_t5 = df_t.resample("5min").mean()
        df_h5 = df_h.resample("5min").mean()
        df = df_t5.join(df_h5, how="inner").dropna()

        pairs = [ScatterPoint(x=float(row["x"]), y=float(row["y"]), t=idx.to_pydatetime()) for idx, row in df.iterrows()]
        return ScatterResponse(pairs=pairs)

    # ------------------ Séries mensais por ano ------------------
    async def monthly_series(
        self,
        silo_id: str,
        sensor_type: str,
        years_csv: Optional[str],
        start: Optional[datetime],
        end: Optional[datetime],
        last_years: Optional[int],
        limit: int = 300000,
    ) -> Dict[str, Any]:
        # 1) Resolve janela temporal
        years: List[int]
        if years_csv:
            years = []
            for y in years_csv.split(","):
                y = y.strip()
                if y.isdigit():
                    years.append(int(y))
            years = sorted(set(years))
            if not years:
                return {"years": [], "rows": []}
            a, b = min(years), max(years)
            start = datetime(a, 1, 1)
            end = datetime(b, 12, 31, 23, 59, 59)
        elif start and end:
            years = list(range(start.year, end.year + 1))
        else:
            last_years = last_years or 3
            this_year = datetime.now().year
            years = list(range(this_year - last_years + 1, this_year + 1))
            start = datetime(years[0], 1, 1)
            end = datetime(years[-1], 12, 31, 23, 59, 59)

        # 2) Histórico
        series = await self.history(silo_id, sensor_type, start, end, limit)
        if not series.points:
            return {"years": years, "rows": [
                {"month": m, "label": l, **{str(y): None for y in years}}
                for m, l in enumerate(["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"], start=1)
            ]}

        df = pd.DataFrame({"t": [p.t for p in series.points], "v": [p.v for p in series.points]}).set_index("t").sort_index()
        df = self._normalize_index_tz(df)
        if df.empty:
            return {"years": years, "rows": []}

        # 3) Média diária -> média por (ano,mês)
        daily = df["v"].resample("1D").mean()
        grp = daily.groupby([daily.index.year.rename("year"), daily.index.month.rename("month")]).mean()
        grp = grp.to_frame("mean").reset_index()

        # 4) Matriz 12 x N anos
        month_labels = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]
        rows: List[Dict[str, Any]] = []
        for m in range(1, 13):
            row: Dict[str, Any] = {"month": m, "label": month_labels[m-1]}
            for y in years:
                sel = grp.loc[(grp["year"] == y) & (grp["month"] == m), "mean"]
                row[str(y)] = (None if sel.empty or np.isnan(sel.values[0]) else float(round(sel.values[0], 2)))
            rows.append(row)

        return {"years": years, "rows": rows}

    # ------------------ Comparação de datas específicas ------------------
    async def compare_specific_days(
        self,
        silo_id: str,
        sensor_type: str,
        iso_dates: List[str],
        gran: str,
        window_h: int,
        weekday: Optional[int],
        limit: int,
    ) -> Dict[str, Any]:
        """
        Para cada data D, pega janela [D-±window_h, D+±window_h], reamostra e alinha
        por tempo relativo (t = -window_h .. +window_h). Opcional: filtrar weekday.
        """
        step = {"5min": "5min", "hour": "1H"}[gran]
        half = timedelta(hours=window_h)

        # eixo relativo
        rel_axis = pd.date_range(
            start=pd.Timestamp(0, unit="h") - pd.to_timedelta(window_h, unit="h"),
            end=pd.Timestamp(0, unit="h") + pd.to_timedelta(window_h, unit="h"),
            freq=step,
        )

        out = []
        for s in iso_dates:
            try:
                center = pd.to_datetime(s)
            except Exception:
                continue
            start, end = center - half, center + half

            series = await self.history(silo_id, sensor_type, start.to_pydatetime(), end.to_pydatetime(), limit)
            if not series.points:
                out.append({"label": s, "values": [None]*len(rel_axis)})
                continue

            df = pd.DataFrame({"t": [p.t for p in series.points], "v": [p.v for p in series.points]}).set_index("t").sort_index()
            df = self._normalize_index_tz(df)
            if weekday is not None:
                df = df[df.index.weekday == int(weekday)]

            df["rel"] = (df.index - center).total_seconds()
            df = df.set_index(pd.to_timedelta(df["rel"], unit="s"))["v"].resample(step).mean()

            aligned = df.reindex(pd.to_timedelta(rel_axis.view("i8")))
            vals = [None if pd.isna(v) else float(round(v, 2)) for v in aligned.values]
            out.append({"label": s, "values": vals})

        # rótulos do eixo em horas relativas
        labels = [(i - len(rel_axis)//2) for i in range(len(rel_axis))]
        return {"sensorType": sensor_type, "relHours": labels, "series": out}

    # ------------------ exportações ------------------
    @staticmethod
    def to_csv(series: SeriesResponse) -> bytes:
        if not series.points:
            return b"t,v\n"
        df = pd.DataFrame({"t": [p.t for p in series.points], "v": [p.v for p in series.points]})
        df["t"] = df["t"].dt.tz_localize(None)
        return df.to_csv(index=False).encode("utf-8")

    @staticmethod
    def _draw_header_pdf(c: canvas.Canvas, title: str, logo_path: Optional[str]):
        w, h = A4
        margin = 40
        if logo_path:
            try:
                c.drawImage(logo_path, w - margin - 120, h - margin - 60,
                            width=120, height=60, preserveAspectRatio=True, anchor='nw')
            except Exception:
                pass
        c.setFont("Helvetica-Bold", 16)
        c.setFillColor(colors.black)
        c.drawString(margin, h - margin - 20, title)

    # ======= Helpers visuais (dentro da classe) =======
    @staticmethod
    def _sensor_label_and_unit(sensor_type: str) -> tuple[str, str]:
        mapping = {
            "temperature": ("Temperatura", "°C"),
            "humidity": ("Umidade", "%"),
            "pressure": ("Pressão Atmosférica", "hPa"),
            "co2": ("Gás CO₂", "ppm"),
        }
        return mapping.get(sensor_type, (sensor_type, ""))

    @staticmethod
    def _fmt(v: float | None, unit: str = "", d: int = 2) -> str:
        if v is None:
            return "—"
        try:
            return f"{float(v):.{d}f}{(' ' + unit) if unit else ''}"
        except Exception:
            return str(v)

    @staticmethod
    def _draw_table(c: canvas.Canvas, x: float, y: float, col_widths: List[float], rows: List[List[Any]],
                    header_fill=colors.HexColor("#1b5e20"),
                    header_text=colors.white,
                    grid=colors.HexColor("#e5e7eb"),
                    zebra=colors.HexColor("#f8fafc")) -> float:
        """
        Tabela com cabeçalho verde e zebra; retorna novo y.
        A largura total da tabela é sum(col_widths). O 'x' deve ser o mesmo 'margin'.
        """
        row_h = 18.0
        total_w = float(sum(col_widths))

        # Cabeçalho
        c.setFillColor(header_fill); c.setStrokeColor(header_fill)
        c.rect(x, y - row_h, total_w, row_h, fill=1, stroke=0)
        c.setFillColor(header_text); c.setFont("Helvetica-Bold", 10)

        cx = x
        for i, head in enumerate(rows[0]):
            c.drawString(cx + 6, y - 13, str(head))
            cx += col_widths[i]
        y -= row_h

        # Linhas
        for r_i, row in enumerate(rows[1:], start=1):
            if r_i % 2 == 0:
                c.setFillColor(zebra)
                c.rect(x, y - row_h, total_w, row_h, fill=1, stroke=0)

            c.setFillColor(colors.black); c.setFont("Helvetica", 9)
            cx = x
            for i, cell in enumerate(row):
                c.setStrokeColor(grid)
                c.rect(cx, y - row_h, col_widths[i], row_h, fill=0, stroke=1)
                c.drawString(cx + 6, y - 13, str(cell))
                cx += col_widths[i]
            y -= row_h
        return y

    @staticmethod
    def _card(c: canvas.Canvas, x: float, y_top: float, title: str, value: str,
              w_card: float, h_card: float = 56.0) -> None:
        """
        Cartão com borda arredondada.
        x = left; y_top = baseline superior; w_card = largura do cartão.
        """
        c.setStrokeColor(colors.HexColor("#cbd5e1"))
        c.roundRect(x, y_top - 30, w_card, h_card, 8, stroke=1, fill=0)
        c.setFont("Helvetica", 9);  c.setFillColor(colors.HexColor("#64748b"))
        c.drawString(x + 10, y_top + 5, title)
        c.setFont("Helvetica-Bold", 14); c.setFillColor(colors.black)
        c.drawString(x + 10, y_top - 12, value)

    # ------------------ PDF (grid A4 alinhado) ------------------
    def to_pdf(
        self,
        series: SeriesResponse,
        summary: AnalysisSummary,
        silo_name: str,
        period_label: str,
        logo_path: Optional[str] = None,
    ) -> bytes:
        print("[AnalysisService] Using NEW to_pdf layout (A4 grid aligned)")

        w, h = A4
        margin = 40.0
        gutter = 24.0
        content_w = w - 2 * margin  # largura útil alinhada ao A4

        buf = BytesIO()
        c = canvas.Canvas(buf, pagesize=A4)

        # Logo por env (fallback)
        logo_path = logo_path or os.getenv("AGROSILO_LOGO_PATH")

        # Cabeçalho
        self._draw_header_pdf(c, "Relatório Técnico de Análises - Agrosilo", logo_path)

        # Metadados
        sensor_label, unit = self._sensor_label_and_unit(series.sensorType)
        y = h - margin - 60
        c.setFont("Helvetica", 11); c.setFillColor(colors.black)
        for ln in [
            f"Silo: {silo_name}",
            f"Sensor: {sensor_label} ({series.sensorType})",
            f"Período: {period_label}",
            f"Amostras: {summary.stats.n}",
        ]:
            c.drawString(margin, y, ln); y -= 14

        y -= 18  # respiro

        # Cards (2 colunas)
        card_w = (content_w - gutter) / 2.0
        x1 = margin
        x2 = margin + card_w + gutter
        self._card(c, x1, y, "Valor atual", self._fmt(summary.last.v, unit), w_card=card_w)
        self._card(c, x2, y, "Δ 24h",      self._fmt(summary.delta24 or 0, unit), w_card=card_w)
        y -= 76

        # 1) Estatísticas
        c.setFont("Helvetica-Bold", 12); c.drawString(margin, y, "1. Estatísticas Descritivas"); y -= 10
        s = summary.stats
        stat_rows = [
            ["Métrica", "Valor"],
            ["Mínimo",        self._fmt(s.min, unit)],
            ["Média",         self._fmt(s.mean, unit)],
            ["Mediana (p50)", self._fmt(s.median, unit)],
            ["p95",           self._fmt(s.p95, unit)],
            ["Máximo",        self._fmt(s.max, unit)],
            ["Desvio-padrão", self._fmt(s.stddev, unit)],
        ]
        y -= 8
        stat_col_w = [0.35 * content_w, 0.65 * content_w]
        y = self._draw_table(c, margin, y, stat_col_w, stat_rows)
        y -= 14

        # 2) Faixas de Risco
        c.setFont("Helvetica-Bold", 12); c.drawString(margin, y, "2. Distribuição por Faixas de Risco"); y -= 10
        b = summary.bands
        total = max(1, b.normal_ms + b.caution_ms + b.warning_ms + b.critical_ms)
        as_h = lambda ms: f"{ms / 3_600_000:.2f} h"
        as_p = lambda ms: f"{(100.0 * ms / total):.1f}%"
        band_rows = [
            ["Faixa", "Tempo acumulado", "% do período"],
            ["Normal",   as_h(b.normal_ms),   as_p(b.normal_ms)],
            ["Atenção",  as_h(b.caution_ms),  as_p(b.caution_ms)],
            ["Alerta",   as_h(b.warning_ms),  as_p(b.warning_ms)],
            ["Crítico",  as_h(b.critical_ms), as_p(b.critical_ms)],
        ]
        y -= 8
        band_col_w = [0.38 * content_w, 0.42 * content_w, 0.20 * content_w]
        y = self._draw_table(c, margin, y, band_col_w, band_rows)
        y -= 14

        # 3) Notas
        c.setFont("Helvetica-Bold", 12); c.drawString(margin, y, "3. Notas de Leitura"); y -= 16
        c.setFont("Helvetica", 10)
        for ln in [
            "- Estatísticas calculadas sobre o período filtrado (ver cabeçalho).",
            "- p95 indica o valor abaixo do qual ficaram 95% das leituras.",
            "- A distribuição por faixas usa os mesmos limites do módulo de alertas e é ponderada pelo tempo entre amostras.",
            "- Δ24h compara o valor atual com uma leitura de referência a ~24 horas.",
        ]:
            c.drawString(margin, y, ln); y -= 12

        # Rodapé
        c.setFont("Helvetica", 9); c.setFillColor(colors.black)
        c.drawRightString(w - margin, margin, f"Gerado em: {datetime.now().strftime('%d/%m/%Y, %H:%M:%S')}")
        c.showPage(); c.save()
        return buf.getvalue()
