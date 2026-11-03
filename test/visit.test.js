// Helpman — Corte 3 tests: the visit cycle and the full email chain.
//   on my way → check-in → photos → check-out ("work finished" email with the
//   two buttons) → the customer confirms from the email link with no login
//   (project completed, payable created, 70 % charged to the saved card, receipt)
//   or reports a problem (dispute, payments on hold). Background reminders at
//   24 h / 72 h / 3 days, the day-before email, and the golden rule in every email.
//
// Own throwaway SQLite DB + server on :3465, fake Stripe, captured mailer.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const TEST_DB = '/tmp/test-visit.db';
const BASE = 'http://localhost:3465';
for (const f of [TEST_DB, TEST_DB + '-shm', TEST_DB + '-wal']) { try { fs.unlinkSync(f); } catch (e) { /* fresh */ } }
process.env.DB_PATH = TEST_DB;
process.env.PORT = '3465';
process.env.JWT_SECRET = 'visit-test-secret-0123456789abcdef0123';
process.env.AUTH_RATE_LIMIT_MAX = '5000';
process.env.INTAKE_RATE_LIMIT_MAX = '5000';
delete process.env.DEV_AUTORECORD_DEPOSIT;
delete process.env.DATABASE_URL;
Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_PUBLISHABLE_KEY: 'pk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect' });

const db = require('../src/db');
require('../server');
after(async () => { const s = await require('../server').listening; if (s) { s.closeAllConnections && s.closeAllConnections(); s.close(); } });

// Capture every email (subject + html) without changing the mailer.
const mailer = require('../src/services/mailer');
const sent = [];
const realSend = mailer.send;
mailer.send = async (m) => { sent.push(m); return realSend(m); };
const mailsTo = (to, re) => sent.filter((m) => m.to === to && (!re || re.test(m.subject)));

const { makeFake } = require('./fake-stripe');
const fake = makeFake();
const visit = require('../src/services/visit');
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SIG = 'data:image/png;base64,' + 'A'.repeat(1200);
const CUST_EMAIL = 'ana.v@test.local', PRO_EMAIL = 'tomas.v@test.local';
const PRO_PHONE = '707-555-0199', CUST_PHONE = '707-555-0188';

async function api(method, p, body, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, data };
}
let HOOK = 0;
async function hook(type, obj) {
  const res = await fetch(BASE + '/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'valid-whsec_fake' },
    body: JSON.stringify({ id: 'evt_v' + (++HOOK), type, data: { object: obj } }) });
  return res.status;
}
const row = (sql, ...a) => db.prepare(sql).get(...a);

let owner, cust, custId, cont, contractorId;

before(async () => {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) { /* retry */ } await new Promise((r) => setTimeout(r, 100)); }
  require('../src/services/stripe')._setClientForTests(fake);
  await db.prepare("INSERT INTO users (name, email, phone, password_hash, role, email_verified) VALUES (?,?,?,?,?,1)")
    .run('Owner', 'owner.v@test.local', '', bcrypt.hashSync('Admin123!', 10), 'admin');
  owner = (await api('POST', '/api/auth/login', { email: 'owner.v@test.local', password: 'Admin123!' })).data.token;

  const c = await api('POST', '/api/auth/signup/customer', { name: 'Ana Vega', email: CUST_EMAIL, phone: CUST_PHONE, password: 'Customer123!' });
  custId = c.data.user.id;
  await db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(custId);
  cust = (await api('POST', '/api/auth/login', { email: CUST_EMAIL, password: 'Customer123!' })).data.token;

  await api('POST', '/api/auth/signup/contractor', { name: 'Tomas Rivera', email: PRO_EMAIL, phone: PRO_PHONE, password: 'Contractor123!', legal_name: 'Tomas Rivera', city: 'Vallejo' });
  cont = (await api('POST', '/api/auth/login', { email: PRO_EMAIL, password: 'Contractor123!' })).data.token;
  contractorId = (await row('SELECT c.id FROM contractors c JOIN users u ON u.id = c.user_id WHERE u.email = ?', PRO_EMAIL)).id;
  await api('PATCH', `/api/contractors/${contractorId}/verify`, { license_verified: true, insurance_verified: true, background_check: 'passed', status: 'active' }, owner);
  const pf = new FormData(); pf.append('photo', new Blob([PNG_1PX], { type: 'image/png' }), 'me.png');
  assert.equal((await api('POST', '/api/contractors/me/photo', pf, cont)).status, 201);
});

// A paid-deposit project with the card saved, assigned and accepted (stage scheduled).
async function scheduledProject(price = 100000) {
  const j = await api('POST', '/api/jobs', { name: 'Ana Vega', phone: CUST_PHONE, email: CUST_EMAIL, address: '5 Elm St', city: 'Vallejo', zip: '94590', service_type: 'drywall', description: 'Patch a hole in the hallway.' }, cust);
  const q = await api('POST', '/api/quotes', { job_request_id: j.data.id, customer_price_cents: price, contractor_cost_cents: price * 0.6 }, owner);
  await api('POST', `/api/quotes/${q.data.id}/send`, {}, owner);
  const pid = (await api('POST', `/api/quotes/${q.data.id}/respond`, { accept: true, terms_accepted: true }, cust)).data.project_id;
  const i = await api('POST', '/api/payments/deposit-intent', { project_id: pid, authorize_balance: true }, cust);
  assert.equal(i.status, 201, JSON.stringify(i.data));
  const pi = fake.pay(i.data.payment_intent_id);
  assert.equal(await hook('payment_intent.succeeded', { id: pi.id, amount: pi.amount, amount_received: pi.amount_received, metadata: pi.metadata, payment_method: pi.payment_method, customer: pi.customer }), 200);
  assert.equal((await api('POST', `/api/projects/${pid}/assign`, { contractor_id: contractorId }, owner)).status, 200);
  const acc = await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: true, terms_accepted: true }, cont);
  assert.equal(acc.data.project.stage, 'scheduled');
  return pid;
}
async function uploadCompletionPhoto(pid) {
  const f = new FormData(); f.append('kind', 'completion'); f.append('photos', new Blob([PNG_1PX], { type: 'image/png' }), 'done.png');
  assert.equal((await api('POST', `/api/projects/${pid}/photos`, f, cont)).status, 201);
}
async function finishedProject() {
  const pid = await scheduledProject();
  assert.equal((await api('POST', `/api/projects/${pid}/check-in`, {}, cont)).status, 200);
  await uploadCompletionPhoto(pid);
  assert.equal((await api('POST', `/api/projects/${pid}/check-out`, { note: 'All patched.' }, cont)).status, 200);
  return pid;
}
const tokenFor = (pid) => visit.links(pid, custId).token;
const confirmBody = { signer_name: 'Ana Vega', signature: SIG, checklist: { work_complete: true, site_clean: true } };
// No email to the customer may carry the pro's contact details (and vice versa).
function assertNoContacts(mails, forbidden) {
  for (const m of mails) for (const f of forbidden) assert.ok(!m.html.includes(f), `"${m.subject}" leaks ${f}`);
}

// ---------------------------------------------------------------- tests
test('C3: on my way → check-in → check-out sends each email, moves the stage, and requires a photo', async () => {
  const pid = await scheduledProject();
  const before = sent.length;

  const w = await api('POST', `/api/projects/${pid}/on-my-way`, {}, cont);
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.equal(w.data.emailed, true);
  assert.equal(mailsTo(CUST_EMAIL, /on the way/).length, 1);

  const ci = await api('POST', `/api/projects/${pid}/check-in`, {}, cont);
  assert.equal(ci.status, 200, JSON.stringify(ci.data));
  assert.equal(ci.data.stage, 'in_progress');
  assert.ok(ci.data.arrived_at);
  assert.equal(mailsTo(CUST_EMAIL, /has arrived/).length, 1);
  assert.equal((await api('POST', `/api/projects/${pid}/check-in`, {}, cont)).status, 409, 'one check-in per visit');

  const noPhoto = await api('POST', `/api/projects/${pid}/check-out`, {}, cont);
  assert.equal(noPhoto.status, 409);
  assert.equal(noPhoto.data.code, 'PHOTO_REQUIRED');

  await uploadCompletionPhoto(pid);
  const co = await api('POST', `/api/projects/${pid}/check-out`, {}, cont);
  assert.equal(co.status, 200, JSON.stringify(co.data));
  assert.equal(co.data.stage, 'review');
  assert.ok(co.data.departed_at);
  const fin = mailsTo(CUST_EMAIL, /did everything go well/);
  assert.equal(fin.length, 1);
  assert.match(fin[0].html, /confirm\.html\?t=/, 'confirm button');
  assert.match(fin[0].html, /problem=1/, 'report-a-problem button');
  assert.match(fin[0].html, /\/api\/photos\//, 'photos of the finished work');
  assert.match(fin[0].html, /Tomas R\./, 'the pro as "First L."');
  assert.equal(mailsTo(PRO_EMAIL, /waiting for the customer/).length, 1);
  assert.ok((await db.prepare("SELECT COUNT(*) c FROM milestones WHERE project_id = ? AND status <> 'completed'").get(pid)).c == 0, 'milestones closed by check-out');

  // Golden rule: nothing to the customer carries the pro's phone or email.
  assertNoContacts(sent.slice(before).filter((m) => m.to === CUST_EMAIL), [PRO_PHONE, PRO_EMAIL, 'Rivera']);
  assertNoContacts(sent.slice(before).filter((m) => m.to === PRO_EMAIL), [CUST_PHONE, CUST_EMAIL, 'Vega']);
});

test('C3: the customer confirms from the email link — no login — and the project closes and charges the 70 %', async () => {
  const pid = await finishedProject();
  const t = encodeURIComponent(tokenFor(pid));

  assert.equal((await api('GET', '/api/visit/not-a-token')).status, 403);
  const g = await api('GET', `/api/visit/${t}`);
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.equal(g.data.status, 'awaiting_confirmation');
  assert.equal(g.data.tech_name, 'Tomas R.');
  assert.equal(g.data.customer_first_name, 'Ana');
  assert.equal(g.data.balance_cents, 70000);
  assert.equal(g.data.auto_charge, true);
  assert.equal(g.data.photos.length, 1);
  assert.ok(!/707-555|@test\.local|Rivera/.test(JSON.stringify(g.data)), 'no contact details on the public page');

  assert.equal((await api('POST', `/api/visit/${t}/confirm`, { ...confirmBody, signature: 'nope' })).status, 422);
  const c = await api('POST', `/api/visit/${t}/confirm`, confirmBody);
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal(c.data.completed, true);
  assert.equal(c.data.balance_charge.status, 'paid');
  assert.equal(c.data.balance_charge.amount_cents, 70000);

  const p = await row('SELECT stage FROM projects WHERE id = ?', pid);
  assert.equal(p.stage, 'completed');
  assert.ok(await row('SELECT id FROM contractor_payables WHERE project_id = ?', pid), "the pro's payout is created");
  assert.equal((await row('SELECT checklist_json FROM completion_sheets WHERE project_id = ?', pid)).checklist_json.includes('"via":"email"'), true);
  assert.equal(mailsTo(CUST_EMAIL, /Receipt — project #\d+ paid in full/).filter((m) => m.subject.includes(`#${pid} `)).length, 1, 'one receipt');
  assert.equal((await api('GET', `/api/visit/${t}`)).data.status, 'confirmed');
  assert.equal((await api('POST', `/api/visit/${t}/confirm`, confirmBody)).status, 409, 'never signed twice');
  assert.equal((await api('POST', `/api/visit/${t}/problem`, { reason: 'quality', description: 'Too late to report here.' })).status, 409);
});

test('C3: a link for one project or customer cannot act on another', async () => {
  const pid = await finishedProject();
  const wrong = encodeURIComponent(visit.links(pid, custId + 999).token);
  assert.equal((await api('GET', `/api/visit/${wrong}`)).status, 403);
  const otherPurpose = encodeURIComponent(require('../src/services/magiclink').sign({ purpose: 'login', projectId: pid, customerId: custId }, 60000));
  assert.equal((await api('GET', `/api/visit/${otherPurpose}`)).status, 403);
});

test('C3: "Report a problem" opens a dispute, notifies support, and holds the confirmation and the charge', async () => {
  const pid = await finishedProject();
  const t = encodeURIComponent(tokenFor(pid));
  assert.equal((await api('POST', `/api/visit/${t}/problem`, { reason: 'nope', description: 'The wall still has a hole.' })).status, 422);
  assert.equal((await api('POST', `/api/visit/${t}/problem`, { reason: 'incomplete', description: 'short' })).status, 422);
  const r = await api('POST', `/api/visit/${t}/problem`, { reason: 'incomplete', description: 'The wall still has a hole near the door.' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(await row("SELECT id FROM disputes WHERE project_id = ? AND opened_by_role = 'customer' AND status = 'open'", pid));
  assert.equal(mailsTo('owner.v@test.local', new RegExp(`Problem reported — project #${pid}$`)).length, 1);
  assert.equal(mailsTo(CUST_EMAIL, new RegExp(`We received your report — project #${pid}$`)).length, 1);
  assert.equal((await api('GET', `/api/visit/${t}`)).data.status, 'problem_reported');
  const c = await api('POST', `/api/visit/${t}/confirm`, confirmBody);
  assert.equal(c.status, 409);
  assert.equal(c.data.code, 'DISPUTE_HOLD');
  assert.equal((await row('SELECT stage FROM projects WHERE id = ?', pid)).stage, 'review');
  assert.equal((await api('POST', `/api/visit/${t}/problem`, { reason: 'quality', description: 'Second report on the same job.' })).status, 409, 'one open report per project');
});

test('C3: the portal sign-off works right after check-out (no milestone clicking) and charges the balance', async () => {
  const pid = await finishedProject();
  const s = await api('POST', `/api/projects/${pid}/sign-off`, confirmBody, cust);
  assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.equal(s.data.balance_charge.status, 'paid');
  assert.equal((await row('SELECT stage FROM projects WHERE id = ?', pid)).stage, 'completed');
});

test('C3: reminders — confirm at 24 h, escalate to support at 72 h, review request 3 days after completion; each once', async () => {
  const waiting = await finishedProject();
  const confirmed = await finishedProject();
  assert.equal((await api('POST', `/api/visit/${encodeURIComponent(tokenFor(confirmed))}/confirm`, confirmBody)).status, 201);

  const now = Date.now();
  const r0 = await visit.runLifecycleEmails({ now: new Date(now + 2 * 3600e3) });
  assert.equal(r0.confirm_reminders, 0, 'nothing before 24 h');

  const r1 = await visit.runLifecycleEmails({ now: new Date(now + 25 * 3600e3) });
  assert.ok(r1.confirm_reminders >= 1);
  assert.equal(mailsTo(CUST_EMAIL, new RegExp(`Reminder: please confirm your finished job — project #${waiting}$`)).length, 1);
  assert.equal(r1.escalations, 0);

  const r2 = await visit.runLifecycleEmails({ now: new Date(now + 73 * 3600e3) });
  assert.ok(r2.escalations >= 1);
  assert.equal(mailsTo('owner.v@test.local', new RegExp(`Customer has not confirmed — project #${waiting}$`)).length, 1);
  assert.ok(r2.review_reminders >= 1);
  assert.equal(mailsTo(CUST_EMAIL, new RegExp(`How did we do\\? — project #${confirmed}$`)).length, 1);

  await visit.runLifecycleEmails({ now: new Date(now + 100 * 3600e3) });
  assert.equal(mailsTo(CUST_EMAIL, new RegExp(`Reminder: please confirm your finished job — project #${waiting}$`)).length, 1, 'never twice');
  assert.equal(mailsTo(CUST_EMAIL, new RegExp(`How did we do\\? — project #${confirmed}$`)).length, 1, 'never twice');
});

test('C3: the day-before reminder goes by email too (customers without SMS consent are told)', async () => {
  const pid = await scheduledProject();
  const tomorrow = require('../src/services/sms').tomorrowIn(process.env.BUSINESS_TZ || 'America/Los_Angeles', new Date());
  await db.prepare('UPDATE projects SET scheduled_start = ? WHERE id = ?').run(tomorrow, pid);
  const r = await require('../src/services/sms').runReminders({ force: true });
  assert.ok(r.emailed >= 1, JSON.stringify(r));
  const m = mailsTo(CUST_EMAIL, new RegExp(`your visit is tomorrow — project #${pid}$`));
  assert.equal(m.length, 1);
  assertNoContacts(m, [PRO_PHONE, PRO_EMAIL]);
});

test('C3: the confirmation page is served and kept out of search engines', async () => {
  const res = await fetch(BASE + '/confirm.html');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /\/api\/visit\//);
  assert.match(html, /noindex/);
});
