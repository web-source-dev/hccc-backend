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
    // Stores the exact Stripe status (e.g., 'incomplete', 'processing', 'succeeded', 'failed', 'canceled', 'expired', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture', 'blocked', etc.)
    required: true,
    default: 'incomplete'
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
    timeRestriction: String,
    // Error tracking fields
    failureReason: String,
    errorCode: String,
    declineCode: String,
    errorType: String,
    failedAt: String,
    // Action tracking fields
    requiresAction: Boolean,
    actionType: String,
    lastActionCheck: String,
    // Dispute tracking fields
    disputeId: String,
    disputeReason: String,
    disputeAmount: Number,
    disputeStatus: String,
    disputedAt: String,
    // Charge tracking
    chargeId: String
  }
}, {
  timestamps: true
});

// Index for better query performance
paymentSchema.index({ user: 1, status: 1, createdAt: -1 });
paymentSchema.index({ stripePaymentIntentId: 1 }, { unique: true });
paymentSchema.index({ user: 1, game: 1, 'tokenPackage.tokens': 1, 'tokenPackage.price': 1, location: 1, status: 1 });

module.exports = mongoose.model('Payment', paymentSchema); 