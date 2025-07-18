const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  game: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game',
    required: true
  },
  tokenPackage: {
    tokens: {
      type: Number,
      required: true
    },
    price: {
      type: Number,
      required: true
    }
  },
  location: {
    type: String,
    required: true
  },
  stripePaymentIntentId: {
    type: String,
    required: true
  },
  stripeClientSecret: {
    type: String,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'usd'
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'succeeded', 'failed', 'canceled', 'expired'],
    default: 'pending'
  },
  paymentMethod: {
    type: String
  },
  receiptUrl: {
    type: String
  },
  // Token addition tracking
  tokensScheduledFor: {
    type: Date,
    default: null
  },
  tokensAdded: {
    type: Boolean,
    default: false
  },
  metadata: {
    gameName: String,
    userFirstname: String,
    userLastname: String,
    userEmail: String,
    timeRestriction: String
  }
}, {
  timestamps: true
});

// Index for better query performance
paymentSchema.index({ user: 1, status: 1, createdAt: -1 });
paymentSchema.index({ stripePaymentIntentId: 1 }, { unique: true });
paymentSchema.index({ user: 1, game: 1, 'tokenPackage.tokens': 1, 'tokenPackage.price': 1, location: 1, status: 1 });
// Index for scheduled token processing
paymentSchema.index({ tokensScheduledFor: 1, tokensAdded: 1, status: 1 });

// Static method to clean up expired payment intents
paymentSchema.statics.cleanupExpiredPayments = async function() {
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
  
  try {
    const result = await this.updateMany(
      {
        status: { $in: ['pending', 'processing'] },
        createdAt: { $lt: thirtyMinutesAgo }
      },
      {
        $set: { status: 'expired' }
      }
    );
    
    console.log(`Cleaned up ${result.modifiedCount} expired payments`);
    return result.modifiedCount;
  } catch (error) {
    console.error('Error cleaning up expired payments:', error);
    throw error;
  }
};

// Static method to process scheduled token additions
paymentSchema.statics.processScheduledTokens = async function() {
  const now = new Date();
  
  try {
    // Find payments that are scheduled for token addition and haven't been processed yet
    const scheduledPayments = await this.find({
      status: 'succeeded',
      tokensScheduledFor: { $lte: now },
      tokensAdded: false
    }).populate('user', 'firstname lastname email').populate('game', 'name');

    console.log(`Found ${scheduledPayments.length} payments ready for token processing`);

    for (const payment of scheduledPayments) {
      try {
        // Add tokens to balance
        const TokenBalance = require('./TokenBalance');
        let tokenBalance = await TokenBalance.findOne({
          user: payment.user._id,
          game: payment.game._id,
          location: payment.location
        });

        if (!tokenBalance) {
          tokenBalance = new TokenBalance({
            user: payment.user._id,
            game: payment.game._id,
            location: payment.location,
            tokens: 0
          });
        }

        tokenBalance.tokens += payment.tokenPackage.tokens;
        await tokenBalance.save();

        // Mark payment as processed
        payment.tokensAdded = true;
        await payment.save();

        console.log(`Processed tokens for payment ${payment._id}: ${payment.tokenPackage.tokens} tokens added to ${payment.user.firstname} ${payment.user.lastname} for ${payment.game.name} at ${payment.location}`);

        // Send notification email to user
        const { sendEmail } = require('../utils/email');
        await sendEmail({
          to: payment.metadata.userEmail,
          subject: '🎮 Your HCCC Games Tokens Are Now Available!',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #b80000;">Your Tokens Are Ready!</h2>
              <p>Hi <b>${payment.metadata.userFirstname} ${payment.metadata.userLastname}</b>,</p>
              <p>Great news! Your <b>${payment.tokenPackage.tokens} tokens</b> for <b>${payment.metadata.gameName}</b> at <b>${payment.location}</b> have been automatically added to your account and are now ready to use!</p>
              <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3 style="margin-top: 0;">Token Details:</h3>
                <p><strong>Game:</strong> ${payment.metadata.gameName}</p>
                <p><strong>Tokens:</strong> ${payment.tokenPackage.tokens}</p>
                <p><strong>Location:</strong> ${payment.location}</p>
                <p><strong>Added at:</strong> ${new Date().toLocaleString()}</p>
              </div>
              <p>Enjoy your game!</p>
              <p>Best regards,<br>HCCC Game Room Team</p>
            </div>
          `,
          text: `Your Tokens Are Ready!\n\nHi ${payment.metadata.userFirstname} ${payment.metadata.userLastname},\n\nGreat news! Your ${payment.tokenPackage.tokens} tokens for ${payment.metadata.gameName} at ${payment.location} have been automatically added to your account and are now ready to use!\n\nToken Details:\n- Game: ${payment.metadata.gameName}\n- Tokens: ${payment.tokenPackage.tokens}\n- Location: ${payment.location}\n- Added at: ${new Date().toLocaleString()}\n\nEnjoy your game!\n\nBest regards,\nHCCC Game Room Team`
        });

      } catch (error) {
        console.error(`Error processing tokens for payment ${payment._id}:`, error);
      }
    }

    return scheduledPayments.length;
  } catch (error) {
    console.error('Error processing scheduled tokens:', error);
    throw error;
  }
};

module.exports = mongoose.model('Payment', paymentSchema); 