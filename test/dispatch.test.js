// Helpman — Corte 8 tests: automatic offers (owner decision 2026-11-03).
//  1. When the deposit is in, the job is offered automatically to the best-ranked
//     verified pro with that trade and a photo (never a company technician).
//  2. It is offered again ONLY when an offer is declined or expires, never to a pro
//     who already had it, up to the configured number of attempts; then support.
//  3. The setting can switch it off (dispatch assigns by hand, as before).
//  4. A1-20: staff cannot accept a proposal for the customer, nor a job for the pro.
//  5. The customer never sees a pro who only has an offer; payment notes stay internal.
//
// Own throwaway SQLite DB + server on :3475. No Stripe (deposits recorded by finance).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const TEST_DB = '/tmp/test-dispatch.db';
const BASE = 'http://localhost:3475';
for (const f of [TEST_DB, TEST_DB + '-shm', TEST_DB + '-wal']) { try { fs.unlinkSync(f); } catch (e) { /* fresh */ } }
Object.assign(process.env, { DB_PATH: TEST_DB, PORT: '3475', JWT_SECRET: 'dispatch-test-secret-0123456789abcdef01', AUTH_RATE_LIMIT_MAX: '5000', INTAKE_RATE_LIMIT_MAX: '5000' });
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
const rows = (sql, ...a) => db.prepare(sql).all(...a);
const ADMIN = 'owner.d@test.local';
const CUST = 'lena.d@test.local';

let owner, cust, custId;
const P = {}; // name -> { token, id, email }

async function makePro(key, name, email, { trade = 'painting', photo = true, rating = null } = {}) {
  await api('POST', '/api/auth/signup/contractor', { name, email, phone: '707-555-0' + (600 + Object.keys(P).length), password: 'Contractor123!', legal_name: name, city: 'Vallejo' });
  const token = (await api('POST', '/api/auth/login', { email, password: 'Contractor123!' })).data.token;
  const id = (await row('SELECT c.id FROM contractors c JOIN users u ON u.id = c.user_id WHERE u.email = ?', email)).id;
  await api('PATCH', `/api/contractors/${id}/verify`, { license_verified: true, insurance_verified: true, background_check: 'passed', status: 'active' }, owner);
  if (trade) assert.equal((await api('PATCH', '/api/contractors/me', { specialties: [trade] }, token)).status, 200);
  if (photo) {
    const f = new FormData(); f.append('photo', new Blob([PNG], { type: 'image/png' }), 'me.png');
    await api('POST', '/api/contractors/me/photo', f, token);
  }
  if (rating !== null) await db.prepare('UPDATE contractors SET rating_avg = ? WHERE id = ?').run(rating, id);
  P[key] = { token, id, email };
}

before(async () => {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) { /* retry */ } await new Promise((r) => setTimeout(r, 100)); }
  await db.prepare("INSERT INTO users (name, email, phone, password_hash, role, email_verified) VALUES ('Owner','owner.d@test.local','',?,'admin',1)").run(bcrypt.hashSync('Admin123!', 10));
  owner = (await api('POST', '/api/auth/login', { email: ADMIN, password: 'Admin123!' })).data.token;
  const c = await api('POST', '/api/auth/signup/customer', { name: '  Lena   Diaz ', email: CUST, phone: '707-555-0700', password: 'Customer123!' });
  custId = c.data.user.id;
  await db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(custId);
  cust = (await api('POST', '/api/auth/login', { email: CUST, password: 'Customer123!' })).data.token;
  // best → worst for painting: star (5.0), good (4.0); the rest must never get an automatic offer.
  await makePro('star', 'Sara Star', 'star.d@test.local', { rating: 5 });
  await makePro('good', 'Gabe Good', 'good.d@test.local', { trade: 'Painting', rating: 4 }); // trade match is case-insensitive
  await makePro('nophoto', 'Nico Nophoto', 'nophoto.d@test.local', { photo: false, rating: 5 });
  await makePro('plumber', 'Pia Plumber', 'plumber.d@test.local', { trade: 'plumbing', rating: 5 });
  await makePro('employee', 'Eli Employee', 'employee.d@test.local', { rating: 5 });
  await db.prepare("UPDATE contractors SET provider_type = 'employee' WHERE id = ?").run(P.employee.id);
});

// Quote accepted (no deposit yet). Returns the project id.
async function accepted() {
  const j = await api('POST', '/api/jobs', { name: 'Lena Diaz', phone: '707-555-0700', email: CUST, address: '9 Oak St', city: 'Vallejo', zip: '94590', service_type: 'painting', description: 'Paint the hallway.' }, cust);
  const q = await api('POST', '/api/quotes', { job_request_id: j.data.id, customer_price_cents: 50000, contractor_cost_cents: 30000 }, owner);
  await api('POST', `/api/quotes/${q.data.id}/send`, {}, owner);
  const r = await api('POST', `/api/quotes/${q.data.id}/respond`, { accept: true, terms_accepted: true }, cust);
  assert.equal(r.status, 200);
  return r.data.project_id;
}
const payDeposit = async (pid) => assert.equal((await api('POST', '/api/payments', { project_id: pid, kind: 'deposit', amount_cents: 15000 }, owner)).status, 201);
const proj = (pid) => row('SELECT * FROM projects WHERE id = ?', pid);
const events = (pid) => rows('SELECT contractor_id, event_type, detail FROM contractor_offer_events WHERE project_id = ? ORDER BY id', pid);
const setRules = async (values) => assert.equal((await api('PUT', '/api/admin/settings', { values }, owner)).status, 200);

test('C8: no offer before the deposit; the deposit triggers an automatic offer to the best pro', async () => {
  const pid = await accepted();
  assert.equal((await proj(pid)).contractor_id, null, 'nothing is offered while the deposit is pending');
  await payDeposit(pid);
  const p = await proj(pid);
  assert.equal(p.contractor_id, P.star.id, 'the best-ranked painter with a photo gets it');
  assert.equal(p.contractor_status, 'offered');
  assert.ok(p.offer_expires_at, 'the offer has its 24 h expiry');
  assert.deepEqual(await events(pid), [{ contractor_id: P.star.id, event_type: 'offered', detail: 'auto' }]);
  const mail = mailsTo(P.star.email, new RegExp(`New job offer .*#${pid}`));
  assert.equal(mail.length, 1, 'the pro gets the usual one-click offer');
  assert.ok(!/9 Oak St/.test(mail[0].html), 'city + ZIP only before accepting');
  assert.ok(await row("SELECT id FROM admin_audit WHERE action = 'project.auto_offered' AND entity_id = ?", pid));
  for (const k of ['nophoto', 'plumber', 'employee']) assert.equal(mailsTo(P[k].email, /New job offer/).length, 0, `${k} never gets an automatic offer`);

  // Golden rule: while it is only an offer the customer sees no pro at all.
  const seen = await api('GET', `/api/projects/${pid}`, undefined, cust);
  assert.equal(seen.status, 200);
  assert.equal(seen.data.contractor, null);
  assert.equal(seen.data.contractor_id, null);
  // Internal bookkeeping notes never reach the customer.
  assert.ok(seen.data.payments.length >= 1);
  for (const pay of seen.data.payments) assert.equal(pay.notes, undefined, 'payment notes stay with finance');
  const list = await api('GET', `/api/payments?project_id=${pid}`, undefined, cust);
  for (const pay of list.data) { assert.equal(pay.notes, undefined); assert.equal(pay.provider_ref, undefined); }

  // Once the pro accepts, the customer meets them (first name + initial, photo).
  assert.equal((await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: true, terms_accepted: true }, P.star.token)).status, 200);
  const after = await api('GET', `/api/projects/${pid}`, undefined, cust);
  assert.equal(after.data.contractor.display_name, 'Sara S.');
  assert.equal((await events(pid)).at(-1).event_type, 'accepted');
});

test('C8: declined → offered to the next pro; never twice to the same pro; then support', async () => {
  const pid = await accepted();
  await payDeposit(pid);
  assert.equal((await proj(pid)).contractor_id, P.star.id);
  const before = mailsTo(ADMIN, /declined/i).length;
  assert.equal((await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: false }, P.star.token)).status, 200);
  const p = await proj(pid);
  assert.equal(p.contractor_id, P.good.id, 're-offered automatically to the next pro');
  assert.equal(p.contractor_status, 'offered');
  assert.equal(mailsTo(ADMIN, /declined/i).length, before, 'support is not bothered when the re-offer went out');

  // The second pro declines too: nobody else fits → support, once.
  assert.equal((await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: false }, P.good.token)).status, 200);
  const p2 = await proj(pid);
  assert.equal(p2.contractor_id, null, 'not offered back to someone who declined');
  assert.equal(mailsTo(ADMIN, new RegExp(`No professional available automatically — project #${pid}`)).length, 1);
  assert.deepEqual((await events(pid)).map((e) => [e.contractor_id, e.event_type]), [
    [P.star.id, 'offered'], [P.star.id, 'declined'], [P.good.id, 'offered'], [P.good.id, 'declined'],
  ]);
  // Dispatch can still assign by hand (e.g. the pro who declined, after a call).
  assert.equal((await api('POST', `/api/projects/${pid}/assign`, { contractor_id: P.star.id }, owner)).status, 200);
  assert.equal((await events(pid)).at(-1).detail, 'manual');
});

test('C8: an expired offer is released by the sweep and offered to the next pro', async () => {
  const pid = await accepted();
  await payDeposit(pid);
  assert.equal((await proj(pid)).contractor_id, P.star.id);
  await db.prepare('UPDATE projects SET offer_expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', pid);
  assert.ok(await offers.releaseExpiredOffers() >= 1);
  const p = await proj(pid);
  assert.equal(p.contractor_id, P.good.id);
  assert.ok(p.offer_expires_at > new Date().toISOString(), 'a fresh 24 h offer');
  assert.deepEqual((await events(pid)).slice(0, 3).map((e) => [e.contractor_id, e.event_type]),
    [[P.star.id, 'offered'], [P.star.id, 'expired'], [P.good.id, 'offered']]);
  assert.equal(mailsTo(ADMIN, new RegExp(`Offer expired — project #${pid}`)).length, 0, 'no manual-assign email when the re-offer went out');
  // The expired pro's email link no longer works.
  const { token } = offers.offerLinks(pid, P.star.id);
  assert.notEqual((await api('POST', `/api/offers/${token}/respond`, { accept: true, terms_accepted: true })).status, 200);
});

test('C8: the attempts cap hands the job to support; switched off = dispatch by hand', async () => {
  await setRules({ auto_offer_max_attempts: 1 });
  const pid = await accepted();
  await payDeposit(pid);
  assert.equal((await proj(pid)).contractor_id, P.star.id);
  await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: false }, P.star.token);
  assert.equal((await proj(pid)).contractor_id, null, 'cap of 1 reached: no second automatic offer');
  assert.equal(mailsTo(ADMIN, new RegExp(`Automatic offers stopped after 1 attempt\\(s\\) — project #${pid}`)).length, 1);
  await setRules({ auto_offer_max_attempts: 3 });

  // Validation: on/off only; attempts 1..10.
  assert.equal((await api('PUT', '/api/admin/settings', { values: { auto_offer_enabled: 2 } }, owner)).status, 422);
  assert.equal((await api('PUT', '/api/admin/settings', { values: { auto_offer_max_attempts: 0 } }, owner)).status, 422);

  await setRules({ auto_offer_enabled: 0 });
  const pid2 = await accepted();
  await payDeposit(pid2);
  assert.equal((await proj(pid2)).contractor_id, null, 'off: nothing offered automatically');
  assert.equal((await api('POST', `/api/projects/${pid2}/assign`, { contractor_id: P.good.id }, owner)).status, 200);
  await api('POST', `/api/projects/${pid2}/contractor-respond`, { accept: false }, P.good.token);
  assert.equal((await proj(pid2)).contractor_id, null, 'off: no automatic re-offer either');
  assert.equal(mailsTo(ADMIN, new RegExp(`Contractor declined project #${pid2}`)).length, 1, 'off: support gets the usual decline email');
  await setRules({ auto_offer_enabled: 1 });
  const rules = (await api('GET', '/api/admin/settings', undefined, owner)).data.rules;
  assert.ok(rules.find((r) => r.key === 'auto_offer_enabled' && r.group === 'dispatch'));
});

test('C8: replacing a pending offer by hand closes the previous pro\'s offer', async () => {
  const pid = await accepted();
  await payDeposit(pid);
  assert.equal((await proj(pid)).contractor_id, P.star.id);
  assert.equal((await api('POST', `/api/projects/${pid}/assign`, { contractor_id: P.good.id }, owner)).status, 200);
  assert.deepEqual((await events(pid)).map((e) => [e.contractor_id, e.event_type, e.detail]), [
    [P.star.id, 'offered', 'auto'], [P.star.id, 'expired', 'replaced by dispatch'], [P.good.id, 'offered', 'manual'],
  ]);
  assert.equal((await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: true, terms_accepted: true }, P.star.token)).status, 403,
    'the replaced pro cannot answer any more');
  // Gates still apply to the manual path.
  assert.equal((await api('POST', `/api/projects/${pid}/assign`, { contractor_id: P.nophoto.id }, owner)).status, 409, 'no photo, no offer');
});

test('A1-20: staff cannot accept for the customer or for the pro', async () => {
  const j = await api('POST', '/api/jobs', { name: 'Lena Diaz', phone: '707-555-0700', email: CUST, address: '9 Oak St', city: 'Vallejo', zip: '94590', service_type: 'painting', description: 'Second room.' }, cust);
  const q = await api('POST', '/api/quotes', { job_request_id: j.data.id, customer_price_cents: 40000, contractor_cost_cents: 24000 }, owner);
  await api('POST', `/api/quotes/${q.data.id}/send`, {}, owner);
  const r = await api('POST', `/api/quotes/${q.data.id}/respond`, { accept: true, terms_accepted: true }, owner);
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'CUSTOMER_ONLY');
  assert.equal((await row('SELECT status FROM quotes WHERE id = ?', q.data.id)).status, 'sent', 'still waiting for the customer');
  assert.equal(await row("SELECT id FROM terms_acceptances WHERE kind = 'client_quote' AND reference_id = ?", q.data.id), undefined, 'no acceptance recorded under staff');
  // The customer can still accept it themselves.
  assert.equal((await api('POST', `/api/quotes/${q.data.id}/respond`, { accept: true, terms_accepted: true }, cust)).status, 200);

  const pid = await accepted();
  await payDeposit(pid);
  const s = await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: true, terms_accepted: true }, owner);
  assert.equal(s.status, 403);
  assert.equal(s.data.code, 'CONTRACTOR_ONLY');
  assert.equal((await proj(pid)).contractor_status, 'offered', 'the offer is untouched');
});

test('C8: greetings never come out as "Hi Ana ," or "Hi ,"', async () => {
  const { greetName, quoteAcceptedCustomer } = require('../src/services/notify');
  assert.equal(greetName('  Lena   Diaz '), 'Lena');
  assert.equal(greetName(''), 'there');
  const html = quoteAcceptedCustomer('Ana ', 1, 'painting');
  assert.ok(html.includes('Hi <strong>Ana</strong>,'));
  const welcome = mailsTo(CUST).map((m) => m.html).join(' ');
  assert.ok(!/Hi <strong>\s*<\/strong>|Hi\s+,/.test(welcome), 'no empty or spaced greeting to the customer whose name has extra spaces');
});
