// backend/models/alertDispatch.js
const mongoose = require('mongoose');

const AlertDispatchSchema = new mongoose.Schema({
  user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  sensor:  { type: mongoose.Schema.Types.ObjectId, ref: 'Sensor', index: true },
  level:   { type: String, enum: ['caution', 'warning', 'critical'], index: true },
  channel: { type: String, enum: ['telegram', 'email'], index: true }, // canal separado
  lastValue:  { type: Number },
  lastSentAt: { type: Date }
}, { timestamps: true });

// 1 doc por combinação (user,sensor,level,channel)
AlertDispatchSchema.index({ user: 1, sensor: 1, level: 1, channel: 1 }, { unique: true });

module.exports = mongoose.model('AlertDispatch', AlertDispatchSchema);
