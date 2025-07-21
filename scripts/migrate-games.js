const mongoose = require('mongoose');
const Game = require('../models/Game');
require('dotenv').config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

const migrateGames = async () => {
  try {
    await connectDB();

    console.log('Starting game migration...');

    // Update all existing games
    const result = await Game.updateMany(
      {}, // Update all games
      {
        $unset: { tokenPackages: "" }, // Remove tokenPackages field
        $set: { createdBy: '687b191d0706ae7ec14759c9' } // Set createdBy to specified ID
      }
    );

    console.log(`✅ Updated ${result.modifiedCount} games`);
    console.log('✅ Removed tokenPackages field from all games');
    console.log('✅ Set createdBy to 687b191d0706ae7ec14759c9 for all games');

    // Verify the changes
    const games = await Game.find({});
    console.log(`\n📊 Total games in database: ${games.length}`);
    
    if (games.length > 0) {
      console.log('\nSample game structure:');
      const sampleGame = games[0];
      console.log('- Name:', sampleGame.name);
      console.log('- CreatedBy:', sampleGame.createdBy);
      console.log('- Has tokenPackages:', sampleGame.tokenPackages ? 'Yes' : 'No');
    }

    console.log('\n🎉 Game migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
};

migrateGames(); 