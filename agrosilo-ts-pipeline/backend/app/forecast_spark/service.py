# app/forecast_spark/service.py
"""
Camada de serviço da previsão (Linear Regression) para Agrosilo.

Agora funciona tanto para:
- temperature  (°C)
- humidity     (%)

Pontos principais:
- Busca sensores do silo na coleção "sensors"
- Lê histórico completo na coleção time-series "readings"
- Treina regressão linear (scikit-learn)
- Gera 24 pontos à frente
- Calcula métricas (RMSE, R², inclinação)
- Gera correlação temperatura x umidade (se ambos existirem)
- Estrutura de saída compatível com o front atual
"""

import os
import math
from typing import Dict, Any, List

import numpy as np
import pandas as pd
from bson import ObjectId
from pymongo import MongoClient

from sklearn.linear_model import LinearRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_squared_error, r2_score


# -------------------------------------------------------------------
# Configurações MongoDB
# -------------------------------------------------------------------
MONGO_URI = os.getenv(
    "MONGODB_URI",
    "mongodb+srv://agrosilo2025_db_user:3ZRT8O3JXNndEWIP@agrosilo.4ec2ahk.mongodb.net/"
    "?retryWrites=true&w=majority"
)
MONGO_DB = os.getenv("MONGODB_DB", "test")

SENSORS_COLLECTION = "sensors"
READINGS_COLLECTION = "readings"  # coleção time-series com histórico completo

# IDs/valores padrão (caso o endpoint não informe)
DEFAULT_SILO_ID = "68c31c63ac369b0d1d2b27da"
DEFAULT_SENSOR_TYPE = "temperature"  # padrão continua sendo temperatura


# -------------------------------------------------------------------
# Helper: descobrir sensores (temperature / humidity) de um silo
# -------------------------------------------------------------------
def get_silo_sensor_ids(silo_id_str: str) -> Dict[str, ObjectId]:
    """
    Retorna um dicionário com os IDs dos sensores de 'temperature' e 'humidity'
    para um silo específico.

    Exemplo de retorno:
      {
        "temperature": ObjectId("..."),
        "humidity": ObjectId("...")
      }
    """
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB]
    sensors_col = db[SENSORS_COLLECTION]

    silo_id = ObjectId(silo_id_str)

    # Busca apenas sensores temperature/humidity do silo
    cursor = sensors_col.find(
        {"silo": silo_id, "type": {"$in": ["temperature", "humidity"]}},
        {"type": 1},
    )

    result: Dict[str, ObjectId] = {}
    for doc in cursor:
        sensor_type = doc.get("type")
        if sensor_type in ("temperature", "humidity"):
            result[sensor_type] = doc["_id"]

    return result


# -------------------------------------------------------------------
# 1) Série temporal genérica (temperatura, umidade, etc.) usando READINGS
# -------------------------------------------------------------------
def load_series_from_readings(silo_id_str: str, sensor_type: str) -> pd.DataFrame:
    """
    Lê do MongoDB a série temporal de um tipo de sensor específico
    (temperature, humidity, ...) para um silo, a partir da coleção READINGS.

    Retorna DataFrame com colunas:
      - Date  (datetime)
      - Close (float)  → valor numérico da série
    """
    sensor_ids = get_silo_sensor_ids(silo_id_str)
    target_sensor_id = sensor_ids.get(sensor_type)

    if not target_sensor_id:
        # Não há sensor do tipo solicitado cadastrado para esse silo
        return pd.DataFrame(columns=["Date", "Close"])

    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB]
    readings_col = db[READINGS_COLLECTION]

    # Lê TODAS as leituras daquele sensor
    rows = list(
        readings_col.find(
            {"sensor": target_sensor_id},
            {"_id": 0, "ts": 1, "value": 1},
        ).sort("ts", 1)
    )

    if not rows:
        return pd.DataFrame(columns=["Date", "Close"])

    df = pd.DataFrame(rows)
    df["Date"] = pd.to_datetime(df["ts"])
    df["Close"] = pd.to_numeric(df["value"], errors="coerce")
    df = df.dropna(subset=["Close"])

    return df[["Date", "Close"]]


# Mantemos o nome antigo por compatibilidade com outros imports
def load_temperature_series(
    silo_id_str: str,
    sensor_type: str = DEFAULT_SENSOR_TYPE
) -> pd.DataFrame:
    """
    Mantido por compatibilidade: por padrão carrega 'temperature', mas
    pode receber outro sensor_type, como 'humidity'.
    """
    return load_series_from_readings(silo_id_str, sensor_type=sensor_type)


# -------------------------------------------------------------------
# 2) Treina regressão linear usando scikit-learn
# -------------------------------------------------------------------
def train_sklearn_linear_model(df: pd.DataFrame):
    """
    Recebe df com colunas [Date, Close] e treina um modelo LinearRegression
    usando um índice crescente como feature (idx = 0..n-1).

    Retorna:
      model      → modelo treinado
      df         → DataFrame completo (já ordenado)
      pred_df    → DataFrame com Date, Close (real) e prediction (teste)
      rmse       → erro quadrático médio raiz
      r2         → R²
    """
    if df.empty:
        raise ValueError("Nenhum dado encontrado para este silo.")

    # Ordena por data e cria índice sequencial
    df = df.sort_values("Date").reset_index(drop=True)
    df["idx"] = df.index.astype(float)

    X = df[["idx"]].values  # shape (n, 1)
    y = df["Close"].values  # shape (n,)

    # Split treino/teste com shuffle (se houver amostras suficientes)
    if len(df) > 5:
        (
            X_train, X_test,
            y_train, y_test,
            idx_train, idx_test,
            date_train, date_test
        ) = train_test_split(
            X,
            y,
            df["idx"].values,
            df["Date"].values,
            test_size=0.3,
            random_state=42,
            shuffle=True,
        )
    else:
        # Poucos pontos: usa tudo como treino e teste
        X_train = X_test = X
        y_train = y_test = y
        idx_train = idx_test = df["idx"].values
        date_train = date_test = df["Date"].values

    model = LinearRegression()
    model.fit(X_train, y_train)

    # Predição no conjunto de teste
    y_pred = model.predict(X_test)

    # RMSE = sqrt(MSE)
    mse = mean_squared_error(y_test, y_pred)
    rmse = float(math.sqrt(mse))

    # R² só faz sentido se houver variância em y_test
    r2 = float(r2_score(y_test, y_pred)) if len(np.unique(y_test)) > 1 else 0.0

    pred_df = pd.DataFrame(
        {
            "Date": date_test,
            "Close": y_test,
            "prediction": y_pred,
        }
    ).sort_values("Date")

    return model, df, pred_df, rmse, r2


# -------------------------------------------------------------------
# 3) Gera previsão futura
# -------------------------------------------------------------------
def forecast_future(
    model: LinearRegression,
    df_original: pd.DataFrame,
    num_steps: int = 24,
) -> List[Dict[str, Any]]:
    """
    Usa o modelo treinado + índice máximo para projetar 'num_steps'
    pontos à frente.

    Para estimar o timestamp futuro, usa o delta mediano entre leituras
    reais (ex.: se as leituras são a cada 5 minutos, mantém essa cadência).
    """
    df_sorted = df_original.sort_values("Date").reset_index(drop=True)
    df_sorted["idx"] = df_sorted.index.astype(float)

    last_idx = float(df_sorted["idx"].iloc[-1])

    if len(df_sorted) >= 2:
        median_delta = df_sorted["Date"].diff().median()
    else:
        # fallback: 1 hora, se só houver 1 ponto
        median_delta = pd.Timedelta(hours=1)

    last_date = df_sorted["Date"].max()

    future_points = []
    for step in range(1, num_steps + 1):
        new_idx = last_idx + step
        X_future = np.array([[new_idx]], dtype=float)
        y_pred = float(model.predict(X_future)[0])

        future_date = last_date + step * median_delta

        future_points.append(
            {
                "step": step,
                "idx": int(new_idx),
                "date_iso": future_date.isoformat(),
                "date_label": future_date.strftime("%d/%m %H:%M"),
                "prediction": round(y_pred, 2),
            }
        )

    return future_points


# -------------------------------------------------------------------
# 4) Insight extra: correlação temperatura x umidade (usando READINGS)
# -------------------------------------------------------------------
def load_temp_humi_joined(silo_id_str: str) -> pd.DataFrame:
    """
    Carrega temperatura + umidade do mesmo silo a partir da coleção READINGS
    e devolve um DataFrame com colunas:
      - Date
      - temperature
      - humidity
    """
    sensor_ids = get_silo_sensor_ids(silo_id_str)
    temp_sensor_id = sensor_ids.get("temperature")
    humi_sensor_id = sensor_ids.get("humidity")

    if not temp_sensor_id or not humi_sensor_id:
        return pd.DataFrame(columns=["Date", "temperature", "humidity"])

    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB]
    readings_col = db[READINGS_COLLECTION]

    # Busca leituras dos dois sensores
    rows = list(
        readings_col.find(
            {"sensor": {"$in": [temp_sensor_id, humi_sensor_id]}},
            {"_id": 0, "ts": 1, "value": 1, "sensor": 1},
        ).sort("ts", 1)
    )

    if not rows:
        return pd.DataFrame(columns=["Date", "temperature", "humidity"])

    df_raw = pd.DataFrame(rows)
    df_raw["Date"] = pd.to_datetime(df_raw["ts"])

    # Mapeia ObjectId -> tipo ("temperature"/"humidity")
    id_to_type = {}
    for sensor_type, s_id in sensor_ids.items():
        id_to_type[str(s_id)] = sensor_type

    df_raw["sensor_type"] = df_raw["sensor"].astype(str).map(id_to_type)

    # Pivot → linhas: Date, colunas: sensor_type, valores: value
    df = (
        df_raw.pivot_table(
            index="Date",
            columns="sensor_type",
            values="value",
        )
        .reset_index()
    )

    # Garante colunas
    for col_name in ["temperature", "humidity"]:
        if col_name not in df.columns:
            df[col_name] = pd.NA

    df["Date"] = pd.to_datetime(df["Date"])
    df["temperature"] = pd.to_numeric(df["temperature"], errors="coerce")
    df["humidity"] = pd.to_numeric(df["humidity"], errors="coerce")

    return df[["Date", "temperature", "humidity"]]


# -------------------------------------------------------------------
# 5) Função principal chamada pelo endpoint
# -------------------------------------------------------------------
def run_full_forecast(
    silo_id_str: str = DEFAULT_SILO_ID,
    sensor_type: str = DEFAULT_SENSOR_TYPE,
) -> Dict[str, Any]:
    """
    Função principal (chamada pelo endpoint):

    - Carrega a série do tipo solicitado (temperature/humidity/...)
    - Treina modelo LinearRegression
    - Gera 24 previsões futuras
    - Calcula métricas e tendência
    - (Opcional) Calcula correlação temperatura x umidade

    Retorna um dicionário pronto para virar JSON.
    """
    # padroniza para minúsculas
    sensor_type = (sensor_type or DEFAULT_SENSOR_TYPE).lower()

    # 1) Carrega série do tipo solicitado
    df_series = load_temperature_series(silo_id_str, sensor_type=sensor_type)
    if df_series.empty:
        return {
            "ok": False,
            "message": f"Nenhum dado de {sensor_type} encontrado para este silo.",
        }

    # 2) Treina modelo e gera previsões internas (teste)
    model, df_full, pred_df, rmse, r2 = train_sklearn_linear_model(df_series)

    # 3) Previsão futura (próximos 24 pontos)
    future_points = forecast_future(model, df_full, num_steps=24)

    # 4) Histórico completo (para gráfico histórico+futuro)
    history_labels = df_full["Date"].dt.strftime("%d/%m %H:%M").tolist()
    history_values = df_full["Close"].round(2).tolist()

    # 5) Real x previsto (conjunto de teste)
    pred_pdf_sorted = pred_df.sort_values("Date")
    test_labels = pred_pdf_sorted["Date"].dt.strftime("%d/%m %H:%M").tolist()
    test_real = pred_pdf_sorted["Close"].round(2).tolist()
    test_pred = pred_pdf_sorted["prediction"].round(2).tolist()

    # 6) Insights básicos
    last_val = float(df_full["Close"].iloc[-1])
    min_val = float(df_full["Close"].min())
    max_val = float(df_full["Close"].max())
    mean_val = float(df_full["Close"].mean())

    # 7) Tendência (texto depende do tipo de sensor)
    slope = float(model.coef_[0]) if model.coef_.size > 0 else 0.0
    if slope > 0:
        if sensor_type == "temperature":
            trend = "tendência de AQUECIMENTO (valores crescentes ao longo do tempo)"
        elif sensor_type == "humidity":
            trend = "tendência de AUMENTO DE UMIDADE (valores crescentes ao longo do tempo)"
        else:
            trend = "tendência de CRESCIMENTO (valores crescentes ao longo do tempo)"
    elif slope < 0:
        if sensor_type == "temperature":
            trend = "tendência de RESFRIAMENTO (valores decrescentes ao longo do tempo)"
        elif sensor_type == "humidity":
            trend = "tendência de REDUÇÃO DE UMIDADE (valores decrescentes ao longo do tempo)"
        else:
            trend = "tendência de QUEDA (valores decrescentes ao longo do tempo)"
    else:
        trend = "série aproximadamente ESTÁVEL (sem tendência forte)."

    # 8) Correlação temperatura x umidade (se existirem os dois sensores)
    df_joined = load_temp_humi_joined(silo_id_str)
    if (not df_joined.empty
            and "temperature" in df_joined
            and "humidity" in df_joined):
        corr = (
            df_joined[["temperature", "humidity"]]
            .corr()
            .iloc[0, 1]
        )
        corr_value = float(corr) if pd.notnull(corr) else None
    else:
        corr_value = None

    # 9) Monta bloco de insights
    insights: Dict[str, Any] = {
        "sensor_type": sensor_type,
        "last_value": round(last_val, 2),
        "min_value": round(min_val, 2),
        "max_value": round(max_val, 2),
        "mean_value": round(mean_val, 2),
        "trend": trend,
        "temp_humi_correlation": corr_value,
    }

    # Chaves específicas para manter compatibilidade com o front
    if sensor_type == "temperature":
        insights.update(
            last_temperature=round(last_val, 2),
            min_temperature=round(min_val, 2),
            max_temperature=round(max_val, 2),
            mean_temperature=round(mean_val, 2),
        )
    elif sensor_type == "humidity":
        insights.update(
            last_humidity=round(last_val, 2),
            min_humidity=round(min_val, 2),
            max_humidity=round(max_val, 2),
            mean_humidity=round(mean_val, 2),
        )

    # 10) Retorno final
    return {
        "ok": True,
        "silo_id": silo_id_str,
        "sensor_type": sensor_type,
        "model_type": f"sklearn_linear_regression_idx_{sensor_type}",
        "metrics": {
            "rmse": rmse,
            "r2": r2,
            "slope": slope,
        },
        "history": {
            "labels": history_labels,
            "values": history_values,
        },
        "test_predictions": {
            "labels": test_labels,
            "real": test_real,
            "predicted": test_pred,
        },
        "future_forecast": future_points,
        "insights": insights,
    }
