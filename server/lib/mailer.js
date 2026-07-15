'use strict';
const nodemailer = require('nodemailer');

function createTransport() {
  const isLocal = !process.env.SMTP_PASS || process.env.SMTP_HOST === 'localhost';
  if (isLocal) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'localhost',
      port: Number(process.env.SMTP_PORT) || 25,
      secure: false,
      ignoreTLS: true,
    });
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendPasswordReset({ to, resetUrl, userName }) {
  const from = `Beauty OS <${process.env.SMTP_USER || 'noreply@proonline.com.ua'}>`;
  const transport = createTransport();
  await transport.sendMail({
    from,
    to,
    subject: 'Сброс пароля — Beauty Operations OS',
    html: `
      <p>Привет, ${userName || ''}!</p>
      <p>Для сброса пароля перейдите по ссылке:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>Ссылка действительна 1 час.</p>
      <p style="color:#999;font-size:12px">Если вы не запрашивали сброс пароля — просто проигнорируйте это письмо.</p>
    `,
  });
}

module.exports = { sendPasswordReset };
