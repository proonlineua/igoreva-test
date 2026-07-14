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
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = message.content.map(c => c.text || '').join('');
    // Robust JSON extraction — find the first { ... } block
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in Claude response');
    const result = JSON.parse(jsonMatch[0]);

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
  const currentYear = new Date().getFullYear();
  const city = salonData?.city || 'Харків';
  const prompt = `Ты операционный консультант для салонов красоты Украины. Создай профессиональный рабочий документ.

ДАННЫЕ САЛОНА (использовать точно, не изменять):
Название: ${salonData?.name || 'Салон'}
Город: ${city}
Мастеров: ${salonData?.masters || 'н/д'}
Администраторов: ${salonData?.admins || 'н/д'}
СРЕДНИЙ ЧЕК: ${salonData?.avgCheck || 'н/д'} ₴ — использовать именно это значение везде в документе
Выручка: ${salonData?.revenue || 'н/д'} ₴/міс

АКТУАЛЬНІ ОРІЄНТИРИ РИНКУ УКРАЇНИ ${currentYear} (${city}):
- Зарплата адміністратора: 13 000–18 000 ₴/міс
- ФОП/відсоток майстра: 45–55% від виручки майстра
- Оренда приміщення: 15 000–30 000 ₴/міс залежно від площі та локації
- Комунальні послуги: 6 000–10 000 ₴/міс
- Середня ціна послуги в ${city}: стрижка 200–500 ₴, фарбування 600–1500 ₴, манікюр 300–600 ₴
- Маркетинговий бюджет: 5–10% від виручки
- CAC (вартість залучення клієнта): 150–400 ₴

Документ: "${taskName}"

Ответы на вопросы анкеты:
${safeAnswers || 'не указаны'}

ТРЕБОВАНИЯ К ФОРМАТУ:
- Используй заголовки: # для названия, ## для разделов, ### для подразделов
- Используй маркированные списки: - пункт
- Конкретные цифры, примеры, готовые формулировки для украинского рынка ${currentYear} года
- Если уместно — добавь таблицу в формате Markdown (| Col | Col |)
- Готово к применению с первого дня. Без вводных слов и воды.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
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

// POST /api/ai/refine — доработка уже сгенерированного документа
router.post('/refine', async (req, res) => {
  if (!req.user.has_access) {
    return res.status(403).json({ error: 'Требуется план внедрения', code: 'ACCESS_REQUIRED' });
  }

  const { taskName, originalContent, feedback, salonData } = req.body;
  if (!feedback || feedback.length > 1000) return res.status(400).json({ error: 'Укажите что нужно исправить' });
  if (!originalContent) return res.status(400).json({ error: 'Нет исходного документа' });

  const prompt = `Ты операционный консультант для салонов красоты.

Вот уже созданный документ "${taskName}" для салона "${salonData?.name || 'Салон'}":

${originalContent.slice(0, 3000)}

---
Пользователь просит доработать: ${feedback.slice(0, 1000)}

Улучши документ с учётом этого запроса. Верни полный улучшенный документ (не только изменения). Конкретно, без воды.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });
    const result = message.content.map(c => c.text || '').join('');

    await query(
      'INSERT INTO generated_documents (user_id, task_name, content) VALUES ($1, $2, $3)',
      [req.user.id, taskName, result]
    ).catch(() => {});

    res.json({ success: true, content: result });
  } catch (err) {
    console.error('[AI REFINE]', err.message);
    res.status(500).json({ error: 'Ошибка доработки. Попробуйте снова.' });
  }
});

// GET /api/ai/documents — список сохранённых документов
router.get('/documents', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, task_name, content, created_at FROM generated_documents WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ documents: rows });
  } catch (err) {
    console.error('[AI DOCUMENTS]', err.message);
    res.status(500).json({ error: 'Ошибка загрузки документов' });
  }
});

module.exports = router;
