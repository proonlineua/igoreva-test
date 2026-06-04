const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../lib/db');

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.use(requireAuth);

// POST /api/ai/analyze — бесплатный AI-анализ аудита
router.post('/analyze', async (req, res) => {
  const { scores, onboarding } = req.body;
  if (!scores || !onboarding) return res.status(400).json({ error: 'Нет данных аудита' });

  const weak = ['finance', 'hr', 'sales', 'clients', 'ops', 'owner', 'marketing']
    .filter(k => (scores[k] || 0) < 50)
    .map(k => `${k}: ${scores[k]}%`).join(', ') || 'нет';

  const prompt = `Ты операционный директор сети салонов красоты с 10-летним опытом.

Данные: ${onboarding.name}, ${onboarding.country || ''} ${onboarding.city || ''}
Мастеров: ${onboarding.masters || 'н/д'}, администраторов: ${onboarding.admins || 'н/д'}
Средний чек: ${onboarding.avgCheck || 'н/д'}, выручка: ${onboarding.revenue || 'н/д'}/мес

Рейтинги аудита:
Финансы: ${scores.finance || 0}%, Персонал: ${scores.hr || 0}%, Продажи: ${scores.sales || 0}%
Клиенты: ${scores.clients || 0}%, Операционка: ${scores.ops || 0}%
Собственник: ${scores.owner || 0}%, Маркетинг: ${scores.marketing || 0}%
Общий: ${scores.overall || 0}%. Слабые блоки: ${weak}

Верни ТОЛЬКО JSON (без markdown):
{
  "main_problems": ["проблема 1","проблема 2","проблема 3"],
  "top_weaknesses": ["слабость 1","слабость 2","слабость 3","слабость 4","слабость 5"],
  "risks": ["риск 1","риск 2","риск 3"],
  "profit_losses": "где теряется прибыль, конкретно",
  "priorities": ["1. действие","2. действие","3. действие"],
  "summary": "2-3 предложения: главный вывод и ключевая возможность"
}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = message.content.map(c => c.text || '').join('');
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());

    await query(
      'INSERT INTO audit_analyses (user_id, scores, analysis) VALUES ($1, $2, $3)',
      [req.user.id, JSON.stringify(scores), JSON.stringify(result)]
    ).catch(() => {});

    res.json({ success: true, analysis: result });
  } catch (err) {
    console.error('[AI ANALYZE]', err.message);
    res.status(500).json({ error: 'Ошибка AI-анализа. Попробуйте снова.' });
  }
});

// POST /api/ai/generate — платная генерация документов
router.post('/generate', async (req, res) => {
  if (!req.user.has_access) {
    return res.status(403).json({ error: 'Требуется план внедрения', code: 'ACCESS_REQUIRED' });
  }

  const { taskName, answers, salonData } = req.body;
  if (!taskName || taskName.length > 150) return res.status(400).json({ error: 'Некорректное название задачи' });

  const safeAnswers = (answers || '').toString().slice(0, 2000);
  const prompt = `Ты операционный консультант для салонов красоты.
Создай "${taskName}" для салона "${salonData?.name || 'Салон'}".
Город: ${salonData?.city || ''}, мастеров: ${salonData?.masters || 'н/д'}, средний чек: ${salonData?.avgCheck || 'н/д'}.

Ответы на вопросы:
${safeAnswers || 'не указаны'}

Требования: конкретно, структурированно, готово к использованию сразу. Без воды.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });
    const result = message.content.map(c => c.text || '').join('');

    await query(
      'INSERT INTO generated_documents (user_id, task_name, content) VALUES ($1, $2, $3)',
      [req.user.id, taskName, result]
    ).catch(() => {});

    res.json({ success: true, content: result });
  } catch (err) {
    console.error('[AI GENERATE]', err.message);
    res.status(500).json({ error: 'Ошибка генерации. Попробуйте снова.' });
  }
});

module.exports = router;
