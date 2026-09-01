const express = require('express');
const router = express.Router();
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const { completePayout } = require('../payouts');
const { completeRefund } = require('../refunds');

// Refunds (src/refunds.js) reuse this same payout provider/callback
// infrastructure — a refund is just a payout aimed at the driver instead of
// the vendor, so Kopo Kopo/IntaSend call back to this same URL either way.
// completePayout() returns null for a reference it doesn't recognize
// (i.e. it's a refund, not a payout), so this tries that first and falls
// back to completeRefund().
async function completePayoutOrRefund({ providerReference, success, failureReason }) {
  const payout = await completePayout({ providerReference, success, failureReason });
  if (payout) return payout;
  return completeRefund({ providerReference, success, failureReason });
}

// GET /api/payouts/job/:jobId — latest payout attempt for a job, if any.
// Mirrors GET /api/payments/job/:jobId — lets the vendor dashboard (or
// admin) show "you were paid KES X (KES Y platform fee)" once the escrow
// releases.
router.get(
  '/job/:jobId',
  asyncHandler(async (req, res) => {
    const payout = await db('payouts')
      .where({ job_id: req.params.jobId })
      .orderBy('created_at', 'desc')
      .first();
    res.json({ payout: payout || null });
  })
);

// POST /api/payouts/intasend/callback — IntaSend calls this once an M-Pesa
// B2C disbursement resolves. Only reachable once INTASEND_SENDMONEY_CALLBACK_URL
// points at a real public HTTPS URL (see README). The mock payout provider
// never calls this — it resolves itself in-process via completePayout().
//
// Per IntaSend's webhook docs, the payload carries a batch-level
// `tracking_id` and `status`, plus a `transactions` array with a per-item
// `status`/`request_reference_id`. This build only ever sends a single
// transaction per payout, so it reads transactions[0].
router.post(
  '/intasend/callback',
  asyncHandler(async (req, res) => {
    try {
      const body = req.body || {};
      const trackingId = body.tracking_id;
      const transaction = Array.isArray(body.transactions) ? body.transactions[0] : null;

      if (!trackingId) {
        console.warn('[payouts] received malformed IntaSend send-money callback:', JSON.stringify(body));
        return res.status(200).json({ received: true });
      }

      const txStatus = (transaction && transaction.status) || body.status || '';
      const success = /complete|success/i.test(txStatus);
      const failed = /fail/i.test(txStatus);

      if (success || failed) {
        await completePayoutOrRefund({
          providerReference: trackingId,
          success,
          failureReason: failed ? txStatus : null,
        });
      } else {
        console.log(`[payouts] IntaSend callback for ${trackingId} is still in-progress status '${txStatus}' — ignoring until terminal`);
      }
    } catch (err) {
      console.error('[payouts] intasend callback handling failed:', err.message);
    }

    res.status(200).json({ received: true });
  })
);

// POST /api/payouts/kopokopo/callback — Kopo Kopo calls this once a Send
// Money (payout) transfer resolves. The success shape below was confirmed
// against a real sandbox delivery while building this:
//   { data: { id, attributes: { status: "Received",
//       transfer_batches: [{ disbursements: [{ status: "Transferred", ... }] }] } } }
// The per-disbursement status inside transfer_batches is what actually
// confirms money moved — the outer "Received" just means Kopo Kopo
// accepted the request. This build only ever sends one destination per
// payout, so it reads disbursements[0]. The failure-path shape was not
// independently confirmed (see src/payouts.js) — treat that branch as a
// reasonable best-effort until seen for real.
router.post(
  '/kopokopo/callback',
  asyncHandler(async (req, res) => {
    try {
      const attrs = req.body && req.body.data && req.body.data.attributes;
      const trackingId = req.body && req.body.data && req.body.data.id;
      const batch = attrs && Array.isArray(attrs.transfer_batches) ? attrs.transfer_batches[0] : null;
      const disbursement = batch && Array.isArray(batch.disbursements) ? batch.disbursements[0] : null;

      if (!attrs || !trackingId) {
        console.warn('[payouts] received malformed Kopo Kopo callback payload:', JSON.stringify(req.body));
        return res.status(200).json({ received: true });
      }

      const status = (disbursement && disbursement.status) || attrs.status || '';
      const success = /transferred|completed|success/i.test(status);
      const failed = /fail|reject|error/i.test(status);

      if (success || failed) {
        await completePayoutOrRefund({ providerReference: trackingId, success, failureReason: failed ? status : null });
      } else {
        console.log(`[payouts] Kopo Kopo callback for ${trackingId} is still in-progress status '${status}' — ignoring until terminal`);
      }
    } catch (err) {
      console.error('[payouts] kopokopo callback handling failed:', err.message);
    }

    res.status(200).json({ received: true });
  })
);

module.exports = router;
