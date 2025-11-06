const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const { listAlerts, getActiveAlerts } = require("../services/alertService");
const Alert = require("../models/Alert");

/**
 * GET /api/alerts
 * Histórico persistido com filtros e paginação.
 * Resposta: { success, items, page, limit, total, totalPages }
 */
router.get("/", auth, async (req, res) => {
  try {
    const {
      level = "all",
      siloId = "all",
      start,
      end,
      page = 1,
      limit = 10,
    } = req.query;

    const result = await listAlerts(req.user._id, {
      level,
      siloId,
      start,
      end,
      page,
      limit,
    });

    return res.send({ success: true, ...result });
  } catch (e) {
    console.error("[alerts:get]", e);
    return res.status(500).send({ success: false, error: e.message });
  }
});

/**
 * GET /api/alerts/active
 * Alertas ATIVOS (calculados a partir do último reading de cada sensor).
 * Compatível com o dashboard (cards + badge).
 * Resposta: { success, alerts: [...] }
 */
router.get("/active", auth, async (req, res) => {
  try {
    const alerts = await getActiveAlerts(req.user._id);
    return res.send({ success: true, alerts });
  } catch (e) {
    console.error("[alerts:active]", e);
    return res.status(500).send({ success: false, error: e.message });
  }
});

/**
 * PUT /api/alerts/:id/acknowledge
 * Marca um alerta do histórico como lido.
 */
router.put("/:id/acknowledge", auth, async (req, res) => {
  try {
    const updated = await Alert.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { acknowledged: true } },
      { new: true }
    ).lean();

    if (!updated) {
      return res
        .status(404)
        .send({ success: false, error: "Alerta não encontrado" });
    }
    return res.send({ success: true, alert: updated });
  } catch (e) {
    console.error("[alerts:ack]", e);
    return res.status(500).send({ success: false, error: e.message });
  }
});

module.exports = router;
