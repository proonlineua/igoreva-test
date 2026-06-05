const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../lib/db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory AI insights cache (resets on PM2 restart)
let insightCache = { date: null, insight: null };

// ─────────────────────────────────────────────
// PHASE 1 — MVP
// ─────────────────────────────────────────────

// GET /api/admin/kpis
router.get('/kpis', async (req, res) => {
  try {
    const { rows } = await query(`
      WITH user_counts AS (
        SELECT
          COUNT(*)                                                          AS total_users,
          COUNT(*) FILTER (WHERE p.has_access = true)                      AS paid_users,
          COUNT(*) FILTER (WHERE u.created_at > NOW() - INTERVAL '1 day') AS new_24h,
          COUNT(*) FILTER (WHERE u.created_at > NOW() - INTERVAL '7 days') AS new_7d,
          COUNT(*) FILTER (WHERE u.created_at > NOW() - INTERVAL '30 days') AS new_30d
        FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      ),
      revenue AS (
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)                                                             AS total_revenue,
          COALESCE(SUM(amount) FILTER (WHERE status = 'paid' AND created_at > NOW() - INTERVAL '30 days'), 0)                 AS revenue_30d,
          COUNT(*) FILTER (WHERE status = 'paid')                                                                              AS total_payments,
          COUNT(*) FILTER (WHERE status = 'paid' AND created_at > NOW() - INTERVAL '30 days')                                 AS payments_30d
        FROM payments
      ),
      audits_agg AS (
        SELECT
          COUNT(*)                                                    AS audits_done,
          ROUND(AVG((scores->>'overall')::numeric), 1)               AS avg_score
        FROM audits WHERE scores->>'overall' IS NOT NULL
      ),
      docs_agg AS (
        SELECT COUNT(*) AS docs_total FROM generated_documents
      ),
      tasks_agg AS (
        SELECT COALESCE(SUM(jsonb_array_length(completed_tasks)), 0) AS tasks_completed
        FROM audits WHERE completed_tasks IS NOT NULL
      )
      SELECT uc.*, r.*, aa.audits_done, aa.avg_score, da.docs_total, ta.tasks_completed
      FROM user_counts uc, revenue r, audits_agg aa, docs_agg da, tasks_agg ta
    `);
    res.json(rows[0] || {});
  } catch (err) {
    console.error('[ADMIN KPIs]', err.message);
    res.status(500).json({ error: 'Ошибка загрузки KPI' });
  }
});

// GET /api/admin/users?search=&access=&audit=&page=1&limit=20
router.get('/users', async (req, res) => {
  try {
    const { search = null, access = null, audit = null, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const accessFilter = access === 'true' ? true : access === 'false' ? false : null;
    const auditFilter  = audit  === 'true' ? true : audit  === 'false' ? false : null;

    const { rows } = await query(`
      SELECT
        u.id, u.email, u.name, u.created_at,
        p.salon_name, p.city, p.has_access, p.access_expires_at, p.is_admin,
        p.onboarding->>'country'  AS country,
        p.onboarding->>'masters'  AS masters,
        p.onboarding->>'avgCheck' AS avg_check,
        a.scores->>'overall'      AS overall_score,
        a.updated_at              AS last_audit_at,
        (SELECT COUNT(*) FROM generated_documents d WHERE d.user_id = u.id) AS doc_count,
        (SELECT COUNT(*) FROM payments pay WHERE pay.user_id = u.id AND pay.status = 'paid') AS payments_count
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
      LEFT JOIN audits a ON a.user_id = u.id
      WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%'
                              OR u.name  ILIKE '%' || $1 || '%'
                              OR p.salon_name ILIKE '%' || $1 || '%')
        AND ($2::boolean IS NULL OR p.has_access = $2)
        AND ($3::boolean IS NULL OR (a.scores->>'overall' IS NOT NULL) = $3)
      ORDER BY u.created_at DESC
      LIMIT $4 OFFSET $5
    `, [search || null, accessFilter, auditFilter, Number(limit), offset]);

    const { rows: countRows } = await query(`
      SELECT COUNT(*) AS total FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
      LEFT JOIN audits a ON a.user_id = u.id
      WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%'
                              OR u.name  ILIKE '%' || $1 || '%'
                              OR p.salon_name ILIKE '%' || $1 || '%')
        AND ($2::boolean IS NULL OR p.has_access = $2)
        AND ($3::boolean IS NULL OR (a.scores->>'overall' IS NOT NULL) = $3)
    `, [search || null, accessFilter, auditFilter]);

    res.json({ users: rows, total: Number(countRows[0].total), page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[ADMIN USERS]', err.message);
    res.status(500).json({ error: 'Ошибка загрузки пользователей' });
  }
});

// GET /api/admin/users/:id — Client 360
router.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [profileRes, auditRes, paymentsRes, docsRes, analysisRes] = await Promise.all([
      query(`SELECT u.id, u.email, u.name, u.created_at,
                    p.salon_name, p.city, p.team_size, p.has_access, p.access_expires_at, p.is_admin, p.onboarding
             FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`, [id]),
      query(`SELECT onboarding, answers, scores, completed_tasks, created_at, updated_at FROM audits WHERE user_id = $1`, [id]),
      query(`SELECT id, order_id, amount, currency, status, created_at FROM payments WHERE user_id = $1 ORDER BY created_at DESC`, [id]),
      query(`SELECT id, task_name, content, created_at FROM generated_documents WHERE user_id = $1 ORDER BY created_at DESC`, [id]),
      query(`SELECT scores, analysis, created_at FROM audit_analyses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [id])
    ]);

    if (!profileRes.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });

    res.json({
      profile:  profileRes.rows[0],
      audit:    auditRes.rows[0] || null,
      payments: paymentsRes.rows,
      documents: docsRes.rows,
      analysis: analysisRes.rows[0] || null
    });
  } catch (err) {
    console.error('[ADMIN USER 360]', err.message);
    res.status(500).json({ error: 'Ошибка загрузки профиля' });
  }
});

// POST /api/admin/users/:id/access — toggle access
router.post('/users/:id/access', async (req, res) => {
  try {
    const { id } = req.params;
    const { grant } = req.body; // true = grant, false = revoke
    const { rows } = await query(`
      UPDATE profiles
      SET has_access = $1,
          access_expires_at = CASE WHEN $1 = true THEN NOW() + INTERVAL '3 months' ELSE NULL END
      WHERE user_id = $2
      RETURNING has_access, access_expires_at
    `, [!!grant, id]);
    if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ success: true, ...rows[0] });
  } catch (err) {
    console.error('[ADMIN ACCESS]', err.message);
    res.status(500).json({ error: 'Ошибка изменения доступа' });
  }
});

// GET /api/admin/payments?page=1&status=
router.get('/payments', async (req, res) => {
  try {
    const { page = 1, limit = 25, status = null } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const { rows } = await query(`
      SELECT p.id, p.order_id, p.amount, p.currency, p.status, p.created_at,
             u.email, u.name, pr.salon_name
      FROM payments p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN profiles pr ON pr.user_id = p.user_id
      WHERE ($1::text IS NULL OR p.status = $1)
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3
    `, [status || null, Number(limit), offset]);

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM payments WHERE ($1::text IS NULL OR status = $1)`,
      [status || null]
    );

    res.json({ payments: rows, total: Number(countRows[0].total), page: Number(page) });
  } catch (err) {
    console.error('[ADMIN PAYMENTS]', err.message);
    res.status(500).json({ error: 'Ошибка загрузки платежей' });
  }
});

// ─────────────────────────────────────────────
// PHASE 2 — ANALYTICS CHARTS
// ─────────────────────────────────────────────

// GET /api/admin/registrations?period=30
router.get('/registrations', async (req, res) => {
  try {
    const period = Math.min(Number(req.query.period) || 30, 365);
    const { rows } = await query(`
      SELECT DATE_TRUNC('day', u.created_at)::date AS day,
             COUNT(*) AS registrations,
             COUNT(*) FILTER (WHERE p.has_access = true) AS conversions
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY 1 ORDER BY 1
    `, [period]);
    res.json(rows);
  } catch (err) {
    console.error('[ADMIN REGISTRATIONS]', err.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// GET /api/admin/revenue-trend
router.get('/revenue-trend', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
             COALESCE(SUM(amount), 0) AS revenue,
             COUNT(*) AS payments
      FROM payments WHERE status = 'paid'
      GROUP BY 1 ORDER BY 1 DESC LIMIT 12
    `);
    res.json(rows.reverse());
  } catch (err) {
    console.error('[ADMIN REVENUE]', err.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// GET /api/admin/block-averages
router.get('/block-averages', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        ROUND(AVG((scores->>'finance')::numeric),   1) AS finance,
        ROUND(AVG((scores->>'hr')::numeric),        1) AS hr,
        ROUND(AVG((scores->>'sales')::numeric),     1) AS sales,
        ROUND(AVG((scores->>'clients')::numeric),   1) AS clients,
        ROUND(AVG((scores->>'ops')::numeric),       1) AS ops,
        ROUND(AVG((scores->>'owner')::numeric),     1) AS owner,
        ROUND(AVG((scores->>'marketing')::numeric), 1) AS marketing,
        ROUND(AVG((scores->>'overall')::numeric),   1) AS overall,
        COUNT(*) AS sample_size
      FROM audits WHERE scores->>'overall' IS NOT NULL
    `);
    res.json(rows[0] || {});
  } catch (err) {
    console.error('[ADMIN BLOCK AVG]', err.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// GET /api/admin/score-distribution
router.get('/score-distribution', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT FLOOR((scores->>'overall')::numeric / 10) * 10 AS bucket_start,
             COUNT(*) AS count
      FROM audits WHERE scores->>'overall' IS NOT NULL
      GROUP BY 1 ORDER BY 1
    `);
    res.json(rows);
  } catch (err) {
    console.error('[ADMIN SCORE DIST]', err.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// GET /api/admin/funnel
router.get('/funnel', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        (SELECT COUNT(*) FROM users)                                                       AS registered,
        (SELECT COUNT(*) FROM audits WHERE onboarding IS NOT NULL AND onboarding != '{}') AS onboarded,
        (SELECT COUNT(*) FROM audits WHERE scores->>'overall' IS NOT NULL)                AS completed_audit,
        (SELECT COUNT(*) FROM audit_analyses)                                             AS ran_ai,
        (SELECT COUNT(DISTINCT user_id) FROM payments)                                    AS initiated_payment,
        (SELECT COUNT(DISTINCT user_id) FROM payments WHERE status = 'paid')              AS converted
    `);
    res.json(rows[0] || {});
  } catch (err) {
    console.error('[ADMIN FUNNEL]', err.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// GET /api/admin/tool-usage
router.get('/tool-usage', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT task_name, COUNT(*) AS count, COUNT(DISTINCT user_id) AS unique_users
      FROM generated_documents
      GROUP BY task_name ORDER BY count DESC LIMIT 20
    `);
    res.json(rows);
  } catch (err) {
    console.error('[ADMIN TOOL USAGE]', err.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// GET /api/admin/cohorts
router.get('/cohorts', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', u.created_at), 'YYYY-MM') AS cohort_month,
        COUNT(DISTINCT u.id)                                   AS registered,
        COUNT(DISTINCT p.user_id) FILTER (WHERE p.has_access = true) AS converted,
        ROUND(100.0 * COUNT(DISTINCT p.user_id) FILTER (WHERE p.has_access = true)
              / NULLIF(COUNT(DISTINCT u.id), 0), 1)            AS conversion_rate
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      GROUP BY 1 ORDER BY 1 DESC LIMIT 12
    `);
    res.json(rows.reverse());
  } catch (err) {
    console.error('[ADMIN COHORTS]', err.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ─────────────────────────────────────────────
// PHASE 3 — INTELLIGENCE
// ─────────────────────────────────────────────

// GET /api/admin/heatmap — aggregate 'no' answers per question across all audits
router.get('/heatmap', async (req, res) => {
  try {
    const { rows } = await query(`SELECT answers FROM audits WHERE answers IS NOT NULL AND answers != '{}' LIMIT 500`);

    const BLOCKS = ['finance','hr','sales','clients','ops','owner','marketing'];
    const BLOCK_NAMES = { finance:'Финансы', hr:'Персонал', sales:'Продажи', clients:'Клиенты', ops:'Операционка', owner:'Собственник', marketing:'Маркетинг' };
    const tally = {}; // key → {no, partly, yes, total}

    for (const row of rows) {
      const answers = row.answers;
      if (!answers) continue;
      for (const [key, val] of Object.entries(answers)) {
        if (!val || !val.val) continue;
        if (!tally[key]) tally[key] = { no: 0, partly: 0, yes: 0, total: 0 };
        tally[key][val.val] = (tally[key][val.val] || 0) + 1;
        tally[key].total++;
      }
    }

    // Block-level aggregation
    const blockStats = {};
    for (const block of BLOCKS) {
      let noCount = 0, total = 0;
      for (const [key, t] of Object.entries(tally)) {
        if (key.startsWith(block + '_')) { noCount += t.no; total += t.total; }
      }
      blockStats[block] = { name: BLOCK_NAMES[block], no_pct: total > 0 ? Math.round(noCount / total * 100) : 0, no: noCount, total };
    }

    // Top 20 most-failed individual questions
    const topProblems = Object.entries(tally)
      .filter(([, t]) => t.total >= 2)
      .map(([key, t]) => ({
        key,
        block: key.split('_')[0],
        block_name: BLOCK_NAMES[key.split('_')[0]] || key.split('_')[0],
        no_pct: Math.round(t.no / t.total * 100),
        no: t.no, total: t.total
      }))
      .sort((a, b) => b.no_pct - a.no_pct)
      .slice(0, 20);

    res.json({ block_stats: blockStats, top_problems: topProblems, total_audits: rows.length });
  } catch (err) {
    console.error('[ADMIN HEATMAP]', err.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// GET /api/admin/benchmarks
router.get('/benchmarks', async (req, res) => {
  try {
    const { rows: global } = await query(`
      SELECT
        ROUND(AVG((scores->>'overall')::numeric),   1) AS overall,
        ROUND(AVG((scores->>'finance')::numeric),   1) AS finance,
        ROUND(AVG((scores->>'hr')::numeric),        1) AS hr,
        ROUND(AVG((scores->>'sales')::numeric),     1) AS sales,
        ROUND(AVG((scores->>'clients')::numeric),   1) AS clients,
        ROUND(AVG((scores->>'ops')::numeric),       1) AS ops,
        ROUND(AVG((scores->>'owner')::numeric),     1) AS owner,
        ROUND(AVG((scores->>'marketing')::numeric), 1) AS marketing,
        COUNT(*) AS sample
      FROM audits WHERE scores->>'overall' IS NOT NULL
    `);

    const { rows: byCity } = await query(`
      SELECT p.city,
             ROUND(AVG((a.scores->>'overall')::numeric), 1) AS avg_overall,
             COUNT(*) AS salons
      FROM audits a JOIN profiles p ON p.user_id = a.user_id
      WHERE a.scores->>'overall' IS NOT NULL AND p.city IS NOT NULL AND p.city != ''
      GROUP BY p.city HAVING COUNT(*) >= 1
      ORDER BY avg_overall DESC LIMIT 20
    `);

    const { rows: users } = await query(`
      SELECT u.id, u.name, p.salon_name, p.city,
             a.scores->>'overall' AS overall,
             a.scores->>'finance' AS finance,
             a.scores->>'hr' AS hr,
             a.scores->>'sales' AS sales,
             a.scores->>'clients' AS clients,
             a.scores->>'ops' AS ops,
             a.scores->>'owner' AS owner,
             a.scores->>'marketing' AS marketing
      FROM users u
      JOIN audits a ON a.user_id = u.id
      LEFT JOIN profiles p ON p.user_id = u.id
      WHERE a.scores->>'overall' IS NOT NULL
      ORDER BY (a.scores->>'overall')::numeric DESC
    `);

    res.json({ global: global[0], by_city: byCity, users });
  } catch (err) {
    console.error('[ADMIN BENCHMARKS]', err.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// GET /api/admin/ai-insights — daily AI analysis (cached in memory)
router.get('/ai-insights', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (insightCache.date === today && insightCache.insight) {
      return res.json({ insight: insightCache.insight, cached: true, date: today });
    }

    // Gather platform stats for the prompt
    const [kpiRes, blockRes, heatmapRes] = await Promise.all([
      query(`SELECT COUNT(*) AS users, COUNT(*) FILTER (WHERE p.has_access) AS paid
             FROM users u LEFT JOIN profiles p ON p.user_id = u.id`),
      query(`SELECT ROUND(AVG((scores->>'overall')::numeric),1) AS overall,
                    ROUND(AVG((scores->>'finance')::numeric),1) AS finance,
                    ROUND(AVG((scores->>'hr')::numeric),1) AS hr,
                    ROUND(AVG((scores->>'sales')::numeric),1) AS sales,
                    ROUND(AVG((scores->>'marketing')::numeric),1) AS marketing,
                    COUNT(*) AS audits
             FROM audits WHERE scores->>'overall' IS NOT NULL`),
      query(`SELECT task_name, COUNT(*) AS cnt FROM generated_documents GROUP BY 1 ORDER BY 2 DESC LIMIT 5`)
    ]);

    const kpi = kpiRes.rows[0];
    const blk = blockRes.rows[0];
    const topDocs = heatmapRes.rows.map(r => `${r.task_name} (${r.cnt}x)`).join(', ');

    const prompt = `Ты аналитик индустрии красоты. На платформе Beauty Operations OS:
- Зарегистрировано пользователей: ${kpi.users} (платных: ${kpi.paid})
- Проведено аудитов: ${blk.audits}
- Средний рейтинг бизнесов: ${blk.overall}%
- Средние блоки: Финансы ${blk.finance}%, HR ${blk.hr}%, Продажи ${blk.sales}%, Маркетинг ${blk.marketing}%
- Самые создаваемые документы: ${topDocs || 'нет данных'}

Напиши 5 инсайтов об индустрии красоты на основе этих данных. Каждый инсайт: конкретная цифра + вывод + рекомендация. Без воды. Формат: пронумерованный список.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    });
    const insight = message.content.map(c => c.text || '').join('');

    insightCache = { date: today, insight };
    res.json({ insight, cached: false, date: today });
  } catch (err) {
    console.error('[ADMIN AI INSIGHTS]', err.message);
    res.status(500).json({ error: 'Ошибка генерации инсайтов' });
  }
});

// GET /api/admin/documents?page=1&search=
router.get('/documents', async (req, res) => {
  try {
    const { page = 1, limit = 25, search = null } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const { rows } = await query(`
      SELECT d.id, d.task_name, d.created_at,
             LEFT(d.content, 200) AS preview,
             u.email, u.name, p.salon_name
      FROM generated_documents d
      JOIN users u ON u.id = d.user_id
      LEFT JOIN profiles p ON p.user_id = d.user_id
      WHERE ($1::text IS NULL OR d.task_name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
      ORDER BY d.created_at DESC
      LIMIT $2 OFFSET $3
    `, [search || null, Number(limit), offset]);

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM generated_documents d JOIN users u ON u.id = d.user_id
       WHERE ($1::text IS NULL OR d.task_name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')`,
      [search || null]
    );

    res.json({ documents: rows, total: Number(countRows[0].total), page: Number(page) });
  } catch (err) {
    console.error('[ADMIN DOCUMENTS]', err.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// GET /api/admin/documents/:id — full document content
router.get('/documents/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT d.*, u.email, u.name, p.salon_name
       FROM generated_documents d JOIN users u ON u.id = d.user_id LEFT JOIN profiles p ON p.user_id = d.user_id
       WHERE d.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Не найден' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

module.exports = router;
