'use strict';
const cron = require('node-cron');
const { query } = require('../lib/db');
const { syncService } = require('./crmConnectors');

// ─── Sync all active integrations for one user ────────────────────────────────
async function syncUserIntegrations(userId) {
  const { rows } = await query(
    `SELECT service, api_key, api_secret, company_id, extra
     FROM integrations
     WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );

  const results = [];
  for (const row of rows) {
    try {
      const metrics = await syncService(
        row.service,
        { apiKey: row.api_key, apiSecret: row.api_secret, companyLogin: row.extra?.company_login },
        row.company_id,
        row.extra || {}
      );

      if (!metrics?.revenue && !metrics?.visits) continue;

      const period = metrics.period || new Date().toISOString().slice(0, 7);

      // Save to manual_metrics
      await query(
        `INSERT INTO manual_metrics
           (user_id, period, period_type, data, revenue, visits, avg_check, new_clients)
         VALUES ($1,$2,'month',$3,$4,$5,$6,$7)
         ON CONFLICT (user_id, period, period_type) DO UPDATE
           SET data=$3, revenue=$4, visits=$5, avg_check=$6, new_clients=$7, updated_at=NOW()`,
        [
          userId, period,
          JSON.stringify({ ...metrics, auto_synced_at: new Date().toISOString() }),
          metrics.revenue || null,
          metrics.visits  || null,
          metrics.avg_check || null,
          metrics.new_clients || null,
        ]
      );

      // Save today's data to cached_metrics
      if (metrics.today) {
        const mastersJSON = metrics.masters?.length
          ? JSON.stringify({ masters: metrics.masters })
          : '{}';

        await query(
          `INSERT INTO cached_metrics
             (user_id, date, source, metrics, revenue, visits, avg_check, new_clients)
           VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, date) DO UPDATE
             SET source=$2, metrics=$3, revenue=$4, visits=$5, avg_check=$6,
                 new_clients=$7`,
          [
            userId, row.service, mastersJSON,
            metrics.today.revenue  || null,
            metrics.today.visits   || null,
            metrics.today.avg_check || null,
            metrics.today.new_clients || null,
          ]
        );
      }

      // Mark sync success
      await query(
        `UPDATE integrations
         SET last_sync_at=NOW(), last_error=NULL, error_count=0, updated_at=NOW()
         WHERE user_id=$1 AND service=$2`,
        [userId, row.service]
      );

      results.push({ service: row.service, ok: true, revenue: metrics.revenue, visits: metrics.visits });

    } catch (err) {
      console.error(`[AUTO SYNC] user=${userId} service=${row.service}:`, err.message);

      await query(
        `UPDATE integrations
         SET last_error=$1, error_count=error_count+1, updated_at=NOW()
         WHERE user_id=$2 AND service=$3`,
        [err.message.slice(0, 500), userId, row.service]
      ).catch(() => {});

      results.push({ service: row.service, ok: false, error: err.message });
    }
  }
  return results;
}

// ─── Sync all users with active integrations ──────────────────────────────────
async function syncAll(label = '') {
  console.log(`[AUTO SYNC] Starting${label ? ' ' + label : ''}...`);
  let synced = 0, errors = 0;

  try {
    // Get all users with at least one active integration
    const { rows: users } = await query(
      `SELECT DISTINCT user_id FROM integrations WHERE status = 'active'`
    );

    console.log(`[AUTO SYNC] ${users.length} users with active integrations`);

    for (const { user_id } of users) {
      try {
        const results = await syncUserIntegrations(user_id);
        const ok  = results.filter(r => r.ok).length;
        const err = results.filter(r => !r.ok).length;
        synced += ok;
        errors += err;

        if (ok) console.log(`[AUTO SYNC] user=${user_id} ✓ ${ok} services synced`);
        if (err) console.log(`[AUTO SYNC] user=${user_id} ✗ ${err} services failed`);

        // Stagger requests — don't hit all APIs at once
        await new Promise(r => setTimeout(r, 3000));

      } catch (err) {
        console.error(`[AUTO SYNC] Fatal for user=${user_id}:`, err.message);
        errors++;
      }
    }

    console.log(`[AUTO SYNC] Done: ${synced} ok, ${errors} errors`);
  } catch (err) {
    console.error('[AUTO SYNC] Fatal error:', err.message);
  }
}

// ─── Init scheduler ───────────────────────────────────────────────────────────
function init() {
  // Morning sync — 08:00 every day
  // Gets yesterday's completed data + today's early bookings
  cron.schedule('0 8 * * *', async () => {
    await syncAll('morning 08:00');
  }, { timezone: 'Europe/Kiev' });

  // Midday sync — 14:00 every day
  // Used for alerts check (bot checks alerts at 14:00 too)
  cron.schedule('0 14 * * *', async () => {
    await syncAll('midday 14:00');
  }, { timezone: 'Europe/Kiev' });

  // Pre-report sync — 19:30 every day
  // 30 min before daily bot report (20:00) — data is fresh
  cron.schedule('30 19 * * *', async () => {
    await syncAll('pre-report 19:30');
  }, { timezone: 'Europe/Kiev' });

  // Weekly deep sync — Sunday 06:00
  // Full data pull for weekly report
  cron.schedule('0 6 * * 0', async () => {
    await syncAll('weekly deep sync');
  }, { timezone: 'Europe/Kiev' });

  console.log('[AUTO SYNC] Scheduler initialized: 08:00, 14:00, 19:30 daily + Sunday 06:00');
}

// ─── Manual trigger (for admin panel or API) ─────────────────────────────────
async function syncUser(userId) {
  return syncUserIntegrations(userId);
}

module.exports = { init, syncAll, syncUser };
