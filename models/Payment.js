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
  metadata: {
    gameName: String,
    userName: String,
    userEmail: String
  }
}, {
  timestamps: true
});

// Index for better query performance
paymentSchema.index({ user: 1, status: 1, createdAt: -1 });
paymentSchema.index({ stripePaymentIntentId: 1 }, { unique: true });
paymentSchema.index({ user: 1, game: 1, 'tokenPackage.tokens': 1, 'tokenPackage.price': 1, location: 1, status: 1 });

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

module.exports = mongoose.model('Payment', paymentSchema); 