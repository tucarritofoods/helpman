// CRM Clients (Corte 4): the client directory and the client profile.
//
// A "client" is a customer account (users.role = 'customer'). Requests sent as a
// guest with the same email before the account existed are linked to it too.
//
// Lifecycle (derived, never stored, so it is always current):
//   lead      account, no request yet
//   prospect  has requests, no deposit paid yet, active in the last 90 days
//   active    a paid project is open (assigned → review)
//   customer  at least one completed project, nothing open
//   lost      prospect with no activity in 90 days, or every quote rejected/expired
// Tags: free labels plus two with meaning — 'vip' and 'blocked' (a blocked client
// cannot create new requests or accept quotes; the history stays visible).
//
// Staff only. Money (payments, balances, lifetime spend) only for the 'finance'
// permission; everything else for 'support'. This module never decides access:
// the routes do (src/routes/clients.js).
'use strict';
const db = require('../db');
const { auditLog } = require('./audit');
const toDate = (v) => require('./kpis').toDate(v);

const LIFECYCLES = ['lead', 'prospect', 'active', 'customer', 'lost'];
const SPECIAL_TAGS = ['vip', 'blocked'];
const LOST_AFTER_DAYS = 90;
const OPEN_STAGES = ['assigned', 'scheduled', 'in_progress', 'review'];
const PAID = ['paid', 'recorded'];

const norm = (e) => String(e || '').trim().toLowerCase();
const ts = (v) => { const d = toDate(v); return d ? d.getTime() : 0; };
const iso = (v) => { const d = toDate(v); return d ? d.toISOString() : null; };
function err(statusCode, message, code) { return Object.assign(new Error(message), { statusCode, code }); }

function cleanTag(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(t)) return null;
  return t;
}

// ---------------------------------------------------------------------------
// Directory: one pass over the tables, no per-client queries.
// ---------------------------------------------------------------------------
async function loadIndex() {
  const users = await db.prepare(`SELECT id, name, email, phone, email_verified, created_at FROM users WHERE role = 'customer'`).all();
  const byId = new Map(), byEmail = new Map();
  for (const u of users) {
    const c = { id: u.id, name: u.name, email: u.email, phone: u.phone || '', email_verified: !!u.email_verified, created_at: iso(u.created_at),
      tags: [], jobs: [], projects: [], spend_cents: 0, last_activity: ts(u.created_at), city: '', zip: '', services: new Set() };
    byId.set(u.id, c); byEmail.set(norm(u.email), c);
  }
  for (const t of await db.prepare('SELECT user_id, tag FROM customer_tags').all()) { const c = byId.get(t.user_id); if (c) c.tags.push(t.tag); }

  const jobs = await db.prepare(`SELECT id, customer_id, email, city, zip, service_type, status, created_at, updated_at FROM job_requests ORDER BY id`).all();
  const jobOwner = new Map();
  for (const j of jobs) {
    const c = (j.customer_id && byId.get(j.customer_id)) || (!j.customer_id && j.email && byEmail.get(norm(j.email)));
    if (!c) continue;
    jobOwner.set(j.id, c);
    c.jobs.push(j);
    if (j.city) c.city = j.city;
    if (j.zip) c.zip = j.zip;
    c.services.add(j.service_type);
    c.last_activity = Math.max(c.last_activity, ts(j.updated_at || j.created_at));
  }
  const quotes = await db.prepare(`SELECT job_request_id, status FROM quotes`).all();
  const quotesByJob = new Map();
  for (const q of quotes) { if (!quotesByJob.has(q.job_request_id)) quotesByJob.set(q.job_request_id, []); quotesByJob.get(q.job_request_id).push(q.status); }

  const projects = await db.prepare(`SELECT id, job_request_id, stage, updated_at, customer_price_cents FROM projects`).all();
  const projOwner = new Map();
  for (const p of projects) {
    const c = jobOwner.get(p.job_request_id);
    if (!c) continue;
    projOwner.set(p.id, c);
    c.projects.push(p);
    c.last_activity = Math.max(c.last_activity, ts(p.updated_at));
  }
  const pays = await db.prepare(`SELECT project_id, kind, amount_cents, status, created_at FROM payments`).all();
  const depositPaid = new Set();
  for (const pay of pays) {
    const c = projOwner.get(pay.project_id);
    if (!c || !PAID.includes(pay.status)) continue;
    c.spend_cents += pay.kind === 'refund' ? -Number(pay.amount_cents) : Number(pay.amount_cents);
    if (pay.kind === 'deposit') depositPaid.add(pay.project_id);
    c.last_activity = Math.max(c.last_activity, ts(pay.created_at));
  }

  const now = Date.now();
  for (const c of byId.values()) {
    const open = c.projects.some((p) => OPEN_STAGES.includes(p.stage) && depositPaid.has(p.id));
    const done = c.projects.some((p) => p.stage === 'completed');
    let lc;
    if (open) lc = 'active';
    else if (done) lc = 'customer';
    else if (!c.jobs.length) lc = 'lead';
    else {
      const allQuotes = c.jobs.flatMap((j) => quotesByJob.get(j.id) || []);
      const allDead = allQuotes.length && allQuotes.every((s) => s === 'rejected' || s === 'expired');
      const stale = now - c.last_activity > LOST_AFTER_DAYS * 86400000;
      lc = allDead || stale ? 'lost' : 'prospect';
    }
    c.lifecycle = lc;
    c.requests = c.jobs.length;
    c.projects_count = c.projects.length;
    c.completed = c.projects.filter((p) => p.stage === 'completed').length;
    c.last_service = c.jobs.length ? c.jobs[c.jobs.length - 1].service_type : null;
    c.services = [...c.services];
  }
  return { byId, byEmail };
}

const SORTS = {
  recent: (a, b) => b.last_activity - a.last_activity,
  name: (a, b) => String(a.name).localeCompare(String(b.name)),
  spend: (a, b) => b.spend_cents - a.spend_cents,
  created: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
};

function listRow(c, withMoney) {
  return {
    id: c.id, name: c.name, email: c.email, phone: c.phone, city: c.city, zip: c.zip,
    lifecycle: c.lifecycle, tags: c.tags.slice().sort(), requests: c.requests, projects: c.projects_count, completed: c.completed,
    last_service: c.last_service, last_activity: c.last_activity ? new Date(c.last_activity).toISOString() : null, created_at: c.created_at,
    spend_cents: withMoney ? c.spend_cents : undefined,
  };
}

async function list({ q, lifecycle, tag, city, sort, page, per_page: perPage, withMoney }) {
  const { byId } = await loadIndex();
  let rows = [...byId.values()];
  const counts = Object.fromEntries(LIFECYCLES.map((l) => [l, 0]));
  for (const c of rows) counts[c.lifecycle]++;
  const needle = norm(q);
  if (needle) {
    const digits = needle.replace(/\D/g, '');
    rows = rows.filter((c) => norm(c.name).includes(needle) || norm(c.email).includes(needle)
      || (digits.length >= 3 && String(c.phone).replace(/\D/g, '').includes(digits)) || String(c.id) === needle.replace(/^#/, ''));
  }
  if (lifecycle && LIFECYCLES.includes(lifecycle)) rows = rows.filter((c) => c.lifecycle === lifecycle);
  if (tag) rows = rows.filter((c) => c.tags.includes(norm(tag)));
  if (city) rows = rows.filter((c) => norm(c.city) === norm(city) || c.zip === String(city).trim());
  rows.sort(SORTS[sort] && (sort !== 'spend' || withMoney) ? SORTS[sort] : SORTS.recent);
  const per = Math.min(Math.max(Number(perPage) || 50, 1), 200);
  const pg = Math.max(Number(page) || 1, 1);
  return { total: rows.length, page: pg, per_page: per, counts, rows: rows.slice((pg - 1) * per, pg * per).map((c) => listRow(c, withMoney)) };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
async function customerRow(id) {
  const u = await db.prepare(`SELECT id, name, email, phone, email_verified, created_at FROM users WHERE id = ? AND role = 'customer'`).get(Number(id));
  if (!u) throw err(404, 'Client not found.');
  return u;
}
async function jobsOf(u) {
  return db.prepare(`SELECT * FROM job_requests WHERE customer_id = ? OR (customer_id IS NULL AND LOWER(email) = ?) ORDER BY id DESC`).all(u.id, norm(u.email));
}
async function projectsOf(jobIds) {
  if (!jobIds.length) return [];
  return db.prepare(`SELECT p.*, j.service_type, u.name AS contractor_name FROM projects p
    JOIN job_requests j ON j.id = p.job_request_id
    LEFT JOIN contractors c ON c.id = p.contractor_id LEFT JOIN users u ON u.id = c.user_id
    WHERE p.job_request_id IN (${jobIds.map(() => '?').join(',')}) ORDER BY p.id DESC`).all(...jobIds);
}
const ids = (rows) => rows.map((r) => r.id);
const inList = (arr) => arr.map(() => '?').join(',');

async function summary(id, { withMoney }) {
  const u = await customerRow(id);
  const { byId } = await loadIndex();
  const c = byId.get(u.id);
  const sms = require('./sms');
  const phone = sms.normalizePhone(u.phone || (c.jobs[c.jobs.length - 1] || {}).phone || '');
  const consent = phone ? await db.prepare('SELECT opted_in FROM sms_consents WHERE phone = ?').get(phone) : null;
  const notes = await db.prepare(`SELECT n.id, n.body, n.created_at, a.name AS author FROM customer_notes n LEFT JOIN users a ON a.id = n.author_id
    WHERE n.customer_id = ? AND n.pinned = 1 AND n.kind = 'note' ORDER BY n.id DESC LIMIT 3`).all(u.id);
  const openTasks = Number((await db.prepare(`SELECT COUNT(*) c FROM followup_tasks t WHERE t.status = 'open' AND (t.customer_id = ?
    ${c.jobs.length ? `OR t.job_request_id IN (${inList(c.jobs)})` : ''})`).get(u.id, ...ids(c.jobs))).c);
  const out = {
    ...listRow(c, withMoney),
    email_verified: !!u.email_verified,
    blocked: c.tags.includes('blocked'), vip: c.tags.includes('vip'),
    services: c.services,
    sms_opted_in: !!(consent && consent.opted_in),
    marketing_unsubscribed: await require('./unsubscribe').isSuppressed(u.email),
    open_disputes: c.projects.length ? Number((await db.prepare(`SELECT COUNT(*) c FROM disputes WHERE status IN ('open','investigating') AND project_id IN (${inList(c.projects)})`).get(...ids(c.projects))).c) : 0,
    open_tasks: openTasks,
    pinned_notes: notes,
    reviews: c.projects.length ? await db.prepare(`SELECT project_id, rating, comment, created_at FROM reviews WHERE customer_id = ? ORDER BY id DESC LIMIT 5`).all(u.id) : [],
  };
  if (withMoney) {
    const billing = require('./billing');
    let due = 0;
    for (const p of c.projects) if (!['cancelled'].includes(p.stage)) due += Math.max(0, await billing.balanceCents(p.id));
    out.balance_due_cents = due;
  }
  return out;
}

async function requestsAndProjects(id) {
  const u = await customerRow(id);
  const jobs = await jobsOf(u);
  const projects = await projectsOf(ids(jobs));
  const quotes = jobs.length ? await db.prepare(`SELECT id, job_request_id, status, customer_price_cents, deposit_cents, sent_at, responded_at, created_at FROM quotes WHERE job_request_id IN (${inList(jobs)}) ORDER BY id DESC`).all(...ids(jobs)) : [];
  const { displayName } = require('./views');
  return {
    requests: jobs.map((j) => ({ id: j.id, service_type: j.service_type, status: j.status, city: j.city, zip: j.zip, address: j.address, urgency: j.urgency,
      description: j.description, created_at: j.created_at, guest: !j.customer_id, quotes: quotes.filter((q) => q.job_request_id === j.id) })),
    projects: projects.map((p) => ({ id: p.id, job_request_id: p.job_request_id, service_type: p.service_type, stage: p.stage, scheduled_start: p.scheduled_start,
      arrival_window: p.arrival_window, contractor: p.contractor_name ? displayName(p.contractor_name) : null, customer_price_cents: p.customer_price_cents,
      created_at: p.created_at, updated_at: p.updated_at })),
  };
}

async function money(id) {
  const u = await customerRow(id);
  const projects = await projectsOf(ids(await jobsOf(u)));
  const billing = require('./billing');
  const pids = ids(projects);
  const payments = pids.length ? await db.prepare(`SELECT id, project_id, kind, amount_cents, status, provider, created_at FROM payments WHERE project_id IN (${inList(projects)}) ORDER BY id DESC`).all(...pids) : [];
  const auths = pids.length ? await db.prepare(`SELECT project_id, consent_text_version, authorized_at, revoked_at, payment_method_id FROM payment_authorizations WHERE project_id IN (${inList(projects)})`).all(...pids) : [];
  const cbs = pids.length ? await db.prepare(`SELECT project_id, amount_cents, reason, status, created_at FROM chargebacks WHERE project_id IN (${inList(projects)})`).all(...pids) : [];
  const perProject = [];
  let paid = 0, refunded = 0, due = 0;
  for (const p of projects) {
    const bal = p.stage === 'cancelled' ? 0 : Math.max(0, await billing.balanceCents(p.id));
    const net = await billing.netPaidCents(p.id);
    due += bal;
    const a = auths.find((x) => x.project_id === p.id);
    perProject.push({ project_id: p.id, service_type: p.service_type, stage: p.stage, price_cents: p.customer_price_cents, paid_cents: net, balance_cents: bal,
      balance_charge_status: p.balance_charge_status || null, card_on_file: !!(a && a.payment_method_id && !a.revoked_at) });
  }
  for (const x of payments) if (PAID.includes(x.status)) { if (x.kind === 'refund') refunded += Number(x.amount_cents); else paid += Number(x.amount_cents); }
  return {
    totals: { paid_cents: paid, refunded_cents: refunded, net_cents: paid - refunded, balance_due_cents: due },
    projects: perProject, payments,
    authorizations: auths.map(({ payment_method_id, ...rest }) => ({ ...rest, card_on_file: !!payment_method_id })), // never the Stripe id
    chargebacks: cbs,
  };
}

async function messages(id) {
  const u = await customerRow(id);
  const projects = await projectsOf(ids(await jobsOf(u)));
  const threads = projects.length ? await db.prepare(`SELECT t.id, t.project_id FROM message_threads t WHERE t.kind = 'client_support' AND t.project_id IN (${inList(projects)}) ORDER BY t.id DESC`).all(...ids(projects)) : [];
  const out = [];
  for (const t of threads) {
    const msgs = await db.prepare(`SELECT m.id, m.body, m.sender_role, m.created_at, m.flagged, m.flag_reason, s.name AS sender_name FROM messages m LEFT JOIN users s ON s.id = m.sender_id WHERE m.thread_id = ? ORDER BY m.id`).all(t.id);
    const p = projects.find((x) => x.id === t.project_id);
    out.push({ thread_id: t.id, project_id: t.project_id, service_type: p ? p.service_type : null, messages: msgs });
  }
  const emails = await db.prepare(`SELECT n.id, n.subject, n.body, n.created_at, a.name AS author FROM customer_notes n LEFT JOIN users a ON a.id = n.author_id WHERE n.customer_id = ? AND n.kind = 'email' ORDER BY n.id DESC`).all(u.id);
  return { threads: out, emails, projects: projects.filter((p) => p.stage !== 'cancelled').map((p) => ({ id: p.id, service_type: p.service_type, stage: p.stage })) };
}

async function notes(id) {
  await customerRow(id);
  return db.prepare(`SELECT n.id, n.body, n.pinned, n.created_at, n.author_id, a.name AS author FROM customer_notes n LEFT JOIN users a ON a.id = n.author_id
    WHERE n.customer_id = ? AND n.kind = 'note' ORDER BY n.pinned DESC, n.id DESC`).all(Number(id));
}

async function tasks(id) {
  const u = await customerRow(id);
  const jobs = await jobsOf(u);
  return db.prepare(`SELECT t.id, t.job_request_id, t.kind, t.title, t.notes, t.due_at, t.status, t.done_at, t.created_at, a.name AS assigned_name, t.assigned_to, b.name AS created_by_name
    FROM followup_tasks t LEFT JOIN users a ON a.id = t.assigned_to LEFT JOIN users b ON b.id = t.created_by
    WHERE t.customer_id = ? ${jobs.length ? `OR t.job_request_id IN (${inList(jobs)})` : ''} ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END, t.due_at, t.id DESC`).all(u.id, ...ids(jobs));
}

async function consents(id) {
  const u = await customerRow(id);
  const jobs = await jobsOf(u);
  const projects = await projectsOf(ids(jobs));
  const sms = require('./sms');
  const phones = [...new Set([u.phone, ...jobs.map((j) => j.phone)].map((p) => sms.normalizePhone(p || '')).filter(Boolean))];
  const smsRows = phones.length ? await db.prepare(`SELECT phone, opted_in, source, updated_at FROM sms_consents WHERE phone IN (${inList(phones)})`).all(...phones) : [];
  const supp = await db.prepare('SELECT reason, created_at FROM email_suppressions WHERE email = ?').get(norm(u.email));
  const terms = await db.prepare(`SELECT kind, reference_id, terms_version, accepted_at FROM terms_acceptances WHERE user_id = ? ORDER BY id DESC`).all(u.id);
  const auths = projects.length ? await db.prepare(`SELECT project_id, consent_text_version, authorized_at, revoked_at FROM payment_authorizations WHERE project_id IN (${inList(projects)})`).all(...ids(projects)) : [];
  const emailsIn = await db.prepare(`SELECT id, subject, status, provider, created_at FROM email_log WHERE LOWER(to_email) = ? ORDER BY id DESC LIMIT 100`).all(norm(u.email));
  const textsIn = phones.length || projects.length
    ? await db.prepare(`SELECT id, kind, body, status, project_id, created_at FROM sms_log WHERE ${[phones.length ? `to_phone IN (${inList(phones)})` : null, projects.length ? `project_id IN (${inList(projects)})` : null].filter(Boolean).join(' OR ')} ORDER BY id DESC LIMIT 100`)
      .all(...phones, ...ids(projects))
    : [];
  return {
    email: { address: u.email, verified: !!u.email_verified, marketing: supp ? { unsubscribed: true, reason: supp.reason, since: supp.created_at } : { unsubscribed: false } },
    sms: phones.map((p) => { const r = smsRows.find((x) => x.phone === p); return { phone: p, opted_in: !!(r && r.opted_in), source: r ? r.source : null, updated_at: r ? r.updated_at : null }; }),
    terms, card_authorizations: auths,
    communications: { emails: emailsIn, texts: textsIn },
  };
}

async function campaignsReceived(id) {
  const u = await customerRow(id);
  return db.prepare(`SELECT o.id, o.campaign_id, c.name AS campaign, o.subject, o.status, o.error, o.sent_at, o.created_at
    FROM email_outbox o LEFT JOIN campaigns c ON c.id = o.campaign_id WHERE LOWER(o.to_email) = ? ORDER BY o.id DESC LIMIT 200`).all(norm(u.email));
}

// Timeline: everything that happened with this client, newest first.
async function history(id) {
  const u = await customerRow(id);
  const jobs = await jobsOf(u);
  const projects = await projectsOf(ids(jobs));
  const ev = [];
  const add = (at, kind, text, ref) => ev.push({ at: iso(at), kind, text, ref: ref || null });
  add(u.created_at, 'account', 'Account created');
  for (const j of jobs) add(j.created_at, 'request', `Request #${j.id} — ${j.service_type}${j.customer_id ? '' : ' (sent as guest)'}`, { job_request_id: j.id });
  if (jobs.length) {
    const qs = await db.prepare(`SELECT id, job_request_id, status, customer_price_cents, sent_at, responded_at FROM quotes WHERE job_request_id IN (${inList(jobs)})`).all(...ids(jobs));
    for (const q of qs) {
      if (q.sent_at) add(q.sent_at, 'quote', `Quote #${q.id} sent ($${(q.customer_price_cents / 100).toFixed(2)})`, { job_request_id: q.job_request_id });
      if (q.responded_at) add(q.responded_at, 'quote', `Quote #${q.id} ${q.status}`, { job_request_id: q.job_request_id });
    }
  }
  if (projects.length) {
    const pids = ids(projects), qm = inList(projects);
    for (const e of await db.prepare(`SELECT entity_id, type, data, created_at FROM events WHERE entity = 'project' AND entity_id IN (${qm})`).all(...pids)) {
      let d = {}; try { d = JSON.parse(e.data || '{}'); } catch (_) { /* free text */ }
      add(e.created_at, 'project', `Project #${e.entity_id}: ${e.type === 'project.stage' && d.to ? `stage → ${d.to}` : e.type.replace(/[._]/g, ' ')}`, { project_id: e.entity_id });
    }
    for (const p of await db.prepare(`SELECT project_id, kind, amount_cents, status, created_at FROM payments WHERE project_id IN (${qm})`).all(...pids)) {
      add(p.created_at, 'payment', `${p.kind === 'refund' ? 'Refund' : 'Payment'} (${p.kind}) $${(p.amount_cents / 100).toFixed(2)} — ${p.status}`, { project_id: p.project_id });
    }
    for (const s of await db.prepare(`SELECT project_id, signed_at FROM completion_sheets WHERE project_id IN (${qm})`).all(...pids)) add(s.signed_at, 'project', `Project #${s.project_id} signed off`, { project_id: s.project_id });
    for (const d of await db.prepare(`SELECT id, project_id, reason, status, created_at FROM disputes WHERE project_id IN (${qm})`).all(...pids)) add(d.created_at, 'dispute', `Problem reported on project #${d.project_id} (${d.reason}) — ${d.status}`, { project_id: d.project_id });
    for (const r of await db.prepare(`SELECT project_id, rating, created_at FROM reviews WHERE project_id IN (${qm})`).all(...pids)) add(r.created_at, 'review', `Review: ${r.rating}★ on project #${r.project_id}`, { project_id: r.project_id });
  }
  for (const a of await db.prepare(`SELECT a.action, a.details, a.created_at, s.name AS admin FROM admin_audit a LEFT JOIN users s ON s.id = a.admin_id WHERE a.entity = 'clients' AND a.entity_id = ?`).all(u.id)) {
    add(a.created_at, 'staff', `${a.admin || 'Staff'}: ${a.action.replace(/^client\./, '').replace(/_/g, ' ')}${a.details ? ` — ${a.details}` : ''}`);
  }
  for (const o of await db.prepare(`SELECT o.subject, o.status, o.created_at, c.name FROM email_outbox o LEFT JOIN campaigns c ON c.id = o.campaign_id WHERE LOWER(o.to_email) = ?`).all(norm(u.email))) {
    add(o.created_at, 'campaign', `Campaign "${o.name || o.subject}" — ${o.status}`);
  }
  ev.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return ev.slice(0, 300);
}

// ---------------------------------------------------------------------------
// Actions (each one audited against the client: entity 'clients')
// ---------------------------------------------------------------------------
async function setTags(id, { add = [], remove = [] }, actor) {
  const u = await customerRow(id);
  const toAdd = [].concat(add).map(cleanTag), toRemove = [].concat(remove).map(cleanTag);
  if (toAdd.includes(null) || toRemove.includes(null)) throw err(422, 'Tags use letters, numbers and dashes (max 24 characters).');
  const current = (await db.prepare('SELECT tag FROM customer_tags WHERE user_id = ?').all(u.id)).map((r) => r.tag);
  if (new Set([...current, ...toAdd]).size - toRemove.filter((t) => current.includes(t)).length > 10) throw err(422, 'A client can have up to 10 tags.');
  for (const t of toAdd) {
    if (current.includes(t)) continue;
    await db.prepare('INSERT INTO customer_tags (user_id, tag, created_by) VALUES (?,?,?)').run(u.id, t, actor.id);
    await auditLog(actor.id, t === 'blocked' ? 'client.blocked' : 'client.tag_added', 'clients', u.id, t);
  }
  for (const t of toRemove) {
    const r = await db.prepare('DELETE FROM customer_tags WHERE user_id = ? AND tag = ?').run(u.id, t);
    if (r.changes) await auditLog(actor.id, t === 'blocked' ? 'client.unblocked' : 'client.tag_removed', 'clients', u.id, t);
  }
  return (await db.prepare('SELECT tag FROM customer_tags WHERE user_id = ? ORDER BY tag').all(u.id)).map((r) => r.tag);
}

async function allTags() {
  const rows = await db.prepare('SELECT tag, COUNT(*) AS n FROM customer_tags GROUP BY tag ORDER BY n DESC, tag').all();
  const out = rows.map((r) => ({ tag: r.tag, count: Number(r.n) }));
  for (const t of SPECIAL_TAGS) if (!out.find((x) => x.tag === t)) out.push({ tag: t, count: 0 });
  return out;
}

// Is this customer (account or the email of a guest request) blocked?
async function isBlocked({ userId, email }) {
  if (userId) {
    if (await db.prepare(`SELECT id FROM customer_tags WHERE user_id = ? AND tag = 'blocked'`).get(userId)) return true;
  }
  if (email) {
    const r = await db.prepare(`SELECT t.id FROM customer_tags t JOIN users u ON u.id = t.user_id WHERE t.tag = 'blocked' AND LOWER(u.email) = ?`).get(norm(email));
    if (r) return true;
  }
  return false;
}

async function addNote(id, { body, pinned }, actor) {
  const u = await customerRow(id);
  const text = String(body || '').trim();
  if (!text || text.length > 4000) throw err(422, 'Write the note (max 4000 characters).');
  const info = await db.prepare(`INSERT INTO customer_notes (customer_id, author_id, kind, body, pinned) VALUES (?,?,'note',?,?)`).run(u.id, actor.id, text, pinned ? 1 : 0);
  await auditLog(actor.id, 'client.note_added', 'clients', u.id, text.slice(0, 120));
  return db.prepare('SELECT * FROM customer_notes WHERE id = ?').get(info.lastInsertRowid);
}

async function updateNote(id, noteId, { pinned }, actor) {
  const n = await db.prepare(`SELECT * FROM customer_notes WHERE id = ? AND customer_id = ? AND kind = 'note'`).get(Number(noteId), Number(id));
  if (!n) throw err(404, 'Note not found.');
  await db.prepare('UPDATE customer_notes SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, n.id);
  await auditLog(actor.id, pinned ? 'client.note_pinned' : 'client.note_unpinned', 'clients', n.customer_id, `note #${n.id}`);
  return db.prepare('SELECT * FROM customer_notes WHERE id = ?').get(n.id);
}

// Only the author or an owner deletes a note; the deletion stays in the audit trail.
async function deleteNote(id, noteId, actor, isOwner) {
  const n = await db.prepare(`SELECT * FROM customer_notes WHERE id = ? AND customer_id = ? AND kind = 'note'`).get(Number(noteId), Number(id));
  if (!n) throw err(404, 'Note not found.');
  if (n.author_id !== actor.id && !isOwner) throw err(403, 'Only the author or an owner can delete this note.');
  await db.prepare('DELETE FROM customer_notes WHERE id = ?').run(n.id);
  await auditLog(actor.id, 'client.note_deleted', 'clients', n.customer_id, n.body.slice(0, 200));
  return { deleted: true };
}

async function addTask(id, { title, due_at, assigned_to, notes: taskNotes, job_request_id }, actor) {
  const u = await customerRow(id);
  const t = String(title || '').trim();
  const errors = {};
  if (!t || t.length > 200) errors.title = 'Write the task (max 200 characters).';
  let due = null;
  if (due_at) { const d = new Date(due_at); if (isNaN(d.getTime())) errors.due_at = 'Invalid date.'; else due = d.toISOString(); }
  let assignee = null;
  if (assigned_to) {
    const s = await db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'admin' AND (staff_role IS NULL OR staff_role <> 'disabled')`).get(Number(assigned_to));
    if (!s) errors.assigned_to = 'Choose an active team member.'; else assignee = s.id;
  }
  let jobId = null;
  if (job_request_id) {
    const jobs = await jobsOf(u);
    if (!jobs.find((j) => j.id === Number(job_request_id))) errors.job_request_id = 'That request is not from this client.'; else jobId = Number(job_request_id);
  }
  if (taskNotes && String(taskNotes).length > 2000) errors.notes = 'Notes are too long.';
  if (Object.keys(errors).length) throw Object.assign(err(422, 'Check the task.'), { errors });
  const info = await db.prepare(`INSERT INTO followup_tasks (job_request_id, customer_id, kind, title, notes, due_at, assigned_to, created_by) VALUES (?,?,'manual',?,?,?,?,?)`)
    .run(jobId, u.id, t, taskNotes ? String(taskNotes).trim() : null, due, assignee, actor.id);
  await auditLog(actor.id, 'client.task_added', 'clients', u.id, t);
  if (assignee && assignee !== actor.id) {
    const a = await db.prepare('SELECT email, name FROM users WHERE id = ?').get(assignee);
    const { notify, shell } = require('./notify');
    if (a && a.email) await notify({ to: a.email, subject: `New task for you — client #${u.id}`, html: shell('A task was assigned to you', `${actor.name} assigned you a task about client #${u.id}.`, [['Task', t], ...(due ? [['Due', due.slice(0, 10)]] : [])]) }).catch(() => {});
  }
  return db.prepare('SELECT * FROM followup_tasks WHERE id = ?').get(info.lastInsertRowid);
}

async function setTaskStatus(id, taskId, status, actor) {
  const u = await customerRow(id);
  const mine = (await tasks(u.id)).find((t) => t.id === Number(taskId));
  if (!mine) throw err(404, 'Task not found.');
  if (!['open', 'done'].includes(status)) throw err(422, 'Status must be open or done.');
  await db.prepare(`UPDATE followup_tasks SET status = ?, done_at = ${status === 'done' ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = ?`).run(status, mine.id);
  await auditLog(actor.id, status === 'done' ? 'client.task_done' : 'client.task_reopened', 'clients', u.id, mine.title);
  return { id: mine.id, status };
}

// A message from Helpman support, by email, when the client has no project thread
// (or support prefers email). Always from the platform, never from a person's
// own account; recorded in the client's file.
async function emailClient(id, { subject, body }, actor) {
  const u = await customerRow(id);
  const s = String(subject || '').trim(), b = String(body || '').trim();
  const errors = {};
  if (!s || s.length > 150) errors.subject = 'Write a subject (max 150 characters).';
  if (!b || b.length > 4000) errors.body = 'Write the message (max 4000 characters).';
  if (Object.keys(errors).length) throw Object.assign(err(422, 'Check the message.'), { errors });
  const { notify, brandShell, esc } = require('./notify');
  const html = brandShell(esc(s), `<p style="margin:0 0 12px;">Hi ${esc(String(u.name).split(' ')[0])},</p>${esc(b).split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${p.replace(/\n/g, '<br>')}</p>`).join('')}<p style="margin:0;">— Helpman support</p>`);
  const r = await notify({ to: u.email, subject: s, html });
  const info = await db.prepare(`INSERT INTO customer_notes (customer_id, author_id, kind, subject, body) VALUES (?,?,'email',?,?)`).run(u.id, actor.id, s, b);
  await auditLog(actor.id, 'client.emailed', 'clients', u.id, s);
  return { id: info.lastInsertRowid, sent: !!(r && r.ok), provider: r && r.provider };
}

// Staff creates a request for the client (phone call, walk-in). Same rules as the form.
async function createRequest(id, b, actor) {
  const u = await customerRow(id);
  if (await isBlocked({ userId: u.id })) throw err(409, 'This client is blocked. Unblock them first.');
  const { isNonEmpty, isPhone } = require('../middleware');
  const { TRADES } = require('./estimator');
  const errors = {};
  const phone = String(b.phone || u.phone || '').trim();
  if (!isPhone(phone)) errors.phone = 'A valid phone is required.';
  if (!isNonEmpty(b.address, 200)) errors.address = 'Project address is required.';
  if (!TRADES[b.service_type]) errors.service_type = 'Choose a valid service type.';
  if (b.urgency && !['standard', 'urgent'].includes(b.urgency)) errors.urgency = 'Invalid urgency.';
  if (!isNonEmpty(b.description, 2000)) errors.description = 'Describe the work.';
  if (Object.keys(errors).length) throw Object.assign(err(422, 'Check the request.'), { errors });
  const crypto = require('crypto');
  const info = await db.prepare(
    `INSERT INTO job_requests (customer_id, name, phone, email, address, city, state, zip, service_type, urgency, description, scope_json, claim_token)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(u.id, u.name, phone, norm(u.email), String(b.address).trim(), String(b.city || '').trim(), String(b.state || '').trim().toUpperCase(),
    String(b.zip || '').trim(), b.service_type, b.urgency || 'standard', String(b.description).trim(), '{}', crypto.randomBytes(16).toString('hex'));
  const jobId = info.lastInsertRowid;
  const crm = require('./crm');
  await crm.touchInteraction(jobId, 'created_by_staff', `by ${actor.name}`);
  await auditLog(actor.id, 'client.request_created', 'clients', u.id, `request #${jobId} — ${b.service_type}`);
  const { notify, shell } = require('./notify');
  await notify({ to: u.email, subject: `We created your request — #${jobId}`,
    html: shell('Your request is in', `Hi ${String(u.name).split(' ')[0]}, as we talked, Helpman support created this request for you. We will send you a fixed quote soon; you can follow it from your portal.`,
      [['Request', `#${jobId} — ${b.service_type}`], ['Address', [b.address, b.city, b.zip].filter(Boolean).join(', ')]]) }).catch(() => {});
  return db.prepare('SELECT * FROM job_requests WHERE id = ?').get(jobId);
}

// "Resend access": a fresh password-reset link (1 h) and, if the email is not
// verified, a new verification link. Throttled to once every 10 minutes per client.
async function resendAccess(id, actor) {
  const u = await db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'customer'`).get(Number(id));
  if (!u) throw err(404, 'Client not found.');
  const last = await db.prepare(`SELECT created_at FROM admin_audit WHERE action = 'client.access_resent' AND entity = 'clients' AND entity_id = ? ORDER BY id DESC LIMIT 1`).get(u.id);
  if (last && Date.now() - ts(last.created_at) < 10 * 60 * 1000) throw err(429, 'An access email was sent less than 10 minutes ago.');
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?').run(token, new Date(Date.now() + 3600 * 1000).toISOString(), u.id);
  const base = require('./magiclink').baseUrl();
  const link = `${base}/auth.html?reset=${token}`;
  const { notify, shell } = require('./notify');
  await notify({ to: u.email, subject: 'Your Helpman access link',
    html: shell('Get back into your account', `Hi ${String(u.name).split(' ')[0]}, Helpman support sent you this link to set a new password and open your portal. It works for 1 hour.`, [['Link', link]])
      + `<p style="text-align:center;margin:20px 0;"><a href="${link}" style="background:#143d7a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Set my password</a></p>` }).catch(() => {});
  let verify = false;
  if (!u.email_verified) {
    const vt = crypto.randomBytes(32).toString('hex');
    await db.prepare('UPDATE users SET verify_token = ?, verify_expires = ? WHERE id = ?').run(vt, new Date(Date.now() + 24 * 3600 * 1000).toISOString(), u.id);
    await notify({ to: u.email, subject: 'Confirm your email — Helpman',
      html: shell('Confirm your email', 'Please confirm this is your email so we can keep you updated about your projects.', [['Confirm', `${base}/auth.html?verify=${vt}`]]) }).catch(() => {});
    verify = true;
  }
  await auditLog(actor.id, 'client.access_resent', 'clients', u.id, verify ? 'reset + verification links' : 'reset link');
  return { sent: true, verification_sent: verify };
}

// The client asked not to get marketing (phone call, letter). Opt-in again only
// happens from the client's own action (CAN-SPAM), so there is no "resubscribe" here.
async function unsubscribeMarketing(id, actor) {
  const u = await customerRow(id);
  await require('./unsubscribe').suppress(u.email, 'requested via support');
  await auditLog(actor.id, 'client.marketing_unsubscribed', 'clients', u.id, 'requested via support');
  return { unsubscribed: true };
}

module.exports = {
  LIFECYCLES, SPECIAL_TAGS, LOST_AFTER_DAYS, cleanTag, list, summary, requestsAndProjects, money, messages, notes, tasks, consents, campaignsReceived, history,
  setTags, allTags, isBlocked, addNote, updateNote, deleteNote, addTask, setTaskStatus, emailClient, createRequest, resendAccess, unsubscribeMarketing,
};
