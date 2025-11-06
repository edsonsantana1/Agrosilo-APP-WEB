# agrosilo-ts-pipeline/backend/app/services.py 
from datetime import datetime, timezone
from typing import List, Tuple, Optional
from bson import ObjectId
from .domain import IReadingRepository, ISensorRepository, Reading
import os

def _env_float(key: str, default: float) -> float:
    """
    Converte variável de ambiente para float com fallback seguro.
    - Evita ValueError ao ler ENV; mantém resiliência do serviço.
    """
    try:
        return float(os.getenv(key, str(default)))
    except:
        return default

class IngestService:
    """
    Serviço de ingestão e tratamento:
    - Coleta (via ts_client), normaliza, valida, filtra ruído (anti-salto),
      persiste (repositórios) e gera assessment.
    - Aplica SRP (regra de negócio/limpeza aqui) e DIP (depende de interfaces).
    """
    def __init__(self, ts_client, sensor_repo: ISensorRepository, reading_repo: IReadingRepository):
        # Dependências injetadas (DIP): cliente de coleta e repositórios.
        self.ts = ts_client
        self.sensors = sensor_repo
        self.readings = reading_repo

        # Parametrização via ENV (OCP): permite ajustar sem alterar código.
        self.silo_id = os.getenv("SILO_ID")
        self.f_temp = int(os.getenv("TS_FIELD_TEMP", 1))
        self.f_hum  = int(os.getenv("TS_FIELD_HUM", 2))
        self.results = int(os.getenv("TS_FETCH_RESULTS", 100))
        if not self.silo_id:
            # Fail-fast: evita pipeline sem contexto obrigatório de silo.
            raise ValueError("SILO_ID deve ser definido no ambiente.")

        # (opcional) pressão – campo ativado apenas se existir no ENV.
        self.f_press = os.getenv("TS_FIELD_PRESS")

        # Limiares de negócio (soja). Mantidos em ENV para calibragem operacional.
        self.h_ok_max   = _env_float("SOY_HUM_OK_MAX",   13.0)
        self.h_adm_max  = _env_float("SOY_HUM_ADM_MAX",  14.0)
        self.h_crit_min = _env_float("SOY_HUM_CRIT_MIN", 16.0)

        self.t_ok_max   = _env_float("SOY_TEMP_OK_MAX",    15.0)
        self.t_alert    = _env_float("SOY_TEMP_ALERT_MIN", 20.0)
        self.t_crit     = _env_float("SOY_TEMP_CRIT_MIN",  30.0)
        self.t_vhigh    = _env_float("SOY_TEMP_VHIGH_MIN", 40.0)

        # Anti-salto (spike filter) simples para reduzir ruído de medição/transmissão.
        self.spike_temp = 10.0
        self.spike_hum  = 30.0

        # Regras de aeração (m³/min/ton), também parametrizáveis (OCP).
        self.air_low  = (_env_float("SOY_AIR_LOW_MIN",  0.10), _env_float("SOY_AIR_LOW_MAX",  0.25))
        self.air_med  = (_env_float("SOY_AIR_MED_MIN",  0.25), _env_float("SOY_AIR_MED_MAX",  0.50))
        self.air_high = (_env_float("SOY_AIR_HIGH_MIN", 0.50), _env_float("SOY_AIR_HIGH_MAX", 1.00))

        # Repo de assessments (injetado posteriormente pelo api.py).
        self.assessments = None

    def set_assessment_repo(self, repo):
        """
        Injeta o repositório de assessments após a construção.
        - Evita dependência circular e mantém composição no 'api.py'.
        """
        self.assessments = repo

    @staticmethod
    def _parse_ts(raw_ts: str):
        """
        Normaliza timestamps ThingSpeak (ISO, com 'Z') para datetime em UTC.
        - Uniformiza fuso/offset para comparações e ordenação consistente.
        """
        ts = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
        return ts.astimezone(timezone.utc)

    def _parse(self, raw: dict, field: int) -> Optional[Tuple[datetime, float]]:
        """
        Extrai e valida um valor numérico (float) do feed bruto para um fieldX.
        - Descarta entradas vazias/None e valores não numéricos.
        - Converte o 'created_at' para UTC com _parse_ts().
        """
        v = raw.get(f"field{field}")
        if v in (None, ""):
            return None
        try:
            val = float(v)
        except:
            return None
        ts = self._parse_ts(raw["created_at"])
        return ts, val

    @staticmethod
    def _in_range(v: float, lo: float, hi: float) -> bool:
        """
        Validação física: garante que v esteja dentro do intervalo plausível do sensor.
        - Protege contra leituras corrompidas/outliers óbvios.
        """
        return v is not None and lo <= v <= hi

    def _hum_status(self, hum: float) -> str:
        """
        Classificação de umidade por limiares (OK/ATENÇÃO/ALERTA/CRÍTICO).
        - Regras configuráveis via ENV (OCP).
        """
        if hum < self.h_ok_max: return "OK"
        if hum <= self.h_adm_max: return "ATENÇÃO"
        if hum <= self.h_crit_min: return "ALERTA"
        return "CRÍTICO"

    def _temp_status(self, t: float) -> str:
        """
        Classificação de temperatura por limiares (OK/ATENÇÃO/ALERTA/CRÍTICO).
        """
        if t < self.t_ok_max: return "OK"
        if t < self.t_alert:  return "ATENÇÃO"
        if t <= self.t_crit:  return "ALERTA"
        return "CRÍTICO"

    def _aeration_advice(self, hum: Optional[float]) -> Tuple[float, float, str]:
        """
        Recomendação de aeração baseada em faixas de umidade.
        - Retorna (mín, máx, rótulo) do fluxo recomendado.
        - Se umidade for desconhecida, comunica ausência de recomendação.
        """
        if hum is None:
            return (0.0, 0.0, "Sem recomendação (umidade indisponível)")
        if hum < 13.0:
            lo, hi = self.air_low;  return (lo, hi, "Aeração leve")
        if 13.0 <= hum <= 15.0:
            lo, hi = self.air_med;  return (lo, hi, "Aeração moderada")
        lo, hi = self.air_high;     return (lo, hi, "Aeração intensiva")

    async def _sync_one(self, sensor_type: str, field: int, lo: float, hi: float, spike: float) -> dict:
        """
        Pipeline de um tipo de sensor:
        1) coleta feeds do ThingSpeak; 2) parse + valida faixa física;
        3) ordena por ts; 4) aplica anti-salto; 5) persiste via upsert;
        6) retorna resumo (recebidos/armazenados/descartados e último valor).
        """
        feeds = await self.ts.fetch_field(field, self.results)
        if not feeds:
            # Retorno estruturado mesmo sem dados (contrato consistente para o chamador).
            return {"type": sensor_type, "received": 0, "stored": 0, "dropped": 0, "last": None}

        # Parse de todos os feeds e filtro por faixa física (higienização).
        parsed = [self._parse(f, field) for f in feeds]
        parsed = [(ts, val) for ts, val in parsed if ts and self._in_range(val, lo, hi)]
        parsed.sort(key=lambda x: x[0])  # ordenação temporal ascendente

        cleaned: List[Reading] = []
        dropped = 0
        prev_val = None
        last_val = None
        last_ts  = None

        # Garante existência do sensor e obtém seu id (idempotente).
        sensor = await self.sensors.get_or_create(self.silo_id, sensor_type)

        # Anti-salto: descarta variações abruptas entre leituras consecutivas.
        for ts, val in parsed:
            if prev_val is not None and abs(val - prev_val) > spike:
                dropped += 1
                continue
            prev_val = val
            last_val = val
            last_ts  = ts
            cleaned.append(Reading(sensor_id=sensor.id, ts=ts, value=val))

        # Persistência idempotente (upsert_many): evita duplicidade por {sensor, ts}.
        stored = await self.readings.upsert_many(cleaned)
        return {
            "type": sensor_type,
            "received": len(feeds),
            "stored": stored,
            "dropped": dropped,
            "last": {"ts": last_ts, "value": last_val} if last_ts else None
        }

    async def sync_all(self) -> dict:
        """
        Orquestra a sincronização de todos os tipos suportados:
        - Temperatura e umidade (DHT11) sempre;
        - Pressão opcional (se configurada).
        - Gera 'assessment' consolidado com status e recomendações.
        """
        # Faixas físicas do DHT11 (conhecidas na literatura).
        t = await self._sync_one("temperature", self.f_temp, lo=-40.0, hi=85.0,  spike=self.spike_temp)
        h = await self._sync_one("humidity",    self.f_hum,  lo=0.0,   hi=100.0, spike=self.spike_hum)

        # Pressão opcional (ex.: barômetro) — só processa se campo existir no ENV.
        p = None
        if self.f_press:
            try:
                f = int(self.f_press)
                p = await self._sync_one("pressure", f, lo=800.0, hi=1100.0, spike=8.0)
            except Exception as e:
                # Fallback seguro: desativa pressão sem interromper a pipeline.
                print(f"[PRESSURE] desativado: {e}")
                p = {"type":"pressure","received":0,"stored":0,"dropped":0,"last":None}

        # ===== Assessment =====
        # Coleta último valor de cada tipo para consolidar visão atual do silo.
        temp = t["last"]["value"] if t["last"] else None
        hum  = h["last"]["value"] if h["last"] else None
        pres = p["last"]["value"] if (p and p["last"]) else None
        # Timestamp de referência: último ts disponível (ou now UTC se não houver dados).
        ts   = (t["last"]["ts"] or h["last"]["ts"]) if (t["last"] or h["last"]) else datetime.now(timezone.utc)

        # Status por limiares (classificação textual) — temperatura/umidade.
        status_temp = self._temp_status(temp) if temp is not None else "N/A"
        status_hum  = self._hum_status(hum)   if hum  is not None else "N/A"
        status_pres = "N/A" if pres is None else "OK"  # placeholder até existir regra de pressão

        # Recomendação operacional de aeração.
        air_lo, air_hi, air_label = self._aeration_advice(hum)

        # Documento consolidado (idempotente por (silo, ts) no repo de assessments).
        assessment_doc = {
            "silo": ObjectId(self.silo_id),
            "ts": ts,
            "temp": temp,
            "hum": hum,
            "pressure": pres,
            "status": {
                "temperature": status_temp,
                "humidity": status_hum,
                "pressure": status_pres,
                "co2": "N/A"
            },
            "aeration": {
                "recommendedFlow_m3_min_ton": [air_lo, air_hi],
                "label": air_label
            },
            "notes": []
        }

        # Regras explicativas (anotações operacionais) conforme desvios.
        if hum is not None:
            if hum >= self.h_crit_min: assessment_doc["notes"].append("Umidade crítica: iniciar aeração intensiva e/ou secagem.")
            elif hum > self.h_adm_max: assessment_doc["notes"].append("Umidade acima do ideal: aeração moderada a intensiva.")
        if temp is not None:
            if temp > self.t_vhigh:  assessment_doc["notes"].append("Temperatura muito alta (>40°C): risco severo de fungos.")
            elif temp > self.t_crit: assessment_doc["notes"].append("Temperatura alta (>30°C): risco de fungos/insetos.")

        # Persistência do assessment (upsert por (silo, ts)); tolera falha sem quebrar o fluxo.
        if self.assessments:
            try:
                await self.assessments.insert(assessment_doc)
            except Exception as e:
                print(f"[ASSESS] Falha ao salvar assessment: {e}")

        # Retorna visão completa para consumo por API/UI (telemetria e diagnóstico).
        return {
            "temperature": t,
            "humidity": h,
            "pressure": p if p else {"type":"pressure","received":0,"stored":0,"dropped":0,"last":None},
            "assessment": assessment_doc
        }
