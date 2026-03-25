// scripts/test-smtp.js
require('dotenv').config();
const nodemailer = require('nodemailer');

async function main() {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_SECURE,
    SMTP_USER,
    SMTP_PASS,
    SMTP_FROM,
  } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.error('Missing SMTP configuration. Please set SMTP_HOST, SMTP_USER, SMTP_PASS (and optionally SMTP_PORT, SMTP_SECURE, SMTP_FROM).');
    process.exit(1);
  }

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT ? parseInt(SMTP_PORT, 10) : 587,
    secure: SMTP_SECURE === 'true',
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  try {
    console.log('Verifying SMTP connection...');
    await transport.verify();
    console.log('SMTP connection OK.');

    const info = await transport.sendMail({
      from: SMTP_FROM || `OrgIT <${SMTP_USER}>`,
      to: 'prasanthkathi05@gmail.com',
      subject: 'OrgIT SMTP Test',
      text: 'This is a test email from OrgIT SMTP test script.',
      html: '<p>This is a <strong>test email</strong> from OrgIT SMTP test script.</p>',
    });

    console.log('Test email sent.');
    console.log('Message ID:', info.messageId);
  } catch (err) {
    console.error('SMTP test failed:');
    console.error(err);
    process.exit(1);
  }
}

main();