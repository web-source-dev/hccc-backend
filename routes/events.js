const express = require('express');
const router = express.Router();
const Event = require('../models/Event');

// Get all events
router.get('/', async (req, res) => {
  try {
    const events = await Event.find().sort({ date: -1 });
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single event by ID
router.get('/:id', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create event
router.post('/', async (req, res) => {
  try {
    const { title, description, date, location, image } = req.body;
    const event = new Event({ title, description, date, location, image });
    await event.save();
    res.status(201).json(event);
  } catch (err) {
    res.status(400).json({ error: 'Invalid data' });
  }
});

// Update event
router.put('/:id', async (req, res) => {
  try {
    const { title, description, date, location, image } = req.body;
    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { title, description, date, location, image },
      { new: true, runValidators: true }
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (err) {
    res.status(400).json({ error: 'Invalid data' });
  }
});

// Delete event
router.delete('/:id', async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json({ message: 'Event deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router; 