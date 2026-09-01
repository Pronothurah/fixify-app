const express = require('express');
const router = express.Router();
const db = require('../db');
const asyncHandler = require('../asyncHandler');

// GET /api/refunds/job/:jobId — latest refund attempt for a job, if any.
// No dedicated callback routes here — refunds reuse the exact same
// payout-provider infrastructure as src/routes/payouts.js (a refund is a
// payout aimed at the driver instead of the vendor), so Kopo Kopo/IntaSend
// call back to those same URLs. See completePayoutOrRefund() there.
router.get(
  '/job/:jobId',
  asyncHandler(async (req, res) => {
    const refund = await db('refunds')
      .where({ job_id: req.params.jobId })
      .orderBy('created_at', 'desc')
      .first();
    res.json({ refund: refund || null });
  })
);

module.exports = router;
