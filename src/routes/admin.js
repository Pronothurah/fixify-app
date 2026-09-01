const express = require('express');
const router = express.Router();
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const { safeNotify } = require('../notifications');

// GET /api/admin/vendors?status=pending|approved|rejected|all
// No auth yet (see README limitations) — this is an internal review screen
// for the founder/admin during this phase, not a public endpoint in spirit.
router.get(
  '/vendors',
  asyncHandler(async (req, res) => {
    const status = req.query.status || 'pending';
    let query = db('vendors').select('*').orderBy('created_at', 'desc');
    if (status !== 'all') {
      query = query.where({ approval_status: status });
    }
    const vendors = await query;

    const withServices = await Promise.all(
      vendors.map(async (v) => ({
        ...v,
        services: (await db('vendor_services').where({ vendor_id: v.id }).select('service_type')).map(
          (r) => r.service_type
        ),
      }))
    );

    res.json({ vendors: withServices });
  })
);

// POST /api/admin/vendors/:id/approve — vendor becomes eligible for matching
router.post(
  '/vendors/:id/approve',
  asyncHandler(async (req, res) => {
    const vendor = await db('vendors').where({ id: req.params.id }).first();
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    if (vendor.approval_status === 'approved') {
      return res.status(409).json({ error: 'Vendor is already approved' });
    }

    await db('vendors')
      .where({ id: req.params.id })
      .update({ approval_status: 'approved', status: 'available', updated_at: db.fn.now() });

    const updated = await db('vendors').where({ id: req.params.id }).first();

    await safeNotify({
      recipientType: 'vendor',
      recipientId: updated.id,
      type: 'vendor_approved',
      title: "You're approved!",
      body: "Your Fixify vendor application was approved — you're now live and eligible for job matches.",
      phone: updated.phone,
    });

    res.json({ vendor: updated });
  })
);

// POST /api/admin/vendors/:id/reject
router.post(
  '/vendors/:id/reject',
  asyncHandler(async (req, res) => {
    const vendor = await db('vendors').where({ id: req.params.id }).first();
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    if (vendor.approval_status === 'rejected') {
      return res.status(409).json({ error: 'Vendor is already rejected' });
    }

    await db('vendors')
      .where({ id: req.params.id })
      .update({ approval_status: 'rejected', status: 'offline', updated_at: db.fn.now() });

    const updated = await db('vendors').where({ id: req.params.id }).first();

    await safeNotify({
      recipientType: 'vendor',
      recipientId: updated.id,
      type: 'vendor_rejected',
      title: 'Application not approved',
      body: "Your Fixify vendor application wasn't approved this time. Contact support if you think this is a mistake.",
      phone: updated.phone,
    });

    res.json({ vendor: updated });
  })
);

module.exports = router;
