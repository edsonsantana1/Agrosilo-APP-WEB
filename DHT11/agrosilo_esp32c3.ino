// ===================================================================================
// Projeto: Monitor de Clima para Armazenagem de Soja com ESP32-C3, DHT11 e ThingSpeak
// Autor:  Edson Santana Alves
// Versão: 2.6  (Otimizado para visualização no ThingSpeak + campos corretos)
// Descrição:
//   - Monitora temperatura e umidade para armazenagem de soja baseado em parâmetros Embrapa
//   - Classifica leituras em: IDEAL, MODERADO e CRÍTICO conforme normas técnicas
//   - Envia dados para 4 campos no ThingSpeak para melhor visualização
// ===================================================================================

// ---- Bibliotecas ----
#include <WiFi.h>
#include <DHT.h>
#include <ThingSpeak.h>
#include "chaves.h"   // <<< Coloque seu CHANNEL_ID e WRITE API KEY (thingspeakApiKey) aqui

// ---- Serial / Debug ----
#define SERIAL_BAUD_RATE       115200   // Velocidade do Serial Monitor

// ---- Configurações da sua Rede Wi-Fi ----
const char* ssid     = "LIVE TIM_R4E6_2G";  // SSID da sua rede Wi-Fi
const char* password = "34jm34UWT4";        // Senha da rede Wi-Fi

// ---- Sensor DHT ----
#define DHT_PIN                4        // GPIO onde o DHT11 está ligado
#define DHT_TYPE               DHT11    // Tipo de sensor DHT

// ===================================================================================
// PARÂMETROS TÉCNICOS PARA ARMAZENAGEM DE SOJA (Base: Embrapa Soja)
// ===================================================================================

// CLASSIFICAÇÃO DE TEMPERATURA PARA ARMAZENAGEM DE SOJA
#define TEMP_IDEAL_MAX         15.0     // °C - Desenvolvimento fúngico lento
#define TEMP_MODERADO_MIN      20.0     // °C - Início desenvolvimento fúngico médio
#define TEMP_MODERADO_MAX      30.0     // °C - Fim desenvolvimento fúngico médio
#define TEMP_CRITICO_MIN       40.0     // °C - Desenvolvimento fúngico máximo

// CLASSIFICAÇÃO DE UMIDADE PARA ARMAZENAGEM DE SOJA
#define HUMI_IDEAL_MAX         13.0     // % - Armazenamento seguro (≤13%)
#define HUMI_MODERADO_MIN      13.0     // % - Início crescimento fúngico rápido
#define HUMI_MODERADO_MAX      16.0     // % - Fim crescimento fúngico rápido
#define HUMI_CRITICO_MIN       16.0     // % - Crescimento fúngico "explosivo"

// Parâmetros de amostragem
#define NUM_LEITURAS           6        // Reduzido para melhor resposta
#define DELAY_ENTRE_LEITURAS   2000     // ms entre amostras

// ---- ThingSpeak ----
// DEFININDO OS CAMPOS PARA CORRESPONDER ÀS SUAS IMAGENS:
#define THINGSPEAK_FIELD_TEMP          1   // Field 1 → Temperatura Atual (°C)
#define THINGSPEAK_FIELD_HUMI          2   // Field 2 → Umidade Atual (%)
#define THINGSPEAK_FIELD_STATUS        3   // Field 3 → Status (1=Normal, 2=Alerta, 3=Crítico)
#define THINGSPEAK_FIELD_HUMI_MIN      4   // Field 4 → Umidade Mínima Segura (13%)
#define HTTP_STATUS_OK         200

// ---- Controle de envio ----
const long SEND_INTERVAL = 30000;       // Intervalo entre envios: 30s
unsigned long lastSendTime = 0;

// ---- Objetos globais ----
DHT dht(DHT_PIN, DHT_TYPE);
WiFiClient client;

// ===================================================================================
// Variáveis para classificação
// ===================================================================================
typedef enum {
    STATUS_IDEAL = 1,
    STATUS_MODERADO = 2,
    STATUS_CRITICO = 3,
    STATUS_ERRO_SENSOR = 4
} StatusArmazenamento;

// ===================================================================================
// Funções auxiliares
// ===================================================================================

void connectWiFi() {
    Serial.print("[WIFI] Conectando-se a ");
    Serial.println(ssid);

    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, password);

    int retries = 0;
    while (WiFi.status() != WL_CONNECTED && retries < 40) {
        delay(500);
        Serial.print(".");
        retries++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\n[WIFI] Conectado com sucesso!");
        Serial.print("[WIFI] IP: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("\n[ERRO] Falha ao conectar ao Wi-Fi. Reiniciando...");
        delay(5000);
        ESP.restart();
    }
}

StatusArmazenamento classificarCondicoes(float temperatura, float umidade) {
    // Condições CRÍTICAS (prioridade máxima)
    if (temperatura >= TEMP_CRITICO_MIN) {
        Serial.println("[STATUS] CRÍTICO - Temperatura ≥40°C: desenvolvimento fúngico máximo");
        return STATUS_CRITICO;
    }
    
    if (umidade > HUMI_CRITICO_MIN) {
        Serial.println("[STATUS] CRÍTICO - Umidade >16%: crescimento fúngico explosivo");
        return STATUS_CRITICO;
    }
    
    // Condições MODERADAS (vigilância aumentada)
    if ((temperatura >= TEMP_MODERADO_MIN && temperatura <= TEMP_MODERADO_MAX) ||
        (umidade >= HUMI_MODERADO_MIN && umidade <= HUMI_MODERADO_MAX)) {
        Serial.println("[STATUS] MODERADO - Condições exigem atenção");
        return STATUS_MODERADO;
    }
    
    // Condições IDEAIS
    Serial.println("[STATUS] IDEAL - Condições seguras para armazenamento");
    return STATUS_IDEAL;
}

bool lerSensor(float* temperatura, float* umidade) {
    float tempSum = 0, humiSum = 0;
    int tempCount = 0, humiCount = 0;

    Serial.println("[SENSOR] Coletando leituras...");

    for (int i = 0; i < NUM_LEITURAS; i++) {
        float t = dht.readTemperature();
        float h = dht.readHumidity();

        if (!isnan(t) && t >= -10 && t <= 60) {
            tempSum += t;
            tempCount++;
        }

        if (!isnan(h) && h >= 0 && h <= 100) {
            humiSum += h;
            humiCount++;
        }

        delay(DELAY_ENTRE_LEITURAS);
    }

    *temperatura = (tempCount > 0) ? (tempSum / tempCount) : NAN;
    *umidade = (humiCount > 0) ? (humiSum / humiCount) : NAN;

    // Log de diagnóstico
    Serial.print("[SENSOR] Leituras válidas - Temp: ");
    Serial.print(tempCount);
    Serial.print("/");
    Serial.print(NUM_LEITURAS);
    Serial.print(", Humi: ");
    Serial.print(humiCount);
    Serial.print("/");
    Serial.println(NUM_LEITURAS);

    return (!isnan(*temperatura) && !isnan(*umidade));
}

void printThingSpeakStatus(int statusCode) {
    if (statusCode == HTTP_STATUS_OK) {
        Serial.println("[THINGSPEAK] OK - Dados enviados com sucesso");
    } else {
        Serial.print("[THINGSPEAK] Erro (code=");
        Serial.print(statusCode);
        Serial.println(")");
        
        // Diagnóstico adicional para erros comuns
        if (statusCode == 401) {
            Serial.println("  >>> ERRO: API Key inválida!");
        } else if (statusCode == 404) {
            Serial.println("  >>> ERRO: Channel ID não encontrado!");
        } else if (statusCode < 0) {
            Serial.println("  >>> ERRO: Falha de conexão com a internet!");
        }
    }
}

// ===================================================================================
// setup()
// ===================================================================================
void setup() {
    Serial.begin(SERIAL_BAUD_RATE);
    delay(1000);
    Serial.println("\n=== MONITOR DE ARMAZENAGEM DE SOJA ===");
    Serial.println("[SISTEMA] Baseado nas especificações Embrapa Soja");
    
    connectWiFi();
    dht.begin();
    ThingSpeak.begin(client);
    
    Serial.println("[SISTEMA] Inicialização concluída");
    Serial.println("[CAMPOS] Field1: Temperatura, Field2: Umidade, Field3: Status, Field4: Ref-Umidade");
}

// ===================================================================================
// loop()
// ===================================================================================
void loop() {
    if (millis() - lastSendTime < SEND_INTERVAL) {
        return;
    }

    Serial.println("\n--- NOVO CICLO DE LEITURA ---");

    // Verifica Wi-Fi
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[WIFI] Reconectando...");
        connectWiFi();
    }

    // Leitura do sensor
    float temperatura, umidade;
    if (!lerSensor(&temperatura, &umidade)) {
        Serial.println("[ERRO] Falha na leitura do sensor");
        ThingSpeak.setField(THINGSPEAK_FIELD_STATUS, STATUS_ERRO_SENSOR);
        ThingSpeak.writeFields(THINGSPEAK_CHANNEL_ID, thingspeakApiKey);
        lastSendTime = millis();
        return;
    }

    // Classificação e log
    StatusArmazenamento status = classificarCondicoes(temperatura, umidade);
    
    Serial.print("[DADOS] Temp: ");
    Serial.print(temperatura, 1);
    Serial.print("°C, Umidade: ");
    Serial.print(umidade, 1);
    Serial.print("%, Status: ");
    Serial.println(status);

    // Prepara dados para ThingSpeak - CORREÇÃO DO ERRO AQUI
    ThingSpeak.setField(THINGSPEAK_FIELD_TEMP, temperatura);        // Field 1: Temperatura atual
    ThingSpeak.setField(THINGSPEAK_FIELD_HUMI, umidade);            // Field 2: Umidade atual
    ThingSpeak.setField(THINGSPEAK_FIELD_STATUS, (int)status);      // Field 3: Status (1-2-3)
    ThingSpeak.setField(THINGSPEAK_FIELD_HUMI_MIN, 13.0f);          // Field 4: Referência 13% (CORRIGIDO: usando 'f' para float)

    // Envia para ThingSpeak
    int statusCode = ThingSpeak.writeFields(THINGSPEAK_CHANNEL_ID, thingspeakApiKey);
    printThingSpeakStatus(statusCode);

    lastSendTime = millis();
    Serial.println("[CICLO] Concluído - Aguardando próximo intervalo");
}