// models/sensor.js
const mongoose = require('mongoose');

const SensorSchema = new mongoose.Schema(
  {
    silo: { type: mongoose.Schema.Types.ObjectId, ref: 'Silo', required: true },
    type: {
      type: String,
      required: true,
      enum: ['temperature', 'humidity', 'pressure', 'co2'],
      index: true
    },


    thingSpeakConfig: {
      channelId:   { type: String },
      fieldNumber: { type: Number },
      apiKey:      { type: String },
      lastSync:    { type: Date }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Sensor', SensorSchema);
