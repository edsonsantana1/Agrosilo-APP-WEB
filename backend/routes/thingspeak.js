const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const Sensor = require("../models/sensor");
const Silo = require("../models/silo");
const {
    syncSensorData,
    syncAllSensors,
    configureSensorThingSpeak,
    removeSensorThingSpeakConfig,
    getChannelInfo
} = require("../services/thingSpeakService");

/**
 * Rotas para integração com ThingSpeak
 * 
 * Endpoints disponíveis:
 * - POST /api/thingspeak/sync/:sensorId - Sincronizar dados de um sensor específico
 * - POST /api/thingspeak/sync-all - Sincronizar todos os sensores
 * - POST /api/thingspeak/configure/:sensorId - Configurar sensor para ThingSpeak
 * - DELETE /api/thingspeak/configure/:sensorId - Remover configuração ThingSpeak
 * - GET /api/thingspeak/channel/:channelId - Obter informações do canal
 */

// Sincronizar dados de um sensor específico
router.post("/sync/:sensorId", auth, async (req, res) => {
    try {
        // Verificar se o sensor pertence ao usuário
        const sensor = await Sensor.findById(req.params.sensorId);
        if (!sensor) {
            return res.status(404).send({
                success: false,
                error: "Sensor não encontrado"
            });
        }

        const silo = await Silo.findOne({ 
            _id: sensor.silo, 
            user: req.user._id 
        });
        
        if (!silo) {
            return res.status(403).send({
                success: false,
                error: "Acesso negado ao sensor"
            });
        }

        // Verificar se o sensor tem configuração ThingSpeak
        if (!sensor.thingSpeakConfig || !sensor.thingSpeakConfig.channelId) {
            return res.status(400).send({
                success: false,
                error: "Sensor não configurado para ThingSpeak"
            });
        }

        // Sincronizar dados
        const result = await syncSensorData(
            sensor._id,
            sensor.thingSpeakConfig.channelId,
            sensor.thingSpeakConfig.fieldNumber,
            sensor.thingSpeakConfig.apiKey
        );

        res.send(result);

    } catch (error) {
        console.error('Erro na sincronização:', error);
        res.status(500).send({
            success: false,
            error: error.message
        });
    }
});

// Sincronizar todos os sensores do usuário
router.post("/sync-all", auth, async (req, res) => {
    try {
        // Buscar todos os silos do usuário
        const silos = await Silo.find({ user: req.user._id }).populate('sensors');
        
        const syncResults = [];
        
        for (const silo of silos) {
            for (const sensor of silo.sensors) {
                if (sensor.thingSpeakConfig && sensor.thingSpeakConfig.channelId) {
                    const result = await syncSensorData(
                        sensor._id,
                        sensor.thingSpeakConfig.channelId,
                        sensor.thingSpeakConfig.fieldNumber,
                        sensor.thingSpeakConfig.apiKey
                    );
                    
                    syncResults.push({
                        sensorId: sensor._id,
                        sensorType: sensor.type,
                        siloName: silo.name,
                        ...result
                    });
                }
            }
        }

        res.send({
            success: true,
            totalSensors: syncResults.length,
            results: syncResults
        });

    } catch (error) {
        console.error('Erro na sincronização geral:', error);
        res.status(500).send({
            success: false,
            error: error.message
        });
    }
});

// Configurar sensor para ThingSpeak
router.post("/configure/:sensorId", auth, async (req, res) => {
    try {
        // Verificar se o sensor pertence ao usuário
        const sensor = await Sensor.findById(req.params.sensorId);
        if (!sensor) {
            return res.status(404).send({
                success: false,
                error: "Sensor não encontrado"
            });
        }

        const silo = await Silo.findOne({ 
            _id: sensor.silo, 
            user: req.user._id 
        });
        
        if (!silo) {
            return res.status(403).send({
                success: false,
                error: "Acesso negado ao sensor"
            });
        }

        // Extrair configuração do corpo da requisição
        const { channelId, fieldNumber, apiKey } = req.body;
        
        if (!channelId || !fieldNumber) {
            return res.status(400).send({
                success: false,
                error: "channelId e fieldNumber são obrigatórios"
            });
        }

        // Configurar sensor
        const result = await configureSensorThingSpeak(req.params.sensorId, {
            channelId,
            fieldNumber,
            apiKey
        });

        res.send(result);

    } catch (error) {
        console.error('Erro na configuração:', error);
        res.status(500).send({
            success: false,
            error: error.message
        });
    }
});

// Remover configuração ThingSpeak do sensor
router.delete("/configure/:sensorId", auth, async (req, res) => {
    try {
        // Verificar se o sensor pertence ao usuário
        const sensor = await Sensor.findById(req.params.sensorId);
        if (!sensor) {
            return res.status(404).send({
                success: false,
                error: "Sensor não encontrado"
            });
        }

        const silo = await Silo.findOne({ 
            _id: sensor.silo, 
            user: req.user._id 
        });
        
        if (!silo) {
            return res.status(403).send({
                success: false,
                error: "Acesso negado ao sensor"
            });
        }

        // Remover configuração
        const result = await removeSensorThingSpeakConfig(req.params.sensorId);
        res.send(result);

    } catch (error) {
        console.error('Erro ao remover configuração:', error);
        res.status(500).send({
            success: false,
            error: error.message
        });
    }
});

// Obter informações de um canal ThingSpeak
router.get("/channel/:channelId", auth, async (req, res) => {
    try {
        const { apiKey } = req.query;
        
        if (!apiKey) {
            return res.status(400).send({
                success: false,
                error: "apiKey é obrigatória"
            });
        }

        const result = await getChannelInfo(req.params.channelId, apiKey);
        res.send(result);

    } catch (error) {
        console.error('Erro ao buscar informações do canal:', error);
        res.status(500).send({
            success: false,
            error: error.message
        });
    }
});

// Listar sensores configurados para ThingSpeak
router.get("/configured-sensors", auth, async (req, res) => {
    try {
        const silos = await Silo.find({ user: req.user._id }).populate('sensors');
        
        const configuredSensors = [];
        
        for (const silo of silos) {
            for (const sensor of silo.sensors) {
                if (sensor.thingSpeakConfig && sensor.thingSpeakConfig.channelId) {
                    configuredSensors.push({
                        sensorId: sensor._id,
                        sensorType: sensor.type,
                        siloId: silo._id,
                        siloName: silo.name,
                        thingSpeakConfig: {
                            channelId: sensor.thingSpeakConfig.channelId,
                            fieldNumber: sensor.thingSpeakConfig.fieldNumber,
                            lastSync: sensor.thingSpeakConfig.lastSync
                        }
                    });
                }
            }
        }

        res.send({
            success: true,
            count: configuredSensors.length,
            sensors: configuredSensors
        });

    } catch (error) {
        console.error('Erro ao listar sensores configurados:', error);
        res.status(500).send({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;

