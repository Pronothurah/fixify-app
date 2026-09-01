const express = require('express');
const router = express.Router();
const db = require('../db');
const asyncHandler = require('../asyncHandler');

// Simulated voice calling (no real telephony — see README limitations).
// A call is scoped to a job; both the driver's and the vendor's screens
// poll GET /api/calls/job/:jobId on their existing refresh loops so a call
// placed from either side shows up as "incoming" on the other in real time.

// POST /api/calls — place a call. Reuses an already-active call for the
// job if one exists, so a double-click/duplicate poll can't ring twice.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { jobId, callerType } = req.body;
    if (!jobId || !['driver', 'vendor'].includes(callerType)) {
      return res.status(400).json({ error: "jobId and callerType ('driver' or 'vendor') are required" });
    }

    const job = await db('jobs').where({ id: jobId }).first();
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const existing = await db('calls')
      .where({ job_id: jobId })
      .whereIn('status', ['ringing', 'connected'])
      .orderBy('created_at', 'desc')
      .first();
    if (existing) return res.status(201).json({ call: existing });

    const [callId] = await db('calls').insert({ job_id: jobId, caller_type: callerType, status: 'ringing' });
    const call = await db('calls').where({ id: callId }).first();
    res.status(201).json({ call });
  })
);

// GET /api/calls/job/:jobId — latest call for a job (any status), or null.
// Polled by both sides to detect a new incoming call and to follow status
// changes (accepted/declined/ended) on whichever call they're already in.
router.get(
  '/job/:jobId',
  asyncHandler(async (req, res) => {
    const call = await db('calls')
      .where({ job_id: req.params.jobId })
      .orderBy('created_at', 'desc')
      .first();
    res.json({ call: call || null });
  })
);

// POST /api/calls/:id/accept — callee picks up
router.post(
  '/:id/accept',
  asyncHandler(async (req, res) => {
    const call = await db('calls').where({ id: req.params.id }).first();
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (call.status !== 'ringing') {
      return res.status(409).json({ error: `Cannot accept a call with status '${call.status}'` });
    }
    await db('calls').where({ id: call.id }).update({ status: 'connected', connected_at: db.fn.now(), updated_at: db.fn.now() });
    res.json({ call: await db('calls').where({ id: call.id }).first() });
  })
);

// POST /api/calls/:id/decline — callee rejects while it's still ringing
router.post(
  '/:id/decline',
  asyncHandler(async (req, res) => {
    const call = await db('calls').where({ id: req.params.id }).first();
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (call.status !== 'ringing') {
      return res.status(409).json({ error: `Cannot decline a call with status '${call.status}'` });
    }
    await db('calls').where({ id: call.id }).update({ status: 'declined', ended_at: db.fn.now(), updated_at: db.fn.now() });
    res.json({ call: await db('calls').where({ id: call.id }).first() });
  })
);

// POST /api/calls/:id/end — either side hangs up, from ringing or connected
router.post(
  '/:id/end',
  asyncHandler(async (req, res) => {
    const call = await db('calls').where({ id: req.params.id }).first();
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (!['ringing', 'connected'].includes(call.status)) {
      return res.json({ call }); // already terminal — no-op, not an error
    }
    await db('calls').where({ id: call.id }).update({ status: 'ended', ended_at: db.fn.now(), updated_at: db.fn.now() });
    res.json({ call: await db('calls').where({ id: call.id }).first() });
  })
);

module.exports = router;
