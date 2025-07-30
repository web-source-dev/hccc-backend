const axios = require('axios');

// PayPal configuration
const PAYPAL_BASE_URL = process.env.NODE_ENV === 'production' 
  ? 'https://api-m.paypal.com' 
  : 'https://api-m.sandbox.paypal.com';

let accessToken = null;
let tokenExpiry = null;

// Get PayPal access token
async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }

  try {
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
    
    const response = await axios.post(`${PAYPAL_BASE_URL}/v1/oauth2/token`, 
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    accessToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000; // Expire 1 minute early
    
    return accessToken;
  } catch (error) {
    console.error('PayPal access token error:', error.response?.data || error.message);
    throw new Error('Failed to get PayPal access token');
  }
}

// Create PayPal order
async function createOrder(amount, currency = 'USD', customId = null) {
  try {
    const token = await getAccessToken();
    
    const response = await axios.post(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
      intent: 'CAPTURE',
      application_context: {
        return_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-success`,
        cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout`,
        brand_name: 'HCCC Games',
        landing_page: 'BILLING',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING'
      },
      purchase_units: [{
        amount: {
          currency_code: currency,
          value: amount.toFixed(2)
        },
        custom_id: customId,
        description: 'HCCC Games Token Purchase'
      }]
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      }
    });

    return {
      success: true,
      orderId: response.data.id,
      order: response.data
    };
  } catch (error) {
    console.error('PayPal create order error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message
    };
  }
}

// Capture PayPal order
async function captureOrder(orderId) {
  try {
    const token = await getAccessToken();
    
    const response = await axios.post(`${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}/capture`, {}, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      }
    });

    return {
      success: true,
      capture: response.data,
      status: response.data.status,
      payerId: response.data.payer?.payer_id
    };
  } catch (error) {
    console.error('PayPal capture order error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message
    };
  }
}

// Get order details
async function getOrder(orderId) {
  try {
    const token = await getAccessToken();
    
    const response = await axios.get(`${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    return {
      success: true,
      order: response.data
    };
  } catch (error) {
    console.error('PayPal get order error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message
    };
  }
}

module.exports = {
  createOrder,
  captureOrder,
  getOrder
}; 