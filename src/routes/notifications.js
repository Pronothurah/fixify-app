const express = require('express');
const router = express.Router();
const db = require('../db');
const asyncHandler = require('../asyncHandler');

const VALID_RECIPIENT_TYPES = ['driver', 'vendor'];

// GET /api/notifications/:recipientType/:recipientId
// Polled by the frontend (driver confirm screen + vendor dashboard) as the
// in-app notification feed — this is what powers the bell/badge without
// needing a real push/SMS account.
router.get(
  '/:recipientType/:recipientId',
  asyncHandler(async (req, res) => {
    const { recipientType, recipientId } = req.params;
    if (!VALID_RECIPIENT_TYPES.includes(recipientType)) {
      return res.status(400).json({ error: "recipientType must be 'driver' or 'vendor'" });
    }

    const notifications = await db('notifications')
      .where({ recipient_type: recipientType, recipient_id: recipientId })
      .orderBy('created_at', 'desc')
      .limit(20);

    const unreadCount = notifications.filter((n) => !n.read_at).length;
    res.json({ notifications, unreadCount });
  })
);

// POST /api/notifications/:id/read
router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const notification = await db('notifications').where({ id: req.params.id }).first();
    if (!notification) return res.status(404).json({ error: 'Notification not found' });

    await db('notifications').where({ id: req.params.id }).update({ read_at: db.fn.now() });
    const updated = await db('notifications').where({ id: req.params.id }).first();
    res.json({ notification: updated });
  })
);

module.exports = router;
