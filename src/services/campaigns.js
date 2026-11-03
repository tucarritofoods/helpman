// CRM Campaigns (Corte 5).
//
//   1. Audience  — a segment builder over the client index of Corte 4 (accounts and
//      people who asked for a quote without an account) or over the pros:
//      lifecycle, tags, city/ZIP, services used, days without activity, number of
//      completed jobs, total spent, guests yes/no. Segments are saved and reused,
//      with a live count. ALWAYS excluded: unsubscribed addresses, blocked clients,
//      people without an email.
//   2. Message   — subject + plain text (blank line = new paragraph, **bold**,
//      links) + an optional button, with variables {{first_name}} {{city}}
//      {{last_service}} (also {{nombre}} {{ciudad}} {{ultimo_servicio}}). Preview
//      for a real recipient and a test send to the staff member's own inbox.
//   3. Send now (the count shown must still be right) or schedule it.
//   4. Results   — queued, sent, failed, skipped, unsubscribed; delivered, bounced,
//      opened and clicked when the email provider (E4: SendGrid + its event
//      webhook) reports them.
//
// Every campaign email goes out from the platform's business sender (mailer.js),
// in the branded layout, with the postal address and a one-click unsubscribe
// (CAN-SPAM, RFC 8058). Nothing is ever sent from a person's own mailbox.
'use strict';
const db = require('../db');
const { auditLog } = require('./audit');
const unsub = require('./unsubscribe');
const toDate = (v) => require('./kpis').toDate(v);

const LEGACY_SEGMENTS = ['all_customers', 'past_customers', 'inactive_clients_90d', 'lost_leads', 'all_contractors', 'pending_contractors', 'top_contractors'];
const VARS = ['first_name', 'name', 'city', 'last_service', 'company', 'nombre', 'ciudad', 'ultimo_servicio'];
const CONTRACTOR_STATUSES = ['pending', 'active', 'suspended', 'rejected'];
const DAY = 86400000;

function err(statusCode, message, extra) { return Object.assign(new Error(message), { statusCode }, extra || {}); }
const norm = (e) => String(e || '').trim().toLowerCase();
const iso = (v) => { const d = toDate(v); return d ? d.toISOString() : null; };

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
const FILTER_SPEC = {
  audience: 'enum', lifecycle: 'list', tags_any: 'list', tags_none: 'list', places: 'list', services: 'list',
  inactive_days_min: 'int', active_within_days: 'int', jobs_min: 'int', jobs_max: 'int',
  spend_min_cents: 'int', spend_max_cents: 'int', include_guests: 'bool', contractor_status: 'list', contractor_min_rating: 'num',
};

function validateFilters(raw) {
  const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {}, errors = {};
  for (const [k, v] of Object.entries(f)) {
    const t = FILTER_SPEC[k];
    if (!t) { errors[k] = 'Unknown filter.'; continue; }
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (t === 'list') {
      const arr = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      if (arr.length > 50 || arr.some((x) => x.length > 60)) errors[k] = 'Too many values.'; else out[k] = [...new Set(arr)];
    } else if (t === 'int') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 1e9) errors[k] = 'Use a whole number (0 or more).'; else out[k] = n;
    } else if (t === 'num') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 5) errors[k] = 'Use a number from 0 to 5.'; else out[k] = n;
    } else if (t === 'bool') {
      out[k] = v === true || v === 'true';
    } else if (t === 'enum') {
      if (!['clients', 'contractors'].includes(v)) errors[k] = 'Audience is clients or contractors.'; else out[k] = v;
    }
  }
  const lcs = require('./clients').LIFECYCLES;
  if (out.lifecycle && out.lifecycle.some((x) => !lcs.includes(x))) errors.lifecycle = `Use: ${lcs.join(', ')}.`;
  if (out.contractor_status && out.contractor_status.some((x) => !CONTRACTOR_STATUSES.includes(x))) errors.contractor_status = `Use: ${CONTRACTOR_STATUSES.join(', ')}.`;
  if (out.jobs_min != null && out.jobs_max != null && out.jobs_min > out.jobs_max) errors.jobs_max = 'Must be at least the minimum.';
  if (out.spend_min_cents != null && out.spend_max_cents != null && out.spend_min_cents > out.spend_max_cents) errors.spend_max_cents = 'Must be at least the minimum.';
  out.audience = out.audience || 'clients';
  return { filters: out, errors };
}

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------
async function buildContext() {
  const clients = require('./clients');
  const index = await clients.loadIndex();
  const suppressed = new Set((await db.prepare('SELECT email FROM email_suppressions').all()).map((r) => norm(r.email)));
  const pros = await db.prepare(`SELECT c.id, c.status, c.city, c.rating_avg, c.jobs_completed, u.id AS user_id, u.name, u.email FROM contractors c JOIN users u ON u.id = c.user_id`).all();
  const { TRADES } = require('./estimator');
  return { index, suppressed, pros, label: (s) => (TRADES[s] && TRADES[s].label) || s || '' };
}

function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }

function audienceFrom(ctx, filters) {
  const excluded = { unsubscribed: 0, blocked: 0, no_email: 0 };
  const now = Date.now();
  let people;
  if (filters.audience === 'contractors') {
    people = ctx.pros.filter((p) => {
      if (filters.contractor_status && !filters.contractor_status.includes(p.status)) return false;
      if (filters.contractor_min_rating != null && Number(p.rating_avg || 0) < filters.contractor_min_rating) return false;
      if (filters.places && !filters.places.includes(norm(p.city))) return false;
      if (filters.jobs_min != null && Number(p.jobs_completed || 0) < filters.jobs_min) return false;
      if (filters.jobs_max != null && Number(p.jobs_completed || 0) > filters.jobs_max) return false;
      return true;
    }).map((p) => ({ user_id: p.user_id, email: norm(p.email), name: p.name, city: p.city || '', last_service: '', blocked: false, lifecycle: null }));
  } else {
    const all = [...ctx.index.byId.values(), ...(filters.include_guests === false ? [] : ctx.index.guests.values())];
    people = all.filter((c) => {
      if (filters.lifecycle && !filters.lifecycle.includes(c.lifecycle)) return false;
      if (filters.tags_any && !filters.tags_any.some((t) => c.tags.includes(t))) return false;
      if (filters.tags_none && filters.tags_none.some((t) => c.tags.includes(t))) return false;
      if (filters.places && !(filters.places.includes(norm(c.city)) || filters.places.includes(norm(c.zip)))) return false;
      if (filters.services && !filters.services.some((s) => c.services.includes(s))) return false;
      const idle = (now - c.last_activity) / DAY;
      if (filters.inactive_days_min != null && idle < filters.inactive_days_min) return false;
      if (filters.active_within_days != null && idle > filters.active_within_days) return false;
      if (filters.jobs_min != null && c.completed < filters.jobs_min) return false;
      if (filters.jobs_max != null && c.completed > filters.jobs_max) return false;
      if (filters.spend_min_cents != null && c.spend_cents < filters.spend_min_cents) return false;
      if (filters.spend_max_cents != null && c.spend_cents > filters.spend_max_cents) return false;
      return true;
    }).map((c) => ({ user_id: c.id, email: norm(c.email), name: c.name, city: c.city || '', last_service: ctx.label(c.last_service), blocked: c.tags.includes('blocked'), lifecycle: c.lifecycle, guest: !!c.guest }));
  }
  const seen = new Set(), members = [];
  for (const p of people) {
    if (!p.email || !p.email.includes('@')) { excluded.no_email++; continue; }
    if (seen.has(p.email)) continue;
    seen.add(p.email);
    if (p.blocked) { excluded.blocked++; continue; }
    if (ctx.suppressed.has(p.email)) { excluded.unsubscribed++; continue; }
    members.push(p);
  }
  return { members, excluded };
}

async function audience(filters) {
  const v = validateFilters(filters);
  if (Object.keys(v.errors).length) throw err(422, 'Check the audience filters.', { errors: v.errors });
  const { members, excluded } = audienceFrom(await buildContext(), v.filters);
  return {
    filters: v.filters, count: members.length, excluded,
    sample: members.slice(0, 10).map((m) => ({ name: m.name, city: m.city, lifecycle: m.lifecycle, guest: !!m.guest, email: m.email })),
  };
}

// ---------------------------------------------------------------------------
// Saved segments
// ---------------------------------------------------------------------------
async function listSegments() {
  const rows = await db.prepare('SELECT s.*, u.name AS created_by_name FROM crm_segments s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.name').all();
  if (!rows.length) return [];
  const ctx = await buildContext();
  return rows.map((r) => {
    const filters = JSON.parse(r.filters_json || '{}');
    return { id: r.id, name: r.name, filters, count: audienceFrom(ctx, validateFilters(filters).filters).members.length, created_by_name: r.created_by_name, updated_at: r.updated_at };
  });
}

async function saveSegment(id, { name, filters }, actor) {
  const n = String(name || '').trim();
  const v = validateFilters(filters);
  const errors = { ...v.errors };
  if (!n || n.length > 80) errors.name = 'Name the segment (max 80 characters).';
  if (Object.keys(errors).length) throw err(422, 'Check the segment.', { errors });
  if (id) {
    const r = await db.prepare('UPDATE crm_segments SET name = ?, filters_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(n, JSON.stringify(v.filters), Number(id));
    if (!r.changes) throw err(404, 'Segment not found.');
    await auditLog(actor.id, 'segment.updated', 'crm_segments', Number(id), n);
    return { id: Number(id), name: n, filters: v.filters };
  }
  const info = await db.prepare('INSERT INTO crm_segments (name, filters_json, created_by) VALUES (?,?,?)').run(n, JSON.stringify(v.filters), actor.id);
  await auditLog(actor.id, 'segment.created', 'crm_segments', info.lastInsertRowid, n);
  return { id: info.lastInsertRowid, name: n, filters: v.filters };
}

async function deleteSegment(id, actor) {
  const s = await db.prepare('SELECT * FROM crm_segments WHERE id = ?').get(Number(id));
  if (!s) throw err(404, 'Segment not found.');
  if (await db.prepare(`SELECT id FROM campaigns WHERE segment_id = ? AND status = 'scheduled'`).get(s.id)) throw err(409, 'A scheduled campaign uses this segment. Unschedule it first.');
  await db.prepare('DELETE FROM crm_segments WHERE id = ?').run(s.id);
  await auditLog(actor.id, 'segment.deleted', 'crm_segments', s.id, s.name);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------
function varsFor(r) {
  const first = firstName(r.name) || 'there';
  return { first_name: first, name: r.name || first, city: r.city || '', last_service: r.last_service || '', company: 'Helpman',
    nombre: firstName(r.name) || '', ciudad: r.city || '', ultimo_servicio: r.last_service || '' };
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function fill(str, vars, escape) {
  return String(str || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => { const v = vars[k] == null ? '' : String(vars[k]); return escape ? esc(v) : v; });
}
function unknownVars(str) {
  return [...String(str || '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).filter((k) => !VARS.includes(k));
}
function safeUrl(u) {
  const s = String(u || '').trim();
  if (/^https:\/\/[^\s<>"']+$/i.test(s)) return s;
  if (/^\/[^\s<>"']*$/.test(s)) return require('./magiclink').baseUrl() + s;
  return null;
}

// Plain text → email HTML. Escaped first, so nothing typed (or any variable) can inject markup.
function bodyHtml(text, vars) {
  const safe = fill(esc(String(text || '')), vars, true);
  return safe.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const inner = p.replace(/\n/g, '<br>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(https:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2b6fe3;">$1</a>');
    return `<p style="margin:0 0 14px;color:#1d2a3a;font-size:15px;line-height:1.65;">${inner}</p>`;
  }).join('');
}

function validateContent(b) {
  const errors = {};
  const name = String(b.name || '').trim(), subject = String(b.subject || '').trim(), body = String(b.body_text || '').trim();
  if (!name || name.length > 160) errors.name = 'Name the campaign (max 160 characters).';
  if (!subject || subject.length > 150) errors.subject = 'Write a subject (max 150 characters).';
  if (!body || body.length > 10000) errors.body_text = 'Write the message (max 10,000 characters).';
  const hint = `Use ${VARS.slice(0, 4).map((v) => `{{${v}}}`).join(', ')}.`;
  const badS = unknownVars(subject), badB = unknownVars(body);
  if (badS.length && !errors.subject) errors.subject = `Unknown variable {{${badS[0]}}}. ${hint}`;
  if (badB.length && !errors.body_text) errors.body_text = `Unknown variable {{${badB[0]}}}. ${hint}`;
  let button_label = String(b.button_label || '').trim() || null, button_url = String(b.button_url || '').trim() || null;
  if (button_label || button_url) {
    if (!button_label || button_label.length > 40) errors.button_label = 'Button text (max 40 characters).';
    if (!safeUrl(button_url)) errors.button_url = 'Use an https:// link or a page of helpman.app (starting with /).';
  }
  return { errors, content: { name, subject, body_text: body, button_label, button_url } };
}

// Full email for one recipient. outboxId ties the unsubscribe link to the results.
function render(c, r, outboxId) {
  const vars = varsFor(r);
  const { brandShell } = require('./notify');
  const button = c.button_label && safeUrl(c.button_url)
    ? `<p style="text-align:center;margin:24px 0 8px;"><a href="${esc(safeUrl(c.button_url))}" style="background:#2b6fe3;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">${esc(fill(c.button_label, vars, false))}</a></p>` : '';
  const subject = fill(c.subject, vars, false).replace(/[\r\n]+/g, ' ').slice(0, 200);
  const html = brandShell(esc(subject), '', bodyHtml(c.body_text, vars) + button + unsub.footerHtml(r.email, outboxId));
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Campaign CRUD
// ---------------------------------------------------------------------------
async function getCampaign(id) {
  const c = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(id));
  if (!c) throw err(404, 'Campaign not found.');
  return c;
}
async function filtersOf(c) {
  if (c.segment_id) {
    const s = await db.prepare('SELECT filters_json FROM crm_segments WHERE id = ?').get(c.segment_id);
    if (s) return JSON.parse(s.filters_json || '{}');
  }
  return JSON.parse(c.filters_json || '{}');
}

async function upsert(id, b, actor) {
  const { errors, content } = validateContent(b);
  let segmentId = null, filters = null;
  if (b.segment_id) {
    const s = await db.prepare('SELECT id FROM crm_segments WHERE id = ?').get(Number(b.segment_id));
    if (!s) errors.segment_id = 'Segment not found.'; else segmentId = s.id;
  } else {
    const v = validateFilters(b.filters);
    Object.assign(errors, v.errors);
    filters = v.filters;
  }
  if (Object.keys(errors).length) throw err(422, 'Check the campaign.', { errors });
  const vals = [content.name, segmentId, filters ? JSON.stringify(filters) : null, content.subject, content.body_text, content.button_label, content.button_url];
  if (id) {
    const c = await getCampaign(id);
    if (c.status !== 'draft') throw err(409, 'Only drafts can be edited. Unschedule it first.');
    await db.prepare(`UPDATE campaigns SET name = ?, segment_id = ?, filters_json = ?, subject = ?, body_text = ?, button_label = ?, button_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals, c.id);
    await auditLog(actor.id, 'campaign.updated', 'campaigns', c.id, content.name);
    return getCampaign(c.id);
  }
  const info = await db.prepare(`INSERT INTO campaigns (name, segment, segment_id, filters_json, subject, body_text, button_label, button_url, created_by, status, updated_at)
    VALUES (?, 'builder', ?, ?, ?, ?, ?, ?, ?, 'draft', CURRENT_TIMESTAMP)`).run(content.name, segmentId, vals[2], content.subject, content.body_text, content.button_label, content.button_url, actor.id);
  await auditLog(actor.id, 'campaign.created', 'campaigns', info.lastInsertRowid, content.name);
  return getCampaign(info.lastInsertRowid);
}

async function list() {
  const rows = await db.prepare(`SELECT c.*, s.name AS segment_name, u.name AS created_by_name,
      (SELECT COUNT(*) FROM email_outbox o WHERE o.campaign_id = c.id) AS recipients,
      (SELECT COUNT(*) FROM email_outbox o WHERE o.campaign_id = c.id AND o.status = 'sent') AS sent
    FROM campaigns c LEFT JOIN crm_segments s ON s.id = c.segment_id LEFT JOIN users u ON u.id = c.created_by ORDER BY c.id DESC`).all();
  return rows.map((r) => ({ ...r, recipients: Number(r.recipients), sent: Number(r.sent), builder: r.segment === 'builder' }));
}

async function detail(id) {
  const c = await getCampaign(id);
  const out = { ...c, filters: c.segment === 'builder' ? await filtersOf(c) : null };
  delete out.filters_json;
  return out;
}

// A real recipient of the audience (or a sample when it is empty), to preview with.
async function sampleRecipient(c, email) {
  const { members } = audienceFrom(await buildContext(), validateFilters(await filtersOf(c)).filters);
  const r = (email && members.find((m) => m.email === norm(email))) || members[0]
    || { email: 'sample@example.com', name: 'Sample Customer', city: 'Vallejo', last_service: 'Painting' };
  return { r, count: members.length };
}

async function preview(id, { recipient_email } = {}) {
  const c = await getCampaign(id);
  if (c.segment !== 'builder') throw err(409, 'Preview is for campaigns made with the builder.');
  const { r, count } = await sampleRecipient(c, recipient_email);
  const { subject, html } = render(c, r, null);
  return { subject, html, recipient: { name: r.name, email: r.email, city: r.city }, audience_count: count };
}

// Test: to the staff member's own inbox (never to a client), marked [TEST],
// personalized as the first person of the audience.
async function sendTest(id, actor) {
  const c = await getCampaign(id);
  if (c.segment !== 'builder') throw err(409, 'Test sends are for campaigns made with the builder.');
  const me = await db.prepare('SELECT email FROM users WHERE id = ?').get(actor.id);
  const { r } = await sampleRecipient(c, null);
  const m = render(c, { ...r, email: me.email }, null);
  const subject = '[TEST] ' + m.subject;
  const result = await require('./mailer').send({ to: me.email, subject, html: m.html });
  await db.prepare('INSERT INTO email_log (outbox_id, to_email, subject, status, provider) VALUES (NULL,?,?,?,?)').run(me.email, subject, result.ok ? 'sent' : 'failed', result.provider || 'console');
  await db.prepare('UPDATE campaigns SET test_sent_at = CURRENT_TIMESTAMP WHERE id = ?').run(c.id);
  await auditLog(actor.id, 'campaign.test_sent', 'campaigns', c.id, me.email);
  return { sent: !!result.ok, to: me.email, provider: result.provider };
}

function realDeliveryReady() {
  const mailer = require('./mailer');
  if (mailer.activeProvider() !== 'console' && !process.env.COMPANY_POSTAL_ADDRESS) {
    throw err(400, 'Set COMPANY_POSTAL_ADDRESS before sending real campaigns (required in the footer of promotional email).');
  }
}

// Resolve the audience NOW and fill the outbox. Atomic claim: never launched twice.
async function launch(c, actorId, expectedCount) {
  realDeliveryReady();
  const { members } = audienceFrom(await buildContext(), validateFilters(await filtersOf(c)).filters);
  if (expectedCount != null && Number(expectedCount) !== members.length) {
    throw err(409, `The audience changed: it is now ${members.length}. Check it and confirm again.`, { code: 'AUDIENCE_CHANGED', count: members.length });
  }
  if (!members.length) throw err(409, 'Nobody to send to: the audience is empty.');
  const claim = await db.prepare(`UPDATE campaigns SET status = 'sending', started_at = CURRENT_TIMESTAMP, audience_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('draft','scheduled')`).run(members.length, c.id);
  if (claim.changes !== 1) throw err(409, 'This campaign was already sent or cancelled.');
  const provider = require('./mailer').activeProvider();
  for (const m of members) {
    const info = await db.prepare(`INSERT INTO email_outbox (campaign_id, to_email, to_name, subject, body_html, provider, recipient_user_id, status) VALUES (?,?,?,?,?,?,?, 'sending')`)
      .run(c.id, m.email, m.name || null, '', '', provider, m.user_id || null);
    const r = render(c, m, info.lastInsertRowid);
    // 'sending' while it is being written, so the worker never picks up an empty row.
    await db.prepare(`UPDATE email_outbox SET subject = ?, body_html = ?, status = 'queued' WHERE id = ?`).run(r.subject, r.html, info.lastInsertRowid);
  }
  await auditLog(actorId, 'campaign.sent', 'campaigns', c.id, `"${c.name}" → ${members.length} recipient(s)`);
  return { status: 'sending', recipients: members.length };
}

async function sendNow(id, { expected_count }, actor) {
  const c = await getCampaign(id);
  if (c.segment !== 'builder') throw err(409, 'Use Queue + Send for this older campaign.');
  if (!['draft', 'scheduled'].includes(c.status)) throw err(409, 'This campaign was already sent or cancelled.');
  if (expected_count == null) throw err(422, 'Confirm the number of recipients.', { errors: { expected_count: 'Required.' } });
  const out = await launch(c, actor.id, expected_count);
  const n = await require('../routes/campaigns').processOutbox(50).catch(() => 0);
  return { ...out, flushed_now: n };
}

async function schedule(id, { at }, actor) {
  const c = await getCampaign(id);
  if (c.segment !== 'builder') throw err(409, 'Only builder campaigns can be scheduled.');
  if (c.status !== 'draft') throw err(409, 'Only drafts can be scheduled.');
  const d = new Date(at);
  if (!at || isNaN(d.getTime())) throw err(422, 'Choose a date and time.', { errors: { at: 'Choose a date and time.' } });
  if (d.getTime() < Date.now() + 5 * 60000) throw err(422, 'Schedule at least 5 minutes ahead.', { errors: { at: 'At least 5 minutes from now.' } });
  if (d.getTime() > Date.now() + 90 * DAY) throw err(422, 'Schedule within the next 90 days.', { errors: { at: 'Within 90 days.' } });
  realDeliveryReady();
  await db.prepare(`UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'`).run(d.toISOString(), c.id);
  await auditLog(actor.id, 'campaign.scheduled', 'campaigns', c.id, d.toISOString());
  return getCampaign(c.id);
}

async function unschedule(id, actor) {
  const r = await db.prepare(`UPDATE campaigns SET status = 'draft', scheduled_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'scheduled'`).run(Number(id));
  if (r.changes !== 1) throw err(409, 'This campaign is not scheduled.');
  await auditLog(actor.id, 'campaign.unscheduled', 'campaigns', Number(id), null);
  return getCampaign(id);
}

// Stop: a draft/scheduled campaign is cancelled; a campaign that is sending stops
// the emails that have not gone out yet.
async function cancel(id, actor) {
  const c = await getCampaign(id);
  if (!['draft', 'scheduled', 'sending', 'queued'].includes(c.status)) throw err(409, 'This campaign already finished.');
  await db.prepare(`UPDATE campaigns SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id);
  const stopped = await db.prepare(`UPDATE email_outbox SET status = 'failed', error = 'cancelled' WHERE campaign_id = ? AND status = 'queued'`).run(c.id);
  await auditLog(actor.id, 'campaign.cancelled', 'campaigns', c.id, `${stopped.changes} unsent email(s) stopped`);
  return { cancelled: true, stopped: stopped.changes };
}

async function duplicate(id, actor) {
  const c = await getCampaign(id);
  if (c.segment !== 'builder') throw err(409, 'Only builder campaigns can be duplicated.');
  const info = await db.prepare(`INSERT INTO campaigns (name, segment, segment_id, filters_json, subject, body_text, button_label, button_url, created_by, status, updated_at)
    VALUES (?, 'builder', ?, ?, ?, ?, ?, ?, ?, 'draft', CURRENT_TIMESTAMP)`).run(`${c.name} (copy)`.slice(0, 160), c.segment_id, c.filters_json, c.subject, c.body_text, c.button_label, c.button_url, actor.id);
  await auditLog(actor.id, 'campaign.created', 'campaigns', info.lastInsertRowid, `copy of #${c.id}`);
  return getCampaign(info.lastInsertRowid);
}

// Background (every 30 s): launch the scheduled campaigns whose time has come.
async function runScheduled({ now = new Date() } = {}) {
  const due = (await db.prepare(`SELECT * FROM campaigns WHERE status = 'scheduled' AND scheduled_at IS NOT NULL`).all())
    .filter((c) => { const d = toDate(c.scheduled_at); return d && d.getTime() <= now.getTime(); });
  let launched = 0;
  for (const c of due) {
    try { await launch(c, c.created_by, null); launched++; }
    catch (e) {
      // Empty audience or a missing postal address: back to draft, and the team is told.
      await db.prepare(`UPDATE campaigns SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'scheduled'`).run(c.id);
      await auditLog(null, 'campaign.schedule_failed', 'campaigns', c.id, e.message);
      const { notify, shell } = require('./notify');
      const who = c.created_by ? await db.prepare('SELECT email FROM users WHERE id = ?').get(c.created_by) : null;
      if (who) await notify({ to: who.email, subject: `Scheduled campaign not sent — ${c.name}`, html: shell('Your scheduled campaign was not sent', e.message, [['Campaign', c.name]]) }).catch(() => {});
    }
  }
  return { launched, due: due.length };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
async function results(id, { page = 1, status } = {}) {
  const c = await getCampaign(id);
  const n = async (where) => Number((await db.prepare(`SELECT COUNT(*) c FROM email_outbox WHERE campaign_id = ? AND ${where}`).get(c.id)).c);
  const totals = {
    recipients: await n('1=1'), queued: await n(`status IN ('queued','sending')`), sent: await n(`status = 'sent'`),
    failed: await n(`status = 'failed' AND (error IS NULL OR error NOT IN ('unsubscribed','cancelled'))`),
    skipped_unsubscribed: await n(`status = 'failed' AND error = 'unsubscribed'`), cancelled: await n(`status = 'failed' AND error = 'cancelled'`),
    delivered: await n('delivered_at IS NOT NULL'), bounced: await n('bounced_at IS NOT NULL'),
    opened: await n('opened_at IS NOT NULL'), clicked: await n('clicked_at IS NOT NULL'), unsubscribed: await n('unsubscribed_at IS NOT NULL'),
  };
  const tracking = require('./mailer').activeProvider() === 'sendgrid' && !!process.env.SENDGRID_WEBHOOK_KEY;
  const per = 50, pg = Math.max(1, Number(page) || 1);
  const filter = { sent: `status = 'sent'`, delivered: 'delivered_at IS NOT NULL', failed: `status = 'failed'`, queued: `status IN ('queued','sending')`, opened: 'opened_at IS NOT NULL', clicked: 'clicked_at IS NOT NULL', bounced: 'bounced_at IS NOT NULL', unsubscribed: 'unsubscribed_at IS NOT NULL' }[status] || '1=1';
  const rows = await db.prepare(`SELECT id, to_email, to_name, status, error, sent_at, delivered_at, opened_at, clicked_at, bounced_at, unsubscribed_at, open_count, click_count
    FROM email_outbox WHERE campaign_id = ? AND ${filter} ORDER BY id LIMIT ? OFFSET ?`).all(c.id, per, (pg - 1) * per);
  return { campaign: { id: c.id, name: c.name, status: c.status, started_at: iso(c.started_at), completed_at: iso(c.completed_at), scheduled_at: iso(c.scheduled_at), audience_count: c.audience_count },
    totals, tracking, provider: require('./mailer').activeProvider(), page: pg, per_page: per, rows };
}

// SendGrid event → the outbox row it belongs to (custom arg outbox_id + same email).
async function recordEvent(ev) {
  const id = Number(ev && ev.outbox_id);
  if (!id || typeof ev.email !== 'string') return false;
  const row = await db.prepare('SELECT id, to_email FROM email_outbox WHERE id = ?').get(id);
  if (!row || norm(row.to_email) !== norm(ev.email)) return false;
  const at = ev.timestamp ? new Date(Number(ev.timestamp) * 1000).toISOString() : new Date().toISOString();
  const SET = {
    delivered: 'delivered_at = COALESCE(delivered_at, ?)',
    open: 'opened_at = COALESCE(opened_at, ?), open_count = open_count + 1',
    click: 'clicked_at = COALESCE(clicked_at, ?), click_count = click_count + 1',
    bounce: 'bounced_at = COALESCE(bounced_at, ?)', dropped: 'bounced_at = COALESCE(bounced_at, ?)',
    spamreport: 'unsubscribed_at = COALESCE(unsubscribed_at, ?)', unsubscribe: 'unsubscribed_at = COALESCE(unsubscribed_at, ?)', group_unsubscribe: 'unsubscribed_at = COALESCE(unsubscribed_at, ?)',
  }[ev.event];
  if (!SET) return false;
  await db.prepare(`UPDATE email_outbox SET ${SET} WHERE id = ?`).run(at, row.id);
  return true;
}

async function recordUnsubscribe(outboxId, email) {
  if (!outboxId) return false;
  const r = await db.prepare('UPDATE email_outbox SET unsubscribed_at = COALESCE(unsubscribed_at, CURRENT_TIMESTAMP) WHERE id = ? AND LOWER(to_email) = ?').run(Number(outboxId), norm(email));
  return r.changes === 1;
}

// ---------------------------------------------------------------------------
// Templates (reusable messages)
// ---------------------------------------------------------------------------
async function saveTemplate(b, actor) {
  const { errors, content } = validateContent({ ...b, name: b.name });
  if (Object.keys(errors).length) throw err(422, 'Check the template.', { errors });
  // body_html stays filled for older code paths: the same text rendered without a recipient.
  const info = await db.prepare('INSERT INTO email_templates (name, subject, body_html, body_text, button_label, button_url) VALUES (?,?,?,?,?,?)')
    .run(content.name, content.subject, bodyHtml(content.body_text, {}), content.body_text, content.button_label, content.button_url);
  await auditLog(actor.id, 'template.created', 'email_templates', info.lastInsertRowid, content.name);
  return db.prepare('SELECT * FROM email_templates WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = {
  LEGACY_SEGMENTS, VARS, validateFilters, buildContext, audienceFrom, audience, listSegments, saveSegment, deleteSegment,
  bodyHtml, render, validateContent, upsert, list, detail, preview, sendTest, sendNow, schedule, unschedule, cancel, duplicate,
  runScheduled, results, recordEvent, recordUnsubscribe, saveTemplate,
};
