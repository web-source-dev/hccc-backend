const mongoose = require('mongoose');
const Payment = require('../models/Payment');
require('dotenv').config();

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected for scheduled token processing');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

// Process scheduled tokens
const processScheduledTokens = async () => {
  try {
    console.log(`[${new Date().toISOString()}] Starting scheduled token processing...`);
    
    const processedCount = await Payment.processScheduledTokens();
    
    console.log(`[${new Date().toISOString()}] Completed processing ${processedCount} scheduled token payments`);
    
    if (processedCount > 0) {
      console.log(`[${new Date().toISOString()}] Successfully processed ${processedCount} token additions`);
    }
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error processing scheduled tokens:`, error);
  }
};

// Main execution
const main = async () => {
  await connectDB();
  await processScheduledTokens();
  
  // Close connection after processing
  await mongoose.connection.close();
  console.log('Database connection closed');
  process.exit(0);
};

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

// Run the script
main().catch(error => {
  console.error('Script execution failed:', error);
  process.exit(1);
}); 