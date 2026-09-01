/**
 * Refunds — the safety valve for moving payment earlier (see
 * src/routes/jobs.js). A driver now pays when they select a vendor, before
 * that vendor is ever dispatched. If the job then falls through (vendor
 * never accepts, driver cancels legitimately) before completion, the
 * driver needs their money back.
 *
 * A refund is mechanically identical to a payout — "send this amount to
 * this phone number" — just aimed at the driver instead of the vendor, and
 * for the full amount rather than the amount-minus-commission. So this
 * reuses getPayoutProvider() from src/payouts.js directly rather than
 * duplicating a third near-identical provider abstraction.
 */
const db = require('./db');
const { safeNotify } = require('./notifications');
const { getPayoutProvider } = require('./payouts');

// Called when a paid job is cancelled before completion (src/routes/jobs.js).
async function initiateRefundForPayment(payment) {
  const job = await db('jobs').where({ id: payment.job_id }).first();
  if (!job) return null;

  const driver = await db('users').where({ id: job.driver_id }).first();
  const phone = payment.phone || (driver && driver.phone);
  if (!phone) {
    console.warn(`[refunds] cannot refund payment ${payment.id} — no phone number on file`);
    return null;
  }

  const [refundId] = await db('refunds').insert({
    job_id: job.id,
    payment_id: payment.id,
    amount: payment.amount,
    phone,
    status: 'pending',
  });

  // Reuses the payout provider — its `initiate` shape doesn't care whether
  // the recipient is a vendor or a driver, only that it's a phone + amount.
  const provider = getPayoutProvider();
  try {
    const result = await provider.initiate({
      payoutId: refundId,
      amount: payment.amount,
      phone,
      vendorName: driver ? driver.name : 'Fixify driver',
      kind: 'refund',
    });
    await db('refunds')
      .where({ id: refundId })
      .update({ provider: provider.name, provider_reference: result.trackingId, updated_at: db.fn.now() });
  } catch (err) {
    await db('refunds')
      .where({ id: refundId })
      .update({ status: 'failed', failure_reason: err.message, failed_at: db.fn.now(), updated_at: db.fn.now() });
    console.error(`[refunds] could not initiate refund for payment ${payment.id}:`, err.message);
  }

  return db('refunds').where({ id: refundId }).first();
}

// Called by the mock provider's timer (piggybacked via the payout provider),
// or by the real Kopo Kopo/IntaSend send-money webhook (src/routes/refunds.js).
async function completeRefund({ providerReference, success, failureReason = null }) {
  const refund = await db('refunds').where({ provider_reference: providerReference }).first();
  if (!refund) return null; // not a refund reference — likely a real payout callback, not ours
  if (refund.status !== 'pending') {
    return refund; // already resolved — ignore a duplicate/late callback
  }

  const updates = success
    ? { status: 'completed', completed_at: db.fn.now(), updated_at: db.fn.now() }
    : { status: 'failed', failure_reason: failureReason, failed_at: db.fn.now(), updated_at: db.fn.now() };

  await db('refunds').where({ id: refund.id }).update(updates);

  if (success) {
    await db('payments').where({ id: refund.payment_id }).update({ status: 'refunded', updated_at: db.fn.now() });
  }

  const updated = await db('refunds').where({ id: refund.id }).first();
  const job = await db('jobs').where({ id: refund.job_id }).first();
  if (job) {
    await safeNotify({
      recipientType: 'driver',
      recipientId: job.driver_id,
      jobId: job.id,
      ...(success
        ? {
            type: 'refund_completed',
            title: 'Refund sent',
            body: `KES ${refund.amount} refunded to your M-Pesa for job #${job.id}.`,
          }
        : {
            type: 'refund_failed',
            title: 'Refund failed',
            body: failureReason || 'Your refund could not be sent — support will follow up.',
          }),
    });
  }

  return updated;
}

module.exports = { initiateRefundForPayment, completeRefund };
