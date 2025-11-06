// backend/models/Assessment.js
const mongoose = require('mongoose');

const AssessmentSchema = new mongoose.Schema({
  silo: { type: mongoose.Schema.Types.ObjectId, index: true },
  ts:   { type: Date, index: true },
  temp: Number,
  hum:  Number,
  pressure: Number,
  co2: Number,
  status: {
    temperature: String,
    humidity: String,
    pressure: String,
    co2: String
  },
  aeration: {
    recommendedFlow_m3_min_ton: [Number],
    label: String
  },
  notes: [String]
}, { collection: 'grain_assessments' });

AssessmentSchema.index({ silo: 1, ts: -1 });

module.exports = mongoose.model('Assessment', AssessmentSchema);
