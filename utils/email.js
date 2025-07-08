const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.com',
  port: 465, // SSL port
  secure: true, // Use SSL
  auth: {
    user: process.env.EMAIL_FROM, // your Zoho email address
    pass: process.env.EMAIL_PASS, // your Zoho app password
  },
  requireTLS: true, // Require TLS/SSL
  authMethod: 'LOGIN', // Explicitly require authentication
});

async function sendEmail({ to, subject, text, html }) {
  const mailOptions = {
    from: process.env.EMAIL_FROM,
    to,
    subject,
    text,
    html,
  };
  return transporter.sendMail(mailOptions);
}

module.exports = { sendEmail }; 