const jwt = require('jsonwebtoken');
const User = require('../models/User');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        message: 'Access denied. No token provided.' 
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');
    
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid token. User not found.' 
      });
    }

    if (!user.isActive) {
      return res.status(401).json({ 
        success: false, 
        message: 'Account is deactivated.' 
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid token.' 
      });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false, 
        message: 'Token expired.' 
      });
    }
    res.status(500).json({ 
      success: false, 
      message: 'Server error.' 
    });
  }
};

const adminAuth = async (req, res, next) => {
  try {
    await auth(req, res, () => {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ 
          success: false, 
          message: 'Access denied. Admin privileges required.' 
        });
      }
      next();
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Server error.' 
    });
  }
};

const cashierAuth = async (req, res, next) => {
  try {
    await auth(req, res, () => {
      if (!['admin', 'cashierCedar', 'cashierLiberty'].includes(req.user.role)) {
        return res.status(403).json({ 
          success: false, 
          message: 'Access denied. Cashier privileges required.' 
        });
      }
      next();
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Server error.' 
    });
  }
};

const locationSpecificAuth = (allowedLocation) => async (req, res, next) => {
  try {
    await auth(req, res, () => {
      if (req.user.role === 'admin') {
        // Admin can access all locations
        next();
        return;
      }
      
      if (req.user.role === 'cashierCedar' && allowedLocation === 'Cedar Park') {
        next();
        return;
      }
      
      if (req.user.role === 'cashierLiberty' && allowedLocation === 'Liberty Hill') {
        next();
        return;
      }
      
      return res.status(403).json({ 
        success: false, 
        message: `Access denied. You can only manage ${allowedLocation} tokens.` 
      });
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Server error.' 
    });
  }
};

module.exports = { auth, adminAuth, cashierAuth, locationSpecificAuth }; 