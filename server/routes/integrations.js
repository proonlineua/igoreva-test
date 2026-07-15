'use strict';
const express  = require('express');
const { requireAuth } = require('../middleware/auth');
const { query }  = require('../lib/db');

const router = express.Router();
router.use(requireAuth);

// ─── Helper: get currency for country ────────────────────────────────────────
function getCurrencyForCountry(country) {
  const map = {
    'Испания': 'EUR', 'Германия': 'EUR', 'Франция': 'EUR',
    'Италия': 'EUR', 'Португалия': 'EUR', 'Нидерланды': 'EUR',
    'Бельгия': 'EUR', 'Австрия': 'EUR', 'Чехия': 'EUR',
    'ОАЭ': 'AED', 'Польша': 'PLN', 'Казахстан': 'KZT',
  };
  return map[country] || 'UAH';
}

// ─── GET /api/integrations/manual ────────────────────────────────────────────
// Load manual metrics history (last 6 periods)
router.get('/manual', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, period, period_type, data, revenue, visits, avg_check,
              new_clients, return_rate, fot_pct, materials_pct, notes, created_at, updated_at
       FROM manual_metrics
       WHERE user_id = $1
       ORDER BY period DESC
       LIMIT 12`,
      [req.user.id]
    );
    res.json({ metrics: rows });
  } catch (err) {
    console.error('[MANUAL METRICS GET]', err.message);
    res.status(500).json({ error: 'Ошибка загрузки данных' });
  }
});

// ─── POST /api/integrations/manual ───────────────────────────────────────────
// Save or update manual metrics for a period
router.post('/manual', async (req, res) => {
  try {
    const {
      period,        // 'YYYY-MM' e.g. '2025-07'
      period_type,   // 'month' | 'week'
      revenue,
      visits,
      avg_check,
      new_clients,
      return_rate,
      fot_pct,
      materials_pct,
      notes,
      data           // full JSON for extra fields
    } = req.body;

    if (!period) return res.status(400).json({ error: 'Укажите период' });

    const fullData = {
      ...(data || {}),
      revenue, visits, avg_check, new_clients,
      return_rate, fot_pct, materials_pct, notes,
      entered_at: new Date().toISOString()
    };

    const { rows } = await query(
      `INSERT INTO manual_metrics
         (user_id, period, period_type, data, revenue, visits, avg_check,
          new_clients, return_rate, fot_pct, materials_pct, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (user_id, period, period_type) DO UPDATE
         SET data = $4, revenue = $5, visits = $6, avg_check = $7,
             new_clients = $8, return_rate = $9, fot_pct = $10,
             materials_pct = $11, notes = $12, updated_at = NOW()
       RETURNING id, period, revenue, visits, avg_check, new_clients, updated_at`,
      [
        req.user.id, period, period_type || 'month',
        JSON.stringify(fullData),
        revenue ? Number(revenue) : null,
        visits ? Number(visits) : null,
        avg_check ? Number(avg_check) : null,
        new_clients ? Number(new_clients) : null,
        return_rate ? Number(return_rate) : null,
        fot_pct ? Number(fot_pct) : null,
        materials_pct ? Number(materials_pct) : null,
        notes || null
      ]
    );

    // Also cache in cached_metrics for last day of period
    try {
      const periodDate = period + '-01'; // first day of month
      await query(
        `INSERT INTO cached_metrics (user_id, date, source, metrics, revenue, visits, avg_check, new_clients)
         VALUES ($1,$2,'manual',$3,$4,$5,$6,$7)
         ON CONFLICT (user_id, date) DO UPDATE
           SET source = 'manual', metrics = $3, revenue = $4,
               visits = $5, avg_check = $6, new_clients = $7`,
        [
          req.user.id, periodDate, JSON.stringify(fullData),
          revenue ? Number(revenue) : null,
          visits ? Number(visits) : null,
          avg_check ? Number(avg_check) : null,
          new_clients ? Number(new_clients) : null,
        ]
      );
    } catch { /* non-critical */ }

    res.json({ success: true, metric: rows[0] });
  } catch (err) {
    console.error('[MANUAL METRICS POST]', err.message);
    res.status(500).json({ error: 'Ошибка сохранения данных' });
  }
});

// ─── GET /api/integrations/latest ────────────────────────────────────────────
// Get the latest metrics for AI prompts
router.get('/latest', async (req, res) => {
  try {
    // Try manual metrics first (most recent month)
    const { rows: manual } = await query(
      `SELECT data, revenue, visits, avg_check, new_clients, return_rate,
              fot_pct, materials_pct, period, updated_at
       FROM manual_metrics
       WHERE user_id = $1 AND period_type = 'month'
       ORDER BY period DESC
       LIMIT 2`,
      [req.user.id]
    );

    // Try cached metrics (from CRM API, more recent)
    const { rows: cached } = await query(
      `SELECT metrics, revenue, visits, avg_check, new_clients, source, date
       FROM cached_metrics
       WHERE user_id = $1
       ORDER BY date DESC
       LIMIT 30`,
      [req.user.id]
    );

    // Get integration status
    const { rows: integrations } = await query(
      `SELECT service, status, last_sync_at FROM integrations WHERE user_id = $1`,
      [req.user.id]
    );

    res.json({
      manual: manual || [],
      cached: cached || [],
      integrations: integrations || [],
      has_data: manual.length > 0 || cached.length > 0
    });
  } catch (err) {
    console.error('[INTEGRATIONS LATEST]', err.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ─── GET /api/integrations/status ────────────────────────────────────────────
// Get all connected integrations for this user
router.get('/status', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, service, status, last_sync_at, last_error, last_csv_at, last_csv_period, company_id
       FROM integrations WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ integrations: rows });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ─── POST /api/integrations/csv ──────────────────────────────────────────────
// Process uploaded CSV from Fresha/Treatwell
// Parses key columns and saves to manual_metrics + cached_metrics
router.post('/csv', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const { service, period, csvData } = req.body;
    if (!csvData || !period) return res.status(400).json({ error: 'Нет данных CSV' });

    const validServices = ['fresha', 'treatwell', 'poster', 'yclients_export'];
    if (!validServices.includes(service)) return res.status(400).json({ error: 'Неизвестный сервис' });

    // Parse CSV (rows come as array of objects from frontend)
    const parsed = parseCSVMetrics(service, csvData);

    if (!parsed.revenue && !parsed.visits) {
      return res.status(400).json({ error: 'Не удалось найти данные о выручке в CSV. Проверьте что загружен правильный отчёт.' });
    }

    // Save to manual_metrics
    const { rows } = await query(
      `INSERT INTO manual_metrics
         (user_id, period, period_type, data, revenue, visits, avg_check, new_clients, return_rate)
       VALUES ($1,$2,'month',$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, period, period_type) DO UPDATE
         SET data = $3, revenue = $4, visits = $5, avg_check = $6,
             new_clients = $7, return_rate = $8, updated_at = NOW()
       RETURNING id, period, revenue, visits`,
      [
        req.user.id, period,
        JSON.stringify({ ...parsed, source: service, imported_at: new Date().toISOString() }),
        parsed.revenue || null,
        parsed.visits || null,
        parsed.avg_check || null,
        parsed.new_clients || null,
        parsed.return_rate || null,
      ]
    );

    // Update integration record
    await query(
      `INSERT INTO integrations (user_id, service, status, last_csv_at, last_csv_period)
       VALUES ($1,$2,'active',NOW(),$3)
       ON CONFLICT (user_id, service) DO UPDATE
         SET status='active', last_csv_at=NOW(), last_csv_period=$3, updated_at=NOW()`,
      [req.user.id, service, period]
    );

    res.json({ success: true, parsed, metric: rows[0] });
  } catch (err) {
    console.error('[CSV UPLOAD]', err.message);
    res.status(500).json({ error: 'Ошибка обработки CSV: ' + err.message });
  }
});

// ─── CSV Parser ───────────────────────────────────────────────────────────────
function parseCSVMetrics(service, rows) {
  const result = { revenue: 0, visits: 0, avg_check: 0, new_clients: 0, return_rate: 0 };
  if (!Array.isArray(rows) || !rows.length) return result;

  const headers = Object.keys(rows[0]).map(h => h.toLowerCase().trim());

  // Column name mappings per service
  const COLUMN_MAP = {
    fresha: {
      revenue:     ['net sales', 'gross sales', 'net_sales', 'gross_sales', 'revenue', 'total'],
      visits:      ['appointments', 'visits', 'sales quantity', 'sales_quantity', 'items sold'],
      new_clients: ['new clients', 'new_clients'],
      return_rate: ['% rebooked', 'rebooked', 'returning clients'],
    },
    treatwell: {
      revenue:     ['revenue', 'turnover', 'total', 'income', 'net sales'],
      visits:      ['appointments', 'visits', 'bookings', 'receipts'],
      new_clients: ['new clients', 'new customers', 'new_clients'],
      return_rate: ['returning', 'retention', 'rebooking'],
    },
    poster: {
      revenue:     ['revenue', 'total', 'сумма', 'выручка'],
      visits:      ['count', 'количество', 'visits', 'orders'],
      new_clients: ['new', 'новые'],
    },
    yclients_export: {
      revenue:     ['сумма', 'выручка', 'revenue', 'total'],
      visits:      ['количество', 'визиты', 'visits'],
      new_clients: ['новые', 'new'],
    }
  };

  const map = COLUMN_MAP[service] || COLUMN_MAP.fresha;

  function findCol(aliases) {
    for (const alias of aliases) {
      const found = headers.find(h => h.includes(alias.toLowerCase()));
      if (found) return Object.keys(rows[0])[headers.indexOf(found)];
    }
    return null;
  }

  const revCol   = findCol(map.revenue || []);
  const visitCol = findCol(map.visits || []);
  const newCol   = findCol(map.new_clients || []);
  const retCol   = findCol(map.return_rate || []);

  // Sum or take last row (summary rows)
  const lastRow = rows[rows.length - 1];
  const firstRow = rows[0];

  // Try to get totals from last row (Fresha puts totals at bottom)
  if (revCol) {
    const val = parseFloat((lastRow[revCol] || firstRow[revCol] || '0').toString().replace(/[^0-9.]/g, ''));
    result.revenue = isNaN(val) ? 0 : val;
    // If last row is small (detail row not summary), sum all
    if (result.revenue < 100 && rows.length > 1) {
      result.revenue = rows.reduce((sum, r) => {
        const v = parseFloat((r[revCol] || '0').toString().replace(/[^0-9.]/g, ''));
        return sum + (isNaN(v) ? 0 : v);
      }, 0);
    }
  }

  if (visitCol) {
    const val = parseInt((lastRow[visitCol] || '0').toString().replace(/[^0-9]/g, ''));
    result.visits = isNaN(val) ? 0 : val;
    if (result.visits < 5 && rows.length > 1) {
      result.visits = rows.reduce((sum, r) => {
        const v = parseInt((r[visitCol] || '0').toString().replace(/[^0-9]/g, ''));
        return sum + (isNaN(v) ? 0 : v);
      }, 0);
    }
  }

  if (newCol) {
    const val = parseInt((lastRow[newCol] || '0').toString().replace(/[^0-9]/g, ''));
    result.new_clients = isNaN(val) ? 0 : val;
  }

  if (retCol) {
    const raw = (lastRow[retCol] || '0').toString().replace(/[^0-9.]/g, '');
    const val = parseFloat(raw);
    result.return_rate = isNaN(val) ? 0 : (val > 1 ? val : val * 100); // handle 0.65 vs 65%
  }

  if (result.revenue > 0 && result.visits > 0) {
    result.avg_check = Math.round(result.revenue / result.visits * 100) / 100;
  }

  return result;
}


// ─── POST /api/integrations/connect ──────────────────────────────────────────
// Connect a new CRM service (test credentials + save)
router.post('/connect', async (req, res) => {
  try {
    const { service, api_key, api_secret, company_login } = req.body;
    if (!service || !api_key) return res.status(400).json({ error: 'Нужны service и api_key' });

    const validServices = ['dikidi','yclients','booksy','simplybook','timify','shore','poster'];
    if (!validServices.includes(service)) return res.status(400).json({ error: 'Неизвестный сервис' });

    const { connectService } = require('../bot/crmConnectors');

    // Test connection
    let info;
    try {
      info = await connectService(service, {
        apiKey: api_key, apiSecret: api_secret, companyLogin: company_login
      });
    } catch(e) {
      return res.status(400).json({ error: 'Ошибка подключения: ' + e.message, code: 'CONNECT_FAILED' });
    }

    // Save integration (encrypt key in production — for now store as-is)
    const { rows } = await query(
      `INSERT INTO integrations
         (user_id, service, status, api_key, api_secret, company_id, extra, last_sync_at)
       VALUES ($1,$2,'active',$3,$4,$5,$6,NOW())
       ON CONFLICT (user_id, service) DO UPDATE
         SET api_key=$3, api_secret=$4, company_id=$5, extra=$6,
             status='active', last_error=NULL, error_count=0, updated_at=NOW()
       RETURNING id, service, status, company_id, last_sync_at`,
      [
        req.user.id, service,
        api_key, api_secret || null,
        info.company_id,
        JSON.stringify({ ...info, company_login: company_login || null })
      ]
    );

    res.json({ success: true, integration: rows[0], info });
  } catch (err) {
    console.error('[CONNECT]', err.message);
    res.status(500).json({ error: 'Ошибка: ' + err.message });
  }
});

// ─── POST /api/integrations/sync ─────────────────────────────────────────────
// Manually trigger sync for a service
router.post('/sync', async (req, res) => {
  try {
    const { service } = req.body;
    if (!service) return res.status(400).json({ error: 'Укажите service' });

    // Load credentials from DB
    const { rows } = await query(
      `SELECT api_key, api_secret, company_id, extra
       FROM integrations WHERE user_id = $1 AND service = $2 AND status = 'active'`,
      [req.user.id, service]
    );
    if (!rows.length) return res.status(404).json({ error: 'Интеграция не подключена' });

    const { api_key, api_secret, company_id, extra } = rows[0];
    const { syncService } = require('../bot/crmConnectors');

    let metrics;
    try {
      metrics = await syncService(service, {
        apiKey: api_key, apiSecret: api_secret, companyLogin: extra?.company_login
      }, company_id, extra || {});
    } catch(e) {
      // Mark error in DB
      await query(
        `UPDATE integrations SET last_error=$1, error_count=error_count+1, updated_at=NOW()
         WHERE user_id=$2 AND service=$3`,
        [e.message, req.user.id, service]
      );
      return res.status(400).json({ error: 'Ошибка синхронизации: ' + e.message });
    }

    // Save to manual_metrics + cached_metrics
    if (metrics.revenue || metrics.visits) {
      const period = metrics.period || new Date().toISOString().slice(0,7);

      await query(
        `INSERT INTO manual_metrics
           (user_id, period, period_type, data, revenue, visits, avg_check, new_clients)
         VALUES ($1,$2,'month',$3,$4,$5,$6,$7)
         ON CONFLICT (user_id, period, period_type) DO UPDATE
           SET data=$3, revenue=$4, visits=$5, avg_check=$6, new_clients=$7, updated_at=NOW()`,
        [req.user.id, period,
         JSON.stringify({ ...metrics, synced_at: new Date().toISOString() }),
         metrics.revenue, metrics.visits, metrics.avg_check, metrics.new_clients || null]
      );

      // Today's cache
      if (metrics.today?.visits || metrics.today?.revenue) {
        const mastersJSON = metrics.masters ? JSON.stringify({ masters: metrics.masters }) : '{}';
        await query(
          `INSERT INTO cached_metrics
             (user_id, date, source, metrics, revenue, visits, avg_check, new_clients)
           VALUES ($1,CURRENT_DATE,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (user_id, date) DO UPDATE
             SET source=$2, metrics=$3, revenue=$4, visits=$5, avg_check=$6, new_clients=$7`,
          [req.user.id, service,
           mastersJSON,
           metrics.today.revenue || null,
           metrics.today.visits  || null,
           metrics.today.avg_check || null,
           metrics.today.new_clients || null]
        );
      }

      // Update last_sync_at
      await query(
        `UPDATE integrations SET last_sync_at=NOW(), last_error=NULL, error_count=0, updated_at=NOW()
         WHERE user_id=$1 AND service=$2`,
        [req.user.id, service]
      );
    }

    res.json({ success: true, metrics });
  } catch (err) {
    console.error('[SYNC]', err.message);
    res.status(500).json({ error: 'Ошибка: ' + err.message });
  }
});

// ─── DELETE /api/integrations/:service ───────────────────────────────────────
router.delete('/:service', async (req, res) => {
  try {
    await query(
      `UPDATE integrations SET status='paused', updated_at=NOW()
       WHERE user_id=$1 AND service=$2`,
      [req.user.id, req.params.service]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});


// ─── POST /api/integrations/sync-all ─────────────────────────────────────────
// Manually trigger sync for ALL active integrations of this user
router.post('/sync-all', async (req, res) => {
  try {
    const { syncUser } = require('../bot/syncScheduler');
    const results = await syncUser(req.user.id);
    const ok  = results.filter(r => r.ok).length;
    const err = results.filter(r => !r.ok).length;
    res.json({ success: true, synced: ok, errors: err, results });
  } catch (err) {
    console.error('[SYNC ALL]', err.message);
    res.status(500).json({ error: 'Ошибка синхронизации: ' + err.message });
  }
});

module.exports = router;
