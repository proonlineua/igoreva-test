'use strict';
const express  = require('express');
const crypto   = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { query }  = require('../lib/db');

const router = express.Router();
router.use(requireAuth);

const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'beautyos_director_bot';

// ─── GET /api/bot/status ─────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const { rows: sub } = await query(
      `SELECT plan, daily_enabled, daily_time, weekly_enabled, monthly_enabled,
              alerts_enabled, alert_load_threshold, alert_revenue_drop,
              alert_cancellations, timezone, sub_expires_at
       FROM bot_subscriptions WHERE user_id = $1`,
      [req.user.id]
    );
    const { rows: recipients } = await query(
      `SELECT id, chat_id, telegram_username, display_name, role,
              receives_daily, receives_weekly, receives_monthly, receives_alerts,
              is_active, last_message_at
       FROM bot_recipients WHERE user_id = $1 ORDER BY joined_at`,
      [req.user.id]
    );
    const { rows: logs } = await query(
      `SELECT report_type, status, created_at FROM bot_report_log
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [req.user.id]
    );
    res.json({
      subscription: sub[0] || null,
      recipients,
      recent_logs: logs,
      bot_username: BOT_USERNAME,
    });
  } catch (err) {
    console.error('[BOT STATUS]', err.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ─── POST /api/bot/link ──────────────────────────────────────────────────────
// Generate a one-time link for connecting Telegram
router.post('/link', async (req, res) => {
  try {
    // Check bot access
    const { rows: profile } = await query(
      'SELECT has_bot_access FROM profiles WHERE user_id = $1',
      [req.user.id]
    );
    if (!profile[0]?.has_bot_access) {
      return res.status(403).json({ error: 'Для подключения бота нужна подписка AI-директор', code: 'BOT_ACCESS_REQUIRED' });
    }

    // Generate secure token
    const token = crypto.randomBytes(20).toString('hex');

    // Save token (expires in 24h)
    await query(
      `INSERT INTO bot_link_tokens (user_id, token)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, token]
    );

    const link = `https://t.me/${BOT_USERNAME}?start=${token}`;
    res.json({ success: true, link, token, expires_in: '24 часа' });
  } catch (err) {
    console.error('[BOT LINK]', err.message);
    res.status(500).json({ error: 'Ошибка генерации ссылки' });
  }
});

// ─── PUT /api/bot/settings ───────────────────────────────────────────────────
router.put('/settings', async (req, res) => {
  try {
    const {
      daily_enabled, daily_time,
      weekly_enabled, monthly_enabled,
      alerts_enabled, alert_load_threshold,
      alert_revenue_drop, alert_cancellations,
      timezone
    } = req.body;

    await query(
      `INSERT INTO bot_subscriptions
         (user_id, plan, daily_enabled, daily_time, weekly_enabled, monthly_enabled,
          alerts_enabled, alert_load_threshold, alert_revenue_drop, alert_cancellations, timezone)
       VALUES ($1,'inactive',$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id) DO UPDATE SET
         daily_enabled = COALESCE($2, bot_subscriptions.daily_enabled),
         daily_time = COALESCE($3, bot_subscriptions.daily_time),
         weekly_enabled = COALESCE($4, bot_subscriptions.weekly_enabled),
         monthly_enabled = COALESCE($5, bot_subscriptions.monthly_enabled),
         alerts_enabled = COALESCE($6, bot_subscriptions.alerts_enabled),
         alert_load_threshold = COALESCE($7, bot_subscriptions.alert_load_threshold),
         alert_revenue_drop = COALESCE($8, bot_subscriptions.alert_revenue_drop),
         alert_cancellations = COALESCE($9, bot_subscriptions.alert_cancellations),
         timezone = COALESCE($10, bot_subscriptions.timezone),
         updated_at = NOW()`,
      [
        req.user.id,
        daily_enabled, daily_time,
        weekly_enabled, monthly_enabled,
        alerts_enabled, alert_load_threshold,
        alert_revenue_drop, alert_cancellations,
        timezone
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[BOT SETTINGS]', err.message);
    res.status(500).json({ error: 'Ошибка сохранения настроек' });
  }
});

// ─── DELETE /api/bot/recipients/:id ─────────────────────────────────────────
router.delete('/recipients/:id', async (req, res) => {
  try {
    await query(
      `UPDATE bot_recipients SET is_active = false
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ─── POST /api/bot/test ──────────────────────────────────────────────────────
// Send a test report right now
router.post('/test', async (req, res) => {
  try {
    const { type } = req.body;
    const { sendReportToUser } = require('../bot');
    const result = await sendReportToUser(req.user.id, type || 'daily');
    if (result.sent === 0) {
      return res.status(400).json({ error: 'Нет подключённых получателей или нет данных для отчёта' });
    }
    res.json({ success: true, sent: result.sent });
  } catch (err) {
    console.error('[BOT TEST]', err.message);
    res.status(500).json({ error: 'Ошибка отправки тестового отчёта' });
  }
});

module.exports = router;
