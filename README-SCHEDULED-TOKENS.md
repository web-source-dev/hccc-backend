# Scheduled Token Processing System

## Overview

The HCCC Game Room now includes an automated token processing system that handles delayed token additions based on location-specific time restrictions.

## Time Restrictions

### Cedar Park Location
- **Cutoff Time**: 3:00 AM
- **Token Addition Time**: 11:00 AM (next business day)
- **Logic**: Tokens purchased after 3 AM are scheduled for addition at 11 AM the next day

### Liberty Hill Location
- **Cutoff Time**: 11:00 PM
- **Token Addition Time**: 10:00 AM (next business day)
- **Logic**: Tokens purchased after 11 PM are scheduled for addition at 10 AM the next day

## How It Works

### 1. Payment Processing
When a payment is confirmed:
- The system checks the current time and location
- If the purchase is made during restricted hours, tokens are marked for delayed addition
- Payment metadata includes `tokensScheduledFor` and `tokensAdded` fields
- Users receive email notifications about the delay

### 2. Scheduled Processing
- The server runs a scheduled job every 5 minutes to check for tokens ready to be added
- Tokens are automatically added to user balances when the scheduled time arrives
- Users receive email notifications when tokens are successfully added

### 3. Database Schema Updates
The Payment model includes new fields:
- `tokensScheduledFor`: Date when tokens should be added
- `tokensAdded`: Boolean indicating if tokens have been added
- `metadata.timeRestriction`: Information about the time restriction applied

## Files Modified

### Backend
- `models/Payment.js`: Added scheduled token processing methods
- `routes/payments.js`: Updated payment confirmation logic
- `server.js`: Added scheduled job processing
- `scripts/process-scheduled-tokens.js`: Standalone script for token processing

### Frontend
- `lib/auth.ts`: Updated token balance interfaces
- `lib/payments.ts`: Updated Payment interface
- `app/profile/page.tsx`: Added pending token display
- `app/payment-success/page.tsx`: Updated to show scheduled token information

## Running the System

### Automatic Processing (Recommended)
The scheduled processing runs automatically when the server starts:
```bash
npm start
```

### Manual Processing
To manually process scheduled tokens:
```bash
npm run process-scheduled-tokens
```

### Cron Job Setup (Optional)
For production environments, you can set up a cron job to run the script every 5 minutes:
```bash
*/5 * * * * cd /path/to/backend && npm run process-scheduled-tokens
```

## User Experience

### During Purchase
- Users see warnings about time restrictions during checkout
- Clear messaging about when tokens will be available
- Payment confirmation includes scheduled addition time

### In Profile
- Users can see both available and pending tokens
- Pending tokens are clearly marked with scheduled addition times
- Visual indicators show token status

### Email Notifications
- Purchase confirmation emails include token availability timing
- Notification emails when tokens are successfully added
- Admin notifications include token processing status

## Monitoring

### Logs
The system logs token processing activities:
- Scheduled token counts
- Processing success/failure
- User notifications sent

### Database Queries
Monitor scheduled tokens:
```javascript
// Find all pending token additions
db.payments.find({
  status: 'succeeded',
  tokensScheduledFor: { $exists: true, $ne: null },
  tokensAdded: false
})

// Find tokens ready for processing
db.payments.find({
  status: 'succeeded',
  tokensScheduledFor: { $lte: new Date() },
  tokensAdded: false
})
```

## Troubleshooting

### Common Issues
1. **Tokens not being added**: Check server logs for processing errors
2. **Email notifications not sent**: Verify email configuration
3. **Scheduled times incorrect**: Ensure server timezone is set correctly

### Debug Commands
```bash
# Check scheduled tokens
npm run process-scheduled-tokens

# View server logs
tail -f logs/app.log

# Check database for pending tokens
mongo --eval "db.payments.find({tokensAdded: false, tokensScheduledFor: {\$exists: true}})"
```

## Future Enhancements

- Webhook notifications for token additions
- Admin dashboard for monitoring scheduled tokens
- Customizable time restrictions per location
- Bulk token processing for multiple users 