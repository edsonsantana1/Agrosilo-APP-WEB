// routes/auth.js
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const User = require("../models/user");

/**
 * Gera um JWT a partir do payload { userId, role }
 */
function signToken(user) {
  const payload = { userId: user.id, role: user.role };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1h" });
}

/**
 * Normaliza o retorno do usuário para não expor campos sensíveis
 */
function toSafeUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    phoneNumber: user.phoneNumber,
  };
}

/**
 * POST /api/auth/register
 * Cria um usuário e já retorna token + dados do usuário
 */
router.post("/register", async (req, res) => {
  try {
    const { name, email, password, role, phoneNumber } = req.body;

    // validações simples
    if (!name || !email || !password) {
      return res.status(400).json({ message: "Nome, email e senha são obrigatórios." });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: "Usuário já existe" });
    }

    // Não faça hash aqui: o model fará no pre('save')
    const user = new User({
      name,
      email,
      password,                 // senha pura; o model fará hash
      role: role || "user",     // padrão: user
      phoneNumber,
    });

    await user.save();

    // Gera token e responde
    const token = signToken(user);
    return res.status(201).json({
      token,
      user: toSafeUser(user),
    });
  } catch (err) {
    console.error("Erro no registro:", err);
    return res.status(500).send("Erro do Servidor");
  }
});

/**
 * POST /api/auth/login
 * Autentica e retorna token + dados do usuário
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email e senha são obrigatórios." });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: "Credenciais de login inválidas" });
    }

    // compara senha usando o método do model (bcrypt.compare)
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ error: "Credenciais de login inválidas" });
    }

    // se o cliente enviou role, valide (opcional)
    if (role && user.role !== role) {
      return res.status(403).json({ error: "Acesso negado para esta função" });
    }

    const token = signToken(user);
    return res.json({
      token,
      user: toSafeUser(user),
    });
  } catch (err) {
    console.error("Erro no login:", err);
    return res.status(500).send("Erro do Servidor");
  }
});

module.exports = router;
