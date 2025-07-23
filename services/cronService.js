const cron = require('node-cron');
const Payment = require('../models/Payment');
const TokenBalance = require('../models/TokenBalance');
const { sendEmail } = require('../utils/email');
const { fixFailedPayments } = require('../scripts/fix-failed-payments');

class CronService {
  constructor() {
    this.isInitialized = false;
  }

  // Initialize all cron jobs
  init() {
    if (this.isInitialized) {
      console.log('Cron service already initialized');
      return;
    }

    console.log('Initializing cron service...');

    // Fix failed payments every 10 minutes
    cron.schedule('*/1 * * * *', async () => {
      console.log(`[${new Date().toISOString()}] Running fix failed payments check...`);
      try {
        const result = await fixFailedPayments();
        console.log(`[${new Date().toISOString()}] Fix failed payments completed:`, result);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in fix failed payments:`, error);
      }
    });

    // Cedar Park tokens at 11:00 AM Texas time (UTC-6, so 17:00 UTC)
    cron.schedule('0 17 * * *', async () => {
      console.log(`[${new Date().toISOString()}] Running Cedar Park scheduled token processing...`);
      await this.processScheduledTokensForLocation('Cedar Park');
    }, {
      timezone: 'America/Chicago' // Texas timezone
    });

    // Liberty Hill tokens at 10:00 AM Texas time (UTC-6, so 16:00 UTC)
    cron.schedule('0 16 * * *', async () => {
      console.log(`[${new Date().toISOString()}] Running Liberty Hill scheduled token processing...`);
      await this.processScheduledTokensForLocation('Liberty Hill');
    }, {
      timezone: 'America/Chicago' // Texas timezone
    });
    this.isInitialized = true;
    console.log('Cron service initialized successfully');
  }

  // Process scheduled tokens for a specific location
  async processScheduledTokensForLocation(location) {
    try {
      const now = new Date();
      console.log(`Processing scheduled tokens for ${location} at ${now.toISOString()}`);

      // Find payments that are scheduled for token addition and haven't been processed yet
      // Only process payments that were scheduled during closing hours
      // status: 'succeeded' is a Stripe status value
      const scheduledPayments = await Payment.find({
        status: 'succeeded',
        location: location,
        tokensAdded: false,
      }).populate('user', 'firstname lastname email').populate('game', 'name');

      console.log(`Found ${scheduledPayments.length} payments ready for token processing in ${location}`);

      let processedCount = 0;
      for (const payment of scheduledPayments) {
        try {
          // Add tokens to balance
          let tokenBalance = await TokenBalance.findOne({
            user: payment.user._id,
            game: payment.game._id,
            location: payment.location
          });

          if (!tokenBalance) {
            tokenBalance = new TokenBalance({
              user: payment.user._id,
              game: payment.game._id,
              location: payment.location,
              tokens: 0
            });
          }

          tokenBalance.tokens += payment.tokenPackage.tokens;
          await tokenBalance.save();

          // Mark payment as processed
          payment.tokensAdded = true;
          payment.tokensScheduledFor = null;
          payment.metadata.timeRestriction = null;
          await payment.save();

          processedCount++;
          console.log(`Processed tokens for payment ${payment._id}: ${payment.tokenPackage.tokens} tokens added to ${payment.user.firstname} ${payment.user.lastname} for ${payment.game.name} at ${payment.location}`);

          // Send notification email to user
          await this.sendTokenAvailableEmail(payment);

        } catch (error) {
          console.error(`Error processing tokens for payment ${payment._id}:`, error);
        }
      }

      console.log(`Successfully processed ${processedCount} token additions for ${location}`);
      return processedCount;

    } catch (error) {
      console.error(`Error processing scheduled tokens for ${location}:`, error);
      throw error;
    }
  }
  // Send email notification when tokens become available
  async sendTokenAvailableEmail(payment) {
    try {
      const logoUrl = 'https://www.hccc.online/image.gif';
      const brandColor = '#1e293b';
      const accentColor = '#38a169';

      const subject = '🎮 Your HCCC Games Tokens Are Now Available!';
      const html = `
        <div style="font-family: Arial, sans-serif; background: #f9f9f9; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0; max-width: 520px; margin: auto;">
          <div style="text-align: center; margin-bottom: 18px;">
            <img src="${logoUrl}" alt="HCCC Games Logo" style="height: 48px; margin-bottom: 8px;" />
            <h2 style="color: ${brandColor}; margin: 0;">Your Tokens Are Ready!</h2>
          </div>
          <p>Hi <b>${payment.metadata.userFirstname} ${payment.metadata.userLastname}</b>,</p>
          <p>Great news! Your <b>${payment.tokenPackage.tokens} tokens</b> for <b>${payment.metadata.gameName}</b> at <b>${payment.location}</b> have been automatically added to your account and are now ready to use!</p>
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Token Details:</h3>
            <p><strong>Game:</strong> ${payment.metadata.gameName}</p>
            <p><strong>Tokens:</strong> <span style="color: #3182ce; font-weight: bold;">${payment.tokenPackage.tokens}</span></p>
            <p><strong>Location:</strong> ${payment.location}</p>
            <p><strong>Added at:</strong> ${new Date().toLocaleString()}</p>
          </div>
          <p>Enjoy your game!</p>
          <hr style="margin: 24px 0;"/>
          <p style="font-size: 13px; color: #718096;">This is an automated notification from HCCC Gameroom.</p>
          <div style="text-align: center; margin-top: 24px;">
            <a href="https://www.hccc.online" style="color: ${brandColor}; text-decoration: none; font-weight: bold;">Visit HCCC Games</a>
          </div>
        </div>
      `;

      const text = `Your Tokens Are Ready!\n\nHi ${payment.metadata.userFirstname} ${payment.metadata.userLastname},\n\nGreat news! Your ${payment.tokenPackage.tokens} tokens for ${payment.metadata.gameName} at ${payment.location} have been automatically added to your account and are now ready to use!\n\nToken Details:\n- Game: ${payment.metadata.gameName}\n- Tokens: ${payment.tokenPackage.tokens}\n- Location: ${payment.location}\n- Added at: ${new Date().toLocaleString()}\n\nEnjoy your game!\n\nBest regards,\nHCCC Game Room Team`;

      await sendEmail({
        to: payment.metadata.userEmail,
        subject: subject,
        html: html,
        text: text
      });

      console.log(`Sent token available email to ${payment.metadata.userEmail}`);
    } catch (error) {
      console.error('Failed to send token available email:', error);
    }
  }

  // Manual trigger for testing
  async triggerManualProcessing(location) {
    console.log(`Manual trigger for ${location} token processing`);
    return await this.processScheduledTokensForLocation(location);
  }

  // Get cron job status
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      jobs: {
        fixFailedPayments: '*/1 * * * * (every 1 minute)',
        cedarPark: '0 17 * * * (11:00 AM Texas time)',
        libertyHill: '0 16 * * * (10:00 AM Texas time)',
      }
    };
  }
}

module.exports = new CronService(); 