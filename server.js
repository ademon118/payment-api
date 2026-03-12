require('dotenv').config();
const express = require('express');
const cors = require('cors');
// node-fetch v3 is ESM-only; in CJS `require('node-fetch')` returns an object.
// This wrapper works in CommonJS across node-fetch versions.
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));

const app = express();
const PORT = process.env.PORT || 4000;
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:4200';

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

if (!TOSS_SECRET_KEY) {
  console.warn('[payments-api] Missing TOSS_SECRET_KEY in environment (.env / process.env).');
} else {
  console.log('[payments-api] TOSS_SECRET_KEY loaded (length):', TOSS_SECRET_KEY.length);
}

const BASIC_TOKEN = TOSS_SECRET_KEY
  ? Buffer.from(`${TOSS_SECRET_KEY}:`, 'utf-8').toString('base64')
  : '';

// Health check for Railway / load balancers (proves routing and container are up)
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, service: 'payments-api' });
});

// POST /payments/confirm
// Body: { paymentKey, orderId, amount }
app.post('/payments/confirm', async (req, res) => {
  const { paymentKey, orderId, amount } = req.body;

  if (!paymentKey || !orderId || !amount) {
    return res.status(400).json({ message: 'paymentKey, orderId, amount are required' });
  }
  if (!BASIC_TOKEN) {
    return res.status(500).json({ message: 'Server is not configured: missing TOSS_SECRET_KEY' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    console.log('[payments-api] Confirming payment', { paymentKey, orderId, amount });

    const tossRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${BASIC_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await tossRes.json();

    if (!tossRes.ok) {
      console.error('[payments-api] Toss confirm error', tossRes.status, data);
      return res.status(tossRes.status).json(data);
    }

    console.log('[payments-api] Payment confirmed', { paymentKey, orderId });
    // TODO: save order, mark as paid, etc.
    return res.json(data);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.error('[payments-api] Toss confirm timeout');
      return res.status(504).json({ message: 'Timed out confirming payment with Toss' });
    }

    console.error('[payments-api] Internal error during confirm', err);
    return res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// POST /toss/webhook
// Registered in Toss dashboard as the webhook URL for:
// - PAYMENT_STATUS_CHANGED
// - DEPOSIT_CALLBACK
// - CANCEL_STATUS_CHANGED
app.post('/toss/webhook', (req, res) => {
  const event = req.body || {};
  const { eventType, data } = event;

  console.log('[Toss Webhook] eventType:', eventType, 'data:', data);

  switch (eventType) {
    case 'PAYMENT_STATUS_CHANGED': {
      const { paymentKey, status, orderId, approvedAt, totalAmount } = data || {};
      // TODO: update order payment status in your database using orderId/paymentKey.
      console.log('PAYMENT_STATUS_CHANGED', { paymentKey, status, orderId, approvedAt, totalAmount });
      break;
    }
    case 'DEPOSIT_CALLBACK': {
      const { orderId, status, virtualAccount } = data || {};
      // TODO: for virtual accounts, mark order as paid when deposit is completed.
      console.log('DEPOSIT_CALLBACK', { orderId, status, virtualAccount });
      break;
    }
    case 'CANCEL_STATUS_CHANGED': {
      const { paymentKey, cancelStatus, canceledAt } = data || {};
      // TODO: update cancellation status for the payment/order.
      console.log('CANCEL_STATUS_CHANGED', { paymentKey, cancelStatus, canceledAt });
      break;
    }
    default: {
      console.log('Unhandled Toss webhook type', eventType, event);
    }
  }

  // Toss requires a 2xx within 10 seconds; simple 200 OK is enough.
  res.status(200).send('ok');
});

app.listen(PORT, () => {
  console.log(`Toss backend running on http://localhost:${PORT}`);
});