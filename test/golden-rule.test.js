// Helpman — Corte 1 contract tests: the GOLDEN RULE.
// A contractor never receives anything that identifies or reaches a customer
// (or another contractor's work); a customer never receives anything that
// reaches the contractor or reveals what Helpman pays them. Checked endpoint by
// endpoint against REAL distinctive values, plus the safety net, the change-order
// mediation, strict photo validation, UPLOADS_DIR and the owner plug-in panel.
//
// Own throwaway SQLite DB + server on :3461, so it runs beside test/api.test.js.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const TEST_DB = '/tmp/test-golden-rule.db';
const UPLOADS = '/tmp/helpman-golden-uploads';
const BASE = 'http://localhost:3461';
for (const f of [TEST_DB, TEST_DB + '-shm', TEST_DB + '-wal']) { try { fs.unlinkSync(f); } catch (e) { /* fresh */ } }
fs.rmSync(UPLOADS, { recursive: true, force: true });
process.env.DB_PATH = TEST_DB;
process.env.PORT = '3461';
process.env.UPLOADS_DIR = UPLOADS;
process.env.JWT_SECRET = 'golden-rule-test-secret-0123456789abcdef';
process.env.AUTH_RATE_LIMIT_MAX = '5000';
process.env.INTAKE_RATE_LIMIT_MAX = '5000';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.DATABASE_URL;

const db = require('../src/db');
require('../server');

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// Distinctive values: if any of them shows up on the wrong side, the rule broke.
const CUST = { name: 'Rosa Elena Villalobos', email: 'rosa.gr@test.local', phone: '707-555-0199', password: 'Customer123!' };
const CONT = { name: 'Teodoro Quintanilla', email: 'teo.gr@test.local', phone: '415-555-0177', password: 'Contractor123!' };
const PRICE = 123457;   // what the customer pays (cents)
const COST = 76543;     // what Helpman pays the pro (cents)
const STREET = '4821 Calle Esmeralda';

async function api(method, p, body, token, form) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, data };
}

let admin, cust, cont, contractorId, jobId, quoteId, pid;

before(async () => {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  await db.prepare("INSERT INTO users (name, email, phone, password_hash, role, email_verified) VALUES (?,?,?,?,?,1)")
    .run('Owner Admin', 'owner.gr@test.local', '', bcrypt.hashSync('Admin123!', 10), 'admin');
  admin = (await api('POST', '/api/auth/login', { email: 'owner.gr@test.local', password: 'Admin123!' })).data.token;

  const c = await api('POST', '/api/auth/signup/customer', CUST);
  assert.equal(c.status, 201);
  await db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(CUST.email);
  cust = (await api('POST', '/api/auth/login', { email: CUST.email, password: CUST.password })).data.token;

  const k = await api('POST', '/api/auth/signup/contractor', { ...CONT, legal_name: 'Quintanilla Home Repair LLC', city: 'Fairfield', license_number: 'CSLB-998877' });
  assert.equal(k.status, 201);
  await db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(CONT.email);
  cont = (await api('POST', '/api/auth/login', { email: CONT.email, password: CONT.password })).data.token;
  contractorId = (await db.prepare('SELECT c.id FROM contractors c JOIN users u ON u.id = c.user_id WHERE u.email = ?').get(CONT.email)).id;
  await api('PATCH', `/api/contractors/${contractorId}/verify`, { license_verified: true, insurance_verified: true, background_check: 'passed', status: 'active' }, admin);
  const pf = new FormData();
  pf.append('photo', new Blob([PNG_1PX], { type: 'image/png' }), 'me.png');
  assert.equal((await api('POST', '/api/contractors/me/photo', undefined, cont, pf)).status, 201);

  const j = await api('POST', '/api/jobs', {
    name: CUST.name, phone: CUST.phone, email: CUST.email, address: STREET, city: 'Fairfield', zip: '94534',
    service_type: 'painting',
    description: `Paint the living room. Call me at ${CUST.phone} or write to ${CUST.email}, or WhatsApp me.`,
  }, cust);
  assert.equal(j.status, 201);
  jobId = j.data.id;
  const q = await api('POST', '/api/quotes', { job_request_id: jobId, customer_price_cents: PRICE, contractor_cost_cents: COST, deposit_pct: 30 }, admin);
  assert.equal(q.status, 201);
  quoteId = q.data.id;
  await api('POST', `/api/quotes/${quoteId}/send`, {}, admin);
  const r = await api('POST', `/api/quotes/${quoteId}/respond`, { accept: true, terms_accepted: true }, cust);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  pid = r.data.project_id;
  const a = await api('POST', `/api/projects/${pid}/assign`, { contractor_id: contractorId }, admin);
  assert.equal(a.status, 200, JSON.stringify(a.data));
});

// ---- helpers ----
// A phone shows up formatted or bare: check the local part both ways.
const hasPhone = (s, phone) => { const local = phone.slice(-8); return s.includes(local) || s.includes(local.replace('-', '')); };
function assertNoCustomerData(label, data) {
  const s = JSON.stringify(data);
  assert.ok(!s.includes(CUST.email), `${label}: customer email leaked`);
  assert.ok(!hasPhone(s, CUST.phone), `${label}: customer phone leaked`);
  assert.ok(!s.includes('Villalobos'), `${label}: customer last name leaked`);
  assert.ok(!s.includes(String(PRICE)), `${label}: customer price leaked`);
  assert.ok(!s.includes(String(Math.round(PRICE * 0.3))), `${label}: customer deposit leaked`);
  assert.ok(!/claim_token|password_hash|reset_token|verify_token|schedule_token/.test(s), `${label}: secret/token leaked`);
}
function assertNoContractorData(label, data) {
  const s = JSON.stringify(data);
  assert.ok(!s.includes(CONT.email), `${label}: contractor email leaked`);
  assert.ok(!hasPhone(s, CONT.phone), `${label}: contractor phone leaked`);
  assert.ok(!s.includes('Quintanilla'), `${label}: contractor last name / legal name leaked`);
  assert.ok(!s.includes('CSLB-998877'), `${label}: contractor license number leaked`);
  assert.ok(!s.includes(String(COST)), `${label}: contractor cost (platform margin) leaked`);
  assert.ok(!/password_hash|reset_token|verify_token|schedule_token/.test(s), `${label}: secret/token leaked`);
}

test('C1: before accepting, the pro sees the area but not the street address; the offer link too', async () => {
  const p = await api('GET', `/api/projects/${pid}`, undefined, cont);
  assert.equal(p.status, 200);
  assert.equal(p.data.job.address, null, 'street address withheld before acceptance');
  assert.equal(p.data.job.city, 'Fairfield');
  assert.equal(p.data.job.customer_first_name, 'Rosa');
  assertNoCustomerData('project (offered)', p.data);
  assert.ok(!JSON.stringify(p.data).includes(STREET), 'street not in the offered view');

  const { token } = require('../src/services/offers').offerLinks(pid, contractorId);
  const o = await api('GET', `/api/offers/${token}`);
  assert.equal(o.status, 200);
  assert.ok(!JSON.stringify(o.data).includes(STREET), 'street not in the magic-link summary');
  assertNoCustomerData('offer link', o.data);
});

test('C1: free text written by the customer reaches the pro without contact details', async () => {
  const p = await api('GET', `/api/projects/${pid}`, undefined, cont);
  assert.match(p.data.job.description, /contact removed/);
  assert.ok(!/whatsapp/i.test(p.data.job.description), 'messaging-app handle removed');
});

test('C1: accepting returns the contractor view only; the street address is then released', async () => {
  const r = await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: true, terms_accepted: true }, cont);
  assert.equal(r.status, 200);
  assertNoCustomerData('contractor-respond', r.data);
  const p = await api('GET', `/api/projects/${pid}`, undefined, cont);
  assert.equal(p.data.job.address, STREET, 'address released after acceptance');
  assert.ok(p.data.contractor_cost_cents === COST, 'the pro still sees their own payout');
  const st = await api('PATCH', `/api/projects/${pid}/stage`, { stage: 'in_progress' }, cont);
  assert.equal(st.status, 200);
  assertNoCustomerData('stage change', st.data);
});

test('C1: CONTRACT SWEEP — every endpoint a contractor can call is free of customer data', async () => {
  const ms = (await api('GET', `/api/projects/${pid}`, undefined, admin)).data.milestones;
  await api('POST', `/api/projects/${pid}/milestones/${ms[0].id}/complete`, {}, cont);
  const endpoints = [
    '/api/auth/me', '/api/projects', `/api/projects/${pid}`, '/api/contractors/me',
    '/api/contractor-ops/dashboard', '/api/contractor-ops/payouts', '/api/payables/mine',
    '/api/reviews', '/api/disputes', `/api/projects/${pid}/threads`, `/api/projects/${pid}/offers`,
    `/api/customer-experience/projects/${pid}/change-orders`, `/api/customer-experience/projects/${pid}/timeline`,
    `/api/projects/${pid}/sign-off`, '/api/payments', '/api/sms/status', '/api/me/export',
  ];
  for (const ep of endpoints) {
    const r = await api('GET', ep, undefined, cont);
    assert.ok(r.status < 500, `${ep} answered ${r.status}`);
    assertNoCustomerData(ep, r.data);
  }
});

test('C1: CONTRACT SWEEP — every endpoint a customer can call is free of the pro\'s contact and cost', async () => {
  const endpoints = [
    '/api/auth/me', '/api/projects', `/api/projects/${pid}`, `/api/quotes?job_request_id=${jobId}`, `/api/quotes/${quoteId}`,
    '/api/payments', '/api/jobs/mine/list', `/api/jobs/${jobId}`, '/api/reviews', '/api/disputes',
    `/api/projects/${pid}/threads`, `/api/customer-experience/projects/${pid}/change-orders`,
    `/api/customer-experience/projects/${pid}/timeline`, '/api/me/export',
  ];
  for (const ep of endpoints) {
    const r = await api('GET', ep, undefined, cust);
    assert.ok(r.status < 500, `${ep} answered ${r.status}`);
    assertNoContractorData(ep, r.data);
  }
  const p = await api('GET', `/api/projects/${pid}`, undefined, cust);
  assert.equal(p.data.contractor.display_name, 'Teodoro Q.', 'first name + initial');
  assert.ok(p.data.contractor.photo_url, 'the customer still sees the photo');
  const q = await api('GET', `/api/quotes/${quoteId}`, undefined, cust);
  assert.equal(q.data.contractor_cost_cents, undefined, 'quote hides the contractor cost');
  assert.equal(q.data.customer_price_cents, PRICE, 'quote keeps the customer price');
});

test('C1: change orders — the pro proposes, Helpman prices and sends; the customer never sees a draft', async () => {
  const d = await api('POST', `/api/customer-experience/projects/${pid}/change-orders`, {
    title: 'Extra wall', description: `Also the hallway. Text me at ${CONT.phone}`, price_delta_cents: 99999,
  }, cont);
  assert.equal(d.status, 201);
  assert.equal(d.data.price_delta_cents, undefined, 'the pro never sees the customer price change');
  const row = await db.prepare('SELECT * FROM change_orders WHERE id = ?').get(d.data.id);
  assert.equal(row.price_delta_cents, 0, 'the pro cannot set the customer price');

  assert.equal((await api('POST', `/api/customer-experience/projects/${pid}/change-orders/${d.data.id}/send`, {}, cont)).status, 403, 'the pro cannot send it to the customer');
  const before = await api('GET', `/api/customer-experience/projects/${pid}/change-orders`, undefined, cust);
  assert.equal(before.data.length, 0, 'drafts are internal');
  const tl = await api('GET', `/api/customer-experience/projects/${pid}/timeline`, undefined, cust);
  assert.ok(!JSON.stringify(tl.data).includes('Extra wall'), 'a draft never reaches the customer timeline');

  const s = await api('POST', `/api/customer-experience/projects/${pid}/change-orders/${d.data.id}/send`, { price_delta_cents: 25000 }, admin);
  assert.equal(s.status, 200);
  const after = await api('GET', `/api/customer-experience/projects/${pid}/change-orders`, undefined, cust);
  assert.equal(after.data.length, 1);
  assert.equal(after.data[0].price_delta_cents, 25000);
  assert.match(after.data[0].description, /contact removed/);
  assertNoContractorData('sent change order', after.data);
});

test('C1: daily logs never go straight to the customer', async () => {
  const r = await api('POST', `/api/contractor-ops/projects/${pid}/daily-log`, { summary: 'Primed the walls', customer_visible: true }, cont);
  assert.equal(r.status, 201);
  assert.equal(r.data.customer_visible, 0);
});

test('C1: photos — the Content-Type is not trusted, a real image is required, stored under UPLOADS_DIR', async () => {
  const fake = new FormData();
  fake.append('photos', new Blob([Buffer.from('<html>call 555-123-4567</html>')], { type: 'image/jpeg' }), 'call-707-555-0100.jpg');
  const bad = await api('POST', `/api/projects/${pid}/photos`, undefined, cont, fake);
  assert.equal(bad.status, 400, 'a non-image disguised as JPEG is refused');
  const good = new FormData();
  good.append('photos', new Blob([PNG_1PX], { type: 'image/png' }), 'call me 707-555-0100.png');
  const ok = await api('POST', `/api/projects/${pid}/photos`, undefined, cont, good);
  assert.equal(ok.status, 201);
  assert.ok(!/707/.test(ok.data.photos[0].original_name), 'file names lose contact details');
  const row = await db.prepare('SELECT filename FROM photos WHERE id = ?').get(ok.data.photos[0].id);
  assert.ok(fs.existsSync(path.join(UPLOADS, row.filename)), 'stored under UPLOADS_DIR');
});

test('C1: safety net — the response guard strips forbidden keys even if a route forgets', () => {
  const { guardPayload, redactContacts } = require('../src/services/views');
  const leaky = { project: { customer_price_cents: 1, contractor_cost_cents: 2, schedule_token: 'x', job: { phone: '7075550199', email: 'x@y.com', customer_id: 9 } }, me: { email: 'me@c.com' } };
  const toCont = guardPayload(leaky, { role: 'contractor', email: 'me@c.com', phone: '' });
  assert.equal(toCont.project.customer_price_cents, undefined);
  assert.equal(toCont.project.contractor_cost_cents, 2);
  assert.equal(toCont.project.schedule_token, undefined);
  assert.equal(toCont.project.job.phone, undefined);
  assert.equal(toCont.project.job.email, undefined);
  assert.equal(toCont.project.job.customer_id, undefined);
  assert.equal(toCont.me.email, 'me@c.com', 'own contact stays');
  const toCust = guardPayload({ contractor: { email: 'pro@x.com', phone: '1', rating_avg: 5, legal_name: 'LLC' }, contractor_cost_cents: 3, job: { email: 'mine@x.com' } }, { role: 'customer', email: 'mine@x.com', phone: '' });
  assert.equal(toCust.contractor.email, undefined);
  assert.equal(toCust.contractor.phone, undefined);
  assert.equal(toCust.contractor.legal_name, undefined);
  assert.equal(toCust.contractor_cost_cents, undefined);
  assert.equal(toCust.job.email, 'mine@x.com', "the customer's own request data stays");
  assert.deepEqual(guardPayload({ customer_price_cents: 1 }, { role: 'admin' }), { customer_price_cents: 1 }, 'staff are unaffected');
  for (const t of ['call (707) 555-0199', 'mail me: a.b@c.co', 'whatsapp 7075550199', 'IG @rosa_paints']) {
    assert.match(redactContacts(t), /contact removed/, t);
  }
  assert.equal(redactContacts('Paint 2 rooms, 400 sqft'), 'Paint 2 rooms, 400 sqft', 'ordinary numbers survive');
});

test('C1: plug-in panel — owner only, never shows a secret, live database test', async () => {
  assert.equal((await api('GET', '/api/admin/plugs', undefined, cont)).status, 403);
  assert.equal((await api('GET', '/api/admin/plugs', undefined, cust)).status, 403);
  assert.equal((await api('GET', '/api/admin/plugs')).status, 401);
  const r = await api('GET', '/api/admin/plugs', undefined, admin);
  assert.equal(r.status, 200);
  const ids = r.data.items.map(i => i.id);
  for (const id of ['stripe', 'database', 'hosting', 'storage', 'email', 'secrets', 'owner_2fa']) assert.ok(ids.includes(id), id);
  assert.ok(!JSON.stringify(r.data).includes(process.env.JWT_SECRET), 'secret values are never returned');
  assert.equal(r.data.items.find(i => i.id === 'database').status, 'missing', 'local SQLite is flagged as not persistent');
  assert.equal(r.data.items.find(i => i.id === 'email').status, 'missing', 'log-mode email is flagged');
  assert.equal(r.data.ready, false);
  const t = await api('POST', '/api/admin/plugs/database/test', {}, admin);
  assert.equal(t.status, 200);
  assert.equal(t.data.ok, true);
  assert.equal((await api('POST', '/api/admin/plugs/nope/test', {}, admin)).status, 404);
  const support = await db.prepare("INSERT INTO users (name, email, phone, password_hash, role, email_verified, staff_role) VALUES (?,?,?,?,?,1,'support')")
    .run('Support', 'support.gr@test.local', '', bcrypt.hashSync('Support123!', 10), 'admin');
  assert.ok(support);
  const st = (await api('POST', '/api/auth/login', { email: 'support.gr@test.local', password: 'Support123!' })).data.token;
  assert.equal((await api('GET', '/api/admin/plugs', undefined, st)).status, 403, 'support staff cannot see the setup panel');
});

test('C1: business counts are not public; email logo points to a real file', async () => {
  assert.equal((await api('GET', '/api/health/metrics-summary')).status, 401);
  assert.equal((await api('GET', '/api/health/metrics-summary', undefined, admin)).status, 200);
  const html = require('../src/services/notify').welcomeCustomer('Rosa');
  const m = html.match(/<img src="[^"]*\/img\/([^"]+)"/);
  assert.ok(m, 'logo present');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'img', m[1])), `logo file ${m[1]} exists`);
  const mailer = require('../src/services/mailer');
  assert.equal(mailer.senderIsAuthenticatable(), !/gmail/i.test(mailer.FROM_EMAIL));
});

test('C1.1: every emailed link uses the public URL, never localhost', async () => {
  const before = process.env.PUBLIC_URL;
  delete process.env.PUBLIC_URL;
  try {
    const link = require('../src/services/unsubscribe').link('rosa.gr@test.local');
    assert.match(link, /^https:\/\/helpman\.app\/api\/unsubscribe\?/);
  } finally { if (before !== undefined) process.env.PUBLIC_URL = before; }
  const src = ['src/routes/auth.js', 'src/routes/staff.js', 'src/routes/contractors.js', 'src/routes/collections.js', 'src/services/unsubscribe.js']
    .map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  assert.ok(!src.includes('localhost:3000'), 'no localhost fallback left in emailed links');
});

test('C1.1: the plug-in panel flags unused variables and non-production mode', async () => {
  process.env.SESSION_SECRET = 'leftover';
  try {
    const r = await api('GET', '/api/admin/plugs', undefined, admin);
    const left = r.data.items.find(i => i.id === 'leftovers');
    assert.ok(left && left.status === 'warning' && /SESSION_SECRET/.test(left.detail));
    assert.ok(!JSON.stringify(r.data).includes('"leftover"'), 'the value itself is never shown');
    assert.equal(r.data.items.find(i => i.id === 'production').status, 'warning');
  } finally { delete process.env.SESSION_SECRET; }
});

