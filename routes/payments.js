const express = require('express');
const { body, validationResult } = require('express-validator');
const Payment = require('../models/Payment');
const Game = require('../models/Game');
const TokenBalance = require('../models/TokenBalance');
const { auth, adminAuth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { getTimeRestrictionInfo, checkTimeRestriction } = require('../utils/timeRestrictions');
const { client } = require('../config/paypal');

const router = express.Router();

// Helper function to map PayPal status to display status
function getDisplayStatus(paypalStatus) {
  switch (paypalStatus) {
    case 'CREATED':
      return 'pending';
    case 'SAVED':
      return 'pending';
    case 'APPROVED':
      return 'processing';
    case 'VOIDED':
      return 'canceled';
    case 'COMPLETED':
      return 'succeeded';
    case 'PAYER_ACTION_REQUIRED':
      return 'pending';
    default:
      return 'pending';
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
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { gameId, packageIndex, location } = req.body;

    // Get the game
    const game = await Game.findById(gameId);
    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    // Check if package index is valid
    if (packageIndex >= game.tokenPackages.length) {
      return res.status(400).json({
        success: false,
        message: 'Invalid package index'
      });
    }

    const tokenPackage = game.tokenPackages[packageIndex];

    // Find location data
    const locationData = game.locations.find(loc => loc.name === location);
    if (!locationData || !locationData.available) {
      return res.status(400).json({
        success: false,
        message: 'Location is not available'
      });
    }

    // Check for existing pending payment for the same user, game, and package
    const existingPayment = await Payment.findOne({
      user: req.user.id,
      game: game._id,
      'tokenPackage.tokens': tokenPackage.tokens,
      'tokenPackage.price': tokenPackage.price,
      location: locationData.name,
      status: { $in: ['CREATED', 'SAVED', 'APPROVED', 'PAYER_ACTION_REQUIRED'] },
      createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) } // Within last 30 minutes
    });

    if (existingPayment) {
      // Return existing order if it's still valid
      return res.json({
        success: true,
        data: {
          orderId: existingPayment.paypalOrderId,
          paymentId: existingPayment._id
        }
      });
    }

    // Check if payment is made during closing hours (Texas time)
    const timeRestriction = getTimeRestrictionInfo(locationData.name);

    // Create PayPal order
    const request = new client().orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: 'USD',
          value: tokenPackage.price.toString()
        },
        description: `${tokenPackage.tokens} tokens for ${game.name} at ${locationData.name}`,
        custom_id: `${req.user.id}_${game._id}_${packageIndex}_${locationData.name}`,
        invoice_id: `INV-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      }],
      application_context: {
        return_url: `${process.env.FRONTEND_URL}/payment-success`,
        cancel_url: `${process.env.FRONTEND_URL}/tokens/${game._id}`,
        brand_name: 'HCCC Game Room',
        landing_page: 'LOGIN',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING'
      }
    });

    const order = await client().execute(request);

    // Create payment record
    const payment = new Payment({
      user: req.user.id,
      game: game._id,
      tokenPackage: {
        tokens: tokenPackage.tokens,
        price: tokenPackage.price
      },
      location: locationData.name,
      paypalOrderId: order.result.id,
      amount: tokenPackage.price,
      metadata: {
        gameName: game.name,
        userFirstname: req.user.firstname,
        userLastname: req.user.lastname,
        userEmail: req.user.email,
        timeRestriction: timeRestriction ? JSON.stringify(timeRestriction) : '',
        paypalIntent: 'CAPTURE'
      }
    });

    await payment.save();

    res.json({
      success: true,
      data: {
        orderId: order.result.id,
        paymentId: payment._id
      }
    });

  } catch (error) {
    console.error('Create PayPal order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create PayPal order'
    });
  }
});

// @route   POST /api/payments/capture-order
// @desc    Capture PayPal order and complete payment
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
        message: 'Validation failed',
        errors: errors.array()
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
        message: 'Payment record not found'
      });
    }

    // Prevent duplicate captures if payment is already completed
    if (payment.status === 'COMPLETED') {
      return res.json({
        success: true,
        data: {
          payment,
          status: 'COMPLETED'
        }
      });
    }

    // Capture the PayPal order
    const request = new client().orders.OrdersCaptureRequest(orderId);
    request.requestBody({});

    const capture = await client().execute(request);

    // Update payment status based on PayPal response
    const status = capture.result.status;
    payment.status = status;
    payment.paypalPaymentId = capture.result.purchase_units[0].payments.captures[0].id;
    payment.receiptUrl = capture.result.purchase_units[0].payments.captures[0].links.find(link => link.rel === 'self')?.href;

    // Add capture details to metadata
    payment.metadata = {
      ...payment.metadata,
      paypalCaptureId: payment.paypalPaymentId
    };

    await payment.save();

    // If payment succeeded, check time restrictions before adding tokens
    if (status === 'COMPLETED' && !payment.tokensAdded) {
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

    res.json({
      success: true,
      data: {
        payment,
        status: status
      }
    });

  } catch (error) {
    console.error('Capture PayPal order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to capture PayPal order'
    });
  }
});

// @route   POST /api/payments/check-status
// @desc    Check PayPal order status
// @access  Private
router.post('/check-status', auth, [
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
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { orderId } = req.body;

    // Find payment record
    const payment = await Payment.findOne({
      paypalOrderId: orderId,
      user: req.user.id
    }).populate('game', 'name image');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment record not found'
      });
    }

    // Get latest status from PayPal
    const request = new client().orders.OrdersGetRequest(orderId);
    const order = await client().execute(request);
    
    const status = order.result.status;

    // Update payment status if it has changed
    if (payment.status !== status) {
      payment.status = status;
      await payment.save();
    }

    // Process successful payments
    if (status === 'COMPLETED' && !payment.tokensAdded) {
      try {
        const timeRestriction = checkTimeRestriction(payment.location);
        if (timeRestriction.shouldDelay && timeRestriction.scheduledTime) {
          payment.tokensScheduledFor = timeRestriction.scheduledTime;
          payment.tokensAdded = false;
          await payment.save();
        } else {
          await addTokensToBalance(payment);
        }
        await sendEmailNotifications(payment, timeRestriction.shouldDelay, timeRestriction.scheduledTime);
      } catch (error) {
        console.error('Error processing successful payment:', error);
      }
    }

    res.json({
      success: true,
      data: {
        payment,
        status: status
      }
    });

  } catch (error) {
    console.error('Check PayPal order status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check PayPal order status'
    });
  }
});

// @route   GET /api/payments/user-payments
// @desc    Get user's payment history
// @access  Private
router.get('/user-payments', auth, async (req, res) => {
  try {
    const payments = await Payment.find({ user: req.user.id })
      .populate('game', 'name image')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: {
        payments: payments.map(payment => ({
          ...payment.toObject(),
          displayStatus: getDisplayStatus(payment.status)
        }))
      }
    });
  } catch (error) {
    console.error('Get user payments error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment history'
    });
  }
});

// @route   GET /api/payments/:paymentId
// @desc    Get payment details by ID
// @access  Private
router.get('/:paymentId', auth, async (req, res) => {
  try {
    const payment = await Payment.findOne({
      _id: req.params.paymentId,
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
    if (payment.status === 'CREATED' || payment.status === 'SAVED' || payment.status === 'APPROVED') {
      try {
        const request = new client().orders.OrdersGetRequest(orderId);
        const order = await client().execute(request);
        
        const status = order.result.status;
        if (payment.status !== status) {
          payment.status = status;
          await payment.save();
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
      .populate('game', 'name')
      .populate('user', 'firstname lastname email')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));
    
    const total = await Payment.countDocuments(filter);
    
    res.json({
      success: true,
      data: {
        payments: payments.map(payment => ({
          ...payment.toObject(),
          displayStatus: getDisplayStatus(payment.status)
        })),
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
      message: 'Server error while fetching payments'
    });
  }
});

// @route   GET /api/payments/admin/stats
// @desc    Get payment statistics (admin only)
// @access  Private (Admin)
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const totalPayments = await Payment.countDocuments();
    const successfulPayments = await Payment.countDocuments({ status: 'COMPLETED' });
    const pendingPayments = await Payment.countDocuments({ 
      status: { $in: ['CREATED', 'SAVED', 'APPROVED', 'PAYER_ACTION_REQUIRED'] } 
    });
    const failedPayments = await Payment.countDocuments({ status: 'VOIDED' });
    
    // Calculate total revenue
    const completedPayments = await Payment.find({ status: 'COMPLETED' });
    const totalRevenue = completedPayments.reduce((sum, payment) => sum + payment.amount, 0);
    
    // Get recent payments (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentPayments = await Payment.countDocuments({ 
      createdAt: { $gte: thirtyDaysAgo } 
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
      message: 'Server error while fetching payment statistics'
    });
  }
});

// @route   POST /api/payments/webhook
// @desc    Handle PayPal webhook events
// @access  Public (PayPal signature verification)
router.post('/webhook', async (req, res) => {
  try {
    const event = req.body;
    console.log(`Processing PayPal webhook event: ${event.event_type}`);

    switch (event.event_type) {
      case 'PAYMENT.CAPTURE.COMPLETED':
        await handlePaymentCompleted(event.resource);
        break;

      case 'PAYMENT.CAPTURE.DENIED':
        await handlePaymentDenied(event.resource);
        break;

      case 'PAYMENT.CAPTURE.REFUNDED':
        await handlePaymentRefunded(event.resource);
        break;

      case 'CHECKOUT.ORDER.APPROVED':
        await handleOrderApproved(event.resource);
        break;

      case 'CHECKOUT.ORDER.CANCELED':
        await handleOrderCanceled(event.resource);
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

  console.log(`Added ${payment.tokenPackage.tokens} tokens to user ${payment.user} for game ${payment.game} at ${payment.location}`);
}

// Helper function to send email notifications
async function sendEmailNotifications(payment, delayed, scheduledTime) {
  try {
    const subject = delayed 
      ? `Token Purchase Scheduled - ${payment.metadata.gameName}`
      : `Token Purchase Confirmed - ${payment.metadata.gameName}`;

    const message = delayed
      ? `Your purchase of ${payment.tokenPackage.tokens} tokens for ${payment.metadata.gameName} has been scheduled for ${scheduledTime.toLocaleString()}. You will receive your tokens at that time.`
      : `Your purchase of ${payment.tokenPackage.tokens} tokens for ${payment.metadata.gameName} has been confirmed. Your tokens have been added to your account.`;

    await sendEmail(payment.metadata.userEmail, subject, message);
  } catch (error) {
    console.error('Error sending email notification:', error);
  }
}

// Helper function to handle completed payments
async function handlePaymentCompleted(capture) {
  console.log(`Processing completed payment: ${capture.id}`);
  
  const payment = await Payment.findOne({
    paypalPaymentId: capture.id
  });

  if (!payment) {
    console.error(`Payment record not found for completed payment: ${capture.id}`);
    return;
  }

  if (payment.status === 'COMPLETED') {
    console.log(`Payment ${payment._id} already marked as completed`);
    return;
  }

  // Update payment status
  payment.status = 'COMPLETED';
  payment.receiptUrl = capture.links.find(link => link.rel === 'self')?.href;
  await payment.save();

  console.log(`Payment ${payment._id} marked as completed`);

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
    paypalPaymentId: capture.id
  });

  if (!payment) {
    console.error(`Payment record not found for denied payment: ${capture.id}`);
    return;
  }

  // Update payment status
  payment.status = 'VOIDED';
  payment.metadata = {
    ...payment.metadata,
    failureReason: 'Payment was denied by PayPal',
    errorCode: 'PAYMENT_DENIED',
    failedAt: new Date().toISOString()
  };
  await payment.save();

  console.log(`Payment ${payment._id} marked as denied`);
}

// Helper function to handle refunded payments
async function handlePaymentRefunded(capture) {
  console.log(`Processing refunded payment: ${capture.id}`);
  
  const payment = await Payment.findOne({
    paypalPaymentId: capture.id
  });

  if (!payment) {
    console.error(`Payment record not found for refunded payment: ${capture.id}`);
    return;
  }

  // Update payment status
  payment.status = 'VOIDED';
  payment.metadata = {
    ...payment.metadata,
    refundedAt: new Date().toISOString(),
    refundReason: 'Payment was refunded'
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

  payment.status = 'APPROVED';
  await payment.save();

  console.log(`Order ${payment._id} marked as approved`);
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

  payment.status = 'VOIDED';
  payment.metadata = {
    ...payment.metadata,
    canceledAt: new Date().toISOString(),
    cancellationReason: 'Order was canceled'
  };
  await payment.save();

  console.log(`Order ${payment._id} marked as canceled`);
}

module.exports = router; 