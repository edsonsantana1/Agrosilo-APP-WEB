const express = require("express");
const router = express.Router();
const Silo = require("../models/silo");
const { auth } = require("../middleware/auth"); // <= aqui!

// Create a new silo
router.post("/", auth, async (req, res) => {
  try {
    const silo = new Silo({ ...req.body, user: req.user._id });
    await silo.save();
    res.status(201).send(silo);
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

// Get all silos for the authenticated user
router.get("/", auth, async (req, res) => {
  try {
    const silos = await Silo.find({ user: req.user._id }).populate("sensors");
    res.send(silos);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// Get a specific silo by ID
router.get("/:id", auth, async (req, res) => {
  try {
    const silo = await Silo.findOne({ _id: req.params.id, user: req.user._id }).populate("sensors");
    if (!silo) return res.status(404).send();
    res.send(silo);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// Update a silo by ID
router.patch("/:id", auth, async (req, res) => {
  const updates = Object.keys(req.body);
  const allowedUpdates = ["name", "location"];
  const isValid = updates.every((u) => allowedUpdates.includes(u));
  if (!isValid) return res.status(400).send({ error: "Invalid updates!" });

  try {
    const silo = await Silo.findOne({ _id: req.params.id, user: req.user._id });
    if (!silo) return res.status(404).send();

    updates.forEach((u) => (silo[u] = req.body[u]));
    await silo.save();
    res.send(silo);
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

// Delete a silo by ID
router.delete("/:id", auth, async (req, res) => {
  try {
    const silo = await Silo.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!silo) return res.status(404).send();
    res.send({ message: "Silo deleted successfully" });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

module.exports = router;
