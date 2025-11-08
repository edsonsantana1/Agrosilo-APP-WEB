from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import cm
from reportlab.lib import colors

# ... (restante dos imports já existem no seu arquivo)

class AnalysisService:
    # ... (toda a classe como já está)

    # ---------- helpers visuais p/ PDF ----------
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
    def _draw_card(c: canvas.Canvas, x: float, y: float, w: float, h: float, title: str, value: str):
        c.setStrokeColor(colors.HexColor("#E5E7EB"))
        c.setFillColor(colors.white)
        c.roundRect(x, y-h, w, h, 8, stroke=1, fill=1)
        c.setFont("Helvetica", 9)
        c.setFillColor(colors.HexColor("#6B7280"))
        c.drawString(x+10, y-16, title)
        c.setFont("Helvetica-Bold", 16)
        c.setFillColor(colors.HexColor("#111111"))
        c.drawString(x+10, y-40, value)

    @staticmethod
    def _draw_header_pdf(c: canvas.Canvas, title: str, logo_path: str | None):
        w, h = A4
        margin = 40
        # logo (opcional)
        if logo_path:
            try:
                c.drawImage(
                    logo_path,
                    w - margin - 90, h - margin - 50,
                    width=90, height=50,
                    preserveAspectRatio=True, anchor='nw'
                )
            except Exception:
                pass
        c.setFont("Helvetica-Bold", 16)
        c.setFillColor(colors.HexColor("#155E3A"))  # verde mais técnico
        c.drawString(margin, h - margin - 12, title)
        c.setFillColor(colors.black)

    def to_pdf(
        self,
        series: "SeriesResponse",
        summary: "AnalysisSummary",
        silo_name: str,
        period_label: str,
        logo_path: str | None = None,
    ) -> bytes:
        """
        Gera um relatório técnico e explicativo com base nos filtros aplicados.
        - Usa os pontos retornados por `history` (já filtrados por silo/tipo/tempo)
        - Usa `summary` (stats + faixas + delta24)
        """
        # fallback de logo: usa a do frontend se nada vier
        if not logo_path:
            logo_path = "frontend/imagens/logo copy.png"

        w, h = A4
        margin = 40
        buf = BytesIO()
        c = canvas.Canvas(buf, pagesize=A4)

        # ---------- cabeçalho ----------
        self._draw_header_pdf(c, "Relatório Técnico de Análises - Agrosilo", logo_path)
        y = h - margin - 40

        sensor_label, unit = self._sensor_label_and_unit(series.sensorType)

        # metadados
        c.setFont("Helvetica", 10)
        meta = [
            f"Silo: {silo_name}",
            f"Sensor: {sensor_label} ({series.sensorType})",
            f"Período: {period_label}",
            f"Amostras: {summary.stats.n}",
        ]
        for ln in meta:
            c.drawString(margin, y, ln)
            y -= 14

        y -= 8

        # ---------- cards (valor atual, delta24, média, p95) ----------
        card_w = (w - 2*margin - 24) / 2
        card_h = 54
        x1, x2 = margin, margin + card_w + 24
        self._draw_card(c, x1, y, card_w, card_h, "Valor atual",
                        self._fmt(summary.last.v, unit))
        self._draw_card(c, x2, y, card_w, card_h, "Δ 24h",
                        f"{'+' if (summary.delta24 or 0) >= 0 else ''}{self._fmt(summary.delta24, unit)}")
        y -= (card_h + 14)
        self._draw_card(c, x1, y, card_w, card_h, "Média",
                        self._fmt(summary.stats.mean, unit))
        self._draw_card(c, x2, y, card_w, card_h, "p95",
                        self._fmt(summary.stats.p95, unit))
        y -= (card_h + 20)

        # ---------- seção 1: estatísticas ----------
        c.setFont("Helvetica-Bold", 12)
        c.drawString(margin, y, "1. Estatísticas Descritivas")
        y -= 16
        c.setFont("Helvetica", 10)
        s = summary.stats
        for ln in [
            f"Mín: {self._fmt(s.min, unit)} | Média: {self._fmt(s.mean, unit)} | Mediana: {self._fmt(s.median, unit)} | p95: {self._fmt(s.p95, unit)} | Máx: {self._fmt(s.max, unit)}",
            f"Desvio-padrão (σ): {self._fmt(s.stddev, unit)}"
        ]:
            c.drawString(margin, y, ln)
            y -= 14

        y -= 6

        # ---------- seção 2: distribuição por faixas ----------
        c.setFont("Helvetica-Bold", 12)
        c.drawString(margin, y, "2. Distribuição por Faixas de Risco (tempo e %)")
        y -= 16
        c.setFont("Helvetica", 10)
        total = max(1, summary.bands.normal_ms + summary.bands.caution_ms +
                       summary.bands.warning_ms + summary.bands.critical_ms)

        def line(lbl: str, ms: int) -> str:
            hrs = ms / 3_600_000.0
            pct = 100.0 * ms / total
            return f"{lbl:<8}  tempo={hrs:.2f} h  ({pct:.1f}%)"

        for lbl, ms in [
            ("Normal",   summary.bands.normal_ms),
            ("Caution",  summary.bands.caution_ms),
            ("Warning",  summary.bands.warning_ms),
            ("Critical", summary.bands.critical_ms),
        ]:
            c.drawString(margin, y, line(lbl, ms))
            y -= 14

        y -= 10

        # ---------- seção 3: como ler os gráficos (explicativo) ----------
        c.setFont("Helvetica-Bold", 12)
        c.drawString(margin, y, "3. Leitura dos Gráficos")
        y -= 16
        c.setFont("Helvetica", 10)
        bullet = [
            "- Série Temporal (tela): curva do período filtrado; use a média e o p95 para avaliar tendência e picos.",
            "- Comparativo Mensal por Ano (tela): compara a média mensal com meses equivalentes de anos anteriores.",
            "- Interpretação: desvios do padrão sazonal (ex.: mês atual muito acima da média histórica) são sinais de risco.",
        ]
        for ln in bullet:
            c.drawString(margin, y, ln)
            y -= 13

        # ---------- seção 4: notas analíticas por tipo ----------
        y -= 8
        c.setFont("Helvetica-Bold", 12)
        c.drawString(margin, y, "4. Notas Analíticas (por tipo de sensor)")
        y -= 16
        c.setFont("Helvetica", 10)

        if series.sensorType == "temperature":
            lines = [
                "• Temperatura do grão deve seguir (com atraso) a temperatura ambiente sazonal.",
                "• Picos sustentados (p.ex., p95 alto) indicam atividade biológica ou 'hot spots'.",
                "• Δ24h positivo recorrente sugere aquecimento interno — revisar aeração/vedação.",
            ]
        elif series.sensorType == "humidity":
            lines = [
                "• Umidade do ar intersticial deve estabilizar após a secagem; variações bruscas sugerem infiltração/condensação.",
                "• Tempo elevado em WARNING/CRITICAL requer ação imediata (aeração, inspeção de vedação).",
                f"• σ={self._fmt(s.stddev, unit)} alto indica instabilidade operacional (liga/desliga, infiltração).",
            ]
        elif series.sensorType == "co2":
            lines = [
                "• CO₂ deve permanecer baixo e estável após a aeração inicial.",
                "• Picos acima de limites históricos do mesmo mês são preditores fortes de infestação (fungos/pragas).",
            ]
        else:  # pressure
            lines = [
                "• A pressão deve acompanhar o regime climático; desvios internos indicam obstrução ou vedação incorreta.",
                "• Use a variação diária como insumo de calibração para modelos de aeração.",
            ]

        for ln in lines:
            c.drawString(margin, y, ln)
            y -= 13

        # ---------- rodapé ----------
        c.setFont("Helvetica", 9)
        c.setFillColor(colors.HexColor("#6B7280"))
        c.drawRightString(w - margin, margin,
                          f"Gerado em: {datetime.now().strftime('%d/%m/%Y, %H:%M:%S')}")
        c.setFillColor(colors.black)

        c.showPage()
        c.save()
        return buf.getvalue()


