// routes/user.js
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { auth, adminAuth } = require('../middleware/auth');

/**
 * LISTAR usuários (apenas admin)
 */
router.get('/', auth, adminAuth, async (req, res) => {
  try {
    const users = await User.find({}).sort({ createdAt: -1 });
    res.send(users);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

/**
 * CRIAR usuário (apenas admin)
 * Obs: Não use /auth/register para o admin criar usuários.
 */
router.post('/', auth, adminAuth, async (req, res) => {
  try {
    const { name, email, password, role = 'user', phoneNumber, telegramChatId, notificationsEnabled } = req.body;

    if (!email || !password) {
      return res.status(400).send({ error: 'E-mail e senha são obrigatórios.' });
    }

    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(409).send({ error: 'E-mail já cadastrado.' });

    const user = new User({
      name,
      email,
      password,
      role,
      phoneNumber,
      telegramChatId,
      notificationsEnabled
    });

    await user.save();
    res.status(201).send(user);
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

/**
 * ATUALIZAR usuário (apenas admin)
 */
router.patch('/:id', auth, adminAuth, async (req, res) => {
  try {
    const updates = Object.keys(req.body);
    const allowed = [
      'name',
      'email',
      'password',
      'role',
      'phoneNumber',
      'telegramChatId',
      'notificationsEnabled'
    ];
    const ok = updates.every(u => allowed.includes(u));
    if (!ok) return res.status(400).send({ error: 'Campos inválidos para atualização.' });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).send({ error: 'Usuário não encontrado.' });

    updates.forEach(u => user[u] = req.body[u]);
    await user.save(); // dispara o hash de senha se password mudou

    res.send(user);
  } catch (error) {
    // conflito de e-mail duplicado, etc.
    const code = error.code === 11000 ? 409 : 400;
    res.status(code).send({ error: error.message });
  }
});

/**
 * EXCLUIR usuário (apenas admin)
 */
router.delete('/:id', auth, adminAuth, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).send({ error: 'Usuário não encontrado.' });
    res.send({ message: 'Usuário excluído com sucesso.' });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

module.exports = router;
