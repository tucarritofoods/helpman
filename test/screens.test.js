// Helpman — Corte 6 tests: admin screens and the older admin APIs behind them.
// The menu is a fixed set of 15 tabs (no script injects tabs any more), each older
// endpoint now checks the team role it needs, and the old "dispatch" shortcut that
// skipped the deposit / photo / deadline rules is closed.
//
// Own throwaway SQLite DB + server on :3471.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const TEST_DB = '/tmp/test-screens.db';
const BASE = 'http://localhost:3471';
for (const f of [TEST_DB, TEST_DB + '-shm', TEST_DB + '-wal']) { try { fs.unlinkSync(f); } catch (e) { /* fresh */ } }
Object.assign(process.env, { DB_PATH: TEST_DB, PORT: '3471', JWT_SECRET: 'screens-test-secret-0123456789abcdef0123', AUTH_RATE_LIMIT_MAX: '5000', INTAKE_RATE_LIMIT_MAX: '5000' });
delete process.env.DATABASE_URL;
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET']) delete process.env[k];

const db = require('../src/db');
require('../server');
after(async () => { const s = await require('../server').listening; if (s) { s.closeAllConnections && s.closeAllConnections(); s.close(); } });

async function api(method, p, body, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, data };
}
const T = {};
before(async () => {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) { /* retry */ } await new Promise((r) => setTimeout(r, 100)); }
  for (const [k, role] of [['owner', null], ['support', 'support'], ['finance', 'finance'], ['dispatch', 'dispatch']]) {
    await db.prepare("INSERT INTO users (name, email, phone, password_hash, role, email_verified, staff_role) VALUES (?,?,?,?,?,1,?)")
      .run(k, `${k}.s@test.local`, '', bcrypt.hashSync('Admin123!', 10), 'admin', role);
    T[k] = (await api('POST', '/api/auth/login', { email: `${k}.s@test.local`, password: 'Admin123!' })).data.token;
  }
  const c = await api('POST', '/api/auth/signup/customer', { name: 'Cus Tomer', email: 'cus.s@test.local', phone: '707-555-0400', password: 'Customer123!' });
  T.customer = (await api('POST', '/api/auth/login', { email: 'cus.s@test.local', password: 'Customer123!' })).data.token;
  void c;
});

test('C6: the old dispatch shortcut is closed — offers only go through the real flow', async () => {
  const r = await api('POST', '/api/operations/projects/1/dispatch/1', { match_score: 90 }, T.owner);
  assert.equal(r.status, 410);
  assert.equal(r.data.code, 'USE_ASSIGN');
});

test('C6: older admin APIs check the team role', async () => {
  const s = (p, who) => api('GET', p, undefined, T[who]).then((r) => r.status);
  // money figures: finance only
  assert.equal(await s('/api/operations/analytics', 'support'), 403);
  assert.equal(await s('/api/operations/analytics', 'dispatch'), 403);
  assert.equal(await s('/api/operations/analytics', 'finance'), 200);
  // assignment board and recommendations: dispatch only
  assert.equal(await s('/api/operations/dispatch', 'support'), 403);
  assert.equal(await s('/api/operations/dispatch', 'finance'), 403);
  assert.equal(await s('/api/operations/dispatch', 'dispatch'), 200);
  // attention queue and exceptions: every team role, never customers
  for (const who of ['support', 'finance', 'dispatch']) {
    assert.equal(await s('/api/operations/control-center', who), 200);
    assert.equal(await s('/api/operations/risks', who), 200);
  }
  assert.equal(await s('/api/operations/control-center', 'customer'), 403);
  // security events: owners only; AI log and growth: team
  assert.equal(await s('/api/intelligence/admin/security-events', 'support'), 403);
  assert.equal(await s('/api/intelligence/admin/security-events', 'owner'), 200);
  assert.equal(await s('/api/intelligence/admin/runs', 'support'), 200);
  assert.equal(await s('/api/growth/admin/growth', 'support'), 200);
  assert.equal(await s('/api/growth/admin/growth', 'customer'), 403);
});

test('C6: failed payments read as money, not cents', async () => {
  const j = await db.prepare(`INSERT INTO job_requests (name, phone, email, address, service_type, description, claim_token) VALUES ('A','707-555-0401','a@x.test','1 St','painting','x','t1')`).run();
  const p = await db.prepare(`INSERT INTO projects (job_request_id, customer_price_cents, contractor_cost_cents) VALUES (?, 50000, 30000)`).run(j.lastInsertRowid);
  await db.prepare(`INSERT INTO payments (project_id, kind, amount_cents, status) VALUES (?, 'deposit', 15000, 'failed')`).run(p.lastInsertRowid);
  const risks = (await api('GET', '/api/operations/risks', undefined, T.support)).data;
  const r = risks.find((x) => x.type === 'payment');
  assert.equal(r.detail, 'deposit · $150.00');
});

test('C6: one fixed menu — no script injects tabs, every panel has a tab', async () => {
  const html = await (await fetch(BASE + '/admin.html')).text();
  const tabs = [...html.matchAll(/data-tab="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['overview', 'kpis', 'clients', 'contractors', 'projects', 'agenda', 'payouts', 'collections', 'disputes', 'messages', 'campaigns', 'reports', 'team', 'security', 'plugs']);
  for (const t of tabs) assert.match(html, new RegExp(`id="panel-${t}"`), 'panel for ' + t);
  for (const f of ['admin-v4.js', 'admin-v5.js', 'admin-v6.js']) {
    const js = await (await fetch(BASE + '/js/' + f)).text();
    assert.ok(!/admin-tabs/.test(js), `${f} must not touch the menu`);
  }
  // the moved sections have a home
  for (const id of ['hm4-ops-center', 'hm4-risks-v4', 'hm4-dispatch-v4', 'hm6-growth', 'hm5-intelligence-v5', 'hm5-security-v5', 'audit-list', 'proj-filters']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /history\.replaceState\(null, '', '#' \+ name\)/, 'the open tab is kept in the address');
});

// ---------------------------------------------------------------- Corte 6.2
test('C6.2: both portals have fixed tabs; older scripts only fill them', async () => {
  const cust = await (await fetch(BASE + '/customer.html')).text();
  assert.deepEqual([...cust.matchAll(/class="tab[^"]*" data-tab="([a-z-]+)"/g)].map((m) => m[1]), ['overview', 'requests', 'projects', 'messages', 'referrals']);
  const pro = await (await fetch(BASE + '/contractor.html')).text();
  assert.deepEqual([...pro.matchAll(/class="tab[^"]*" data-tab="([a-z-]+)"/g)].map((m) => m[1]), ['overview', 'jobs', 'availability', 'documents', 'payouts', 'disputes', 'messages', 'profile']);
  for (const [html, ids] of [[cust, ['panel-overview', 'hm-command-center']], [pro, ['panel-overview', 'hm3-pro-dashboard', 'hm3-availability', 'hm3-documents']]]) {
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const f of ['customer-v2.js', 'contractor-v3.js']) {
    const js = await (await fetch(BASE + '/js/' + f)).text();
    assert.ok(!/insertBefore\(b(tn)?,\s*tabs\.firstChild\)/.test(js), `${f} must not inject tabs`);
  }
});

let proId, proToken;
async function makePro() {
  if (proId) return;
  await api('POST', '/api/auth/signup/contractor', { name: 'Pablo Pro', email: 'pablo.s@test.local', phone: '707-555-0450', password: 'Contractor123!', legal_name: 'Pablo Pro LLC', city: 'Vallejo' });
  proToken = (await api('POST', '/api/auth/login', { email: 'pablo.s@test.local', password: 'Contractor123!' })).data.token;
  proId = (await db.prepare(`SELECT c.id FROM contractors c JOIN users u ON u.id = c.user_id WHERE u.email = 'pablo.s@test.local'`).get()).id;
}

test('C6.2: a pro\'s trades are always saved as a list (typed "a, b" or a list)', async () => {
  await makePro();
  assert.equal((await api('PATCH', '/api/contractors/me', { specialties: 'Painting, drywall ,painting' }, proToken)).status, 200);
  assert.equal((await db.prepare('SELECT specialties FROM contractors WHERE id = ?').get(proId)).specialties, '["painting","drywall"]');
  assert.equal((await api('PATCH', '/api/contractors/me', { specialties: ['Carpentry'] }, proToken)).status, 200);
  assert.equal((await db.prepare('SELECT specialties FROM contractors WHERE id = ?').get(proId)).specialties, '["carpentry"]');
});

test('C6.2: the pro profile — amounts only for roles that see costs; documents reviewed by dispatch', async () => {
  await makePro();
  const j = await db.prepare(`INSERT INTO job_requests (name, phone, email, address, city, service_type, description, claim_token) VALUES ('B','707-555-0402','b@x.test','2 St','Vallejo','painting','x','t2')`).run();
  const p = await db.prepare(`INSERT INTO projects (job_request_id, contractor_id, contractor_status, stage, customer_price_cents, contractor_cost_cents) VALUES (?, ?, 'accepted', 'completed', 50000, 30000)`).run(j.lastInsertRowid, proId);
  await db.prepare(`INSERT INTO contractor_payables (project_id, contractor_id, payable_cents) VALUES (?, ?, 30000)`).run(p.lastInsertRowid, proId);
  await db.prepare(`INSERT INTO contractor_offer_events (project_id, contractor_id, event_type) VALUES (?, ?, 'offered'), (?, ?, 'accepted')`).run(p.lastInsertRowid, proId, p.lastInsertRowid, proId);
  const doc = await db.prepare(`INSERT INTO contractor_documents (contractor_id, doc_type, expires_on, storage_key) VALUES (?, 'insurance', '2027-01-01', 'secret/key')`).run(proId);

  const own = await api('GET', `/api/contractors/${proId}/profile`, undefined, T.owner);
  assert.equal(own.status, 200);
  assert.equal(own.data.can_see_money, true);
  assert.equal(own.data.payouts[0].payable_cents, 30000);
  assert.equal(own.data.jobs[0].contractor_cost_cents, 30000);
  assert.equal(own.data.offers.counts.accepted, 1);
  assert.ok(!JSON.stringify(own.data).includes('secret/key'), 'never the stored file key');
  assert.ok(!('stripe_account_id' in own.data.summary));

  const sup = await api('GET', `/api/contractors/${proId}/profile`, undefined, T.support);
  assert.equal(sup.status, 200);
  assert.equal(sup.data.can_see_money, false);
  assert.equal(sup.data.payouts, null, 'support never sees what a pro is paid');
  assert.equal(sup.data.jobs[0].contractor_cost_cents, undefined);
  assert.equal((await api('GET', `/api/contractors/${proId}/profile`, undefined, T.customer)).status, 403);
  assert.equal((await api('GET', '/api/contractors/99999/profile', undefined, T.owner)).status, 404);

  const id = doc.lastInsertRowid;
  assert.equal((await api('PATCH', `/api/contractor-ops/admin/documents/${id}`, { status: 'verified' }, T.support)).status, 403, 'support cannot verify documents');
  assert.equal((await api('PATCH', `/api/contractor-ops/admin/documents/${id}`, { status: 'verified' }, T.dispatch)).status, 200);
});

test('C6.2: operating timeframes are business rules — validated and used', async () => {
  const g = (await api('GET', '/api/admin/settings', undefined, T.owner)).data.rules;
  for (const k of ['confirm_reminder_hours', 'confirm_escalate_hours', 'review_request_days', 'client_lost_after_days']) {
    const r = g.find((x) => x.key === k);
    assert.ok(r, k); assert.equal(r.group, 'timing');
  }
  assert.equal(g.find((x) => x.key === 'confirm_reminder_hours').value, 24);
  assert.equal(g.find((x) => x.key === 'client_lost_after_days').value, 90);
  assert.equal((await api('PUT', '/api/admin/settings', { values: { confirm_escalate_hours: 12 } }, T.owner)).status, 422, 'support is told after the reminder, never before');
  assert.equal((await api('PUT', '/api/admin/settings', { values: { client_lost_after_days: 5 } }, T.owner)).status, 422);
  assert.equal((await api('PUT', '/api/admin/settings', { values: { client_lost_after_days: 30 } }, T.support)).status, 403);

  // "lost" follows the rule: a prospect idle for 40 days is not lost at 90 days, and is at 30.
  const c = await api('POST', '/api/auth/signup/customer', { name: 'Ida Idle', email: 'ida.s@test.local', phone: '707-555-0460', password: 'Customer123!' });
  const old = new Date(Date.now() - 40 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  await db.prepare(`INSERT INTO job_requests (customer_id, name, phone, email, address, service_type, description, claim_token, created_at, updated_at) VALUES (?, 'Ida Idle', '707-555-0460', 'ida.s@test.local', '3 St', 'painting', 'x', 't3', ?, ?)`).run(c.data.user.id, old, old);
  await db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(old, c.data.user.id);
  const lc = async () => (await api('GET', '/api/clients?q=ida', undefined, T.owner)).data.rows[0].lifecycle;
  assert.equal(await lc(), 'prospect');
  assert.equal((await api('PUT', '/api/admin/settings', { values: { client_lost_after_days: 30 } }, T.owner)).status, 200);
  assert.equal(await lc(), 'lost');
  await api('PUT', '/api/admin/settings', { values: { client_lost_after_days: 90 } }, T.owner);
});

test('C6.2: Disputes and Collections name the client (link to the profile) for the team only', async () => {
  await makePro();
  const c = await db.prepare(`SELECT id FROM users WHERE email = 'cus.s@test.local'`).get();
  const j = await db.prepare(`INSERT INTO job_requests (customer_id, name, phone, email, address, service_type, description, claim_token) VALUES (?, 'Cus Tomer', '707-555-0400', 'cus.s@test.local', '4 St', 'drywall', 'x', 't4')`).run(c.id);
  const p = await db.prepare(`INSERT INTO projects (job_request_id, contractor_id, contractor_status, stage, customer_price_cents, contractor_cost_cents) VALUES (?, ?, 'accepted', 'review', 40000, 20000)`).run(j.lastInsertRowid, proId);
  await db.prepare(`INSERT INTO disputes (project_id, opened_by, opened_by_role, reason, description) VALUES (?, ?, 'customer', 'quality', 'Not good')`).run(p.lastInsertRowid, c.id);
  const staff = (await api('GET', '/api/disputes', undefined, T.owner)).data.find((d) => d.project_id === p.lastInsertRowid);
  assert.equal(staff.customer_name, 'Cus Tomer');
  assert.equal(staff.customer_id, c.id);
  assert.equal(staff.service_type, 'drywall');
  const mine = (await api('GET', '/api/disputes', undefined, T.customer)).data.find((d) => d.project_id === p.lastInsertRowid);
  assert.ok(mine && mine.customer_name === undefined, 'the extra staff columns are not sent to customers');
  const pro = (await api('GET', '/api/disputes', undefined, proToken)).data.find((d) => d.project_id === p.lastInsertRowid);
  assert.ok(pro && pro.customer_name === undefined && pro.customer_id === undefined, 'nor to the pro (golden rule)');
  const col = (await api('GET', '/api/collections', undefined, T.owner)).data.items.find((i) => i.project_id === p.lastInsertRowid);
  assert.equal(col.customer_id, c.id);
});

test('C6.2: the admin page ships the pro profile, searches and grouped rules', async () => {
  const html = await (await fetch(BASE + '/admin.html')).text();
  for (const id of ['co-q', 'po-q']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /js\/pros-v1\.js/);
  assert.match(html, /data-open-pro=/);
  assert.equal((await fetch(BASE + '/js/pros-v1.js')).status, 200);
  assert.match(html, /<h2>Business rules<\/h2>/);
});
