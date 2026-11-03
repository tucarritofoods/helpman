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
