// Mass campaigns: templates, segments, outbox queue, pluggable sending.
// Sending is NEVER fake: default provider logs to console AND records every
// attempt in email_log. See src/services/mailer.js.
const express = require('express');
const { requireStaff, can } = require('../services/permissions');
const db = require('../db');
const { ah, authRequired, requireRole, isNonEmpty, failIfErrors } = require('../middleware');
const crm = require('../services/crm');
const mailer = require('../services/mailer');
const { auditLog } = require('../services/audit');

const unsub = require('../services/unsubscribe');
const router = express.Router();
router.use(authRequired, requireStaff('marketing'));

const SEGMENTS = ['all_customers', 'past_customers', 'inactive_clients_90d', 'lost_leads',
  'all_contractors', 'pending_contractors', 'top_contractors'];

// ---- Templates ----
router.get('/templates', ah(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM email_templates ORDER BY id DESC').all());
}));

router.post('/templates', ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!isNonEmpty(b.name, 120)) errors.name = 'Name required.';
  if (!isNonEmpty(b.subject, 200)) errors.subject = 'Subject required.';
  if (!isNonEmpty(b.body_html, 20000)) errors.body_html = 'Body required. Use {{name}} style variables.';
  if (failIfErrors(res, errors)) return;
  const info = await db.prepare('INSERT INTO email_templates (name, subject, body_html) VALUES (?,?,?)')
    .run(b.name.trim(), b.subject.trim(), b.body_html);
  res.status(201).json(await db.prepare('SELECT * FROM email_templates WHERE id = ?').get(info.lastInsertRowid));
}));

// ---- Corte 5: segment builder, saved segments, builder campaigns ----
const svc = require('../services/campaigns');
const run = (fn, okStatus) => ah(async (req, res) => {
  try { res.status(okStatus || 200).json(await fn(req)); }
  catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json(e.errors ? { errors: e.errors } : { error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.count != null ? { count: e.count } : {}) });
    throw e;
  }
});
router.post('/builder/templates', run((req) => svc.saveTemplate(req.body || {}, req.user), 201));
router.post('/audience', run((req) => svc.audience((req.body || {}).filters)));
router.get('/segments', run(() => svc.listSegments()));
router.post('/segments', run((req) => svc.saveSegment(null, req.body || {}, req.user), 201));
router.put('/segments/:sid', run((req) => svc.saveSegment(req.params.sid, req.body || {}, req.user)));
router.delete('/segments/:sid', run((req) => svc.deleteSegment(req.params.sid, req.user)));
router.get('/variables', (req, res) => res.json(svc.VARS));

// ---- Campaigns ----
router.get('/', run(() => svc.list()));

router.post('/', ah(async (req, res, next) => {
  const b = req.body || {};
  // Builder campaign (subject + message + audience); the older shape (segment + template) still works.
  if (b.body_text !== undefined || b.subject !== undefined || b.filters !== undefined || b.segment_id !== undefined) {
    return run((r) => svc.upsert(null, r.body || {}, r.user), 201)(req, res, next);
  }
  const errors = {};
  if (!isNonEmpty(b.name, 160)) errors.name = 'Name required.';
  if (!SEGMENTS.includes(b.segment)) errors.segment = 'Unknown segment.';
  if (!await db.prepare('SELECT id FROM email_templates WHERE id = ?').get(b.template_id)) errors.template_id = 'Template not found.';
  if (failIfErrors(res, errors)) return;
  const info = await db.prepare('INSERT INTO campaigns (name, segment, template_id) VALUES (?,?,?)')
    .run(b.name.trim(), b.segment, b.template_id);
  res.status(201).json(await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(info.lastInsertRowid));
}));

router.get('/:id', run((req) => svc.detail(req.params.id)));
router.put('/:id', run((req) => svc.upsert(req.params.id, req.body || {}, req.user)));
router.post('/:id/preview', run((req) => svc.preview(req.params.id, req.body || {})));
router.post('/:id/test', run((req) => svc.sendTest(req.params.id, req.user)));
router.post('/:id/send-now', run((req) => svc.sendNow(req.params.id, req.body || {}, req.user)));
router.post('/:id/schedule', run((req) => svc.schedule(req.params.id, req.body || {}, req.user)));
router.post('/:id/unschedule', run((req) => svc.unschedule(req.params.id, req.user)));
router.post('/:id/cancel', run((req) => svc.cancel(req.params.id, req.user)));
router.post('/:id/duplicate', run((req) => svc.duplicate(req.params.id, req.user), 201));
router.get('/:id/results', run((req) => svc.results(req.params.id, req.query || {})));

// Resolve the segment into the outbox (one row per recipient). Idempotent-ish:
// re-queueing skips addresses already queued for this campaign.
router.post('/:id/queue', ah(async (req, res) => {
  const c = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  if (c.segment === 'builder') return res.status(409).json({ error: 'Use "Send now" or "Schedule" for this campaign.' });
  const t = await db.prepare('SELECT * FROM email_templates WHERE id = ?').get(c.template_id);
  if (!t) return res.status(400).json({ error: 'Template missing.' });

  // Real delivery needs the sender's physical address in every promotional email.
  if (mailer.activeProvider() !== 'console' && !process.env.COMPANY_POSTAL_ADDRESS) {
    return res.status(400).json({ error: 'Set COMPANY_POSTAL_ADDRESS before sending real campaigns (required in the footer of promotional email).' });
  }

  let members;
  try { members = await crm.segmentMembers(c.segment); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const haveRows = await db.prepare('SELECT to_email FROM email_outbox WHERE campaign_id = ?').all(c.id);
  const have = new Set(haveRows.map(r => r.to_email));
  let queued = 0;
  let skippedUnsubscribed = 0;
  // NOTE: the transaction handle is `tx`, NOT `t`: an inner `t` used to shadow the template `t`, so every
  // queued email got the subject and body "undefined".
  await db.transaction(async (tx) => {
    const ins = tx.prepare(
      `INSERT INTO email_outbox (campaign_id, to_email, to_name, subject, body_html, provider)
       VALUES (?,?,?,?,?,?)`
    );
    for (const m of members) {
      if (!m.email || have.has(m.email)) continue;
      if (await unsub.isSuppressed(m.email)) { skippedUnsubscribed++; continue; }
      const vars = { name: m.name || 'there', company: 'Helpman', ...(m.context || {}) };
      await ins.run(c.id, m.email, m.name, crm.renderTemplate(t.subject, vars),
        crm.renderTemplate(t.body_html, vars, { escape: true }) + unsub.footerHtml(m.email), mailer.activeProvider());
      queued++;
    }
    await tx.prepare(`UPDATE campaigns SET status = 'queued' WHERE id = ?`).run(c.id);
  });
  res.json({ queued, skipped_unsubscribed: skippedUnsubscribed, campaign_id: c.id });
}));

// Mark for sending; the background worker (server.js) drains the outbox.
router.post('/:id/send', ah(async (req, res) => {
  const c = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  if (c.segment === 'builder') return res.status(409).json({ error: 'Use "Send now" for this campaign.' });
  await db.prepare(`UPDATE campaigns SET status = 'sending' WHERE id = ?`).run(c.id);
  await auditLog(req.user.id, 'campaign.sent', 'campaigns', c.id, `Campaign "${c.name}" → segment ${c.segment}`);
  const n = await processOutbox(50); // also flush a batch right now for immediacy
  res.json({ status: 'sending', flushed_now: n });
}));

router.get('/:id/outbox', ah(async (req, res) => {
  res.json(await db.prepare('SELECT id, to_email, to_name, subject, status, provider, error, sent_at FROM email_outbox WHERE campaign_id = ? ORDER BY id').all(req.params.id));
}));

// ---- Outbox worker: drains queued rows, logs EVERY attempt ----
async function processOutbox(limit = 50) {
  const rows = await db.prepare(`SELECT * FROM email_outbox WHERE status = 'queued' ORDER BY id LIMIT ?`).all(limit);
  let done = 0;
  const mark = db.prepare(`UPDATE email_outbox SET status = ?, sent_at = ?, error = ? WHERE id = ?`);
  const log = db.prepare(`INSERT INTO email_log (outbox_id, to_email, subject, status, provider) VALUES (?,?,?,?,?)`);
  for (const r of rows) {
    // Claim the row atomically: a second worker/instance skips rows already taken.
    const claim = await db.prepare(`UPDATE email_outbox SET status = 'sending' WHERE id = ? AND status = 'queued'`).run(r.id);
    if (claim.changes !== 1) continue;
    try {
      // Honor opt-outs that arrived AFTER the campaign was queued.
      if (await unsub.isSuppressed(r.to_email)) {
        await mark.run('failed', null, 'unsubscribed', r.id);
        await log.run(r.id, r.to_email, r.subject, 'failed', r.provider);
        continue;
      }
      const result = await mailer.send({
        to: r.to_email, subject: r.subject, html: r.body_html,
        headers: { 'List-Unsubscribe': `<${unsub.link(r.to_email, r.id)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        customArgs: { outbox_id: r.id, campaign_id: r.campaign_id },
      });
      await mark.run(result.ok ? 'sent' : 'failed', result.ok ? new Date().toISOString() : null, result.error || null, r.id);
      await log.run(r.id, r.to_email, r.subject, result.ok ? 'sent' : 'failed', result.provider);
      // Close out finished campaigns.
      const pending = (await db.prepare(`SELECT COUNT(*) c FROM email_outbox WHERE campaign_id = ? AND status IN ('queued','sending')`).get(r.campaign_id)).c;
      if (Number(pending) === 0) await db.prepare(`UPDATE campaigns SET status = 'done', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued','sending')`).run(r.campaign_id);
    } catch (err) {
      await mark.run('failed', null, String(err.message).slice(0, 200), r.id);
      await log.run(r.id, r.to_email, r.subject, 'failed', r.provider);
    }
    done++;
  }
  return done;
}

module.exports = router;
module.exports.processOutbox = processOutbox;
