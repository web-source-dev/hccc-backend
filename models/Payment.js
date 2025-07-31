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
  paypalPayerId: {
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
  // Store both PayPal status and our internal status
  paypalStatus: {
    type: String,
    enum: [
      'CREATED', 'SAVED', 'APPROVED', 'VOIDED', 'COMPLETED', 'PAYER_ACTION_REQUIRED',
      'CAPTURE_PENDING', 'CAPTURE_COMPLETED', 'CAPTURE_DENIED', 'CAPTURE_VOIDED', 
      'CAPTURE_REFUNDED', 'CAPTURE_FAILED', 'EXPIRED', 'DENIED'
    ],
    default: 'CREATED'
  },
  status: {
    type: String,
    enum: ['incomplete', 'processing', 'succeeded', 'failed', 'canceled', 'expired', 'refunded'],
    required: true,
    default: 'incomplete'
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
  // Enhanced metadata for production tracking
  metadata: {
    gameName: String,
    userFirstname: String,
    userLastname: String,
    userEmail: String,
    timeRestriction: String,
    // PayPal specific fields
    paypalCaptureId: String,
    paypalTransactionId: String,
    paypalFee: Number,
    paypalNetAmount: Number,
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
    // Risk assessment fields
    riskLevel: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'low'
    },
    riskFactors: [String],
    // Fraud prevention fields
    ipAddress: String,
    userAgent: String,
    deviceFingerprint: String,
    // Compliance fields
    complianceStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending'
    },
    complianceNotes: String
  }
}, {
  timestamps: true
});

// Index for better query performance
paymentSchema.index({ user: 1, status: 1, createdAt: -1 });
paymentSchema.index({ paypalOrderId: 1 }, { unique: true });
paymentSchema.index({ user: 1, game: 1, 'tokenPackage.tokens': 1, 'tokenPackage.price': 1, location: 1, status: 1 });
paymentSchema.index({ paypalStatus: 1, status: 1 });
paymentSchema.index({ 'metadata.riskLevel': 1, status: 1 });
paymentSchema.index({ tokensScheduledFor: 1, tokensAdded: 1 });

// Virtual for display status
paymentSchema.virtual('displayStatus').get(function() {
  return this.status;
});

// Pre-save middleware to update internal status based on PayPal status
paymentSchema.pre('save', function(next) {
  if (this.isModified('paypalStatus')) {
    const statusMap = {
      'COMPLETED': 'succeeded',
      'CAPTURE_COMPLETED': 'succeeded',
      'PENDING': 'processing',
      'CAPTURE_PENDING': 'processing',
      'APPROVED': 'processing',
      'PAYER_ACTION_REQUIRED': 'processing',
      'VOIDED': 'canceled',
      'CAPTURE_VOIDED': 'canceled',
      'DENIED': 'failed',
      'CAPTURE_DENIED': 'failed',
      'CAPTURE_FAILED': 'failed',
      'EXPIRED': 'expired',
      'CAPTURE_REFUNDED': 'refunded',
      'CREATED': 'incomplete',
      'SAVED': 'incomplete'
    };
    
    this.status = statusMap[this.paypalStatus] || 'incomplete';
  }
  next();
});

// Ensure virtuals are serialized
paymentSchema.set('toJSON', { virtuals: true });
paymentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Payment', paymentSchema); 