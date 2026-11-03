// Helpman — Corte 5 tests: CRM Campaigns.
// Segment builder (filters, exclusions, saved segments with live counts), the
// message (variables, escaping, button, unsubscribe footer), preview and test
// send, send now with count confirmation, schedule / unschedule / cancel,
// results (sent, failed, skipped, unsubscribed, delivered/open/click/bounce from
// the provider webhook), contractors as an audience, and who may do it.
//
// Own throwaway SQLite DB + server on :3469. Console mail provider, captured.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const TEST_DB = '/tmp/test-campaigns.db';
const BASE = 'http://localhost:3469';
for (const f of [TEST_DB, TEST_DB + '-shm', TEST_DB + '-wal']) { try { fs.unlinkSync(f); } catch (e) { /* fresh */ } }
process.env.DB_PATH = TEST_DB;
process.env.PORT = '3469';
process.env.JWT_SECRET = 'campaigns-test-secret-0123456789abcdef01';
process.env.AUTH_RATE_LIMIT_MAX = '5000';
process.env.INTAKE_RATE_LIMIT_MAX = '5000';
process.env.SENDGRID_WEBHOOK_KEY = 'sg-test-key-123';
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
const svc = require('../src/services/campaigns');

async function api(method, p, body, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, data };
}
const row = (sql, ...a) => db.prepare(sql).get(...a);
const rows = (sql, ...a) => db.prepare(sql).all(...a);

let owner, support, finance;
const C = {};
async function staff(name, email, role) {
  await db.prepare("INSERT INTO users (name, email, phone, password_hash, role, email_verified, staff_role) VALUES (?,?,?,?,?,1,?)")
    .run(name, email, '', bcrypt.hashSync('Admin123!', 10), 'admin', role);
  return (await api('POST', '/api/auth/login', { email, password: 'Admin123!' })).data.token;
}
async function customer(key, name, email, phone, job) {
  const c = await api('POST', '/api/auth/signup/customer', { name, email, phone, password: 'Customer123!' });
  await db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(c.data.user.id);
  C[key] = { id: c.data.user.id, email, name, token: (await api('POST', '/api/auth/login', { email, password: 'Customer123!' })).data.token };
  if (job) {
    const j = await api('POST', '/api/jobs', { name, phone, email, address: '1 Main St', city: job.city || 'Vallejo', zip: job.zip || '94590', service_type: job.service || 'painting', description: 'Some work please.' }, C[key].token);
    C[key].job = j.data.id;
  }
  return C[key];
}
const camp = (extra, tok = support) => api('POST', '/api/campaigns', { name: 'Fall tune-up', subject: 'Hi {{first_name}}, fall is here', body_text: 'Hello {{first_name}} in {{city}}!\n\nYour last service: **{{last_service}}**.\nSee https://helpman.app/offers', button_label: 'Book now', button_url: '/', filters: { lifecycle: ['customer'] }, ...extra }, tok);

before(async () => {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) { /* retry */ } await new Promise((r) => setTimeout(r, 100)); }
  owner = await staff('Olga Owner', 'owner.k@test.local', null);
  support = await staff('Sam Support', 'support.k@test.local', 'support');
  finance = await staff('Fin Finance', 'finance.k@test.local', 'finance');

  // customers with a completed project (one in Benicia with plumbing, one with a dangerous name)
  for (const [k, name, email, job] of [['cust1', 'Carla Customer', 'carla.k@test.local', { service: 'plumbing', city: 'Benicia', zip: '94510' }],
    ['cust2', '<b>Evil</b> Eve', 'eve.k@test.local', {}], ['cust3', 'Cris Customer', 'cris.k@test.local', {}]]) {
    await customer(k, name, email, '707-555-02' + String(Object.keys(C).length).padStart(2, '0'), job);
    const q = await api('POST', '/api/quotes', { job_request_id: C[k].job, customer_price_cents: 40000, contractor_cost_cents: 20000 }, owner);
    await api('POST', `/api/quotes/${q.data.id}/send`, {}, owner);
    const acc = await api('POST', `/api/quotes/${q.data.id}/respond`, { accept: true, terms_accepted: true }, C[k].token);
    await api('POST', '/api/payments', { project_id: acc.data.project_id, kind: 'deposit', amount_cents: 12000 }, owner);
    await db.prepare(`UPDATE projects SET stage = 'completed' WHERE id = ?`).run(acc.data.project_id);
  }
  await customer('pros', 'Pia Prospect', 'pia.k@test.local', '707-555-0290', { service: 'painting' });
  await customer('lead', 'Leo Lead', 'leo.k@test.local', '707-555-0291');
  // blocked customer and an unsubscribed customer (both "customer" lifecycle → excluded)
  await customer('blk', 'Bob Blocked', 'bob.k@test.local', '707-555-0292', {});
  const qb = await api('POST', '/api/quotes', { job_request_id: C.blk.job, customer_price_cents: 40000, contractor_cost_cents: 20000 }, owner);
  await api('POST', `/api/quotes/${qb.data.id}/send`, {}, owner);
  const ab = await api('POST', `/api/quotes/${qb.data.id}/respond`, { accept: true, terms_accepted: true }, C.blk.token);
  await db.prepare(`UPDATE projects SET stage = 'completed' WHERE id = ?`).run(ab.data.project_id);
  await api('POST', `/api/clients/${C.blk.id}/tags`, { add: ['blocked'] }, support);
  await require('../src/services/unsubscribe').suppress('cris.k@test.local', 'test');
  await api('POST', `/api/clients/${C.cust1.id}/tags`, { add: ['vip'] }, support);
  // a guest (no account) who asked for a quote
  await api('POST', '/api/jobs', { name: 'Gina Guest', phone: '707-555-0293', email: 'gina.k@test.local', address: '5 Elm', city: 'Napa', service_type: 'roofing', description: 'Roof leak.' });
  // a pro
  await api('POST', '/api/auth/signup/contractor', { name: 'Paul Pro', email: 'paul.k@test.local', phone: '707-555-0299', password: 'Contractor123!', legal_name: 'Paul Pro', city: 'Vallejo' });
});

test('C5: only marketing roles (owner, support) run campaigns', async () => {
  assert.equal((await api('POST', '/api/campaigns/audience', { filters: {} }, finance)).status, 403);
  assert.equal((await api('POST', '/api/campaigns/audience', { filters: {} }, C.cust1.token)).status, 403);
  assert.equal((await api('POST', '/api/campaigns/audience', { filters: {} })).status, 401);
  assert.equal((await api('POST', '/api/campaigns/audience', { filters: {} }, support)).status, 200);
});

test('C5: segment builder — filters, guests, exclusions always applied', async () => {
  const a = (filters) => api('POST', '/api/campaigns/audience', { filters }, support).then((r) => r.data);
  const all = await a({});
  const emails = all.sample.map((m) => m.email);
  assert.ok(emails.includes('gina.k@test.local'), 'guests are included by default');
  assert.ok(!emails.includes('bob.k@test.local'), 'blocked clients never');
  assert.ok(!emails.includes('cris.k@test.local'), 'unsubscribed never');
  assert.ok(!emails.includes('paul.k@test.local'), 'pros are not clients');
  assert.equal(all.excluded.blocked, 1);
  assert.equal(all.excluded.unsubscribed, 1);
  assert.equal(all.count, 5, 'carla, eve, pia, leo, gina');

  assert.equal((await a({ lifecycle: ['customer'] })).count, 2, 'carla + eve');
  assert.equal((await a({ include_guests: false })).count, 4);
  assert.deepEqual((await a({ places: ['94510'] })).sample.map((m) => m.email), ['carla.k@test.local']);
  assert.deepEqual((await a({ places: ['napa'] })).sample.map((m) => m.email), ['gina.k@test.local']);
  assert.deepEqual((await a({ services: ['plumbing'] })).sample.map((m) => m.email), ['carla.k@test.local']);
  assert.deepEqual((await a({ tags_any: ['vip'] })).sample.map((m) => m.email), ['carla.k@test.local']);
  assert.equal((await a({ tags_none: ['vip'], lifecycle: ['customer'] })).count, 1);
  assert.equal((await a({ jobs_min: 1 })).count, 2);
  assert.equal((await a({ spend_min_cents: 10000 })).count, 2);
  assert.equal((await a({ inactive_days_min: 30 })).count, 0, 'everyone is recent');
  assert.equal((await a({ active_within_days: 30 })).count, 5);

  const bad = await api('POST', '/api/campaigns/audience', { filters: { lifecycle: ['vip'], jobs_min: -1, nope: 1 } }, support);
  assert.equal(bad.status, 422);
  assert.ok(bad.data.errors.lifecycle && bad.data.errors.jobs_min && bad.data.errors.nope);

  const pros = await a({ audience: 'contractors', contractor_status: ['pending'] });
  assert.deepEqual(pros.sample.map((m) => m.email), ['paul.k@test.local'], 'pros can be an audience too');
});

test('C5: saved segments with live counts; a scheduled campaign protects its segment', async () => {
  assert.equal((await api('POST', '/api/campaigns/segments', { name: '', filters: {} }, support)).status, 422);
  const s = await api('POST', '/api/campaigns/segments', { name: 'Past customers', filters: { lifecycle: ['customer'] } }, support);
  assert.equal(s.status, 201);
  let list = (await api('GET', '/api/campaigns/segments', undefined, support)).data;
  assert.equal(list.find((x) => x.id === s.data.id).count, 2);
  assert.equal((await api('PUT', `/api/campaigns/segments/${s.data.id}`, { name: 'Past customers in Benicia', filters: { lifecycle: ['customer'], places: ['benicia'] } }, support)).status, 200);
  list = (await api('GET', '/api/campaigns/segments', undefined, support)).data;
  assert.equal(list.find((x) => x.id === s.data.id).count, 1, 'count is live');
  const c = await camp({ filters: undefined, segment_id: s.data.id });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal((await api('POST', `/api/campaigns/${c.data.id}/schedule`, { at: new Date(Date.now() + 3600e3).toISOString() }, support)).status, 200);
  assert.equal((await api('DELETE', `/api/campaigns/segments/${s.data.id}`, undefined, support)).status, 409);
  await api('POST', `/api/campaigns/${c.data.id}/unschedule`, {}, support);
  assert.equal((await api('DELETE', `/api/campaigns/segments/${s.data.id}`, undefined, support)).status, 200);
  assert.ok(await row(`SELECT id FROM admin_audit WHERE action = 'segment.deleted'`));
});

test('C5: message — validated, variables filled and escaped, button, unsubscribe; preview and test go only to staff', async () => {
  const bad = await camp({ subject: 'Hi {{frist_name}}', button_url: 'javascript:alert(1)' });
  assert.equal(bad.status, 422);
  assert.match(bad.data.errors.subject, /Unknown variable \{\{frist_name\}\}/);
  assert.ok(bad.data.errors.button_url);
  const c = await camp({ name: 'Preview me' });
  assert.equal(c.status, 201);
  const p = await api('POST', `/api/campaigns/${c.data.id}/preview`, { recipient_email: 'eve.k@test.local' }, support);
  assert.equal(p.status, 200);
  assert.equal(p.data.audience_count, 2);
  assert.equal(p.data.subject, 'Hi <b>Evil</b>, fall is here', 'subject is plain text');
  assert.ok(!/<b>Evil/.test(p.data.html), 'a name never injects markup in the email');
  assert.match(p.data.html, /Hello &lt;b&gt;Evil&lt;\/b&gt; in Vallejo!/);
  assert.match(p.data.html, /<strong>Painting<\/strong>/, 'bold + last service label');
  assert.match(p.data.html, /<a href="https:\/\/helpman\.app\/offers"/, 'links');
  assert.match(p.data.html, />Book now</);
  assert.match(p.data.html, /\/api\/unsubscribe\?e=/);
  const before = sent.length;
  const t = await api('POST', `/api/campaigns/${c.data.id}/test`, {}, support);
  assert.equal(t.status, 200);
  assert.equal(t.data.to, 'support.k@test.local');
  const news = sent.slice(before);
  assert.equal(news.length, 1, 'only the test email');
  assert.equal(news[0].to, 'support.k@test.local');
  assert.match(news[0].subject, /^\[TEST\] Hi /);
  assert.equal((await row('SELECT COUNT(*) c FROM email_outbox WHERE campaign_id = ?', c.data.id)).c, 0, 'a test never touches the outbox');
});

test('C5: send now — the confirmed count must match; each person once, personalized, then results', async () => {
  const c = await camp({ name: 'Customers fall', filters: { lifecycle: ['customer'] } });
  const wrong = await api('POST', `/api/campaigns/${c.data.id}/send-now`, { expected_count: 7 }, support);
  assert.equal(wrong.status, 409);
  assert.equal(wrong.data.code, 'AUDIENCE_CHANGED');
  assert.equal(wrong.data.count, 2);
  const before = sent.length;
  const ok = await api('POST', `/api/campaigns/${c.data.id}/send-now`, { expected_count: 2 }, support);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.recipients, 2);
  const out = sent.slice(before);
  assert.deepEqual(out.map((m) => m.to).sort(), ['carla.k@test.local', 'eve.k@test.local']);
  const carla = out.find((m) => m.to === 'carla.k@test.local');
  assert.equal(carla.subject, 'Hi Carla, fall is here');
  assert.match(carla.html, /in Benicia/);
  assert.match(carla.html, /Plumbing/);
  assert.ok(carla.customArgs && carla.customArgs.outbox_id, 'provider gets the outbox id for its events');
  assert.match(carla.headers['List-Unsubscribe'], new RegExp(`&o=${carla.customArgs.outbox_id}`), 'one-click unsubscribe tied to the email');
  assert.equal((await row('SELECT status, completed_at FROM campaigns WHERE id = ?', c.data.id)).status, 'done');
  assert.equal((await api('POST', `/api/campaigns/${c.data.id}/send-now`, { expected_count: 2 }, support)).status, 409, 'never twice');
  assert.equal((await api('PUT', `/api/campaigns/${c.data.id}`, { name: 'x', subject: 'x', body_text: 'x', filters: {} }, support)).status, 409, 'no edits after sending');

  // the provider reports back (SendGrid event webhook)
  const oid = carla.customArgs.outbox_id;
  const ev = (event, extra = {}) => ({ email: 'carla.k@test.local', event, outbox_id: String(oid), timestamp: Math.floor(Date.now() / 1000), ...extra });
  const hook = await fetch(`${BASE}/api/email/events?key=sg-test-key-123`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([ev('delivered'), ev('open'), ev('open'), ev('click'), ev('delivered', { email: 'someone@else.test' })]) });
  assert.equal((await hook.json()).recorded, 4, 'an event with another email is ignored');
  // Eve unsubscribes from the link in that email
  const eveRow = await row(`SELECT id FROM email_outbox WHERE campaign_id = ? AND to_email = 'eve.k@test.local'`, c.data.id);
  const unsub = require('../src/services/unsubscribe');
  const u = await fetch(unsub.link('eve.k@test.local', eveRow.id).replace(/^https?:\/\/[^/]+/, BASE), { method: 'POST' });
  assert.equal(u.status, 200);
  const r = (await api('GET', `/api/campaigns/${c.data.id}/results`, undefined, support)).data;
  assert.equal(r.totals.recipients, 2);
  assert.equal(r.totals.sent, 2);
  assert.equal(r.totals.delivered, 1);
  assert.equal(r.totals.opened, 1);
  assert.equal(r.totals.clicked, 1);
  assert.equal(r.totals.unsubscribed, 1);
  assert.equal(r.rows.find((x) => x.to_email === 'carla.k@test.local').open_count, 2);
  assert.equal(r.tracking, false, 'console mode: opens/clicks only when SendGrid is plugged in');
  assert.ok(await unsub.isSuppressed('eve.k@test.local'));
  // The client profile (Corte 4) lists the campaign
  const prof = (await api('GET', `/api/clients/${C.cust1.id}/campaigns`, undefined, support)).data;
  assert.equal(prof[0].campaign, 'Customers fall');
});

test('C5: schedule → launches on time; unschedule; cancel stops what has not gone out; failures go back to draft', async () => {
  const c = await camp({ name: 'Scheduled one', filters: { lifecycle: ['prospect', 'lead'] } });
  assert.equal((await api('POST', `/api/campaigns/${c.data.id}/schedule`, { at: new Date(Date.now() - 60e3).toISOString() }, support)).status, 422);
  assert.equal((await api('POST', `/api/campaigns/${c.data.id}/schedule`, { at: 'soon' }, support)).status, 422);
  const at = new Date(Date.now() + 2 * 3600e3);
  const s = await api('POST', `/api/campaigns/${c.data.id}/schedule`, { at: at.toISOString() }, support);
  assert.equal(s.data.status, 'scheduled');
  assert.equal((await api('PUT', `/api/campaigns/${c.data.id}`, { name: 'x', subject: 'x', body_text: 'x', filters: {} }, support)).status, 409, 'unschedule before editing');
  assert.equal((await svc.runScheduled({ now: new Date() })).launched, 0, 'not yet');
  const r = await svc.runScheduled({ now: new Date(at.getTime() + 60e3) });
  assert.equal(r.launched, 1);
  const q = await rows(`SELECT status FROM email_outbox WHERE campaign_id = ?`, c.data.id);
  assert.equal(q.length, 3, 'pia + leo + gina (guest)');
  assert.ok(q.every((x) => x.status === 'queued'));
  const cancel = await api('POST', `/api/campaigns/${c.data.id}/cancel`, {}, support);
  assert.equal(cancel.data.stopped, 3);
  const res = (await api('GET', `/api/campaigns/${c.data.id}/results`, undefined, support)).data;
  assert.equal(res.totals.cancelled, 3);
  assert.equal(res.campaign.status, 'cancelled');
  await require('../src/routes/campaigns').processOutbox(50);
  assert.equal(mailsTo('pia.k@test.local', /Hi Pia/).length, 0, 'nothing sent after cancel');

  // empty audience at send time → back to draft, the creator is told
  const e = await camp({ name: 'Nobody', filters: { places: ['atlantis'] } });
  await api('POST', `/api/campaigns/${e.data.id}/schedule`, { at: at.toISOString() }, support);
  const r2 = await svc.runScheduled({ now: new Date(at.getTime() + 60e3) });
  assert.equal(r2.launched, 0);
  assert.equal((await row('SELECT status FROM campaigns WHERE id = ?', e.data.id)).status, 'draft');
  assert.equal(mailsTo('support.k@test.local', /Scheduled campaign not sent — Nobody/).length, 1);

  // duplicate a sent campaign as a new draft
  const d = await api('POST', `/api/campaigns/${c.data.id}/duplicate`, {}, support);
  assert.equal(d.status, 201);
  assert.equal(d.data.status, 'draft');
  assert.match(d.data.name, /\(copy\)$/);
});

test('C5: templates save the message; the list shows builder and older campaigns', async () => {
  const t = await api('POST', '/api/campaigns/builder/templates', { name: 'Seasonal', subject: 'Hi {{first_name}}', body_text: 'Hello!\n\nBye.' }, support);
  assert.equal(t.status, 201);
  assert.equal(t.data.body_text, 'Hello!\n\nBye.');
  const tl = (await api('GET', '/api/campaigns/templates', undefined, support)).data;
  assert.ok(tl.find((x) => x.id === t.data.id));
  const list = (await api('GET', '/api/campaigns', undefined, support)).data;
  assert.ok(list.some((x) => x.builder && x.name === 'Customers fall' && x.sent === 2));
  const leg = await api('POST', '/api/campaigns', { name: 'Old style', segment: 'all_customers', template_id: t.data.id }, support);
  assert.equal(leg.status, 201, 'the older flow still works');
  assert.equal((await api('POST', `/api/campaigns/${c0()}/queue`, {}, support)).status, 409, 'builder campaigns use send-now');
  function c0() { return list.find((x) => x.builder).id; }
});

test('C5: the admin page ships the campaign builder', async () => {
  const html = await (await fetch(BASE + '/admin.html')).text();
  assert.match(html, /js\/campaigns-v1\.js/);
  assert.match(html, /id="campaign-builder"/);
  assert.equal((await fetch(BASE + '/js/campaigns-v1.js')).status, 200);
});
