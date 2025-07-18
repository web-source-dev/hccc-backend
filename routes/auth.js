const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { auth, adminAuth } = require('../middleware/auth');
const TokenBalance = require('../models/TokenBalance');
const Payment = require('../models/Payment');

const router = express.Router();

// Generate JWT Token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE
  });
};

// @route   POST /api/auth/signup
// @desc    Register a new user
// @access  Public
router.post('/signup', [
  body('firstname')
    .isLength({ min: 2, max: 50 })
    .withMessage('First name must be between 2 and 50 characters')
    .matches(/^[a-zA-Z\s]+$/)
    .withMessage('First name can only contain letters and spaces'),
  body('lastname')
    .isLength({ min: 2, max: 50 })
    .withMessage('Last name must be between 2 and 50 characters')
    .matches(/^[a-zA-Z\s]+$/)
    .withMessage('Last name can only contain letters and spaces'),
  body('email')
    .isEmail()
    .withMessage('Please enter a valid email'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number')
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

    const { firstname, lastname, email, password } = req.body;

    // Check if user already exists by email
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Email already registered'
      });
    }

    // Create new user
    const user = new User({
      firstname,
      lastname,
      email,
      password
    });

    await user.save();

    // Generate token
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        user: {
          id: user._id,
          _id: user._id,
          firstname: user.firstname,
          lastname: user.lastname,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt,
          lastLogin: user.lastLogin
        },
        token
      }
    });

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during registration'
    });
  }
});

// @route   POST /api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post('/login', [
  body('email')
    .isEmail()
    .withMessage('Please enter a valid email'),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
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

    const { email, password } = req.body;

    // Find user by email and include password for comparison
    const user = await User.findOne({ email }).select('+password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated'
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate token
    const token = generateToken(user._id);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user._id,
          _id: user._id,
          firstname: user.firstname,
          lastname: user.lastname,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt,
          lastLogin: user.lastLogin
        },
        token
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login'
    });
  }
});

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get('/me', auth, async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        user: req.user
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/auth/users
// @desc    Get all users (admin only)
// @access  Private (Admin)
router.get('/users', adminAuth, async (req, res) => {
  try {
    const { limit = 50, page = 1, search } = req.query;
    
    const filter = {};
    if (search) {
      filter.$or = [
        { firstname: { $regex: search, $options: 'i' } },
        { lastname: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }
    
    const users = await User.find(filter)
      .select('-password')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));
    
    const total = await User.countDocuments(filter);
    
    res.json({
      success: true,
      data: {
        users,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching users'
    });
  }
});

// @route   GET /api/auth/stats
// @desc    Get user statistics (admin only)
// @access  Private (Admin)
router.get('/stats', adminAuth, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ isActive: true });
    const adminUsers = await User.countDocuments({ role: 'admin' });
    
    // Get users created in last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const newUsers = await User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } });
    
    res.json({
      success: true,
      data: {
        totalUsers,
        activeUsers,
        adminUsers,
        newUsers
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching statistics'
    });
  }
});

// Get current user's token balances
router.get('/me/tokens', auth, async (req, res) => {
  try {
    const balances = await TokenBalance.find({ user: req.user._id })
      .populate('game', 'name')
      .sort({ game: 1, location: 1 });

    // Get pending token additions from scheduled payments
    const Payment = require('../models/Payment');
    const pendingPayments = await Payment.find({
      user: req.user._id,
      status: 'succeeded',
      tokensScheduledFor: { $exists: true, $ne: null },
      tokensAdded: false
    }).populate('game', 'name');

    // Group pending tokens by game and location
    const pendingTokens = {};
    pendingPayments.forEach(payment => {
      const key = `${payment.game._id}-${payment.location}`;
      if (!pendingTokens[key]) {
        pendingTokens[key] = {
          game: payment.game,
          location: payment.location,
          tokens: 0,
          scheduledFor: payment.tokensScheduledFor
        };
      }
      pendingTokens[key].tokens += payment.tokenPackage.tokens;
    });

    // Add pending token info to balances
    const balancesWithPending = balances.map(balance => {
      const key = `${balance.game._id}-${balance.location}`;
      const pending = pendingTokens[key];
      return {
        ...balance.toObject(),
        pendingTokens: pending ? pending.tokens : 0,
        tokensScheduledFor: pending ? pending.scheduledFor : null
      };
    });

    res.json({ 
      success: true, 
      data: { 
        balances: balancesWithPending,
        pendingTokens: Object.values(pendingTokens)
      } 
    });
  } catch (error) {
    console.error('Get token balances error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch token balances' });
  }
});

// Get all token balances for a user (admin only)
router.get('/:userId/tokens', adminAuth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const balances = await TokenBalance.find({ user: userId })
      .populate('game', 'name')
      .sort({ game: 1, location: 1 });

    // Get pending token additions from scheduled payments
    const Payment = require('../models/Payment');
    const pendingPayments = await Payment.find({
      user: userId,
      status: 'succeeded',
      tokensScheduledFor: { $exists: true, $ne: null },
      tokensAdded: false
    }).populate('game', 'name');

    // Group pending tokens by game and location
    const pendingTokens = {};
    pendingPayments.forEach(payment => {
      const key = `${payment.game._id}-${payment.location}`;
      if (!pendingTokens[key]) {
        pendingTokens[key] = {
          game: payment.game,
          location: payment.location,
          tokens: 0,
          scheduledFor: payment.tokensScheduledFor
        };
      }
      pendingTokens[key].tokens += payment.tokenPackage.tokens;
    });

    // Add pending token info to balances
    const balancesWithPending = balances.map(balance => {
      const key = `${balance.game._id}-${balance.location}`;
      const pending = pendingTokens[key];
      return {
        ...balance.toObject(),
        pendingTokens: pending ? pending.tokens : 0,
        tokensScheduledFor: pending ? pending.scheduledFor : null
      };
    });

    res.json({ 
      success: true, 
      data: { 
        balances: balancesWithPending,
        pendingTokens: Object.values(pendingTokens)
      } 
    });
  } catch (error) {
    console.error('Get token balances error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch token balances' });
  }
});

// Adjust token balance for a user/game/location (admin only)
router.post('/:userId/tokens/adjust', adminAuth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const { gameId, location, delta } = req.body;
    if (!gameId || !location || typeof delta !== 'number') {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    let balance = await TokenBalance.findOne({ user: userId, game: gameId, location });
    if (!balance) {
      balance = new TokenBalance({ user: userId, game: gameId, location, tokens: 0 });
    }
    balance.tokens = Math.max(0, balance.tokens + delta);
    await balance.save();
    res.json({ success: true, data: { balance } });
  } catch (error) {
    console.error('Adjust token balance error:', error);
    res.status(500).json({ success: false, message: 'Failed to adjust token balance' });
  }
});

// Update user (admin only)
router.put('/:userId', adminAuth, [
  body('firstname')
    .optional()
    .isLength({ min: 2, max: 50 })
    .withMessage('First name must be between 2 and 50 characters')
    .matches(/^[a-zA-Z\s]+$/)
    .withMessage('First name can only contain letters and spaces'),
  body('lastname')
    .optional()
    .isLength({ min: 2, max: 50 })
    .withMessage('Last name must be between 2 and 50 characters')
    .matches(/^[a-zA-Z\s]+$/)
    .withMessage('Last name can only contain letters and spaces'),
  body('email')
    .optional()
    .isEmail()
    .withMessage('Please enter a valid email'),
  body('role')
    .optional()
    .isIn(['user', 'admin'])
    .withMessage('Role must be either user or admin'),
  body('isActive')
    .optional()
    .isBoolean()
    .withMessage('isActive must be a boolean')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const userId = req.params.userId;
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if email is being changed and if it already exists
    if (req.body.email && req.body.email !== user.email) {
      const existingUser = await User.findOne({ email: req.body.email });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'Email already registered'
        });
      }
    }

    // Update user
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      req.body,
      { new: true, runValidators: true }
    ).select('-password');

    res.json({
      success: true,
      message: 'User updated successfully',
      data: { user: updatedUser }
    });

  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating user'
    });
  }
});

// Delete user (admin only)
router.delete('/:userId', adminAuth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Prevent admin from deleting themselves
    if (userId === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    // Delete user's token balances
    await TokenBalance.deleteMany({ user: userId });
    
    // Delete user's payments
    await Payment.deleteMany({ user: userId });
    
    // Delete user
    await User.findByIdAndDelete(userId);

    res.json({
      success: true,
      message: 'User deleted successfully'
    });

  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting user'
    });
  }
});

// Block/Unblock user (admin only)
router.patch('/:userId/block', adminAuth, [
  body('isActive')
    .isBoolean()
    .withMessage('isActive must be a boolean')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const userId = req.params.userId;
    const { isActive } = req.body;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Prevent admin from blocking themselves
    if (userId === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        message: 'Cannot block your own account'
      });
    }

    user.isActive = isActive;
    await user.save();

    res.json({
      success: true,
      message: `User ${isActive ? 'activated' : 'blocked'} successfully`,
      data: { user }
    });

  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating user status'
    });
  }
});

module.exports = router; 