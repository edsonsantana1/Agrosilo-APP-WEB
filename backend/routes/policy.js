// backend/routes/policy.js
const express = require('express');
const router = express.Router();
const POLICY = require('../config/policy');

// sem auth de propósito: é só leitura de limites
router.get('/', (_req, res) => {
  res.send(POLICY);
});

module.exports = router;
