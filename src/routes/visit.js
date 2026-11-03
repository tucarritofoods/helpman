// Public, link-based endpoints of the "Your job is finished — did everything go
// well?" email (confirm.html). The signed, expiring link IS the credential: it is
// bound to one project and one customer. No contact details of the pro are ever
// returned here (golden rule) — only "First L." and the finished-work photos.
'use strict';
const express = require('express');
const db = require('../db');
const { ah, failIfErrors } = require('../middleware');
const visit = require('../services/visit');

const router = express.Router();

async function load(req, res) {
  const pt = await visit.loadByToken(req.params.token);
  if (pt.error) { res.status(403).json({ error: 'This link is invalid or has expired. Open your project from your Helpman portal instead.' }); return null; }
  return pt;
}

async function status(pt) {
  if (await db.prepare('SELECT id FROM completion_sheets WHERE project_id = ?').get(pt.project.id)) return 'confirmed';
  if (await require('../services/disputes').openDisputeFor(pt.project.id)) return 'problem_reported';
  if (pt.project.stage === 'cancelled') return 'cancelled';
  const p = pt.project;
  if (p.stage === 'review' && p.departed_at) return 'awaiting_confirmation';
  if (['in_progress', 'review'].includes(p.stage)) {
    // Legacy path: every milestone approved in the portal also allows signing.
    const ms = await db.prepare('SELECT customer_approval FROM milestones WHERE project_id = ?').all(p.id);
    if (ms.length && ms.every((m) => m.customer_approval === 'approved')) return 'awaiting_confirmation';
  }
  return 'not_ready';
}

router.get('/:token', ah(async (req, res) => {
  const pt = await load(req, res); if (!pt) return;
  const billing = require('../services/billing');
  const { displayName, firstName } = require('../services/views');
  res.json({
    project_id: pt.project.id,
    service_type: pt.job.service_type,
    customer_first_name: firstName(pt.customer ? pt.customer.name : pt.job.name),
    tech_name: pt.pro ? displayName(pt.pro.name) : null,
    // Same-origin paths on the page (the email uses absolute URLs).
    photos: (await visit.completionPhotoUrls(pt.project.id)).map((u) => u.replace(require('../services/magiclink').baseUrl(), '')),
    balance_cents: await billing.balanceCents(pt.project.id),
    auto_charge: await visit.willAutoCharge(pt.project.id),
    card_consent_text: billing.CARD_CONSENT_TEXT,
    status: await status(pt),
    reasons: visit.PROBLEM_REASONS,
  });
}));

router.post('/:token/confirm', ah(async (req, res) => {
  const pt = await load(req, res); if (!pt) return;
  if (!pt.job.customer_id) return res.status(409).json({ error: 'Please sign in to your portal to confirm this project.' });
  const b = req.body || {};
  if (failIfErrors(res, visit.validateSignOff(b))) return;
  try {
    const out = await visit.confirmWork(pt.project, { userId: pt.job.customer_id, b, ip: req.ip || null, via: 'email' });
    res.status(201).json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
    throw e;
  }
}));

router.post('/:token/problem', ah(async (req, res) => {
  const pt = await load(req, res); if (!pt) return;
  if (await db.prepare('SELECT id FROM completion_sheets WHERE project_id = ?').get(pt.project.id)) {
    return res.status(409).json({ error: 'This project was already confirmed. To report a problem, open it in your portal.' });
  }
  try {
    res.status(201).json(await visit.reportProblem(pt, req.body || {}));
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    throw e;
  }
}));

module.exports = router;
