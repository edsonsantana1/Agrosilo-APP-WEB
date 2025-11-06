
const mongoose = require("mongoose");

const SiloSchema = new mongoose.Schema({
    name: { type: String, required: true },
    location: { type: String },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sensors: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Sensor"
    }],
});

module.exports = mongoose.model("Silo", SiloSchema);


