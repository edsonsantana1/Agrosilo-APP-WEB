const Sensor = require("../models/sensor");
const Silo = require("../models/silo");
const { SAFETY_PARAMETERS } = require("./alertService");

/**
 * Serviço de Relatórios do Agrosilo
 * 
 * Este serviço é responsável por:
 * - Gerar relatórios detalhados dos dados dos sensores
 * - Análise estatística dos dados
 * - Detecção de anomalias
 * - Análise de correlação entre variáveis
 * - Geração de insights automáticos usando IA
 */

/**
 * Gera um relatório completo para um silo específico
 * @param {string} siloId - ID do silo
 * @param {Date} startDate - Data de início do período
 * @param {Date} endDate - Data de fim do período
 * @returns {Promise<object>} - Relatório completo
 */
async function generateSiloReport(siloId, startDate, endDate) {
    try {
        const silo = await Silo.findById(siloId).populate('sensors');
        
        if (!silo) {
            throw new Error('Silo não encontrado');
        }

        const report = {
            silo: {
                id: silo._id,
                name: silo.name,
                location: silo.location
            },
            period: {
                start: startDate,
                end: endDate,
                duration: Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) // dias
            },
            sensors: [],
            summary: {},
            anomalies: [],
            correlations: [],
            insights: [],
            generatedAt: new Date()
        };

        // Processar dados de cada sensor
        for (const sensor of silo.sensors) {
            const sensorData = await processSensorData(sensor, startDate, endDate);
            report.sensors.push(sensorData);
        }

        // Gerar análises
        report.summary = generateSummary(report.sensors);
        report.anomalies = detectAnomalies(report.sensors);
        report.correlations = analyzeCorrelations(report.sensors);
        report.insights = await generateInsights(report);

        return report;

    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        throw error;
    }
}

/**
 * Processa os dados de um sensor específico para o período
 * @param {object} sensor - Objeto do sensor
 * @param {Date} startDate - Data de início
 * @param {Date} endDate - Data de fim
 * @returns {object} - Dados processados do sensor
 */
async function processSensorData(sensor, startDate, endDate) {
    const filteredData = sensor.data.filter(reading => 
        reading.timestamp >= startDate && reading.timestamp <= endDate
    );

    if (filteredData.length === 0) {
        return {
            id: sensor._id,
            type: sensor.type,
            dataPoints: 0,
            statistics: null,
            trends: null,
            alerts: []
        };
    }

    const values = filteredData.map(reading => reading.value);
    const timestamps = filteredData.map(reading => reading.timestamp);

    // Calcular estatísticas
    const statistics = calculateStatistics(values);
    
    // Analisar tendências
    const trends = analyzeTrends(values, timestamps);
    
    // Verificar alertas no período
    const alerts = checkAlertsInPeriod(sensor.type, filteredData);

    return {
        id: sensor._id,
        type: sensor.type,
        dataPoints: filteredData.length,
        statistics: statistics,
        trends: trends,
        alerts: alerts,
        rawData: filteredData
    };
}

/**
 * Calcula estatísticas básicas para um conjunto de valores
 * @param {Array<number>} values - Array de valores
 * @returns {object} - Estatísticas calculadas
 */
function calculateStatistics(values) {
    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((acc, val) => acc + val, 0);
    const mean = sum / values.length;
    
    // Variância e desvio padrão
    const variance = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / values.length;
    const standardDeviation = Math.sqrt(variance);
    
    // Mediana
    const median = sorted.length % 2 === 0 
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];

    return {
        count: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        mean: parseFloat(mean.toFixed(2)),
        median: parseFloat(median.toFixed(2)),
        standardDeviation: parseFloat(standardDeviation.toFixed(2)),
        variance: parseFloat(variance.toFixed(2)),
        range: Math.max(...values) - Math.min(...values)
    };
}

/**
 * Analisa tendências nos dados
 * @param {Array<number>} values - Array de valores
 * @param {Array<Date>} timestamps - Array de timestamps
 * @returns {object} - Análise de tendências
 */
function analyzeTrends(values, timestamps) {
    if (values.length < 2) return null;

    // Calcular tendência linear simples
    const n = values.length;
    const timeNumbers = timestamps.map(t => t.getTime());
    
    const sumX = timeNumbers.reduce((acc, val) => acc + val, 0);
    const sumY = values.reduce((acc, val) => acc + val, 0);
    const sumXY = timeNumbers.reduce((acc, x, i) => acc + x * values[i], 0);
    const sumXX = timeNumbers.reduce((acc, x) => acc + x * x, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Determinar direção da tendência
    let direction = 'stable';
    if (Math.abs(slope) > 0.001) {
        direction = slope > 0 ? 'increasing' : 'decreasing';
    }

    return {
        direction: direction,
        slope: parseFloat(slope.toFixed(6)),
        intercept: parseFloat(intercept.toFixed(2)),
        correlation: calculateCorrelation(timeNumbers, values)
    };
}

/**
 * Calcula correlação entre duas variáveis
 * @param {Array<number>} x - Primeira variável
 * @param {Array<number>} y - Segunda variável
 * @returns {number} - Coeficiente de correlação
 */
function calculateCorrelation(x, y) {
    if (x.length !== y.length || x.length === 0) return 0;

    const n = x.length;
    const sumX = x.reduce((acc, val) => acc + val, 0);
    const sumY = y.reduce((acc, val) => acc + val, 0);
    const sumXY = x.reduce((acc, val, i) => acc + val * y[i], 0);
    const sumXX = x.reduce((acc, val) => acc + val * val, 0);
    const sumYY = y.reduce((acc, val) => acc + val * val, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));

    return denominator === 0 ? 0 : parseFloat((numerator / denominator).toFixed(3));
}

/**
 * Verifica alertas que ocorreram no período
 * @param {string} sensorType - Tipo do sensor
 * @param {Array} data - Dados do sensor
 * @returns {Array} - Lista de alertas
 */
function checkAlertsInPeriod(sensorType, data) {
    const alerts = [];
    
    data.forEach(reading => {
        let alert = null;
        
        switch (sensorType) {
            case 'humidity':
                if (reading.value > SAFETY_PARAMETERS.humidity.fungus_risk) {
                    alert = { level: 'critical', reason: 'Risco explosivo de fungos' };
                } else if (reading.value > SAFETY_PARAMETERS.humidity.acceptable) {
                    alert = { level: 'warning', reason: 'Acima do nível aceitável' };
                }
                break;
            case 'temperature':
                if (reading.value >= SAFETY_PARAMETERS.temperature.high_risk_min && 
                    reading.value <= SAFETY_PARAMETERS.temperature.high_risk_max) {
                    alert = { level: 'critical', reason: 'Crescimento máximo de fungos' };
                } else if (reading.value >= SAFETY_PARAMETERS.temperature.medium_growth_min && 
                          reading.value <= SAFETY_PARAMETERS.temperature.medium_growth_max) {
                    alert = { level: 'warning', reason: 'Crescimento médio de fungos' };
                }
                break;
        }
        
        if (alert) {
            alerts.push({
                timestamp: reading.timestamp,
                value: reading.value,
                level: alert.level,
                reason: alert.reason
            });
        }
    });
    
    return alerts;
}

/**
 * Gera resumo executivo do relatório
 * @param {Array} sensorsData - Dados de todos os sensores
 * @returns {object} - Resumo executivo
 */
function generateSummary(sensorsData) {
    const summary = {
        totalSensors: sensorsData.length,
        totalDataPoints: sensorsData.reduce((acc, sensor) => acc + sensor.dataPoints, 0),
        sensorsWithAlerts: sensorsData.filter(sensor => sensor.alerts.length > 0).length,
        totalAlerts: sensorsData.reduce((acc, sensor) => acc + sensor.alerts.length, 0),
        averageReadingsPerSensor: 0,
        sensorsSummary: {}
    };

    if (summary.totalSensors > 0) {
        summary.averageReadingsPerSensor = Math.round(summary.totalDataPoints / summary.totalSensors);
    }

    // Resumo por tipo de sensor
    sensorsData.forEach(sensor => {
        if (sensor.statistics) {
            summary.sensorsSummary[sensor.type] = {
                count: (summary.sensorsSummary[sensor.type]?.count || 0) + 1,
                avgMean: sensor.statistics.mean,
                avgMin: sensor.statistics.min,
                avgMax: sensor.statistics.max,
                alerts: sensor.alerts.length
            };
        }
    });

    return summary;
}

/**
 * Detecta anomalias nos dados
 * @param {Array} sensorsData - Dados de todos os sensores
 * @returns {Array} - Lista de anomalias detectadas
 */
function detectAnomalies(sensorsData) {
    const anomalies = [];

    sensorsData.forEach(sensor => {
        if (!sensor.statistics || sensor.dataPoints < 10) return;

        const { mean, standardDeviation } = sensor.statistics;
        const threshold = 2 * standardDeviation; // 2 desvios padrão

        sensor.rawData.forEach(reading => {
            const deviation = Math.abs(reading.value - mean);
            if (deviation > threshold) {
                anomalies.push({
                    sensorId: sensor.id,
                    sensorType: sensor.type,
                    timestamp: reading.timestamp,
                    value: reading.value,
                    expectedRange: {
                        min: parseFloat((mean - threshold).toFixed(2)),
                        max: parseFloat((mean + threshold).toFixed(2))
                    },
                    deviation: parseFloat(deviation.toFixed(2)),
                    severity: deviation > 3 * standardDeviation ? 'high' : 'medium'
                });
            }
        });
    });

    return anomalies.sort((a, b) => b.deviation - a.deviation);
}

/**
 * Analisa correlações entre diferentes tipos de sensores
 * @param {Array} sensorsData - Dados de todos os sensores
 * @returns {Array} - Lista de correlações encontradas
 */
function analyzeCorrelations(sensorsData) {
    const correlations = [];
    
    // Comparar cada par de sensores
    for (let i = 0; i < sensorsData.length; i++) {
        for (let j = i + 1; j < sensorsData.length; j++) {
            const sensor1 = sensorsData[i];
            const sensor2 = sensorsData[j];
            
            if (sensor1.dataPoints === 0 || sensor2.dataPoints === 0) continue;
            
            // Sincronizar dados por timestamp (aproximado)
            const syncedData = synchronizeData(sensor1.rawData, sensor2.rawData);
            
            if (syncedData.length > 5) {
                const values1 = syncedData.map(d => d.value1);
                const values2 = syncedData.map(d => d.value2);
                const correlation = calculateCorrelation(values1, values2);
                
                if (Math.abs(correlation) > 0.3) { // Correlação significativa
                    correlations.push({
                        sensor1: { id: sensor1.id, type: sensor1.type },
                        sensor2: { id: sensor2.id, type: sensor2.type },
                        correlation: correlation,
                        strength: getCorrelationStrength(correlation),
                        dataPoints: syncedData.length
                    });
                }
            }
        }
    }
    
    return correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
}

/**
 * Sincroniza dados de dois sensores por timestamp
 * @param {Array} data1 - Dados do primeiro sensor
 * @param {Array} data2 - Dados do segundo sensor
 * @returns {Array} - Dados sincronizados
 */
function synchronizeData(data1, data2) {
    const synced = [];
    const tolerance = 5 * 60 * 1000; // 5 minutos de tolerância
    
    data1.forEach(reading1 => {
        const matchingReading = data2.find(reading2 => 
            Math.abs(reading1.timestamp.getTime() - reading2.timestamp.getTime()) <= tolerance
        );
        
        if (matchingReading) {
            synced.push({
                timestamp: reading1.timestamp,
                value1: reading1.value,
                value2: matchingReading.value
            });
        }
    });
    
    return synced;
}

/**
 * Determina a força da correlação
 * @param {number} correlation - Coeficiente de correlação
 * @returns {string} - Força da correlação
 */
function getCorrelationStrength(correlation) {
    const abs = Math.abs(correlation);
    if (abs >= 0.8) return 'muito forte';
    if (abs >= 0.6) return 'forte';
    if (abs >= 0.4) return 'moderada';
    if (abs >= 0.2) return 'fraca';
    return 'muito fraca';
}

/**
 * Gera insights automáticos usando IA (simulado)
 * @param {object} report - Relatório completo
 * @returns {Promise<Array>} - Lista de insights
 */
async function generateInsights(report) {
    const insights = [];
    
    // Insight sobre alertas
    if (report.summary.totalAlerts > 0) {
        insights.push({
            type: 'alert_analysis',
            title: 'Análise de Alertas',
            description: `Foram detectados ${report.summary.totalAlerts} alertas no período analisado. ${report.summary.sensorsWithAlerts} sensores apresentaram condições fora dos parâmetros seguros.`,
            priority: 'high',
            recommendation: 'Revisar as condições de armazenamento e considerar ajustes na ventilação ou controle de umidade.'
        });
    }
    
    // Insight sobre correlações
    const strongCorrelations = report.correlations.filter(c => Math.abs(c.correlation) > 0.6);
    if (strongCorrelations.length > 0) {
        insights.push({
            type: 'correlation_analysis',
            title: 'Correlações Identificadas',
            description: `Foram identificadas ${strongCorrelations.length} correlações fortes entre sensores, indicando possíveis relações causais entre as variáveis monitoradas.`,
            priority: 'medium',
            recommendation: 'Utilizar essas correlações para otimizar o controle ambiental do silo.'
        });
    }
    
    // Insight sobre anomalias
    const highSeverityAnomalies = report.anomalies.filter(a => a.severity === 'high');
    if (highSeverityAnomalies.length > 0) {
        insights.push({
            type: 'anomaly_detection',
            title: 'Anomalias Detectadas',
            description: `Foram detectadas ${highSeverityAnomalies.length} anomalias de alta severidade que requerem atenção imediata.`,
            priority: 'high',
            recommendation: 'Investigar as causas das anomalias e implementar medidas corretivas.'
        });
    }
    
    // Insight sobre tendências
    const sensorsWithTrends = report.sensors.filter(s => s.trends && s.trends.direction !== 'stable');
    if (sensorsWithTrends.length > 0) {
        insights.push({
            type: 'trend_analysis',
            title: 'Análise de Tendências',
            description: `${sensorsWithTrends.length} sensores apresentam tendências significativas nos dados, indicando mudanças graduais nas condições do silo.`,
            priority: 'medium',
            recommendation: 'Monitorar as tendências identificadas para antecipar possíveis problemas.'
        });
    }
    
    return insights;
}

module.exports = {
    generateSiloReport,
    processSensorData,
    calculateStatistics,
    analyzeTrends,
    detectAnomalies,
    analyzeCorrelations,
    generateInsights
};

