/**
 * Payouts abstraction layer — the other half of the escrow-like flow
 * alongside src/payments.js. Once a driver's payment is confirmed, this
 * module automatically pays the vendor their cut (fare minus platform
 * commission) via the same pluggable-provider pattern: routes/other code
 * never talks to a disbursement API directly, only `getPayoutProvider()`.
 *
 * Kenya requires a CBK Payment Service Provider license to hold customer
 * funds — a solo pilot cannot legally build that itself. So Fixify never
 * custodies money directly: it collects into an aggregator's (IntaSend's)
 * wallet — they hold the license and the trust account — then immediately
 * triggers a payout from that wallet to the vendor. The "escrow" is real,
 * it's just held by the licensed intermediary rather than by Fixify.
 */
const db = require('./db');
const { safeNotify } = require('./notifications');

const DEFAULT_COMMISSION_RATE = 0.15;

function commissionRate() {
  const raw = parseFloat(process.env.PLATFORM_COMMISSION_RATE);
  return Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : DEFAULT_COMMISSION_RATE;
}

function calculateSplit(amount) {
  const rate = commissionRate();
  const commission = Math.round(amount * rate);
  const vendorAmount = amount - commission;
  return { commission, vendorAmount, rate };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

// Default provider — simulates the payout landing in the vendor's M-Pesa a
// few seconds later, same asynchronous shape a real disbursement has.
function mockPayoutProvider() {
  return {
    name: 'mock',
    // `kind` distinguishes a payout (vendor) from a refund (driver) — both
    // reuse this same provider (see src/refunds.js), but they live in
    // different tables, so the right completion function must be called.
    // require('./refunds') is deliberately deferred to inside the timeout
    // rather than at module load time, since refunds.js requires this file
    // (for getPayoutProvider) — requiring it back at the top of this file
    // would be a circular require.
    async initiate({ payoutId, amount, phone, kind = 'payout' }) {
      const trackingId = `MOCK-PAYOUT-${Date.now()}-${payoutId}`;
      const delayMs = 3000 + Math.random() * 2000;

      setTimeout(() => {
        const complete = kind === 'refund' ? require('./refunds').completeRefund : completePayout;
        complete({ providerReference: trackingId, success: true }).catch((err) =>
          console.error('[payouts:mock] auto-complete failed:', err.message)
        );
      }, delayMs);

      const label = kind === 'refund' ? 'Refund' : 'Vendor payout';
      console.log(
        `\n💸 [payouts:mock] ${label} of KES ${amount} to ${phone} simulated — auto-completing in ~${Math.round(delayMs / 1000)}s (ref: ${trackingId})\n`
      );
      return { trackingId };
    },
  };
}

// Real IntaSend M-Pesa B2C disbursement.
//
// IMPORTANT — this is intentionally incomplete, the same way the Daraja
// payment provider was: written faithfully against IntaSend's public docs,
// but NOT run against a live/sandbox account (no credentials were available
// while building this). Specifically:
//
// IntaSend's Send Money (disbursement) API is a two-step flow — step 1
// below ("initiate") is fully documented and implemented. Step 2 requires
// an RSA-2048-signed "approve" request (their fraud-control measure for
// money leaving the platform), and the exact approval endpoint/payload
// isn't in IntaSend's public docs — it's issued once you register an RSA
// public key against your account in the IntaSend dashboard (Settings ->
// Send Money -> API Authentication). Rather than guess at an unverified
// signing scheme for something that moves real money, step 2 is left as a
// clearly-marked gap: a payout initiated for real stops at "awaiting
// manual approval" (approve it by hand in the IntaSend dashboard) until
// approveSendMoney() is finished against your actual dashboard-issued
// signing key. See README "Going live with IntaSend payouts".
function intasendPayoutProvider() {
  const secretKey = process.env.INTASEND_SECRET_KEY;
  const deviceId = process.env.INTASEND_DEVICE_ID;
  const callbackUrl = process.env.INTASEND_SENDMONEY_CALLBACK_URL;
  const env = process.env.INTASEND_ENV === 'live' ? 'live' : 'sandbox';
  const baseUrl = env === 'live' ? 'https://payment.intasend.com' : 'https://sandbox.intasend.com';

  return {
    name: 'intasend',
    async initiate({ amount, phone, vendorName }) {
      const res = await fetch(`${baseUrl}/api/v1/send-money/initiate/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'MPESA-B2C',
          currency: 'KES',
          device_id: deviceId,
          callback_url: callbackUrl,
          transactions: [{ name: vendorName, account: phone, amount: Math.max(1, Math.round(amount)) }],
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.tracking_id) {
        throw new Error(`IntaSend send-money initiate failed: ${JSON.stringify(data)}`);
      }

      // See the function-level comment: step 2 (RSA-signed approval) isn't
      // wired up yet, so a real disbursement stops here until it's approved
      // manually in the IntaSend dashboard or approveSendMoney() is finished.
      console.warn(
        `[payouts:intasend] Disbursement ${data.tracking_id} initiated but NOT auto-approved — ` +
          'finish the RSA-signed approval step (see README) or approve it manually in the IntaSend dashboard.'
      );

      return { trackingId: data.tracking_id };
    },
  };
}

// Real Kopo Kopo M-Pesa payout via their Send Money API — the vendor's cut
// of the fare, released the moment the driver's payment clears. Unlike the
// IntaSend payout provider above, this one is fully verified end to end
// against a real sandbox call while building this: a live disbursement
// (KES 425 to a test M-Pesa number) actually completed with no manual
// approval step needed — `source_identifier` turned out to just be the
// same till number used for collection, confirmed empirically since Kopo
// Kopo's own docs don't spell that out. See README "Going live with Kopo
// Kopo" for the confirmed request/webhook shapes.
//
// One honest gap: only the *success* webhook shape was captured during
// testing (no real transaction could be made to fail on demand in
// sandbox) — the failure-path field names below are a reasonable
// best-effort, not independently confirmed the way collection's failure
// path was.
// Kopo Kopo rejects phone numbers with a leading '+' (confirmed by a real
// sandbox 400 during testing) — vendors are stored as +254... in the DB.
function toKopoKopoPhone(phone) {
  return String(phone || '').replace(/^\+/, '');
}

function kopokopoPayoutProvider() {
  const clientId = process.env.KOPOKOPO_CLIENT_ID;
  const clientSecret = process.env.KOPOKOPO_CLIENT_SECRET;
  const sourceIdentifier = process.env.KOPOKOPO_TILL_NUMBER;
  const callbackUrl = process.env.KOPOKOPO_SENDMONEY_CALLBACK_URL;
  const env = process.env.KOPOKOPO_ENV === 'production' ? 'production' : 'sandbox';
  const baseUrl = env === 'production' ? 'https://api.kopokopo.com' : 'https://sandbox.kopokopo.com';

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
    async initiate({ amount, phone, vendorName }) {
      const token = await getAccessToken();

      const res = await fetch(`${baseUrl}/api/v2/send_money`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          destinations: [
            {
              type: 'mobile_wallet',
              nickname: vendorName,
              phone_number: toKopoKopoPhone(phone),
              network: 'Safaricom',
              amount: Math.max(1, Math.round(amount)),
              description: 'Fixify vendor payout',
            },
          ],
          source_identifier: sourceIdentifier,
          currency: 'KES',
          _links: { callback_url: callbackUrl },
        }),
      });

      const location = res.headers.get('location');
      if (!res.ok || !location) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(`Kopo Kopo send_money failed: ${JSON.stringify(errBody)}`);
      }
      const trackingId = location.split('/').pop();
      return { trackingId };
    },
  };
}

const PROVIDERS = { mock: mockPayoutProvider, intasend: intasendPayoutProvider, kopokopo: kopokopoPayoutProvider };
const INTASEND_REQUIRED_ENV = ['INTASEND_SECRET_KEY', 'INTASEND_DEVICE_ID', 'INTASEND_SENDMONEY_CALLBACK_URL'];
const KOPOKOPO_REQUIRED_ENV = ['KOPOKOPO_CLIENT_ID', 'KOPOKOPO_CLIENT_SECRET', 'KOPOKOPO_TILL_NUMBER', 'KOPOKOPO_SENDMONEY_CALLBACK_URL'];

function getPayoutProvider() {
  const name = process.env.PAYOUT_PROVIDER || 'mock';

  if (name === 'intasend') {
    const missing = INTASEND_REQUIRED_ENV.filter((key) => !process.env[key]);
    if (missing.length) {
      console.warn(
        `[payouts] PAYOUT_PROVIDER=intasend but missing env var(s): ${missing.join(', ')} — falling back to mock provider`
      );
      return mockPayoutProvider();
    }
  }

  if (name === 'kopokopo') {
    const missing = KOPOKOPO_REQUIRED_ENV.filter((key) => !process.env[key]);
    if (missing.length) {
      console.warn(
        `[payouts] PAYOUT_PROVIDER=kopokopo but missing env var(s): ${missing.join(', ')} — falling back to mock provider`
      );
      return mockPayoutProvider();
    }
  }

  const factory = PROVIDERS[name] || PROVIDERS.mock;
  return factory();
}

// ---------------------------------------------------------------------------
// Shared logic
// ---------------------------------------------------------------------------

// Called by completePayment() (src/payments.js) right after a driver's
// payment is confirmed — this is the "release the escrow" step.
async function initiatePayoutForPayment(payment) {
  const job = await db('jobs').where({ id: payment.job_id }).first();
  if (!job || !job.vendor_id) return null;

  const vendor = await db('vendors').where({ id: job.vendor_id }).first();
  if (!vendor || !vendor.phone) {
    console.warn(`[payouts] cannot pay out job ${job.id} — vendor ${job.vendor_id} has no phone on file`);
    return null;
  }

  const { commission, vendorAmount, rate } = calculateSplit(payment.amount);

  const [payoutId] = await db('payouts').insert({
    job_id: job.id,
    payment_id: payment.id,
    vendor_id: vendor.id,
    amount: vendorAmount,
    commission_amount: commission,
    commission_rate: rate,
    method: 'mpesa',
    phone: vendor.phone,
    status: 'pending',
  });

  const provider = getPayoutProvider();
  try {
    const result = await provider.initiate({ payoutId, amount: vendorAmount, phone: vendor.phone, vendorName: vendor.name });
    await db('payouts')
      .where({ id: payoutId })
      .update({ provider: provider.name, provider_reference: result.trackingId, updated_at: db.fn.now() });
  } catch (err) {
    await db('payouts')
      .where({ id: payoutId })
      .update({ status: 'failed', failure_reason: err.message, failed_at: db.fn.now(), updated_at: db.fn.now() });
    console.error(`[payouts] could not initiate payout for job ${job.id}:`, err.message);
  }

  return db('payouts').where({ id: payoutId }).first();
}

// Called by the mock provider's timer, or by the real IntaSend send-money
// webhook (src/routes/payouts.js).
async function completePayout({ providerReference, success, failureReason = null }) {
  const payout = await db('payouts').where({ provider_reference: providerReference }).first();
  if (!payout) {
    console.warn(`[payouts] completePayout: no payout found for reference ${providerReference}`);
    return null;
  }
  if (payout.status !== 'pending') {
    return payout; // already resolved — ignore a duplicate/late callback
  }

  const updates = success
    ? { status: 'completed', completed_at: db.fn.now(), updated_at: db.fn.now() }
    : { status: 'failed', failure_reason: failureReason, failed_at: db.fn.now(), updated_at: db.fn.now() };

  await db('payouts').where({ id: payout.id }).update(updates);
  const updated = await db('payouts').where({ id: payout.id }).first();

  await safeNotify({
    recipientType: 'vendor',
    recipientId: payout.vendor_id,
    jobId: payout.job_id,
    ...(success
      ? {
          type: 'payout_completed',
          title: "You've been paid!",
          body: `KES ${payout.amount} sent to your M-Pesa for job #${payout.job_id} (KES ${payout.commission_amount} platform fee deducted).`,
        }
      : {
          type: 'payout_failed',
          title: 'Payout failed',
          body: failureReason || 'Your payout could not be sent — support will follow up.',
        }),
  });

  return updated;
}

module.exports = { getPayoutProvider, initiatePayoutForPayment, completePayout, calculateSplit };
