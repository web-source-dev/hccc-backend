const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { body, validationResult } = require('express-validator');
const Payment = require('../models/Payment');
const Game = require('../models/Game');
const TokenBalance = require('../models/TokenBalance');
const { auth, adminAuth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { getTimeRestrictionInfo, checkTimeRestriction } = require('../utils/timeRestrictions');

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

    // Check if payment is made during closing hours (Texas time)
    const timeRestriction = getTimeRestrictionInfo(locationData.name);

    // Create payment intent with Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      payment_method_types: ['card'],
      receipt_email: req.user.email, // <-- Add this
      metadata: {
        gameId: game._id.toString(),
        gameName: game.name,
        userFirstname: req.user.firstname,
        userLastname: req.user.lastname,
        userEmail: req.user.email,
        packageIndex: packageIndex.toString(),
        location,
        tokens: tokenPackage.tokens.toString(),
        price: tokenPackage.price.toString(),
        timeRestriction: timeRestriction ? JSON.stringify(timeRestriction) : ''
      },
      payment_method_options: {
        card: {
          billing_details: {
            name: `${req.user.firstname} ${req.user.lastname}`,
            email: req.user.email
          }
        }
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
        userFirstname: req.user.firstname,
        userLastname: req.user.lastname,
        userEmail: req.user.email,
        timeRestriction: timeRestriction ? JSON.stringify(timeRestriction) : ''
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

    // Get detailed error information for failed payments
    let errorDetails = null;
    if (paymentIntent.status === 'requires_payment_method' && paymentIntent.last_payment_error) {
      errorDetails = {
        code: paymentIntent.last_payment_error.code,
        message: paymentIntent.last_payment_error.message,
        decline_code: paymentIntent.last_payment_error.decline_code,
        type: paymentIntent.last_payment_error.type
      };
    }

    // Update payment status based on Stripe status
    const status = mapStripeStatusToDbStatus(paymentIntent.status);

    // Always update if status has changed
    if (payment.status !== status) {
      payment.status = status;
      payment.paymentMethod = paymentIntent.payment_method_types[0];
      payment.receiptUrl = paymentIntent.charges?.data[0]?.receipt_url;
      
      // Add error details to metadata if payment failed
      if (status === 'failed' && errorDetails) {
        payment.metadata = {
          ...payment.metadata,
          failureReason: errorDetails.message,
          errorCode: errorDetails.code,
          declineCode: errorDetails.decline_code,
          errorType: errorDetails.type,
          failedAt: new Date().toISOString()
        };
      }
      
      await payment.save();
    }

    // If payment succeeded, check time restrictions before adding tokens
    if (status === 'succeeded' && !payment.tokensAdded) {
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
    if (status === 'failed') {
      return res.status(400).json({
        success: false,
        message: errorDetails?.message || 'Payment failed',
        data: {
          payment,
          status: paymentIntent.status,
          error: errorDetails
        }
      });
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

// Helper function to map Stripe status to database status
function mapStripeStatusToDbStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'succeeded':
      return 'succeeded';
    case 'processing':
      return 'processing';
    case 'canceled':
      return 'canceled';
    case 'requires_payment_method':
      return 'failed';
    case 'requires_action':
      return 'pending';
    case 'requires_confirmation':
      return 'pending';
    case 'requires_capture':
      return 'pending';
    case 'expired':
      return 'expired';
    default:
      return 'pending';
  }
}

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
        ${delayed ? `<p><b>Token Addition:</b> <span style="color: #ff6b35; font-weight: bold;">Scheduled for ${scheduledTime.toLocaleString()}</span></p>` : '<p><b>Token Addition:</b> <span style="color: #38a169; font-weight: bold;">Immediate</span></p>'}
        <hr style="margin: 24px 0;"/>
        <p style="font-size: 13px; color: #718096;">This is an automated notification for admins of HCCC Gameroom.</p>
        <div style="text-align: center; margin-top: 24px;">
          <a href="https://www.hccc.online" style="color: ${brandColor}; text-decoration: none; font-weight: bold;">Visit HCCC Games</a>
        </div>
      </div>
    `;
    
    const adminText = `HCCC Games - Token Purchase Alert\n\nUser: ${payment.metadata.userFirstname} ${payment.metadata.userLastname} (${payment.metadata.userEmail})\nGame: ${payment.metadata.gameName}\nTokens: ${payment.tokenPackage.tokens}\nAmount: $${payment.amount}\nLocation: ${payment.location}\nStatus: ${payment.status}\nToken Addition: ${delayed ? `Scheduled for ${scheduledTime.toLocaleString()}` : 'Immediate'}\n\nPayment ID: ${payment._id}\nStripe ID: ${payment.stripePaymentIntentId}`;

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
    
    const userText = `Thank you for your purchase!\n\nHi ${payment.metadata.userFirstname} ${payment.metadata.userLastname},\n\nThank you for purchasing ${payment.tokenPackage.tokens} tokens for ${payment.metadata.gameName} at ${payment.location}.\n\nPurchase Details:\n- Game: ${payment.metadata.gameName}\n- Tokens: ${payment.tokenPackage.tokens}\n- Amount: $${payment.amount}\n- Location: ${payment.location}\n- Date: ${new Date(payment.createdAt).toLocaleDateString()}\n\n${delayed ? `Token Availability: Your tokens will be automatically added to your account on ${scheduledTime.toLocaleDateString()} at ${scheduledTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}.` : 'Your tokens have been added to your account and are ready to use!'}\n\nIf you have any questions, please contact us.\n\nBest regards,\nHCCC Game Room Team`;

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

// @route   GET /api/payments/by-intent/:paymentIntentId
// @desc    Get payment details by Stripe payment intent ID
// @access  Private
router.get('/by-intent/:paymentIntentId', auth, async (req, res) => {
  try {
    const { paymentIntentId } = req.params;

    const payment = await Payment.findOne({
      stripePaymentIntentId: paymentIntentId,
      user: req.user.id
    }).populate('game', 'name image');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    // Get latest status from Stripe if payment is still pending
    if (payment.status === 'pending' || payment.status === 'processing') {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        
        // Update payment status if it has changed
        const dbStatus = mapStripeStatusToDbStatus(paymentIntent.status);
        if (payment.status !== dbStatus) {
          payment.status = dbStatus;
          
          // Add error details if payment failed
          if (dbStatus === 'failed' && paymentIntent.last_payment_error) {
            payment.metadata = {
              ...payment.metadata,
              failureReason: paymentIntent.last_payment_error.message,
              errorCode: paymentIntent.last_payment_error.code,
              declineCode: paymentIntent.last_payment_error.decline_code,
              errorType: paymentIntent.last_payment_error.type,
              failedAt: new Date().toISOString()
            };
          }
          
          await payment.save();
        }
      } catch (stripeError) {
        console.error('Error retrieving payment intent from Stripe:', stripeError);
        // Continue with the payment record we have
      }
    }

    res.json({
      success: true,
      data: { payment }
    });

  } catch (error) {
    console.error('Get payment by intent error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment details'
    });
  }
});

// @route   POST /api/payments/check-status
// @desc    Check payment status and sync with Stripe
// @access  Private
router.post('/check-status', auth, [
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

    // Find payment record
    const payment = await Payment.findOne({
      stripePaymentIntentId: paymentIntentId,
      user: req.user.id
    }).populate('game', 'name image');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment record not found'
      });
    }

    // Get latest status from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    // Get detailed error information for failed payments
    let errorDetails = null;
    if (paymentIntent.status === 'requires_payment_method' && paymentIntent.last_payment_error) {
      errorDetails = {
        code: paymentIntent.last_payment_error.code,
        message: paymentIntent.last_payment_error.message,
        decline_code: paymentIntent.last_payment_error.decline_code,
        type: paymentIntent.last_payment_error.type
      };
    }

    // Update payment status if it has changed
    const status = mapStripeStatusToDbStatus(paymentIntent.status);

    if (payment.status !== status) {
      payment.status = status;
      payment.paymentMethod = paymentIntent.payment_method_types[0];
      payment.receiptUrl = paymentIntent.charges?.data[0]?.receipt_url;
      
      // Add error details to metadata if payment failed
      if (status === 'failed' && errorDetails) {
        payment.metadata = {
          ...payment.metadata,
          failureReason: errorDetails.message,
          errorCode: errorDetails.code,
          declineCode: errorDetails.decline_code,
          errorType: errorDetails.type,
          failedAt: new Date().toISOString()
        };
      }
      
      await payment.save();
    }

    // Process successful payments
    if (status === 'succeeded' && !payment.tokensAdded) {
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
        status: paymentIntent.status,
        error: errorDetails
      }
    });

  } catch (error) {
    console.error('Check payment status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check payment status'
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

  console.log(`Processing webhook event: ${event.type}`);

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSuccess(event.data.object);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentFailure(event.data.object);
        break;

      case 'payment_intent.canceled':
        await handlePaymentCanceled(event.data.object);
        break;

      case 'payment_intent.processing':
        await handlePaymentProcessing(event.data.object);
        break;

      case 'payment_intent.requires_action':
        await handlePaymentRequiresAction(event.data.object);
        break;

      case 'charge.failed':
        await handleChargeFailed(event.data.object);
        break;

      case 'charge.succeeded':
        await handleChargeSucceeded(event.data.object);
        break;

      case 'charge.dispute.created':
        await handleChargeDispute(event.data.object);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Helper function to handle successful payments
async function handlePaymentSuccess(paymentIntent) {
  console.log(`Processing successful payment: ${paymentIntent.id}`);
  
  const payment = await Payment.findOne({
    stripePaymentIntentId: paymentIntent.id
  });

  if (!payment) {
    console.error(`Payment record not found for successful payment: ${paymentIntent.id}`);
    return;
  }

  if (payment.status === 'succeeded') {
    console.log(`Payment ${payment._id} already marked as succeeded`);
    return;
  }

  // Update payment status
  payment.status = 'succeeded';
  payment.paymentMethod = paymentIntent.payment_method_types[0];
  payment.receiptUrl = paymentIntent.charges?.data[0]?.receipt_url;
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
    console.error('Error processing successful payment:', error);
  }
}

// Helper function to handle payment failures
async function handlePaymentFailure(paymentIntent) {
  console.log(`Processing failed payment: ${paymentIntent.id}`);
  
  const payment = await Payment.findOne({
    stripePaymentIntentId: paymentIntent.id
  });

  if (!payment) {
    console.error(`Payment record not found for failed payment: ${paymentIntent.id}`);
    return;
  }

  // Get detailed error information
  const lastPaymentError = paymentIntent.last_payment_error;
  let failureReason = 'Payment failed';
  let errorCode = 'unknown_error';

  if (lastPaymentError) {
    failureReason = lastPaymentError.message || 'Payment failed';
    errorCode = lastPaymentError.code || 'unknown_error';
    
    console.log(`Payment failure details - Code: ${errorCode}, Message: ${failureReason}`);
  }

  // Update payment status
  payment.status = 'failed';
  payment.metadata = {
    ...payment.metadata,
    failureReason,
    errorCode,
    failedAt: new Date().toISOString()
  };
  await payment.save();

  console.log(`Payment ${payment._id} marked as failed: ${failureReason}`);

  // Send failure notification email
  try {
    await sendFailureNotification(payment, failureReason, errorCode);
  } catch (error) {
    console.error('Error sending failure notification:', error);
  }
}

// Helper function to handle canceled payments
async function handlePaymentCanceled(paymentIntent) {
  console.log(`Processing canceled payment: ${paymentIntent.id}`);
  
  const payment = await Payment.findOne({
    stripePaymentIntentId: paymentIntent.id
  });

  if (!payment) {
    console.error(`Payment record not found for canceled payment: ${paymentIntent.id}`);
    return;
  }

  payment.status = 'canceled';
  payment.metadata = {
    ...payment.metadata,
    canceledAt: new Date().toISOString(),
    cancellationReason: paymentIntent.cancellation_reason || 'user_canceled'
  };
  await payment.save();

  console.log(`Payment ${payment._id} marked as canceled`);
}

// Helper function to handle processing payments
async function handlePaymentProcessing(paymentIntent) {
  console.log(`Processing payment in processing state: ${paymentIntent.id}`);
  
  const payment = await Payment.findOne({
    stripePaymentIntentId: paymentIntent.id
  });

  if (!payment) {
    console.error(`Payment record not found for processing payment: ${paymentIntent.id}`);
    return;
  }

  payment.status = 'processing';
  await payment.save();

  console.log(`Payment ${payment._id} marked as processing`);
}

// Helper function to handle payments requiring action
async function handlePaymentRequiresAction(paymentIntent) {
  console.log(`Processing payment requiring action: ${paymentIntent.id}`);
  
  const payment = await Payment.findOne({
    stripePaymentIntentId: paymentIntent.id
  });

  if (!payment) {
    console.error(`Payment record not found for action-required payment: ${paymentIntent.id}`);
    return;
  }

  // Keep status as pending but add metadata about required action
  payment.metadata = {
    ...payment.metadata,
    requiresAction: true,
    actionType: paymentIntent.next_action?.type || 'unknown',
    lastActionCheck: new Date().toISOString()
  };
  await payment.save();

  console.log(`Payment ${payment._id} marked as requiring action: ${paymentIntent.next_action?.type}`);
}

// Helper function to handle failed charges
async function handleChargeFailed(charge) {
  console.log(`Processing failed charge: ${charge.id}`);
  
  const payment = await Payment.findOne({
    stripePaymentIntentId: charge.payment_intent
  });

  if (!payment) {
    console.error(`Payment record not found for failed charge: ${charge.id}`);
    return;
  }

  // Update payment status to failed
  payment.status = 'failed';
  payment.metadata = {
    ...payment.metadata,
    failureReason: charge.failure_message || 'Charge failed',
    errorCode: charge.failure_code || 'charge_failed',
    failedAt: new Date().toISOString(),
    chargeId: charge.id
  };
  await payment.save();

  console.log(`Payment ${payment._id} marked as failed due to charge failure: ${charge.failure_message}`);
}

// Helper function to handle successful charges
async function handleChargeSucceeded(charge) {
  console.log(`Processing successful charge: ${charge.id}`);
  
  const payment = await Payment.findOne({
    stripePaymentIntentId: charge.payment_intent
  });

  if (!payment) {
    console.error(`Payment record not found for successful charge: ${charge.id}`);
    return;
  }

  // Update receipt URL if not already set
  if (!payment.receiptUrl && charge.receipt_url) {
    payment.receiptUrl = charge.receipt_url;
    await payment.save();
  }

  console.log(`Charge succeeded for payment ${payment._id}`);
}

// Helper function to handle charge disputes
async function handleChargeDispute(dispute) {
  console.log(`Processing charge dispute: ${dispute.id}`);
  
  const payment = await Payment.findOne({
    stripePaymentIntentId: dispute.charge.payment_intent
  });

  if (!payment) {
    console.error(`Payment record not found for dispute: ${dispute.id}`);
    return;
  }

  // Add dispute information to metadata
  payment.metadata = {
    ...payment.metadata,
    disputeId: dispute.id,
    disputeReason: dispute.reason,
    disputeAmount: dispute.amount,
    disputeStatus: dispute.status,
    disputedAt: new Date().toISOString()
  };
  await payment.save();

  console.log(`Dispute recorded for payment ${payment._id}: ${dispute.reason}`);
}

// Helper function to send failure notification
async function sendFailureNotification(payment, failureReason, errorCode) {
  try {
    const adminSubject = `❌ Payment Failed - ${payment.location}`;
    const adminHtml = `
      <div style="font-family: Arial, sans-serif; background: #f9f9f9; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0; max-width: 520px; margin: auto;">
        <div style="text-align: center; margin-bottom: 18px;">
          <h2 style="color: #dc2626; margin: 0;">Payment Failed Alert</h2>
        </div>
        <p><b>User:</b> ${payment.metadata.userFirstname} ${payment.metadata.userLastname} (${payment.metadata.userEmail})</p>
        <p><b>Game:</b> ${payment.metadata.gameName}</p>
        <p><b>Amount:</b> $${payment.amount}</p>
        <p><b>Location:</b> ${payment.location}</p>
        <p><b>Failure Reason:</b> <span style="color: #dc2626;">${failureReason}</span></p>
        <p><b>Error Code:</b> ${errorCode}</p>
        <p><b>Payment ID:</b> ${payment._id}</p>
        <p><b>Stripe ID:</b> ${payment.stripePaymentIntentId}</p>
      </div>
    `;

    // Determine admin email by location
    let adminEmail = null;
    if (payment.location.toLowerCase().includes('cedar')) {
      adminEmail = process.env.ADMIN_EMAIL_CEDAR_PARK;
    } else if (payment.location.toLowerCase().includes('liberty')) {
      adminEmail = process.env.ADMIN_EMAIL_LIBERTY_HILL;
    }

    if (adminEmail) {
      await sendEmail({
        to: adminEmail,
        subject: adminSubject,
        html: adminHtml,
        text: `Payment Failed Alert\n\nUser: ${payment.metadata.userFirstname} ${payment.metadata.userLastname} (${payment.metadata.userEmail})\nGame: ${payment.metadata.gameName}\nAmount: $${payment.amount}\nLocation: ${payment.location}\nFailure Reason: ${failureReason}\nError Code: ${errorCode}`
      });
    }

    // Send user notification
    const userSubject = 'Payment Failed - HCCC Games';
    const userHtml = `
      <div style="font-family: Arial, sans-serif; background: #f9f9f9; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0; max-width: 520px; margin: auto;">
        <div style="text-align: center; margin-bottom: 18px;">
          <h2 style="color: #dc2626; margin: 0;">Payment Failed</h2>
        </div>
        <p>Hi <b>${payment.metadata.userFirstname}</b>,</p>
        <p>We're sorry, but your payment for <b>${payment.metadata.gameName}</b> at <b>${payment.location}</b> was not successful.</p>
        <div style="background: #fee2e2; border: 1px solid #fecaca; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p style="color: #dc2626; margin: 0;"><b>Reason:</b> ${failureReason}</p>
        </div>
        <p><b>Order Details:</b></p>
        <ul style="background: #fff; padding: 16px; border-radius: 6px; list-style: none;">
          <li><b>Game:</b> ${payment.metadata.gameName}</li>
          <li><b>Tokens:</b> ${payment.tokenPackage.tokens}</li>
          <li><b>Amount:</b> $${payment.amount}</li>
          <li><b>Location:</b> ${payment.location}</li>
        </ul>
        <p>Please try again with a different payment method or contact us if you need assistance.</p>
        <p>Thank you for choosing HCCC Games!</p>
      </div>
    `;

    await sendEmail({
      to: payment.metadata.userEmail,
      subject: userSubject,
      html: userHtml,
      text: `Payment Failed\n\nHi ${payment.metadata.userFirstname},\n\nWe're sorry, but your payment for ${payment.metadata.gameName} at ${payment.location} was not successful.\n\nReason: ${failureReason}\n\nOrder Details:\n- Game: ${payment.metadata.gameName}\n- Tokens: ${payment.tokenPackage.tokens}\n- Amount: $${payment.amount}\n- Location: ${payment.location}\n\nPlease try again with a different payment method or contact us if you need assistance.\n\nThank you for choosing HCCC Games!`
    });

  } catch (error) {
    console.error('Failed to send failure notification:', error);
  }
}

module.exports = router; 