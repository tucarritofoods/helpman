// Money engine (Corte 2) — the owner's hard rule:
//
//   1. To book the visit the customer pays a DEPOSIT (DEPOSIT_PCT of the agreed
//      price, 30 % today; app_settings.deposit_pct). The card is saved, with the
//      customer's explicit authorization, for the rest.
//   2. When the customer CONFIRMS the finished work (signs off), the REST of the
//      price (+ approved change orders, − refunds) is charged AUTOMATICALLY to the
//      same card. If the bank refuses or asks for authentication, the customer gets
//      a link to pay and the balance shows up in Collections.
//   3. From the fully collected money, the pro is paid AUTOMATICALLY by Stripe
//      Connect (transfer to their Express account) once the hold period passes —
//      never while a dispute or a card chargeback is open, never twice.
//   4. Cancellation / no-show: the deposit is refunded or kept according to the
//      owner's parameters (settings: cancel_free_hours, late_cancel_fee_pct,
//      customer_no_show_fee_pct). A pro no-show always protects the customer.
//
// Every function here is idempotent or guarded by an atomic UPDATE: a retry, a
// double click or a replayed webhook never charges, refunds or pays twice.
'use strict';
const db = require('../db');
const settings = require('./settings');

const CARD_CONSENT_VERSION = 'card-on-file-2026-11-02';
const CARD_CONSENT_TEXT = 'I authorize Helpman by Mendoza Capital LLC to save this payment method and charge it for the remaining balance of this project (the agreed price minus this deposit, plus any change I approve, minus any refund) when I confirm the work is complete.';
const money = (c) => '$' + (Number(c) / 100).toFixed(2);
const stripeSvc = () => require('./stripe');

// ---------------------------------------------------------------------------
// Balances (single source of truth — payments.js and payables.js use these)
// ---------------------------------------------------------------------------
async function netPaidCents(projectId) {
  const rows = await db.prepare(
    `SELECT kind, COALESCE(SUM(amount_cents),0) AS s FROM payments
     WHERE project_id = ? AND status IN ('paid','recorded') GROUP BY kind`
  ).all(projectId);
  const by = Object.fromEntries(rows.map(r => [r.kind, Number(r.s)]));
  return (by.deposit || 0) + (by.milestone || 0) + (by.final || 0) - (by.refund || 0);
}

async function balanceCents(projectId) {
  const p = await db.prepare('SELECT customer_price_cents FROM projects WHERE id = ?').get(projectId);
  if (!p) return 0;
  return Math.max(0, Number(p.customer_price_cents) - await netPaidCents(projectId));
}

async function depositPaidCents(projectId) {
  const r = await db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE project_id = ? AND kind = 'deposit' AND status IN ('paid','recorded')`
  ).get(projectId);
  return Number(r.s);
}

async function depositPct() { return settings.get('deposit_pct'); }
async function depositFor(priceCents) { return Math.round(Number(priceCents) * (await depositPct()) / 100); }

async function openChargebackFor(projectId) {
  return db.prepare(`SELECT id FROM chargebacks WHERE project_id = ? AND status = 'open'`).get(projectId);
}
async function moneyHold(projectId) {
  if (await require('./disputes').openDisputeFor(projectId)) return 'dispute';
  if (await openChargebackFor(projectId)) return 'chargeback';
  return null;
}

// ---------------------------------------------------------------------------
// Card on file
// ---------------------------------------------------------------------------
async function ensureCustomer(userId) {
  const u = await db.prepare('SELECT id, name, email, stripe_customer_id FROM users WHERE id = ?').get(userId);
  if (!u) throw new Error('User not found.');
  if (u.stripe_customer_id) return u.stripe_customer_id;
  const c = await stripeSvc().getClient().customers.create({
    email: u.email, name: u.name, metadata: { user_id: String(u.id), platform: 'helpman' },
  }, { idempotencyKey: `customer-${u.id}` });
  await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL').run(c.id, u.id);
  const again = await db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(u.id);
  return again.stripe_customer_id || c.id;
}

async function recordAuthorization({ projectId, userId, customerId, ip }) {
  const sql = db._isPg
    ? `INSERT INTO payment_authorizations (project_id, user_id, stripe_customer_id, consent_text_version, ip)
       VALUES (?,?,?,?,?) ON CONFLICT (project_id) DO NOTHING`
    : `INSERT OR IGNORE INTO payment_authorizations (project_id, user_id, stripe_customer_id, consent_text_version, ip)
       VALUES (?,?,?,?,?)`;
  await db.prepare(sql).run(projectId, userId, customerId || null, CARD_CONSENT_VERSION, ip || null);
  await db.prepare(`UPDATE payment_authorizations SET stripe_customer_id = COALESCE(stripe_customer_id, ?), revoked_at = NULL WHERE project_id = ?`)
    .run(customerId || null, projectId);
}

// Called when the deposit charge succeeds: remember the card it was made with.
async function rememberPaymentMethod(projectId, paymentMethodId, customerId) {
  if (!projectId || !paymentMethodId) return;
  await db.prepare(
    `UPDATE payment_authorizations SET payment_method_id = ?, stripe_customer_id = COALESCE(?, stripe_customer_id)
     WHERE project_id = ? AND revoked_at IS NULL`
  ).run(paymentMethodId, customerId || null, projectId);
}

async function authorizationFor(projectId) {
  return db.prepare(`SELECT * FROM payment_authorizations WHERE project_id = ? AND revoked_at IS NULL`).get(projectId);
}

// ---------------------------------------------------------------------------
// Automatic balance charge (the 70 %)
// ---------------------------------------------------------------------------
async function parties(projectId) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!p) return {};
  const job = await db.prepare('SELECT id, customer_id, name, email, service_type FROM job_requests WHERE id = ?').get(p.job_request_id);
  const cust = job && job.customer_id ? await db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(job.customer_id) : null;
  return { p, job, cust };
}

async function notifyCustomer(projectId, subject, title, lead, rows, cta) {
  const { notify, shell } = require('./notify');
  const { job, cust } = await parties(projectId);
  const to = cust ? cust.email : job && job.email;
  if (!to) return;
  const { baseUrl } = require('./magiclink');
  const html = shell(title, lead, rows) + (cta ? `<p style="text-align:center;margin:20px 0;"><a href="${baseUrl()}/customer.html" style="background:#2b6fe3;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">${cta}</a></p>` : '');
  await notify({ to, subject, html }).catch(() => {});
}
async function notifyAdmins(subject, lead, rows) {
  const { notify, shell } = require('./notify');
  const admins = await db.prepare("SELECT email FROM users WHERE role = 'admin' AND (staff_role IS NULL OR staff_role <> 'disabled')").all();
  for (const a of admins) await notify({ to: a.email, subject, html: shell(subject, lead, rows) }).catch(() => {});
}

const RETRYABLE_STATES = ['failed', 'requires_action', 'needs_payment'];

// Charges what the customer still owes to the saved card. Never throws for a card
// problem: it records it, tells the customer how to pay and returns the outcome.
async function chargeBalance(projectId, { actorId = null, trigger = 'signoff' } = {}) {
  const stripe = stripeSvc();
  if (!stripe.isEnabled()) return { status: 'skipped', reason: 'stripe_off' };
  const { p } = await parties(projectId);
  if (!p) return { status: 'skipped', reason: 'not_found' };
  if (p.stage === 'cancelled') return { status: 'skipped', reason: 'cancelled' };
  const hold = await moneyHold(projectId);
  if (hold) return { status: 'skipped', reason: hold };
  const balance = await balanceCents(projectId);
  if (balance < 100) {
    await db.prepare(`UPDATE projects SET balance_charge_status = 'paid' WHERE id = ?`).run(projectId);
    return { status: 'nothing_due' };
  }
  const auth = await authorizationFor(projectId);
  if (!auth || !auth.payment_method_id || !auth.stripe_customer_id) {
    await db.prepare(`UPDATE projects SET balance_charge_status = 'needs_payment', balance_charge_error = ? WHERE id = ?`)
      .run('No saved card for this project.', projectId);
    await notifyCustomer(projectId, `Your balance is ready to pay — project #${projectId}`, 'Thanks for confirming your project',
      'Your project is complete. Please pay the remaining balance from your portal:', [['Project', `#${projectId}`], ['Balance', money(balance)]], 'Pay my balance');
    return { status: 'needs_payment', balance_cents: balance };
  }
  // Atomic claim: one charge at a time per project (double sign-off, retry clicks, cron).
  const claim = await db.prepare(
    `UPDATE projects SET balance_charge_status = 'processing', balance_charge_attempts = COALESCE(balance_charge_attempts,0) + 1, balance_charge_error = NULL
     WHERE id = ? AND (balance_charge_status IS NULL OR balance_charge_status IN ('failed','requires_action','needs_payment'))`
  ).run(projectId);
  if (claim.changes !== 1) return { status: 'skipped', reason: 'already_in_progress' };
  const attempt = Number((await db.prepare('SELECT balance_charge_attempts a FROM projects WHERE id = ?').get(projectId)).a);

  const client = stripe.getClient();
  // A balance intent left open from the portal would double-charge: cancel it first.
  const pend = await db.prepare(`SELECT id, provider_ref FROM payments WHERE project_id = ? AND kind = 'final' AND provider = 'stripe' AND status = 'pending'`).all(projectId);
  for (const row of pend) {
    try { await client.paymentIntents.cancel(row.provider_ref); } catch (e) { /* already gone */ }
    await db.prepare(`UPDATE payments SET status = 'failed', notes = COALESCE(notes,'') || ' | superseded by the automatic balance charge' WHERE id = ?`).run(row.id);
  }

  let pi = null, failure = null;
  try {
    pi = await client.paymentIntents.create({
      amount: balance, currency: 'usd',
      customer: auth.stripe_customer_id, payment_method: auth.payment_method_id,
      off_session: true, confirm: true,
      description: `Helpman — balance for project #${projectId}`,
      metadata: { project_id: String(projectId), kind: 'final', trigger },
    }, { idempotencyKey: `balance-${projectId}-${attempt}` });
  } catch (e) {
    failure = e;
    pi = e && e.raw && e.raw.payment_intent ? e.raw.payment_intent : null;
  }
  if (pi && pi.id) {
    await db.prepare(
      `INSERT INTO payments (project_id, kind, amount_cents, status, provider, provider_ref, notes) VALUES (?,?,?,'pending','stripe',?,?)`
    ).run(projectId, 'final', balance, pi.id, `Automatic balance charge (${trigger}) to the saved card`);
  }
  if (!failure && pi && pi.status === 'succeeded') {
    await stripe.applySucceededIntent(pi);
    return { status: 'paid', amount_cents: balance, payment_intent_id: pi.id };
  }
  if (!failure && pi && pi.status === 'processing') {
    await db.prepare(`UPDATE projects SET balance_charge_status = 'processing' WHERE id = ?`).run(projectId);
    return { status: 'processing', amount_cents: balance, payment_intent_id: pi.id };
  }
  // Authentication needed, declined, or any other refusal: the customer pays from the portal.
  const code = failure ? (failure.code || failure.type || 'error') : (pi && pi.status) || 'error';
  const needsAction = code === 'authentication_required' || (pi && pi.status === 'requires_action');
  const status = needsAction ? 'requires_action' : 'failed';
  const msg = String((failure && failure.message) || `Charge not completed (${code}).`).slice(0, 200);
  if (pi && pi.id) {
    await db.prepare(`UPDATE payments SET status = 'failed', notes = COALESCE(notes,'') || ? WHERE provider = 'stripe' AND provider_ref = ? AND status = 'pending'`)
      .run(` | ${code}`, pi.id);
  }
  await db.prepare(`UPDATE projects SET balance_charge_status = ?, balance_charge_error = ? WHERE id = ?`).run(status, msg, projectId);
  await require('./audit').auditLog(actorId, 'payment.balance_charge_failed', 'projects', projectId, `${code}: ${msg}`);
  await notifyCustomer(projectId, `Action needed: complete your payment — project #${projectId}`, 'We could not charge your card',
    needsAction ? 'Your bank asks you to confirm this payment. Please pay the balance from your portal:' : 'Your card was not charged. Please pay the balance from your portal with the same or another card:',
    [['Project', `#${projectId}`], ['Balance', money(balance)]], 'Pay my balance');
  await notifyAdmins(`Balance charge failed — project #${projectId}`, 'The automatic charge of the balance did not go through. The customer was asked to pay from the portal; it also shows in Collections.',
    [['Project', `#${projectId}`], ['Balance', money(balance)], ['Reason', code]]);
  return { status, reason: code, amount_cents: balance };
}

// Called (idempotently) when a balance/final charge is confirmed paid.
async function onBalancePaid(projectId) {
  if (await balanceCents(projectId) < 100) {
    await db.prepare(`UPDATE projects SET balance_charge_status = 'paid', balance_charge_error = NULL WHERE id = ?`).run(projectId);
    await require('./visit').sendReceipt(projectId).catch(() => {});
  }
  // Payable due date counts from FULL payment (the hold protects the customer).
  const holdDays = await settings.get('payout_hold_days');
  const due = new Date(Date.now() + holdDays * 86400000).toISOString();
  await db.prepare(`UPDATE contractor_payables SET due_at = ? WHERE project_id = ? AND status IN ('pending','approved')`).run(due, projectId);
  if (holdDays === 0) await runPayouts({ projectId }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Change orders move the price AND the pro's payout (once, on approval)
// ---------------------------------------------------------------------------
async function applyChangeOrder(changeOrderId) {
  const co = await db.prepare('SELECT * FROM change_orders WHERE id = ?').get(changeOrderId);
  if (!co || co.status !== 'approved') return null;
  const claim = await db.prepare(`UPDATE change_orders SET applied_at = CURRENT_TIMESTAMP WHERE id = ? AND applied_at IS NULL`).run(co.id);
  if (claim.changes !== 1) return null; // already applied
  const price = Number(co.price_delta_cents || 0), cost = Number(co.contractor_cost_delta_cents || 0);
  await db.prepare(
    `UPDATE projects SET customer_price_cents = MAX(0, customer_price_cents + ?), contractor_cost_cents = MAX(0, contractor_cost_cents + ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      .replace(/MAX\(/g, db._isPg ? 'GREATEST(' : 'MAX(')
  ).run(price, cost, co.project_id);
  if (cost) {
    await db.prepare(`UPDATE contractor_payables SET payable_cents = MAX(0, payable_cents + ?) WHERE project_id = ? AND status IN ('pending','approved')`
      .replace(/MAX\(/g, db._isPg ? 'GREATEST(' : 'MAX(')).run(cost, co.project_id);
  }
  await require('./audit').auditLog(null, 'change_order.applied', 'change_orders', co.id,
    `Project #${co.project_id}: customer price ${price >= 0 ? '+' : ''}${money(price)}, pro payout ${cost >= 0 ? '+' : ''}${money(cost)}`);
  return { price_delta_cents: price, contractor_cost_delta_cents: cost };
}

// ---------------------------------------------------------------------------
// Pro payouts through Stripe Connect
// ---------------------------------------------------------------------------
async function payoutBlockers(pb, { ignoreHold = false } = {}) {
  const out = [];
  const stripe = stripeSvc();
  if (!stripe.isEnabled()) out.push('stripe_off');
  const p = await db.prepare('SELECT stage FROM projects WHERE id = ?').get(pb.project_id);
  if (!p || p.stage !== 'completed') out.push('not_completed');
  if (await balanceCents(pb.project_id) >= 100) out.push('customer_balance_due');
  const hold = await moneyHold(pb.project_id);
  if (hold) out.push(hold);
  const c = await db.prepare('SELECT stripe_account_id, payouts_enabled, provider_type FROM contractors WHERE id = ?').get(pb.contractor_id);
  if (!c || c.provider_type === 'employee') out.push('payroll');
  else if (!c.stripe_account_id || !c.payouts_enabled) out.push('payout_account_not_ready');
  if (!ignoreHold && pb.due_at && new Date(pb.due_at).getTime() > Date.now()) out.push('hold_period');
  if (!(Number(pb.payable_cents) > 0)) out.push('nothing_to_pay');
  return out;
}

// The Stripe charge the money came from (lets Stripe tie the transfer to it).
async function sourceChargeFor(projectId) {
  const pay = await db.prepare(
    `SELECT provider_ref FROM payments WHERE project_id = ? AND provider = 'stripe' AND status = 'paid' AND kind = 'final' ORDER BY id DESC LIMIT 1`
  ).get(projectId);
  if (!pay) return null;
  try {
    const pi = await stripeSvc().getClient().paymentIntents.retrieve(pay.provider_ref);
    const ch = pi && pi.latest_charge;
    return typeof ch === 'string' ? ch : ch && ch.id ? ch.id : null;
  } catch (e) { return null; }
}

async function transferPayable(pb, { actorId = null, ignoreHold = false } = {}) {
  const blockers = await payoutBlockers(pb, { ignoreHold });
  if (blockers.length) return { paid: false, blockers };
  // Atomic claim: mark as being paid by Stripe; a second worker finds it taken.
  const claim = await db.prepare(
    `UPDATE contractor_payables SET status = 'paid', paid_at = CURRENT_TIMESTAMP, paid_method = 'stripe', paid_by = ?
     WHERE id = ? AND status IN ('pending','approved') AND transfer_id IS NULL`
  ).run(actorId, pb.id);
  if (claim.changes !== 1) return { paid: false, blockers: ['already_paid'] };
  const c = await db.prepare('SELECT stripe_account_id FROM contractors WHERE id = ?').get(pb.contractor_id);
  const source = await sourceChargeFor(pb.project_id);
  let tr;
  try {
    tr = await stripeSvc().getClient().transfers.create({
      amount: Number(pb.payable_cents), currency: 'usd', destination: c.stripe_account_id,
      transfer_group: `project_${pb.project_id}`,
      ...(source ? { source_transaction: source } : {}),
      description: `Helpman payout — project #${pb.project_id}`,
      metadata: { project_id: String(pb.project_id), payable_id: String(pb.id) },
    }, { idempotencyKey: `payout-${pb.id}-${pb.payable_cents}` });
  } catch (e) {
    // Undo the claim: nothing left Helpman.
    await db.prepare(`UPDATE contractor_payables SET status = 'approved', paid_at = NULL, paid_method = NULL, paid_by = NULL, notes = ? WHERE id = ? AND transfer_id IS NULL`)
      .run(`Stripe transfer failed: ${String(e.message).slice(0, 180)}`, pb.id);
    await notifyAdmins(`Payout failed — project #${pb.project_id}`, 'The automatic transfer to the pro failed and will be retried. Check the Stripe balance and the pro\'s payout account.', [['Project', `#${pb.project_id}`], ['Amount', money(pb.payable_cents)]]);
    return { paid: false, blockers: ['transfer_failed'], error: String(e.message).slice(0, 180) };
  }
  await db.prepare(`UPDATE contractor_payables SET transfer_id = ?, paid_reference = ? WHERE id = ?`).run(tr.id, tr.id, pb.id);
  await require('./audit').auditLog(actorId, 'payable.paid_stripe', 'contractor_payables', pb.id, `${money(pb.payable_cents)} → ${c.stripe_account_id} (${tr.id})`);
  const cu = await db.prepare('SELECT u.name, u.email FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(pb.contractor_id);
  if (cu && cu.email) {
    const { notify, shell } = require('./notify');
    await notify({
      to: cu.email,
      subject: `Payout sent — project #${pb.project_id} (${money(pb.payable_cents)})`,
      html: shell('Your payout is on its way', `Hi ${String(cu.name || '').split(' ')[0]}, Helpman sent your payment to your Stripe payout account. Stripe deposits it in your bank on its usual schedule.`, [
        ['Project', `#${pb.project_id}`], ['Amount', money(pb.payable_cents)], ['Reference', tr.id],
      ]),
    }).catch(() => {});
  }
  return { paid: true, transfer_id: tr.id };
}

// Background job (hourly) + right after full payment when the hold is 0 days.
async function runPayouts({ projectId = null } = {}) {
  if (!stripeSvc().isEnabled()) return { paid: 0, skipped: 0 };
  const rows = await db.prepare(
    `SELECT pb.* FROM contractor_payables pb WHERE pb.status IN ('pending','approved') AND pb.transfer_id IS NULL ${projectId ? 'AND pb.project_id = ?' : ''} ORDER BY pb.id LIMIT 100`
  ).all(...(projectId ? [projectId] : []));
  let paid = 0, skipped = 0;
  for (const pb of rows) {
    const r = await transferPayable(pb).catch(() => ({ paid: false }));
    if (r.paid) paid++; else skipped++;
  }
  return { paid, skipped };
}

// A chargeback or a refund after the pro was paid: take back up to `amountCents`.
async function reversePayout(projectId, amountCents, reason) {
  const pb = await db.prepare(`SELECT * FROM contractor_payables WHERE project_id = ? AND transfer_id IS NOT NULL`).get(projectId);
  if (!pb) return null;
  const left = Number(pb.payable_cents) - Number(pb.reversed_cents || 0);
  const amount = Math.min(left, Number(amountCents));
  if (amount < 1) return null;
  const rev = await stripeSvc().getClient().transfers.createReversal(pb.transfer_id, {
    amount, metadata: { project_id: String(projectId), reason: String(reason || '').slice(0, 200) },
  }, { idempotencyKey: `reversal-${pb.id}-${reason}-${amount}` });
  await db.prepare(`UPDATE contractor_payables SET reversed_cents = COALESCE(reversed_cents,0) + ?, notes = COALESCE(notes,'') || ? WHERE id = ?`)
    .run(amount, ` | reversed ${money(amount)} (${reason})`, pb.id);
  await require('./audit').auditLog(null, 'payable.reversed', 'contractor_payables', pb.id, `${money(amount)}: ${reason}`);
  return { reversal_id: rev.id, amount_cents: amount };
}

// ---------------------------------------------------------------------------
// Cancellation and no-show
// ---------------------------------------------------------------------------
const CANCEL_KINDS = ['customer_cancel', 'customer_no_show', 'contractor_no_show', 'staff'];

async function cancellationQuote(project, kind) {
  const deposit = await depositPaidCents(project.id);
  const refundable = Math.min(deposit, await netPaidCents(project.id));
  const freeHours = await settings.get('cancel_free_hours');
  let feePct = 0, rule = 'full_refund';
  // SQLite gives text ("2026-11-20" or "2026-11-20 10:00:00"), PostgreSQL a Date.
  const raw = project.scheduled_start;
  const start = !raw ? null : raw instanceof Date ? raw
    : new Date(String(raw).length <= 10 ? `${raw}T09:00:00` : String(raw).replace(' ', 'T'));
  const hoursBefore = start && !isNaN(start) ? (start.getTime() - Date.now()) / 3600000 : null;
  if (kind === 'customer_cancel') {
    if (hoursBefore !== null && hoursBefore < freeHours) { feePct = await settings.get('late_cancel_fee_pct'); rule = 'late_cancellation'; }
    else rule = 'free_cancellation';
  } else if (kind === 'customer_no_show') {
    feePct = await settings.get('customer_no_show_fee_pct'); rule = 'customer_no_show';
  } else {
    rule = kind === 'contractor_no_show' ? 'pro_no_show' : 'helpman_decision';
  }
  const fee = Math.min(refundable, Math.round(deposit * feePct / 100));
  return {
    kind, rule, deposit_paid_cents: deposit, fee_pct: feePct, fee_cents: fee, refund_cents: Math.max(0, refundable - fee),
    free_hours: freeHours, hours_before_visit: hoursBefore === null ? null : Math.round(hoursBefore),
    pending_owner_values: (await settings.all()).some(s => s.pending_owner),
  };
}

async function cancelProject(project, { kind, actorId, reason }) {
  if (!CANCEL_KINDS.includes(kind)) throw Object.assign(new Error('Unknown cancellation kind.'), { statusCode: 422 });
  // Atomic: only one cancellation, and never once the work is under way.
  const claim = await db.prepare(
    `UPDATE projects SET stage = 'cancelled', cancellation_kind = ?, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND stage IN ('assigned','scheduled')`
  ).run(kind, project.id);
  if (claim.changes !== 1) throw Object.assign(new Error('This project can no longer be cancelled here (work started or already closed). Contact Helpman support.'), { statusCode: 409 });
  const q = await cancellationQuote(project, kind);
  let refund = { via_stripe_cents: 0, manual_cents: 0 };
  if (q.refund_cents > 0) {
    try {
      refund = await require('./disputes').executeRefund({ projectId: project.id, amountCents: q.refund_cents, note: `Cancellation (${q.rule}) — refund` });
    } catch (e) {
      // Payment service failed: undo the cancellation so it can be retried. Refunds
      // already sent are in the ledger, so the retry only sends what is missing.
      await db.prepare(`UPDATE projects SET stage = ?, cancellation_kind = NULL, cancelled_at = NULL WHERE id = ? AND stage = 'cancelled'`).run(project.stage, project.id);
      throw e;
    }
  }
  await db.prepare(`UPDATE job_requests SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(project.job_request_id);
  await require('./events').stage(project.id, project.stage, 'cancelled', actorId).catch(() => {});
  await require('./audit').auditLog(actorId, 'project.cancelled', 'projects', project.id,
    `${q.rule}: refund ${money(q.refund_cents)}, kept ${money(q.fee_cents)}${reason ? ' — ' + String(reason).slice(0, 200) : ''}`);
  await notifyCustomer(project.id, `Your project #${project.id} was cancelled`, 'Cancellation confirmed',
    q.refund_cents > 0 ? `We refunded ${money(q.refund_cents)} of your deposit${q.fee_cents ? ` (${money(q.fee_cents)} kept under the cancellation policy)` : ''}. Card refunds take 5–10 business days.`
      : (q.deposit_paid_cents ? `Under the cancellation policy the deposit (${money(q.fee_cents)}) is not refundable.` : 'No payment was taken.'),
    [['Project', `#${project.id}`]], null);
  if (project.contractor_id) {
    const cu = await db.prepare('SELECT u.name, u.email FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(project.contractor_id);
    if (cu && cu.email) {
      const { notify, shell } = require('./notify');
      await notify({ to: cu.email, subject: `Job #${project.id} cancelled`,
        html: shell('This job was cancelled', `Hi ${String(cu.name || '').split(' ')[0]}, Helpman cancelled job #${project.id}. You do not need to go. Questions? Message support from your portal.`, [['Job', `#${project.id}`]]) }).catch(() => {});
    }
  }
  return { ...q, refund };
}

// Pro did not show up and the customer prefers a new pro: release and re-dispatch (no money moves).
async function releaseForReschedule(project, { actorId }) {
  const claim = await db.prepare(
    `UPDATE projects SET contractor_id = NULL, contractor_status = NULL, stage = 'assigned', schedule_status = 'pending', schedule_token = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND stage IN ('assigned','scheduled')`
  ).run(project.id);
  if (claim.changes !== 1) throw Object.assign(new Error('This project cannot be re-dispatched now.'), { statusCode: 409 });
  await require('./audit').auditLog(actorId, 'project.redispatch_pro_no_show', 'projects', project.id, `Contractor #${project.contractor_id} did not show; customer chose a new pro`);
  await notifyCustomer(project.id, `We're assigning you a new pro — project #${project.id}`, 'Sorry about the missed visit',
    'Your pro could not make it. We are assigning a new professional with priority and will confirm the new day and time by email. Your deposit stays on your project.', [['Project', `#${project.id}`]], null);
  await notifyAdmins(`Re-dispatch with priority — project #${project.id}`, 'The pro did not show up; the customer chose a new pro. Assign one with priority.', [['Project', `#${project.id}`]]);
  return { redispatched: true };
}

module.exports = {
  CARD_CONSENT_VERSION, CARD_CONSENT_TEXT, CANCEL_KINDS,
  netPaidCents, balanceCents, depositPaidCents, depositPct, depositFor, moneyHold, openChargebackFor,
  ensureCustomer, recordAuthorization, rememberPaymentMethod, authorizationFor,
  chargeBalance, onBalancePaid, applyChangeOrder,
  payoutBlockers, transferPayable, runPayouts, reversePayout,
  cancellationQuote, cancelProject, releaseForReschedule,
};
