const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { query } = require('../lib/db');
const { sign, setTokenCookie, clearTokenCookie } = require('../lib/jwt');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 12;

function getMailer() {
  const isLocal = !process.env.SMTP_PASS || process.env.SMTP_HOST === 'localhost';
  if (isLocal) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'localhost',
      port: Number(process.env.SMTP_PORT) || 25,
      secure: false,
      ignoreTLS: true
    });
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Заполните все поля' });
    if (password.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });

    const exists = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(409).json({ error: 'Этот email уже зарегистрирован' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email.toLowerCase(), hash, name.trim()]
    );
    const user = rows[0];

    await query(
      'INSERT INTO profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [user.id]
    );

    const token = sign({ userId: user.id, email: user.email });
    setTokenCookie(res, token);

    res.json({ user: { id: user.id, email: user.email, name: user.name, has_access: false } });
  } catch (err) {
    console.error('[REGISTER]', err.message);
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Введите email и пароль' });

    const { rows } = await query(
      `SELECT u.id, u.email, u.name, u.password,
              p.has_access, p.is_admin, p.salon_name
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.email = $1`,
      [email.toLowerCase()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Неверный email или пароль' });

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });

    await query(
      'UPDATE users SET last_login_at = NOW(), login_count = COALESCE(login_count, 0) + 1 WHERE id = $1',
      [user.id]
    );

    const token = sign({ userId: user.id, email: user.email });
    setTokenCookie(res, token);

    res.json({ user: { id: user.id, email: user.email, name: user.name, has_access: user.has_access || false } });
  } catch (err) {
    console.error('[LOGIN]', err.message);
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearTokenCookie(res);
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ user: { id: u.id, email: u.email, name: u.name, has_access: u.has_access || false } });
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Введите email' });

    const { rows } = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    // Отвечаем одинаково независимо от того, найден ли пользователь (защита от перебора)
    if (!rows.length) return res.json({ success: true });

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 час

    await query(
      'UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3',
      [token, expires, rows[0].id]
    );

    const resetUrl = `${process.env.APP_URL}/reset-password?token=${token}`;

    if (process.env.SMTP_HOST) {
      const mailer = getMailer();
      await mailer.sendMail({
        from: `Beauty OS <${process.env.SMTP_USER || 'noreply@beauty.proonline.com.ua'}>`,
        to: email,
        subject: 'Сброс пароля — Beauty Operations OS',
        html: `<p>Для сброса пароля перейдите по ссылке:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>Ссылка действительна 1 час.</p>`
      });
    } else {
      console.log('[RESET LINK]', resetUrl);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[FORGOT PASSWORD]', err.message);
    res.status(500).json({ error: 'Ошибка отправки письма' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Недостаточно данных' });
    if (password.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });

    const { rows } = await query(
      'SELECT id FROM users WHERE reset_token = $1 AND reset_expires > NOW()',
      [token]
    );
    if (!rows.length) return res.status(400).json({ error: 'Ссылка недействительна или истекла' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    await query(
      'UPDATE users SET password = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2',
      [hash, rows[0].id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[RESET PASSWORD]', err.message);
    res.status(500).json({ error: 'Ошибка сброса пароля' });
  }
});

// GET /api/auth/impersonate?token=xxx — client view mode
router.get('/impersonate', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const { rows } = await query(
      `DELETE FROM impersonate_tokens WHERE token = $1 AND expires_at > NOW() RETURNING user_id`,
      [token]
    );
    if (!rows.length) return res.status(401).json({ error: 'Токен недействителен или истёк' });

    const { rows: userRows } = await query(
      `SELECT u.id, u.email, u.name, p.has_access, p.is_admin, p.salon_name
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
      [rows[0].user_id]
    );
    if (!userRows.length) return res.status(404).json({ error: 'Пользователь не найден' });

    const user = userRows[0];
    const jwtToken = sign({ userId: user.id, email: user.email });
    setTokenCookie(res, jwtToken);
    res.json({ user: { id: user.id, email: user.email, name: user.name, has_access: user.has_access || false } });
  } catch (err) {
    console.error('[IMPERSONATE]', err.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

module.exports = router;
