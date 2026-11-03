// Helpman — Corte 4 tests: CRM Clients (directory + 9-tab profile + actions).
// Access by team role, derived lifecycle, guest requests linked by email, tags
// (VIP / blocked, and what "blocked" stops), notes, tasks, mediated email,
// request on behalf, resend access, consents, campaigns received, history, and
// the golden rule inside the profile.
//
// Own throwaway SQLite DB + server on :3467. No Stripe (deposits recorded by finance).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const TEST_DB = '/tmp/test-clients.db';
const BASE = 'http://localhost:3467';
for (const f of [TEST_DB, TEST_DB + '-shm', TEST_DB + '-wal']) { try { fs.unlinkSync(f); } catch (e) { /* fresh */ } }
process.env.DB_PATH = TEST_DB;
process.env.PORT = '3467';
process.env.JWT_SECRET = 'clients-test-secret-0123456789abcdef0123';
process.env.AUTH_RATE_LIMIT_MAX = '5000';
process.env.INTAKE_RATE_LIMIT_MAX = '5000';
delete process.env.DEV_AUTORECORD_DEPOSIT;
delete process.env.DATABASE_URL;
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET']) delete process.env[k];

const db = require('../src/db');
require('../server');
after(async () => { const s = await require('../server').listening; if (s) { s.closeAllConnections && s.closeAllConnections(); s.close(); } });

const mailer = require('../src/services/mailer');
const sent = [];
const realSend = mailer.send;
mailer.send = async (m) => { sent.push(m); return realSend(m); };
const mailsTo = (to, re) => sent.filter((m) => m.to === to && (!re || re.test(m.subject)));

async function api(method, p, body, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, data };
}
const row = (sql, ...a) => db.prepare(sql).get(...a);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let owner, support, support2, finance, cont, contractorId, supportId;
const C = {}; // name -> { id, token, email }

async function staff(name, email, role) {
  const info = await db.prepare("INSERT INTO users (name, email, phone, password_hash, role, email_verified, staff_role) VALUES (?,?,?,?,?,1,?)")
    .run(name, email, '', bcrypt.hashSync('Admin123!', 10), 'admin', role);
  return { id: info.lastInsertRowid, token: (await api('POST', '/api/auth/login', { email, password: 'Admin123!' })).data.token };
}
async function customer(key, name, email, phone) {
  const c = await api('POST', '/api/auth/signup/customer', { name, email, phone, password: 'Customer123!' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  await db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(c.data.user.id);
  C[key] = { id: c.data.user.id, email, phone, name, token: (await api('POST', '/api/auth/login', { email, password: 'Customer123!' })).data.token };
  return C[key];
}
const job = (c, extra = {}) => api('POST', '/api/jobs', { name: c.name, phone: c.phone, email: c.email, address: '1 Main St', city: 'Vallejo', zip: '94590', service_type: 'painting', description: 'Paint the hallway.', ...extra }, c.token);
async function quoteAccept(c, jobId) {
  const q = await api('POST', '/api/quotes', { job_request_id: jobId, customer_price_cents: 50000, contractor_cost_cents: 30000 }, owner);
  await api('POST', `/api/quotes/${q.data.id}/send`, {}, owner);
  return api('POST', `/api/quotes/${q.data.id}/respond`, { accept: true, terms_accepted: true }, c.token);
}

before(async () => {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) { /* retry */ } await new Promise((r) => setTimeout(r, 100)); }
  owner = (await staff('Olga Owner', 'owner.c@test.local', null)).token;
  const s = await staff('Sam Support', 'support.c@test.local', 'support'); support = s.token; supportId = s.id;
  support2 = (await staff('Sara Support', 'support2.c@test.local', 'support')).token;
  finance = (await staff('Fin Finance', 'finance.c@test.local', 'finance')).token;

  await api('POST', '/api/auth/signup/contractor', { name: 'Pedro Gomez', email: 'pedro.c@test.local', phone: '707-555-0300', password: 'Contractor123!', legal_name: 'Pedro Gomez', city: 'Vallejo' });
  cont = (await api('POST', '/api/auth/login', { email: 'pedro.c@test.local', password: 'Contractor123!' })).data.token;
  contractorId = (await row(`SELECT c.id FROM contractors c JOIN users u ON u.id = c.user_id WHERE u.email = 'pedro.c@test.local'`)).id;
  await api('PATCH', `/api/contractors/${contractorId}/verify`, { license_verified: true, insurance_verified: true, background_check: 'passed', status: 'active' }, owner);
  const f = new FormData(); f.append('photo', new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }), 'me.png');
  await fetch(BASE + '/api/contractors/me/photo', { method: 'POST', headers: { Authorization: 'Bearer ' + cont }, body: f });

  // lead: account only
  await customer('lead', 'Lena Lead', 'lena.c@test.local', '707-555-0101');
  // prospect: one request
  await customer('pros', 'Paco Prospect', 'paco.c@test.local', '707-555-0102');
  assert.equal((await job(C.pros)).status, 201);
  // active: deposit paid (recorded by finance), assigned to the pro
  await customer('act', 'Ana Active', 'ana.c@test.local', '707-555-0103');
  const ja = await job(C.act, { city: 'Benicia', zip: '94510' });
  const acc = await quoteAccept(C.act, ja.data.id);
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  C.act.project = acc.data.project_id;
  assert.equal((await api('POST', '/api/payments', { project_id: C.act.project, kind: 'deposit', amount_cents: 15000, notes: 'Zelle' }, owner)).status, 201);
  assert.equal((await api('POST', `/api/projects/${C.act.project}/assign`, { contractor_id: contractorId }, owner)).status, 200);
  // customer: a completed project
  await customer('done', 'Carlos Done', 'carlos.c@test.local', '707-555-0104');
  const jd = await job(C.done);
  const accd = await quoteAccept(C.done, jd.data.id);
  await api('POST', '/api/payments', { project_id: accd.data.project_id, kind: 'deposit', amount_cents: 15000 }, owner);
  await db.prepare(`UPDATE projects SET stage = 'completed' WHERE id = ?`).run(accd.data.project_id);
  // lost: request long ago, nothing since
  await customer('lost', 'Luis Lost', 'luis.c@test.local', '707-555-0105');
  const jl = await job(C.lost);
  const old = '2025-01-01 10:00:00';
  await db.prepare('UPDATE job_requests SET created_at = ?, updated_at = ? WHERE id = ?').run(old, old, jl.data.id);
  await db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(old, C.lost.id);
  // guest request sent before the account existed, same email as the lead
  assert.equal((await api('POST', '/api/jobs', { name: 'Lena Lead', phone: '707-555-0101', email: 'LENA.C@test.local', address: '9 Pine', city: 'Fairfield', service_type: 'plumbing', description: 'Leaky sink.' })).status, 201);
});

const get = (id, tab, token) => api('GET', `/api/clients/${id}${tab ? '/' + tab : ''}`, undefined, token);

test('C4: only the team sees clients; money only for finance, actions only for support', async () => {
  assert.equal((await api('GET', '/api/clients', undefined, C.act.token)).status, 403, 'customers cannot');
  assert.equal((await api('GET', '/api/clients', undefined, cont)).status, 403, 'pros cannot');
  assert.equal((await api('GET', '/api/clients')).status, 401);

  const sup = await api('GET', '/api/clients', undefined, support);
  assert.equal(sup.status, 200);
  assert.equal(sup.data.rows[0].spend_cents, undefined, 'support sees no money');
  assert.equal((await get(C.act.id, 'money', support)).status, 403);
  assert.equal((await get(C.act.id, '', support)).data.balance_due_cents, undefined);

  const fin = await api('GET', '/api/clients', undefined, finance);
  assert.equal(fin.status, 200);
  assert.equal(typeof fin.data.rows[0].spend_cents, 'number');
  const m = await get(C.act.id, 'money', finance);
  assert.equal(m.status, 200);
  assert.equal(m.data.totals.paid_cents, 15000);
  assert.equal(m.data.totals.balance_due_cents, 35000);
  assert.ok(!JSON.stringify(m.data).includes('pm_'), 'never the Stripe payment method id');
  assert.equal((await get(C.act.id, 'notes', finance)).status, 403, 'finance has no CRM actions/notes');
  assert.equal((await api('POST', `/api/clients/${C.act.id}/notes`, { body: 'x' }, finance)).status, 403);
  assert.equal((await get(99999, '', owner)).status, 404);
  const proId = (await row(`SELECT user_id FROM contractors WHERE id = ?`, contractorId)).user_id;
  assert.equal((await get(proId, '', owner)).status, 404, 'a pro is not a client');
});

test('C4: lifecycle, counts, search, filters, sort and pages', async () => {
  const all = (await api('GET', '/api/clients?per_page=200', undefined, owner)).data;
  const lc = (k) => all.rows.find((r) => r.id === C[k].id).lifecycle;
  assert.equal(lc('lead'), 'prospect', 'the guest request (same email) counts for the account');
  assert.equal(lc('pros'), 'prospect');
  assert.equal(lc('act'), 'active');
  assert.equal(lc('done'), 'customer');
  assert.equal(lc('lost'), 'lost');
  assert.equal(all.rows.find((r) => r.id === C.lead.id).requests, 1, 'guest request linked by email (case-insensitive)');
  assert.equal(all.counts.active, 1);

  const q = (s) => api('GET', '/api/clients?' + s, undefined, support).then((r) => r.data);
  assert.deepEqual((await q('q=carlos')).rows.map((r) => r.id), [C.done.id]);
  assert.deepEqual((await q('q=555-0103')).rows.map((r) => r.id), [C.act.id], 'search by phone digits');
  assert.deepEqual((await q(`q=%23${C.lost.id}`)).rows.map((r) => r.id), [C.lost.id], 'search by #id');
  assert.deepEqual((await q('lifecycle=lost')).rows.map((r) => r.id), [C.lost.id]);
  assert.deepEqual((await q('city=94510')).rows.map((r) => r.id), [C.act.id], 'ZIP filter');
  assert.deepEqual((await q('city=benicia')).rows.map((r) => r.id), [C.act.id], 'city filter');
  const p1 = await q('per_page=2&page=1&sort=name'), p2 = await q('per_page=2&page=2&sort=name');
  assert.equal(p1.rows.length, 2); assert.equal(p1.total, 5);
  assert.ok(p1.rows[0].name < p2.rows[0].name, 'sorted by name across pages');
});

test('C4: tags — VIP and blocked; a blocked client cannot open requests or accept quotes', async () => {
  const t = (body, tok = support) => api('POST', `/api/clients/${C.pros.id}/tags`, body, tok);
  assert.equal((await t({ add: ['no spaces!'] })).status, 422);
  assert.deepEqual((await t({ add: ['vip', 'Repeat Client'] })).data.tags, ['repeat-client', 'vip']);
  assert.equal((await t({ add: Array.from({ length: 9 }, (_, i) => 'x' + i) })).status, 422, 'max 10 tags');
  assert.deepEqual((await api('GET', '/api/clients?tag=vip', undefined, support)).data.rows.map((r) => r.id), [C.pros.id]);

  // a quote waiting for the client, then block
  const jid = (await row('SELECT id FROM job_requests WHERE customer_id = ?', C.pros.id)).id;
  const qq = await api('POST', '/api/quotes', { job_request_id: jid, customer_price_cents: 40000, contractor_cost_cents: 20000 }, owner);
  await api('POST', `/api/quotes/${qq.data.id}/send`, {}, owner);
  assert.deepEqual((await t({ add: ['blocked'] })).data.tags, ['blocked', 'repeat-client', 'vip']);
  const nj = await job(C.pros);
  assert.equal(nj.status, 403); assert.equal(nj.data.code, 'CLIENT_BLOCKED');
  const guest = await api('POST', '/api/jobs', { name: 'Paco', phone: '707-555-0102', email: 'paco.c@test.local', address: '2 Main', service_type: 'painting', description: 'Again, as a guest.' });
  assert.equal(guest.status, 403, 'not as a guest with the same email either');
  const acc = await api('POST', `/api/quotes/${qq.data.id}/respond`, { accept: true, terms_accepted: true }, C.pros.token);
  assert.equal(acc.status, 403); assert.equal(acc.data.code, 'CLIENT_BLOCKED');
  assert.equal((await api('POST', `/api/clients/${C.pros.id}/requests`, { address: '3 Main', service_type: 'painting', description: 'By phone.' }, support)).status, 409);
  assert.equal((await get(C.pros.id, '', support)).data.blocked, true);
  assert.ok(await row(`SELECT id FROM admin_audit WHERE action = 'client.blocked' AND entity = 'clients' AND entity_id = ?`, C.pros.id));

  await t({ remove: ['blocked'] });
  assert.equal((await job(C.pros)).status, 201, 'unblocked: works again');
  assert.ok(await row(`SELECT id FROM admin_audit WHERE action = 'client.unblocked' AND entity_id = ?`, C.pros.id));
  const tags = (await api('GET', '/api/clients/tags', undefined, support)).data;
  assert.ok(tags.find((x) => x.tag === 'vip').count >= 1);
  assert.ok(tags.find((x) => x.tag === 'blocked'), 'blocked is always offered');
});

test('C4: internal notes — pinned to the summary, only the author or an owner deletes, all audited', async () => {
  assert.equal((await api('POST', `/api/clients/${C.act.id}/notes`, { body: '   ' }, support)).status, 422);
  const n = await api('POST', `/api/clients/${C.act.id}/notes`, { body: 'Prefers morning visits. Has a dog.', pinned: true }, support);
  assert.equal(n.status, 201);
  const s = (await get(C.act.id, '', support)).data;
  assert.equal(s.pinned_notes[0].body, 'Prefers morning visits. Has a dog.');
  assert.equal((await api('PATCH', `/api/clients/${C.act.id}/notes/${n.data.id}`, { pinned: false }, support)).status, 200);
  assert.equal((await get(C.act.id, '', support)).data.pinned_notes.length, 0);
  assert.equal((await api('DELETE', `/api/clients/${C.act.id}/notes/${n.data.id}`, undefined, support2)).status, 403, 'another support user cannot delete');
  assert.equal((await api('DELETE', `/api/clients/${C.lead.id}/notes/${n.data.id}`, undefined, owner)).status, 404, 'note must belong to that client');
  assert.equal((await api('DELETE', `/api/clients/${C.act.id}/notes/${n.data.id}`, undefined, owner)).status, 200, 'an owner can');
  assert.ok(await row(`SELECT id FROM admin_audit WHERE action = 'client.note_deleted' AND entity_id = ? AND details LIKE 'Prefers%'`, C.act.id));
  // the client never sees notes anywhere
  const mine = JSON.stringify((await api('GET', `/api/projects/${C.act.project}`, undefined, C.act.token)).data);
  assert.ok(!/Prefers morning/.test(mine));
});

test('C4: tasks — assigned with an email, validated, done/reopen; automatic tasks of the client show too', async () => {
  assert.equal((await api('POST', `/api/clients/${C.act.id}/tasks`, { title: 'Call back', assigned_to: C.act.id }, support)).status, 422, 'only team members');
  assert.equal((await api('POST', `/api/clients/${C.act.id}/tasks`, { title: 'Call back', due_at: 'tomorrow-ish' }, support)).status, 422);
  const t = await api('POST', `/api/clients/${C.act.id}/tasks`, { title: 'Call to confirm the color', due_at: '2026-11-20', assigned_to: supportId }, owner);
  assert.equal(t.status, 201, JSON.stringify(t.data));
  assert.equal(mailsTo('support.c@test.local', /New task for you/).length, 1);
  const jid = (await row('SELECT id FROM job_requests WHERE customer_id = ?', C.act.id)).id;
  await db.prepare(`INSERT INTO followup_tasks (job_request_id, kind, title) VALUES (?, 'quote_followup', 'Follow up quote')`).run(jid);
  let list = (await get(C.act.id, 'tasks', support)).data;
  assert.equal(list.length, 2);
  assert.equal(list.find((x) => x.id === t.data.id).assigned_name, 'Sam Support');
  assert.equal((await api('PATCH', `/api/clients/${C.act.id}/tasks/${t.data.id}`, { status: 'done' }, support)).status, 200);
  assert.equal((await api('PATCH', `/api/clients/${C.lead.id}/tasks/${t.data.id}`, { status: 'done' }, support)).status, 404, "not another client's task");
  list = (await get(C.act.id, 'tasks', support)).data;
  assert.equal(list.find((x) => x.id === t.data.id).status, 'done');
  assert.equal((await get(C.act.id, '', support)).data.open_tasks, 1);
});

test('C4: messages — email from support is logged in the file; project conversations are listed; golden rule holds', async () => {
  assert.equal((await api('POST', `/api/clients/${C.lead.id}/email`, { subject: '', body: 'hi' }, support)).status, 422);
  const e = await api('POST', `/api/clients/${C.lead.id}/email`, { subject: 'About your sink', body: 'Hi! We can visit Thursday.\n\nThanks.' }, support);
  assert.equal(e.status, 201);
  const m = mailsTo('lena.c@test.local', /About your sink/);
  assert.equal(m.length, 1);
  assert.match(m[0].html, /We can visit Thursday/);
  assert.ok(await row(`SELECT id FROM email_log WHERE to_email = 'lena.c@test.local' AND subject = 'About your sink'`));
  const tab = (await get(C.lead.id, 'messages', support)).data;
  assert.equal(tab.emails[0].subject, 'About your sink');

  const th = await api('POST', `/api/projects/${C.act.project}/threads`, { kind: 'client_support' }, support);
  await api('POST', `/api/threads/${th.data.id}/messages`, { body: 'Your pro is confirmed.' }, support);
  const conv = (await get(C.act.id, 'messages', support)).data;
  assert.equal(conv.threads[0].messages[0].body, 'Your pro is confirmed.');
  assert.ok(!conv.threads.some((x) => x.kind === 'support_contractor'), 'only the client conversation');

  // Profile shows the pro as "First L." only — never contact details.
  const work = JSON.stringify((await get(C.act.id, 'work', support)).data);
  assert.match(work, /Pedro G\./);
  assert.ok(!/pedro\.c@test\.local|707-555-0300|Gomez/.test(work));
});

test('C4: new request for the client — validated, linked to the account, client emailed, audited', async () => {
  const bad = await api('POST', `/api/clients/${C.done.id}/requests`, { service_type: 'nope', address: '', description: '' }, support);
  assert.equal(bad.status, 422);
  assert.ok(bad.data.errors.service_type && bad.data.errors.address && bad.data.errors.description);
  const r = await api('POST', `/api/clients/${C.done.id}/requests`, { service_type: 'plumbing', address: '7 Oak', city: 'Vallejo', zip: '94590', description: 'Kitchen faucet drips.' }, support);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const j = await row('SELECT * FROM job_requests WHERE id = ?', r.data.id);
  assert.equal(j.customer_id, C.done.id);
  assert.equal(j.email, 'carlos.c@test.local');
  assert.equal(j.phone, '707-555-0104', 'defaults to the account phone');
  assert.equal(mailsTo('carlos.c@test.local', new RegExp(`We created your request — #${r.data.id}`)).length, 1);
  assert.ok(await row(`SELECT id FROM admin_audit WHERE action = 'client.request_created' AND entity_id = ?`, C.done.id));
  const mine = await api('GET', '/api/jobs/mine/list', undefined, C.done.token);
  assert.equal(mine.status, 200);
  assert.ok(mine.data.some((x) => x.id === r.data.id), 'the client sees it in the portal');
});

test('C4: resend access — reset link (and verification if needed), throttled, audited', async () => {
  await db.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run(C.lost.id);
  const r = await api('POST', `/api/clients/${C.lost.id}/resend-access`, {}, support);
  assert.equal(r.status, 201);
  assert.equal(r.data.verification_sent, true);
  const u = await row('SELECT reset_token, verify_token FROM users WHERE id = ?', C.lost.id);
  assert.ok(u.reset_token && u.verify_token);
  assert.equal(mailsTo('luis.c@test.local', /access link/).length, 1);
  assert.match(mailsTo('luis.c@test.local', /access link/)[0].html, new RegExp(u.reset_token));
  assert.equal((await api('POST', `/api/clients/${C.lost.id}/resend-access`, {}, support)).status, 429, 'once every 10 minutes');
  const reset = await api('POST', '/api/auth/reset', { token: u.reset_token, password: 'NewPass123!' });
  assert.equal(reset.status, 200, 'the link works');
});

test('C4: consents & communications, campaigns received, history', async () => {
  await require('../src/services/sms').setConsent('707-555-0103', true, 'request_form');
  const c = (await get(C.act.id, 'consents', support)).data;
  assert.equal(c.sms[0].opted_in, true);
  assert.equal(c.email.marketing.unsubscribed, false);
  assert.equal(c.terms[0].kind, 'client_quote', 'quote terms acceptance is listed');
  assert.ok(c.communications.emails.length > 0);
  assert.equal((await api('POST', `/api/clients/${C.act.id}/marketing-unsubscribe`, {}, support)).status, 201);
  assert.equal((await get(C.act.id, 'consents', support)).data.email.marketing.unsubscribed, true);
  assert.equal((await get(C.act.id, '', support)).data.marketing_unsubscribed, true);

  const camp = await db.prepare(`INSERT INTO campaigns (name, segment, status) VALUES ('Fall promo', 'all_customers', 'done')`).run();
  await db.prepare(`INSERT INTO email_outbox (campaign_id, to_email, subject, body_html, status, sent_at) VALUES (?, 'ana.c@test.local', 'Fall is here', '<p>x</p>', 'sent', CURRENT_TIMESTAMP)`).run(camp.lastInsertRowid);
  const cr = (await get(C.act.id, 'campaigns', support)).data;
  assert.equal(cr[0].campaign, 'Fall promo');

  const h = (await get(C.act.id, 'history', support)).data;
  const kinds = new Set(h.map((e) => e.kind));
  for (const k of ['account', 'request', 'quote', 'payment', 'project', 'staff', 'campaign']) assert.ok(kinds.has(k), 'history has ' + k);
  assert.ok(h.some((e) => /marketing unsubscribed/.test(e.text)));
  for (let i = 1; i < h.length; i++) assert.ok(String(h[i - 1].at) >= String(h[i].at), 'newest first');
});

test('C4: the admin page ships the client directory', async () => {
  const html = await (await fetch(BASE + '/admin.html')).text();
  assert.match(html, /id="client-directory"/);
  assert.match(html, /js\/clients-v1\.js/);
  assert.equal((await fetch(BASE + '/js/clients-v1.js')).status, 200);
});
