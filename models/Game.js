const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Game name is required'],
    trim: true,
    unique: true,
    minlength: [2, 'Game name must be at least 2 characters long'],
    maxlength: [100, 'Game name cannot exceed 100 characters']
  },
  description: {
    type: String,
    required: [true, 'Game description is required'],
    trim: true,
    minlength: [10, 'Description must be at least 10 characters long'],
    maxlength: [500, 'Description cannot exceed 500 characters']
  },
  image: {
    type: String,
    required: [true, 'Game image is required'],
    trim: true
  },
  category: {
    type: String,
    required: [true, 'Game category is required'],
    enum: ['RPG', 'Action', 'Sci-Fi', 'Adventure', 'Strategy', 'Puzzle', 'Racing', 'Sports', 'Other'],
    default: 'Other'
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'maintenance'],
    default: 'active'
  },
  locations: [{
    name: {
      type: String,
      required: true,
      trim: true
    },
    available: {
      type: Boolean,
      default: true
    },
  }],
  tokenPackages: [{
    tokens: {
      type: Number,
      required: true,
      min: [1, 'Tokens must be at least 1']
    },
    price: {
      type: Number,
      required: true,
      min: [0, 'Price cannot be negative']
    }
  }],
  featured: {
    type: Boolean,
    default: false
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Index for better query performance
gameSchema.index({ name: 1, status: 1, category: 1 });

// Virtual for total revenue
gameSchema.virtual('totalRevenue').get(function() {
  if (!this.locations || this.locations.length === 0) {
    return 0;
  }
  return this.totalSales * (this.locations[0].price || 0);
});

// Ensure virtuals are serialized
gameSchema.set('toJSON', { virtuals: true });
gameSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Game', gameSchema); 