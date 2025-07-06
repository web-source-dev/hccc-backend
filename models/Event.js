const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  date: { type: Date, required: true },
  location: { type: String },
  image: { type: String },
}, {
  timestamps: true // adds createdAt and updatedAt
});

module.exports = mongoose.model('Event', eventSchema); 