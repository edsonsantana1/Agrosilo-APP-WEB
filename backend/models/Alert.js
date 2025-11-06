const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  siloId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Silo', required: true, index: true },
  sensorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Sensor', required: true, index: true },
  siloName:   { type: String, required: true },
  sensorType: { type: String, enum: ['temperature','humidity','pressure','co2'], required: true, index: true },
  level:      { type: String, enum: ['caution','warning','critical'], required: true, index: true },
  message:    { type: String, required: true },
  recommendation: { type: String },
  value:      { type: Number, required: true },
  timestamp:  { type: Date, default: Date.now, index: true },
  acknowledged: { type: Boolean, default: false, index: true }
}, { timestamps: true });

// buscas comuns
alertSchema.index({ userId:1, timestamp:-1 });
alertSchema.index({ userId:1, siloId:1, timestamp:-1 });
alertSchema.index({ userId:1, level:1, timestamp:-1 });

module.exports = mongoose.model('Alert', alertSchema);
