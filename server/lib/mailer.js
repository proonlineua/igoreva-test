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

async function sendPaymentSuccess({ to, userName, salonName, amount, currency, orderRef }) {
  const from = `Beauty OS <${process.env.SMTP_USER || 'noreply@proonline.com.ua'}>`;
  const transport = createTransport();
  await transport.sendMail({
    from,
    to,
    subject: 'Оплата прошла успешно — Beauty Operations OS',
    html: `
      <p>Привет, ${userName || ''}!</p>
      <p>Оплата подтверждена. Доступ к платформе активирован на 3 месяца.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Салон:</td><td><b>${salonName || '—'}</b></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Сумма:</td><td><b>${amount} ${currency}</b></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Заказ:</td><td style="color:#999;font-size:12px">${orderRef}</td></tr>
      </table>
      <p><a href="${process.env.APP_URL || 'https://beauty.proonline.com.ua'}" style="background:#6c47ff;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px">Войти в систему</a></p>
      <p style="color:#999;font-size:12px">Если у вас есть вопросы — пишите нам в Telegram или на почту.</p>
    `,
  });
}

module.exports = { sendPasswordReset, sendPaymentSuccess };
