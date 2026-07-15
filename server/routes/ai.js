'use strict';
const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');
const { query }  = require('../lib/db');

const router    = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.use(requireAuth);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getMarketContext(country, city, year) {
  const c = (country || '').trim();

  if (c === 'Испания') return `
РЫНОЧНЫЕ ОРИЕНТИРЫ — ИСПАНИЯ, ${city || 'Испания'} (${year}):
- Валюта: евро (€). ВСЕ цифры в документе — только в €, никаких ₴ или zł
- Зарплата администратора: 1 100–1 400 € брутто/мес (с учётом Seguridad Social работодателя ~30% → реальная стоимость 1 430–1 820 €)
- ФОТ мастеров: 33–42% от выручки (если мастер работает со своими материалами — до 48%)
- Аренда: 8–14% от выручки (для Валенсии — 700–1 800 €/мес типично)
- Материалы: 8–13% от выручки
- Налоги (IVA 21% на услуги + IRPF/SS autónomo или IS для SL): 8–13% от выручки
- Gestoría (бухгалтер): 150–400 €/мес
- Маркетинговый бюджет (Instagram Ads): 300–800 €/мес реалистично для малого салона
- CAC (стоимость привлечения клиента): 15–40 €
- Средняя цена услуг: маникюр 35–60 €, педикюр 30–50 €, брови 25–45 €, массаж 50–80 €
- Норма прибыли здорового салона: 17–28% от выручки
- ВАЖНО: учитывать IVA в расчётах. Клиент платит с IVA (21%), выручка для расчёта прибыли — без IVA`;

  if (c === 'Польша') return `
РЫНОЧНЫЕ ОРИЕНТИРЫ — ПОЛЬША, ${city || 'Польша'} (${year}):
- Валюта: злотые (zł). ВСЕ цифры — только в zł
- Зарплата администратора: 4 500–6 500 zł брутто/мес
- ФОТ мастеров: 33–42% от выручки
- НДС на beauty-услуги: 8% (льготная ставка)
- ZUS для ИП: ~1 700 zł/мес (первые 2 года — Mały ZUS ~400 zł)
- Маркетинговый бюджет: 1 500–4 000 zł/мес
- Средняя цена: маникюр 100–200 zł, массаж 150–250 zł`;

  if (c === 'Германия') return `
РЫНОЧНЫЕ ОРИЕНТИРЫ — ГЕРМАНИЯ, ${city || 'Германия'} (${year}):
- Валюта: евро (€). ВСЕ цифры — только в €
- Зарплата администратора: 2 200–2 800 € брутто/мес
- ФОТ мастеров: 30–40% от выручки
- НДС на услуги: 19% (Umsatzsteuer)
- Sozialversicherung работодателя: ~20% от брутто
- Маркетинговый бюджет: 500–1 500 €/мес`;

  if (c === 'Казахстан') return `
НАЛОГИ (Казахстан):
- ИП на упрощённой декларации: 3% от дохода (1.5% ИПН + 1.5% соц.налог), сдаётся раз в полугодие
- ОПВ (обязательные пенсионные взносы): 10% от зарплаты каждого сотрудника
- СО (социальные отчисления): 3.5% от зарплаты
- ОСМС (медстрах работодатель): 3% от зарплаты
- Итого на сотрудника: ~16.5% сверх зарплаты
- НДС: 12% (только если оборот >20 000 МРП/год, для малых салонов обычно не нужен)
- ВАЖНО: добавить строку «Налоги ИП» (~3% от выручки) + «Отчисления с ФОТ» (~16.5% от зарплат) в расчёт себестоимости`;

  if (c === 'Чехия') return `
РЫНОЧНЫЕ ОРИЕНТИРЫ — ЧЕХИЯ, ${city || 'Чехия'} (${year}):
- Валюта: чешские кроны (Kč) или € (указывай в чём клиент работает). ВСЕ цифры в Kč
- Зарплата администратора: 28 000–38 000 Kč брутто/мес
- ФОТ мастеров: 33–42% от выручки
- НДС на услуги красоты: 21%
- Социальное и медицинское страхование работодателя: ~34% от брутто
- Маркетинговый бюджет: 5 000–15 000 Kč/мес
- Средняя цена: маникюр 500–900 Kč, массаж 800–1 400 Kč`;

  if (c === 'ОАЭ') return `
РЫНОЧНЫЕ ОРИЕНТИРЫ — ОАЭ/ДУБАЙ, ${city || 'Dubai'} (${year}):
- Валюта: дирхам (AED). ВСЕ цифры в AED
- Зарплата администратора: 3 500–6 000 AED/мес (налогов нет)
- ФОТ мастеров: 28–38% от выручки
- НДС: 5% (VAT, введён в 2018)
- Корпоративный налог: 9% от прибыли >375 000 AED (с 2023), до этой суммы — 0%
- Аренда: оплачивается чеками на год вперёд — учитывай в cash flow
- Маркетинговый бюджет: 1 500–4 000 AED/мес
- Средняя цена: маникюр 80–150 AED, массаж 200–350 AED`;

  if (c === 'Португалия' || c === 'Франция' || c === 'Италия' || c === 'Нидерланды' || c === 'Бельгия' || c === 'Австрия') {
    const euCities = {
      'Португалия': 'НДС 23%, мин. зарплата ~820 €/мес',
      'Франция':    'НДС 20%, cotisations sociales ~45% от брутто',
      'Италия':     'НДС 22%, contributi INPS ~26%',
      'Нидерланды': 'НДС 21%, sociale lasten ~20%',
      'Бельгия':    'НДС 21%, cotisations sociales ~27%',
      'Австрия':    'НДС 20%, Sozialversicherung ~18%',
    };
    return `
РЫНОЧНЫЕ ОРИЕНТИРЫ — ${c.toUpperCase()}, ${city || c} (${year}):
- Валюта: евро (€). ВСЕ цифры — только в €
- Налоговая специфика: ${euCities[c] || 'уточни у местного бухгалтера'}
- ФОТ мастеров: 30–42% от выручки
- Маркетинговый бюджет: 300–1 000 €/мес для малого салона
- Средние цены: маникюр 30–55 €, массаж 50–90 €
- ВАЖНО: уточни у местного бухгалтера специфику налогообложения для salón/Salon/beauty studio`;
  }

  if (c === 'Казахстан') return `
РЫНОЧНЫЕ ОРИЕНТИРЫ — КАЗАХСТАН, ${city || 'Алматы'} (${year}):
- Валюта: тенге (₸). ВСЕ цифры — только в ₸
- Зарплата администратора: 180 000–280 000 ₸/мес (чистыми)
- ФОТ мастеров: 40–50% от выручки мастера
- Налоги для ИП (ИП на упрощённой декларации): 3% от дохода (1.5% ИПН + 1.5% соц.налог) + ОПВ 10% от зарплаты + СО ~3.5%
- Налоги для ТОО: КПН 20% от прибыли, НДС 12% (если оборот >20 000 МРП)
- Аренда: Алматы центр 8 000–18 000 ₸/м²/мес; спальные районы 4 000–8 000 ₸/м²/мес
- Коммунальные: 60 000–120 000 ₸/мес
- Маркетинговый бюджет (Instagram, 2ГИС): 50 000–150 000 ₸/мес реалистично
- CAC (стоимость привлечения клиента): 2 000–6 000 ₸
- Средняя цена услуг (Алматы): маникюр 5 000–12 000 ₸, педикюр 5 000–10 000 ₸, брови 4 000–8 000 ₸, массаж 8 000–18 000 ₸, стрижка 5 000–15 000 ₸
- Норма прибыли: 15–25% от выручки
- Специфика: сильная конкуренция в Алматы и Астане, клиент чувствителен к цене, Instagram и WhatsApp — основные каналы
- МРП ${year}: ~3 692 ₸ (уточняй актуальный МРП на налоговых сайтах КЗ)`;

  if (c === 'Грузия' || c === 'Армения' || c === 'Молдова') {
    const cur2 = {
      'Грузия': 'лари (₾)', 'Армения': 'драм (֏)', 'Молдова': 'лей (MDL)'
    };
    return `
РЫНОЧНЫЕ ОРИЕНТИРЫ — ${c.toUpperCase()}, ${city || c} (${year}):
- Валюта: ${cur2[c] || 'местная валюта'}. Указывай в местной валюте
- ФОТ мастеров: 40–50% от выручки (рынок близок к украинскому)
- Налогообложение: упрощённая система для ИП — уточни актуальные ставки
- Маркетинг: Instagram — основной канал. Бюджет 5–15% от выручки
- Ориентируйся на украинские нормы с поправкой на местный уровень жизни`;
  }

  // Default: Украина (и все остальные)
  return `
РЫНОЧНЫЕ ОРИЕНТИРЫ — УКРАИНА, ${city || 'Украина'} (${year}):
- Валюта: гривна (₴). ВСЕ цифры — только в ₴
- Зарплата администратора: 15 000–22 000 ₴/мес (чистыми)
- ФОТ мастеров: 45–55% от выручки мастера (РЕАЛЬНАЯ норма UA ${year} с учётом дефицита кадров после эмиграции; НЕ писать «35–40% норма» — это устаревшие данные)
- Аренда: 15 000–35 000 ₴/мес (зависит от локации и площади)
- Материалы: 10–16% от выручки
- Налоги (ФОП 2-я группа): ЄП ~1 340 ₴/мес + ЄСВ ~1 562 ₴/мес = ~2 900 ₴/мес фиксировано (не % от выручки)
- Маркетинговый бюджет (Instagram/Google): 5 000–15 000 ₴/мес реалистично
- CAC (стоимость привлечения клиента): 150–400 ₴
- Средняя цена услуг: маникюр 400–700 ₴, педикюр 350–600 ₴, брови 300–500 ₴, массаж 600–1 200 ₴
- Норма прибыли: 15–25% от выручки`;
}

function getCurrency(country) {
  const c = (country || '').trim();
  if (c === 'Испания' || c === 'Германия' || c === 'Чехия' || c === 'ОАЭ') return '€';
  if (c === 'Польша') return 'zł';
  if (c === 'Чехия') return 'Kč';
  if (c === 'ОАЭ') return 'AED';
  if (c === 'Казахстан') return '₸';
  if (c === 'Грузия') return '₾';
  if (['Франция','Италия','Португалия','Нидерланды','Бельгия','Австрия'].includes(c)) return '€';
  return '₴';
}

function getTaxNote(country, taxFormId) {
  const c = (country || '').trim();
  const fid = taxFormId || '';
  if (c === 'Испания') return `
НАЛОГИ И ФАКТУРЫ (Испания) — Форма: ${fid === 'sl' ? 'Sociedad Limitada (SL)' : fid === 'comunidad' ? 'Comunidad de bienes' : 'Autónomo'}:
${fid === 'sl'
  ? '- IS (Impuesto Sociedades): 25% от прибыли (15% первые 2 года для новых SL)\n- Дивиденды: IRPF 19–26%\n- НДС (IVA) 21% — SL обязана быть плательщиком НДС'
  : fid === 'comunidad'
  ? '- Каждый партнёр платит IRPF со своей доли прибыли\n- SS autónomo: ~294 €/мес каждый'
  : '- IRPF: 15–37% (первые 2 года новый autónomo — 7% tarifa reducida)\n- SS autónomo: ~294 €/мес (tarifa plana первый год: 80 €)'}
- IVA 21% включён в цену услуг клиенту. Из выручки вычти IVA для расчёта чистого дохода
- Все расходы с фактурами (аренда, материалы, gestoría) вычитают входящий IVA → уменьшают квартальный платёж
- Seguridad Social autónomo: ~294 € базово (tarifa plana первый год: 80 €)
- IRPF: 15–37% от прибыли (первые 2 года 7% для новых autónomo)
- ОБЯЗАТЕЛЬНО добавить строку «Налоги и SS» в расчёт себестоимости`;
  if (c === 'Казахстан') return `
НАЛОГИ (Казахстан):
- ИП на упрощённой декларации: 3% от дохода (1.5% ИПН + 1.5% соц.налог), раз в полугодие
- ОПВ (пенсионные взносы): 10% от зарплаты каждого сотрудника
- СО (социальные отчисления): 3.5% от зарплаты
- ОСМС (медстрах, работодатель): 3% от зарплаты
- Итого нагрузка на ФОТ: ~16.5% сверх зарплаты
- НДС 12% только если оборот >20 000 МРП/год (малый салон обычно ниже порога)
- В расчёт себестоимости добавь: «Налог ИП» ~3% от выручки + «Отчисления ФОТ» ~16.5% от зарплат`;

  if (c === 'Казахстан') return `
НАЛОГИ (Казахстан):
- ИП на упрощённой декларации: 3% от дохода (1.5% ИПН + 1.5% соц.налог), раз в полугодие
- ОПВ (пенсионные взносы): 10% от зарплаты каждого сотрудника
- СО (социальные отчисления): 3.5% от зарплаты
- ОСМС (медстрах, работодатель): 3% от зарплаты
- Итого нагрузка на ФОТ: ~16.5% сверх зарплаты
- НДС 12% только если оборот >20 000 МРП/год (малый салон обычно ниже порога)
- В расчёт себестоимости: «Налог ИП» ~3% от выручки + «Отчисления ФОТ» ~16.5% от зарплат`;

  if (c === 'Польша') return `
НАЛОГИ (Польша):
- НДС на услуги красоты: 8% (льготная ставка)
- ZUS или Mały ZUS — фиксированный платёж
- Ryczałt 8.5% от дохода — популярный режим для малого бизнеса`;
  if (c === 'Казахстан') return `
НАЛОГИ (Казахстан):
- ИП на упрощённой декларации: 3% от дохода (1.5% ИПН + 1.5% соц.налог), сдаётся раз в полугодие
- ОПВ (обязательные пенсионные взносы): 10% от зарплаты каждого сотрудника
- СО (социальные отчисления): 3.5% от зарплаты
- ОСМС (медстрах работодатель): 3% от зарплаты
- Итого на сотрудника: ~16.5% сверх зарплаты
- НДС: 12% (только если оборот >20 000 МРП/год, для малых салонов обычно не нужен)
- ВАЖНО: добавить строку «Налоги ИП» (~3% от выручки) + «Отчисления с ФОТ» (~16.5% от зарплат) в расчёт себестоимости`;

  if (c === 'Чехия') return `
НАЛОГИ (Чехия):
- НДС: 21% на услуги
- Социальное + медицинское страхование работодателя: ~34% от брутто
- Daň z příjmů (налог на прибыль ИП): прогрессивный 15–23%`;

  if (c === 'ОАЭ') return `
НАЛОГИ (ОАЭ):
- НДС: 5% на большинство услуг
- Корпоративный налог: 9% от прибыли >375 000 AED (с 2023), иначе 0%
- Для сотрудников-иностранцев: нет НДФЛ, минимальные соц. взносы`;

    return `
НАЛОГИ (Украина):
- ФОП 2-я группа: ЄП ~1 340 ₴/мес + ЄСВ ~1 562 ₴/мес = ~2 900 ₴/мес (фиксировано)
- НДС при ФОП 2-й группы нет
- ПДФО + ВЗ с зарплат наёмных: 19.5% + ЄСВ 22%`;
}


// ─── Enrich prompt with real metrics from DB ─────────────────────────────────
async function getLatestMetrics(userId) {
  if (!userId) return null;
  try {
    const { query } = require('../lib/db');
    // Try manual metrics first (most recent month)
    const { rows: manual } = await query(
      `SELECT period, revenue, visits, avg_check, new_clients, return_rate, fot_pct, materials_pct, notes
       FROM manual_metrics
       WHERE user_id = $1 AND period_type = 'month'
       ORDER BY period DESC LIMIT 2`,
      [userId]
    );
    // Try cached metrics (from CRM)
    const { rows: cached } = await query(
      `SELECT date, revenue, visits, avg_check, new_clients, source
       FROM cached_metrics
       WHERE user_id = $1
       ORDER BY date DESC LIMIT 30`,
      [userId]
    );

    if (!manual.length && !cached.length) return null;

    const latest = manual[0];
    const prev   = manual[1];

    // Aggregate cached (last 30 days) if available
    let cachedAgg = null;
    if (cached.length) {
      const totalRev   = cached.reduce((s,r) => s + Number(r.revenue||0), 0);
      const totalVis   = cached.reduce((s,r) => s + Number(r.visits||0), 0);
      cachedAgg = { revenue: totalRev, visits: totalVis,
                    avg_check: totalVis > 0 ? Math.round(totalRev/totalVis) : 0,
                    source: cached[0].source, period: '30 дней' };
    }

    return { latest, prev, cached: cachedAgg };
  } catch { return null; }
}

function buildMetricsContext(metrics, currency) {
  if (!metrics) return '';
  const { latest, prev, cached } = metrics;

  let ctx = '\nРЕАЛЬНЫЕ ДАННЫЕ САЛОНА (использовать в расчётах):';

  if (cached) {
    ctx += `
Данные за последние 30 дней (источник: ${cached.source}):`;
    if (cached.revenue) ctx += `
- Выручка: ${Number(cached.revenue).toLocaleString('ru')} ${currency}`;
    if (cached.visits)  ctx += `
- Визитов: ${cached.visits}`;
    if (cached.avg_check) ctx += `
- Средний чек: ${Number(cached.avg_check).toLocaleString('ru')} ${currency}`;
  }

  if (latest) {
    const d = new Date(latest.period + '-01');
    const label = d.toLocaleDateString('ru', {month:'long', year:'numeric'});
    ctx += `
Данные за ${label}:`;
    if (latest.revenue)    ctx += `
- Выручка: ${Number(latest.revenue).toLocaleString('ru')} ${currency}`;
    if (latest.visits)     ctx += `
- Визитов: ${latest.visits}`;
    if (latest.avg_check)  ctx += `
- Средний чек: ${Number(latest.avg_check).toLocaleString('ru')} ${currency}`;
    if (latest.new_clients)ctx += `
- Новых клиентов: ${latest.new_clients}`;
    if (latest.return_rate)ctx += `
- Retention: ${latest.return_rate}%`;
    if (latest.fot_pct)    ctx += `
- ФОТ: ${latest.fot_pct}% от выручки`;
    if (latest.materials_pct) ctx += `
- Материалы: ${latest.materials_pct}% от выручки`;
    if (latest.notes)      ctx += `
- Заметки: ${latest.notes}`;
  }

  if (prev && latest) {
    const revDiff = latest.revenue && prev.revenue
      ? Math.round((latest.revenue - prev.revenue) / prev.revenue * 100) : null;
    if (revDiff !== null) ctx += `\n- Динамика выручки: ${revDiff >= 0 ? '+' : ''}${revDiff}% к предыдущему месяцу`;
  }

  ctx += '\nВАЖНО: используй эти реальные цифры в расчётах и документах, а не абстрактные примеры.';
  return ctx;
}

// ─── ANALYZE ────────────────────────────────────────────────────────────────

router.post('/analyze', async (req, res) => {
  const { scores, onboarding } = req.body;
  if (!scores || !onboarding) return res.status(400).json({ error: 'Нет данных аудита' });

  const country = onboarding.country || 'Украина';
  const cur     = getCurrency(country);
  const weak    = ['finance','hr','sales','clients','ops','owner','marketing']
    .filter(k => (scores[k]||0) < 50)
    .map(k => `${k}: ${scores[k]}%`).join(', ') || 'нет';

  const prompt = `Ты операционный директор сети салонов красоты с 10-летним опытом. Анализируй с учётом специфики рынка ${country}.

ДАННЫЕ САЛОНА:
Название: ${onboarding.name || 'Салон'}, ${onboarding.city || ''}, ${country}
Форма налогообложения: ${onboarding.taxForm || 'не указана'}
Мастеров: ${onboarding.masters || 'н/д'}, администраторов: ${onboarding.admins || 'н/д'}
Средний чек: ${onboarding.avgCheck || 'н/д'} ${cur}, выручка: ${onboarding.revenue || 'н/д'} ${cur}/мес
Прибыль: ${onboarding.profit || 'н/д'} ${cur}/мес, система записи: ${onboarding.crm || 'н/д'}

РЕЗУЛЬТАТЫ АУДИТА:
Финансы: ${scores.finance||0}%, Персонал: ${scores.hr||0}%, Продажи: ${scores.sales||0}%
Клиенты: ${scores.clients||0}%, Операционка: ${scores.ops||0}%
Собственник: ${scores.owner||0}%, Маркетинг: ${scores.marketing||0}%
Общий: ${scores.overall||0}%. Слабые блоки (<50%): ${weak}

${getMarketContext(country, onboarding.city, new Date().getFullYear())}${metricsCtx}

ТРЕБОВАНИЯ:
- Все суммы в ${cur}. Называй конкретные потери в деньгах используя данные выручки
- Учитывай специфику рынка ${country}: менталитет, ценообразование, налоги
- Для Украины: ФОТ мастеров 45–55% — это НОРМА, не проблема
- Для Испании: учитывай IVA, SS, gestoría в расчётах

Верни ТОЛЬКО JSON (без markdown):
{
  "main_problems": ["проблема 1 с суммой в ${cur}","проблема 2","проблема 3"],
  "top_weaknesses": ["слабость 1","слабость 2","слабость 3","слабость 4","слабость 5"],
  "risks": ["риск 1","риск 2","риск 3"],
  "profit_losses": "где теряется прибыль — конкретно в ${cur}",
  "priorities": ["1. первое действие","2. второе","3. третье"],
  "summary": "2-3 предложения: главный вывод и ключевая возможность"
}`;

  try {
    // Enrich with real metrics if available
    const metrics = await getLatestMetrics(req.user?.id);
    const metricsCtx = buildMetricsContext(metrics, cur);

    const msg  = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    });
    const text      = msg.content.map(c => c.text || '').join('');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
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

// ─── GENERATE ────────────────────────────────────────────────────────────────

router.post('/generate', async (req, res) => {
  if (!req.user.has_access) {
    return res.status(403).json({ error: 'Требуется план внедрения', code: 'ACCESS_REQUIRED' });
  }

  const { taskName, answers, salonData } = req.body;
  if (!taskName || taskName.length > 150) return res.status(400).json({ error: 'Некорректное название задачи' });

  const safeAnswers = (answers || '').toString().slice(0, 2000);
  const year        = new Date().getFullYear();
  const country     = salonData?.country || 'Украина';
  const city        = salonData?.city || '';
  const cur         = getCurrency(country);
  const market      = getMarketContext(country, city, year);
  const taxNote     = getTaxNote(country, salonData?.taxFormId);

  // Task-specific extra instructions
  const taskLower = taskName.toLowerCase();
  let taskExtra = '';

  if (taskLower.includes('себестоимост') || taskLower.includes('точк') || taskLower.includes('bep') || taskLower.includes('безубыточ')) {
    taskExtra = `
ВАЖНО ДЛЯ РАСЧЁТА СЕБЕСТОИМОСТИ И BEP:
${taxNote}
- Обязательно включи строку «Налоги» в статьи расходов с реальными цифрами для ${country}
- Маржинальность считай ПОСЛЕ налогов
- Если выручка указана с НДС (Испания) — покажи расчёт и с НДС и без
- Добавь строку «Запас прочности» = (Выручка - BEP) / Выручка × 100%`;
  }

  if (taskLower.includes('реклам') || taskLower.includes('instagram') || taskLower.includes('таргет')) {
    taskExtra = `
ВАЖНО ДЛЯ РЕКЛАМЫ:
- Реалистичный бюджет на таргет для малого салона: ${country === 'Испания' ? '300–800 €/мес' : '5 000–15 000 ₴/мес'}
- Это ТОЛЬКО рекламный бюджет платформы. Отдельно: услуги таргетолога ${country === 'Испания' ? '400–800 €/мес' : '8 000–15 000 ₴/мес'}
- НЕ пиши нереалистичные цифры (100–180 € за весь маркетинг — это невозможно)
- CAC (стоимость привлечения клиента): ${country === 'Испания' ? '15–40 €' : '150–400 ₴'}
- Ожидаемый результат: 20–40 новых клиентов в месяц при правильной настройке`;
  }

  if (taskLower.includes('фот') || taskLower.includes('мотивац') || taskLower.includes('зарплат') || taskLower.includes('kpi') || taskLower.includes('кпи')) {
    taskExtra = `
ВАЖНО ДЛЯ ФОТ И МОТИВАЦИИ (${country}):
${country === 'Украина' ? '- Реальная норма ФОТ мастеров в Украине ' + year + ': 45–55% (НЕ 35–40% — это устаревшие данные). Дефицит кадров после 2022 года повысил рыночную ставку\n- Администратор: оклад 15 000–22 000 ₴ + бонус 5–10% от выручки сверх плана' : ''}
${country === 'Испания' ? '- ФОТ мастеров: 33–42% (если со своими материалами — до 48%)\n- Администратор: 1 100–1 400 € брутто + Seguridad Social работодателя 30% сверху\n- Учитывай: mínimo convenio colectivo peluquería/estética' : ''}
- KPI должен содержать конкретные числа: не «повысить конверсию», а «конверсия ≥ 70%»
- Бонусная шкала: показывай точные пороги и суммы бонусов`;
  }

  if (taskLower.includes('контент') || taskLower.includes('instagram') || taskLower.includes('smm')) {
    taskExtra = `
ВАЖНО ДЛЯ КОНТЕНТ-ПЛАНА:
- Указывай конкретные форматы: Reels (15–30 сек), Stories (опрос/вопрос/за кулисами), пост (карусель/одно фото)
- Добавь реальные хэштеги для ${city || country}: локальные + нишевые
- Частота: минимум 4–5 Stories в день + 3–4 поста в неделю
- CTA в каждом посте: конкретное призывное действие`;
  }

  if (taskLower.includes('делегир') || taskLower.includes('стратег') || taskLower.includes('собственник') || taskLower.includes('управлен')) {
    taskExtra = `
ВАЖНО ДЛЯ БЛОКА СОБСТВЕННИК:
- Это самый болезненный блок: владелец вышел из мастера и не умеет не работать руками
- Добавь раздел «Личная эффективность»: тайм-менеджмент, энергия, выход из операционки
- Матрица делегирования: что делать ТОЛЬКО собственнику, что — управляющему, что — администратору
- Конкретный план: за 30/60/90 дней
- Добавь метрики для контроля без погружения: еженедельный дашборд (5 цифр за 15 минут)`;
  }

  const taxForm = salonData?.taxForm || '';
  const pricelistLine = (salonData?.pricelist || '').trim()
    ? `\nПРАЙС-ЛИСТ (использовать ТОЛЬКО эти цены, не придумывать):\n${salonData.pricelist.slice(0, 800)}`
    : '';
  const extraLines = [
    salonData?.workDays  ? `Рабочих дней в неделю: ${salonData.workDays}` : '',
    salonData?.workHours ? `Рабочие часы: ${salonData.workHours}` : '',
    salonData?.visitCycle? `Цикличность визитов клиентов: ${salonData.visitCycle} дней` : '',
  ].filter(Boolean).join('\n');

  // SSE streaming — keeps connection alive, no nginx 60s timeout
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // Load metrics BEFORE building prompt (was a ReferenceError bug before)
    const metrics    = await getLatestMetrics(req.user?.id);
    const metricsCtx = buildMetricsContext(metrics, cur);

    const prompt = `Ты операционный консультант для салонов красоты. Создай профессиональный рабочий документ который можно использовать с первого дня.

ДАННЫЕ САЛОНА (использовать точно):
Название: ${salonData?.name || 'Салон'}
Страна/Город: ${country}, ${city}
Форма налогообложения: ${taxForm || 'не указана'}
Мастеров: ${salonData?.masters || 'н/д'}, администраторов: ${salonData?.admins || 'н/д'}
Средний чек: ${salonData?.avgCheck || 'н/д'} ${cur}
Выручка: ${salonData?.revenue || 'н/д'} ${cur}/мес
Услуги: ${(salonData?.services||[]).join(', ') || 'не указаны'}
Система записи: ${salonData?.crm || 'не указана'}${extraLines ? '\n' + extraLines : ''}${pricelistLine}

${market}
${metricsCtx}
${taskExtra}

ДОКУМЕНТ: "${taskName}"

ОТВЕТЫ НА ВОПРОСЫ ФОРМЫ:
${safeAnswers || 'не указаны — используй данные салона выше'}

ТРЕБОВАНИЯ К ДОКУМЕНТУ:
- # Название документа (с именем салона)
- ## Разделы, ### Подразделы
- Конкретные цифры в ${cur} — НЕ абстрактные проценты без сумм
- Таблицы Markdown там где уместно (KPI, расчёты, матрицы)
- Расшифровывай термины при первом упоминании: ФОТ (фонд оплаты труда), BEP (точка безубыточности), CAC (стоимость привлечения клиента), LTV (пожизненная ценность клиента)
- Готово к применению сразу. Ноль воды и общих слов.
- Язык: русский (если город в Украине — можно украинский)`;

    let fullText = '';
    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-6', max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        fullText += event.delta.text;
        sendSSE({ chunk: event.delta.text });
      }
    }

    await query(
      'INSERT INTO generated_documents (user_id, task_name, content) VALUES ($1, $2, $3)',
      [req.user.id, taskName, fullText]
    ).catch(() => {});

    sendSSE({ done: true });
    res.end();
  } catch (err) {
    console.error('[AI GENERATE]', err.message);
    sendSSE({ error: err.message });
    res.end();
  }
});

// ─── REFINE ──────────────────────────────────────────────────────────────────

router.post('/refine', async (req, res) => {
  if (!req.user.has_access) {
    return res.status(403).json({ error: 'Требуется план внедрения', code: 'ACCESS_REQUIRED' });
  }

  const { taskName, originalContent, feedback, salonData } = req.body;
  if (!feedback || feedback.length > 1000) return res.status(400).json({ error: 'Укажите что нужно исправить' });
  if (!originalContent) return res.status(400).json({ error: 'Нет исходного документа' });

  const country = salonData?.country || 'Украина';
  const cur     = getCurrency(country);

  const prompt = `Ты операционный консультант для салонов красоты.

Документ "${taskName}" для салона "${salonData?.name || 'Салон'}" (${salonData?.city || ''}, ${country}):

${originalContent.slice(0, 3000)}

---
Запрос на доработку: ${feedback.slice(0, 1000)}

Улучши документ с учётом запроса. Все цифры в ${cur}. Верни полный улучшенный документ. Конкретно, без воды.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });
    const result = msg.content.map(c => c.text || '').join('');

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

// ─── DOCUMENTS ───────────────────────────────────────────────────────────────

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
