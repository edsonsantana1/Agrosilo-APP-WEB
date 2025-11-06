const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const { generateSiloReport } = require("../services/reportService");
const Silo = require("../models/silo");

/**
 * Rotas para geração de relatórios
 * 
 * Endpoints disponíveis:
 * - POST /api/reports/silo/:siloId - Gerar relatório de um silo específico
 * - GET /api/reports/silo/:siloId/quick - Relatório rápido (últimas 24h)
 */

// Gerar relatório personalizado de um silo
router.post("/silo/:siloId", auth, async (req, res) => {
    try {
        // Verificar se o silo pertence ao usuário
        const silo = await Silo.findOne({ 
            _id: req.params.siloId, 
            user: req.user._id 
        });
        
        if (!silo) {
            return res.status(404).send({ 
                success: false,
                error: "Silo não encontrado ou acesso negado" 
            });
        }

        // Extrair parâmetros do corpo da requisição
        const { startDate, endDate, includeRawData = false } = req.body;
        
        // Validar datas
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 dias atrás
        const end = endDate ? new Date(endDate) : new Date(); // agora
        
        if (start >= end) {
            return res.status(400).send({
                success: false,
                error: "Data de início deve ser anterior à data de fim"
            });
        }

        // Gerar relatório
        const report = await generateSiloReport(req.params.siloId, start, end);
        
        // Remover dados brutos se não solicitados (para reduzir tamanho da resposta)
        if (!includeRawData) {
            report.sensors.forEach(sensor => {
                delete sensor.rawData;
            });
        }

        res.send({
            success: true,
            report: report
        });

    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        res.status(500).send({ 
            success: false,
            error: error.message 
        });
    }
});

// Relatório rápido (últimas 24 horas)
router.get("/silo/:siloId/quick", auth, async (req, res) => {
    try {
        // Verificar se o silo pertence ao usuário
        const silo = await Silo.findOne({ 
            _id: req.params.siloId, 
            user: req.user._id 
        });
        
        if (!silo) {
            return res.status(404).send({ 
                success: false,
                error: "Silo não encontrado ou acesso negado" 
            });
        }

        // Últimas 24 horas
        const end = new Date();
        const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

        // Gerar relatório
        const report = await generateSiloReport(req.params.siloId, start, end);
        
        // Remover dados brutos para resposta mais leve
        report.sensors.forEach(sensor => {
            delete sensor.rawData;
        });

        res.send({
            success: true,
            report: report,
            period: "24h"
        });

    } catch (error) {
        console.error('Erro ao gerar relatório rápido:', error);
        res.status(500).send({ 
            success: false,
            error: error.message 
        });
    }
});

// Relatório semanal
router.get("/silo/:siloId/weekly", auth, async (req, res) => {
    try {
        const silo = await Silo.findOne({ 
            _id: req.params.siloId, 
            user: req.user._id 
        });
        
        if (!silo) {
            return res.status(404).send({ 
                success: false,
                error: "Silo não encontrado ou acesso negado" 
            });
        }

        // Últimos 7 dias
        const end = new Date();
        const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

        const report = await generateSiloReport(req.params.siloId, start, end);
        
        report.sensors.forEach(sensor => {
            delete sensor.rawData;
        });

        res.send({
            success: true,
            report: report,
            period: "7d"
        });

    } catch (error) {
        console.error('Erro ao gerar relatório semanal:', error);
        res.status(500).send({ 
            success: false,
            error: error.message 
        });
    }
});

// Relatório mensal
router.get("/silo/:siloId/monthly", auth, async (req, res) => {
    try {
        const silo = await Silo.findOne({ 
            _id: req.params.siloId, 
            user: req.user._id 
        });
        
        if (!silo) {
            return res.status(404).send({ 
                success: false,
                error: "Silo não encontrado ou acesso negado" 
            });
        }

        // Últimos 30 dias
        const end = new Date();
        const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

        const report = await generateSiloReport(req.params.siloId, start, end);
        
        report.sensors.forEach(sensor => {
            delete sensor.rawData;
        });

        res.send({
            success: true,
            report: report,
            period: "30d"
        });

    } catch (error) {
        console.error('Erro ao gerar relatório mensal:', error);
        res.status(500).send({ 
            success: false,
            error: error.message 
        });
    }
});

module.exports = router;

