const express  = require('express');
const crypto   = require('crypto');
const { requireAuth }          = require('../middleware/auth');
const { query }                = require('../lib/db');
const { sendPaymentSuccess }   = require('../lib/mailer');

const router = express.Router();

const MERCHANT      = process.env.WAYFORPAY_MERCHANT_ACCOUNT;
const SECRET        = process.env.WAYFORPAY_SECRET_KEY;
const DOMAIN        = process.env.WAYFORPAY_MERCHANT_DOMAIN;
const APP_URL       = process.env.APP_URL || 'http://localhost:3000';
const PRICE         = Number(process.env.PLAN_PRICE) || 2999;
const CURRENCY      = 'UAH';
const PRODUCT       = 'Beauty Operations OS — AI Business Builder';
const ACCESS_MONTHS = 3;

const GRANT_STATUSES = ['Approved', 'InProcessing'];

function wayforpaySign(fields) {
  return crypto.createHmac('md5', SECRET).update(fields.join(';')).digest('hex');
}

function acceptResponse(orderReference) {
  const now = Math.floor(Date.now() / 1000);
  return {
    orderReference,
    status: 'accept',
    time: now,
    signature: wayforpaySign([orderReference, 'accept', now]),
  };
}

// POST /api/payment/checkout
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    if (req.user.has_access) {
      return res.status(400).json({ error: 'Доступ уже активирован' });
    }

    const orderRef  = `bos-${req.user.id.slice(0, 8)}-${Date.now()}`;
    const orderDate = Math.floor(Date.now() / 1000);

    const signFields = [MERCHANT, DOMAIN, orderRef, orderDate, PRICE, CURRENCY, PRODUCT, 1, PRICE];
    const signature  = wayforpaySign(signFields);

    await query(
      'INSERT INTO payments (user_id, order_id, amount, currency, status) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, orderRef, PRICE, CURRENCY, 'pending']
    );

    res.json({
      action: 'https://secure.wayforpay.com/pay',
      fields: {
        merchantAccount:    MERCHANT,
        merchantDomainName: DOMAIN,
        merchantSignature:  signature,
        orderReference:     orderRef,
        orderDate,
        amount:             PRICE,
        currency:           CURRENCY,
        'productName[]':    PRODUCT,
        'productCount[]':   1,
        'productPrice[]':   PRICE,
        returnUrl:          `${APP_URL}/payment/success`,
        serviceUrl:         `${APP_URL}/api/payment/callback`,
        clientFirstName:    req.user.name || '',
        clientEmail:        req.user.email || '',
      },
    });
  } catch (err) {
    console.error('[CHECKOUT]', err.message);
    res.status(500).json({ error: 'Ошибка создания платежа' });
  }
});

// POST /api/payment/callback — Wayforpay webhook
router.post('/callback', express.json(), express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const contentType = req.headers['content-type'] || 'unknown';
    console.log('[CALLBACK] content-type:', contentType, '| keys:', Object.keys(req.body || {}).join(',') || 'EMPTY');

    let body = req.body || {};
    if (!body.transactionStatus && typeof req.body === 'string') {
      try { body = JSON.parse(req.body); } catch {}
    }

    // Верификация подписи
    const expected = wayforpaySign([
      body.merchantAccount, body.orderReference, body.amount,
      body.currency, body.authCode, body.cardPan,
      body.transactionStatus, body.reasonCode,
    ]);
    if (body.merchantSignature !== expected) {
      console.warn('[CALLBACK] Invalid signature — expected:', expected, 'got:', body.merchantSignature);
    }

    const status = body.transactionStatus;
    console.log('[CALLBACK] status:', status, 'order:', body.orderReference);

    if (GRANT_STATUSES.includes(status)) {
      const { rows } = await query(
        'SELECT status, user_id FROM payments WHERE order_id = $1',
        [body.orderReference]
      );

      if (!rows.length) {
        console.warn('[CALLBACK] Order not found:', body.orderReference);
        return res.json(acceptResponse(body.orderReference));
      }

      // Идемпотентность — не обрабатываем повторно
      if (rows[0].status === 'paid') {
        return res.json(acceptResponse(body.orderReference));
      }

      // Обновляем статус платежа
      await query(
        'UPDATE payments SET status = $1, payload = $2 WHERE order_id = $3',
        ['paid', JSON.stringify(body), body.orderReference]
      );

      // Открываем доступ на 3 месяца
      const accessUntil = new Date();
      accessUntil.setMonth(accessUntil.getMonth() + ACCESS_MONTHS);

      await query(
        `UPDATE profiles
         SET has_access = true,
             access_expires_at = $1
         WHERE user_id = $2`,
        [accessUntil.toISOString(), rows[0].user_id]
      );

      console.log(`[CALLBACK] Access granted (${ACCESS_MONTHS}mo) to user:`, rows[0].user_id);

      // Отправляем письмо об успешной оплате (асинхронно, не блокируем ответ)
      setImmediate(async () => {
        try {
          const { rows: userRows } = await query(
            `SELECT u.email, u.name, p.salon_name
             FROM users u LEFT JOIN profiles p ON p.user_id = u.id
             WHERE u.id = $1`,
            [rows[0].user_id]
          );

          if (userRows.length) {
            await sendPaymentSuccess({
              to:         userRows[0].email,
              userName:   userRows[0].name,
              salonName:  userRows[0].salon_name,
              amount:     body.amount || PRICE,
              currency:   body.currency || CURRENCY,
              orderRef:   body.orderReference,
              userId:     rows[0].user_id,
            });
          }
        } catch (mailErr) {
          console.error('[CALLBACK mailer]', mailErr.message);
        }
      });

      return res.json(acceptResponse(body.orderReference));
    }

    // Неуспешные статусы
    if (['Declined', 'Expired'].includes(status)) {
      await query(
        "UPDATE payments SET status = 'failed', payload = $1 WHERE order_id = $2",
        [JSON.stringify(body), body.orderReference]
      ).catch(() => {});
    }

    res.json(acceptResponse(body.orderReference));
  } catch (err) {
    console.error('[CALLBACK ERROR]', err.message);
    res.status(500).json({ status: 'error' });
  }
});

// GET /api/payment/price
router.get('/price', (req, res) => {
  res.json({ amount: PRICE, currency: CURRENCY, months: ACCESS_MONTHS });
});

module.exports = router;
