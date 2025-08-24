const express = require('express');
const router = express.Router();
const Winners = require('../models/winners');
const { adminAuth } = require('../middleware/auth');

// Get all winners (admin only)
router.get('/', adminAuth, async (req, res) => {
  try {
    const winners = await Winners.find()
      .populate('game', 'name')
      .sort({ date: -1 });
    res.json(winners);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get public winners (visible ones)
router.get('/public', async (req, res) => {
  try {
    const winners = await Winners.find({ showWinner: true })
      .populate('game', 'name')
      .sort({ date: -1 });
    res.json(winners);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single winner by ID (admin only)
router.get('/:id', adminAuth, async (req, res) => {
  try {
    const winner = await Winners.findById(req.params.id).populate('game', 'name');
    if (!winner) return res.status(404).json({ error: 'Winner not found' });
    res.json(winner);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create winner (admin only)
router.post('/', adminAuth, async (req, res) => {
  try {
    const { name, email, phone, location, game, amount, date, showWinner } = req.body;
    
    // Validate required fields
    if (!name || !email || !phone || !location || !game || !amount || !date) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const winner = new Winners({ 
      name, 
      email, 
      phone, 
      location, 
      game, 
      amount, 
      date, 
      showWinner: showWinner || false 
    });
    await winner.save();
    
    const populatedWinner = await Winners.findById(winner._id).populate('game', 'name');
    res.status(201).json(populatedWinner);
  } catch (err) {
    console.error('Create winner error:', err);
    res.status(400).json({ error: 'Invalid data' });
  }
});

// Update winner (admin only)
router.put('/:id', adminAuth, async (req, res) => {
  try {
    const { name, email, phone, location, game, amount, date, showWinner } = req.body;
    
    const winner = await Winners.findByIdAndUpdate(
      req.params.id,
      { name, email, phone, location, game, amount, date, showWinner },
      { new: true, runValidators: true }
    ).populate('game', 'name');
    
    if (!winner) return res.status(404).json({ error: 'Winner not found' });
    res.json(winner);
  } catch (err) {
    console.error('Update winner error:', err);
    res.status(400).json({ error: 'Invalid data' });
  }
});

// Delete winner (admin only)
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const winner = await Winners.findByIdAndDelete(req.params.id);
    if (!winner) return res.status(404).json({ error: 'Winner not found' });
    res.json({ message: 'Winner deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle winner visibility (admin only)
router.patch('/:id/toggle-visibility', adminAuth, async (req, res) => {
  try {
    const winner = await Winners.findById(req.params.id);
    if (!winner) return res.status(404).json({ error: 'Winner not found' });
    
    winner.showWinner = !winner.showWinner;
    await winner.save();
    
    const populatedWinner = await Winners.findById(winner._id).populate('game', 'name');
    res.json(populatedWinner);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
