const paypal = require('@paypal/checkout-server-sdk');

// PayPal environment configuration
function environment() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (process.env.NODE_ENV === 'production') {
    return new paypal.core.LiveEnvironment(clientId, clientSecret);
  } else {
    return new paypal.core.SandboxEnvironment(clientId, clientSecret);
  }
}

// PayPal client
function client() {
  return new paypal.core.PayPalHttpClient(environment());
}

module.exports = { client }; 