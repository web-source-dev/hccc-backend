const mongoose = require('mongoose');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

const Payment = require('../models/Payment');
const TokenBalance = require('../models/TokenBalance');
const { checkTimeRestriction } = require('../utils/timeRestrictions');

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

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

// Fix failed payments by syncing with Stripe
async function fixFailedPayments() {
  try {
    console.log('Starting to fix failed payments...');

    // Find all pending payments that might be failed
    const pendingPayments = await Payment.find({
      status: { $in: ['requires_payment_method', 'processing', 'requires_action', 'requires_confirmation', 'requires_capture', 'incomplete'] }
    });

    console.log(`Found ${pendingPayments.length} pending/processing payments to check`);

    let updatedCount = 0;
    let errorCount = 0;
    let tokensAddedCount = 0;

    for (const payment of pendingPayments) {
      try {
        console.log(`Checking payment ${payment._id} (Stripe ID: ${payment.stripePaymentIntentId})`);

        // Get latest status from Stripe
        const paymentIntent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);

        // Map Stripe status to database status
        // const dbStatus = mapStripeStatusToDbStatus(paymentIntent.status);
        // Check if payment status has changed
        if (payment.status !== paymentIntent.status) {
          console.log(`Payment ${payment._id} status changed from ${payment.status} to ${paymentIntent.status} (Stripe: ${paymentIntent.status})`);

          // Update payment status
          payment.status = paymentIntent.status;

          // Add error details if payment failed
          if (paymentIntent.last_payment_error) {
            payment.metadata = {
              ...payment.metadata,
              failureReason: paymentIntent.last_payment_error.message,
              errorCode: paymentIntent.last_payment_error.code,
              declineCode: paymentIntent.last_payment_error.decline_code,
              errorType: paymentIntent.last_payment_error.type,
              failedAt: new Date().toISOString()
            };
          }

          // Update receipt URL if available
          if (paymentIntent.charges?.data[0]?.receipt_url) {
            payment.receiptUrl = paymentIntent.charges.data[0].receipt_url;
          }

          await payment.save();
          updatedCount++;

          console.log(`Updated payment ${payment._id} to status: ${paymentIntent.status}`);
        }

        // If Stripe says succeeded but DB is pending/processing, add tokens if not already added
        if (paymentIntent.status === 'succeeded' && !payment.tokensAdded) {
          // Check time restrictions
          const timeRestriction = checkTimeRestriction(payment.location);
          if (timeRestriction.shouldDelay && timeRestriction.scheduledTime) {
            payment.tokensScheduledFor = timeRestriction.scheduledTime;
            payment.tokensAdded = false;
            await payment.save();
            console.log(`Tokens scheduled for ${timeRestriction.scheduledTime.toISOString()} for payment ${payment._id}`);
          } else {
            await addTokensToBalance(payment);
            tokensAddedCount++;
          }
        }
      } catch (error) {
        console.error(`Error processing payment ${payment._id}:`, error.message);
        errorCount++;
      }
    }

    const result = {
      totalChecked: pendingPayments.length,
      updated: updatedCount,
      tokensAdded: tokensAddedCount,
      errors: errorCount
    };

    console.log(`\nFix completed:`);
    console.log(`- Total payments checked: ${result.totalChecked}`);
    console.log(`- Payments updated: ${result.updated}`);
    console.log(`- Payments with tokens added: ${result.tokensAdded}`);
    console.log(`- Errors encountered: ${result.errors}`);

    return result;

  } catch (error) {
    console.error('Error fixing failed payments:', error);
    throw error;
  }
}

// Export functions for use in routes
module.exports = {
  fixFailedPayments,
  addTokensToBalance,
  connectDB
};

// Run the fix if this file is executed directly
if (require.main === module) {
  const runFix = async () => {
    await connectDB();
    await fixFailedPayments();
    process.exit(0);
  };

  runFix();
} 