const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
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

const setupUsers = async () => {
  try {
    await connectDB();

    const users = [
      {
        firstname: 'Kimberly',
        lastname: 'Lamar',
        email: 'kmldigital601@gmail.com',
        password: 'Admin123!',
        role: 'admin',
        isActive: true
      },
      {
        firstname: 'Kimberly',
        lastname: 'Lamar',
        email: 'kimlamar2003@yahoo.com',
        password: 'User123!',
        role: 'user',
        isActive: true
      },
      {
        firstname: 'Casey',
        lastname: 'Barson',
        email: 'nimby45@gmail.com',
        password: 'User123!',
        role: 'user',
        isActive: true
      },
      {
        firstname: 'Liberty Hill',
        lastname: 'Cashier',
        email: 'libertyhilldigital@gmail.com',
        password: 'LibertyCashier123!',
        role: 'cashierLiberty',
        isActive: true
      },
      {
        firstname: 'Cedar Park',
        lastname: 'Cashier',
        email: 'cedarparkdigitial601@gmail.com',
        password: 'CedarCashier123!',
        role: 'cashierCedar',
        isActive: true
      }
    ];

    for (const userData of users) {
      try {
        // Check if user already exists
        const existingUser = await User.findOne({ email: userData.email });
        
        if (existingUser) {
          console.log(`User ${userData.email} already exists. Updating...`);
          
          // Update existing user
          existingUser.firstname = userData.firstname;
          existingUser.lastname = userData.lastname;
          existingUser.role = userData.role;
          existingUser.isActive = userData.isActive;
          
          // Only update password if it's different
          if (userData.password) {
            const salt = await bcrypt.genSalt(12);
            existingUser.password = await bcrypt.hash(userData.password, salt);
          }
          
          await existingUser.save();
          console.log(`✅ Updated user: ${userData.email} (${userData.role})`);
        } else {
          // Create new user
          const user = new User(userData);
          await user.save();
          console.log(`✅ Created user: ${userData.email} (${userData.role})`);
        }
      } catch (error) {
        console.error(`❌ Error processing user ${userData.email}:`, error.message);
      }
    }

    console.log('\n🎉 User setup completed!');
    console.log('\nUser Accounts:');
    console.log('==============');
    console.log('Admin: kmldigital601@gmail.com (Kimberly Lamar)');
    console.log('Personal: kimlamar2003@yahoo.com (Kimberly Lamar)');
    console.log('Personal: nimby45@gmail.com (Casey Barson)');
    console.log('Cashier: libertyhilldigital@gmail.com (Liberty Hill)');
    console.log('Cashier: cedarparkdigitial601@gmail.com (Cedar Park)');
    console.log('\nAll passwords are set to: User123! (except admin: Admin123!, cashiers: CedarCashier123!, LibertyCashier123!)');

    process.exit(0);
  } catch (error) {
    console.error('Setup failed:', error);
    process.exit(1);
  }
};

setupUsers(); 