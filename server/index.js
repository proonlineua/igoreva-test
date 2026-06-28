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
const adminRouter   = require('./routes/admin');
const crypto        = require('crypto');
const { execFile }  = require('child_process');

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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', ts: new Date().toISOString() });
});

// GitHub webhook auto-deploy
app.post('/api/deploy', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = process.env.DEPLOY_SECRET;
  if (!secret) return res.status(403).json({ error: 'not configured' });

  const sig = req.headers['x-hub-signature-256'];
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig || ''), Buffer.from(expected))) {
    return res.status(401).json({ error: 'invalid signature' });
  }

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
app.listen(PORT, () => {
  console.log(`Beauty OS running on port ${PORT}`);
  console.log(`URL: ${process.env.APP_URL || 'http://localhost:' + PORT}`);
});
