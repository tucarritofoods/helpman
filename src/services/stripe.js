// Stripe integration — REAL payments.
//
// Setup (2 minutes, no code changes):
//   1. Create a free account at https://dashboard.stripe.com/register
//   2. Copy your keys from Developers -> API keys:
//        STRIPE_SECRET_KEY      (sk_live_...  — starts with sk_test_ in test mode)
//        STRIPE_PUBLISHABLE_KEY (pk_live_... / pk_test_... — used by the frontend)
//   3. Turn on Connect (Express accounts) for the pro payouts.
//   4. Create TWO webhooks at Developers -> Webhooks -> Add endpoint:
//      a) "Your account" events -> https://helpman.app/api/payments/webhook
//         Events: payment_intent.succeeded, payment_intent.payment_failed,
//                 charge.refunded, charge.dispute.created, charge.dispute.updated,
//                 charge.dispute.closed
//         Signing secret -> STRIPE_WEBHOOK_SECRET (whsec_...)
//      b) "Connected accounts" events -> https://helpman.app/api/payments/connect-webhook
//         Events: account.updated
//         Signing secret -> STRIPE_CONNECT_WEBHOOK_SECRET (whsec_...)
//   5. Set the four env vars and restart. Done: 30 % deposit with the card saved,
//      automatic balance on sign-off, automatic payouts to the pros.
//
// When the keys are NOT set, everything keeps working exactly as before:
// payments are recorded manually (provider='manual'). Nothing breaks.
let stripeClient = null;

function isEnabled() {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Simulated payment mode ("como si Stripe estuviera"): for end-to-end testing
// without real Stripe keys. Enabled ONLY with SIMULATED_PAYMENTS=true and only
// when Stripe is NOT configured. Every simulated record is clearly labeled so
// it can never be confused with a real charge.
function isSimulated() {
  return !isEnabled() && process.env.SIMULATED_PAYMENTS === 'true';
}

function getClient() {
  if (!isEnabled()) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY.');
  if (!stripeClient) {
    stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

// Creates a PaymentIntent (deposit or final balance) and records it as pending.
// Returns { client_secret, payment_id } — the frontend confirms with the
// publishable key via Stripe.js, the webhook marks it paid.
async function createIntent({ projectId, amountCents, kind = 'deposit', customerEmail, description, customerId, saveCard }) {
  const db = require('../db');
  const stripe = getClient();
  const label = kind === 'final' ? 'final balance' : 'deposit';
  const pi = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    receipt_email: customerEmail || undefined,
    description: description || `Helpman — ${label} for project #${projectId}`,
    metadata: { project_id: String(projectId), kind },
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    // Card on file (owner's 30/70 rule): the deposit card is saved, with the
    // customer's authorization, so the balance can be charged automatically.
    ...(customerId ? { customer: customerId } : {}),
    ...(saveCard ? { setup_future_usage: 'off_session' } : {}),
  });
  const info = await db.prepare(
    `INSERT INTO payments (project_id, kind, amount_cents, status, provider, provider_ref, notes)
     VALUES (?,?,?,'pending','stripe',?,?)`
  ).run(projectId, kind, amountCents, pi.id, 'Stripe PaymentIntent created');
  return { client_secret: pi.client_secret, payment_id: info.lastInsertRowid, payment_intent_id: pi.id };
}
// Backwards-compatible name.
const createDepositIntent = (args) => createIntent({ ...args, kind: 'deposit' });

// Refunds (part of) a PAID Stripe payment. Stripe itself rejects refunds above
// what is still refundable; we also check first to return a clean error.
async function refundPayment({ payment, amountCents, cap = false, note }) {
  const db = require('../db');
  const stripe = getClient();
  const pi = await stripe.paymentIntents.retrieve(payment.provider_ref, { expand: ['latest_charge'] });
  const charge = pi.latest_charge;
  const refundable = charge ? (charge.amount - charge.amount_refunded) : 0;
  // cap=true: refund min(requested, refundable); nothing refundable -> null (caller moves on to the next payment).
  const amount = cap ? Math.min(amountCents || refundable, refundable) : (amountCents || refundable);
  if (cap && refundable < 1) return null;
  if (amount < 1 || amount > refundable) {
    const err = new Error(`Refundable amount is ${refundable} cents.`);
    err.statusCode = 400;
    throw err;
  }
  const refund = await stripe.refunds.create({ payment_intent: payment.provider_ref, amount });
  const info = await db.prepare(
    `INSERT INTO payments (project_id, kind, amount_cents, status, provider, provider_ref, notes)
     VALUES (?,?,?,'paid','stripe',?,?)`
  ).run(payment.project_id, 'refund', amount, refund.id, note || `Refund of payment #${payment.id}`);
  return { refund_id: refund.id, payment_id: info.lastInsertRowid, amount_cents: amount };
}

// Verifies the webhook signature and applies the event to our ledger.
// Contract: returns null ONLY when the signature is invalid (caller -> 400);
// returns the event type when handled; THROWS when processing fails so the
// route answers 500 and Stripe retries. Idempotent: replays change nothing.
async function handleWebhook(rawBody, signature) {
  const db = require('../db');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set.');
  const stripe = getClient();
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (e) {
    return null; // bad signature — caller returns 400
  }

  if (event.type === 'payment_intent.succeeded') {
    await applySucceededIntent(event.data.object);
    return event.type;
  }

  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    const upd = await db.prepare(
      `UPDATE payments SET status = 'failed', notes = COALESCE(notes,'') || ' | Stripe failed'
       WHERE provider = 'stripe' AND provider_ref = ? AND status = 'pending'`
    ).run(pi.id);
    // An automatic balance charge that fails later (e.g. bank refusal after "processing").
    if (upd.changes === 1 && pi.metadata && pi.metadata.kind === 'final' && pi.metadata.project_id) {
      await db.prepare(`UPDATE projects SET balance_charge_status = 'failed', balance_charge_error = ? WHERE id = ? AND balance_charge_status = 'processing'`)
        .run('The bank refused the charge.', Number(pi.metadata.project_id));
    }
    return event.type;
  }

  // A refund made in the Stripe dashboard (or any refund we did not record): add it to the ledger once.
  if (event.type === 'charge.refunded') {
    const ch = event.data.object;
    const pay = await db.prepare(`SELECT * FROM payments WHERE provider = 'stripe' AND provider_ref = ?`).get(ch.payment_intent);
    if (!pay) return event.type;
    for (const r of ((ch.refunds && ch.refunds.data) || [])) {
      if (r.status && !['succeeded', 'pending'].includes(r.status)) continue;
      const seen = await db.prepare(`SELECT id FROM payments WHERE provider = 'stripe' AND provider_ref = ?`).get(r.id);
      if (seen) continue;
      await db.prepare(`INSERT INTO payments (project_id, kind, amount_cents, status, provider, provider_ref, notes) VALUES (?,?,?,'paid','stripe',?,?)`)
        .run(pay.project_id, 'refund', r.amount, r.id, `Refund made in Stripe for payment #${pay.id}`);
      await require('./audit').auditLog(null, 'payment.refund_external', 'payments', pay.id, `Stripe refund ${r.id} (${r.amount} cents)`);
    }
    return event.type;
  }

  // Card disputes (chargebacks): freeze the pro's payout; claw it back if it already left.
  if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.updated' || event.type === 'charge.dispute.closed') {
    const d = event.data.object;
    const chargeId = typeof d.charge === 'string' ? d.charge : d.charge && d.charge.id;
    const piId = typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent && d.payment_intent.id;
    const pay = piId ? await db.prepare(`SELECT * FROM payments WHERE provider = 'stripe' AND provider_ref = ?`).get(piId) : null;
    const status = event.type === 'charge.dispute.closed' ? (d.status === 'won' ? 'won' : d.status === 'lost' ? 'lost' : 'closed') : 'open';
    const existing = await db.prepare(`SELECT * FROM chargebacks WHERE stripe_dispute_id = ?`).get(d.id);
    if (!existing) {
      await db.prepare(`INSERT INTO chargebacks (project_id, payment_id, stripe_dispute_id, stripe_charge_id, amount_cents, reason, status) VALUES (?,?,?,?,?,?,?)`)
        .run(pay ? pay.project_id : null, pay ? pay.id : null, d.id, chargeId || null, Number(d.amount || 0), d.reason || null, status);
    } else {
      await db.prepare(`UPDATE chargebacks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, existing.id);
    }
    if (pay && !existing && status === 'open') {
      const billing = require('./billing');
      await billing.reversePayout(pay.project_id, Number(d.amount || 0), `chargeback ${d.id}`).catch(() => null);
      const { notify, shell } = require('./notify');
      const admins = await db.prepare("SELECT email FROM users WHERE role = 'admin' AND (staff_role IS NULL OR staff_role <> 'disabled')").all();
      for (const a of admins) {
        await notify({ to: a.email, subject: `Card dispute (chargeback) — project #${pay.project_id}`,
          html: shell('A customer disputed a card charge', 'Stripe reported a chargeback. The pro\'s payout is frozen (or was clawed back). Answer the dispute in the Stripe dashboard before the deadline.',
            [['Project', `#${pay.project_id}`], ['Amount', '$' + (Number(d.amount || 0) / 100).toFixed(2)], ['Reason', d.reason || '—']]) }).catch(() => {});
      }
    }
    return event.type;
  }
  return event.type; // acknowledged, nothing to do
}

// Marks a confirmed PaymentIntent as paid and moves the project forward. Used by
// the webhook AND by the automatic balance charge (synchronous success).
// Idempotent: a replay changes nothing. Throws on an amount mismatch.
async function applySucceededIntent(pi) {
  const db = require('../db');
  const pay = await db.prepare(
    `SELECT id, amount_cents, status FROM payments WHERE provider = 'stripe' AND provider_ref = ?`
  ).get(pi.id);
  if (!pay) return false;                      // not one of ours
  if (pay.status === 'paid') return false;     // replay: already applied
  const received = pi.amount_received === undefined ? pi.amount : pi.amount_received;
  if (received !== pay.amount_cents) {         // never mark paid on a different amount
    await db.prepare(
      `UPDATE payments SET notes = COALESCE(notes,'') || ' | AMOUNT MISMATCH: received ' || ? WHERE id = ?`
    ).run(String(received), pay.id);
    throw new Error(`Amount mismatch on ${pi.id}: expected ${pay.amount_cents}, received ${received}`);
  }
  const upd = await db.prepare(
    `UPDATE payments SET status = 'paid', notes = COALESCE(notes,'') || ' | Stripe confirmed'
     WHERE id = ? AND status <> 'paid'`
  ).run(pay.id);
  if (upd.changes !== 1) return false;
  const kind = pi.metadata && pi.metadata.kind;
  const pid = pi.metadata && pi.metadata.project_id;
  await require('./events').record('payment', pay.id, 'payment.paid', { data: { project_id: Number(pid) || null, kind, amount_cents: pay.amount_cents } });
  if (kind === 'deposit' && pid) {
    const proj = await db.prepare('SELECT job_request_id FROM projects WHERE id = ?').get(pid);
    if (proj) {
      // Only moves FORWARD: a late/replayed event can never pull a job back.
      await db.prepare(
        `UPDATE job_requests SET status = 'deposit_paid', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status IN ('new','ai_analyzed','quote_sent')`
      ).run(proj.job_request_id);
    }
    // Card on file: remember the card the deposit was paid with (for the balance).
    const pm = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method && pi.payment_method.id;
    const cus = typeof pi.customer === 'string' ? pi.customer : pi.customer && pi.customer.id;
    if (pm) await require('./billing').rememberPaymentMethod(Number(pid), pm, cus);
    // Email the customer: deposit received + Terms of Service.
    const { depositConfirmationEmail } = require('./notify');
    await depositConfirmationEmail(pid).catch(() => {});
    // Corte 8: the deposit is in — offer the job automatically (if on).
    await require('./dispatch').autoOffer(Number(pid), { reason: 'deposit' });
  }
  if (kind === 'final' && pid) await require('./billing').onBalancePaid(Number(pid));
  return true;
}

// ---- Stripe Connect (pro payout accounts) ----
// A separate webhook endpoint ("Connect" events) with its own signing secret.
async function handleConnectWebhook(rawBody, signature) {
  const db = require('../db');
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_CONNECT_WEBHOOK_SECRET is not set.');
  let event;
  try {
    event = getClient().webhooks.constructEvent(rawBody, signature, secret);
  } catch (e) {
    return null;
  }
  if (event.type === 'account.updated') {
    const a = event.data.object;
    await syncAccount(a);
  }
  return event.type;
}

// Copies a Connect account's readiness onto the contractor row.
async function syncAccount(a) {
  const db = require('../db');
  if (!a || !a.id) return null;
  const due = (a.requirements && a.requirements.currently_due) || [];
  await db.prepare(
    `UPDATE contractors SET payouts_enabled = ?, payout_details_submitted = ?, payout_requirements = ? WHERE stripe_account_id = ?`
  ).run(a.payouts_enabled ? 1 : 0, a.details_submitted ? 1 : 0, due.length ? JSON.stringify(due).slice(0, 2000) : null, a.id);
  return { payouts_enabled: !!a.payouts_enabled, details_submitted: !!a.details_submitted, currently_due: due };
}

// Test hook: lets the automated tests inject a fake Stripe client (no network). Never used in production.
function _setClientForTests(client) { stripeClient = client; }

// Status reporter: true when Stripe is NOT configured but SIMULATED_PAYMENTS=true.
// Every simulated record is clearly labeled so it can never be confused with a real charge.
function isSimulated() {
  return !isEnabled() && process.env.SIMULATED_PAYMENTS === 'true';
}

module.exports = { _setClientForTests, isEnabled, isSimulated, getClient, createIntent, createDepositIntent, refundPayment, handleWebhook, applySucceededIntent, handleConnectWebhook, syncAccount };
