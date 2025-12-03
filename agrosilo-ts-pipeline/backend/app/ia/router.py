from __future__ import annotations

"""
Router da assistente de voz IARA
(Inteligência de Análise de Risco Agrícola).

Endpoint principal:
    POST /ia/query  -> recebe um texto e responde com análise do silo.

A IARA usa principalmente:
- grain_assessments: valores consolidados (temp, umidade, pressão, CO2, status);
- alerts: alertas recentes do silo.

Ela também pode usar Groq (LLM) para:
- interpretar a intenção do comando (NLP mais inteligente);
- reescrever o relatório técnico agronômico.
"""

from typing import Any, Dict, List, Optional, Tuple
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import os
import json
import re

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

# Groq (LLM)
from groq import Groq


# ==================== DTOs (request/response) ====================


class IAQueryRequest(BaseModel):
    """
    Requisição enviada pelo front:
    { "text": "Iara, qual a temperatura do silo Teste Silo?" }
    """
    text: str = Field(..., min_length=3)


class IAQueryResponse(BaseModel):
    """
    Resposta da IARA:
    - reply: texto pronto para ser falado;
    - data: dados estruturados (métricas, alertas, relatório, etc).
    """
    reply: str
    data: Dict[str, Any] = {}


# ==================== helpers / dependências ====================

router = APIRouter(prefix="/ia", tags=["ia"])


def get_db(request: Request) -> AsyncIOMotorDatabase:
    """
    Recupera a instância de banco injetada no app FastAPI (state.db).
    """
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=500, detail="Database não inicializado")
    return db


def _as_oid(v: str) -> Optional[ObjectId]:
    """
    Tenta converter uma string em ObjectId.
    Retorna None se falhar.
    """
    try:
        return ObjectId(v)
    except Exception:
        return None


# ==================== Serviço principal da IARA ====================


class AgrosiloAssistantService:
    """
    Serviço da IARA.

    Responsabilidades:
    - identificar o silo mencionado na frase;
    - detectar quais grandezas foram pedidas (temp, umidade, etc.);
    - consultar grain_assessments + alerts;
    - montar resposta em linguagem natural;
    - opcionalmente, usar Groq para:
        * interpretar intenção do comando (NLP mais inteligente);
        * reescrever relatório técnico agronômico.
    """

    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db
        self.col_silos = db["silos"]
        self.col_assess = db["grain_assessments"]
        self.col_alerts = db["alerts"]
        self.col_readings = db["readings"]  # reservado para uso futuro

        # Cliente Groq (LLM) – interpretador + gerador de relatório
        api_key = os.getenv("GROQ_API_KEY")
        if api_key:
            self.groq_client = Groq(api_key=api_key)
            print("[IARA/GROQ] Cliente Groq inicializado.")
        else:
            self.groq_client = None
            print(
                "[IARA/GROQ] GROQ_API_KEY não configurada. "
                "IARA funciona apenas com regras fixas."
            )

    # ---------- utilidades de tempo / serialização ----------

    def _to_recife(self, dt: datetime) -> datetime:
        """
        Converte um datetime (assumindo UTC se naive) para o fuso America/Recife.
        """
        try:
            tz_recife = ZoneInfo("America/Recife")
        except Exception:
            # fallback: se der erro com timezone, devolve o original
            return dt

        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(tz_recife)

    def _normalize_for_response(self, obj: Any) -> Any:
        """
        Converte ObjectId, datetime, etc., para tipos serializáveis em JSON.
        Isso é usado antes de mandar o "data" para o frontend.
        """
        if isinstance(obj, ObjectId):
            return str(obj)
        if isinstance(obj, datetime):
            return obj.isoformat()
        if isinstance(obj, list):
            return [self._normalize_for_response(x) for x in obj]
        if isinstance(obj, dict):
            return {k: self._normalize_for_response(v) for k, v in obj.items()}
        return obj

    # ---------- parser robusto de JSON vindo do LLM ----------

    def _parse_llm_json(self, raw: str) -> Dict[str, Any]:
        """
        Tenta extrair JSON válido de uma resposta do LLM, mesmo que venha
        dentro de ``` ``` ou com texto extra antes/depois.

        Estratégia:
        - Usa regex para pegar o PRIMEIRO bloco { ... } da string.
        - Faz json.loads nesse bloco.
        """
        s = (raw or "").strip()

        # Regex pega tudo entre o primeiro '{' e o último '}' (modo DOTALL).
        m = re.search(r"\{[\s\S]*\}", s)
        if not m:
            raise ValueError("Não encontrei um bloco JSON na resposta do LLM.")

        json_str = m.group(0)
        return json.loads(json_str)

    # ---------- “NLP” simples por palavras-chave (fallback) ----------

    async def _infer_silo(
        self,
        text: str,
        silo_hint: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Tenta descobrir qual silo foi citado.

        Estratégia:
        1. Usa um "hint" de nome de silo vindo do LLM (se existir);
        2. Carrega todos os silos e verifica se nome/alias/local aparecem na frase;
        3. Se não encontrar, procura padrão "silo X";
        4. Se existir apenas 1 silo na base, assume esse.
        """
        t_base = text
        if silo_hint:
            # concatenamos o hint para facilitar o match (ex.: “TESTE SILO”)
            t_base = f"{text} {silo_hint}"

        t = t_base.lower()
        candidates: List[tuple[int, Dict[str, Any]]] = []

        async for silo in self.col_silos.find({}):
            name = str(
                silo.get("name")
                or silo.get("siloName")
                or silo.get("label")
                or ""
            ).strip()
            alias = str(silo.get("alias") or "").strip()
            location = str(
                silo.get("location")
                or silo.get("local")
                or ""
            ).strip()

            name_l = name.lower()
            alias_l = alias.lower()
            loc_l = location.lower()

            score = 0
            if name_l and name_l in t:
                score += 3
            if alias_l and alias_l in t:
                score += 2
            if loc_l and loc_l in t:
                score += 1

            if score > 0:
                candidates.append((score, silo))

        if candidates:
            # pega o candidato com maior “score”
            candidates.sort(key=lambda x: x[0], reverse=True)
            return candidates[0][1]

        # Fallback: padrão "silo X"
        m = re.search(r"silo\s+([a-z0-9çãõáéíóúâêôü\s_-]+)", t)
        token = m.group(1).strip() if m else None

        if token:
            q = {
                "$or": [
                    {"name": {"$regex": token, "$options": "i"}},
                    {"siloName": {"$regex": token, "$options": "i"}},
                    {"label": {"$regex": token, "$options": "i"}},
                    {"location": {"$regex": token, "$options": "i"}},
                    {"local": {"$regex": token, "$options": "i"}},
                ]
            }
            doc = await self.col_silos.find_one(q)
            if doc:
                return doc

        # Se só existir um silo na base, assume ele
        count = await self.col_silos.count_documents({})
        if count == 1:
            return await self.col_silos.find_one({})

        return None

    def _detect_metrics(self, text: str) -> Dict[str, bool]:
        """
        Detecta, via palavras-chave simples, quais métricas foram pedidas.
        (fallback quando LLM não está disponível ou falhar)
        """
        t = text.lower()
        metrics = {
            "temperature": any(k in t for k in ["temperatura", "calor", "quente", "frio"]),
            "humidity": any(k in t for k in ["umidade", "úmido", "umido"]),
            "co2": "co2" in t or "gás carbônico" in t or "gas carbonico" in t,
            "pressure": any(k in t for k in ["pressão", "pressao"]),
            "alerts": any(k in t for k in ["alerta", "alertas", "risco", "status"]),
        }

        # Heurística extra: se o usuário falar "status geral", assume visão completa
        if "status geral" in t or "status do silo" in t:
            metrics["temperature"] = True
            metrics["humidity"] = True
            metrics["alerts"] = True

        return metrics

    def _is_report_request(self, text: str) -> bool:
        """
        Identifica pedidos de relatório técnico.
        """
        t = text.lower()
        keys = [
            "relatório",
            "relatorio",
            "relatório técnico",
            "relatorio tecnico",
            "gere um relatório",
            "gerar um relatório",
            "gerar relatório",
        ]
        return any(k in t for k in keys)

    # ----------------- acesso às coleções -----------------

    async def _get_latest_assessment(self, silo_id: str) -> Optional[Dict[str, Any]]:
        """
        Recupera a avaliação de grão mais recente para o silo.
        """
        oid = _as_oid(silo_id)
        q = {"silo": oid} if oid else {"silo": silo_id}
        return await self.col_assess.find_one(q, sort=[("ts", -1)])

    async def _get_recent_alerts(
        self,
        silo_id: str,
        window_hours: int = 1,
    ) -> List[Dict[str, Any]]:
        """
        Busca últimos alertas (até 5) para o silo, na janela de N horas.
        """
        now = datetime.utcnow()
        start = now - timedelta(hours=window_hours)
        oid = _as_oid(silo_id)

        or_terms: List[Dict[str, Any]] = []
        for field in ["siloId", "silo_id", "silo"]:
            if oid:
                or_terms.append({field: oid})
            or_terms.append({field: silo_id})

        q = {"$and": [{"$or": or_terms}, {"timestamp": {"$gte": start}}]}

        cur = self.col_alerts.find(q).sort("timestamp", -1).limit(5)
        result: List[Dict[str, Any]] = []
        async for doc in cur:
            result.append(doc)
        return result

    # ----------------- recomendações -----------------

    def _build_recommendations(
        self,
        assess: Dict[str, Any],
        alerts_last_hour: List[Dict[str, Any]],
    ) -> str:
        """
        Gera recomendações agronômicas simples, combinando:
        - notas de aeração (assessment.aeration.notes);
        - status de temperatura/umidade;
        - presença de alertas recentes.
        """
        notes: List[str] = []

        aeration = assess.get("aeration") or {}
        aer_notes = aeration.get("notes") or []
        if isinstance(aer_notes, list):
            for n in aer_notes:
                if isinstance(n, str):
                    notes.append(n)

        status_block: Dict[str, Any] = assess.get("status") or {}
        temp_status = status_block.get("temperature")
        hum_status = status_block.get("humidity")

        if temp_status in ("ALERTA", "CRÍTICO"):
            notes.append(
                "Temperatura em nível de risco: avaliar resfriamento do silo e "
                "intensificar a ventilação para evitar deterioração dos grãos."
            )
        if hum_status in ("ALERTA", "CRÍTICO"):
            notes.append(
                "Umidade elevada: priorizar aeração intensiva e, se necessário, "
                "secagem dos grãos para reduzir risco de fungos e perdas de qualidade."
            )

        if alerts_last_hour:
            notes.append(
                "Foram registrados alertas na última hora: revisar o histórico de "
                "leituras e registrar as ações corretivas no sistema."
            )

        # Remove duplicadas mantendo ordem
        seen = set()
        final_notes: List[str] = []
        for n in notes:
            if n not in seen:
                seen.add(n)
                final_notes.append(n)

        if not final_notes:
            return (
                "Recomendações: sem ações críticas no momento. "
                "Manter o monitoramento rotineiro, inspeções visuais periódicas "
                "e registro das leituras."
            )

        return "Recomendações: " + " ".join(final_notes)

    # ----------------- interpretação de comando via Groq -----------------

    async def _interpret_command_llm(
        self,
        text: str,
    ) -> Tuple[Dict[str, bool], Optional[str], bool]:
        """
        Usa Groq (LLaMA 3.3) para interpretar o comando do usuário.

        Retorna:
            metrics: dict com flags (temperature, humidity, pressure, co2, alerts)
            silo_hint: possível nome do silo extraído pelo LLM (ou None)
            wants_report: se o usuário pediu relatório técnico

        Se o Groq não estiver configurado ou falhar, cai no fallback
        com heurísticas simples.
        """
        # Começa com o fallback simples
        base_metrics = self._detect_metrics(text)
        base_wants_report = self._is_report_request(text)
        silo_hint: Optional[str] = None

        if not self.groq_client:
            print("[IARA/GROQ] Sem cliente configurado. Usando heurísticas simples.")
            return base_metrics, silo_hint, base_wants_report

        try:
            print("[IARA/GROQ] Interpretando comando do usuário (intenção)...")

            system_prompt = (
                "Você é a Iara, uma engenheira agrônoma digital especializada em armazenagem "
                "de grãos em silos. Seu papel é interpretar comandos em português e devolver "
                "um JSON com a intenção de consulta.\n\n"
                "Você SEMPRE deve responder APENAS um JSON válido, sem texto extra."
            )

            user_prompt = (
                "Analise o comando a seguir e retorne APENAS um JSON com o formato:\n\n"
                "{\n"
                '  "wants_report": bool,\n'
                '  "metrics": {\n'
                '    "temperature": bool,\n'
                '    "humidity": bool,\n'
                '    "pressure": bool,\n'
                '    "co2": bool,\n'
                '    "alerts": bool\n'
                "  },\n"
                '  "silo_name": string | null\n'
                "}\n\n"
                "- \"wants_report\" deve ser true se o usuário pediu relatório ou laudo técnico.\n"
                "- \"metrics\" indica que tipo de dado ele quer ouvir (temperatura, umidade, etc.).\n"
                "- Se ele pedir \"status geral\" do silo, ative pelo menos temperature, humidity e alerts.\n"
                "- \"silo_name\" deve conter o nome do silo citado no texto, se houver (por exemplo: \"TESTE SILO\").\n\n"
                f"Comando do usuário:\n\"{text}\""
            )

            completion = self.groq_client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            )

            raw = (completion.choices[0].message.content or "").strip()
            print("[IARA/GROQ] Resposta bruta de interpretação:", raw)

            # Usa o parser robusto, que aguenta ```json ... ```
            parsed = self._parse_llm_json(raw)

            metrics = parsed.get("metrics") or {}
            wants_report = bool(parsed.get("wants_report", base_wants_report))
            silo_name_val = parsed.get("silo_name")

            # Garante todas as chaves de métricas, mesclando com fallback
            merged_metrics: Dict[str, bool] = {
                "temperature": bool(metrics.get("temperature", base_metrics["temperature"])),
                "humidity": bool(metrics.get("humidity", base_metrics["humidity"])),
                "pressure": bool(metrics.get("pressure", base_metrics["pressure"])),
                "co2": bool(metrics.get("co2", base_metrics["co2"])),
                "alerts": bool(metrics.get("alerts", base_metrics["alerts"])),
            }

            if isinstance(silo_name_val, str) and silo_name_val.strip():
                silo_hint = silo_name_val.strip()

            print(
                "[IARA/GROQ] Interpretação final:",
                merged_metrics,
                silo_hint,
                wants_report,
            )
            return merged_metrics, silo_hint, wants_report

        except Exception as e:
            # Se der qualquer erro (JSON quebrado, etc.), loga e volta para o fallback
            print("[IARA/GROQ] Erro ao interpretar comando:", repr(e))
            return base_metrics, None, base_wants_report

    # ----------------- chamada ao Groq (LLM) para relatório -----------------

    async def _maybe_generate_llm_report(
        self,
        base_report: str,
    ) -> Optional[str]:
        """
        Usa Groq (LLaMA 3.3 70B) para reescrever o relatório
        no formato técnico agronômico.
        Se não houver cliente ou der erro, retorna None.
        """
        if not self.groq_client:
            print("[IARA/GROQ] Cliente Groq indisponível. Usando relatório base.")
            return None

        try:
            print("[IARA/GROQ] Gerando relatório técnico com LLaMA 3.3...")
            prompt_system = (
                "Você é uma engenheira agrônoma chamada Iara, especialista em armazenagem "
                "e conservação de grãos em silos. Você escreve relatórios técnicos em "
                "português do Brasil, com linguagem clara, objetiva e profissional."
            )

            prompt_user = (
                "A seguir está um rascunho de relatório de monitoramento de um silo, "
                "já contendo todos os dados numéricos consolidados.\n\n"
                "Rascunho:\n\n"
                f"{base_report}\n\n"
                "Reescreva esse conteúdo no formato de relatório técnico agronômico, "
                "organizado em parágrafos, mantendo todos os valores numéricos e níveis de risco. "
                "Use tom profissional, cite temperatura, umidade, situação de alertas e "
                "recomendações operacionais. Não use bullet points; escreva como texto corrido."
            )

            completion = self.groq_client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[
                    {"role": "system", "content": prompt_system},
                    {"role": "user", "content": prompt_user},
                ],
            )

            llm_text = completion.choices[0].message.content
            print("[IARA/GROQ] Relatório gerado com sucesso.")
            return llm_text

        except Exception as e:
            print("[IARA/GROQ] Erro ao chamar Groq:", repr(e))
            return None

    # ----------------- fluxo principal -----------------

    async def handle_query(self, text: str) -> IAQueryResponse:
        """
        Fluxo principal:
        - Usa Groq para interpretar o comando (quando disponível);
        - Faz fallback para heurísticas simples se precisar;
        - Consulta MongoDB;
        - Gera resposta em linguagem natural;
        - (Opcional) gera relatório técnico com Groq.
        """
        # 1) Interpretação do comando (LLM + fallback)
        metrics, silo_hint, wants_report = await self._interpret_command_llm(text)

        # 2) Descobre o silo (usando hint do LLM, se existir)
        silo_doc = await self._infer_silo(text, silo_hint=silo_hint)
        if not silo_doc:
            return IAQueryResponse(
                reply=(
                    "Oi, eu sou a IARA. Não consegui identificar qual silo você citou. "
                    "Tente dizer, por exemplo: 'Iara, qual a temperatura e umidade do silo TESTE SILO?'."
                ),
                data={},
            )

        silo_id = str(silo_doc["_id"])
        silo_name = silo_doc.get("name") or silo_doc.get("siloName") or "silo"

        # 3) Busca assessment consolidado
        assess = await self._get_latest_assessment(silo_id)
        if not assess:
            return IAQueryResponse(
                reply=(
                    f"Oi, eu sou a IARA. Ainda não encontrei avaliações consolidadas "
                    f"para o {silo_name}."
                ),
                data={"silo_id": silo_id, "silo_name": silo_name},
            )

        # --- Data/hora em Pernambuco (America/Recife) ---
        ts: datetime = assess.get("ts")  # type: ignore[assignment]
        ts_recife: Optional[datetime] = None
        if isinstance(ts, datetime):
            ts_recife = self._to_recife(ts)
            ts_str = ts_recife.strftime("%d/%m/%Y %H:%M")
        else:
            ts_str = "data desconhecida"

        temp = assess.get("temp")
        hum = assess.get("hum")
        pressure = assess.get("pressure")
        co2 = assess.get("co2")
        status_block: Dict[str, Any] = assess.get("status") or {}

        parts: List[str] = [
            f"Analisando o {silo_name}, última avaliação em {ts_str}."
        ]

        # Temperatura
        if metrics.get("temperature") and temp is not None:
            st = status_block.get("temperature")
            trecho = f"Temperatura em torno de {float(temp):.1f} °C"
            if st:
                trecho += f" (nível: {st})."
            else:
                trecho += "."
            parts.append(trecho)

        # Umidade
        if metrics.get("humidity") and hum is not None:
            st = status_block.get("humidity")
            trecho = f"Umidade em torno de {float(hum):.1f} %"
            if st:
                trecho += f" (nível: {st})."
            else:
                trecho += "."
            parts.append(trecho)

        # Pressão
        if metrics.get("pressure"):
            if pressure is not None:
                parts.append(f"Pressão atmosférica registrada em {pressure} hPa.")
            else:
                parts.append("Não há registro de pressão atmosférica para este silo.")

        # CO2
        if metrics.get("co2"):
            if co2 is not None:
                parts.append(f"Concentração de CO₂ em {co2} ppm.")
            else:
                parts.append("Não há registro de CO₂ para este silo.")

        # Alertas da ÚLTIMA HORA
        alerts_last_hour: List[Dict[str, Any]] = []
        if metrics.get("alerts") or not any(metrics.values()):
            alerts_last_hour = await self._get_recent_alerts(silo_id, window_hours=1)
            if alerts_last_hour:
                parts.append("Encontrei alguns alertas recentes na última hora:")
                for a in alerts_last_hour[:3]:
                    level = a.get("level") or ""
                    msg = a.get("message") or ""
                    parts.append(f"- [{level}] {msg}")
            else:
                parts.append(
                    "Não há alertas recentes na última hora para este silo."
                )

        # Recomendações finais
        rec_text = self._build_recommendations(assess, alerts_last_hour)
        parts.append(rec_text)

        # Frase “normal” que a IARA fala (reply de voz/texto)
        reply = " ".join(parts)

        # --------- Relatório técnico base (regra fixa) ---------
        report_lines: List[str] = [
            f"Relatório técnico do silo {silo_name}",
            f"- Data/hora da última avaliação (America/Recife): {ts_str}.",
        ]

        if temp is not None:
            report_lines.append(
                f"- Temperatura média do silo: {float(temp):.1f} °C "
                f"(status: {status_block.get('temperature', 'N/A')})."
            )
        if hum is not None:
            report_lines.append(
                f"- Umidade relativa interna: {float(hum):.1f} % "
                f"(status: {status_block.get('humidity', 'N/A')})."
            )
        if pressure is not None:
            report_lines.append(f"- Pressão atmosférica: {pressure} hPa.")
        if co2 is not None:
            report_lines.append(f"- Concentração de CO₂: {co2} ppm.")

        if alerts_last_hour:
            report_lines.append("- Alertas registrados na última hora:")
            for a in alerts_last_hour:
                lvl = a.get("level") or "NÍVEL DESCONHECIDO"
                msg = a.get("message") or "Sem descrição."
                ts_a: Optional[datetime] = a.get("timestamp")
                if isinstance(ts_a, datetime):
                    ts_a_rec = self._to_recife(ts_a)
                    ts_a_str = ts_a_rec.strftime("%d/%m/%Y %H:%M")
                else:
                    ts_a_str = "data/hora não informada"
                report_lines.append(f"  • [{lvl}] {msg} (registrado em {ts_a_str}).")
        else:
            report_lines.append(
                "- Não foram registrados alertas na última hora para este silo."
            )

        rec_clean = rec_text.replace("Recomendações:", "").strip()
        report_lines.append(f"- Recomendações operacionais: {rec_clean}")

        base_report_text = "\n".join(report_lines)

        # --------- Tenta gerar relatório via Groq ---------
        llm_report = await self._maybe_generate_llm_report(base_report_text)
        final_report_text = llm_report or base_report_text

        # Dados estruturados para tela / export
        data: Dict[str, Any] = {
            "silo_id": silo_id,
            "silo_name": silo_name,
            "ts_utc": ts.isoformat() if isinstance(ts, datetime) else None,
            "ts_recife": ts_recife.isoformat() if ts_recife else None,
            "metrics": {
                "temperature": {
                    "value": temp,
                    "status": status_block.get("temperature"),
                },
                "humidity": {
                    "value": hum,
                    "status": status_block.get("humidity"),
                },
                "pressure": {
                    "value": pressure,
                    "status": status_block.get("pressure"),
                },
                "co2": {
                    "value": co2,
                    "status": status_block.get("co2"),
                },
            },
            "alerts_last_hour": alerts_last_hour,
            "recommendations": rec_text,
            "report_text": final_report_text,
            "examples": [
                "Iara, qual a temperatura e umidade do silo TESTE SILO?",
                "Iara, quais alertas na última hora do silo TESTE SILO?",
                "Iara, qual o status geral do silo TESTE SILO?",
                "Iara, gere um relatório técnico do silo TESTE SILO.",
            ],
        }

        safe_data = self._normalize_for_response(data)

        # Se pediu relatório, a IARA lê o relatório completo
        if wants_report:
            reply = final_report_text

        return IAQueryResponse(reply=reply, data=safe_data)


# ==================== endpoints FastAPI ====================


def get_service(db: AsyncIOMotorDatabase = Depends(get_db)) -> AgrosiloAssistantService:
    """
    Factory para injeção do serviço em cada request.
    """
    return AgrosiloAssistantService(db)


@router.post("/query", response_model=IAQueryResponse)
async def query_ia(
    payload: IAQueryRequest,
    service: AgrosiloAssistantService = Depends(get_service),
) -> IAQueryResponse:
    """
    Endpoint principal da IARA.

    Recebe um texto (payload.text) e devolve:
    - reply: texto para ser falado pela voz da Iara;
    - data: estrutura com métricas, alertas e relatório técnico.
    """
    return await service.handle_query(payload.text)
