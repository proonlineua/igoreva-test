const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../lib/db');

const router = express.Router();
router.use(requireAuth);

// POST /api/audit/save
router.post('/save', async (req, res) => {
  try {
    const { onboarding, answers, scores, completedTasks } = req.body;
    await query(
      `INSERT INTO audits (user_id, onboarding, answers, scores, completed_tasks)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET onboarding = $2, answers = $3, scores = $4,
             completed_tasks = $5, updated_at = NOW()`,
      [req.user.id,
       JSON.stringify(onboarding || {}),
       JSON.stringify(answers || {}),
       JSON.stringify(scores || {}),
       JSON.stringify(completedTasks || [])]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[AUDIT SAVE]', err.message);
    res.status(500).json({ error: 'Ошибка сохранения' });
  }
});

// GET /api/audit/load
router.get('/load', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM audits WHERE user_id = $1', [req.user.id]);
    res.json({ audit: rows[0] || null });
  } catch (err) {
    console.error('[AUDIT LOAD]', err.message);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

// POST /api/audit/task
router.post('/task', async (req, res) => {
  try {
    const { taskId, done } = req.body;
    const { rows } = await query('SELECT completed_tasks FROM audits WHERE user_id = $1', [req.user.id]);
    let tasks = rows[0]?.completed_tasks || [];
    if (done && !tasks.includes(taskId)) tasks.push(taskId);
    if (!done) tasks = tasks.filter(t => t !== taskId);
    await query('UPDATE audits SET completed_tasks = $1, updated_at = NOW() WHERE user_id = $2', [JSON.stringify(tasks), req.user.id]);
    res.json({ success: true, completed_tasks: tasks });
  } catch (err) {
    console.error('[AUDIT TASK]', err.message);
    res.status(500).json({ error: 'Ошибка обновления задачи' });
  }
});

module.exports = router;
