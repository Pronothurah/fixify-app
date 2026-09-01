/**
 * Notification abstraction layer.
 *
 * Every call site in the app (routes) talks only to `safeNotify()` — never
 * to a specific delivery mechanism. Which provider actually delivers the
 * message is chosen here, by env var, so swapping in a real SMS/push
 * service later is a config/credentials change, not a rewrite of any route.
 *
 * Every notification is persisted to the `notifications` table regardless
 * of provider, which is what powers the in-app bell/badge in the frontend
 * even when there's no real SMS account configured.
 */
const db = require('./db');

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

// Default provider — no external account needed. Logs clearly to the
// server console so a demo can show "this is where a real SMS would fire."
function consoleProvider() {
  return {
    name: 'console',
    async send({ recipientType, recipientId, title, body }) {
      console.log(
        `\n🔔 [notify:console] -> ${recipientType} #${recipientId} — ${title}\n   ${body || ''}\n`
      );
      return { ok: true };
    },
  };
}

// Africa's Talking SMS provider — the natural choice for a Kenya-based
// product. Not backed by a real account in this build; if the required
// env vars aren't set it logs a warning and falls back to the console
// provider instead of failing the request. See README "Wiring in a real
// SMS provider" for the exact env vars and setup steps.
function africasTalkingProvider() {
  const apiKey = process.env.AT_API_KEY;
  const username = process.env.AT_USERNAME;
  const senderId = process.env.AT_SENDER_ID || '';

  return {
    name: 'africastalking',
    async send({ recipientType, recipientId, title, body, phone }) {
      if (!apiKey || !username) {
        console.warn('[notify:africastalking] AT_API_KEY/AT_USERNAME not set — falling back to console log');
        return consoleProvider().send({ recipientType, recipientId, title, body });
      }
      if (!phone) {
        console.warn(`[notify:africastalking] no phone number for ${recipientType} #${recipientId} — falling back to console log`);
        return consoleProvider().send({ recipientType, recipientId, title, body });
      }

      const res = await fetch('https://api.africastalking.com/version1/messaging', {
        method: 'POST',
        headers: {
          apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          username,
          to: phone,
          message: `${title}: ${body || ''}`,
          ...(senderId ? { from: senderId } : {}),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`Africa's Talking send failed: ${JSON.stringify(data)}`);
      }
      return { ok: true, data };
    },
  };
}

const PROVIDERS = {
  console: consoleProvider,
  africastalking: africasTalkingProvider,
};

function getProvider() {
  const name = process.env.NOTIFICATION_PROVIDER || 'console';
  const factory = PROVIDERS[name] || PROVIDERS.console;
  return factory();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send + persist a notification. Delivery failures (e.g. a misconfigured
 * SMS account) are caught and recorded as `status: 'failed'` rather than
 * thrown — a flaky notification should never take down the job/vendor
 * action that triggered it.
 */
async function notify({ recipientType, recipientId, jobId = null, type, title, body, phone = null }) {
  const provider = getProvider();
  let status = 'sent';

  try {
    await provider.send({ recipientType, recipientId, title, body, phone });
  } catch (err) {
    console.error(`[notify:${provider.name}] delivery failed:`, err.message);
    status = 'failed';
  }

  const [id] = await db('notifications').insert({
    recipient_type: recipientType,
    recipient_id: recipientId,
    job_id: jobId,
    type,
    title,
    body,
    channel: provider.name,
    status,
  });

  return db('notifications').where({ id }).first();
}

/**
 * Same as notify(), but never throws — used at every route call site so a
 * notification bug can't turn into a 500 on the primary action (accepting
 * a job, cancelling a request, etc.). Failures are logged, not surfaced.
 */
async function safeNotify(payload) {
  try {
    return await notify(payload);
  } catch (err) {
    console.error('[notify] failed to record notification:', err.message);
    return null;
  }
}

module.exports = { notify, safeNotify, getProvider };
