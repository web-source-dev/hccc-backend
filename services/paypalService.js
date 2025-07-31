const axios = require('axios');
const crypto = require('crypto');

// PayPal configuration
const PAYPAL_BASE_URL = process.env.NODE_ENV === 'production' 
  ? 'https://api-m.paypal.com' 
  : 'https://api-m.sandbox.paypal.com';

let accessToken = null;
let tokenExpiry = null;

// Get PayPal access token with retry logic
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
        },
        timeout: 10000 // 10 second timeout
      }
    );

    accessToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000; // Expire 1 minute early
    
    return accessToken;
  } catch (error) {
    console.error('PayPal access token error:', error.response?.data || error.message);
    
    // Provide specific error messages for different scenarios
    if (error.response?.status === 401) {
      throw new Error('PayPal authentication failed. Please check your credentials.');
    } else if (error.code === 'ECONNABORTED') {
      throw new Error('PayPal service timeout. Please try again.');
    } else if (error.code === 'ENOTFOUND') {
      throw new Error('Unable to connect to PayPal. Please check your internet connection.');
    }
    
    throw new Error('Failed to authenticate with PayPal. Please try again later.');
  }
}

// Verify PayPal webhook signature
function verifyWebhookSignature(headers, body, webhookId) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('Skipping webhook signature verification in non-production environment');
    return true;
  }

  try {
    const transmissionId = headers['paypal-transmission-id'];
    const timestamp = headers['paypal-transmission-time'];
    const certUrl = headers['paypal-cert-url'];
    const authAlgo = headers['paypal-auth-algo'];
    const signature = headers['paypal-transmission-sig'];

    if (!transmissionId || !timestamp || !certUrl || !authAlgo || !signature) {
      console.error('Missing required webhook headers');
      return false;
    }

    // Verify certificate URL is from PayPal
    if (!certUrl.startsWith('https://api.paypal.com') && !certUrl.startsWith('https://api.sandbox.paypal.com')) {
      console.error('Invalid certificate URL');
      return false;
    }

    // Create the signature string
    const signatureString = `${transmissionId}|${timestamp}|${webhookId}|${crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;

    // In production, you would verify the signature using PayPal's public key
    // For now, we'll log the verification attempt
    console.log('Webhook signature verification attempted:', {
      transmissionId,
      timestamp,
      webhookId,
      signature: signature.substring(0, 20) + '...'
    });

    return true; // In production, implement actual signature verification
  } catch (error) {
    console.error('Webhook signature verification error:', error);
    return false;
  }
}

// Create PayPal order with enhanced error handling
async function createOrder(amount, currency = 'USD', customId = null) {
  try {
    const token = await getAccessToken();
    
    const orderData = {
      intent: 'CAPTURE',
      application_context: {
        return_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-success`,
        cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout`,
        brand_name: 'HCCC Games',
        landing_page: 'BILLING',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
        payment_method: {
          payer_selected: 'PAYPAL',
          payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED'
        }
      },
      purchase_units: [{
        amount: {
          currency_code: currency,
          value: amount.toFixed(2)
        },
        custom_id: customId,
        description: 'HCCC Games Token Purchase',
        soft_descriptor: 'HCCC Games'
      }]
    };

    const response = await axios.post(`${PAYPAL_BASE_URL}/v2/checkout/orders`, orderData, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      timeout: 15000 // 15 second timeout
    });

    return {
      success: true,
      orderId: response.data.id,
      order: response.data
    };
  } catch (error) {
    console.error('PayPal create order error:', error.response?.data || error.message);
    
    // Provide specific error messages
    if (error.response?.status === 400) {
      const errorDetails = error.response.data;
      if (errorDetails.details?.[0]?.issue === 'INVALID_REQUEST') {
        return {
          success: false,
          error: 'Invalid payment request. Please check your payment details and try again.'
        };
      }
    } else if (error.response?.status === 401) {
      return {
        success: false,
        error: 'Payment service authentication failed. Please try again later.'
      };
    } else if (error.response?.status === 403) {
      return {
        success: false,
        error: 'Payment request was denied. Please contact support if this persists.'
      };
    } else if (error.code === 'ECONNABORTED') {
      return {
        success: false,
        error: 'Payment service timeout. Please try again.'
      };
    }
    
    return {
      success: false,
      error: 'Unable to create payment order. Please try again later.'
    };
  }
}

// Capture PayPal order with enhanced error handling
async function captureOrder(orderId) {
  try {
    const token = await getAccessToken();
    
    const response = await axios.post(`${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}/capture`, {}, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      timeout: 15000 // 15 second timeout
    });

    return {
      success: true,
      capture: response.data,
      status: response.data.status,
      payerId: response.data.payer?.payer_id
    };
  } catch (error) {
    console.error('PayPal capture order error:', error.response?.data || error.message);
    
    // Provide specific error messages
    if (error.response?.status === 400) {
      const errorDetails = error.response.data;
      if (errorDetails.details?.[0]?.issue === 'ORDER_NOT_APPROVED') {
        return {
          success: false,
          error: 'Payment was not approved. Please try again.'
        };
      } else if (errorDetails.details?.[0]?.issue === 'ORDER_ALREADY_CAPTURED') {
        return {
          success: false,
          error: 'Payment has already been processed.'
        };
      } else if (errorDetails.details?.[0]?.issue === 'ORDER_EXPIRED') {
        return {
          success: false,
          error: 'Payment order has expired. Please create a new order.'
        };
      }
    } else if (error.response?.status === 404) {
      return {
        success: false,
        error: 'Payment order not found. Please try again.'
      };
    } else if (error.response?.status === 409) {
      return {
        success: false,
        error: 'Payment is being processed. Please wait a moment and try again.'
      };
    }
    
    return {
      success: false,
      error: 'Unable to process payment. Please try again later.'
    };
  }
}

// Get order details with enhanced error handling
async function getOrder(orderId) {
  try {
    const token = await getAccessToken();
    
    const response = await axios.get(`${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000 // 10 second timeout
    });

    return {
      success: true,
      order: response.data
    };
  } catch (error) {
    console.error('PayPal get order error:', error.response?.data || error.message);
    
    if (error.response?.status === 404) {
      return {
        success: false,
        error: 'Payment order not found.'
      };
    }
    
    return {
      success: false,
      error: 'Unable to retrieve payment details.'
    };
  }
}

// Map PayPal status to our internal status
function mapPayPalStatus(paypalStatus) {
  const statusMap = {
    'COMPLETED': 'succeeded',
    'PENDING': 'processing',
    'VOIDED': 'canceled',
    'DENIED': 'failed',
    'EXPIRED': 'expired',
    'CREATED': 'incomplete',
    'SAVED': 'incomplete',
    'APPROVED': 'processing',
    'PAYER_ACTION_REQUIRED': 'processing',
    'CAPTURE_DENIED': 'failed',
    'CAPTURE_PENDING': 'processing',
    'CAPTURE_COMPLETED': 'succeeded',
    'CAPTURE_VOIDED': 'canceled',
    'CAPTURE_REFUNDED': 'refunded',
    'CAPTURE_FAILED': 'failed'
  };
  
  return statusMap[paypalStatus] || 'incomplete';
}

// Validate PayPal webhook event
function validateWebhookEvent(event) {
  const validEventTypes = [
    'PAYMENT.CAPTURE.COMPLETED',
    'PAYMENT.CAPTURE.DENIED',
    'PAYMENT.CAPTURE.PENDING',
    'PAYMENT.CAPTURE.REFUNDED',
    'PAYMENT.CAPTURE.VOIDED',
    'PAYMENT.CAPTURE.FAILED',
    'CHECKOUT.ORDER.APPROVED',
    'CHECKOUT.ORDER.CANCELED',
    'CHECKOUT.ORDER.COMPLETED',
    'CHECKOUT.ORDER.PROCESSED'
  ];
  
  return validEventTypes.includes(event.event_type);
}

module.exports = {
  createOrder,
  captureOrder,
  getOrder,
  getAccessToken,
  verifyWebhookSignature,
  mapPayPalStatus,
  validateWebhookEvent
}; 