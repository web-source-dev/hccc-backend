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
  paypalOrderId: {
    type: String,
    required: true
  },
  paypalPaymentId: {
    type: String
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'USD'
  },
  status: {
    type: String,
    // PayPal statuses: 'CREATED', 'SAVED', 'APPROVED', 'VOIDED', 'COMPLETED', 'PAYER_ACTION_REQUIRED'
    required: true,
    default: 'CREATED'
  },
  paymentMethod: {
    type: String,
    default: 'paypal'
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
    // PayPal specific fields
    paypalIntent: String,
    paypalCaptureId: String
  }
}, {
  timestamps: true
});

// Index for better query performance
paymentSchema.index({ user: 1, status: 1, createdAt: -1 });
paymentSchema.index({ paypalOrderId: 1 }, { unique: true });
paymentSchema.index({ user: 1, game: 1, 'tokenPackage.tokens': 1, 'tokenPackage.price': 1, location: 1, status: 1 });

module.exports = mongoose.model('Payment', paymentSchema); 