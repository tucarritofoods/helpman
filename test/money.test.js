// Helpman — Corte 2 tests: the owner's money rule, end to end, against a fake
// Stripe (no network). 30 % deposit with the card saved under the customer's
// authorization → the rest charged automatically when the customer confirms →
// change orders move price and payout → automatic payout to the pro's Stripe
// Connect account, frozen by disputes/chargebacks, never twice → cancellation and
// no-show rules → no Stripe = deposit stays pending.
//
// Own throwaway SQLite DB + server on :3463.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const TEST_DB = '/tmp/test-money.db';
const BASE = 'http://localhost:3463';
for (const f of [TEST_DB, TEST_DB + '-shm', TEST_DB + '-wal']) { try { fs.unlinkSync(f); } catch (e) { /* fresh */ } }
process.env.DB_PATH = TEST_DB;
process.env.PORT = '3463';
process.env.JWT_SECRET = 'money-test-secret-0123456789abcdef0123';
process.env.AUTH_RATE_LIMIT_MAX = '5000';
process.env.INTAKE_RATE_LIMIT_MAX = '5000';
delete process.env.DEV_AUTORECORD_DEPOSIT;
delete process.env.DATABASE_URL;
const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_PUBLISHABLE_KEY: 'pk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect' };
Object.assign(process.env, STRIPE_ENV);

const db = require('../src/db');
require('../server');
after(async () => { const s = await require('../server').listening; if (s) { s.closeAllConnections && s.closeAllConnections(); s.close(); } });

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// ---------------------------------------------------------------- fake Stripe
let SEQ = 0;
function makeFake() {
  const intents = new Map(), refunds = [], transferLog = [], reversals = [], accountMap = new Map(), customerLog = [];
  const state = { offSession: 'succeed' }; // 'succeed' | 'auth' | 'decline'
  const refunded = (id) => refunds.filter(r => r.payment_intent === id).reduce((a, r) => a + r.amount, 0);
  const cardError = (code, pi) => Object.assign(new Error(code === 'authentication_required' ? 'This payment requires authentication.' : 'Your card was declined.'), { type: 'StripeCardError', code, raw: { payment_intent: pi } });
  const fake = {
    state, intents, refundLog: refunds, transferLog, reversals, accountMap, customerLog,
    customers: { create: async (p, o) => { const c = { id: `cus_${++SEQ}`, email: p.email, idem: o && o.idempotencyKey }; customerLog.push(c); return c; } },
    paymentIntents: {
      create: async (p, o) => {
        const id = `pi_${++SEQ}`;
        const pi = { id, client_secret: `${id}_secret`, amount: p.amount, amount_received: 0, metadata: p.metadata, customer: p.customer || null,
          payment_method: p.payment_method || null, setup_future_usage: p.setup_future_usage || null, off_session: !!p.off_session,
          status: 'requires_payment_method', idem: o && o.idempotencyKey, latest_charge: null };
        intents.set(id, pi);
        if (p.off_session && p.confirm) {
          if (state.offSession === 'succeed') { pi.status = 'succeeded'; pi.amount_received = p.amount; pi.latest_charge = `ch_${++SEQ}`; }
          else if (state.offSession === 'auth') { pi.status = 'requires_payment_method'; throw cardError('authentication_required', { ...pi }); }
          else { pi.status = 'requires_payment_method'; throw cardError('card_declined', { ...pi }); }
        }
        return { ...pi };
      },
      cancel: async (id) => { intents.get(id).status = 'canceled'; return intents.get(id); },
      retrieve: async (id) => { const pi = intents.get(id); return { ...pi, latest_charge: { id: pi.latest_charge || `ch_for_${id}`, amount: pi.amount_received, amount_refunded: refunded(id) } }; },
    },
    refunds: { create: async ({ payment_intent, amount }) => {
      const pi = intents.get(payment_intent);
      if (amount > pi.amount_received - refunded(payment_intent)) throw new Error('over-refund');
      const r = { id: `re_${++SEQ}`, payment_intent, amount }; refunds.push(r); return r;
    } },
    accounts: {
      create: async (p, o) => { const a = { id: `acct_${++SEQ}`, email: p.email, payouts_enabled: false, details_submitted: false, requirements: { currently_due: ['external_account'] }, idem: o && o.idempotencyKey }; accountMap.set(a.id, a); return a; },
      retrieve: async (id) => ({ ...accountMap.get(id) }),
    },
    accountLinks: { create: async (p) => ({ url: `https://connect.stripe.test/setup/${p.account}`, expires_at: 1 }) },
    transfers: {
      create: async (p, o) => { const t = { id: `tr_${++SEQ}`, ...p, idem: o && o.idempotencyKey }; transferLog.push(t); return t; },
      createReversal: async (id, p) => { const r = { id: `trr_${++SEQ}`, transfer: id, amount: p.amount }; reversals.push(r); return r; },
    },
    balance: { retrieve: async () => ({ livemode: false }) },
    webhooks: { constructEvent: (raw, sig, secret) => { if (sig !== `valid-${secret}`) throw new Error('bad signature'); return JSON.parse(Buffer.from(raw).toString('utf8')); } },
    // helper: the customer pays an intent in the browser
    pay(id, pm = 'pm_card_visa') { const pi = intents.get(id); pi.amount_received = pi.amount; pi.status = 'succeeded'; pi.payment_method = pm; pi.latest_charge = `ch_${++SEQ}`; return pi; },
  };
  return fake;
}
const fake = makeFake();

// ---------------------------------------------------------------- helpers
async function api(method, p, body, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, data };
}
async function hook(type, obj, { connect = false, sig } = {}) {
  const path = connect ? '/api/payments/connect-webhook' : '/api/payments/webhook';
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig || `valid-${connect ? 'whsec_connect' : 'whsec_fake'}` },
    body: JSON.stringify({ id: 'evt_' + (++SEQ), type, data: { object: obj } }) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const row = (sql, ...a) => db.prepare(sql).get(...a);
const rows = (sql, ...a) => db.prepare(sql).all(...a);

let owner, support, cust, custId, cont, contractorId, jobId;

before(async () => {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) { /* retry */ } await new Promise(r => setTimeout(r, 100)); }
  require('../src/services/stripe')._setClientForTests(fake);
  const mk = async (name, email, staff) => db.prepare("INSERT INTO users (name, email, phone, password_hash, role, email_verified, staff_role) VALUES (?,?,?,?,?,1,?)")
    .run(name, email, '', bcrypt.hashSync('Admin123!', 10), 'admin', staff);
  await mk('Owner', 'owner.m@test.local', null);
  await mk('Support', 'support.m@test.local', 'support');
  owner = (await api('POST', '/api/auth/login', { email: 'owner.m@test.local', password: 'Admin123!' })).data.token;
  support = (await api('POST', '/api/auth/login', { email: 'support.m@test.local', password: 'Admin123!' })).data.token;

  const c = await api('POST', '/api/auth/signup/customer', { name: 'Marta Ruiz', email: 'marta.m@test.local', phone: '707-555-0111', password: 'Customer123!' });
  custId = c.data.user.id;
  await db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(custId);
  cust = (await api('POST', '/api/auth/login', { email: 'marta.m@test.local', password: 'Customer123!' })).data.token;

  await api('POST', '/api/auth/signup/contractor', { name: 'Luis Perez', email: 'luis.m@test.local', phone: '707-555-0122', password: 'Contractor123!', legal_name: 'Luis Perez', city: 'Vallejo' });
  cont = (await api('POST', '/api/auth/login', { email: 'luis.m@test.local', password: 'Contractor123!' })).data.token;
  contractorId = (await row('SELECT c.id FROM contractors c JOIN users u ON u.id = c.user_id WHERE u.email = ?', 'luis.m@test.local')).id;
  await api('PATCH', `/api/contractors/${contractorId}/verify`, { license_verified: true, insurance_verified: true, background_check: 'passed', status: 'active' }, owner);
  const pf = new FormData(); pf.append('photo', new Blob([PNG_1PX], { type: 'image/png' }), 'me.png');
  assert.equal((await api('POST', '/api/contractors/me/photo', pf, cont)).status, 201);

  const j = await api('POST', '/api/jobs', { name: 'Marta Ruiz', phone: '707-555-0111', email: 'marta.m@test.local', address: '10 Oak St', city: 'Vallejo', zip: '94590', service_type: 'painting', description: 'Paint two bedrooms.' }, cust);
  jobId = j.data.id;
});

async function quoteAccepted(price, cost) {
  const q = await api('POST', '/api/quotes', { job_request_id: jobId, customer_price_cents: price, contractor_cost_cents: cost, deposit_pct: 10 }, owner);
  assert.equal(q.status, 201, JSON.stringify(q.data));
  await api('POST', `/api/quotes/${q.data.id}/send`, {}, owner);
  const r = await api('POST', `/api/quotes/${q.data.id}/respond`, { accept: true, terms_accepted: true }, cust);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { pid: r.data.project_id, quote: q.data, accept: r.data };
}
async function payDeposit(pid) {
  const i = await api('POST', '/api/payments/deposit-intent', { project_id: pid, authorize_balance: true }, cust);
  assert.equal(i.status, 201, JSON.stringify(i.data));
  const pi = fake.pay(i.data.payment_intent_id);
  const h = await hook('payment_intent.succeeded', { id: pi.id, amount: pi.amount, amount_received: pi.amount_received, metadata: pi.metadata, payment_method: pi.payment_method, customer: pi.customer });
  assert.equal(h.status, 200, JSON.stringify(h.data));
  return i.data;
}
async function workDone(pid) {
  assert.equal((await api('POST', `/api/projects/${pid}/assign`, { contractor_id: contractorId }, owner)).status, 200);
  assert.equal((await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: true, terms_accepted: true }, cont)).status, 200);
  assert.equal((await api('PATCH', `/api/projects/${pid}/stage`, { stage: 'in_progress' }, cont)).status, 200);
  for (const kind of ['completion', 'signoff']) {
    const f = new FormData(); f.append('kind', kind); f.append('photos', new Blob([PNG_1PX], { type: 'image/png' }), `${kind}.png`);
    assert.equal((await api('POST', `/api/projects/${pid}/photos`, f, cont)).status, 201);
  }
  const ms = (await api('GET', `/api/projects/${pid}`, undefined, owner)).data.milestones;
  for (const m of ms) {
    assert.equal((await api('POST', `/api/projects/${pid}/milestones/${m.id}/complete`, {}, cont)).status, 200);
    assert.equal((await api('POST', `/api/projects/${pid}/milestones/${m.id}/approve`, { approved: true }, cust)).status, 200);
  }
}
const signOff = (pid) => api('POST', `/api/projects/${pid}/sign-off`, { signer_name: 'Marta Ruiz', signature: 'data:image/png;base64,' + 'A'.repeat(1200), checklist: { work_complete: true, site_clean: true } }, cust);
const balance = (pid) => require('../src/services/billing').balanceCents(pid);

// ---------------------------------------------------------------- tests
test('C2: business rules — one global deposit %, owner-only changes, validated and audited', async () => {
  const g = await api('GET', '/api/admin/settings', undefined, support);
  assert.equal(g.status, 200);
  const dep = g.data.rules.find(r => r.key === 'deposit_pct');
  assert.equal(dep.value, 30, "the owner's 30 % is the default");
  assert.ok(g.data.rules.find(r => r.key === 'late_cancel_fee_pct').pending_owner, 'legal values are flagged until the owner sets them');
  assert.equal((await api('PUT', '/api/admin/settings', { values: { deposit_pct: 40 } }, support)).status, 403, 'support cannot change money rules');
  assert.equal((await api('PUT', '/api/admin/settings', { values: { deposit_pct: 0 } }, owner)).status, 422);
  assert.equal((await api('PUT', '/api/admin/settings', { values: { nope: 1 } }, owner)).status, 422);
  assert.equal((await api('PUT', '/api/admin/settings', { values: { deposit_pct: 40 } }, owner)).status, 200);
  const q = await api('POST', '/api/quotes', { job_request_id: jobId, customer_price_cents: 100000, contractor_cost_cents: 60000, deposit_pct: 5 }, owner);
  assert.equal(q.status, 201);
  const stored = await row('SELECT deposit_pct, deposit_cents FROM quotes WHERE id = (SELECT MAX(id) FROM quotes)');
  assert.equal(stored.deposit_pct, 40, 'a per-quote % is ignored');
  assert.equal(stored.deposit_cents, 40000);
  assert.equal((await api('PUT', '/api/admin/settings', { values: { deposit_pct: 30 } }, owner)).status, 200);
  assert.ok(await row("SELECT id FROM admin_audit WHERE action = 'settings.updated'"), 'changes are audited');
});

test('C2: without Stripe the deposit stays PENDING until finance records the money', async () => {
  const keep = { ...STRIPE_ENV };
  for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
  try {
    const { pid, accept } = await quoteAccepted(50000, 30000);
    assert.equal(accept.deposit_pending, true);
    assert.equal(await row("SELECT id FROM payments WHERE project_id = ? AND kind = 'deposit'", pid), undefined, 'nothing is marked paid by itself');
    const as = await api('POST', `/api/projects/${pid}/assign`, { contractor_id: contractorId }, owner);
    assert.equal(as.status, 409, 'no pro is offered work before the deposit is in');
    assert.equal((await api('POST', '/api/payments', { project_id: pid, kind: 'deposit', amount_cents: 15000, notes: 'Zelle ref 123' }, owner)).status, 201);
    assert.equal((await api('POST', `/api/projects/${pid}/assign`, { contractor_id: contractorId }, owner)).status, 200);
  } finally { Object.assign(process.env, keep); }
});

test('C2: 30/70 — the deposit card is saved with authorization; confirming the work charges the rest automatically', async () => {
  const { pid } = await quoteAccepted(100000, 60000);
  const noAuth = await api('POST', '/api/payments/deposit-intent', { project_id: pid }, cust);
  assert.equal(noAuth.status, 422);
  assert.equal(noAuth.data.code, 'CARD_AUTHORIZATION_REQUIRED');
  const terms = await api('GET', '/api/payments/card-authorization');
  assert.match(terms.data.text, /charge it for the remaining balance/);
  const dep = await payDeposit(pid);
  const pi = fake.intents.get(dep.payment_intent_id);
  assert.equal(pi.amount, 30000, '30 % of the agreed price');
  assert.equal(pi.setup_future_usage, 'off_session', 'the card is saved for the balance');
  assert.ok(pi.customer && pi.customer.startsWith('cus_'));
  const auth = await row('SELECT * FROM payment_authorizations WHERE project_id = ?', pid);
  assert.equal(auth.payment_method_id, 'pm_card_visa');
  assert.ok(auth.consent_text_version);

  await workDone(pid);
  const s = await signOff(pid);
  assert.equal(s.status, 201);
  assert.equal(s.data.balance_charge.status, 'paid');
  assert.equal(s.data.balance_charge.amount_cents, 70000, 'the remaining 70 %');
  const charge = [...fake.intents.values()].find(x => x.off_session);
  assert.equal(charge.payment_method, 'pm_card_visa');
  assert.equal(charge.customer, pi.customer, 'same customer, same card');
  assert.equal(await balance(pid), 0);
  assert.equal((await row('SELECT balance_charge_status s FROM projects WHERE id = ?', pid)).s, 'paid');
  assert.equal(fake.customerLog.length, 1, 'one Stripe customer per person, reused');

  // The pro never sees the customer's payment state.
  const asPro = JSON.stringify((await api('GET', `/api/projects/${pid}`, undefined, cont)).data);
  assert.ok(!/balance_charge|amount_cents|customer_price/.test(asPro));
});

test('C2: change orders move the price AND the pro payout once; the customer never sees the payout change', async () => {
  const { pid } = await quoteAccepted(80000, 50000);
  await payDeposit(pid);
  assert.equal((await api('POST', `/api/projects/${pid}/assign`, { contractor_id: contractorId }, owner)).status, 200);
  assert.equal((await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: true, terms_accepted: true }, cont)).status, 200);
  const co = await api('POST', `/api/customer-experience/projects/${pid}/change-orders`, { title: 'Ceiling too', description: 'Also paint the ceiling.', contractor_cost_delta_cents: 6000 }, cont);
  assert.equal(co.status, 201);
  assert.equal(co.data.contractor_cost_delta_cents, 6000, 'the pro sees their own payout change');
  assert.equal((await api('POST', `/api/customer-experience/projects/${pid}/change-orders/${co.data.id}/send`, { price_delta_cents: 10000 }, owner)).status, 200);
  const seen = await api('GET', `/api/customer-experience/projects/${pid}/change-orders`, undefined, cust);
  assert.equal(seen.data[0].price_delta_cents, 10000);
  assert.equal(seen.data[0].contractor_cost_delta_cents, undefined, 'the customer never sees the payout change');
  assert.equal((await api('POST', `/api/customer-experience/projects/${pid}/change-orders/${co.data.id}/respond`, { approved: true }, cust)).status, 200);
  const p = await row('SELECT customer_price_cents, contractor_cost_cents FROM projects WHERE id = ?', pid);
  assert.equal(p.customer_price_cents, 90000);
  assert.equal(p.contractor_cost_cents, 56000);
  assert.equal(await require('../src/services/billing').applyChangeOrder(co.data.id), null, 'applied once');
  assert.equal(await balance(pid), 90000 - 24000, 'the balance includes the approved change');
});

test('C2: the bank asks for authentication — the customer gets a pay link, finance can retry, nothing is charged twice', async () => {
  const { pid } = await quoteAccepted(60000, 35000);
  await payDeposit(pid);
  await workDone(pid);
  fake.state.offSession = 'auth';
  const s = await signOff(pid);
  assert.equal(s.status, 201, 'the signature stands');
  assert.equal(s.data.balance_charge.status, 'requires_action');
  assert.equal(await balance(pid), 42000);
  assert.ok(await row("SELECT id FROM email_log WHERE to_email = 'marta.m@test.local' AND subject LIKE 'Action needed: complete your payment%'"));
  assert.ok(await row(`SELECT id FROM payments WHERE project_id = ? AND kind = 'final' AND status = 'failed'`, pid));
  assert.equal((await api('POST', `/api/payments/projects/${pid}/charge-balance`, {}, support)).status, 403, 'finance only');
  fake.state.offSession = 'succeed';
  const r = await api('POST', `/api/payments/projects/${pid}/charge-balance`, {}, owner);
  assert.equal(r.data.status, 'paid');
  const intentsBefore = fake.intents.size;
  const again = await api('POST', `/api/payments/projects/${pid}/charge-balance`, {}, owner);
  assert.ok(['nothing_due', 'skipped'].includes(again.data.status), 'paid: nothing more to charge');
  assert.equal(fake.intents.size, intentsBefore, 'no second charge attempted');
  assert.equal(await balance(pid), 0);
});

test('C2: payouts — the pro connects Stripe; the money goes out automatically from what was collected, once', async () => {
  const pa = await api('GET', '/api/contractor-ops/payout-account', undefined, cont);
  assert.equal(pa.data.connected, false);
  const link = await api('POST', '/api/contractor-ops/payout-account/link', {}, cont);
  assert.equal(link.status, 200);
  assert.match(link.data.url, /connect\.stripe\.test/);
  const acct = (await row('SELECT stripe_account_id a FROM contractors WHERE id = ?', contractorId)).a;
  assert.ok(acct);
  await api('POST', '/api/contractor-ops/payout-account/link', {}, cont);
  assert.equal(fake.accountMap.size, 1, 'one Connect account per pro');
  assert.equal((await hook('account.updated', { id: acct, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [] } }, { connect: true, sig: 'forged' })).status, 400);
  fake.accountMap.get(acct).payouts_enabled = true;
  assert.equal((await hook('account.updated', { id: acct, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [] } }, { connect: true })).status, 200);
  assert.equal((await api('GET', '/api/contractor-ops/payout-account', undefined, cont)).data.payouts_enabled, true);

  // Blocked while the customer still owes money (manual Stripe payout from the admin).
  const { pid } = await quoteAccepted(70000, 40000);
  await payDeposit(pid);
  await workDone(pid);
  fake.state.offSession = 'decline';
  await signOff(pid);
  fake.state.offSession = 'succeed';
  await db.prepare("UPDATE projects SET stage = 'completed' WHERE id = ?").run(pid);
  await require('../src/services/payables').ensurePayable(await row('SELECT * FROM projects WHERE id = ?', pid));
  const pb = await row('SELECT * FROM contractor_payables WHERE project_id = ?', pid);
  const blocked = await api('POST', `/api/payables/${pb.id}/pay`, { method: 'stripe' }, owner);
  assert.equal(blocked.status, 409);
  assert.ok(blocked.data.blockers.includes('customer_balance_due'));

  // Paid in full, hold set to 0 → the payout goes out on its own.
  await api('PUT', '/api/admin/settings', { values: { payout_hold_days: 0 } }, owner);
  await db.prepare('UPDATE contractor_payables SET due_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), pb.id);
  const before = fake.transferLog.length;
  const r = await api('POST', `/api/payments/projects/${pid}/charge-balance`, {}, owner);
  assert.equal(r.data.status, 'paid');
  assert.equal(fake.transferLog.length, before + 1, 'one transfer');
  const t = fake.transferLog[fake.transferLog.length - 1];
  assert.equal(t.destination, acct);
  assert.equal(t.amount, 40000);
  assert.equal(t.transfer_group, `project_${pid}`);
  assert.ok(t.source_transaction, 'tied to the customer charge');
  const paid = await row('SELECT * FROM contractor_payables WHERE id = ?', pb.id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paid_method, 'stripe');
  assert.equal(paid.transfer_id, t.id);
  await require('../src/services/billing').runPayouts();
  assert.equal(fake.transferLog.length, before + 1, 'never paid twice');
  assert.ok(await row("SELECT id FROM email_log WHERE to_email = 'luis.m@test.local' AND subject LIKE 'Payout sent%'"));

  // A chargeback afterwards: claws the payout back and blocks any further one.
  const final = await row(`SELECT provider_ref FROM payments WHERE project_id = ? AND kind = 'final' AND status = 'paid'`, pid);
  assert.equal((await hook('charge.dispute.created', { id: 'dp_1', charge: 'ch_x', payment_intent: final.provider_ref, amount: 20000, reason: 'fraudulent' })).status, 200);
  await hook('charge.dispute.created', { id: 'dp_1', charge: 'ch_x', payment_intent: final.provider_ref, amount: 20000, reason: 'fraudulent' });
  assert.equal(fake.reversals.length, 1, 'clawed back once');
  assert.equal(fake.reversals[0].amount, 20000);
  assert.equal((await row('SELECT reversed_cents r FROM contractor_payables WHERE id = ?', pb.id)).r, 20000);
  assert.equal((await row("SELECT status FROM chargebacks WHERE stripe_dispute_id = 'dp_1'")).status, 'open');
  assert.equal(await require('../src/services/billing').moneyHold(pid), 'chargeback');
  await hook('charge.dispute.closed', { id: 'dp_1', charge: 'ch_x', payment_intent: final.provider_ref, amount: 20000, status: 'won' });
  assert.equal((await row("SELECT status FROM chargebacks WHERE stripe_dispute_id = 'dp_1'")).status, 'won');
  await api('PUT', '/api/admin/settings', { values: { payout_hold_days: 7 } }, owner);
});

test('C2: a refund made in the Stripe dashboard is added to the ledger once', async () => {
  const { pid } = await quoteAccepted(40000, 25000);
  const dep = await payDeposit(pid);
  const ev = { id: 'ch_r', payment_intent: dep.payment_intent_id, refunds: { data: [{ id: 're_dash_1', amount: 5000, status: 'succeeded' }] } };
  await hook('charge.refunded', ev);
  await hook('charge.refunded', ev);
  const r = await rows(`SELECT * FROM payments WHERE project_id = ? AND kind = 'refund'`, pid);
  assert.equal(r.length, 1);
  assert.equal(r[0].amount_cents, 5000);
});

test('C2: cancellation and no-show follow the owner\'s rules; work in progress cannot be cancelled', async () => {
  const billing = require('../src/services/billing');
  // Early customer cancellation: full refund (free window).
  const a = await quoteAccepted(50000, 30000);
  await payDeposit(a.pid);
  await db.prepare("UPDATE projects SET stage = 'scheduled', scheduled_start = ? WHERE id = ?").run(new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10), a.pid);
  const pv = await api('GET', `/api/projects/${a.pid}/cancellation-preview`, undefined, cust);
  assert.equal(pv.data.refund_cents, 15000);
  assert.equal(pv.data.rule, 'free_cancellation');
  assert.equal((await api('POST', `/api/projects/${a.pid}/cancel`, {}, cont)).status, 403, 'pros cannot cancel');
  const c1 = await api('POST', `/api/projects/${a.pid}/cancel`, { reason: 'Changed my mind' }, cust);
  assert.equal(c1.status, 200, JSON.stringify(c1.data));
  assert.equal(c1.data.refund.via_stripe_cents, 15000);
  assert.equal((await row('SELECT stage FROM projects WHERE id = ?', a.pid)).stage, 'cancelled');
  assert.equal((await api('POST', `/api/projects/${a.pid}/cancel`, {}, cust)).status, 409, 'once');

  // Late cancellation with the owner's fee: half the deposit kept.
  await api('PUT', '/api/admin/settings', { values: { cancel_free_hours: 48, late_cancel_fee_pct: 50 } }, owner);
  const b = await quoteAccepted(50000, 30000);
  await payDeposit(b.pid);
  await db.prepare("UPDATE projects SET stage = 'scheduled', scheduled_start = ? WHERE id = ?").run(new Date(Date.now() + 5 * 3600000).toISOString(), b.pid);
  const c2 = await api('POST', `/api/projects/${b.pid}/cancel`, {}, cust);
  assert.equal(c2.data.rule, 'late_cancellation');
  assert.equal(c2.data.fee_cents, 7500);
  assert.equal(c2.data.refund_cents, 7500);
  assert.equal(await billing.netPaidCents(b.pid), 7500);

  // Pro no-show: the customer picks a new pro (no money moves) — staff only.
  const c = await quoteAccepted(50000, 30000);
  await payDeposit(c.pid);
  assert.equal((await api('POST', `/api/projects/${c.pid}/assign`, { contractor_id: contractorId }, owner)).status, 200);
  assert.equal((await api('POST', `/api/projects/${c.pid}/contractor-respond`, { accept: true, terms_accepted: true }, cont)).status, 200);
  assert.equal((await api('POST', `/api/projects/${c.pid}/cancel`, { kind: 'contractor_no_show', option: 'reschedule' }, support)).status, 403, 'needs dispatch');
  const rs = await api('POST', `/api/projects/${c.pid}/cancel`, { kind: 'contractor_no_show', option: 'reschedule' }, owner);
  assert.equal(rs.data.redispatched, true);
  const after = await row('SELECT contractor_id, stage FROM projects WHERE id = ?', c.pid);
  assert.equal(after.contractor_id, null);
  assert.equal(after.stage, 'assigned');
  assert.equal(await billing.netPaidCents(c.pid), 15000, 'the deposit stays on the project');

  // Work under way: not cancellable here.
  const d = await quoteAccepted(50000, 30000);
  await payDeposit(d.pid);
  assert.equal((await api('POST', `/api/projects/${d.pid}/assign`, { contractor_id: contractorId }, owner)).status, 200);
  assert.equal((await api('POST', `/api/projects/${d.pid}/contractor-respond`, { accept: true, terms_accepted: true }, cont)).status, 200);
  assert.equal((await api('PATCH', `/api/projects/${d.pid}/stage`, { stage: 'in_progress' }, cont)).status, 200);
  assert.equal((await api('POST', `/api/projects/${d.pid}/cancel`, {}, cust)).status, 409);
  await api('PUT', '/api/admin/settings', { values: { cancel_free_hours: 24, late_cancel_fee_pct: 0 } }, owner);
});
