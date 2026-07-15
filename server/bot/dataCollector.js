'use strict';
const { query } = require('../lib/db');

// ─── Get data for a specific user and report type ─────────────────────────────
async function collectData(userId, type) {
  const result = { today: null, week: null, month: null, prev_month: null, masters: [] };

  try {
    const now   = new Date();
    const today = now.toISOString().slice(0, 10);

    // ── Monthly data (manual_metrics) ────────────────────────────────────────
    const curPeriod  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const prevDate   = new Date(now.getFullYear(), now.getMonth()-1, 1);
    const prevPeriod = `${prevDate.getFullYear()}-${String(prevDate.getMonth()+1).padStart(2,'0')}`;

    const { rows: monthRows } = await query(
      `SELECT revenue, visits, avg_check, new_clients, return_rate, fot_pct, materials_pct, notes
       FROM manual_metrics WHERE user_id = $1 AND period = $2 AND period_type = 'month'`,
      [userId, curPeriod]
    );
    if (monthRows.length) result.month = monthRows[0];

    const { rows: prevRows } = await query(
      `SELECT revenue, visits, avg_check FROM manual_metrics
       WHERE user_id = $1 AND period = $2 AND period_type = 'month'`,
      [userId, prevPeriod]
    );
    if (prevRows.length) result.prev_month = prevRows[0];

    // ── Cached daily/weekly metrics (from CRM integrations) ──────────────────
    const { rows: dailyRows } = await query(
      `SELECT revenue, visits, avg_check, new_clients,
              metrics->>'cancellations' as cancellations
       FROM cached_metrics WHERE user_id = $1 AND date = $2`,
      [userId, today]
    );
    if (dailyRows.length) result.today = dailyRows[0];

    // Weekly — sum last 7 days from cached_metrics
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 6);
    const { rows: weekRows } = await query(
      `SELECT SUM(revenue) as revenue, SUM(visits) as visits,
              SUM(new_clients) as new_clients,
              ROUND(AVG(NULLIF(avg_check,0))::numeric, 0) as avg_check
       FROM cached_metrics
       WHERE user_id = $1 AND date >= $2 AND date <= $3`,
      [userId, weekStart.toISOString().slice(0,10), today]
    );
    if (weekRows.length && weekRows[0].revenue) result.week = weekRows[0];

    // Fallback: if no cached today data but have monthly — estimate daily
    if (!result.today && result.month) {
      const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
      result.today = {
        revenue:   Math.round(result.month.revenue / daysInMonth),
        visits:    Math.round(result.month.visits / daysInMonth),
        avg_check: result.month.avg_check,
      };
      result._estimated = true;
    }

    // ── Masters data from cached_metrics JSONB ────────────────────────────────
    const { rows: mastersRows } = await query(
      `SELECT metrics->'masters' as masters_data
       FROM cached_metrics WHERE user_id = $1 AND date = $2`,
      [userId, today]
    );
    if (mastersRows.length && mastersRows[0].masters_data) {
      result.masters = mastersRows[0].masters_data;
    }

  } catch (err) {
    console.error('[DATA COLLECTOR]', err.message);
  }

  return result;
}

// ─── Check if user has enough data for bot reports ───────────────────────────
async function hasData(userId) {
  try {
    const { rows } = await query(
      `SELECT COUNT(*) as cnt FROM manual_metrics WHERE user_id = $1`,
      [userId]
    );
    const { rows: r2 } = await query(
      `SELECT COUNT(*) as cnt FROM cached_metrics WHERE user_id = $1`,
      [userId]
    );
    return Number(rows[0].cnt) > 0 || Number(r2[0].cnt) > 0;
  } catch { return false; }
}

// ─── Check alert conditions ───────────────────────────────────────────────────
async function checkAlerts(userId, settings) {
  const alerts = [];
  try {
    const now   = new Date();
    const today = now.toISOString().slice(0, 10);

    // Load today's cached data
    const { rows } = await query(
      `SELECT revenue, visits, avg_check,
              metrics->>'cancellations' as cancellations,
              metrics->>'load_pct' as load_pct
       FROM cached_metrics WHERE user_id = $1 AND date = $2`,
      [userId, today]
    );
    if (!rows.length) return alerts;

    const d = rows[0];
    const loadPct = Number(d.load_pct || 0);
    const cancels = Number(d.cancellations || 0);

    // Load 30-day avg revenue for comparison
    const { rows: avgRows } = await query(
      `SELECT AVG(revenue)::numeric as avg_rev FROM cached_metrics
       WHERE user_id = $1 AND date >= (CURRENT_DATE - INTERVAL '30 days')`,
      [userId]
    );
    const avgRev = Number(avgRows[0]?.avg_rev || 0);
    const todayRev = Number(d.revenue || 0);

    // Alert: low load
    if (loadPct > 0 && loadPct < (settings.alert_load_threshold || 50)) {
      alerts.push({ type: 'low_load', data: { load_pct: loadPct }, threshold: settings.alert_load_threshold });
    }

    // Alert: revenue drop
    if (avgRev > 0 && todayRev > 0) {
      const dropPct = Math.round((avgRev - todayRev) / avgRev * 100);
      if (dropPct > (settings.alert_revenue_drop || 30)) {
        alerts.push({ type: 'revenue_drop', data: { revenue: todayRev, drop_pct: dropPct } });
      }
    }

    // Alert: cancellations
    if (cancels >= (settings.alert_cancellations || 3)) {
      alerts.push({ type: 'cancellations', data: { count: cancels } });
    }

  } catch (err) {
    console.error('[CHECK ALERTS]', err.message);
  }
  return alerts;
}

module.exports = { collectData, hasData, checkAlerts };
