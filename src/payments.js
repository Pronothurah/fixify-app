/**
 * Payments abstraction layer — same shape as src/notifications.js.
 *
 * Route code never talks to M-Pesa directly; it calls `getPaymentProvider()`
 * and calls `.initiate()` on whatever comes back. Which provider that is
 * (mock vs real Daraja) is a `PAYMENT_PROVIDER` env var, not a rewrite.
 *
 * M-Pesa's STK Push ("Lipa Na M-Pesa Online") is inherently asynchronous:
 * you kick off a push, the customer enters their PIN on their phone, and
 * Safaricom calls your CallBackURL some seconds later with the result. The
 * mock provider simulates that same asynchronous shape locally (a timer
 * instead of a real callback), so the exact same completePayment() logic
 * — updating the DB and notifying both sides — runs whether the result
 * came from a real Daraja callback hitting POST /api/payments/mpesa/callback
 * or from the mock provider's internal timer.
 *
 * Payment happens when a driver selects a vendor (job status
 * 'awaiting_payment'), before that vendor is ever dispatched — see
 * /select-vendor in routes/jobs.js. So completePayment() below is also
 * where the vendor actually finds out about the job (flips it to
 * 'matched' and notifies them) on success. The payout to the vendor is a
 * separate, later step — it fires when the job is marked completed (see
 * routes/vendors.js), not here, since paying the vendor before they've
 * done the work would just move the non-payment risk onto drivers instead
 * of fixing it.
 */
const db = require('./db');
const { safeNotify } = require('./notifications');

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

// Default provider — no Safaricom account needed. Immediately returns a
// fake CheckoutRequestID, then "delivers" a fake successful callback a few
// seconds later, exactly like a real STK push would once the user enters
// their PIN.
function mockProvider() {
  return {
    name: 'mock',
    async initiate({ paymentId, amount }) {
      const checkoutRequestId = `MOCK-${Date.now()}-${paymentId}`;
      const delayMs = 4000 + Math.random() * 2500;

      setTimeout(() => {
        completePayment({
          providerReference: checkoutRequestId,
          success: true,
          receiptNumber: `MOCK${Math.floor(100000 + Math.random() * 900000)}`,
        }).catch((err) => console.error('[payments:mock] auto-complete failed:', err.message));
      }, delayMs);

      console.log(`\n💳 [payments:mock] STK push simulated for KES ${amount} — auto-completing in ~${Math.round(delayMs / 1000)}s (ref: ${checkoutRequestId})\n`);
      return { checkoutRequestId };
    },
  };
}

// Real Safaricom Daraja (Lipa Na M-Pesa Online / STK Push) integration.
// Not backed by a real account in this build — if credentials are missing,
// getPaymentProvider() below falls back to the mock provider before this
// is ever reached. See README "Going live with real Daraja credentials".
function darajaProvider() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;
  const env = process.env.MPESA_ENV === 'production' ? 'production' : 'sandbox';
  const baseUrl =
    env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

  function darajaTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  async function getAccessToken() {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const res = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Could not obtain Daraja access token: ${JSON.stringify(data)}`);
    }
    return data.access_token;
  }

  return {
    name: 'daraja',
    async initiate({ amount, phone, accountRef }) {
      const timestamp = darajaTimestamp();
      const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
      const token = await getAccessToken();

      const res = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: 'CustomerPayBillOnline',
          Amount: Math.max(1, Math.round(amount)),
          PartyA: phone,
          PartyB: shortcode,
          PhoneNumber: phone,
          CallBackURL: callbackUrl,
          AccountReference: accountRef,
          TransactionDesc: 'Fixify roadside assistance payment',
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.CheckoutRequestID) {
        throw new Error(`Daraja STK push failed: ${JSON.stringify(data)}`);
      }
      return { checkoutRequestId: data.CheckoutRequestID };
    },
  };
}

// IntaSend collection: an M-Pesa STK push that deposits into a platform
// wallet (the "escrow" side — see src/payouts.js for the release side).
// Unlike Daraja, IntaSend's collection API is a simple public_key-in-body
// POST with no OAuth/token dance, and settlement is confirmed via a
// webhook keyed on `api_ref` (see POST /api/payments/intasend/callback).
function intasendProvider() {
  const publicKey = process.env.INTASEND_PUBLIC_KEY;
  const env = process.env.INTASEND_ENV === 'live' ? 'live' : 'sandbox';
  const baseUrl = env === 'live' ? 'https://payment.intasend.com' : 'https://sandbox.intasend.com';

  return {
    name: 'intasend',
    async initiate({ paymentId, amount, phone }) {
      // api_ref must uniquely identify this *attempt*, not just the job — a
      // retried payment creates a new `payments` row for the same job, and
      // the webhook matches back to us purely by api_ref.
      const apiRef = `FIXIFY-PAY-${paymentId}`;
      const res = await fetch(`${baseUrl}/api/v1/payment/collection/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          public_key: publicKey,
          currency: 'KES',
          method: 'M-PESA',
          amount: Math.max(1, Math.round(amount)),
          api_ref: apiRef,
          name: 'Fixify driver',
          phone_number: phone,
          wallet_id: process.env.INTASEND_WALLET_ID,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.invoice || !data.invoice.invoice_id) {
        throw new Error(`IntaSend collection failed: ${JSON.stringify(data)}`);
      }
      return { checkoutRequestId: apiRef };
    },
  };
}

// Kopo Kopo (K2 Connect) collection — an M-Pesa STK push via their
// `incoming_payments` API. Unlike the Daraja and IntaSend providers above,
// every request/response shape here — including both the success AND
// failure webhook payloads — was verified against Kopo Kopo's real sandbox
// while building this (not just read from docs, which have real gaps: e.g.
// `event.errors` on failure is a plain string, not the array their guide
// describes). See README "Going live with Kopo Kopo" for the verified
// request/webhook shapes.
// Kopo Kopo rejects phone numbers with a leading '+' (confirmed by a real
// sandbox 400: "invalid length or format") — vendors are stored as
// +254... in the DB, so this strips it before every request.
function toKopoKopoPhone(phone) {
  return String(phone || '').replace(/^\+/, '');
}

function kopokopoProvider() {
  const clientId = process.env.KOPOKOPO_CLIENT_ID;
  const clientSecret = process.env.KOPOKOPO_CLIENT_SECRET;
  const tillNumber = process.env.KOPOKOPO_TILL_NUMBER;
  const callbackUrl = process.env.KOPOKOPO_CALLBACK_URL;
  const env = process.env.KOPOKOPO_ENV === 'production' ? 'production' : 'sandbox';
  const baseUrl = env === 'production' ? 'https://api.kopokopo.com' : 'https://sandbox.kopokopo.com';

  // No refresh tokens in K2 Connect — a fresh token is fetched per request,
  // same approach the Daraja provider above already takes.
  async function getAccessToken() {
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Could not obtain Kopo Kopo access token: ${JSON.stringify(data)}`);
    }
    return data.access_token;
  }

  return {
    name: 'kopokopo',
    async initiate({ paymentId, amount, phone }) {
      const token = await getAccessToken();
      const reference = `FIXIFY-PAY-${paymentId}`;

      const res = await fetch(`${baseUrl}/api/v2/incoming_payments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          payment_channel: 'M-PESA STK Push',
          till_number: tillNumber,
          subscriber: { first_name: 'Fixify', last_name: 'driver', phone_number: toKopoKopoPhone(phone) },
          amount: { currency: 'KES', value: String(Math.max(1, Math.round(amount))) },
          metadata: { reference },
          _links: { callback_url: callbackUrl },
        }),
      });

      // Success returns 201 with no body — the transaction id is only in
      // the Location header (confirmed against the real sandbox).
      const location = res.headers.get('location');
      if (!res.ok || !location) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(`Kopo Kopo incoming_payments failed: ${JSON.stringify(errBody)}`);
      }
      const transactionId = location.split('/').pop();
      return { checkoutRequestId: transactionId };
    },
  };
}

const PROVIDERS = { mock: mockProvider, daraja: darajaProvider, intasend: intasendProvider, kopokopo: kopokopoProvider };
const DARAJA_REQUIRED_ENV = [
  'MPESA_CONSUMER_KEY',
  'MPESA_CONSUMER_SECRET',
  'MPESA_SHORTCODE',
  'MPESA_PASSKEY',
  'MPESA_CALLBACK_URL',
];
const INTASEND_REQUIRED_ENV = ['INTASEND_PUBLIC_KEY', 'INTASEND_WALLET_ID'];
const KOPOKOPO_REQUIRED_ENV = ['KOPOKOPO_CLIENT_ID', 'KOPOKOPO_CLIENT_SECRET', 'KOPOKOPO_TILL_NUMBER', 'KOPOKOPO_CALLBACK_URL'];

function getPaymentProvider() {
  const name = process.env.PAYMENT_PROVIDER || 'mock';

  if (name === 'daraja') {
    const missing = DARAJA_REQUIRED_ENV.filter((key) => !process.env[key]);
    if (missing.length) {
      console.warn(
        `[payments] PAYMENT_PROVIDER=daraja but missing env var(s): ${missing.join(', ')} — falling back to mock provider`
      );
      return mockProvider();
    }
  }

  if (name === 'intasend') {
    const missing = INTASEND_REQUIRED_ENV.filter((key) => !process.env[key]);
    if (missing.length) {
      console.warn(
        `[payments] PAYMENT_PROVIDER=intasend but missing env var(s): ${missing.join(', ')} — falling back to mock provider`
      );
      return mockProvider();
    }
  }

  if (name === 'kopokopo') {
    const missing = KOPOKOPO_REQUIRED_ENV.filter((key) => !process.env[key]);
    if (missing.length) {
      console.warn(
        `[payments] PAYMENT_PROVIDER=kopokopo but missing env var(s): ${missing.join(', ')} — falling back to mock provider`
      );
      return mockProvider();
    }
  }

  const factory = PROVIDERS[name] || PROVIDERS.mock;
  return factory();
}

// ---------------------------------------------------------------------------
// Shared completion logic — used by both the mock provider's timer and the
// real Daraja callback route (src/routes/payments.js).
// ---------------------------------------------------------------------------

async function completePayment({ providerReference, success, receiptNumber = null, resultDesc = null }) {
  const payment = await db('payments').where({ provider_reference: providerReference }).first();
  if (!payment) {
    console.warn(`[payments] completePayment: no payment found for reference ${providerReference}`);
    return null;
  }
  if (payment.status !== 'pending') {
    return payment; // already resolved — ignore a duplicate/late callback
  }

  const updates = success
    ? { status: 'completed', receipt_number: receiptNumber, completed_at: db.fn.now(), updated_at: db.fn.now() }
    : { status: 'failed', failed_at: db.fn.now(), updated_at: db.fn.now() };

  await db('payments').where({ id: payment.id }).update(updates);
  const updated = await db('payments').where({ id: payment.id }).first();

  const job = await db('jobs').where({ id: payment.job_id }).first();
  if (job) {
    await safeNotify({
      recipientType: 'driver',
      recipientId: job.driver_id,
      jobId: job.id,
      ...(success
        ? {
            type: 'payment_completed',
            title: 'Payment received',
            body: `KES ${payment.amount} paid via M-Pesa. Finding your vendor now.`,
          }
        : {
            type: 'payment_failed',
            title: 'Payment failed',
            body: resultDesc || 'Your M-Pesa payment did not go through. Please try again.',
          }),
    });

    // Success is the moment the vendor actually finds out about this job —
    // /select-vendor deliberately held off notifying them until payment
    // cleared, so nobody gets dispatched against an unpaid request. This
    // is that notification, now that it's earned. Guarded on job.status
    // still being 'awaiting_payment' so a late/duplicate callback can't
    // re-fire it after the job has already moved on.
    if (success && job.status === 'awaiting_payment' && job.vendor_id) {
      const vendor = await db('vendors').where({ id: job.vendor_id }).first();
      const driver = await db('users').where({ id: job.driver_id }).first();

      await db('jobs')
        .where({ id: job.id })
        .update({ status: 'matched', matched_at: db.fn.now(), updated_at: db.fn.now() });

      if (vendor) {
        await safeNotify({
          recipientType: 'vendor',
          recipientId: vendor.id,
          jobId: job.id,
          type: 'job_request',
          title: 'New job request nearby',
          body: `${driver ? driver.name : 'A driver'} needs ${job.service_type} help near ${job.location_label || 'your area'} (~${job.distance_km}km away). Already paid.`,
          phone: vendor.phone,
        });
      }
    }
    // On failure the vendor was never told about this job (still
    // 'awaiting_payment') — nothing to notify them about; the driver can
    // simply retry payment via POST /api/payments again.
  }

  return updated;
}

module.exports = { getPaymentProvider, completePayment };
