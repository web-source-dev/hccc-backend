/**
 * Time restriction utilities for token scheduling
 * Handles business hours logic for Cedar Park and Liberty Hill locations
 */

/**
 * Check if a payment should have tokens delayed based on Texas time
 * @param {string} location - The location name
 * @param {Date} paymentTime - The time of payment (optional, defaults to now)
 * @returns {Object} - { shouldDelay: boolean, scheduledTime: Date|null, message: string }
 */
function checkTimeRestriction(location, paymentTime = new Date()) {
  // Convert to Texas time (Central Time)
  const texasTime = new Date(paymentTime.toLocaleString("en-US", {timeZone: "America/Chicago"}));
  const currentHour = texasTime.getHours();
  const currentMinute = texasTime.getMinutes();
  const currentTime = currentHour * 60 + currentMinute;
  
  const normalizedLocation = location.toLowerCase().replace(/[-\s]/g, '');
  let shouldDelay = false;
  let scheduledTime = null;
  let message = '';
  
  if (normalizedLocation.includes('cedarpark') || normalizedLocation.includes('cedar')) {
    // Cedar Park: Schedule tokens if payment is between 3 AM to 11 AM Texas time
    if (currentTime >= 180 && currentTime < 660) { // 3 AM to 11 AM
      shouldDelay = true;
      // Schedule for next day at 11 AM Texas time
      scheduledTime = new Date(texasTime);
      scheduledTime.setDate(scheduledTime.getDate() + 1);
      scheduledTime.setHours(11, 0, 0, 0);
      message = 'Disclaimer: Tokens bought after closing will be added the next business day.';
    }
  } else if (normalizedLocation.includes('libertyhill') || normalizedLocation.includes('liberty')) {
    // Liberty Hill: Schedule tokens if payment is between 11 PM to 10 AM Texas time
    if (currentTime >= 1380 || currentTime < 600) { // 11 PM to 10 AM (crosses midnight)
      shouldDelay = true;
      // Schedule for next day at 10 AM Texas time
      scheduledTime = new Date(texasTime);
      if (currentTime >= 1380) {
        // If it's after 11 PM, schedule for next day
        scheduledTime.setDate(scheduledTime.getDate() + 1);
      }
      scheduledTime.setHours(10, 0, 0, 0);
      message = 'Disclaimer: Tokens bought after closing will be added the next business day.';
    }
  }
  
  return {
    shouldDelay,
    scheduledTime,
    message,
    currentTexasTime: texasTime
  };
}

/**
 * Get time restriction info for display purposes
 * @param {string} location - The location name
 * @returns {Object|null} - Time restriction object or null if no restriction
 */
function getTimeRestrictionInfo(location) {
  const restriction = checkTimeRestriction(location);
  
  if (!restriction.shouldDelay) {
    return null;
  }
  
  const normalizedLocation = location.toLowerCase().replace(/[-\s]/g, '');
  
  if (normalizedLocation.includes('cedarpark') || normalizedLocation.includes('cedar')) {
    return {
      type: 'cedar_park',
      message: restriction.message,
      cutoffTime: '3:00 AM - 11:00 AM'
    };
  } else if (normalizedLocation.includes('libertyhill') || normalizedLocation.includes('liberty')) {
    return {
      type: 'liberty_hill',
      message: restriction.message,
      cutoffTime: '11:00 PM - 10:00 AM'
    };
  }
  
  return null;
}

/**
 * Get current Texas time
 * @returns {Date} - Current time in Texas (Central Time)
 */
function getCurrentTexasTime() {
  return new Date(new Date().toLocaleString("en-US", {timeZone: "America/Chicago"}));
}

module.exports = {
  checkTimeRestriction,
  getTimeRestrictionInfo,
  getCurrentTexasTime
}; 