// Helpman — Corte 7 tests: process redesign.
//  1. The pro books the visit (day + arrival window) while accepting the offer — portal or
//     email link — guided by the customer's preference; the customer is told at once and
//     dispatch no longer has to pick a date and wait for the pro to confirm it.
//  2. Quote accepted but no deposit: one automatic reminder to the customer, then support.
//  3. The quote form no longer shows a per-quote deposit % that the server ignored.
//
// Own throwaway SQLite DB + server on :3473. No Stripe (deposits recorded by the owner).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const TEST_DB = '/tmp/test-process.db';
const BASE = 'http://localhost:3473';
for (const f of [TEST_DB, TEST_DB + '-shm', TEST_DB + '-wal']) { try { fs.unlinkSync(f); } catch (e) { /* fresh */ } }
Object.assign(process.env, { DB_PATH: TEST_DB, PORT: '3473', JWT_SECRET: 'process-test-secret-0123456789abcdef012', AUTH_RATE_LIMIT_MAX: '5000', INTAKE_RATE_LIMIT_MAX: '5000' });
delete process.env.DATABASE_URL; delete process.env.DEV_AUTORECORD_DEPOSIT;
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET']) delete process.env[k];

const db = require('../src/db');
require('../server');
after(async () => { const s = await require('../server').listening; if (s) { s.closeAllConnections && s.closeAllConnections(); s.close(); } });

const mailer = require('../src/services/mailer');
const sent = [];
const realSend = mailer.send;
mailer.send = async (m) => { sent.push(m); return realSend(m); };
const mailsTo = (to, re) => sent.filter((m) => m.to === to && (!re || re.test(m.subject)));
const offers = require('../src/services/offers');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function api(method, p, body, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, data };
}
const row = (sql, ...a) => db.prepare(sql).get(...a);
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

let owner, cust, custId, pro, proId, pro2, pro2Id;
const CUST = 'rita.p@test.local', PRO = 'mario.p@test.local';

async function makePro(name, email, phone) {
  await api('POST', '/api/auth/signup/contractor', { name, email, phone, password: 'Contractor123!', legal_name: name, city: 'Vallejo' });
  const token = (await api('POST', '/api/auth/login', { email, password: 'Contractor123!' })).data.token;
  const id = (await row('SELECT c.id FROM contractors c JOIN users u ON u.id = c.user_id WHERE u.email = ?', email)).id;
  await api('PATCH', `/api/contractors/${id}/verify`, { license_verified: true, insurance_verified: true, background_check: 'passed', status: 'active' }, owner);
  const f = new FormData(); f.append('photo', new Blob([PNG], { type: 'image/png' }), 'me.png');
  await api('POST', '/api/contractors/me/photo', f, token);
  return { token, id };
}

before(async () => {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) { /* retry */ } await new Promise((r) => setTimeout(r, 100)); }
  await db.prepare("INSERT INTO users (name, email, phone, password_hash, role, email_verified) VALUES ('Owner','owner.p@test.local','',?,'admin',1)").run(bcrypt.hashSync('Admin123!', 10));
  owner = (await api('POST', '/api/auth/login', { email: 'owner.p@test.local', password: 'Admin123!' })).data.token;
  const c = await api('POST', '/api/auth/signup/customer', { name: 'Rita Perez', email: CUST, phone: '707-555-0500', password: 'Customer123!' });
  custId = c.data.user.id;
  await db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(custId);
  cust = (await api('POST', '/api/auth/login', { email: CUST, password: 'Customer123!' })).data.token;
  ({ token: pro, id: proId } = await makePro('Mario Lopez', PRO, '707-555-0510'));
  ({ token: pro2, id: pro2Id } = await makePro('Other Pro', 'other.p@test.local', '707-555-0511'));
});

// Quote accepted + deposit recorded + offered to `to` (stage assigned, contractor_status offered).
async function offered(to = proId, { deposit = true } = {}) {
  const j = await api('POST', '/api/jobs', { name: 'Rita Perez', phone: '707-555-0500', email: CUST, address: '12 Pine St', city: 'Vallejo', zip: '94590', service_type: 'painting', description: 'Paint the kitchen.' }, cust);
  const q = await api('POST', '/api/quotes', { job_request_id: j.data.id, customer_price_cents: 60000, contractor_cost_cents: 36000 }, owner);
  await api('POST', `/api/quotes/${q.data.id}/send`, {}, owner);
  const pid = (await api('POST', `/api/quotes/${q.data.id}/respond`, { accept: true, terms_accepted: true }, cust)).data.project_id;
  if (!deposit) return pid;
  assert.equal((await api('POST', '/api/payments', { project_id: pid, kind: 'deposit', amount_cents: 18000 }, owner)).status, 201);
  assert.equal((await api('POST', `/api/projects/${pid}/assign`, { contractor_id: to }, owner)).status, 200);
  return pid;
}

test('C7: the pro sees the customer\'s timing wish (no contact details), the windows and their own visits', async () => {
  const pid = await offered();
  await api('PUT', `/api/customer-experience/projects/${pid}/schedule-preference`, { preferred_date: day(5), time_window: 'morning', flexibility: 'plus_minus_1', notes: 'Call me at 707-555-0500 before' }, cust);
  const o = await api('GET', `/api/projects/${pid}/booking-options`, undefined, pro);
  assert.equal(o.status, 200);
  assert.equal(o.data.windows.length, 5);
  assert.equal(o.data.preference.preferred_date, day(5));
  assert.ok(!/707-555-0500/.test(o.data.preference.notes), 'the customer\'s phone never reaches the pro');
  assert.equal((await api('GET', `/api/projects/${pid}/booking-options`, undefined, pro2)).status, 403, 'only the pro it was offered to');
  assert.equal((await api('GET', `/api/projects/${pid}/booking-options`, undefined, cust)).status, 403);
});

test('C7: accepting with a day + window books the visit at once and tells the customer', async () => {
  const pid = await offered();
  const before = sent.length;
  const bad = [
    [{ visit_date: day(0), arrival_window: offers.ARRIVAL_WINDOWS[0] }, 'visit_date'],
    [{ visit_date: day(45), arrival_window: offers.ARRIVAL_WINDOWS[0] }, 'visit_date'],
    [{ visit_date: day(3), arrival_window: 'whenever' }, 'arrival_window'],
  ];
  for (const [b, field] of bad) {
    const r = await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: true, terms_accepted: true, ...b }, pro);
    assert.equal(r.status, 422); assert.ok(r.data.errors[field], field);
  }
  assert.equal((await row('SELECT contractor_status FROM projects WHERE id = ?', pid)).contractor_status, 'offered', 'an invalid day does not half-accept the job');

  const r = await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: true, terms_accepted: true, visit_date: day(3), arrival_window: offers.ARRIVAL_WINDOWS[1] }, pro);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.booked, true);
  const p = await row('SELECT * FROM projects WHERE id = ?', pid);
  assert.equal(p.stage, 'scheduled');
  assert.equal(String(p.scheduled_start).slice(0, 10), day(3));
  assert.equal(p.arrival_window, offers.ARRIVAL_WINDOWS[1]);
  assert.equal(p.schedule_status, 'confirmed', 'the pro chose it: nothing left to confirm');
  const news = sent.slice(before);
  assert.equal(news.filter((m) => m.to === CUST && /Your visit is scheduled/.test(m.subject)).length, 1, 'the customer is told');
  const booked = news.filter((m) => m.to === PRO && /Visit booked/.test(m.subject));
  assert.equal(booked.length, 1); assert.match(booked[0].html, /12 Pine St/, 'the pro gets the address');
  assert.equal(news.filter((m) => m.to === PRO && /waiting for day confirmation/.test(m.subject)).length, 0);
  assert.ok(await row(`SELECT id FROM admin_audit WHERE action = 'project.visit_booked_by_pro' AND entity_id = ?`, pid));
  // It no longer needs a date in Agenda.
  const ag = await api('GET', '/api/projects/agenda', undefined, owner);
  if (ag.status === 200 && ag.data.unscheduled) assert.ok(!ag.data.unscheduled.some((x) => x.id === pid));
});

test('C7: the same pro cannot be booked twice in the same window', async () => {
  const a = await offered();
  await api('POST', `/api/projects/${a}/contractor-respond`, { accept: true, terms_accepted: true, visit_date: day(6), arrival_window: offers.ARRIVAL_WINDOWS[2] }, pro);
  const b = await offered();
  const r = await api('POST', `/api/projects/${b}/contractor-respond`, { accept: true, terms_accepted: true, visit_date: day(6), arrival_window: offers.ARRIVAL_WINDOWS[2] }, pro);
  assert.equal(r.status, 422);
  assert.match(r.data.errors.arrival_window, new RegExp(`#${a}`));
  assert.equal((await api('POST', `/api/projects/${b}/contractor-respond`, { accept: true, terms_accepted: true, visit_date: day(6), arrival_window: offers.ARRIVAL_WINDOWS[3] }, pro)).status, 200, 'another window that day is fine');
  const opts = (await api('GET', `/api/projects/${a}/booking-options`, undefined, pro)).data;
  assert.ok(opts.busy.some((x) => x.project_id === b), 'the pro sees their other visits');
});

test('C7: accepting without a day keeps the dispatch flow (no booking, the pro is told dispatch sets it)', async () => {
  const pid = await offered();
  const r = await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: true, terms_accepted: true }, pro);
  assert.equal(r.status, 200);
  assert.equal(r.data.booked, false);
  const p = await row('SELECT scheduled_start FROM projects WHERE id = ?', pid);
  assert.equal(p.scheduled_start, null);
  assert.equal(mailsTo(PRO, new RegExp(`waiting for day confirmation`)).filter((m) => m.subject.includes(`#${pid}`)).length, 1);
});

test('C7: the email offer page books the visit too', async () => {
  const pid = await offered();
  const { token } = offers.offerLinks(pid, proId);
  const g = await api('GET', `/api/offers/${encodeURIComponent(token)}`);
  assert.equal(g.status, 200);
  assert.equal(g.data.windows.length, 5);
  assert.ok('preference' in g.data);
  const r = await api('POST', `/api/offers/${encodeURIComponent(token)}/respond`, { accept: true, terms_accepted: true, visit_date: day(8), arrival_window: offers.ARRIVAL_WINDOWS[4] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.booked, true);
  assert.equal(r.data.project.customer_price_cents, undefined, 'the pro never sees the customer price');
  assert.equal((await row('SELECT arrival_window FROM projects WHERE id = ?', pid)).arrival_window, offers.ARRIVAL_WINDOWS[4]);
});

test('C7: unpaid deposit — one reminder to the customer, then support; validated timeframes', async () => {
  const pid = await offered(proId, { deposit: false });
  const visit = require('../src/services/visit');
  const now = Date.now();
  await visit.runLifecycleEmails({ now: new Date(now + 2 * 3600e3) });
  assert.equal(mailsTo(CUST, new RegExp(`waiting for the deposit — project #${pid}$`)).length, 0, 'nothing before 24 h');
  const r1 = await visit.runLifecycleEmails({ now: new Date(now + 25 * 3600e3) });
  assert.ok(r1.deposit_reminders >= 1);
  const m = mailsTo(CUST, new RegExp(`waiting for the deposit — project #${pid}$`));
  assert.equal(m.length, 1); assert.match(m[0].html, /\$180\.00/, 'shows the deposit amount');
  const r2 = await visit.runLifecycleEmails({ now: new Date(now + 73 * 3600e3) });
  assert.ok(r2.deposit_escalations >= 1);
  assert.equal(mailsTo('owner.p@test.local', new RegExp(`Deposit still unpaid — project #${pid}$`)).length, 1);
  await visit.runLifecycleEmails({ now: new Date(now + 200 * 3600e3) });
  assert.equal(mailsTo(CUST, new RegExp(`waiting for the deposit — project #${pid}$`)).length, 1, 'never twice');
  // paid deposits are never reminded
  const paid = await offered();
  await visit.runLifecycleEmails({ now: new Date(now + 300 * 3600e3) });
  assert.equal(mailsTo(CUST, new RegExp(`waiting for the deposit — project #${paid}$`)).length, 0);
  // settings
  assert.equal((await api('PUT', '/api/admin/settings', { values: { deposit_escalate_hours: 10 } }, owner)).status, 422);
  assert.equal((await api('PUT', '/api/admin/settings', { values: { deposit_reminder_hours: 12, deposit_escalate_hours: 48 } }, owner)).status, 200);
});

test('C7: the quote form shows the real deposit rule and the estimate, not an ignored % field', async () => {
  const html = await (await fetch(BASE + '/admin.html')).text();
  assert.ok(!/name="deposit_pct"/.test(html), 'no per-quote deposit field');
  assert.match(html, /data-use-mid=/);
  const offer = await (await fetch(BASE + '/offer.html')).text();
  assert.match(offer, /bk-date/);
  const portal = await (await fetch(BASE + '/contractor.html')).text();
  assert.match(portal, /booking-options/);
});
