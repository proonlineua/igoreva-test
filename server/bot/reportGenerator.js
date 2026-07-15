'use strict';
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Currency helper ──────────────────────────────────────────────────────────
function getCur(country) {
  const map = { 'Испания':'€','Германия':'€','Чехия':'€','Франция':'€',
                'Италия':'€','Португалия':'€','Польша':'zł','ОАЭ':'AED','Казахстан':'₸' };
  return map[country] || '₴';
}

// ─── Format numbers nicely ────────────────────────────────────────────────────
function fmt(n) { return Number(n).toLocaleString('ru'); }

// ─── Build data context string for prompts ───────────────────────────────────
function buildDataContext(data, salon, type) {
  const cur = getCur(salon.country);
  const { today, week, month, prev_month, masters } = data;

  let ctx = '';

  if (type === 'daily' && today) {
    ctx += `ДАННЫЕ ЗА СЕГОДНЯ:\n`;
    if (today.revenue)    ctx += `- Выручка: ${fmt(today.revenue)} ${cur}\n`;
    if (today.visits)     ctx += `- Визитов: ${today.visits}\n`;
    if (today.avg_check)  ctx += `- Средний чек: ${fmt(today.avg_check)} ${cur}\n`;
    if (today.cancellations) ctx += `- Отмен: ${today.cancellations}\n`;
    if (today.new_clients)ctx += `- Новых клиентов: ${today.new_clients}\n`;
  }

  if (type === 'weekly' && week) {
    ctx += `ДАННЫЕ ЗА НЕДЕЛЮ:\n`;
    if (week.revenue)    ctx += `- Выручка: ${fmt(week.revenue)} ${cur}\n`;
    if (week.visits)     ctx += `- Визитов: ${week.visits}\n`;
    if (week.avg_check)  ctx += `- Средний чек: ${fmt(week.avg_check)} ${cur}\n`;
    if (week.new_clients)ctx += `- Новых клиентов: ${week.new_clients}\n`;
    if (week.return_rate)ctx += `- Retention: ${week.return_rate}%\n`;
  }

  if (type === 'monthly' && month) {
    ctx += `ДАННЫЕ ЗА МЕСЯЦ:\n`;
    if (month.revenue)      ctx += `- Выручка: ${fmt(month.revenue)} ${cur}\n`;
    if (month.visits)       ctx += `- Визитов: ${month.visits}\n`;
    if (month.avg_check)    ctx += `- Средний чек: ${fmt(month.avg_check)} ${cur}\n`;
    if (month.new_clients)  ctx += `- Новых клиентов: ${month.new_clients}\n`;
    if (month.return_rate)  ctx += `- Retention: ${month.return_rate}%\n`;
    if (month.fot_pct)      ctx += `- ФОТ: ${month.fot_pct}%\n`;
    if (month.materials_pct)ctx += `- Материалы: ${month.materials_pct}%\n`;
    if (prev_month?.revenue) {
      const diff = Math.round((month.revenue - prev_month.revenue) / prev_month.revenue * 100);
      ctx += `- Динамика vs прошлый месяц: ${diff >= 0 ? '+' : ''}${diff}%\n`;
    }
  }

  if (masters?.length) {
    ctx += `\nПО МАСТЕРАМ:\n`;
    masters.forEach(m => {
      ctx += `- ${m.name}: выручка ${fmt(m.revenue)} ${cur}, загрузка ${m.load_pct}%`;
      if (m.visits) ctx += `, визитов ${m.visits}`;
      ctx += '\n';
    });
  }

  return ctx;
}

// ─── Generate report via Claude ───────────────────────────────────────────────
async function generateReport({ type, salon, data, settings }) {
  const cur  = getCur(salon.country);
  const dataCtx = buildDataContext(data, salon, type);

  const TYPE_LABELS = {
    daily:   'ежедневный отчёт',
    weekly:  'еженедельный отчёт',
    monthly: 'ежемесячный отчёт',
  };

  const TYPE_FOCUS = {
    daily: `Сделай акцент на: что произошло сегодня, кто из мастеров недозагружен, были ли проблемы с отменами, на что обратить внимание завтра.`,
    weekly: `Сделай акцент на: итоги недели, топ-мастера, топ-услуги, динамика относительно прошлой недели, главные выводы и 1-2 конкретных действия на следующую неделю.`,
    monthly: `Сделай акцент на: полный P&L срез, рост/падение ключевых метрик, сравнение с нормами рынка ${salon.country}, прогресс по целям, приоритеты на следующий месяц.`,
  };

  const prompt = `Ты AI-директор салона красоты. Генерируй ${TYPE_LABELS[type]} в Telegram.

САЛОН: ${salon.name || 'Салон'}, ${salon.city || ''}, ${salon.country || ''}
МАСТЕРОВ: ${salon.masters || 'н/д'}, Средний чек: ${salon.avgCheck || 'н/д'} ${cur}

${dataCtx}

РЫНОЧНЫЕ НОРМЫ (${salon.country}):
${salon.country === 'Украина' ? '- ФОТ норма: 45–55%\n- Retention норма: 55–70%\n- Загрузка норма: 70–85%' :
  salon.country === 'Испания' ? '- ФОТ норма: 33–42%\n- Retention норма: 60–75%\n- Загрузка норма: 75–90%' :
  salon.country === 'Казахстан' ? '- ФОТ норма: 40–50%\n- Retention норма: 50–65%\n- Загрузка норма: 65–80%' :
  '- ФОТ норма: 35–45%\n- Retention норма: 55–70%\n- Загрузка норма: 70–85%'}

${TYPE_FOCUS[type]}

ФОРМАТ ОТВЕТА (строго для Telegram):
- Используй жирный текст *так* для ключевых цифр
- Используй эмодзи для визуального разделения
- Структура: 1) Краткий итог с главной цифрой 2) Детали 3) ⚠️ Проблемы/риски 4) ✅ Хорошее 5) 💡 1-2 конкретных действия
- Длина: ежедневный до 200 слов, еженедельный до 300, ежемесячный до 400
- Язык: ${salon.language || 'русский'}
- НЕ используй Markdown заголовки (#, ##) — только эмодзи и жирный текст
- Пиши как умный управляющий, не как робот`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    return msg.content.map(b => b.text || '').join('');
  } catch (err) {
    console.error('[REPORT GEN]', err.message);
    return null;
  }
}

// ─── Generate alert message ───────────────────────────────────────────────────
async function generateAlert({ type, salon, data, threshold }) {
  const cur = getCur(salon.country);
  const ALERT_PROMPTS = {
    low_load: `Сгенерируй короткий алерт (3-4 строки) для руководителя салона: загрузка сегодня ${data.load_pct}% при пороге ${threshold}%. Дай 1 конкретное действие прямо сейчас. Язык: ${salon.language || 'русский'}.`,
    revenue_drop: `Сгенерируй короткий алерт (3-4 строки): выручка ${fmt(data.revenue)} ${cur} — это на ${data.drop_pct}% ниже среднего. Дай 1 конкретное действие. Язык: ${salon.language || 'русский'}.`,
    cancellations: `Сгенерируй короткий алерт (3-4 строки): ${data.count} отмен подряд в ${salon.name}. Что делать прямо сейчас? Язык: ${salon.language || 'русский'}.`,
  };

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: ALERT_PROMPTS[type] || ALERT_PROMPTS.low_load }]
    });
    return msg.content.map(b => b.text || '').join('');
  } catch (err) {
    console.error('[ALERT GEN]', err.message);
    return null;
  }
}

// ─── Answer interactive question ─────────────────────────────────────────────
async function answerQuestion({ question, salon, data }) {
  const cur = getCur(salon.country);
  const dataCtx = buildDataContext(data, salon, 'monthly');

  const prompt = `Ты AI-директор салона красоты "${salon.name}" (${salon.city}, ${salon.country}).

${dataCtx}

Вопрос от руководителя: ${question}

Ответь коротко и конкретно (до 150 слов). Используй реальные данные выше. Язык: ${salon.language || 'русский'}.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    });
    return msg.content.map(b => b.text || '').join('');
  } catch (err) {
    console.error('[ANSWER GEN]', err.message);
    return '❌ Не удалось получить ответ. Попробуйте позже.';
  }
}

module.exports = { generateReport, generateAlert, answerQuestion };
