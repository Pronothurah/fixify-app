const express = require('express');
const router = express.Router();
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const VALID_SERVICE_TYPES = require('../serviceTypes');
const { resolveNeighborhoodCoords } = require('../neighborhoods');
const { safeNotify } = require('../notifications');
const { initiatePayoutForPayment } = require('../payouts');

// GET /api/vendors — list all vendors (debug/admin use), or look up a single
// vendor by the phone number they registered with (?phone=...) — this is
// how the vendor-facing UI resolves "which vendor am I" without building
// full auth (see README limitations).
router.get(
  '/',
  asyncHandler(async (req, res) => {
    let query = db('vendors').select('*');
    if (req.query.phone) {
      query = query.where({ phone: req.query.phone });
    }
    const vendors = await query;
    res.json({ vendors });
  })
);

// POST /api/vendors — vendor self-registration. Lands as `pending`; an
// admin must approve before the vendor is eligible for matching (see
// /api/admin/vendors and src/matching.js).
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, phone, serviceTypes, neighborhood, idNumber } = req.body;

    if (!name || !phone || !neighborhood || !idNumber) {
      return res.status(400).json({ error: 'name, phone, neighborhood and idNumber are required' });
    }
    if (!Array.isArray(serviceTypes) || serviceTypes.length === 0) {
      return res.status(400).json({ error: 'serviceTypes must be a non-empty array' });
    }
    const invalid = serviceTypes.filter((s) => !VALID_SERVICE_TYPES.includes(s));
    if (invalid.length) {
      return res.status(400).json({ error: `Invalid service type(s): ${invalid.join(', ')}` });
    }

    const { lat, lng, neighborhood: resolvedHood } = resolveNeighborhoodCoords(neighborhood);

    const [vendorId] = await db('vendors').insert({
      name,
      business_name: `${name}'s Roadside Service`, // placeholder; editable by an admin later
      vehicle_type: 'Not specified',
      phone,
      lat,
      lng,
      neighborhood: resolvedHood,
      id_number: idNumber,
      approval_status: 'pending',
      status: 'offline',
    });

    await db('vendor_services').insert(
      serviceTypes.map((service_type) => ({ vendor_id: vendorId, service_type }))
    );

    const vendor = await db('vendors').where({ id: vendorId }).first();
    res.status(201).json({ vendor, message: 'Application received — pending review.' });
  })
);

// GET /api/vendors/:id — vendor profile
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const vendor = await db('vendors').where({ id: req.params.id }).first();
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ vendor });
  })
);

// GET /api/vendors/:id/stats — today's earnings/completed jobs for the dashboard header
router.get(
  '/:id/stats',
  asyncHandler(async (req, res) => {
    const vendor = await db('vendors').where({ id: req.params.id }).first();
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    // Filtered in JS rather than in SQL: SQLite stores knex timestamps as
    // "YYYY-MM-DD HH:MM:SS" text (UTC), which does not compare correctly
    // against a "YYYY-MM-DDTHH:MM:SS.sssZ" ISO string with a plain >=. This
    // stays correct regardless of DB engine and the dataset is small.
    const now = new Date();
    const startOfDayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const isToday = (ts) => {
      if (!ts) return false;
      const iso = typeof ts === 'string' ? ts.replace(' ', 'T') + 'Z' : ts;
      return new Date(iso).getTime() >= startOfDayUTC;
    };

    const allCompletedJobs = await db('jobs').where({ vendor_id: req.params.id, status: 'completed' });
    const completedToday = allCompletedJobs.filter((j) => isToday(j.completed_at));

    // Earnings reflect actual completed *payouts* (what landed in the
    // vendor's own M-Pesa, after the platform commission is deducted) —
    // not the driver's raw payment amount, and not just the estimated
    // price of a completed job (a job can be "done" while payment/payout
    // is still pending or failed).
    let earningsToday = 0;
    let paidJobsToday = 0;
    if (allCompletedJobs.length) {
      const jobIds = allCompletedJobs.map((j) => j.id);
      const completedPayouts = await db('payouts').where({ status: 'completed' }).whereIn('job_id', jobIds);
      const todaysPayouts = completedPayouts.filter((p) => isToday(p.completed_at));
      earningsToday = todaysPayouts.reduce((sum, p) => sum + (p.amount || 0), 0);
      paidJobsToday = todaysPayouts.length;
    }

    res.json({
      rating: vendor.rating,
      completedToday: completedToday.length,
      earningsToday,
      paidJobsToday,
    });
  })
);

// PATCH /api/vendors/:id/availability — toggle online/offline
router.patch(
  '/:id/availability',
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    if (!['available', 'offline'].includes(status)) {
      return res.status(400).json({ error: "status must be 'available' or 'offline'" });
    }
    const vendor = await db('vendors').where({ id: req.params.id }).first();
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    if (vendor.status === 'busy') {
      return res.status(409).json({ error: 'Cannot change availability while on an active job' });
    }
    if (status === 'available' && vendor.approval_status !== 'approved') {
      return res.status(403).json({ error: 'Vendor is not yet approved' });
    }

    await db('vendors').where({ id: req.params.id }).update({ status, updated_at: db.fn.now() });
    const updated = await db('vendors').where({ id: req.params.id }).first();
    res.json({ vendor: updated });
  })
);

// GET /api/vendors/:id/jobs — dashboard feed: pending requests + current active job
router.get(
  '/:id/jobs',
  asyncHandler(async (req, res) => {
    const vendorId = req.params.id;

    const incoming = await db('jobs')
      .where({ vendor_id: vendorId, status: 'matched' })
      .orderBy('matched_at', 'desc');

    const active = await db('jobs')
      .where({ vendor_id: vendorId })
      .whereIn('status', ['accepted', 'en_route'])
      .orderBy('accepted_at', 'desc');

    const attachDriver = async (jobs) =>
      Promise.all(
        jobs.map(async (job) => ({
          ...job,
          driver: await db('users').where({ id: job.driver_id }).first(),
        }))
      );

    res.json({
      incoming: await attachDriver(incoming),
      active: await attachDriver(active),
    });
  })
);

// POST /api/vendors/:vendorId/jobs/:jobId/accept
router.post(
  '/:vendorId/jobs/:jobId/accept',
  asyncHandler(async (req, res) => {
    const { vendorId, jobId } = req.params;
    const job = await db('jobs').where({ id: jobId, vendor_id: vendorId }).first();
    if (!job) return res.status(404).json({ error: 'Job not found for this vendor' });
    if (job.status !== 'matched') {
      return res.status(409).json({ error: `Cannot accept a job with status '${job.status}'` });
    }

    await db('jobs')
      .where({ id: jobId })
      .update({ status: 'accepted', accepted_at: db.fn.now(), updated_at: db.fn.now() });
    await db('vendors').where({ id: vendorId }).update({ status: 'busy', updated_at: db.fn.now() });

    const updated = await db('jobs').where({ id: jobId }).first();

    const vendor = await db('vendors').where({ id: vendorId }).first();
    const driver = await db('users').where({ id: job.driver_id }).first();
    await safeNotify({
      recipientType: 'driver',
      recipientId: job.driver_id,
      jobId: job.id,
      type: 'job_accepted',
      title: `${vendor.name} accepted your request`,
      body: `Heading your way now — ETA about ${updated.eta_minutes} min.`,
      phone: driver ? driver.phone : null,
    });

    res.json({ job: updated });
  })
);

// POST /api/vendors/:vendorId/jobs/:jobId/decline
router.post(
  '/:vendorId/jobs/:jobId/decline',
  asyncHandler(async (req, res) => {
    const { vendorId, jobId } = req.params;
    const job = await db('jobs').where({ id: jobId, vendor_id: vendorId }).first();
    if (!job) return res.status(404).json({ error: 'Job not found for this vendor' });
    if (job.status !== 'matched') {
      return res.status(409).json({ error: `Cannot decline a job with status '${job.status}'` });
    }

    const declined = JSON.parse(job.declined_vendor_ids || '[]');
    declined.push(Number(vendorId));

    const vendor = await db('vendors').where({ id: vendorId }).first();

    await db('jobs')
      .where({ id: jobId })
      .update({
        status: 'requested',
        vendor_id: null,
        matched_at: null,
        declined_vendor_ids: JSON.stringify(declined),
        updated_at: db.fn.now(),
      });

    const updated = await db('jobs').where({ id: jobId }).first();

    const driver = await db('users').where({ id: job.driver_id }).first();
    await safeNotify({
      recipientType: 'driver',
      recipientId: job.driver_id,
      jobId: job.id,
      type: 'job_declined',
      title: `${vendor ? vendor.name : 'That vendor'} isn't available`,
      body: `We're finding you another nearby match now.`,
      phone: driver ? driver.phone : null,
    });

    res.json({ job: updated });
  })
);

// PATCH /api/vendors/:vendorId/jobs/:jobId/status — advance an active job
// Valid transitions: accepted -> en_route -> completed
router.patch(
  '/:vendorId/jobs/:jobId/status',
  asyncHandler(async (req, res) => {
    const { vendorId, jobId } = req.params;
    const { status } = req.body;
    const allowedNext = { accepted: 'en_route', en_route: 'completed' };

    const job = await db('jobs').where({ id: jobId, vendor_id: vendorId }).first();
    if (!job) return res.status(404).json({ error: 'Job not found for this vendor' });
    if (allowedNext[job.status] !== status) {
      return res.status(409).json({ error: `Cannot move job from '${job.status}' to '${status}'` });
    }

    const updates = { status, updated_at: db.fn.now() };
    if (status === 'en_route') updates.en_route_at = db.fn.now();
    if (status === 'completed') updates.completed_at = db.fn.now();

    await db('jobs').where({ id: jobId }).update(updates);

    if (status === 'completed') {
      await db('vendors').where({ id: vendorId }).update({ status: 'available', updated_at: db.fn.now() });

      // Payment already happened up front, when the driver selected this
      // vendor (see /select-vendor in routes/jobs.js) — this is the
      // "release the escrow" moment: now that the job is actually done,
      // pay the vendor their cut. Fire-and-forget from the caller's
      // perspective — a payout failure shouldn't fail this response, it's
      // tracked and investigated on its own (see src/payouts.js).
      const payment = await db('payments').where({ job_id: jobId, status: 'completed' }).first();
      if (payment) {
        initiatePayoutForPayment(payment).catch((err) =>
          console.error(`[vendors] payout trigger failed for job ${jobId}:`, err.message)
        );
      } else {
        console.warn(`[vendors] job ${jobId} marked completed with no completed payment on file — no payout triggered`);
      }
    }

    const updated = await db('jobs').where({ id: jobId }).first();

    const vendor = await db('vendors').where({ id: vendorId }).first();
    const driver = await db('users').where({ id: job.driver_id }).first();
    const notifCopy = {
      en_route: {
        type: 'job_en_route',
        title: `${vendor.name} is on the way`,
        body: `ETA about ${updated.eta_minutes} min.`,
      },
      completed: {
        type: 'job_completed',
        title: 'Job complete!',
        body: `${vendor.name} marked your ${job.service_type} request as done. Thanks for using Fixify!`,
      },
    }[status];

    await safeNotify({
      recipientType: 'driver',
      recipientId: job.driver_id,
      jobId: job.id,
      ...notifCopy,
      phone: driver ? driver.phone : null,
    });

    res.json({ job: updated });
  })
);

module.exports = router;
