const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../lib/db');

const router = express.Router();

const MERCHANT = process.env.WAYFORPAY_MERCHANT_ACCOUNT;
const SECRET   = process.env.WAYFORPAY_SECRET_KEY;
const DOMAIN   = process.env.WAYFORPAY_MERCHANT_DOMAIN;
const APP_URL  = process.env.APP_URL || 'http://localhost:3000';
const PRICE    = Number(process.env.PLAN_PRICE) || 2999;
const CURRENCY = 'UAH';
const PRODUCT  = 'Beauty Operations OS — план внедрения';

function wayforpaySign(fields) {
  const str = fields.join(';');
  return crypto.createHmac('md5', SECRET).update(str).digest('hex');
}

// POST /api/payment/checkout
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    if (req.user.has_access) {
      return res.status(400).json({ error: 'Доступ уже активирован' });
    }

    const orderRef  = `bos-${req.user.id.slice(0, 8)}-${Date.now()}`;
    const orderDate = Math.floor(Date.now() / 1000);

    const signFields = [
      MERCHANT, DOMAIN, orderRef, orderDate,
      PRICE, CURRENCY,
      PRODUCT, 1, PRICE
    ];
    const signature = wayforpaySign(signFields);

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
        orderDate:          orderDate,
        amount:             PRICE,
        currency:           CURRENCY,
        'productName[]':    PRODUCT,
        'productCount[]':   1,
        'productPrice[]':   PRICE,
        returnUrl:          `${APP_URL}/payment/success`,
        serviceUrl:         `${APP_URL}/api/payment/callback`,
        clientFirstName:    req.user.name || '',
        clientEmail:        req.user.email || ''
      }
    });
  } catch (err) {
    console.error('[CHECKOUT]', err.message);
    res.status(500).json({ error: 'Ошибка создания платежа' });
  }
});

// POST /api/payment/callback — вызывается Wayforpay после оплаты
router.post('/callback', express.json(), async (req, res) => {
  try {
    const body = req.body;

    // Верификация подписи
    const signFields = [
      body.merchantAccount, body.orderReference, body.amount,
      body.currency, body.authCode, body.cardPan,
      body.transactionStatus, body.reasonCode
    ];
    const expected = wayforpaySign(signFields);
    if (body.merchantSignature !== expected) {
      console.warn('[CALLBACK] Invalid signature');
      return res.status(403).json({ status: 'error' });
    }

    console.log('[CALLBACK] status:', body.transactionStatus, 'order:', body.orderReference);

    if (body.transactionStatus === 'Approved') {
      // Идемпотентность: проверяем, не обработан ли уже
      const { rows } = await query(
        'SELECT status FROM payments WHERE order_id = $1',
        [body.orderReference]
      );
      if (rows[0]?.status === 'paid') {
        return res.json({ orderReference: body.orderReference, status: 'accept', time: Math.floor(Date.now() / 1000), signature: wayforpaySign([body.orderReference, 'accept', Math.floor(Date.now() / 1000)]) });
      }

      const now = Math.floor(Date.now() / 1000);
      await query(
        'UPDATE payments SET status = $1, payload = $2 WHERE order_id = $3',
        ['paid', JSON.stringify(body), body.orderReference]
      );

      const { rows: payRows } = await query('SELECT user_id FROM payments WHERE order_id = $1', [body.orderReference]);
      if (payRows.length) {
        await query('UPDATE profiles SET has_access = true WHERE user_id = $1', [payRows[0].user_id]);
        console.log('[CALLBACK] Access granted to user:', payRows[0].user_id);
      }

      // Обязательный ответ для Wayforpay
      const sig = wayforpaySign([body.orderReference, 'accept', now]);
      return res.json({ orderReference: body.orderReference, status: 'accept', time: now, signature: sig });
    }

    await query(
      "UPDATE payments SET status = 'failed', payload = $1 WHERE order_id = $2",
      [JSON.stringify(body), body.orderReference]
    ).catch(() => {});

    const now = Math.floor(Date.now() / 1000);
    const sig = wayforpaySign([body.orderReference, 'accept', now]);
    res.json({ orderReference: body.orderReference, status: 'accept', time: now, signature: sig });
  } catch (err) {
    console.error('[CALLBACK ERROR]', err.message);
    res.status(500).json({ status: 'error' });
  }
});

// GET /api/payment/price
router.get('/price', (req, res) => {
  res.json({ amount: PRICE, currency: CURRENCY });
});

module.exports = router;
