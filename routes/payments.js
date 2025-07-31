const express = require('express');
const { body, validationResult } = require('express-validator');
const Payment = require('../models/Payment');
const Game = require('../models/Game');
const TokenBalance = require('../models/TokenBalance');
const { auth, adminAuth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { getTimeRestrictionInfo, checkTimeRestriction } = require('../utils/timeRestrictions');
const { createOrder, captureOrder, getOrder, verifyWebhookSignature, mapPayPalStatus, validateWebhookEvent } = require('../services/paypalService');

const router = express.Router();

// Helper function to assess payment risk
function assessPaymentRisk(payment, req) {
  const riskFactors = [];
  let riskLevel = 'low';

  // Check for high-value transactions
  if (payment.amount > 100) {
    riskFactors.push('high_value');
    riskLevel = 'medium';
  }

  // Check for rapid successive payments
  // This would need to be implemented with additional queries

  // Check for unusual IP patterns
  const clientIP = req.ip || req.connection.remoteAddress;
  if (clientIP) {
    payment.metadata.ipAddress = clientIP;
  }

  // Check user agent
  const userAgent = req.get('User-Agent');
  if (userAgent) {
    payment.metadata.userAgent = userAgent;
  }

  // Check for new user (first payment)
  // This would need to be implemented with additional queries

  payment.metadata.riskLevel = riskLevel;
  payment.metadata.riskFactors = riskFactors;

  return { riskLevel, riskFactors };
}

// Helper function to get user-friendly error message
function getUserFriendlyError(error) {
  if (typeof error === 'string') {
    return error;
  }

  // PayPal specific errors
  if (error.response?.data?.details?.[0]?.issue) {
    const issue = error.response.data.details[0].issue;
    const issueMap = {
      'INVALID_REQUEST': 'Invalid payment request. Please check your details and try again.',
      'ORDER_NOT_APPROVED': 'Payment was not approved. Please try again.',
      'ORDER_ALREADY_CAPTURED': 'Payment has already been processed.',
      'ORDER_EXPIRED': 'Payment order has expired. Please create a new order.',
      'PAYER_ACCOUNT_LOCKED_OR_CLOSED': 'PayPal account is locked or closed. Please use a different payment method.',
      'PAYER_ACCOUNT_RESTRICTED': 'PayPal account is restricted. Please use a different payment method.',
      'PAYER_CANNOT_PAY': 'Unable to process payment with this PayPal account. Please try a different method.',
      'PAYER_COUNTRY_NOT_SUPPORTED': 'PayPal payments from your country are not supported.',
      'PAYER_ACCOUNT_NOT_VERIFIED': 'PayPal account is not verified. Please verify your account or use a different method.',
      'INSUFFICIENT_FUNDS': 'Insufficient funds in PayPal account. Please add funds or use a different payment method.',
      'CURRENCY_NOT_SUPPORTED': 'Currency not supported. Please try again with USD.',
      'AMOUNT_TOO_LARGE': 'Payment amount is too large. Please contact support.',
      'AMOUNT_TOO_SMALL': 'Payment amount is too small. Please try a larger amount.'
    };
    return issueMap[issue] || 'Payment processing error. Please try again.';
  }

  // Network errors
  if (error.code === 'ECONNABORTED') {
    return 'Payment service timeout. Please try again.';
  }
  if (error.code === 'ENOTFOUND') {
    return 'Unable to connect to payment service. Please check your internet connection.';
  }

  // HTTP status errors
  if (error.response?.status === 400) {
    return 'Invalid payment request. Please check your details and try again.';
  }
  if (error.response?.status === 401) {
    return 'Payment service authentication failed. Please try again later.';
  }
  if (error.response?.status === 403) {
    return 'Payment request was denied. Please contact support if this persists.';
  }
  if (error.response?.status === 404) {
    return 'Payment order not found. Please try again.';
  }
  if (error.response?.status === 409) {
    return 'Payment is being processed. Please wait a moment and try again.';
  }
  if (error.response?.status >= 500) {
    return 'Payment service is temporarily unavailable. Please try again later.';
  }

  return 'An unexpected error occurred. Please try again later.';
}

// Helper function to map PayPal status to display status
function getDisplayStatus(paypalStatus) {
  switch (paypalStatus) {
    case 'COMPLETED':
      return 'succeeded';
    case 'PENDING':
      return 'processing';
    case 'VOIDED':
      return 'canceled';
    case 'DENIED':
      return 'failed';
    case 'EXPIRED':
      return 'expired';
    default:
      return 'incomplete';
  }
}

// @route   POST /api/payments/create-order
// @desc    Create a PayPal order for token purchase
// @access  Private
router.post('/create-order', auth, [
  body('gameId')
    .isMongoId()
    .withMessage('Valid game ID is required'),
  body('packageIndex')
    .isInt({ min: 0 })
    .withMessage('Valid package index is required'),
  body('location')
    .notEmpty()
    .withMessage('Location is required')
], async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Please check your input and try again.',
        errors: errors.array().map(err => err.msg)
      });
    }

    const { gameId, packageIndex, location } = req.body;

    // Get the game
    const game = await Game.findById(gameId);
    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found. Please try again.'
      });
    }

    // Check if game is active
    if (game.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'This game is currently unavailable for purchase.'
      });
    }

    // Get the token package
    const tokenPackage = game.tokenPackages[packageIndex];
    if (!tokenPackage) {
      return res.status(400).json({
        success: false,
        message: 'Invalid token package selected. Please try again.'
      });
    }

    // Check if location is available
    const locationData = game.locations.find(loc =>
      loc.name.toLowerCase().replace(/\s+/g, '-') === location.toLowerCase().replace(/\s+/g, '-')
    );
    if (!locationData || !locationData.available) {
      return res.status(400).json({
        success: false,
        message: 'Selected location is not available. Please choose a different location.'
      });
    }

    // Check for existing pending payment for the same user, game, and package
    const existingPayment = await Payment.findOne({
      user: req.user.id,
      game: game._id,
      'tokenPackage.tokens': game.tokenPackages[packageIndex].tokens,
      'tokenPackage.price': game.tokenPackages[packageIndex].price,
      location: locationData.name,
      status: { $in: ['incomplete', 'processing'] },
      createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) } // Within last 30 minutes
    });

    if (existingPayment) {
      // Check if the existing order is still valid
      try {
        const orderResult = await getOrder(existingPayment.paypalOrderId);
        if (orderResult.success && ['CREATED', 'SAVED'].includes(orderResult.order.status)) {
          // Return existing order if it's still valid
          return res.json({
            success: true,
            data: {
              orderId: existingPayment.paypalOrderId,
              paymentId: existingPayment._id
            }
          });
        } else {
          // Mark as expired if order is no longer valid
          existingPayment.paypalStatus = 'EXPIRED';
          existingPayment.status = 'expired';
          await existingPayment.save();
        }
      } catch (error) {
        // If we can't retrieve the order, mark as expired
        existingPayment.paypalStatus = 'EXPIRED';
        existingPayment.status = 'expired';
        await existingPayment.save();
      }
    }

    // Create PayPal order
    const orderResult = await createOrder(
      tokenPackage.price,
      'USD',
      `${req.user.id}_${game._id}_${packageIndex}_${Date.now()}`
    );

    if (!orderResult.success) {
      return res.status(500).json({
        success: false,
        message: orderResult.error || 'Unable to create payment order. Please try again later.'
      });
    }

    // Create payment record
    const payment = new Payment({
      user: req.user.id,
      game: game._id,
      tokenPackage: {
        tokens: tokenPackage.tokens,
        price: tokenPackage.price
      },
      location: locationData.name,
      paypalOrderId: orderResult.orderId,
      amount: tokenPackage.price,
      paypalStatus: 'CREATED',
      status: 'incomplete',
      metadata: {
        gameName: game.name,
        userFirstname: req.user.firstname,
        userLastname: req.user.lastname,
        userEmail: req.user.email,
        timeRestriction: getTimeRestrictionInfo(locationData.name) ? JSON.stringify(getTimeRestrictionInfo(locationData.name)) : ''
      }
    });

    // Assess payment risk
    assessPaymentRisk(payment, req);

    await payment.save();

    res.json({
      success: true,
      data: {
        orderId: orderResult.orderId,
        paymentId: payment._id
      }
    });

  } catch (error) {
    console.error('Create PayPal order error:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      response: error.response?.data,
      status: error.response?.status
    });
    
    const userMessage = getUserFriendlyError(error);
    res.status(500).json({
      success: false,
      message: userMessage
    });
  }
});

// @route   POST /api/payments/capture-order
// @desc    Capture PayPal order and update status
// @access  Private
router.post('/capture-order', auth, [
  body('orderId')
    .notEmpty()
    .withMessage('Order ID is required')
], async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid order ID.',
        errors: errors.array().map(err => err.msg)
      });
    }

    const { orderId } = req.body;

    // Find payment record
    const payment = await Payment.findOne({
      paypalOrderId: orderId,
      user: req.user.id
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment record not found. Please try again.'
      });
    }

    // Prevent duplicate captures if payment is already succeeded
    if (payment.status === 'succeeded') {
      return res.json({
        success: true,
        data: {
          payment,
          status: payment.paypalStatus
        }
      });
    }

    // Capture the PayPal order
    const captureResult = await captureOrder(orderId);

    if (!captureResult.success) {
      return res.status(500).json({
        success: false,
        message: captureResult.error || 'Unable to process payment. Please try again later.'
      });
    }

    // Update payment status based on PayPal status
    const paypalStatus = captureResult.status;
    const internalStatus = mapPayPalStatus(paypalStatus);

    // Always update if status has changed
    if (payment.paypalStatus !== paypalStatus) {
      payment.paypalStatus = paypalStatus;
      payment.status = internalStatus;
      payment.paypalPayerId = captureResult.payerId;
      payment.paymentMethod = 'paypal';
      
      // Store additional PayPal data
      if (captureResult.capture) {
        payment.metadata.paypalCaptureId = captureResult.capture.id;
        payment.metadata.paypalTransactionId = captureResult.capture.id;
        if (captureResult.capture.seller_receivable_breakdown) {
          payment.metadata.paypalFee = parseFloat(captureResult.capture.seller_receivable_breakdown.paypal_fee?.value || 0);
          payment.metadata.paypalNetAmount = parseFloat(captureResult.capture.seller_receivable_breakdown.net_amount?.value || 0);
        }
      }
      
      await payment.save();
    }

    // If payment succeeded, check time restrictions before adding tokens
    if (internalStatus === 'succeeded' && !payment.tokensAdded) {
      try {
        // Check if payment was made during closing hours (Texas time)
        const timeRestriction = checkTimeRestriction(payment.location);
        if (timeRestriction.shouldDelay && timeRestriction.scheduledTime) {
          // Mark payment for delayed token addition
          payment.tokensScheduledFor = timeRestriction.scheduledTime;
          payment.tokensAdded = false;
          await payment.save();
          console.log(`Tokens scheduled for ${timeRestriction.scheduledTime.toISOString()} for payment ${payment._id}`);
        } else {
          // Add tokens immediately
          await addTokensToBalance(payment);
        }
        // Send email notifications
        await sendEmailNotifications(payment, timeRestriction.shouldDelay, timeRestriction.scheduledTime);
      } catch (error) {
        console.error('Error processing payment:', error);
        // Don't fail the payment confirmation if token processing fails
      }
    }

    // Return appropriate response based on status
    if (internalStatus === 'failed') {
      return res.status(400).json({
        success: false,
        message: 'Payment failed. Please try again or contact support if you were charged.',
        data: {
          payment,
          status: paypalStatus
        }
      });
    }

    res.json({
      success: true,
      data: {
        payment,
        status: paypalStatus
      }
    });

  } catch (error) {
    console.error('Capture PayPal order error:', error);
    const userMessage = getUserFriendlyError(error);
    res.status(500).json({
      success: false,
      message: userMessage
    });
  }
});

// Helper function to add tokens to balance
async function addTokensToBalance(payment) {
  let tokenBalance = await TokenBalance.findOne({
    user: payment.user,
    game: payment.game,
    location: payment.location
  });

  if (!tokenBalance) {
    tokenBalance = new TokenBalance({
      user: payment.user,
      game: payment.game,
      location: payment.location,
      tokens: 0
    });
  }

  tokenBalance.tokens += payment.tokenPackage.tokens;
  await tokenBalance.save();
  
  // Mark payment as tokens added
  payment.tokensAdded = true;
  await payment.save();
  
  console.log(`Added ${payment.tokenPackage.tokens} tokens for payment ${payment._id}`);
}

// Helper function to send email notifications
async function sendEmailNotifications(payment, delayed, scheduledTime) {
  try {
    // Determine admin email by location
    let adminEmail = null;
    if (payment.location.toLowerCase().includes('cedar')) {
      adminEmail = process.env.ADMIN_EMAIL_CEDAR_PARK;
    } else if (payment.location.toLowerCase().includes('liberty')) {
      adminEmail = process.env.ADMIN_EMAIL_LIBERTY_HILL;
    }

    // Compose enhanced email content with branding
    const logoUrl = 'https://www.hccc.online/image.gif';
    const brandColor = '#1e293b';
    const accentColor = '#38a169';
    
    const adminSubject = `🎮 Token Purchase Notification - ${payment.location}`;
    const adminHtml = `
      <div style="font-family: Arial, sans-serif; background: #f9f9f9; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0; max-width: 520px; margin: auto;">
        <div style="text-align: center; margin-bottom: 18px;">
          <img src="${logoUrl}" alt="HCCC Games Logo" style="height: 48px; margin-bottom: 8px;" />
          <h2 style="color: ${brandColor}; margin: 0;">HCCC Games - Token Purchase Alert</h2>
        </div>
        <p><b>User:</b> ${payment.metadata.userFirstname} ${payment.metadata.userLastname} (<a href="mailto:${payment.metadata.userEmail}">${payment.metadata.userEmail}</a>)</p>
        <p><b>Game:</b> ${payment.metadata.gameName}</p>
        <p><b>Tokens Purchased:</b> <span style="color: #3182ce; font-weight: bold;">${payment.tokenPackage.tokens}</span></p>
        <p><b>Amount:</b> <span style="color: ${accentColor};">$${payment.amount}</span></p>
        <p><b>Location:</b> ${payment.location}</p>
        <p><b>Status:</b> <span style="color: ${accentColor};">${payment.status}</span></p>
        <p><b>Payment Method:</b> PayPal</p>
        ${delayed ? `<p><b>Token Addition:</b> <span style="color: #ff6b35; font-weight: bold;">Scheduled for ${scheduledTime.toLocaleString()}</span></p>` : '<p><b>Token Addition:</b> <span style="color: #38a169; font-weight: bold;">Immediate</span></p>'}
        <hr style="margin: 24px 0;"/>
        <p style="font-size: 13px; color: #718096;">This is an automated notification for admins of HCCC Gameroom.</p>
        <div style="text-align: center; margin-top: 24px;">
          <a href="https://www.hccc.online" style="color: ${brandColor}; text-decoration: none; font-weight: bold;">Visit HCCC Games</a>
        </div>
      </div>
    `;
    
    const adminText = `HCCC Games - Token Purchase Alert\n\nUser: ${payment.metadata.userFirstname} ${payment.metadata.userLastname} (${payment.metadata.userEmail})\nGame: ${payment.metadata.gameName}\nTokens: ${payment.tokenPackage.tokens}\nAmount: $${payment.amount}\nLocation: ${payment.location}\nStatus: ${payment.status}\nPayment Method: PayPal\nToken Addition: ${delayed ? `Scheduled for ${scheduledTime.toLocaleString()}` : 'Immediate'}\n\nPayment ID: ${payment._id}\nPayPal Order ID: ${payment.paypalOrderId}`;

    // Send to admin
    if (adminEmail) {
      await sendEmail({
        to: adminEmail,
        subject: adminSubject,
        html: adminHtml,
        text: adminText
      });
    }

    // Enhanced user email with branding
    const userSubject = '🎉 Your HCCC Games Token Purchase Confirmation';
    const userHtml = `
      <div style="font-family: Arial, sans-serif; background: #f9f9f9; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0; max-width: 520px; margin: auto;">
        <div style="text-align: center; margin-bottom: 18px;">
          <img src="${logoUrl}" alt="HCCC Games Logo" style="height: 48px; margin-bottom: 8px;" />
          <h2 style="color: ${brandColor}; margin: 0;">Thank you for your purchase!</h2>
        </div>
        <p>Hi <b>${payment.metadata.userFirstname} ${payment.metadata.userLastname}</b>,</p>
        <p>We're excited to confirm your token purchase for <b>${payment.metadata.gameName}</b> at <b>${payment.location}</b>.</p>
        <ul style="background: #fff; padding: 16px; border-radius: 6px; list-style: none;">
          <li><b>Tokens:</b> <span style="color: #3182ce; font-weight: bold;">${payment.tokenPackage.tokens}</span></li>
          <li><b>Amount:</b> <span style="color: ${accentColor};">$${payment.amount}</span></li>
          <li><b>Location:</b> ${payment.location}</li>
          <li><b>Payment Method:</b> PayPal</li>
        </ul>
        ${delayed ? `<div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin: 20px 0;"><p style="color: #856404; font-weight: bold; margin: 0;">⏰ Token Availability:</p><p style="color: #856404; margin: 5px 0 0 0;">Your tokens will be automatically added to your account on ${scheduledTime.toLocaleDateString()} at ${scheduledTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}.</p></div>` : '<p style="margin-top: 18px;">Your tokens have been added to your account and are ready to use!</p>'}
        <p>If you have any questions, just reply to this email. Enjoy your game!</p>
        <hr style="margin: 24px 0;"/>
        <p style="font-size: 13px; color: #718096;">This is an automated confirmation from HCCC Gameroom.</p>
        <div style="text-align: center; margin-top: 24px;">
          <a href="https://www.hccc.online" style="color: ${brandColor}; text-decoration: none; font-weight: bold;">Visit HCCC Games</a>
        </div>
      </div>
    `;
    
    const userText = `Thank you for your purchase!\n\nHi ${payment.metadata.userFirstname} ${payment.metadata.userLastname},\n\nThank you for purchasing ${payment.tokenPackage.tokens} tokens for ${payment.metadata.gameName} at ${payment.location}.\n\nPurchase Details:\n- Game: ${payment.metadata.gameName}\n- Tokens: ${payment.tokenPackage.tokens}\n- Amount: $${payment.amount}\n- Location: ${payment.location}\n- Payment Method: PayPal\n- Date: ${new Date(payment.createdAt).toLocaleDateString()}\n\n${delayed ? `Token Availability: Your tokens will be automatically added to your account on ${scheduledTime.toLocaleDateString()} at ${scheduledTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}.` : 'Your tokens have been added to your account and are ready to use!'}\n\nIf you have any questions, please contact us.\n\nBest regards,\nHCCC Game Room Team`;

    // Send to user
    await sendEmail({
      to: payment.metadata.userEmail,
      subject: userSubject,
      html: userHtml,
      text: userText
    });
  } catch (error) {
    console.error('Failed to send email notifications:', error);
  }
}

// @route   GET /api/payments/user-payments
// @desc    Get user's payment history
// @access  Private
router.get('/user-payments', auth, async (req, res) => {
  try {
    const payments = await Payment.find({ user: req.user.id })
      .populate('game', 'name image')
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({
      success: true,
      data: { payments: payments.map(p => ({ ...p.toObject(), displayStatus: getDisplayStatus(p.status) })) }
    });

  } catch (error) {
    console.error('Get user payments error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment history'
    });
  }
});

// @route   GET /api/payments/:id
// @desc    Get payment details
// @access  Private
router.get('/:id', auth, async (req, res) => {
  try {
    const payment = await Payment.findOne({
      _id: req.params.id,
      user: req.user.id
    }).populate('game', 'name image');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    res.json({
      success: true,
      data: { payment: { ...payment.toObject(), displayStatus: getDisplayStatus(payment.status) } }
    });

  } catch (error) {
    console.error('Get payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment details'
    });
  }
});

// @route   GET /api/payments/by-order/:orderId
// @desc    Get payment details by PayPal order ID
// @access  Private
router.get('/by-order/:orderId', auth, async (req, res) => {
  try {
    const { orderId } = req.params;

    const payment = await Payment.findOne({
      paypalOrderId: orderId,
      user: req.user.id
    }).populate('game', 'name image');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    // Get latest status from PayPal if payment is still pending
    if (payment.status === 'incomplete' || payment.status === 'processing') {
      try {
        const orderResult = await getOrder(orderId);
        
        if (orderResult.success) {
          // Update payment status if it has changed
          const paypalStatus = orderResult.order.status;
          const dbStatus = getDisplayStatus(paypalStatus);
          
          if (payment.status !== dbStatus) {
            payment.status = dbStatus;
            await payment.save();
          }
        }
      } catch (paypalError) {
        console.error('Error retrieving order from PayPal:', paypalError);
        // Continue with the payment record we have
      }
    }

    res.json({
      success: true,
      data: { payment: { ...payment.toObject(), displayStatus: getDisplayStatus(payment.status) } }
    });

  } catch (error) {
    console.error('Get payment by order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment details'
    });
  }
});

// @route   GET /api/payments/admin/all
// @desc    Get all payments (admin only)
// @access  Private (Admin)
router.get('/admin/all', adminAuth, async (req, res) => {
  try {
    const { limit = 50, page = 1, status } = req.query;

    const filter = {};
    if (status) filter.status = status;

    const payments = await Payment.find(filter)
      .populate('user', 'firstname lastname email')
      .populate('game', 'name image')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Payment.countDocuments(filter);

    res.json({
      success: true,
      data: {
        payments: payments.map(p => ({ ...p.toObject(), displayStatus: getDisplayStatus(p.status) })),
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });

  } catch (error) {
    console.error('Get all payments error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payments'
    });
  }
});

// @route   GET /api/payments/admin/stats
// @desc    Get payment statistics (admin only)
// @access  Private (Admin)
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const totalPayments = await Payment.countDocuments();
    const successfulPayments = await Payment.countDocuments({ status: 'succeeded' });
    const pendingPayments = await Payment.countDocuments({ status: { $in: ['incomplete', 'processing'] } });
    const failedPayments = await Payment.countDocuments({ status: { $in: ['failed', 'canceled', 'expired'] } });

    // Calculate total revenue
    const revenueResult = await Payment.aggregate([
      { $match: { status: 'succeeded' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const totalRevenue = revenueResult.length > 0 ? revenueResult[0].total : 0;

    // Get payments in last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentPayments = await Payment.countDocuments({
      createdAt: { $gte: thirtyDaysAgo },
      status: 'succeeded'
    });

    res.json({
      success: true,
      data: {
        totalPayments,
        successfulPayments,
        pendingPayments,
        failedPayments,
        totalRevenue,
        recentPayments
      }
    });

  } catch (error) {
    console.error('Get payment stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment statistics'
    });
  }
});

// @route   GET /api/payments/debug-config
// @desc    Debug PayPal configuration (admin only)
// @access  Private (Admin)
router.get('/debug-config', adminAuth, async (req, res) => {
  try {
    const config = {
      environment: process.env.NODE_ENV,
      paypalBaseUrl: process.env.NODE_ENV === 'production' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
      hasClientId: !!process.env.PAYPAL_CLIENT_ID,
      hasClientSecret: !!process.env.PAYPAL_CLIENT_SECRET,
      hasWebhookId: !!process.env.PAYPAL_WEBHOOK_ID,
      frontendUrl: process.env.FRONTEND_URL,
      clientIdLength: process.env.PAYPAL_CLIENT_ID ? process.env.PAYPAL_CLIENT_ID.length : 0,
      clientSecretLength: process.env.PAYPAL_CLIENT_SECRET ? process.env.PAYPAL_CLIENT_SECRET.length : 0
    };

    // Test PayPal connection
    try {
      const { getAccessToken } = require('../services/paypalService');
      const token = await getAccessToken();
      config.paypalConnection = 'success';
      config.tokenLength = token ? token.length : 0;
    } catch (error) {
      config.paypalConnection = 'failed';
      config.paypalError = error.message;
    }

    res.json({
      success: true,
      data: config
    });

  } catch (error) {
    console.error('Debug config error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get debug configuration'
    });
  }
});

// @route   POST /api/payments/webhook
// @desc    Handle PayPal webhook events
// @access  Public (PayPal signature verification)
router.post('/webhook', async (req, res) => {
  try {
    const event = req.body;
    
    // Validate webhook event
    if (!validateWebhookEvent(event)) {
      console.error(`Invalid webhook event type: ${event.event_type}`);
      return res.status(400).json({ error: 'Invalid event type' });
    }

    // Verify webhook signature in production
    if (process.env.NODE_ENV === 'production') {
      const webhookId = process.env.PAYPAL_WEBHOOK_ID;
      if (!verifyWebhookSignature(req.headers, req.body, webhookId)) {
        console.error('Webhook signature verification failed');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    console.log(`Processing PayPal webhook event: ${event.event_type}`, {
      eventId: event.id,
      resourceType: event.resource_type,
      resourceId: event.resource?.id
    });

    // Process the webhook event
    switch (event.event_type) {
      case 'PAYMENT.CAPTURE.COMPLETED':
        await handlePaymentCompleted(event.resource);
        break;

      case 'PAYMENT.CAPTURE.DENIED':
        await handlePaymentDenied(event.resource);
        break;

      case 'PAYMENT.CAPTURE.PENDING':
        await handlePaymentPending(event.resource);
        break;

      case 'PAYMENT.CAPTURE.REFUNDED':
        await handlePaymentRefunded(event.resource);
        break;

      case 'PAYMENT.CAPTURE.VOIDED':
        await handlePaymentVoided(event.resource);
        break;

      case 'PAYMENT.CAPTURE.FAILED':
        await handlePaymentFailed(event.resource);
        break;

      case 'CHECKOUT.ORDER.APPROVED':
        await handleOrderApproved(event.resource);
        break;

      case 'CHECKOUT.ORDER.CANCELED':
        await handleOrderCanceled(event.resource);
        break;

      case 'CHECKOUT.ORDER.COMPLETED':
        await handleOrderCompleted(event.resource);
        break;

      case 'CHECKOUT.ORDER.PROCESSED':
        await handleOrderProcessed(event.resource);
        break;

      default:
        console.log(`Unhandled PayPal event type: ${event.event_type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('PayPal webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Helper function to handle completed payments
async function handlePaymentCompleted(capture) {
  console.log(`Processing completed payment: ${capture.id}`);
  
  const payment = await Payment.findOne({
    paypalOrderId: capture.custom_id?.split('_')[0] || capture.id
  });

  if (!payment) {
    console.error(`Payment record not found for completed payment: ${capture.id}`);
    return;
  }

  if (payment.paypalStatus === 'CAPTURE_COMPLETED') {
    console.log(`Payment ${payment._id} already marked as completed`);
    return;
  }

  // Update payment status
  payment.paypalStatus = 'CAPTURE_COMPLETED';
  payment.status = 'succeeded';
  payment.paypalPayerId = capture.payer_id;
  payment.paymentMethod = 'paypal';
  
  // Store additional PayPal data
  payment.metadata.paypalCaptureId = capture.id;
  payment.metadata.paypalTransactionId = capture.id;
  if (capture.seller_receivable_breakdown) {
    payment.metadata.paypalFee = parseFloat(capture.seller_receivable_breakdown.paypal_fee?.value || 0);
    payment.metadata.paypalNetAmount = parseFloat(capture.seller_receivable_breakdown.net_amount?.value || 0);
  }
  
  await payment.save();

  console.log(`Payment ${payment._id} marked as succeeded`);

  // Process tokens
  try {
    const timeRestriction = checkTimeRestriction(payment.location);
    
    if (timeRestriction.shouldDelay && timeRestriction.scheduledTime) {
      // Mark payment for delayed token addition
      payment.tokensScheduledFor = timeRestriction.scheduledTime;
      payment.tokensAdded = false;
      await payment.save();
      
      console.log(`Webhook: Tokens scheduled for ${timeRestriction.scheduledTime.toISOString()} for payment ${payment._id}`);
    } else {
      // Add tokens immediately
      await addTokensToBalance(payment);
    }

    // Send email notifications
    await sendEmailNotifications(payment, timeRestriction.shouldDelay, timeRestriction.scheduledTime);
  } catch (error) {
    console.error('Error processing completed payment:', error);
  }
}

// Helper function to handle denied payments
async function handlePaymentDenied(capture) {
  console.log(`Processing denied payment: ${capture.id}`);
  
  const payment = await Payment.findOne({
    paypalOrderId: capture.custom_id?.split('_')[0] || capture.id
  });

  if (!payment) {
    console.error(`Payment record not found for denied payment: ${capture.id}`);
    return;
  }

  payment.paypalStatus = 'CAPTURE_DENIED';
  payment.status = 'failed';
  payment.metadata = {
    ...payment.metadata,
    failureReason: capture.status_details?.reason || 'Payment denied',
    failedAt: new Date().toISOString(),
    errorCode: capture.status_details?.reason || 'DENIED'
  };
  await payment.save();

  console.log(`Payment ${payment._id} marked as failed: Payment denied`);
}

// Helper function to handle pending payments
async function handlePaymentPending(capture) {
  console.log(`Processing pending payment: ${capture.id}`);
  
  const payment = await Payment.findOne({
    paypalOrderId: capture.custom_id?.split('_')[0] || capture.id
  });

  if (!payment) {
    console.error(`Payment record not found for pending payment: ${capture.id}`);
    return;
  }

  payment.paypalStatus = 'CAPTURE_PENDING';
  payment.status = 'processing';
  await payment.save();

  console.log(`Payment ${payment._id} marked as processing`);
}

// Helper function to handle refunded payments
async function handlePaymentRefunded(capture) {
  console.log(`Processing refunded payment: ${capture.id}`);
  
  const payment = await Payment.findOne({
    paypalOrderId: capture.custom_id?.split('_')[0] || capture.id
  });

  if (!payment) {
    console.error(`Payment record not found for refunded payment: ${capture.id}`);
    return;
  }

  payment.paypalStatus = 'CAPTURE_REFUNDED';
  payment.status = 'refunded';
  payment.metadata = {
    ...payment.metadata,
    refundedAt: new Date().toISOString(),
    refundAmount: capture.amount?.value
  };
  await payment.save();

  console.log(`Payment ${payment._id} marked as refunded`);
}

// Helper function to handle approved orders
async function handleOrderApproved(order) {
  console.log(`Processing approved order: ${order.id}`);
  
  const payment = await Payment.findOne({
    paypalOrderId: order.id
  });

  if (!payment) {
    console.error(`Payment record not found for approved order: ${order.id}`);
    return;
  }

  payment.status = 'processing';
  await payment.save();

  console.log(`Payment ${payment._id} marked as processing (order approved)`);
}

// Helper function to handle canceled orders
async function handleOrderCanceled(order) {
  console.log(`Processing canceled order: ${order.id}`);
  
  const payment = await Payment.findOne({
    paypalOrderId: order.id
  });

  if (!payment) {
    console.error(`Payment record not found for canceled order: ${order.id}`);
    return;
  }

  payment.paypalStatus = 'VOIDED';
  payment.status = 'canceled';
  payment.metadata = {
    ...payment.metadata,
    canceledAt: new Date().toISOString(),
    cancellationReason: 'user_canceled'
  };
  await payment.save();

  console.log(`Payment ${payment._id} marked as canceled`);
}

// Helper function to handle voided payments
async function handlePaymentVoided(capture) {
  console.log(`Processing voided payment: ${capture.id}`);
  
  const payment = await Payment.findOne({
    paypalOrderId: capture.custom_id?.split('_')[0] || capture.id
  });

  if (!payment) {
    console.error(`Payment record not found for voided payment: ${capture.id}`);
    return;
  }

  payment.paypalStatus = 'CAPTURE_VOIDED';
  payment.status = 'canceled';
  payment.metadata = {
    ...payment.metadata,
    canceledAt: new Date().toISOString(),
    cancellationReason: 'payment_voided'
  };
  await payment.save();

  console.log(`Payment ${payment._id} marked as voided`);
}

// Helper function to handle failed payments
async function handlePaymentFailed(capture) {
  console.log(`Processing failed payment: ${capture.id}`);
  
  const payment = await Payment.findOne({
    paypalOrderId: capture.custom_id?.split('_')[0] || capture.id
  });

  if (!payment) {
    console.error(`Payment record not found for failed payment: ${capture.id}`);
    return;
  }

  payment.paypalStatus = 'CAPTURE_FAILED';
  payment.status = 'failed';
  payment.metadata = {
    ...payment.metadata,
    failureReason: capture.status_details?.reason || 'Payment failed',
    failedAt: new Date().toISOString(),
    errorCode: capture.status_details?.reason || 'FAILED'
  };
  await payment.save();

  console.log(`Payment ${payment._id} marked as failed`);
}

// Helper function to handle completed orders
async function handleOrderCompleted(order) {
  console.log(`Processing completed order: ${order.id}`);
  
  const payment = await Payment.findOne({
    paypalOrderId: order.id
  });

  if (!payment) {
    console.error(`Payment record not found for completed order: ${order.id}`);
    return;
  }

  payment.paypalStatus = 'COMPLETED';
  payment.status = 'succeeded';
  await payment.save();

  console.log(`Payment ${payment._id} marked as completed`);
}

// Helper function to handle processed orders
async function handleOrderProcessed(order) {
  console.log(`Processing processed order: ${order.id}`);
  
  const payment = await Payment.findOne({
    paypalOrderId: order.id
  });

  if (!payment) {
    console.error(`Payment record not found for processed order: ${order.id}`);
    return;
  }

  payment.paypalStatus = 'APPROVED';
  payment.status = 'processing';
  await payment.save();

  console.log(`Payment ${payment._id} marked as processed`);
}

module.exports = router; 