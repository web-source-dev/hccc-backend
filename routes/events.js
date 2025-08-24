const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const { adminAuth } = require('../middleware/auth');

// Get all events (admin only)
router.get('/', adminAuth, async (req, res) => {
  try {
    const events = await Event.find().sort({ date: -1 });
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get public events (visible ones)
router.get('/public', async (req, res) => {
  try {
    const events = await Event.find({ showEvent: true }).sort({ date: -1 });
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single event by ID (admin only)
router.get('/:id', adminAuth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create event (admin only)
router.post('/', adminAuth, async (req, res) => {
  try {
    const { title, description, date, location, image, showEvent } = req.body;
    const event = new Event({ 
      title, 
      description, 
      date, 
      location, 
      image, 
      showEvent: showEvent || false 
    });
    await event.save();
    res.status(201).json(event);
  } catch (err) {
    res.status(400).json({ error: 'Invalid data' });
  }
});

// Update event (admin only)
router.put('/:id', adminAuth, async (req, res) => {
  try {
    const { title, description, date, location, image, showEvent } = req.body;
    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { title, description, date, location, image, showEvent },
      { new: true, runValidators: true }
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (err) {
    res.status(400).json({ error: 'Invalid data' });
  }
});

// Delete event (admin only)
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json({ message: 'Event deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router; 