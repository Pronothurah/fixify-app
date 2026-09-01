const express = require('express');
const router = express.Router();
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const { haversineKm, estimateEtaMinutes, estimatePrice, rankVendors, MAX_SEARCH_RADIUS_KM } = require('../matching');
const VALID_SERVICE_TYPES = require('../serviceTypes');
const { safeNotify } = require('../notifications');
const { initiateRefundForPayment } = require('../refunds');

// POST /api/jobs — driver creates a new roadside assistance request
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { driverName, driverPhone, serviceType, lat, lng, locationLabel } = req.body;

    if (!driverName || !serviceType || lat == null || lng == null) {
      return res.status(400).json({ error: 'driverName, serviceType, lat and lng are required' });
    }
    if (!VALID_SERVICE_TYPES.includes(serviceType)) {
      return res.status(400).json({ error: `serviceType must be one of: ${VALID_SERVICE_TYPES.join(', ')}` });
    }

    // Reuse an existing driver record by phone if we have one, else create.
    let driver = null;
    if (driverPhone) {
      driver = await db('users').where({ phone: driverPhone }).first();
    }
    if (!driver) {
      const [driverId] = await db('users').insert({ name: driverName, phone: driverPhone || null });
      driver = await db('users').where({ id: driverId }).first();
    }

    const [jobId] = await db('jobs').insert({
      driver_id: driver.id,
      service_type: serviceType,
      status: 'requested',
      driver_lat: lat,
      driver_lng: lng,
      location_label: locationLabel || null,
    });

    const job = await db('jobs').where({ id: jobId }).first();
    res.status(201).json({ job, driver });
  })
);

// GET /api/jobs/:id — job status/details (driver polls this screen)
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const job = await db('jobs').where({ id: req.params.id }).first();
    if (!job) return res.status(404).json({ error: 'Job not found' });

    let vendor = null;
    if (job.vendor_id) {
      vendor = await db('vendors').where({ id: job.vendor_id }).first();
    }
    res.json({ job, vendor });
  })
);

// GET /api/jobs/:id/nearby-vendors — haversine-ranked candidate vendors
router.get(
  '/:id/nearby-vendors',
  asyncHandler(async (req, res) => {
    const job = await db('jobs').where({ id: req.params.id }).first();
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const declined = JSON.parse(job.declined_vendor_ids || '[]');
    const vendors = await rankVendors(db, {
      lat: job.driver_lat,
      lng: job.driver_lng,
      serviceType: job.service_type,
      excludeVendorIds: declined,
    });
    res.json({ vendors });
  })
);

// POST /api/jobs/:id/select-vendor — driver picks a vendor from the ranked list
//
// Payment now happens HERE, before a vendor is ever dispatched — not after
// the job completes. That protects vendors from doing unpaid work: they're
// only notified once payment is actually confirmed (see completePayment()
// in src/payments.js, which flips the job from 'awaiting_payment' to
// 'matched' and sends the notification this route used to send directly).
//
// A vendor declining sends the job back to 'requested' (see /decline in
// routes/vendors.js) without touching the payment — if the driver then
// re-picks a different vendor here, that already-completed payment covers
// it too, so this skips straight to 'matched' and notifies immediately
// rather than charging a second time.
router.post(
  '/:id/select-vendor',
  asyncHandler(async (req, res) => {
    const { vendorId } = req.body;
    const job = await db('jobs').where({ id: req.params.id }).first();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'requested') {
      return res.status(409).json({ error: `Cannot select a vendor while job status is '${job.status}'` });
    }

    const vendor = await db('vendors')
      .where({ id: vendorId, status: 'available', approval_status: 'approved' })
      .first();
    if (!vendor) return res.status(400).json({ error: 'Vendor is not available' });

    const distanceKm = haversineKm(job.driver_lat, job.driver_lng, vendor.lat, vendor.lng);

    // Defense in depth: the ranked nearby-vendors list already only ever
    // offers vendors within the expanding search radius (see rankVendors
    // in src/matching.js), so this shouldn't normally trigger — but a
    // direct API call (or a re-match against a stale list) shouldn't be
    // able to bypass the same radius rule that applies everywhere else.
    if (distanceKm > MAX_SEARCH_RADIUS_KM) {
      return res.status(400).json({
        error: `That vendor is ${Math.round(distanceKm)}km away — outside the ${MAX_SEARCH_RADIUS_KM}km service radius`,
      });
    }

    const existingPayment = await db('payments').where({ job_id: job.id, status: 'completed' }).first();

    const updates = {
      vendor_id: vendor.id,
      distance_km: Math.round(distanceKm * 10) / 10,
      eta_minutes: estimateEtaMinutes(distanceKm),
      updated_at: db.fn.now(),
    };

    if (existingPayment) {
      updates.status = 'matched';
      updates.matched_at = db.fn.now();
      // price_estimate deliberately left as-is — the driver already paid
      // that amount; a different vendor at a different distance doesn't
      // change what they were charged for this job.
    } else {
      updates.status = 'awaiting_payment';
      updates.price_estimate = estimatePrice(distanceKm);
    }

    await db('jobs').where({ id: job.id }).update(updates);
    const updated = await db('jobs').where({ id: job.id }).first();

    if (existingPayment) {
      const driver = await db('users').where({ id: job.driver_id }).first();
      await safeNotify({
        recipientType: 'vendor',
        recipientId: vendor.id,
        jobId: job.id,
        type: 'job_request',
        title: 'New job request nearby',
        body: `${driver ? driver.name : 'A driver'} needs ${job.service_type} help near ${job.location_label || 'your area'} (~${updated.distance_km}km away). Already paid.`,
        phone: vendor.phone,
      });
    }
    // No existing payment: the vendor is NOT notified yet. That happens
    // once POST /api/payments confirms — see completePayment().

    res.json({ job: updated, vendor });
  })
);

// POST /api/jobs/:id/cancel — driver cancels the request at any non-terminal stage
router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const job = await db('jobs').where({ id: req.params.id }).first();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (['completed', 'cancelled'].includes(job.status)) {
      return res.status(409).json({ error: `Job is already ${job.status}` });
    }

    const wasActiveForVendor = job.vendor_id && ['accepted', 'en_route'].includes(job.status);
    const hadVendor = job.vendor_id && ['matched', 'accepted', 'en_route'].includes(job.status);

    await db('jobs')
      .where({ id: job.id })
      .update({ status: 'cancelled', cancelled_at: db.fn.now(), updated_at: db.fn.now() });

    if (wasActiveForVendor) {
      await db('vendors').where({ id: job.vendor_id }).update({ status: 'available', updated_at: db.fn.now() });
    }

    if (hadVendor) {
      await safeNotify({
        recipientType: 'vendor',
        recipientId: job.vendor_id,
        jobId: job.id,
        type: 'job_cancelled',
        title: 'Job request cancelled',
        body: `The driver cancelled the ${job.service_type} request near ${job.location_label || 'your area'}.`,
      });
    }

    // A driver now pays as soon as they select a vendor (see
    // /select-vendor above), before the job is anywhere near done — if
    // they cancel before completion, refund whatever was already
    // collected rather than keeping payment for a job that never happened.
    const payment = await db('payments').where({ job_id: job.id, status: 'completed' }).first();
    if (payment) {
      initiateRefundForPayment(payment).catch((err) =>
        console.error(`[jobs] refund trigger failed for job ${job.id}:`, err.message)
      );
    }

    const updated = await db('jobs').where({ id: job.id }).first();
    res.json({ job: updated });
  })
);

module.exports = router;
