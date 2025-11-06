// backend/routes/thresholds.js
const express = require('express');
const router = express.Router();
const Threshold = require('../models/threshold');

/**
 * GET /api/thresholds
 * Retorna os thresholds do usuário. Se não existir, cria com defaults via .create().
 */
router.get('/', async (req, res) => {
  try {
    let doc = await Threshold.findOne({ user: req.user._id }).lean();

    if (!doc) {
      // create() aplica os defaults do schema
      doc = await Threshold.create({ user: req.user._id });
      doc = doc.toObject();
      console.log('[thresholds][GET] criado com defaults para user:', String(req.user._id));
    }

    res.json({ success: true, thresholds: doc });
  } catch (err) {
    console.error('[thresholds][GET] erro:', err);
    res.status(500).json({ success: false, error: 'Erro ao carregar thresholds' });
  }
});

/**
 * PUT /api/thresholds
 * Atualiza parcial (merge) dos thresholds do usuário, criando se não existir.
 * IMPORTANTE: setDefaultsOnInsert:true aplica defaults quando o doc é criado via upsert.
 */
router.put('/', async (req, res) => {
  try {
    const patch = {};
    if (req.body.humidity)    patch.humidity    = req.body.humidity;
    if (req.body.temperature) patch.temperature = req.body.temperature;

    // sempre atualiza marca de alteração
    patch.updatedAt = new Date();

    const updated = await Threshold.findOneAndUpdate(
      { user: req.user._id },
      { $set: patch },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true // <- garante defaults quando criar via upsert
      }
    ).lean();

    res.json({ success: true, thresholds: updated });
  } catch (err) {
    console.error('[thresholds][PUT] erro:', err);
    res.status(500).json({ success: false, error: 'Erro ao atualizar thresholds' });
  }
});

/**
 * POST /api/thresholds/seed
 * Força criação com defaults (útil para “fazer aparecer” o primeiro documento).
 * Idempotente: se já existir, só retorna o existente.
 */
router.post('/seed', async (req, res) => {
  try {
    let doc = await Threshold.findOne({ user: req.user._id });
    if (!doc) {
      doc = await Threshold.create({ user: req.user._id });
      console.log('[thresholds][SEED] criado com defaults para user:', String(req.user._id));
    }
    res.json({ success: true, thresholds: doc });
  } catch (err) {
    console.error('[thresholds][SEED] erro:', err);
    res.status(500).json({ success: false, error: 'Erro ao semear thresholds' });
  }
});

module.exports = router;
