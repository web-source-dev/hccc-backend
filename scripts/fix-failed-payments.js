const mongoose = require('mongoose');
const stripe = require('stripe')('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');
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
      status: { $in: ['pending', 'processing'] }
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
        const dbStatus = mapStripeStatusToDbStatus(paymentIntent.status);

        // Check if payment status has changed
        if (payment.status !== dbStatus) {
          console.log(`Payment ${payment._id} status changed from ${payment.status} to ${dbStatus} (Stripe: ${paymentIntent.status})`);

          // Update payment status
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

          // Update receipt URL if available
          if (paymentIntent.charges?.data[0]?.receipt_url) {
            payment.receiptUrl = paymentIntent.charges.data[0].receipt_url;
          }

          await payment.save();
          updatedCount++;

          console.log(`Updated payment ${payment._id} to status: ${dbStatus}`);
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

    console.log(`\nFix completed:`);
    console.log(`- Total payments checked: ${pendingPayments.length}`);
    console.log(`- Payments updated: ${updatedCount}`);
    console.log(`- Payments with tokens added: ${tokensAddedCount}`);
    console.log(`- Errors encountered: ${errorCount}`);

  } catch (error) {
    console.error('Error fixing failed payments:', error);
  }
}

// Run the fix
const runFix = async () => {
  await connectDB();
  await fixFailedPayments();
  process.exit(0);
};

runFix(); 