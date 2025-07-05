const express = require('express');
const { body, validationResult } = require('express-validator');
const Game = require('../models/Game');
const { auth, adminAuth } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/games
// @desc    Get all games (public)
// @access  Public
router.get('/', async (req, res) => {
  try {
    const { status, category, featured, limit = 50, page = 1 } = req.query;
    
    const filter = {};
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (featured !== undefined) filter.featured = featured === 'true';
    
    const games = await Game.find(filter)
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));
    
    const total = await Game.countDocuments(filter);
    
    res.json({
      success: true,
      data: {
        games,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get games error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching games'
    });
  }
});

// @route   GET /api/games/:id
// @desc    Get game by ID (public)
// @access  Public
router.get('/:id', async (req, res) => {
  try {
    const game = await Game.findById(req.params.id)
      .populate('createdBy', 'username');
    
    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }
    
    res.json({
      success: true,
      data: { game }
    });
  } catch (error) {
    console.error('Get game error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching game'
    });
  }
});

// @route   POST /api/games
// @desc    Create a new game (admin only)
// @access  Private (Admin)
router.post('/', adminAuth, [
  body('name')
    .isLength({ min: 2, max: 100 })
    .withMessage('Game name must be between 2 and 100 characters')
    .trim(),
  body('description')
    .isLength({ min: 10, max: 500 })
    .withMessage('Description must be between 10 and 500 characters')
    .trim(),
  body('image')
    .notEmpty()
    .withMessage('Game image is required')
    .trim(),
  body('category')
    .isIn(['RPG', 'Action', 'Sci-Fi', 'Adventure', 'Strategy', 'Puzzle', 'Racing', 'Sports', 'Other'])
    .withMessage('Invalid category'),
  body('status')
    .optional()
    .isIn(['active', 'inactive', 'maintenance'])
    .withMessage('Invalid status'),
  body('locations')
    .isArray({ min: 1 })
    .withMessage('At least one location is required'),
  body('locations.*.name')
    .notEmpty()
    .withMessage('Location name is required'),
  body('locations.*.available')
    .optional()
    .isBoolean()
    .withMessage('Location available must be a boolean'),
  body('tokenPackages')
    .isArray({ min: 1 })
    .withMessage('At least one token package is required'),
  body('tokenPackages.*.tokens')
    .isInt({ min: 1 })
    .withMessage('Token amount must be at least 1'),
  body('tokenPackages.*.price')
    .isFloat({ min: 0 })
    .withMessage('Token package price must be a positive number'),
  body('featured')
    .optional()
    .isBoolean()
    .withMessage('Featured must be a boolean')
], async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const {
      name,
      description,
      image,
      category,
      status = 'active',
      locations,
      tokenPackages,
      featured = false
    } = req.body;

    // Check if game name already exists
    const existingGame = await Game.findOne({ name });
    if (existingGame) {
      return res.status(400).json({
        success: false,
        message: 'Game with this name already exists'
      });
    }

    // Create new game
    const game = new Game({
      name,
      description,
      image,
      category,
      status,
      locations,
      tokenPackages,
      featured,
      createdBy: req.user.id
    });

    await game.save();

    // Populate creator info
    await game.populate('createdBy', 'username');

    res.status(201).json({
      success: true,
      message: 'Game created successfully',
      data: { game }
    });

  } catch (error) {
    console.error('Create game error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while creating game'
    });
  }
});

// @route   PUT /api/games/:id
// @desc    Update a game (admin only)
// @access  Private (Admin)
router.put('/:id', adminAuth, [
  body('name')
    .optional()
    .isLength({ min: 2, max: 100 })
    .withMessage('Game name must be between 2 and 100 characters')
    .trim(),
  body('description')
    .optional()
    .isLength({ min: 10, max: 500 })
    .withMessage('Description must be between 10 and 500 characters')
    .trim(),
  body('image')
    .optional()
    .notEmpty()
    .withMessage('Game image is required')
    .trim(),
  body('category')
    .optional()
    .isIn(['RPG', 'Action', 'Sci-Fi', 'Adventure', 'Strategy', 'Puzzle', 'Racing', 'Sports', 'Other'])
    .withMessage('Invalid category'),
  body('status')
    .optional()
    .isIn(['active', 'inactive', 'maintenance'])
    .withMessage('Invalid status'),
  body('locations')
    .optional()
    .isArray({ min: 1 })
    .withMessage('At least one location is required'),
  body('locations.*.name')
    .optional()
    .notEmpty()
    .withMessage('Location name is required'),
  body('locations.*.available')
    .optional()
    .isBoolean()
    .withMessage('Location available must be a boolean'),
  body('tokenPackages')
    .optional()
    .isArray({ min: 1 })
    .withMessage('At least one token package is required'),
  body('featured')
    .optional()
    .isBoolean()
    .withMessage('Featured must be a boolean')
], async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const game = await Game.findById(req.params.id);
    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    // Check if name is being changed and if it already exists
    if (req.body.name && req.body.name !== game.name) {
      const existingGame = await Game.findOne({ name: req.body.name });
      if (existingGame) {
        return res.status(400).json({
          success: false,
          message: 'Game with this name already exists'
        });
      }
    }

    // Update game
    const updatedGame = await Game.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate('createdBy', 'username');

    res.json({
      success: true,
      message: 'Game updated successfully',
      data: { game: updatedGame }
    });

  } catch (error) {
    console.error('Update game error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating game'
    });
  }
});

// @route   DELETE /api/games/:id
// @desc    Delete a game (admin only)
// @access  Private (Admin)
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const game = await Game.findById(req.params.id);
    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    await Game.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Game deleted successfully'
    });

  } catch (error) {
    console.error('Delete game error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting game'
    });
  }
});

module.exports = router; 