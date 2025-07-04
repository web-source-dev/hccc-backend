const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { body, validationResult } = require('express-validator');
const Payment = require('../models/Payment');
const Game = require('../models/Game');
const TokenBalance = require('../models/TokenBalance');
const { auth, adminAuth } = require('../middleware/auth');

const router = express.Router();

// @route   POST /api/payments/create-payment-intent
// @desc    Create a payment intent for token purchase
// @access  Private
router.post('/create-payment-intent', auth, [
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

    // Check if game is active
    if (game.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'Game is not available for purchase'
      });
    }

    // Get the token package
    const tokenPackage = game.tokenPackages[packageIndex];
    if (!tokenPackage) {
      return res.status(400).json({
        success: false,
        message: 'Invalid token package'
      });
    }

    // Check if location is available
    const locationData = game.locations.find(loc => 
      loc.name.toLowerCase().replace(/\s+/g, '-') === location.toLowerCase().replace(/\s+/g, '-')
    );
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
      'tokenPackage.tokens': game.tokenPackages[packageIndex].tokens,
      'tokenPackage.price': game.tokenPackages[packageIndex].price,
      location: locationData.name,
      status: { $in: ['pending', 'processing'] },
      createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) } // Within last 30 minutes
    });

    if (existingPayment) {
      // Check if the existing payment intent is still valid
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(existingPayment.stripePaymentIntentId);
        
        if (paymentIntent.status === 'requires_payment_method') {
          // Return existing payment intent if it's still valid
          return res.json({
            success: true,
            data: {
              clientSecret: existingPayment.stripeClientSecret,
              paymentId: existingPayment._id
            }
          });
        } else {
          // Mark as expired if payment intent is no longer valid
          existingPayment.status = 'expired';
          await existingPayment.save();
        }
      } catch (error) {
        // If we can't retrieve the payment intent, mark as expired
        existingPayment.status = 'expired';
        await existingPayment.save();
      }
    }

    // Calculate amount in cents
    const amount = Math.round(tokenPackage.price * 100);

    // Create payment intent with Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      metadata: {
        gameId: game._id.toString(),
        gameName: game.name,
        userId: req.user.id,
        userName: req.user.username,
        userEmail: req.user.email,
        tokens: tokenPackage.tokens.toString(),
        location: locationData.name,
        packageIndex: packageIndex.toString()
      }
    });

    // Create payment record
    const payment = new Payment({
      user: req.user.id,
      game: game._id,
      tokenPackage: {
        tokens: tokenPackage.tokens,
        price: tokenPackage.price
      },
      location: locationData.name,
      stripePaymentIntentId: paymentIntent.id,
      stripeClientSecret: paymentIntent.client_secret,
      amount: tokenPackage.price,
      metadata: {
        gameName: game.name,
        userName: req.user.username,
        userEmail: req.user.email
      }
    });

    await payment.save();

    res.json({
      success: true,
      data: {
        clientSecret: paymentIntent.client_secret,
        paymentId: payment._id
      }
    });

  } catch (error) {
    console.error('Create payment intent error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create payment intent'
    });
  }
});

// @route   POST /api/payments/confirm-payment
// @desc    Confirm payment and update status
// @access  Private
router.post('/confirm-payment', auth, [
  body('paymentIntentId')
    .notEmpty()
    .withMessage('Payment intent ID is required')
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

    const { paymentIntentId } = req.body;

    // Retrieve payment intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (!paymentIntent) {
      return res.status(404).json({
        success: false,
        message: 'Payment intent not found'
      });
    }

    // Find payment record
    const payment = await Payment.findOne({ 
      stripePaymentIntentId: paymentIntentId,
      user: req.user.id 
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment record not found'
      });
    }

    // Prevent duplicate confirmations if payment is already succeeded
    if (payment.status === 'succeeded') {
      return res.json({
        success: true,
        data: {
          payment,
          status: 'succeeded'
        }
      });
    }

    // Update payment status based on Stripe status
    let status = 'pending';
    if (paymentIntent.status === 'succeeded') {
      status = 'succeeded';
    } else if (paymentIntent.status === 'processing') {
      status = 'processing';
    } else if (paymentIntent.status === 'canceled') {
      status = 'canceled';
    } else if (paymentIntent.status === 'requires_payment_method') {
      status = 'failed';
    }

    // Only update if status has changed
    if (payment.status !== status) {
      payment.status = status;
      payment.paymentMethod = paymentIntent.payment_method_types[0];
      payment.receiptUrl = paymentIntent.charges?.data[0]?.receipt_url;

      await payment.save();

      // If payment succeeded, update token balance
      if (status === 'succeeded') {
        try {
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
        } catch (error) {
          console.error('Error updating token balance:', error);
          // Don't fail the payment confirmation if token balance update fails
        }
      }
    }

    res.json({
      success: true,
      data: {
        payment,
        status: paymentIntent.status
      }
    });

  } catch (error) {
    console.error('Confirm payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to confirm payment'
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
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({
      success: true,
      data: { payments }
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
      data: { payment }
    });

  } catch (error) {
    console.error('Get payment error:', error);
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
      .populate('user', 'username email')
      .populate('game', 'name image')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));
    
    const total = await Payment.countDocuments(filter);
    
    res.json({
      success: true,
      data: {
        payments,
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
    const pendingPayments = await Payment.countDocuments({ status: 'pending' });
    const failedPayments = await Payment.countDocuments({ status: 'failed' });
    
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

// @route   POST /api/payments/webhook
// @desc    Handle Stripe webhook events
// @access  Public (Stripe signature verification)
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        
        // Find and update payment record
        const payment = await Payment.findOne({ 
          stripePaymentIntentId: paymentIntent.id 
        });

        if (payment && payment.status !== 'succeeded') {
          payment.status = 'succeeded';
          payment.paymentMethod = paymentIntent.payment_method_types[0];
          payment.receiptUrl = paymentIntent.charges?.data[0]?.receipt_url;
          await payment.save();

          // Update token balance
          try {
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
          } catch (error) {
            console.error('Error updating token balance via webhook:', error);
          }
        }
        break;

      case 'payment_intent.payment_failed':
        const failedPaymentIntent = event.data.object;
        
        // Find and update payment record
        const failedPayment = await Payment.findOne({ 
          stripePaymentIntentId: failedPaymentIntent.id 
        });

        if (failedPayment && failedPayment.status !== 'failed') {
          failedPayment.status = 'failed';
          await failedPayment.save();
        }
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router; 