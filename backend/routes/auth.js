// backend/routes/auth.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/user');

// ========= Config =========
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';
const JWT_ALG = 'HS256';

// Habilita fluxo MFA por padrão (defina REQUIRE_MFA=false no .env para desabilitar)
const REQUIRE_MFA = (process.env.REQUIRE_MFA || 'true').toLowerCase() !== 'false';

// ========= Helpers =========
function issueToken(payload, opts = {}) {
  return jwt.sign(payload, JWT_SECRET, { algorithm: JWT_ALG, expiresIn: '24h', ...opts });
}

function issueTempMfaToken(payload) {
  return jwt.sign({ ...payload, mfa_stage: 'provision' }, JWT_SECRET, {
    algorithm: JWT_ALG,
    expiresIn: '10m'
  });
}

function toSafeUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    phoneNumber: user.phoneNumber || null
  };
}

// ========= Register =========
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, phoneNumber } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    }

    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(409).json({ error: 'E-mail já cadastrado.' });

    const user = await User.create({
      name,
      email: email.toLowerCase().trim(),
      password, // hash no pre('save') do schema
      role: role || 'user',
      phoneNumber: phoneNumber || null,
      mfa: { enabled: false }
    });

    return res.status(201).json({ ok: true, id: user._id });
  } catch (err) {
    console.error('[auth/register] error:', err);
    return res.status(500).json({ error: 'Erro ao registrar usuário.' });
  }
});

// ========= Login (com MFA) =========
router.post('/login', async (req, res) => {
  try {
    const { email, password, role } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Informe e-mail e senha.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });

    if (role && user.role && role !== user.role) {
      return res.status(403).json({ error: 'Perfil não autorizado para este usuário.' });
    }

    if (REQUIRE_MFA) {
      const mfa = user.mfa || {};
      if (mfa.enabled && mfa.secret) {
        // 2FA já habilitado → segunda etapa (TOTP)
        return res.json({ mfa: 'verify', email: user.email });
      }
      // ainda não habilitou → provisionar (gera token temporário)
      const tempToken = issueTempMfaToken({
        sub: String(user._id),
        userId: String(user._id),
        email: user.email,
        role: user.role || 'user'
      });
      return res.json({ mfa: 'provision', tempToken });
    }

    // Sem MFA (REQUIRE_MFA=false)
    const token = issueToken({
      sub: String(user._id),
      userId: String(user._id),
      email: user.email,
      role: user.role || 'user'
    });
    return res.json({ token, user: toSafeUser(user) });
  } catch (err) {
    console.error('[auth/login] error:', err);
    return res.status(500).json({ error: 'Erro ao processar login.' });
  }
});

module.exports = router;
