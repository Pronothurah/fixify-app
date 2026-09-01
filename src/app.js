const express = require('express');
const cors = require('cors');
const path = require('path');

const jobsRouter = require('./routes/jobs');
const vendorsRouter = require('./routes/vendors');
const adminRouter = require('./routes/admin');
const notificationsRouter = require('./routes/notifications');
const paymentsRouter = require('./routes/payments');
const payoutsRouter = require('./routes/payouts');
const refundsRouter = require('./routes/refunds');
const callsRouter = require('./routes/calls');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/jobs', jobsRouter);
app.use('/api/vendors', vendorsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/payouts', payoutsRouter);
app.use('/api/refunds', refundsRouter);
app.use('/api/calls', callsRouter);

// Serve the demo frontend (public/index.html) from the same server/port,
// so the whole app is just `npm start` + open http://localhost:3000
app.use(express.static(path.join(__dirname, '..', 'public')));

// Error handler so unexpected failures return JSON, not an HTML stack trace.
// This is a demo/internal tool with no sensitive data behind it yet, so we
// deliberately surface the real error message (e.g. a SQLite
// "no such column" error from a missed migration) instead of hiding it
// behind a generic "Internal server error" — that message is exactly what
// shows up in the frontend's toast, which is often the only diagnostic
// info available when something breaks. The full stack still goes to the
// server console either way.
app.use((err, req, res, next) => {
  console.error(err);
  const detail = err && err.message ? err.message : 'Unknown error';
  res.status(err.status || 500).json({ error: `Internal server error: ${detail}` });
});

module.exports = app;
