require('dotenv').config();

// Auto-configure missing .env values on first start
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const envPath = path.join(__dirname, '..', '.env');
const envDefaults = {
  APP_URL:   'https://beauty.proonline.com.ua',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '25',
  SMTP_USER: 'noreply@beauty.proonline.com.ua',
};
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  // Auto-generate BOT_ENCRYPTION_KEY if missing
  if (!envContent.includes('BOT_ENCRYPTION_KEY=')) {
    const key = crypto.randomBytes(16).toString('hex');
    fs.appendFileSync(envPath, `\nBOT_ENCRYPTION_KEY=${key}\n`);
    process.env.BOT_ENCRYPTION_KEY = key;
    console.log('[ENV] Generated BOT_ENCRYPTION_KEY');
  }
  const lines = Object.entries(envDefaults)
    .filter(([k]) => !envContent.includes(`${k}=`))
    .map(([k, v]) => `${k}=${v}`);
  if (lines.length) {
    fs.appendFileSync(envPath, '\n' + lines.join('\n') + '\n');
    lines.forEach(l => { const [k,v] = l.split('='); process.env[k] = v; });
    console.log('[ENV] Added defaults:', lines.map(l => l.split('=')[0]).join(', '));
  }
}
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const authRouter         = require('./routes/auth');
const aiRouter           = require('./routes/ai');
const paymentRouter      = require('./routes/payment');
const auditRouter        = require('./routes/audit');
const adminRouter        = require('./routes/admin');
const integrationsRouter = require('./routes/integrations');
const { execFile }       = require('child_process');

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'fonts.gstatic.com'],
      fontSrc:       ["'self'", 'fonts.gstatic.com'],
      connectSrc:    ["'self'", 'secure.wayforpay.com'],
      imgSrc:        ["'self'", 'data:'],
      formAction:    ["'self'", 'https://secure.wayforpay.com']
    }
  }
}));

const origin = process.env.APP_URL || 'http://localhost:3000';
app.use(cors({ origin, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

const globalLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const aiLimit     = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true,
  keyGenerator: req => {
    const token = req.cookies?.token;
    if (token) {
      try {
        const { verify } = require('./lib/jwt');
        return verify(token).userId;
      } catch {}
    }
    return req.ip;
  }
});
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });

app.use(globalLimit);
app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/auth',    authLimit,  authRouter);
app.use('/api/ai',      aiLimit,    aiRouter);
app.use('/api/payment',             paymentRouter);
app.use('/api/audit',               auditRouter);
app.use('/api/admin',               adminRouter);
app.use('/api/integrations',        integrationsRouter);
app.use('/api/bot',                 require('./routes/bot'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.5.0', ts: new Date().toISOString() });
});

// GitHub webhook auto-deploy
app.post('/api/deploy', (req, res) => {
  const secret = process.env.DEPLOY_SECRET;
  const token = req.headers['x-deploy-token'];
  if (!secret || token !== secret) return res.status(401).json({ error: 'unauthorized' });

  res.json({ ok: true });

  const appDir = path.join(__dirname, '..');
  execFile('bash', ['-c', `
    cd ${appDir} &&
    git fetch --prune origin main &&
    git reset --hard origin/main &&
    npm ci --omit=dev &&
    pm2 reload beauty-os --update-env
  `], (err, stdout, stderr) => {
    if (err) console.error('[DEPLOY ERROR]', stderr);
    else console.log('[DEPLOY OK]', stdout.trim().split('\n').pop());
  });
});

// Wayforpay redirects browser to returnUrl via POST after payment
app.post('/payment/success', (req, res) => {
  res.redirect(303, '/payment/success');
});

// Admin panel — must be before SPA catch-all
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack || err.message);
  res.status(err.status || 500).json({ error: err.message || 'Внутренняя ошибка' });
});

const PORT = process.env.PORT || 3000;

// Auto-run pending migrations on startup
async function runMigrations() {
  const { query } = require('./lib/db');
  try {
    await query(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

    // If tables already exist under another owner, mark 001 as applied without running it
    const { rows: usersExists } = await query(
      `SELECT 1 FROM information_schema.tables WHERE table_name='users' AND table_schema='public'`
    );
    if (usersExists.length) {
      await query(`INSERT INTO _migrations (name) VALUES ('001_initial_schema.sql') ON CONFLICT DO NOTHING`);
    }

    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      const { rows } = await query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
      if (rows.length) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      try {
        await query(sql);
        await query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        console.log(`[MIGRATION] Applied: ${file}`);
      } catch (err) {
        console.error(`[MIGRATION ERROR] ${file}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[MIGRATION ERROR]', err.message);
  }
}
runMigrations();

// Init Telegram bot
const beautyBot = require('./bot');
beautyBot.init();

// Init background CRM sync scheduler
const syncScheduler = require('./bot/syncScheduler');
syncScheduler.init();

app.listen(PORT, () => {
  console.log(`Beauty OS running on port ${PORT}`);
  console.log(`URL: ${process.env.APP_URL || 'http://localhost:' + PORT}`);
});

// Auto-restart when deploy.trigger file changes (written by git-pull cron)
const TRIGGER = path.join(__dirname, '..', 'deploy.trigger');
if (fs.existsSync(TRIGGER)) {
  fs.watch(TRIGGER, () => {
    console.log('[RESTART] deploy.trigger changed, restarting...');
    process.exit(0); // PM2 will restart automatically
  });
}
