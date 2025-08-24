const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { auth, adminAuth, cashierAuth, locationSpecificAuth } = require('../middleware/auth');
const TokenBalance = require('../models/TokenBalance');
const Payment = require('../models/Payment');
const { sendEmail } = require('../utils/email');
const crypto = require('crypto');

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
    const { limit = 50, page = 1, search, role, status, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    
    const filter = {};
    
    // Search filter
    if (search) {
      filter.$or = [
        { firstname: { $regex: search, $options: 'i' } },
        { lastname: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Role filter
    if (role && role !== 'all') {
      filter.role = role;
    }
    
    // Status filter
    if (status && status !== 'all') {
      if (status === 'active') {
        filter.isActive = { $ne: false };
      } else if (status === 'inactive') {
        filter.isActive = false;
      }
    }
    
    // Build sort object
    const sort = {};
    if (sortBy) {
      sort[sortBy] = sortOrder === 'asc' ? 1 : -1;
    }
    
    const users = await User.find(filter)
      .select('-password')
      .sort(sort)
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

// Cashier-specific routes

// Get users for cashier (filtered by location access)
router.get('/cashier/users', cashierAuth, async (req, res) => {
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
    console.error('Get cashier users error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching users'
    });
  }
});

// Get token balances for cashier (filtered by location)
router.get('/cashier/tokens', cashierAuth, async (req, res) => {
  try {
    const { location } = req.query;
    
    // Determine allowed locations based on cashier role
    let allowedLocations = [];
    if (req.user.role === 'admin') {
      allowedLocations = ['Cedar Park', 'Liberty Hill'];
    } else if (req.user.role === 'cashierCedar') {
      allowedLocations = ['Cedar Park'];
    } else if (req.user.role === 'cashierLiberty') {
      allowedLocations = ['Liberty Hill'];
    }
    
    // If specific location is requested, check if cashier has access
    if (location && !allowedLocations.includes(location)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. You can only manage ${allowedLocations.join(' and ')} tokens.`
      });
    }
    
    const filter = {};
    if (location) {
      filter.location = location;
    } else {
      filter.location = { $in: allowedLocations };
    }
    
    const balances = await TokenBalance.find(filter)
      .populate('game', 'name')
      .populate('user', 'firstname lastname email')
      .sort({ game: 1, location: 1, 'user.firstname': 1 });
    
    // Get pending token additions from scheduled payments
    const pendingPayments = await Payment.find({
      status: 'succeeded',
      tokensScheduledFor: { $exists: true, $ne: null },
      tokensAdded: false,
      location: filter.location || { $in: allowedLocations }
    }).populate('game', 'name').populate('user', 'firstname lastname email');

    // Group pending tokens by user, game and location
    const pendingTokens = {};
    pendingPayments.forEach(payment => {
      const key = `${payment.user._id}-${payment.game._id}-${payment.location}`;
      if (!pendingTokens[key]) {
        pendingTokens[key] = {
          user: payment.user,
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
      const key = `${balance.user._id}-${balance.game._id}-${balance.location}`;
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
        pendingTokens: Object.values(pendingTokens),
        allowedLocations
      } 
    });
  } catch (error) {
    console.error('Get cashier token balances error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch token balances' });
  }
});

// Adjust token balance for cashier (location-specific)
router.post('/cashier/tokens/adjust', cashierAuth, async (req, res) => {
  try {
    const { userId, gameId, location, delta } = req.body;
    
    if (!userId || !gameId || !location || typeof delta !== 'number') {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    // Check if cashier has access to this location
    let allowedLocations = [];
    if (req.user.role === 'admin') {
      allowedLocations = ['Cedar Park', 'Liberty Hill'];
    } else if (req.user.role === 'cashierCedar') {
      allowedLocations = ['Cedar Park'];
    } else if (req.user.role === 'cashierLiberty') {
      allowedLocations = ['Liberty Hill'];
    }
    
    if (!allowedLocations.includes(location)) {
      return res.status(403).json({ 
        success: false, 
        message: `Access denied. You can only manage ${allowedLocations.join(' and ')} tokens.` 
      });
    }
    
    let balance = await TokenBalance.findOne({ user: userId, game: gameId, location });
    if (!balance) {
      balance = new TokenBalance({ user: userId, game: gameId, location, tokens: 0 });
    }
    
    balance.tokens = Math.max(0, balance.tokens + delta);
    await balance.save();
    
    // Populate the balance for response
    await balance.populate('game', 'name');
    await balance.populate('user', 'firstname lastname email');
    
    res.json({ success: true, data: { balance } });
  } catch (error) {
    console.error('Cashier adjust token balance error:', error);
    res.status(500).json({ success: false, message: 'Failed to adjust token balance' });
  }
});

// Get all token balances for admin (bulk endpoint)
router.get('/admin/tokens', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 15, search = '', location = '', game = '', sortBy = 'user', sortOrder = 'asc' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build user filter
    let userFilter = {};
    if (search) {
      userFilter = {
        $or: [
          { firstname: { $regex: search, $options: 'i' } },
          { lastname: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ]
      };
    }
    
    // Build sort object for users
    const userSort = {};
    if (sortBy === 'user') {
      userSort.firstname = sortOrder === 'asc' ? 1 : -1;
      userSort.lastname = sortOrder === 'asc' ? 1 : -1;
    }
    
    // Get users with pagination
    const users = await User.find(userFilter)
      .select('_id firstname lastname email')
      .skip(skip)
      .limit(parseInt(limit))
      .sort(userSort);
    
    const totalUsers = await User.countDocuments(userFilter);
    
    // Build token balance filter
    let balanceFilter = {};
    if (location) {
      balanceFilter.location = location;
    }
    if (game) {
      balanceFilter.game = game;
    }
    
    // Build sort object for token balances
    const balanceSort = {};
    if (sortBy === 'user') {
      balanceSort['user.firstname'] = sortOrder === 'asc' ? 1 : -1;
      balanceSort['user.lastname'] = sortOrder === 'asc' ? 1 : -1;
    } else if (sortBy === 'game') {
      balanceSort['game.name'] = sortOrder === 'asc' ? 1 : -1;
    } else if (sortBy === 'location') {
      balanceSort.location = sortOrder === 'asc' ? 1 : -1;
    } else if (sortBy === 'tokens') {
      balanceSort.tokens = sortOrder === 'asc' ? 1 : -1;
    } else if (sortBy === 'updatedAt') {
      balanceSort.updatedAt = sortOrder === 'asc' ? 1 : -1;
    }
    
    // Get all token balances for the users
    const balances = await TokenBalance.find({
      ...balanceFilter,
      user: { $in: users.map(u => u._id) }
    })
      .populate('game', 'name')
      .populate('user', 'firstname lastname email')
      .sort(balanceSort);
    
    // Get pending token additions from scheduled payments
    const Payment = require('../models/Payment');
    const pendingPayments = await Payment.find({
      user: { $in: users.map(u => u._id) },
      status: 'succeeded',
      tokensScheduledFor: { $exists: true, $ne: null },
      tokensAdded: false,
      ...(location && { location }),
      ...(game && { game })
    }).populate('game', 'name').populate('user', 'firstname lastname email');

    // Group pending tokens by user, game and location
    const pendingTokens = {};
    pendingPayments.forEach(payment => {
      const key = `${payment.user._id}-${payment.game._id}-${payment.location}`;
      if (!pendingTokens[key]) {
        pendingTokens[key] = {
          user: payment.user,
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
      const key = `${balance.user._id}-${balance.game._id}-${balance.location}`;
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
        pendingTokens: Object.values(pendingTokens),
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: totalUsers,
          pages: Math.ceil(totalUsers / parseInt(limit))
        }
      } 
    });
  } catch (error) {
    console.error('Get admin token balances error:', error);
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
    .isIn(['user', 'admin', 'cashierCedar', 'cashierLiberty'])
    .withMessage('Role must be either user, admin, cashierCedar, or cashierLiberty'),
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

// @route   POST /api/auth/forgot-password
// @desc    Send reset password email
// @access  Public
router.post('/forgot-password', [
  body('email')
    .isEmail()
    .withMessage('Please enter a valid email')
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

    const { email } = req.body;

    console.log('Email:', email);

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase() });

    console.log('User:', user);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No user found with that email address'
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Account is deactivated'
      });
    }

    // Generate reset token
    const resetToken = user.getResetPasswordToken();
    await user.save({ validateBeforeSave: false });

    // Create reset URL
    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;

    // Email content
    const subject = 'Password Reset Request - HCCC Game Room';
    const html = `
      <div style="font-family: Arial, sans-serif; background: #f9f9f9; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0; max-width: 520px; margin: auto;">
        <div style="text-align: center; margin-bottom: 18px;">
          <h2 style="color: #1e293b; margin: 0;">HCCC Game Room - Password Reset</h2>
        </div>
        <p>Hello ${user.firstname} ${user.lastname},</p>
        <p>You requested a password reset for your HCCC Game Room account.</p>
        <p>Click the button below to reset your password:</p>
        <div style="text-align: center; margin: 24px 0;">
          <a href="${resetUrl}" style="background-color: #38a169; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">Reset Password</a>
        </div>
        <p><strong>This link will expire in 10 minutes.</strong></p>
        <p>If you didn't request this password reset, please ignore this email.</p>
        <hr style="margin: 24px 0;"/>
        <p style="font-size: 13px; color: #718096;">This is an automated email from HCCC Game Room.</p>
      </div>
    `;

    const text = `Hello ${user.firstname} ${user.lastname},\n\nYou requested a password reset for your HCCC Game Room account.\n\nClick the link below to reset your password:\n${resetUrl}\n\nThis link will expire in 10 minutes.\n\nIf you didn't request this password reset, please ignore this email.\n\nBest regards,\nHCCC Game Room Team`;

    // Send email
    await sendEmail({
      to: user.email,
      subject,
      html,
      text
    });

    res.json({
      success: true,
      message: 'Password reset email sent successfully'
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    
    // Reset user fields if email fails
    if (error.message.includes('email')) {
      user.resetPasswordToken = undefined;
      user.resetPasswordExpire = undefined;
      await user.save({ validateBeforeSave: false });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to send password reset email'
    });
  }
});

// @route   POST /api/auth/reset-password
// @desc    Reset password with token
// @access  Public
router.post('/reset-password', [
  body('token')
    .notEmpty()
    .withMessage('Reset token is required'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number')
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

    const { token, password } = req.body;

    // Hash the token to compare with stored hash
    const resetPasswordToken = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    // Find user with valid token and not expired
    const user = await User.findOne({
      resetPasswordToken,
      resetPasswordExpire: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset token'
      });
    }

    // Set new password
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();

    // Generate new JWT token
    const newToken = generateToken(user._id);

    res.json({
      success: true,
      message: 'Password reset successfully',
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
        token: newToken
      }
    });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during password reset'
    });
  }
});

module.exports = router; 