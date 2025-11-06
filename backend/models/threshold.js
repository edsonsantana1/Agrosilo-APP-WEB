const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Thresholds por usuário.
 * Um documento por user (escopo do usuário logado do seu app).
 * Você pode ter defaults aqui e alterar depois via API.
 */
const thresholdSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', unique: true, required: true },

  humidity: {
    acceptable:   { type: Number, default: 14 },
    safe:         { type: Number, default: 13 },
    insect_limit: { type: Number, default: 10 },
    fungus_risk:  { type: Number, default: 16 }
  },

  temperature: {
    slow_fungus:       { type: Number, default: 15 },
    medium_growth_min: { type: Number, default: 20 },
    medium_growth_max: { type: Number, default: 30 },
    high_risk_min:     { type: Number, default: 40 },
    high_risk_max:     { type: Number, default: 55 }
  },

// marca quando foi alterado
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Threshold', thresholdSchema);
