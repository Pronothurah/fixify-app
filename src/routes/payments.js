const express = require('express');
const router = express.Router();
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const { getPaymentProvider, completePayment } = require('../payments');

// POST /api/payments — driver pays to confirm a matched vendor, BEFORE
// that vendor is dispatched (see /select-vendor in routes/jobs.js — that's
// the deliberate point of this ordering: a vendor should never do work
// against a job that was never paid for). Uses the job's existing
// price_estimate as the amount (no separate pricing input) so it always
// matches what was shown during matching.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { jobId, phone } = req.body;
    if (!jobId || !phone) {
      return res.status(400).json({ error: 'jobId and phone are required' });
    }

    const job = await db('jobs').where({ id: jobId }).first();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'awaiting_payment') {
      return res.status(409).json({ error: 'Payment can only be initiated while a job is awaiting payment confirmation' });
    }

    // Idempotency: don't fire a second STK push if one's already pending or
    // already succeeded for this job — hand back the existing attempt.
    const existing = await db('payments')
      .where({ job_id: jobId })
      .whereIn('status', ['pending', 'completed'])
      .orderBy('created_at', 'desc')
      .first();
    if (existing) return res.json({ payment: existing });

    const amount = job.price_estimate || 0;
    const [paymentId] = await db('payments').insert({
      job_id: jobId,
      amount,
      method: 'mpesa',
      status: 'pending',
      phone,
    });

    const provider = getPaymentProvider();
    try {
      const result = await provider.initiate({ paymentId, amount, phone, accountRef: `FIXIFY-${jobId}` });
      await db('payments')
        .where({ id: paymentId })
        .update({ provider: provider.name, provider_reference: result.checkoutRequestId, updated_at: db.fn.now() });
    } catch (err) {
      await db('payments')
        .where({ id: paymentId })
        .update({ status: 'failed', failed_at: db.fn.now(), updated_at: db.fn.now() });
      const failedPayment = await db('payments').where({ id: paymentId }).first();
      return res.status(502).json({ error: `Could not start payment: ${err.message}`, payment: failedPayment });
    }

    const payment = await db('payments').where({ id: paymentId }).first();
    res.status(201).json({ payment });
  })
);

// GET /api/payments/:id — polled by the driver's payment screen
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const payment = await db('payments').where({ id: req.params.id }).first();
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    res.json({ payment });
  })
);

// GET /api/payments/job/:jobId — latest payment attempt for a job, if any
router.get(
  '/job/:jobId',
  asyncHandler(async (req, res) => {
    const payment = await db('payments')
      .where({ job_id: req.params.jobId })
      .orderBy('created_at', 'desc')
      .first();
    res.json({ payment: payment || null });
  })
);

// POST /api/payments/mpesa/callback — Safaricom Daraja calls this once the
// customer has entered (or cancelled) their M-Pesa PIN. Only reachable in
// practice once MPESA_CALLBACK_URL points at a real public HTTPS URL (see
// README) — the mock provider never calls this, it resolves itself
// in-process via the same completePayment() function.
router.post(
  '/mpesa/callback',
  asyncHandler(async (req, res) => {
    try {
      const stk = req.body && req.body.Body && req.body.Body.stkCallback;
      if (!stk) {
        console.warn('[payments] received malformed Daraja callback payload');
        return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
      }

      const success = stk.ResultCode === 0;
      let receiptNumber = null;
      if (success && stk.CallbackMetadata && Array.isArray(stk.CallbackMetadata.Item)) {
        const item = stk.CallbackMetadata.Item.find((i) => i.Name === 'MpesaReceiptNumber');
        receiptNumber = item ? item.Value : null;
      }

      await completePayment({
        providerReference: stk.CheckoutRequestID,
        success,
        receiptNumber,
        resultDesc: stk.ResultDesc,
      });
    } catch (err) {
      console.error('[payments] callback handling failed:', err.message);
    }

    // Daraja expects exactly this acknowledgement shape regardless of what
    // we did with the callback — returning anything else can cause it to
    // retry the callback repeatedly.
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  })
);

// POST /api/payments/intasend/callback — IntaSend calls this once an M-Pesa
// STK collection resolves. Only reachable once INTASEND_CALLBACK_URL points
// at a real public HTTPS URL and is registered against the collection
// request (see README) — the mock provider never calls this.
//
// IntaSend's public docs describe the webhook as carrying `state`
// (COMPLETED/FAILED), `api_ref`, and `invoice_id`, but don't show the exact
// payload nesting — this parses defensively (top-level or nested under
// `invoice`) the same way the Daraja callback above tolerates its payload
// shape, and should be confirmed against a real sandbox delivery before
// going live (see README "Going live with IntaSend payments").
router.post(
  '/intasend/callback',
  asyncHandler(async (req, res) => {
    try {
      const body = req.body || {};
      const invoice = body.invoice || body;
      const apiRef = invoice.api_ref || body.api_ref;
      const state = invoice.state || body.state;

      if (!apiRef || !state) {
        console.warn('[payments] received malformed IntaSend callback payload:', JSON.stringify(body));
        return res.status(200).json({ received: true });
      }

      await completePayment({
        providerReference: apiRef,
        success: state === 'COMPLETE' || state === 'COMPLETED',
        resultDesc: invoice.failed_reason || body.failed_reason || null,
      });
    } catch (err) {
      console.error('[payments] intasend callback handling failed:', err.message);
    }

    res.status(200).json({ received: true });
  })
);

// POST /api/payments/kopokopo/callback — Kopo Kopo calls this once an
// M-Pesa STK collection resolves. Payload shape below was confirmed against
// a real sandbox delivery (not just docs) while building this integration:
//   success: { data: { id, attributes: { status: "Success", event: { resource: { reference, ... } } } } }
//   failure: { data: { id, attributes: { status: "Failed", event: { resource: null, errors: "<string>" } } } }
// `data.id` matches the transaction id returned in the Location header when
// the payment was initiated (see kopokopoProvider in src/payments.js).
router.post(
  '/kopokopo/callback',
  asyncHandler(async (req, res) => {
    try {
      const attrs = req.body && req.body.data && req.body.data.attributes;
      const transactionId = req.body && req.body.data && req.body.data.id;

      if (!attrs || !transactionId) {
        console.warn('[payments] received malformed Kopo Kopo callback payload:', JSON.stringify(req.body));
        return res.status(200).json({ received: true });
      }

      const success = attrs.status === 'Success';
      const resource = attrs.event && attrs.event.resource;

      await completePayment({
        providerReference: transactionId,
        success,
        receiptNumber: success && resource ? resource.reference : null,
        resultDesc: !success && attrs.event ? attrs.event.errors : null,
      });
    } catch (err) {
      console.error('[payments] kopokopo callback handling failed:', err.message);
    }

    res.status(200).json({ received: true });
  })
);

module.exports = router;
