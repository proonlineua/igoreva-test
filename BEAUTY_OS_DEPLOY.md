# Beauty Operations OS — Полная реализация для Claude Code

## Что делаем
Разворачиваем Node.js приложение на VPS с нуля. У нас уже есть `index.html` (фронтенд). Всё остальное создаём по этому файлу.

## Что нужно от пользователя перед стартом
Попроси предоставить:
- IP адрес VPS и root пароль
- SUPABASE_URL (из Supabase → Settings → API → Project URL)
- SUPABASE_ANON_KEY (из Supabase → Settings → API → anon/public)
- SUPABASE_SERVICE_KEY (из Supabase → Settings → API → service_role)
- ANTHROPIC_API_KEY (из console.anthropic.com → API Keys)
- LIQPAY_PUBLIC_KEY и LIQPAY_PRIVATE_KEY (из liqpay.ua → магазин → API)
- Домен (или сказать что домена пока нет)

---

## ШАГ 1 — Подключиться к серверу и установить всё нужное

```bash
# Подключение к серверу
ssh root@<IP_АДРЕС>

# Обновить систему
apt update && apt upgrade -y

# Установить Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Проверить
node --version   # должно быть v20.x.x
npm --version

# Установить nginx, certbot, unzip
apt install -y nginx certbot python3-certbot-nginx unzip

# Установить PM2 (держит приложение запущенным)
npm install -g pm2

# Создать папку проекта
mkdir -p /var/www/beauty-os/public
mkdir -p /var/www/beauty-os/server/lib
mkdir -p /var/www/beauty-os/server/middleware
mkdir -p /var/www/beauty-os/server/routes
mkdir -p /var/www/beauty-os/logs
```

---

## ШАГ 2 — Создать все файлы проекта

Выполни на сервере — создай каждый файл командой `cat > путь << 'EOF' ... EOF`.

### package.json

```bash
cat > /var/www/beauty-os/package.json << 'EOF'
{
  "name": "beauty-operations-os",
  "version": "1.0.0",
  "main": "server/index.js",
  "scripts": {
    "start": "node server/index.js",
    "dev": "nodemon server/index.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.24.0",
    "@supabase/supabase-js": "^2.43.0",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.3.1",
    "helmet": "^7.1.0",
    "node-fetch": "^3.3.2"
  },
  "devDependencies": {
    "nodemon": "^3.1.3"
  },
  "engines": { "node": ">=18.0.0" }
}
EOF
```

### server/index.js

```bash
cat > /var/www/beauty-os/server/index.js << 'EOF'
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');

const authRouter    = require('./routes/auth');
const aiRouter      = require('./routes/ai');
const paymentRouter = require('./routes/payment');
const auditRouter   = require('./routes/audit');

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdn.jsdelivr.net"],
      styleSrc:   ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "fonts.gstatic.com"],
      fontSrc:    ["'self'", "fonts.gstatic.com"],
      connectSrc: ["'self'", "*.supabase.co"],
      imgSrc:     ["'self'", "data:"],
    },
  },
}));

app.use(cors({ origin: process.env.APP_URL || 'http://localhost:3000', credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const globalLimit = rateLimit({ windowMs: 15*60*1000, max: 200, message: { error: 'Слишком много запросов.' } });
const aiLimit     = rateLimit({ windowMs: 60*1000,    max: 10,  message: { error: 'Лимит AI-запросов. Подождите минуту.' } });
const authLimit   = rateLimit({ windowMs: 15*60*1000, max: 20,  message: { error: 'Слишком много попыток входа.' } });

app.use(globalLimit);
app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/auth',    authLimit, authRouter);
app.use('/api/ai',      aiLimit,   aiRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/audit',   auditRouter);

app.get('/api/config', (req, res) => {
  res.json({ SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', ts: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Внутренняя ошибка' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Beauty OS запущен на порту ${PORT}`);
  console.log(`🌐 ${process.env.APP_URL || 'http://localhost:' + PORT}`);
});
EOF
```

### server/lib/supabase.js

```bash
cat > /var/www/beauty-os/server/lib/supabase.js << 'EOF'
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const supabasePublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

module.exports = { supabaseAdmin, supabasePublic };
EOF
```

### server/middleware/auth.js

```bash
cat > /var/www/beauty-os/server/middleware/auth.js << 'EOF'
const { supabasePublic, supabaseAdmin } = require('../lib/supabase');

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Необходима авторизация' });
    }
    const token = authHeader.slice(7);

    const { data: { user }, error } = await supabasePublic.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Сессия истекла. Войдите снова.' });
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, name, email, has_access, access_granted_at')
      .eq('id', user.id)
      .single();

    req.user = { ...user, profile };
    next();
  } catch (err) {
    console.error('[AUTH]', err.message);
    return res.status(401).json({ error: 'Ошибка авторизации' });
  }
}

module.exports = { requireAuth };
EOF
```

### server/routes/auth.js

```bash
cat > /var/www/beauty-os/server/routes/auth.js << 'EOF'
const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Вызывается после регистрации — создаёт профиль если триггер не сработал
router.post('/profile/init', requireAuth, async (req, res) => {
  try {
    const { user } = req;
    const name = req.body.name || user.user_metadata?.name || user.email.split('@')[0];

    const { data: existing } = await supabaseAdmin
      .from('profiles').select('id').eq('id', user.id).single();

    if (existing) return res.json({ success: true, already_exists: true });

    const { error } = await supabaseAdmin.from('profiles').insert({
      id: user.id, email: user.email, name, has_access: false,
      created_at: new Date().toISOString()
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[PROFILE INIT]', err);
    res.status(500).json({ error: 'Ошибка создания профиля' });
  }
});

// Текущий пользователь
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { user } = req;
    const p = user.profile;
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: p?.name || user.email.split('@')[0],
        has_access: p?.has_access || false
      }
    });
  } catch (err) {
    console.error('[ME]', err);
    res.status(500).json({ error: 'Ошибка получения профиля' });
  }
});

module.exports = router;
EOF
```

### server/routes/ai.js

```bash
cat > /var/www/beauty-os/server/routes/ai.js << 'EOF'
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../lib/supabase');

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.use(requireAuth);

// БЕСПЛАТНО — анализ результатов аудита
router.post('/analyze', async (req, res) => {
  const { scores, onboarding } = req.body;
  if (!scores || !onboarding) return res.status(400).json({ error: 'Нет данных' });

  const weak = ['finance','hr','sales','clients','ops','owner','marketing']
    .filter(k => (scores[k]||0) < 50)
    .map(k => `${k}: ${scores[k]}%`).join(', ') || 'нет';

  const prompt = `Ты операционный директор сети салонов красоты с 10-летним опытом.

Данные: ${onboarding.name}, ${onboarding.country} ${onboarding.city}
Мастеров: ${onboarding.masters}, администраторов: ${onboarding.admins}
Средний чек: ${onboarding.avgCheck||'н/д'} ₴, выручка: ${onboarding.revenue||'н/д'} ₴/мес

Рейтинги аудита:
Финансы: ${scores.finance||0}%, Персонал: ${scores.hr||0}%, Продажи: ${scores.sales||0}%
Клиенты: ${scores.clients||0}%, Операционка: ${scores.ops||0}%
Собственник: ${scores.owner||0}%, Маркетинг: ${scores.marketing||0}%
Общий: ${scores.overall||0}%. Слабые блоки: ${weak}

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
      model: 'claude-sonnet-4-20250514', max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = message.content.map(c => c.text||'').join('');
    const result = JSON.parse(text.replace(/```json|```/g,'').trim());

    await supabaseAdmin.from('audit_analyses').insert({
      user_id: req.user.id, scores, analysis: result,
      created_at: new Date().toISOString()
    }).catch(() => {});

    res.json({ success: true, analysis: result });
  } catch (err) {
    console.error('[AI ANALYZE]', err);
    res.status(500).json({ error: 'Ошибка AI-анализа' });
  }
});

// ПЛАТНО — генерация документов (требует has_access = true)
router.post('/generate', async (req, res) => {
  if (!req.user.profile?.has_access) {
    return res.status(403).json({ error: 'Требуется план внедрения', code: 'ACCESS_REQUIRED' });
  }

  const { taskName, answers, salonData } = req.body;
  if (!taskName) return res.status(400).json({ error: 'Нет названия задачи' });

  const prompt = `Ты операционный консультант для салонов красоты.
Создай "${taskName}" для салона "${salonData?.name||'Салон'}".
Город: ${salonData?.city||''}, мастеров: ${salonData?.masters||'н/д'}, средний чек: ${salonData?.avgCheck||'н/д'} ₴.

Ответы на вопросы:
${answers||'не указаны'}

Требования: конкретно, структурированно, готово к использованию сразу. Без воды.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });
    const result = message.content.map(c => c.text||'').join('');

    await supabaseAdmin.from('generated_documents').insert({
      user_id: req.user.id, task_name: taskName, content: result,
      created_at: new Date().toISOString()
    }).catch(() => {});

    res.json({ success: true, content: result });
  } catch (err) {
    console.error('[AI GENERATE]', err);
    res.status(500).json({ error: 'Ошибка генерации' });
  }
});

module.exports = router;
EOF
```

### server/routes/payment.js

```bash
cat > /var/www/beauty-os/server/routes/payment.js << 'EOF'
const express = require('express');
const crypto  = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../lib/supabase');

const router = express.Router();
const LIQPAY_PUBLIC  = process.env.LIQPAY_PUBLIC_KEY;
const LIQPAY_PRIVATE = process.env.LIQPAY_PRIVATE_KEY;
const APP_URL        = process.env.APP_URL || 'http://localhost:3000';
const PRICE          = process.env.PLAN_PRICE || 99;

function liqpaySign(data) {
  return crypto.createHash('sha1')
    .update(LIQPAY_PRIVATE + data + LIQPAY_PRIVATE).digest('base64');
}

// Создать форму оплаты LiqPay — разовый платёж $99
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    if (req.user.profile?.has_access) {
      return res.status(400).json({ error: 'Доступ уже активирован' });
    }

    const orderId = `bos-${req.user.id.slice(0,8)}-${Date.now()}`;
    const params = {
      version: 3, public_key: LIQPAY_PUBLIC, action: 'pay',
      amount: PRICE, currency: 'USD',
      description: 'Beauty Operations OS — план внедрения',
      order_id: orderId,
      result_url: `${APP_URL}/payment/success`,
      server_url: `${APP_URL}/api/payment/callback`,
      info: JSON.stringify({ userId: req.user.id })
    };

    const data      = Buffer.from(JSON.stringify(params)).toString('base64');
    const signature = liqpaySign(data);

    await supabaseAdmin.from('payments').insert({
      user_id: req.user.id, order_id: orderId,
      amount: PRICE, currency: 'USD', status: 'pending',
      created_at: new Date().toISOString()
    });

    res.json({ data, signature, action: 'https://www.liqpay.ua/api/3/checkout' });
  } catch (err) {
    console.error('[CHECKOUT]', err);
    res.status(500).json({ error: 'Ошибка создания платежа' });
  }
});

// LiqPay webhook — вызывается после успешной оплаты
router.post('/callback', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { data, signature } = req.body;
    if (!data || !signature) return res.status(400).send('Bad request');

    if (liqpaySign(data) !== signature) {
      console.warn('[CALLBACK] Invalid signature');
      return res.status(403).send('Invalid signature');
    }

    const payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    console.log('[CALLBACK]', payload.status, payload.order_id);

    if (payload.status === 'success' || payload.status === 'sandbox') {
      const { userId } = JSON.parse(payload.info || '{}');
      if (!userId) return res.status(400).send('Missing userId');

      await supabaseAdmin.from('profiles')
        .update({ has_access: true, access_granted_at: new Date().toISOString() })
        .eq('id', userId);

      await supabaseAdmin.from('payments')
        .update({ status: 'paid', paid_at: new Date().toISOString(), liqpay_status: payload.status })
        .eq('order_id', payload.order_id);

      console.log(`✅ Доступ открыт: ${userId}`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('[CALLBACK ERROR]', err);
    res.status(500).send('Error');
  }
});

router.get('/price', (req, res) => {
  res.json({ amount: PRICE, currency: 'USD' });
});

module.exports = router;
EOF
```

### server/routes/audit.js

```bash
cat > /var/www/beauty-os/server/routes/audit.js << 'EOF'
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../lib/supabase');

const router = express.Router();
router.use(requireAuth);

router.post('/save', async (req, res) => {
  try {
    const { onboarding, answers, scores, completedTasks } = req.body;
    const { error } = await supabaseAdmin.from('audits').upsert({
      user_id: req.user.id, onboarding, answers, scores,
      completed_tasks: completedTasks || [],
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[AUDIT SAVE]', err);
    res.status(500).json({ error: 'Ошибка сохранения' });
  }
});

router.get('/load', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('audits').select('*').eq('user_id', req.user.id).single();
    if (error && error.code !== 'PGRST116') throw error;
    res.json({ audit: data || null });
  } catch (err) {
    console.error('[AUDIT LOAD]', err);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

router.post('/task', async (req, res) => {
  try {
    const { taskId, done } = req.body;
    const { data: current } = await supabaseAdmin
      .from('audits').select('completed_tasks').eq('user_id', req.user.id).single();
    let tasks = current?.completed_tasks || [];
    if (done && !tasks.includes(taskId)) tasks.push(taskId);
    if (!done) tasks = tasks.filter(t => t !== taskId);
    await supabaseAdmin.from('audits')
      .update({ completed_tasks: tasks, updated_at: new Date().toISOString() })
      .eq('user_id', req.user.id);
    res.json({ success: true, completed_tasks: tasks });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления задачи' });
  }
});

module.exports = router;
EOF
```

### ecosystem.config.js (PM2)

```bash
cat > /var/www/beauty-os/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'beauty-os',
    script: 'server/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: { NODE_ENV: 'production', PORT: 3000 },
    error_file: './logs/error.log',
    out_file:   './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    time: true
  }]
};
EOF
```

---

## ШАГ 3 — Скопировать index.html на сервер

У пользователя есть файл `index.html` локально. Загрузить его на сервер:

```bash
# Выполнить ЛОКАЛЬНО на компьютере пользователя (не на сервере!)
scp /путь/к/index.html root@<IP_АДРЕС>:/var/www/beauty-os/public/index.html
```

Если пользователь в VS Code — можно через терминал VS Code.
Если использует MobaXterm — через встроенный файловый менеджер (слева).

---

## ШАГ 4 — Создать .env файл с реальными ключами

```bash
cat > /var/www/beauty-os/.env << 'EOF'
SUPABASE_URL=СЮДА_ВСТАВИТЬ
SUPABASE_ANON_KEY=СЮДА_ВСТАВИТЬ
SUPABASE_SERVICE_KEY=СЮДА_ВСТАВИТЬ
ANTHROPIC_API_KEY=СЮДА_ВСТАВИТЬ
LIQPAY_PUBLIC_KEY=СЮДА_ВСТАВИТЬ
LIQPAY_PRIVATE_KEY=СЮДА_ВСТАВИТЬ
PORT=3000
APP_URL=https://ДОМЕН_ИЛИ_IP
NODE_ENV=production
PLAN_PRICE=99
EOF
```

Затем открыть и заполнить реальными значениями:

```bash
nano /var/www/beauty-os/.env
```

Управление в nano: стрелки для перемещения, вставить значение, сохранить `Ctrl+O` → Enter → выйти `Ctrl+X`.

---

## ШАГ 5 — Установить зависимости и запустить

```bash
cd /var/www/beauty-os
npm install --production

# Запустить через PM2
pm2 start ecosystem.config.js

# Сохранить список процессов (чтобы запускался после перезагрузки сервера)
pm2 save

# Настроить автозапуск
pm2 startup
# PM2 выдаст команду — скопировать и выполнить её

# Проверить что работает
pm2 status
curl http://localhost:3000/api/health
```

Должно вернуть: `{"status":"ok","version":"1.0.0"}`

---

## ШАГ 6 — Настроить базу данных Supabase

Это нужно сделать ОДИН РАЗ в браузере.

1. Открыть [supabase.com](https://supabase.com) → свой проект
2. Левое меню → **SQL Editor** → **New query**
3. Вставить и выполнить этот SQL:

```sql
-- PROFILES — профили пользователей
CREATE TABLE IF NOT EXISTS public.profiles (
  id                UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  name              TEXT NOT NULL DEFAULT '',
  has_access        BOOLEAN NOT NULL DEFAULT false,
  access_granted_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- PAYMENTS — история платежей
CREATE TABLE IF NOT EXISTS public.payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  order_id      TEXT UNIQUE NOT NULL,
  amount        DECIMAL(10,2) NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','paid','failed','refunded')),
  liqpay_status TEXT,
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- AUDITS — результаты аудитов
CREATE TABLE IF NOT EXISTS public.audits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  onboarding       JSONB NOT NULL DEFAULT '{}',
  answers          JSONB NOT NULL DEFAULT '{}',
  scores           JSONB NOT NULL DEFAULT '{}',
  completed_tasks  TEXT[] DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id)
);

-- AUDIT_ANALYSES — AI-анализы
CREATE TABLE IF NOT EXISTS public.audit_analyses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scores      JSONB NOT NULL DEFAULT '{}',
  analysis    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- GENERATED_DOCUMENTS — сгенерированные документы
CREATE TABLE IF NOT EXISTS public.generated_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_name   TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_profiles_access ON public.profiles(has_access);
CREATE INDEX IF NOT EXISTS idx_payments_user   ON public.payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_order  ON public.payments(order_id);
CREATE INDEX IF NOT EXISTS idx_audits_user     ON public.audits(user_id);
CREATE INDEX IF NOT EXISTS idx_analyses_user   ON public.audit_analyses(user_id);
CREATE INDEX IF NOT EXISTS idx_docs_user       ON public.generated_documents(user_id);

-- Row Level Security
ALTER TABLE public.profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audits              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_analyses      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles: own"  ON public.profiles            FOR ALL USING (auth.uid() = id);
CREATE POLICY "payments: own"  ON public.payments            FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "audits: own"    ON public.audits              FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "analyses: own"  ON public.audit_analyses      FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "docs: own"      ON public.generated_documents FOR ALL USING (auth.uid() = user_id);

-- Автообновление updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER audits_updated_at BEFORE UPDATE ON public.audits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Автосоздание профиля при регистрации
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, name, has_access)
  VALUES (
    NEW.id, NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    false
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
```

4. Нажать **Run** → должно написать Success
5. В Supabase → **Authentication** → **Providers** → **Email** → убедиться что включён

---

## ШАГ 7 — Настроить nginx и SSL

```bash
# Создать конфиг nginx
cat > /etc/nginx/sites-available/beauty-os << 'EOF'
server {
    listen 80;
    server_name ДОМЕН www.ДОМЕН;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
EOF

# Заменить ДОМЕН на реальный домен
nano /etc/nginx/sites-available/beauty-os

# Включить конфиг
ln -sf /etc/nginx/sites-available/beauty-os /etc/nginx/sites-enabled/

# Проверить и перезапустить
nginx -t && systemctl restart nginx

# Получить SSL сертификат (бесплатно)
certbot --nginx -d ДОМЕН -d www.ДОМЕН
# Ввести email, согласиться (Y), выбрать редирект (2)

# Перезапустить nginx
systemctl reload nginx
```

**Если домена ещё нет** — пропустить certbot, сайт будет работать по IP на HTTP.

---

## ШАГ 8 — Настроить LiqPay

1. Зарегистрироваться на [liqpay.ua](https://www.liqpay.ua/)
2. Создать магазин → указать домен сайта
3. Скопировать Public Key и Private Key
4. Обновить `.env`:

```bash
nano /var/www/beauty-os/.env
# Заменить LIQPAY_PUBLIC_KEY и LIQPAY_PRIVATE_KEY на боевые
pm2 restart beauty-os
```

5. В настройках магазина LiqPay указать **Server callback URL**:
```
https://ДОМЕН/api/payment/callback
```

**Тестовая карта для проверки:**
- Номер: `4242 4242 4242 4242`
- Срок: любой будущий
- CVV: `123`
- OTP: `123456`

---

## ШАГ 9 — Проверить всё работает

```bash
# Статус процесса
pm2 status

# Логи в реальном времени
pm2 logs beauty-os

# Health check
curl http://localhost:3000/api/health

# Открыть в браузере
# http://IP_АДРЕС:3000  (без домена)
# https://ДОМЕН         (с доменом)
```

---

## Полезные команды для обслуживания

```bash
# Перезапустить после изменений
pm2 restart beauty-os

# Посмотреть логи ошибок
pm2 logs beauty-os --err --lines 50

# Мониторинг в реальном времени
pm2 monit

# Обновить код (если проект на git)
cd /var/www/beauty-os && git pull && npm install --production && pm2 restart beauty-os

# Статус nginx
systemctl status nginx

# Обновить SSL (автоматически, но можно вручную)
certbot renew
```

---

## Структура проекта после создания

```
/var/www/beauty-os/
├── server/
│   ├── index.js              ← главный сервер Express
│   ├── lib/
│   │   └── supabase.js       ← клиент Supabase (admin + public)
│   ├── middleware/
│   │   └── auth.js           ← проверка JWT токена Supabase
│   └── routes/
│       ├── auth.js           ← /api/auth/me, /api/auth/profile/init
│       ├── ai.js             ← /api/ai/analyze (бесплатно), /api/ai/generate (платно)
│       ├── payment.js        ← /api/payment/checkout, /api/payment/callback
│       └── audit.js          ← /api/audit/save, /api/audit/load, /api/audit/task
├── public/
│   └── index.html            ← фронтенд (загружается отдельно)
├── logs/
│   ├── error.log
│   └── out.log
├── ecosystem.config.js       ← конфиг PM2
├── package.json
└── .env                      ← секретные ключи (не в git!)
```

---

## Бизнес-логика доступа

| Действие | Требует |
|---|---|
| Пройти аудит | Ничего (даже без регистрации) |
| Увидеть рейтинги | Ничего |
| AI-анализ (проблемы, риски) | Регистрация (бесплатно) |
| Роадмап внедрения | `has_access = true` ($99) |
| AI генерация документов | `has_access = true` ($99) |
| Шаблоны | `has_access = true` ($99) |
| Повторный аудит | `has_access = true` (уже куплен) |

После оплаты LiqPay автоматически вызывает `/api/payment/callback` → ставит `has_access = true` в таблице `profiles` → пользователь сразу получает доступ без перезагрузки.
