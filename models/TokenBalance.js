const mongoose = require('mongoose');

const tokenBalanceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  game: { type: mongoose.Schema.Types.ObjectId, ref: 'Game', required: true },
  location: { type: String, required: true },
  tokens: { type: Number, required: true, default: 0 },
}, {
  timestamps: true
});

tokenBalanceSchema.index({ user: 1, game: 1, location: 1 }, { unique: true });

module.exports = mongoose.model('TokenBalance', tokenBalanceSchema); 