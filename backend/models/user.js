// models/user.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MfaSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    secret: { type: String, default: null },     // definitivo, só após confirmar
    tempSecret: { type: String, default: null }, // usado no provision antes de confirmar
    method: { type: String, enum: ['app'], default: 'app' } // se quiser evoluir
  },
  { _id: false } // subdocumento, sem _id
);

const UserSchema = new mongoose.Schema(
  {
    role: { type: String, required: true, enum: ['user', 'admin'], default: 'user' },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    name: { type: String, trim: true },
    phoneNumber: { type: String, trim: true },
    telegramChatId: { type: String, trim: true },
    notificationsEnabled: { type: Boolean, default: true },
    mfa: { type: MfaSchema, default: () => ({}) }
  },
  { timestamps: true, minimize: false } // não remova objetos vazios
);

UserSchema.pre('save', async function(next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});

UserSchema.methods.comparePassword = function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Remover dados sensíveis ao serializar
UserSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  if (obj.mfa) {
    // não exponha segredos
    delete obj.mfa.secret;
    delete obj.mfa.tempSecret;
  }
  return obj;
};

module.exports = mongoose.model('User', UserSchema);
