const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const Payment = require('../models/Payment');
const TokenBalance = require('../models/TokenBalance');
const User = require('../models/User');
const Game = require('../models/Game');

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Migration function
const migrateTokenBalances = async () => {
  try {
    console.log('🔄 Starting token balance migration...');
    
    // Get all successful payments
    const successfulPayments = await Payment.find({ status: 'succeeded' })
      .populate('user', 'username')
      .populate('game', 'name');
    
    console.log(`📊 Found ${successfulPayments.length} successful payments to process`);
    
    if (successfulPayments.length === 0) {
      console.log('✅ No payments to migrate');
      return;
    }
    
    // Group payments by user, game, and location
    const paymentGroups = {};
    
    successfulPayments.forEach(payment => {
      const key = `${payment.user._id}-${payment.game._id}-${payment.location}`;
      
      if (!paymentGroups[key]) {
        paymentGroups[key] = {
          user: payment.user._id,
          game: payment.game._id,
          location: payment.location,
          totalTokens: 0,
          paymentCount: 0,
          lastUpdated: payment.updatedAt
        };
      }
      
      paymentGroups[key].totalTokens += payment.tokenPackage.tokens;
      paymentGroups[key].paymentCount += 1;
      
      if (payment.updatedAt > paymentGroups[key].lastUpdated) {
        paymentGroups[key].lastUpdated = payment.updatedAt;
      }
    });
    
    console.log(`📦 Grouped into ${Object.keys(paymentGroups).length} unique user-game-location combinations`);
    
    // Create or update token balances
    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    
    for (const [key, group] of Object.entries(paymentGroups)) {
      try {
        // Check if token balance already exists
        let tokenBalance = await TokenBalance.findOne({
          user: group.user,
          game: group.game,
          location: group.location
        });
        
        if (tokenBalance) {
          // Update existing balance
          const oldTokens = tokenBalance.tokens;
          tokenBalance.tokens = group.totalTokens;
          tokenBalance.updatedAt = group.lastUpdated;
          await tokenBalance.save();
          
          console.log(`🔄 Updated: User ${group.user} - Game ${group.game} - ${group.location}: ${oldTokens} → ${group.totalTokens} tokens (${group.paymentCount} payments)`);
          updatedCount++;
        } else {
          // Create new balance
          tokenBalance = new TokenBalance({
            user: group.user,
            game: group.game,
            location: group.location,
            tokens: group.totalTokens,
            createdAt: group.lastUpdated,
            updatedAt: group.lastUpdated
          });
          await tokenBalance.save();
          
          console.log(`✨ Created: User ${group.user} - Game ${group.game} - ${group.location}: ${group.totalTokens} tokens (${group.paymentCount} payments)`);
          createdCount++;
        }
      } catch (error) {
        console.error(`❌ Error processing ${key}:`, error.message);
        skippedCount++;
      }
    }
    
    // Summary
    console.log('\n📈 Migration Summary:');
    console.log(`✅ Created: ${createdCount} new token balances`);
    console.log(`🔄 Updated: ${updatedCount} existing token balances`);
    console.log(`⏭️  Skipped: ${skippedCount} due to errors`);
    console.log(`📊 Total processed: ${createdCount + updatedCount + skippedCount}`);
    
    // Verify migration
    const totalTokenBalances = await TokenBalance.countDocuments();
    console.log(`\n🔍 Verification: Total token balance records: ${totalTokenBalances}`);
    
    // Show some sample data
    const sampleBalances = await TokenBalance.find()
      .populate('user', 'username')
      .populate('game', 'name')
      .limit(5)
      .sort({ tokens: -1 });
    
    if (sampleBalances.length > 0) {
      console.log('\n📋 Sample Token Balances:');
      sampleBalances.forEach(balance => {
        console.log(`  • ${balance.user.username} - ${balance.game.name} (${balance.location}): ${balance.tokens} tokens`);
      });
    }
    
    console.log('\n✅ Token balance migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
};

// Run migration
const runMigration = async () => {
  try {
    await connectDB();
    await migrateTokenBalances();
    console.log('🎉 Migration completed!');
    process.exit(0);
  } catch (error) {
    console.error('💥 Migration failed:', error);
    process.exit(1);
  }
};

// Run if called directly
if (require.main === module) {
  runMigration();
}

module.exports = { migrateTokenBalances }; 