# Fixify

Fixify is a roadside assistance marketplace — think "Uber for breakdowns." A driver whose car breaks down (flat tire, engine trouble, dead battery, out of fuel, accident, etc.) opens the app, picks the problem, gets matched by real distance to the nearest available vendor (mechanic, tow operator, tire tech), tracks them to arrival, and pays by M-Pesa when the job's done. Vendors self-register, get approved by an admin, run their own dashboard, and get paid. Built for a Nairobi-based founder validating the concept before a full production build.

This file is the single, running reference doc for the project — it lives inside the project folder itself so everything stays self-contained. It gets updated as each phase lands; check the **Progress** section at the bottom for exactly what's built vs. not yet started.

### Where this stands

All six scoped phases are built and wired together end to end: a driver can request help, get matched by real haversine distance to an approved nearby vendor, track them through a real accept → en route → completed lifecycle backed by a real database, call them or get notified in-app at every step, and pay by M-Pesa when it's done — the vendor is then paid automatically, net of a platform commission, through an escrow-style flow that holds the collected fare in a licensed intermediary's wallet before releasing it. A vendor runs their whole side of this (signup, dashboard, accept/decline, job progress, earnings) independently, identified by their own phone number, synced through the same backend rather than any hardcoded script. The app is also Postgres-ready and has a full deployment path (Docker + Nginx + HTTPS) to a real VPS — see **DEPLOY.md**.

**Update: the M-Pesa flow is no longer just theoretical.** The Kopo Kopo provider (collection and payout both) has been run against a real Kopo Kopo sandbox account — a real STK push, a real payout to a test M-Pesa number, and the real webhook payloads for both were captured and confirmed to match what the code expects. That's the recommended path today (see "Going live with Kopo Kopo" below). IntaSend and Daraja remain faithful-to-the-docs implementations that haven't been run against a live account — IntaSend's sandbox specifically turned out to be invite-gated in practice, which is why Kopo Kopo became the proven path instead.

SMS/push notifications remain demo-stage by design — a console log rather than a live Africa's Talking account, because this was built without those credentials. See "Wiring in a real SMS provider" below for that switch.

---

## What's in this repo

```
fixify-app/                 ← you are here; the real, self-contained project
├── README.md                 this file — single source of truth
├── DEPLOY.md                  VPS deployment walkthrough (Oracle Cloud Always Free)
├── package.json
├── knexfile.js                DB connection config (SQLite locally, Postgres via DATABASE_URL)
├── server.js                  entry point (npm start)
├── Dockerfile                 Node app image (Debian-based, arm64/amd64)
├── docker-compose.yml          app + self-hosted Postgres
├── .env.example                every env var the app reads, documented
├── deploy/
│   └── nginx.conf                reverse-proxy template for the VPS
├── src/
│   ├── app.js                  Express app setup, routes, static file serving
│   ├── db.js                   Knex instance
│   ├── matching.js             haversine distance + ETA/price estimation
│   ├── neighborhoods.js        Nairobi neighborhood name → lat/lng resolver (used at vendor signup)
│   ├── serviceTypes.js         shared list of valid service types
│   ├── notifications.js        pluggable notification layer (console provider by default)
│   ├── payments.js             pluggable payments (collection) layer — mock / daraja / intasend
│   ├── payouts.js              pluggable payouts layer — the escrow release to the vendor
│   ├── asyncHandler.js         small helper so async route errors return JSON
│   └── routes/
│       ├── jobs.js               driver-facing endpoints
│       ├── vendors.js            vendor-facing endpoints + self-registration + phone lookup
│       ├── admin.js              vendor application review (approve/reject)
│       ├── notifications.js      in-app notification feed (list, mark read)
│       ├── payments.js           payment initiation, polling, Daraja + IntaSend callbacks
│       ├── payouts.js            payout status + IntaSend send-money callback
│       └── calls.js              call signaling (place, poll, accept/decline/end)
├── migrations/                  users / vendors / vendor_services / jobs / vendor approval fields /
│                                 notifications / payments / calls / payouts
├── seeds/                       14 sample vendor profiles across Nairobi + metro area (pre-approved)
└── public/
    └── index.html                the live demo app (driver + vendor + signup + admin screens)

../index.html                  Phase 1 static prototype (mock data, no backend) — kept one level up for reference
```

Open `public/index.html` via the running server (not by double-clicking the file) — see setup below.

---

## Architecture

**Frontend** — a single HTML file (`public/index.html`) with inline CSS/JS. Mobile-first phone-frame UI. No framework, no build step. It talks to the backend exclusively through `fetch()` calls to a REST API on the same origin, and polls a handful of endpoints every 1.5–3 seconds so two browser tabs (e.g. one acting as the driver, one as the vendor) stay in sync — this is a genuine two-sided marketplace now, not a canned animation.

**Backend** — Node.js + Express. Route groups:
- `GET /api/health` — liveness check
- `/api/jobs/*` — driver-facing: create a request, fetch ranked nearby vendors, pick one, cancel
- `/api/vendors/*` — vendor-facing: self-register, profile, stats, availability toggle, incoming/active jobs, accept/decline, advance job status
- `/api/admin/*` — review vendor applications: list pending, approve, reject
- `/api/notifications/*` — in-app notification feed for a driver or vendor: list + mark read
- `/api/payments/*` — initiate an M-Pesa payment for a completed job, poll its status, and receive the Daraja STK Push callback

**Database** — SQLite via a file (`fixify-app/fixify.sqlite3`), accessed through **Knex.js** as the query layer. Knex generates SQL for whichever client is configured — nothing in the models, routes, or migrations is SQLite-specific. Moving to Postgres later is a config change (see "Migrating to Postgres" below), not a rewrite.

**Matching** — no external maps API. `src/matching.js` computes straight-line (haversine) distance between the driver's coordinates and each candidate vendor, then derives a rough ETA (distance ÷ assumed average speed) and price estimate (flat base fare + per-km rate). Only vendors with `approval_status = 'approved'` and `status = 'available'` are ever considered — pending or rejected applicants never enter the matching pool.

**Notifications** — `src/notifications.js` is a small pluggable layer sitting in front of every "something happened" event (a vendor gets a new job request, a driver's vendor accepted/is en route/completed the job, a vendor's application was approved/rejected, etc.). Every route that triggers one of these calls `safeNotify(...)` — never a specific delivery mechanism directly — so which "provider" actually delivers the message is a one-line config change (`NOTIFICATION_PROVIDER` env var), not a rewrite of any route. Two providers exist today:
- **`console`** (default) — logs clearly to the server terminal. Needs no account/credentials, which is why it's the default for a demo-stage app.
- **`africastalking`** — a real SMS-sending implementation against [Africa's Talking](https://africastalking.com/)'s REST API (the natural SMS provider for a Kenya-based product), gated behind env vars. If those env vars aren't set, it logs a warning and falls back to the console provider automatically rather than failing the request. See "Wiring in a real SMS provider" below.

Every notification is also persisted to a `notifications` table regardless of which provider handled delivery — that's what powers the in-app 🔔 bell/badge in both the driver and vendor screens, so the feature is fully demoable with zero external accounts, and polling that table doubles as a simple in-app notification center even after a real SMS/push provider is wired in later.

**Payments (collection)** — `src/payments.js` follows the exact same pattern as notifications: routes never talk to M-Pesa directly, they call `getPaymentProvider().initiate(...)`, and which provider that resolves to is a `PAYMENT_PROVIDER` env var. Four providers exist today: `mock` (default — simulates the full async STK Push round-trip locally, no external account needed), `daraja` (real Safaricom STK Push, collection only — no payout/split mechanism), `intasend` (real STK Push into an IntaSend wallet — see below), and `kopokopo` (real STK Push via Kopo Kopo — **the recommended, verified-live option**, see "Going live with Kopo Kopo" below). All fall back to `mock` if their required env vars are incomplete.

**Payment timing — this is the important part.** A driver pays the moment they select a vendor (job status `awaiting_payment`), **before that vendor is ever notified or dispatched** — not after the job completes. The reasoning: with payment at the end, a vendor could drive out and do real work with no guarantee the driver ever pays, since M-Pesa has no card-style pre-authorization hold to protect against that. Charging upfront against the fare estimate (already computed the moment a vendor is picked) closes that gap without needing a hold M-Pesa doesn't support. `completePayment()` in `src/payments.js` is where the job actually flips to `matched` and the vendor is notified for the first time — on payment failure, the vendor is never told the job existed, and the driver can simply retry. A re-picked vendor after a decline skips straight to `matched` without a second charge, since the original payment already covers the job.

All providers funnel into that one shared `completePayment()` function, which updates the `payments` row, notifies the driver, and (on success) notifies the vendor and unlocks the job.

**Payments (payout) / the escrow model** — `src/payouts.js`. Kenya requires a Central Bank–licensed Payment Service Provider to legally hold customer funds, even briefly — not something a pilot builds itself. So Fixify never custodies driver money directly: it collects into a licensed aggregator's wallet/till, then triggers a payout from that wallet to the vendor's own M-Pesa number, minus a platform commission (`PLATFORM_COMMISSION_RATE`, default 15%). **The payout fires when the job is marked `completed`** (see `routes/vendors.js`), not when payment clears — since payment now happens up front, paying the vendor immediately on payment would mean they could get paid before ever showing up, just flipping the non-payment risk onto drivers instead of fixing it. Collect early, release late — that's the actual escrow shape. Three providers, same pluggable pattern as everything else:
- **`mock`** (default) — simulates the payout landing in the vendor's M-Pesa a few seconds after the job is marked completed.
- **`kopokopo`** — real M-Pesa B2C Send Money, **verified working end to end against a live sandbox account** — see "Going live with Kopo Kopo" below.
- **`intasend`** — a real implementation of IntaSend's M-Pesa B2C Send Money API. **Only the first of its two required steps is wired up** — IntaSend requires an RSA-signed "approve" call before a disbursement actually moves (their fraud-control measure), and the exact approval endpoint isn't in their public docs; it's issued once you register an RSA key in your IntaSend dashboard. Until that's finished, a real payout initiates but sits at "awaiting manual approval." See "Going live with IntaSend payments" below.

A `payouts` row is created per job (linked to the `payments` row that funded it), tracking `amount` (what the vendor actually receives), `commission_amount`, and `commission_rate` as a snapshot — so historical payouts stay correct even if the commission rate changes later. Vendor "today's earnings" on the dashboard reflects completed **payouts** (net of commission), not the driver's gross payment.

**Payments (refunds)** — `src/refunds.js`. Paying up front means a driver can end up with a completed payment for a job that never finishes (vendor never accepts, or the driver cancels for a legitimate reason). `POST /api/jobs/:id/cancel` automatically triggers a full refund whenever the cancelled job had a completed payment — mechanically this reuses the exact same payout-provider machinery (`getPayoutProvider()`), just aimed at the driver's phone for the full amount instead of the vendor's for the commission-adjusted amount. Kopo Kopo/IntaSend send their webhook to the same URL either way, so `src/routes/payouts.js`'s callback handlers try matching a payout first and fall back to matching a refund.

The pay screen now sits right after a driver picks a vendor, not at the end: it shows the fare estimate, collects an M-Pesa number, and calls `POST /api/payments`. The old "skip payment for now" escape hatch was removed — allowing a skip there would defeat the entire point of moving payment earlier — and replaced with "Cancel request," which cancels the job outright (and refunds it, if payment had already gone through).

---

## Data model

**users** — drivers. Created on first request (matched by phone if provided, otherwise a fresh row). No login/auth yet.

**vendors** — mechanics/tow/tire operators. Fields: name, business name, vehicle type, phone, rating, lat/lng, neighborhood, plate, icon, `id_number` (National ID or plate, captured at signup for lightweight verification), `approval_status` (`pending` / `approved` / `rejected`), and `status` — the *operational* availability (`available` / `busy` / `offline`), separate from approval. A vendor can be approved but offline, or pending and therefore always excluded from matching regardless of `status`.

**vendor_services** — join table; a vendor can offer multiple service types (tire, towing, engine, battery, fuel, accident, other). Modeled as a table rather than a JSON column so it stays indexable and portable.

**jobs** — one row per roadside request. Tracks the driver, the matched vendor (nullable), service type, driver's lat/lng, a `declined_vendor_ids` list (so a vendor who declines isn't re-offered the same job), price/ETA/distance snapshots, and a `status` plus a timestamp for every stage:

```
requested → awaiting_payment → matched → accepted → en_route → completed
                                   ↘ (vendor declines) → back to requested
        (driver can cancel from any non-terminal state) → cancelled
                       (refund fires automatically if already paid)
```

**Why `awaiting_payment` and `matched` are separate states:** payment happens the moment a driver picks a vendor, *before* that vendor is ever notified or dispatched — a vendor should never do real work against a request that hasn't been paid for. A job only becomes `matched` (and the vendor only finds out it exists) once payment actually clears — see `completePayment()` in `src/payments.js`. Re-picking a vendor after a decline skips straight back to `matched` without a second charge, since the original payment already covers the job regardless of which vendor ultimately takes it. See "Payments (collection)" below for the full reasoning.

**notifications** — one row per notification, regardless of delivery provider. Fields: `recipient_type` (`driver`/`vendor`), `recipient_id`, an optional `job_id`, `type` (`job_request` / `job_accepted` / `job_declined` / `job_en_route` / `job_completed` / `job_cancelled` / `vendor_approved` / `vendor_rejected` / `payment_completed` / `payment_failed` / `payout_completed` / `payout_failed` / `refund_completed` / `refund_failed`), `title`, `body`, `channel` (which provider handled it), `status` (`sent`/`failed`), and `read_at`.

**payments** — one row per payment *attempt* on a job (a retry after a failure creates a new row, so attempt history is kept, not overwritten). Fields: `job_id`, `amount` (KES, copied from the job's `price_estimate` at payment time), `method` (`mpesa`), `phone` (the number charged), `status` (`pending` / `completed` / `failed` / `refunded`), `provider` (`mock` / `daraja` / `intasend` / `kopokopo`), `provider_reference` (how a callback gets matched back to this row), `receipt_number` (populated once completed), and timestamps for each stage.

**payouts** — the escrow-release side: one row per payout *attempt* to the vendor, funded by a specific `payments` row (`payment_id`), fired when the job is marked **completed** — not when the payment clears (see above; paying the vendor before they've done the work would just move the risk onto drivers instead of fixing it). Fields: `job_id`, `payment_id`, `vendor_id`, `amount` (KES the vendor actually receives, net of commission), `commission_amount` and `commission_rate` (snapshotted at payout time, so past payouts stay correct if the rate later changes), `phone` (vendor's number, snapshotted at payout time), `status` (`pending` / `completed` / `failed`), `provider` (`mock` / `intasend` / `kopokopo`), `provider_reference`, `failure_reason`, and timestamps for each stage.

**refunds** — the safety valve for paying up front: one row per refund *attempt*, fired automatically when a job with a completed payment is cancelled before it finishes. Mechanically identical to a payout (send money to a phone number), just aimed at the driver for the full amount rather than the vendor net of commission — see `src/refunds.js`, which reuses the payout provider directly rather than duplicating a third integration. Fields: `job_id`, `payment_id`, `amount`, `phone` (driver's number), `status` (`pending` / `completed` / `failed`), `provider`, `provider_reference`, `failure_reason`, and timestamps for each stage.

---

## Setup & running it locally

Requires Node.js (v18+ recommended). From inside this folder (`fixify-app/`):

```bash
npm install
npm run setup      # runs migrations, then seeds 14 sample vendors across Nairobi + metro area (pre-approved)
npm start
```

Then open **http://localhost:3000** in a browser. That's the whole app — frontend and API are served from the same process.

For active development, `npm run dev` uses nodemon to restart on file changes.

**If you already ran this before Phase 3, 4, or 5:** the vendor approval fields, the notifications table, and the payments table were all added at different points. `npm start` now automatically applies any pending migrations before the server starts accepting requests (see "Troubleshooting" below), so the schema itself can no longer silently drift out of date — but you should still run `npm run seed` again after pulling newer code, so the 8 demo vendors are explicitly marked `approved` (re-seeding clears and reinserts all vendors/jobs/users — expected in a dev/demo database, not something you'd do against real production data).

**To see the two-sided marketplace in action:** open the app in two browser tabs. In tab 1, go through the driver flow ("My car broke down") and pick a vendor. In tab 2, switch to "Service Provider" → "Open vendor dashboard (demo vendor)" — the request should appear within a few seconds (and a 🔔 badge should light up — check the server terminal too, you'll see a `[notify:console]` log line fire the moment the driver selects that vendor). Accepting it in tab 2 updates tab 1 automatically, including a driver-side notification badge when the vendor accepts/goes en route/completes. If you don't want to juggle two tabs, the driver's confirmation screen has a small "simulate vendor actions" link that makes the same real API calls on a timer.

**To see payment end to end:** get a job to the vendor marking it "Complete" (either via the two-tab flow above, or the "simulate vendor actions" link). The driver's app moves to a payment screen showing the job's price estimate — enter any phone number and tap "Pay with M-Pesa." Watch the server terminal for a `[payments:mock] STK push simulated...` log line; a few seconds later the screen updates itself to "Payment received" with a fake receipt number, and both the driver and vendor get a payment notification. No real money or SMS is involved anywhere in this path by default.

**To try vendor self-registration:** from the landing screen, switch to "Service Provider" → "Apply to become a vendor." Submit the form, then open the admin screen (small "Admin" link on the landing screen) to approve or reject it. Approving fires a notification to that vendor too (console log + a row in the `notifications` table) — approved vendors immediately become eligible for matching.

**Resetting the database:** delete `fixify.sqlite3` and re-run `npm run setup`.

### Troubleshooting

**"Something threw an error" on any action (vendor registration included):** as of this update, `npm start` runs `db.migrate.latest()` before the server starts accepting requests, and the server's error handler now returns the *actual* error message in the response instead of a generic "Internal server error" — so whatever goes wrong should now show up as a specific, readable message in the toast on screen (and always in full in the server terminal). If you hit an error:
1. Check the server terminal first — the full error is always logged there, migration-related or not.
2. If the terminal shows something like `SQLITE_ERROR: no such column`, your database file predates a schema change. Run `npm run migrate` manually (it's safe to run repeatedly — a no-op if already current) and restart.
3. If it's something else, the on-screen toast text is now the real error message — that's the most useful thing to copy/paste when reporting a bug.

This was specifically hardened after a report that vendor self-registration threw an error with no further detail available at the time. A full manual review of the registration path — the signup form, `POST /api/vendors`, the `approval_status`/`id_number` migration, and the seed script — turned up no field-name mismatches or missing-required-field bugs in the code itself; the most likely real-world cause was a database file that hadn't picked up the Phase 3 schema change yet, which the auto-migration on startup now prevents going forward. If registration still fails after updating, the improved error message above should make the actual cause obvious.

### Migrating to Postgres later

`pg` is already a dependency (added when the deployment setup below was built), so this is now just:

1. Set a `DATABASE_URL` environment variable pointing at your Postgres instance
2. Run the app with `NODE_ENV=production` (picks up the `production` block in `knexfile.js`)
3. Run `npm run migrate` and `npm run seed` against the new database

No route, model, or query code changes are required — that's the point of going through Knex from the start. All migrations use Knex's schema builder exclusively (no raw SQLite-specific SQL anywhere in the codebase), so they're portable by construction — see **DEPLOY.md** for the full path from local SQLite to a self-hosted Postgres instance on a VPS.

### Deploying to a VPS

See **[DEPLOY.md](./DEPLOY.md)** for a full walkthrough: Docker + Docker Compose (app + self-hosted Postgres), Nginx as a reverse proxy, and HTTPS via Certbot/Let's Encrypt, written specifically for Oracle Cloud's Always Free tier (a genuinely free ARM VPS, up to 4 OCPUs/24GB RAM). `Dockerfile`, `docker-compose.yml`, `.env.example`, and `deploy/nginx.conf` in this repo are the artifacts that walkthrough uses — none of it is sandbox-only, it's meant to be the real pilot deployment.

### Wiring in a real SMS provider later

Right now `NOTIFICATION_PROVIDER` defaults to `console`, which just logs to the server terminal and stores everything in the `notifications` table (which is what the in-app 🔔 bell reads from). To switch to real SMS via Africa's Talking once you have an account:

1. Sign up at [africastalking.com](https://africastalking.com/) and create an app to get an API key + username (their sandbox app works for testing before you commit to a paid sender ID).
2. Set these environment variables when starting the server:
   - `NOTIFICATION_PROVIDER=africastalking`
   - `AT_API_KEY=<your API key>`
   - `AT_USERNAME=<your Africa's Talking username>`
   - `AT_SENDER_ID=<your approved sender ID>` (optional — omit to use their shared/sandbox sender)
3. That's it — no code changes. Every place that currently calls `safeNotify(...)` (job requests, accept/decline, status updates, vendor approval) will start sending real SMS to the phone numbers already on file (driver phone at request time, vendor phone at signup), and will keep logging to the `notifications` table exactly as before.
4. If `AT_API_KEY`/`AT_USERNAME` are missing, or a recipient has no phone number on file, it automatically falls back to the console provider and logs a warning instead of failing the request — so a half-configured environment degrades gracefully rather than breaking the app.

Twilio (or any other provider) would follow the same pattern: add a new provider function in `src/notifications.js` alongside `africasTalkingProvider`, register it in the `PROVIDERS` map, and point `NOTIFICATION_PROVIDER` at it.

### Going live with real M-Pesa (Daraja) credentials

Right now `PAYMENT_PROVIDER` defaults to `mock`, which simulates the whole STK Push flow locally with no Safaricom account and no real money moving. To switch to a real M-Pesa integration:

1. Create an account at the [Safaricom Daraja portal](https://developer.safaricom.co.ke/) and create an app. This gives you a **sandbox** consumer key + secret immediately, for free, with no business paperwork — this is what you'd use first, before ever touching production.
2. For sandbox testing, Safaricom publishes a standard test shortcode (`174379`) and a test passkey on the Daraja docs site (under the "Lipa Na M-Pesa Online" / STK Push sample app) — use those to get a real sandbox STK push working before requesting your own production shortcode. Safaricom also publishes a test phone number (`254708374149`) that works with the sandbox regardless of whose phone you're testing from.
3. **The callback URL is the part that trips people up locally.** Daraja will only call back to a real, publicly reachable HTTPS URL — it cannot reach `localhost`. For local development, run [ngrok](https://ngrok.com/) (`ngrok http 3000`) and use the HTTPS URL it gives you, pointed at `/api/payments/mpesa/callback`, e.g. `https://abcd1234.ngrok.io/api/payments/mpesa/callback`. In a real deployment this would just be your production domain.
4. Set these environment variables when starting the server:
   - `PAYMENT_PROVIDER=daraja`
   - `MPESA_CONSUMER_KEY=<from your Daraja app>`
   - `MPESA_CONSUMER_SECRET=<from your Daraja app>`
   - `MPESA_SHORTCODE=<174379 for sandbox, or your paybill/till number for production>`
   - `MPESA_PASSKEY=<the sandbox passkey from Daraja docs, or your production passkey>`
   - `MPESA_CALLBACK_URL=<your ngrok URL (dev) or production URL>/api/payments/mpesa/callback`
   - `MPESA_ENV=sandbox` (or `production` once you have a live shortcode + passkey from Safaricom)
5. That's it — no code changes. `POST /api/payments` will now perform a real OAuth token fetch and a real STK push against Safaricom's sandbox (or production) API, and Safaricom's callback to your ngrok/production URL will land on `POST /api/payments/mpesa/callback`, which runs through the exact same `completePayment()` logic the mock provider uses today.
6. If any of the `MPESA_*` env vars are missing, it automatically falls back to the `mock` provider and logs a warning — so a half-configured environment degrades gracefully instead of breaking checkout.

**Before trusting this with real money**, a few things this build does *not* yet do that a production payments integration should: verify the callback actually came from Safaricom (Daraja doesn't sign callbacks by default — IP allowlisting is the usual mitigation), handle Safaricom's callback retry behavior more defensively, add a reconciliation job for payments that never get a callback at all, and add refund handling. None of that is hard to add on top of this structure, but none of it exists yet.

### Going live with IntaSend payments (collection + vendor payout)

IntaSend was the original candidate for the full escrow-like flow — collect from the driver, automatically pay the vendor their cut — without becoming a CBK-licensed Payment Service Provider yourself (see `src/payouts.js` for why that matters). **In practice, IntaSend's sandbox turned out to be invite-only** (a request submitted while building this was still pending review, despite docs implying open self-serve access) — **Kopo Kopo below is the currently-recommended path**, since its sandbox is genuinely self-serve and every request/response/webhook shape below has been confirmed against a real account. This section is kept for when/if an IntaSend invite comes through, or if you prefer their feature set once you have access.

1. Sign up at [intasend.com](https://intasend.com) and request sandbox access — be aware this may sit in a review queue rather than granting instant access.
2. From your IntaSend dashboard, grab your **sandbox** public key, secret key, and wallet ID (Settings → API Keys / Wallets).
3. For payments (collection), set:
   - `PAYMENT_PROVIDER=intasend`
   - `INTASEND_PUBLIC_KEY=<your public key>`
   - `INTASEND_WALLET_ID=<the wallet to collect into>`
   - `INTASEND_ENV=sandbox` (or `live` once you have production keys)
4. Register your callback URL with IntaSend (dashboard → Webhooks) pointing at `<your domain>/api/payments/intasend/callback`. Like Daraja, IntaSend cannot reach `localhost` — use ngrok for local testing.
5. For payouts (paying the vendor), set:
   - `PAYOUT_PROVIDER=intasend`
   - `INTASEND_SECRET_KEY=<your secret key>`
   - `INTASEND_DEVICE_ID=<device ID created in your dashboard>`
   - `INTASEND_SENDMONEY_CALLBACK_URL=<your domain>/api/payouts/intasend/callback`
6. **Before payouts will actually move money**, finish IntaSend's RSA-signed approval step: generate an RSA-2048 keypair, upload the public key in your IntaSend dashboard (Settings → Send Money → API Authentication), then implement `approveSendMoney()` in `src/payouts.js` against the exact approval endpoint IntaSend gives you once that key is registered (not published in their general docs). Until then, a real payout initiates but sits at "awaiting manual approval" — approve it by hand in the dashboard if you need to pay a vendor before finishing this.
7. If any of the collection or payout env vars are missing, both fall back to the `mock` provider and log a warning — a half-configured environment degrades gracefully rather than breaking checkout.

**Before trusting this with real money**, the same caveats as Daraja apply (callback authenticity, retries, reconciliation, refunds) — plus finishing the RSA approval step above is a hard requirement, not optional polish, since payouts silently won't complete without it.

### Going live with Kopo Kopo (collection + vendor payout) — recommended, fully verified

Kopo Kopo (K2 Connect) is a Kenya-native M-Pesa integration whose sandbox is genuinely self-serve — no invite queue. **Everything below was tested against a real Kopo Kopo sandbox account while building this integration** (not just read from their docs, which have real gaps — e.g. their guide describes `event.errors` as an array, but a real failure response returns a plain string): a full collection succeeded, a full payout succeeded with no manual approval step, and both success *and* failure webhook payloads were captured live via a temporary public endpoint. This is the most trustworthy provider in this codebase as a result.

1. Sign up at [payment.kopokopo.com](https://payment.kopokopo.com) or go straight to the sandbox at [sandbox.kopokopo.com](https://sandbox.kopokopo.com) and use "Sign up" there — sandbox accounts are separate from live accounts (a different login), and are not gated.
2. In the sandbox dashboard, go to **Authorization → Add new API application**, name it anything, and it immediately gives you a **Client ID** and **Client Secret** — no waiting.
3. Set:
   - `PAYMENT_PROVIDER=kopokopo` and/or `PAYOUT_PROVIDER=kopokopo`
   - `KOPOKOPO_CLIENT_ID=<from your API application>`
   - `KOPOKOPO_CLIENT_SECRET=<from your API application>`
   - `KOPOKOPO_TILL_NUMBER=1234567` for sandbox (confirmed as their "always succeeds" test till; `K000000` is confirmed as "always fails" — both discovered empirically, not documented). **This same value doubles as `source_identifier` for payouts** — Kopo Kopo's docs don't state this, it was confirmed by testing.
   - `KOPOKOPO_CALLBACK_URL` / `KOPOKOPO_SENDMONEY_CALLBACK_URL` pointing at `<your domain>/api/payments/kopokopo/callback` and `.../api/payouts/kopokopo/callback` — like the other providers, Kopo Kopo cannot reach `localhost`, use ngrok for local testing.
   - `KOPOKOPO_ENV=sandbox` (or `production` once you have live credentials — note the production base URL, `api.kopokopo.com`, has not itself been tested, only sandbox)
4. Phone numbers must **not** have a leading `+` (confirmed by a real `400: "invalid length or format"` error) — `src/payments.js` and `src/payouts.js` both strip it automatically via `toKopoKopoPhone()`, so this only matters if you're calling their API directly outside this codebase.
5. If any required env vars are missing, both collection and payout fall back to the `mock` provider and log a warning.

**One honest remaining gap**: only the payout *success* webhook shape was captured (no way to force a real payout failure in sandbox) — the failure-path field names in `src/routes/payouts.js`'s Kopo Kopo callback handler are a reasonable best-effort pattern match, not independently confirmed the way every other path in this integration is. Worth deliberately testing (e.g. an invalid phone number, an over-limit amount) before fully trusting it in production.

**Before trusting this with real money**, the same general caveats apply as the other providers: verify callback authenticity, add reconciliation for payments/payouts that never receive a callback, and add refund handling — none of that exists yet for any provider in this codebase.

---

## API reference (brief)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/jobs` | Create a request (driver name, service type, lat/lng) |
| GET | `/api/jobs/:id` | Get current job status + matched vendor |
| GET | `/api/jobs/:id/nearby-vendors` | Ranked available + approved vendors by distance |
| POST | `/api/jobs/:id/select-vendor` | Driver picks a vendor → status `awaiting_payment` (or straight to `matched` if this job was already paid for — a re-pick after a decline) |
| POST | `/api/jobs/:id/cancel` | Driver cancels |
| GET | `/api/vendors` | List all vendors (debug/admin use) |
| POST | `/api/vendors` | Vendor self-registration → status `pending` |
| GET | `/api/vendors/:id` | Vendor profile |
| GET | `/api/vendors/:id/stats` | Today's earnings/completed jobs |
| PATCH | `/api/vendors/:id/availability` | Toggle online/offline (blocked until approved) |
| GET | `/api/vendors/:id/jobs` | Incoming (pending) + active job for that vendor |
| POST | `/api/vendors/:vendorId/jobs/:jobId/accept` | Vendor accepts |
| POST | `/api/vendors/:vendorId/jobs/:jobId/decline` | Vendor declines (job returns to the pool) |
| PATCH | `/api/vendors/:vendorId/jobs/:jobId/status` | Vendor advances `accepted → en_route → completed` |
| GET | `/api/admin/vendors?status=pending` | List vendor applications by approval status (`pending`/`approved`/`rejected`/`all`) |
| POST | `/api/admin/vendors/:id/approve` | Approve a pending vendor → enters matching pool |
| POST | `/api/admin/vendors/:id/reject` | Reject a pending vendor |
| GET | `/api/notifications/:recipientType/:recipientId` | List recent notifications for a driver or vendor + unread count |
| POST | `/api/notifications/:id/read` | Mark one notification as read |
| POST | `/api/payments` | Driver pays to confirm a matched vendor — only valid while the job is `awaiting_payment` (`jobId`, `phone`) |
| GET | `/api/payments/:id` | Poll a payment's status |
| GET | `/api/payments/job/:jobId` | Latest payment attempt for a job, if any |
| POST | `/api/payments/mpesa/callback` | Daraja's STK Push result callback (not used by the mock provider) |
| POST | `/api/payments/intasend/callback` | IntaSend's collection result webhook (not used by the mock provider) |
| POST | `/api/payments/kopokopo/callback` | Kopo Kopo's `incoming_payments` result webhook — verified live (see README) |
| GET | `/api/payouts/job/:jobId` | Latest payout attempt for a job, if any (the vendor's cut, net of commission — fires on job completion) |
| POST | `/api/payouts/intasend/callback` | IntaSend's send-money (B2C) result webhook — also handles refund callbacks (see `src/refunds.js`) |
| POST | `/api/payouts/kopokopo/callback` | Kopo Kopo's `send_money` result webhook — verified live; also handles refund callbacks |
| GET | `/api/refunds/job/:jobId` | Latest refund attempt for a job, if any — fires automatically on cancelling an already-paid job |
| POST | `/api/calls` | Place a call for a job (`jobId`, `callerType`: `driver`/`vendor`) |
| GET | `/api/calls/job/:jobId` | Latest call for a job, if any — polled by both sides to detect an incoming call |
| POST | `/api/calls/:id/accept` / `/decline` / `/end` | Callee accepts/declines a ringing call, or either side hangs up |

### Known limitations (by design, not oversight)

- No authentication anywhere yet — a vendor identifies themselves by the phone number they registered with (looked up against the real `vendors` table, persisted in `localStorage`), and the admin screen/endpoints have no login gate. Real password/OTP-based auth for drivers, vendors, and admins is still ahead.
- ID/plate verification at signup is a plain text field with no actual document check — an admin reviews it by eye before approving. Real KYC/document upload is a future step.
- A driver's request currently goes to one vendor at a time, in ranked order (driver picks, or re-picks if declined) — there's no simultaneous broadcast to multiple vendors yet.
- ETA/pricing are heuristics (avg speed + flat rate), not a real routing engine.
- Ratings submitted on the driver's "done" screen aren't persisted to the vendor's rating yet.
- Notifications are delivered via a console log + in-app bell by default — no real SMS/push account is configured (see "Wiring in a real SMS provider" above).
- Notification delivery relies on the frontend polling every 1.5–3 seconds, not a push channel (WebSocket/SSE) — a deliberate choice to keep the mechanism simple and low-risk to get right; it's not instantaneous, but it's reliable and easy to reason about.
- Voice calling is simulated signaling, not real telephony — the `calls` table and ringing/accept/decline/connected lifecycle are real and synced between both sides, but no actual audio ever crosses a phone network. Real call masking (e.g. via Africa's Talking Voice or Twilio) is still ahead. Two-way in-app text chat is still UI-only.
- Payments/payouts default to a simulated M-Pesa flow — no real IntaSend or Safaricom account is configured yet (see "Going live with IntaSend payments" and "Going live with real M-Pesa (Daraja) credentials" below).
- The real Daraja and IntaSend provider code has been written and documented but never actually run against a live sandbox (no credentials were available while building this) — treat both as solid, faithful-to-the-docs starting points to validate once you have real credentials, not as already-proven-to-work. **Kopo Kopo is the exception** — its collection and payout providers, and the webhook handlers for both, have been run against a real sandbox account and confirmed working end to end (see "Going live with Kopo Kopo"). It's the recommended provider as a result — IntaSend's sandbox turned out to be invite-gated in practice, contrary to what its docs implied.
- The IntaSend payout (disbursement) provider only completes step 1 of IntaSend's required two-step flow — the RSA-signed approval step isn't wired up (the exact endpoint isn't in IntaSend's public docs; it's issued once you register a signing key in your dashboard). A real payout currently stops at "awaiting manual approval" until that's finished. See `src/payouts.js` and "Going live with IntaSend payments" below.
- Refunds exist and fire automatically on cancelling a paid job (see `src/refunds.js`), but they reuse the payout provider — so a refund via `intasend` inherits the same "step 1 only, needs manual approval" gap as IntaSend payouts. Refunds via `kopokopo` use the verified-working path.
- No reconciliation job for payments/payouts/refunds that never receive a callback at all (e.g. a webhook silently lost), and no callback authenticity verification for any provider's webhook — anyone who discovers a callback URL could currently POST a fake "payment succeeded" event. Fine for a closed pilot, not for handling real strangers' money at any scale.
- The price a driver pays is locked in at the *first* vendor match for a job — if they're re-matched to a different (further/closer) vendor after a decline, the original price stands rather than being recalculated. Deliberate (avoids double-charging or partial refunds for a re-match), but means the price shown briefly on the vendor-picking screen for a fallback vendor may not exactly equal what was actually charged.
- One payment amount per job, always equal to the original price estimate — no itemized billing, discounts, or tipping.
- The platform commission rate is a single global env var (`PLATFORM_COMMISSION_RATE`) — no per-vendor rates, promotions, or negotiated rates yet.

---

## Testing note

Every phase of this build (2 through 5) was developed and code-reviewed in an environment without the ability to actually run `npm install` / start the server (no local execution sandbox was available in any of those sessions). Every file was manually re-read for correctness — route paths, request/response field names between frontend and backend, migration/foreign-key ordering — and a few real bugs were caught this way (a SQLite timestamp string-comparison issue in the stats endpoint, a redundant primary-key modifier in the migrations). Please run through `npm install && npm run setup && npm start` yourself and flag anything that doesn't behave as described here — none of it has been confirmed by an actual execution pass yet, and that especially applies to the real Daraja/Africa's Talking provider code paths, which have never been exercised against a live account at all.

---

## Progress

All 5 originally scoped MVP phases below have a working, demoable implementation — the full request → match → track → complete → pay lifecycle runs end to end on a real backend and database. Everything left unchecked from here down is a real-credentials or production-hardening step (real SMS, real M-Pesa, real auth, real document verification), not a missing feature of the app itself.

**Phase 1 — Clickable demo** ✅ Done
- Static single-file HTML/CSS/JS prototype with mock Nairobi data
- Driver flow: service select → location → nearby vendors → confirm → live tracking → rating
- Vendor flow: dashboard, accept/decline, active job

**Phase 2 — Backend + database** ✅ Done
- Express REST API + SQLite database via Knex (Postgres-portable by config change)
- Real data models: users (drivers), vendors, vendor_services, jobs with full status lifecycle
- Real haversine-based geolocation matching, ranked by distance, with ETA/price estimates
- Endpoints for creating requests, listing ranked nearby vendors, selecting/accepting/declining, advancing job status, polling status
- Frontend rewired to hit the real API — two browser tabs (driver + vendor) now sync through a real shared database
- Seed data: 14 sample vendors with real approximate coordinates, covering Nairobi County plus the wider metro area (see Phase 7)

**Phase 3 — Vendor & driver onboarding** 🟡 In progress
- ✅ Vendor self-registration form (name, phone, service type(s), coverage neighborhood, ID/plate verification field) → lands as `pending`
- ✅ Admin endpoints + a simple in-app screen to list pending applications and approve/reject them
- ✅ Approved vendors enter the matching pool automatically; pending/rejected never do
- ⬜ Real authentication for drivers, vendors, and admins (everything above is still gate-free/unauthenticated)
- ⬜ Driver accounts with request history
- ⬜ Multi-vendor broadcast (currently one vendor is offered a job at a time, in rank order)
- ⬜ Real document/ID verification (currently a free-text field an admin eyeballs)

**Phase 4 — Notifications** 🟡 In progress
- ✅ Pluggable notification abstraction (`src/notifications.js`) — every route calls one `safeNotify()` function, never a specific delivery channel directly
- ✅ Console/log provider working by default (zero external accounts needed) — every notification also persisted to a `notifications` table
- ✅ Vendor notified when a driver selects them for a job, and when a driver cancels
- ✅ Driver notified in-app when their vendor accepts, declines, goes en route, and completes the job
- ✅ Vendor notified when their signup application is approved/rejected
- ✅ In-app 🔔 bell + badge in both the vendor dashboard and driver confirm screen, backed by polling (not WebSocket/SSE — a deliberate, lower-risk choice for this phase)
- ✅ Africa's Talking SMS provider implemented and documented (env-var config), but **not wired to a real account** — falls back to console logging until real credentials are supplied (see "Wiring in a real SMS provider")
- ⬜ Real SMS/push actually configured with live credentials
- ⬜ Real in-app two-way text messaging (the chat UI on the driver's confirm screen is still non-functional)
- ✅ Call *signaling* between driver and vendor — a real `calls` table, ringing/accept/decline/connected/ended lifecycle, synced between both sides via the same polling loops (see `src/routes/calls.js`)
- ⬜ Real call *audio* (actual telephony/masking, e.g. via Africa's Talking Voice or Twilio) — today's calls are signaling-only, no audio ever crosses a phone network
- ⬜ Push/WebSocket delivery instead of polling, if latency ever becomes a real product issue

**Phase 5 — Payments & payouts (M-Pesa escrow)** ✅ Done — verified end to end against a real Kopo Kopo sandbox, not just mock
- ✅ Pluggable payments abstraction (`src/payments.js`) — `mock` / `daraja` / `intasend` / `kopokopo` collection providers, same `PAYMENT_PROVIDER` env var pattern as notifications
- ✅ Mock provider simulates a full STK Push round-trip (fake reference → simulated delay → simulated success) with zero external accounts
- ✅ Real Daraja (Lipa Na M-Pesa Online) provider implemented — not run against a live sandbox
- ✅ Real IntaSend collection provider implemented — not run against a live sandbox (their sandbox turned out to be invite-gated; a request is pending)
- ✅ **Real Kopo Kopo collection provider — verified against a live sandbox account**: a real STK push succeeded (`status: Success`), a real failure was also captured and confirmed (`status: Failed`, sandbox till `K000000`), and the actual webhook payload for both was captured live and matches what the code expects
- ✅ **Escrow-style payout system** (`src/payouts.js`, new `payouts` table) — Fixify never custodies driver money itself (that needs a CBK PSP license); it collects into a licensed intermediary's wallet/till, then triggers a payout to the vendor's own M-Pesa, net of a configurable platform commission (`PLATFORM_COMMISSION_RATE`)
- ✅ **Vendor-protection reorder**: payment moved to happen the moment a driver selects a vendor (new `awaiting_payment` job status), *before* that vendor is ever notified — a vendor now can never be dispatched against an unpaid request. The payout to the vendor moved the other direction, to fire on job *completion* rather than on payment — so a vendor also can't get paid before actually doing the work. See `src/routes/jobs.js`, `src/payments.js`, and `src/routes/vendors.js`
- ✅ **Automatic refunds** (`src/refunds.js`, new `refunds` table) — the necessary safety valve for paying up front: cancelling a job that was already paid for (vendor never accepted, or a legitimate driver cancellation) triggers a full refund automatically. Reuses the payout provider directly (a refund is just a payout aimed at the driver) rather than a third integration
- ✅ Mock payment/payout/refund providers — verified end to end: driver pays to confirm → vendor gets notified only now → job runs its course → payout fires on completion with the correct commission split → vendor's "today's earnings" reflects the real net payout; separately, cancelling a paid job correctly triggers a refund
- ✅ Real IntaSend payout (B2C) provider implemented for step 1 of its flow (initiate) — **step 2 (RSA-signed approval) is an intentionally flagged gap**, see "Going live with IntaSend payments" above; a real payout (or refund) stops at "awaiting manual approval" until that's finished
- ✅ **Real Kopo Kopo payout provider — verified against a live sandbox account**: a real KES 425 disbursement to a test M-Pesa number completed successfully through this codebase's own code path, no manual approval step needed. A real integration bug was caught and fixed this way — Kopo Kopo rejects phone numbers with a leading `+`, which the vendor's stored phone number has
- ✅ `payments`, `payouts`, and `refunds` tables tracking every attempt, linked to each other and to their job, with commission amounts snapshotted per payout
- ✅ Driver and vendor notified in-app for payment, payout, and refund completion/failure
- ✅ `dotenv` wired into `server.js` and `knexfile.js` so a local `.env` is actually loaded for `npm start`/`npm run migrate`, not just inside Docker
- ⬜ Real Daraja or IntaSend account actually tested (Kopo Kopo is proven; those two remain faithful-to-docs-but-unverified)
- ⬜ Finish the IntaSend RSA-signed payout approval step (see above) — not needed if going with Kopo Kopo instead
- ⬜ Kopo Kopo payout *failure* webhook shape — only the success path was captured live (no way to force a real failure in their sandbox); the failure-handling code is a reasonable pattern match, not independently confirmed
- ⬜ Reconciliation job for payments/payouts/refunds that never receive a callback at all
- ⬜ Callback authenticity verification for any provider's webhook

**Phase 6 — Deployment** ✅ Ready (needs your own VPS/account to actually run)
- ✅ Postgres-ready: `pg` installed, `knexfile.js`'s `production` block wired to `DATABASE_URL`, every migration uses Knex's schema builder only (no raw SQLite-specific SQL) so it's portable by construction
- ✅ `Dockerfile` (Debian-based, arm64/amd64 compatible) + `docker-compose.yml` (app + self-hosted Postgres with a persistent volume)
- ✅ `deploy/nginx.conf` reverse-proxy template + `.env.example` covering every env var the app reads
- ✅ **[DEPLOY.md](./DEPLOY.md)** — full walkthrough written for Oracle Cloud's Always Free tier: VM creation, the two-layer firewall gotcha specific to Oracle, Docker/Nginx/Certbot install, HTTPS via Let's Encrypt, and ongoing ops (redeploys, logs, backups)
- ⬜ Actually deployed and running on a live VPS with a real domain (the walkthrough is ready; the account creation, payment, and DNS steps are yours to do)

**Phase 7 — Geographic coverage** ✅ Done
- ✅ Matching itself was already location-agnostic (haversine on raw lat/lng, no hardcoded bounding box) — the real gap was the *display/vendor-signup* neighborhood list only covering ~10 central-Nairobi points, so a real GPS position in Thika or Machakos would resolve to a misleading "nearest" central-Nairobi label
- ✅ `src/neighborhoods.js` (vendor signup) and the frontend's `NEIGHBORHOOD_POINTS` (location display) both expanded from ~10 to 42 real places, covering Nairobi County plus the wider Nairobi Metropolitan Area — Thika/Ruiru/Juja/Kiambu Town/Limuru/Kikuyu (Kiambu County), Ngong/Rongai/Kitengela/Kiserian (Kajiado County), Machakos/Athi River (Machakos County) — each tagged with its real county (`region`)
- ✅ **Fixed a real bug**: the driver's detected location always displayed as "X, Nairobi" regardless of where X actually was — verified live that a GPS position near Thika now correctly labels as "Thika, Kiambu", Machakos as "Machakos, Machakos", Rongai as "Rongai, Kajiado", not falsely "Nairobi"
- ✅ Driver's *actual* coordinates (real device GPS via `navigator.geolocation`, already wired up) are what's sent for matching — the neighborhood name was always display-only, never fed into the haversine distance calculation
- ✅ 6 new seed vendors added across the newly-covered towns (Thika, Ruiru, Ngong, Rongai, Kitengela, Machakos) so the expanded coverage is actually demoable, not just theoretically supported — verified live: a request from real Thika coordinates correctly ranks the Thika-based vendor first at 0.2km, with central-Nairobi vendors correctly showing 39-50km away
- ⬜ ETA/pricing still use one flat average-speed constant (`AVG_SPEED_KMH` in `src/matching.js`) regardless of trip type — a 40km CBD-to-Machakos highway trip and a 2km CBD-to-CBD trip in traffic get the same km/h assumption. Not fixed here; flagged as a known heuristic limitation, same spirit as the existing "not a real routing engine" caveat
