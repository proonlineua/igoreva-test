'use strict';
const TelegramBot = require('node-telegram-bot-api');
const cron        = require('node-cron');
const { query }   = require('../lib/db');
const { generateReport, generateAlert, answerQuestion } = require('./reportGenerator');
const { collectData, hasData, checkAlerts } = require('./dataCollector');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let bot = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  if (!TOKEN) {
    console.log('[BOT] TELEGRAM_BOT_TOKEN not set — bot disabled');
    return null;
  }
  if (bot) return bot;

  bot = new TelegramBot(TOKEN, { polling: true });
  console.log('[BOT] Started polling');

  setupHandlers(bot);
  setupScheduler(bot);
  return bot;
}

// ─── Send helper ─────────────────────────────────────────────────────────────
async function sendMessage(chatId, text, opts = {}) {
  if (!bot) return;
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
  } catch (err) {
    console.error('[BOT SEND]', chatId, err.message);
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────
function setupHandlers(bot) {

  // /start — link Telegram account to Beauty OS user
  bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId   = msg.chat.id;
    const username = msg.from?.username || msg.from?.first_name || 'Unknown';
    const token    = (match[1] || '').trim();

    if (!token) {
      await sendMessage(chatId, `👋 Привет, *${username}*!\n\nЭто AI-директор Beauty OS.\n\nЧтобы подключить бота к вашему салону, перейдите в личный кабинет Beauty OS → Профиль → AI-директор и нажмите «Подключить Telegram».`);
      return;
    }

    // Validate token from impersonate_tokens or dedicated link tokens
    try {
      const { rows } = await query(
        `SELECT user_id FROM bot_link_tokens WHERE token = $1 AND expires_at > NOW()`,
        [token]
      );
      if (!rows.length) {
        await sendMessage(chatId, '❌ Ссылка недействительна или истекла. Сгенерируйте новую в личном кабинете.');
        return;
      }

      const userId = rows[0].user_id;

      // Load user profile and bot settings
      const { rows: userRows } = await query(
        `SELECT u.name, u.email, a.onboarding, bs.plan, bs.daily_time, bs.weekly_enabled, bs.monthly_enabled
         FROM users u
         LEFT JOIN audits a ON a.user_id = u.id
         LEFT JOIN bot_subscriptions bs ON bs.user_id = u.id
         WHERE u.id = $1`,
        [userId]
      );
      if (!userRows.length) {
        await sendMessage(chatId, '❌ Пользователь не найден.');
        return;
      }

      const user = userRows[0];
      const salon = user.onboarding || {};

      // Save recipient
      await query(
        `INSERT INTO bot_recipients (user_id, chat_id, telegram_username, display_name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, chat_id) DO UPDATE
           SET telegram_username = $3, is_active = true, last_message_at = NOW()`,
        [userId, chatId, username, msg.from?.first_name || username]
      );

      // Mark token as used
      await query('DELETE FROM bot_link_tokens WHERE token = $1', [token]);

      const salonName = salon.name || 'ваш салон';
      const plan = user.plan || 'inactive';
      const planLabel = plan === 'team' ? 'AI-директор Команда' : plan === 'pro' ? 'AI-директор Про' : 'базовый';

      await sendMessage(chatId,
        `✅ *Подключено!*\n\n` +
        `Салон: *${salonName}*\n` +
        `Тариф: ${planLabel}\n\n` +
        `Вы будете получать:\n` +
        `📊 Ежедневный отчёт в ${user.daily_time || '20:00'}\n` +
        `${user.weekly_enabled ? '📈 Еженедельный отчёт по пятницам\n' : ''}` +
        `${user.monthly_enabled ? '🗓 Ежемесячный отчёт 1-го числа\n' : ''}` +
        `\nМожете писать мне любые вопросы о вашем бизнесе!`
      );

    } catch (err) {
      console.error('[BOT START]', err.message);
      await sendMessage(chatId, '❌ Ошибка подключения. Попробуйте позже.');
    }
  });

  // /report — manual daily report request
  bot.onText(/\/report/, async (msg) => {
    await handleReportCommand(msg.chat.id, 'daily');
  });

  // /week — weekly report
  bot.onText(/\/week/, async (msg) => {
    await handleReportCommand(msg.chat.id, 'weekly');
  });

  // /month — monthly report
  bot.onText(/\/month/, async (msg) => {
    await handleReportCommand(msg.chat.id, 'monthly');
  });

  // /status — show connection status
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const { rows } = await query(
        `SELECT u.name, u.email, a.onboarding, bs.plan, bs.daily_time,
                p.has_bot_access, p.bot_expires_at
         FROM bot_recipients br
         JOIN users u ON u.id = br.user_id
         LEFT JOIN audits a ON a.user_id = u.id
         LEFT JOIN bot_subscriptions bs ON bs.user_id = br.user_id
         LEFT JOIN profiles p ON p.user_id = br.user_id
         WHERE br.chat_id = $1 AND br.is_active = true`,
        [chatId]
      );
      if (!rows.length) {
        await sendMessage(chatId, '❌ Этот чат не подключён к Beauty OS. Используйте ссылку из личного кабинета.');
        return;
      }
      const r = rows[0];
      const salon = r.onboarding || {};
      const expires = r.bot_expires_at ? new Date(r.bot_expires_at).toLocaleDateString('ru') : 'не ограничен';
      await sendMessage(chatId,
        `📋 *Статус подключения*\n\n` +
        `👤 Аккаунт: ${r.email}\n` +
        `🏠 Салон: ${salon.name || 'н/д'}, ${salon.city || ''}\n` +
        `📦 Тариф: ${r.plan || 'н/д'}\n` +
        `📅 Доступ до: ${expires}\n` +
        `⏰ Ежедневный отчёт: ${r.daily_time || '20:00'}`
      );
    } catch (err) {
      await sendMessage(chatId, '❌ Ошибка получения статуса.');
    }
  });

  // /help — command list
  bot.onText(/\/help/, async (msg) => {
    await sendMessage(msg.chat.id,
      `🤖 *AI-директор Beauty OS*\n\n` +
      `*Команды:*\n` +
      `/report — отчёт за сегодня\n` +
      `/week — отчёт за неделю\n` +
      `/month — отчёт за месяц\n` +
      `/status — статус подключения\n` +
      `/help — список команд\n\n` +
      `*Или просто напишите вопрос:*\n` +
      `_«Какая выручка за эту неделю?»_\n` +
      `_«Кто из мастеров самый прибыльный?»_\n` +
      `_«Что происходит с retention?»_`
    );
  });

  // Interactive — any text that's not a command
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const question = msg.text.trim();
    if (question.length < 3) return;

    await handleInteractiveQuestion(chatId, question);
  });
}

// ─── Report command handler ───────────────────────────────────────────────────
async function handleReportCommand(chatId, type) {
  try {
    const { rows } = await query(
      `SELECT br.user_id, u.name, a.onboarding, bs.plan, bs.daily_time,
              bs.weekly_enabled, bs.monthly_enabled, p.has_bot_access
       FROM bot_recipients br
       JOIN users u ON u.id = br.user_id
       LEFT JOIN audits a ON a.user_id = u.id
       LEFT JOIN bot_subscriptions bs ON bs.user_id = br.user_id
       LEFT JOIN profiles p ON p.user_id = br.user_id
       WHERE br.chat_id = $1 AND br.is_active = true`,
      [chatId]
    );

    if (!rows.length) {
      await sendMessage(chatId, '❌ Чат не подключён к Beauty OS.');
      return;
    }

    const r = rows[0];
    if (!r.has_bot_access) {
      await sendMessage(chatId, '❌ Для доступа к отчётам нужна подписка AI-директор. Оформите в личном кабинете Beauty OS.');
      return;
    }

    const salon = r.onboarding || {};
    const dataOk = await hasData(r.user_id);
    if (!dataOk) {
      await sendMessage(chatId, '⚠️ Нет данных для отчёта. Введите метрики в личном кабинете Beauty OS → Профиль → Данные бизнеса.');
      return;
    }

    await sendMessage(chatId, '⏳ Генерирую отчёт...');

    const data   = await collectData(r.user_id, type);
    const report = await generateReport({ type, salon, data });

    if (!report) {
      await sendMessage(chatId, '❌ Не удалось сгенерировать отчёт. Попробуйте позже.');
      return;
    }

    // Add quick action buttons
    const keyboard = {
      inline_keyboard: [
        [
          { text: '📊 Детали', callback_data: `detail_${type}` },
          { text: '💡 Что делать?', callback_data: `advice_${type}` },
        ]
      ]
    };

    await sendMessage(chatId, report, { reply_markup: keyboard });

    // Log
    await query(
      `INSERT INTO bot_report_log (user_id, chat_id, report_type, period_date, status)
       VALUES ($1,$2,$3,CURRENT_DATE,'sent')`,
      [r.user_id, chatId, type]
    ).catch(() => {});

    await query(
      'UPDATE bot_recipients SET last_message_at = NOW() WHERE chat_id = $1',
      [chatId]
    ).catch(() => {});

  } catch (err) {
    console.error('[REPORT CMD]', err.message);
    await sendMessage(chatId, '❌ Ошибка генерации отчёта.');
  }
}

// ─── Interactive question handler ─────────────────────────────────────────────
async function handleInteractiveQuestion(chatId, question) {
  try {
    const { rows } = await query(
      `SELECT br.user_id, a.onboarding, bs.plan, p.has_bot_access
       FROM bot_recipients br
       LEFT JOIN audits a ON a.user_id = br.user_id
       LEFT JOIN bot_subscriptions bs ON bs.user_id = br.user_id
       LEFT JOIN profiles p ON p.user_id = br.user_id
       WHERE br.chat_id = $1 AND br.is_active = true`,
      [chatId]
    );

    if (!rows.length) return;
    const r = rows[0];

    // Interactive only for Team plan
    if (r.plan !== 'team' || !r.has_bot_access) {
      await sendMessage(chatId,
        '💬 Интерактивный режим доступен на тарифе *AI-директор Команда*.\n' +
        'Для отчётов используйте: /report /week /month'
      );
      return;
    }

    await sendMessage(chatId, '🤔 Думаю...');
    const salon  = r.onboarding || {};
    const data   = await collectData(r.user_id, 'monthly');
    const answer = await answerQuestion({ question, salon, data });
    await sendMessage(chatId, answer || '❌ Не удалось получить ответ.');

    // Log
    await query(
      `INSERT INTO bot_report_log (user_id, chat_id, report_type, status)
       VALUES ($1,$2,'interactive','sent')`,
      [r.user_id, chatId]
    ).catch(() => {});

  } catch (err) {
    console.error('[INTERACTIVE]', err.message);
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
function setupScheduler(bot) {

  // Daily reports — 20:00 every day
  cron.schedule('0 20 * * *', async () => {
    console.log('[BOT CRON] Daily reports...');
    await sendScheduledReports('daily');
  }, { timezone: 'Europe/Kiev' });

  // Weekly reports — Friday 18:00
  cron.schedule('0 18 * * 5', async () => {
    console.log('[BOT CRON] Weekly reports...');
    await sendScheduledReports('weekly');
  }, { timezone: 'Europe/Kiev' });

  // Monthly reports — 1st of month 09:00
  cron.schedule('0 9 1 * *', async () => {
    console.log('[BOT CRON] Monthly reports...');
    await sendScheduledReports('monthly');
  }, { timezone: 'Europe/Kiev' });

  // Alerts check — 14:00 every day
  cron.schedule('0 14 * * *', async () => {
    console.log('[BOT CRON] Checking alerts...');
    await sendAlerts();
  }, { timezone: 'Europe/Kiev' });
}

async function sendScheduledReports(type) {
  try {
    // Get all active subscribers with bot access
    const { rows } = await query(
      `SELECT br.user_id, br.chat_id, a.onboarding, bs.plan,
              bs.daily_enabled, bs.weekly_enabled, bs.monthly_enabled
       FROM bot_recipients br
       JOIN bot_subscriptions bs ON bs.user_id = br.user_id
       JOIN profiles p ON p.user_id = br.user_id
       LEFT JOIN audits a ON a.user_id = br.user_id
       WHERE br.is_active = true
         AND p.has_bot_access = true
         AND bs.plan IN ('pro','team')
         AND (bs.sub_expires_at IS NULL OR bs.sub_expires_at > NOW())`
    );

    console.log(`[BOT CRON] ${type}: ${rows.length} recipients`);

    for (const r of rows) {
      // Check if this type is enabled for this user
      if (type === 'daily'   && !r.daily_enabled)   continue;
      if (type === 'weekly'  && !r.weekly_enabled)   continue;
      if (type === 'monthly' && !r.monthly_enabled)  continue;
      // Monthly only for Team plan
      if (type === 'monthly' && r.plan !== 'team')   continue;

      try {
        const salon  = r.onboarding || {};
        const dataOk = await hasData(r.user_id);
        if (!dataOk) continue;

        const data   = await collectData(r.user_id, type);
        const report = await generateReport({ type, salon, data });
        if (!report) continue;

        await sendMessage(r.chat_id, report);

        await query(
          `INSERT INTO bot_report_log (user_id, chat_id, report_type, period_date, status)
           VALUES ($1,$2,$3,CURRENT_DATE,'sent')`,
          [r.user_id, r.chat_id, type]
        ).catch(() => {});

        // Rate limit: don't spam Claude API
        await new Promise(r => setTimeout(r, 2000));

      } catch (err) {
        console.error(`[BOT CRON] Error for ${r.chat_id}:`, err.message);
        await query(
          `INSERT INTO bot_report_log (user_id, chat_id, report_type, status, error)
           VALUES ($1,$2,$3,'failed',$4)`,
          [r.user_id, r.chat_id, type, err.message]
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[BOT CRON] Fatal:', err.message);
  }
}

async function sendAlerts() {
  try {
    const { rows } = await query(
      `SELECT br.user_id, br.chat_id, a.onboarding, bs.alert_load_threshold,
              bs.alert_revenue_drop, bs.alert_cancellations, bs.alerts_enabled
       FROM bot_recipients br
       JOIN bot_subscriptions bs ON bs.user_id = br.user_id
       JOIN profiles p ON p.user_id = br.user_id
       LEFT JOIN audits a ON a.user_id = br.user_id
       WHERE br.is_active = true
         AND p.has_bot_access = true
         AND bs.alerts_enabled = true
         AND bs.plan IN ('pro','team')`
    );

    for (const r of rows) {
      try {
        const alerts = await checkAlerts(r.user_id, r);
        const salon  = r.onboarding || {};

        for (const alert of alerts) {
          const text = await generateAlert({ type: alert.type, salon, data: alert.data, threshold: alert.threshold });
          if (text) {
            await sendMessage(r.chat_id, `⚠️ *Алерт*\n\n${text}`);
            await new Promise(r => setTimeout(r, 1500));
          }
        }
      } catch (err) {
        console.error(`[BOT ALERTS] ${r.chat_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[BOT ALERTS] Fatal:', err.message);
  }
}

// ─── External: send report to specific user (from admin panel) ────────────────
async function sendReportToUser(userId, type) {
  try {
    const { rows } = await query(
      `SELECT br.chat_id, a.onboarding FROM bot_recipients br
       LEFT JOIN audits a ON a.user_id = br.user_id
       WHERE br.user_id = $1 AND br.is_active = true`,
      [userId]
    );
    if (!rows.length) return { sent: 0 };

    const salon = rows[0].onboarding || {};
    const data  = await collectData(userId, type);
    const report = await generateReport({ type, salon, data });
    if (!report) return { sent: 0 };

    for (const r of rows) {
      await sendMessage(r.chat_id, report);
    }
    return { sent: rows.length };
  } catch (err) {
    console.error('[SEND TO USER]', err.message);
    return { sent: 0, error: err.message };
  }
}

module.exports = { init, sendMessage, sendReportToUser };
