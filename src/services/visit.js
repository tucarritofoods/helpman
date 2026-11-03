// The visit, end to end (Corte 3), with every email of the cycle:
//
//   pro: "On my way"  → customer email (+ SMS if opted in)
//   pro: "I've arrived" (check-in) → stage in_progress, customer email with the pro's photo
//   pro: uploads photos of the finished work → "Work finished" (check-out)
//        → stage review, milestones done, customer email with the photos and two
//          buttons: "Everything is fine — confirm & sign" / "Report a problem"
//   customer confirms (from the email link, no login, or from the portal)
//        → signed completion sheet, project COMPLETED, pro's payable created,
//          balance charged automatically to the saved card (Corte 2), receipt
//   customer reports a problem → dispute opened, payments on hold, support notified
//   background: confirmation reminder (24 h), escalation to support (72 h),
//               review reminder (3 days after completion)
//
// Golden rule: every email to the customer names the pro as "First L." with the
// photo; nothing here exposes contact details to either side.
'use strict';
const db = require('../db');
const magic = require('./magiclink');
const { auditLog } = require('./audit');
const { displayName, firstName } = require('./views');

const VISIT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // confirmation links stay valid two weeks
const H = 3600 * 1000;
const toDate = (v) => require('./kpis').toDate(v);
const money = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

function err(statusCode, message, code) { return Object.assign(new Error(message), { statusCode, code }); }

// ---------------------------------------------------------------------------
// People and links
// ---------------------------------------------------------------------------
async function parties(projectId) {
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return {};
  const job = await db.prepare('SELECT * FROM job_requests WHERE id = ?').get(project.job_request_id);
  const customer = job && job.customer_id
    ? await db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(job.customer_id)
    : (job && job.email ? { id: null, name: job.name, email: job.email } : null);
  const pro = project.contractor_id
    ? await db.prepare('SELECT c.id, c.photo_filename, c.user_id, u.name, u.email FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(project.contractor_id)
    : null;
  return { project, job, customer, pro };
}

function links(projectId, customerId) {
  const token = magic.sign({ purpose: 'visit', projectId, customerId: customerId || 0 }, VISIT_TTL_MS);
  const base = `${magic.baseUrl()}/confirm.html?t=${encodeURIComponent(token)}`;
  return { token, confirmUrl: base, problemUrl: `${base}&problem=1` };
}

// The customer's confirmation link → { project, job, customer } or an error.
async function loadByToken(token) {
  const p = magic.verify(token);
  if (!p || p.purpose !== 'visit') return { error: 'invalid' };
  const pt = await parties(p.projectId);
  if (!pt.project) return { error: 'invalid' };
  if ((pt.job.customer_id || 0) !== (p.customerId || 0)) return { error: 'invalid' };
  return pt;
}

async function completionPhotoUrls(projectId) {
  const rows = await db.prepare(`SELECT filename FROM photos WHERE project_id = ? AND kind = 'completion' ORDER BY id DESC LIMIT 4`).all(projectId);
  return rows.map(r => `${magic.baseUrl()}/api/photos/${encodeURIComponent(r.filename)}`);
}

async function willAutoCharge(projectId) {
  if (!require('./stripe').isEnabled()) return false;
  const a = await require('./billing').authorizationFor(projectId);
  return !!(a && a.payment_method_id);
}

async function emailCustomer(pt, subject, html) {
  if (!pt.customer || !pt.customer.email) return;
  const { notify } = require('./notify');
  await notify({ to: pt.customer.email, subject, html }).catch(() => {});
}
async function emailAdmins(subject, lead, rows) {
  const { notify, shell } = require('./notify');
  const admins = await db.prepare("SELECT email FROM users WHERE role = 'admin' AND (staff_role IS NULL OR staff_role <> 'disabled')").all();
  for (const a of admins) await notify({ to: a.email, subject, html: shell(subject, lead, rows) }).catch(() => {});
}
const proView = (pt) => {
  const { contractorPhotoUrl } = require('./notify');
  return { techName: pt.pro ? displayName(pt.pro.name) : 'Your pro', photoUrl: pt.pro ? contractorPhotoUrl(pt.pro) : null };
};
const custFirst = (pt) => firstName(pt.customer ? pt.customer.name : pt.job && pt.job.name) || 'there';

// ---------------------------------------------------------------------------
// The pro's side of the visit
// ---------------------------------------------------------------------------
async function onTheWay(projectId) {
  const pt = await parties(projectId);
  if (!pt.project) return { emailed: false };
  const last = toDate(pt.project.on_my_way_at);
  if (last && Date.now() - last.getTime() < 0.5 * H) return { emailed: false, reason: 'recent' };
  await db.prepare('UPDATE projects SET on_my_way_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
  const { onTheWayCustomer } = require('./notify');
  await emailCustomer(pt, `Your pro is on the way — project #${projectId}`,
    onTheWayCustomer({ customerName: custFirst(pt), ...proView(pt), projectId, serviceType: pt.job.service_type }));
  return { emailed: true };
}

async function checkIn(project, actorId) {
  if (project.contractor_status !== 'accepted') throw err(409, 'Accept the job offer first.');
  if (!['scheduled', 'in_progress'].includes(project.stage)) throw err(409, 'This job is not scheduled for a visit.');
  const claim = await db.prepare(
    `UPDATE projects SET arrived_at = CURRENT_TIMESTAMP, stage = 'in_progress', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND arrived_at IS NULL AND stage IN ('scheduled','in_progress')`
  ).run(project.id);
  if (claim.changes !== 1) throw err(409, 'You already checked in for this visit.');
  if (project.stage !== 'in_progress') {
    await require('./events').stage(project.id, project.stage, 'in_progress', actorId);
    await db.prepare(`UPDATE job_requests SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(project.job_request_id);
  }
  await auditLog(actorId, 'visit.check_in', 'projects', project.id, 'Pro arrived');
  const pt = await parties(project.id);
  const { arrivedCustomer } = require('./notify');
  await emailCustomer(pt, `Your pro has arrived — project #${project.id}`,
    arrivedCustomer({ customerName: custFirst(pt), ...proView(pt), projectId: project.id, serviceType: pt.job.service_type }));
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
}

async function checkOut(project, actorId, note) {
  if (project.stage !== 'in_progress') throw err(409, 'Check in first: the job is not in progress.');
  const photos = Number((await db.prepare(`SELECT COUNT(*) c FROM photos WHERE project_id = ? AND kind = 'completion'`).get(project.id)).c);
  if (photos < 1) throw err(409, 'Upload at least one photo of the finished work before you finish the job.', 'PHOTO_REQUIRED');
  const claim = await db.prepare(
    `UPDATE projects SET departed_at = CURRENT_TIMESTAMP, stage = 'review', updated_at = CURRENT_TIMESTAMP,
            confirm_reminder_sent_at = NULL, confirm_escalated_at = NULL
     WHERE id = ? AND stage = 'in_progress'`
  ).run(project.id);
  if (claim.changes !== 1) throw err(409, 'This job was already finished.');
  await db.prepare(`UPDATE milestones SET status = 'completed' WHERE project_id = ? AND status <> 'completed'`).run(project.id);
  await db.prepare(`UPDATE job_requests SET status = 'review', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(project.job_request_id);
  await db.prepare('INSERT INTO visit_events (project_id, outcome, by_user, note) VALUES (?,?,?,?)')
    .run(project.id, 'completed', actorId, note ? String(note).trim().slice(0, 500) : null);
  await require('./events').stage(project.id, 'in_progress', 'review', actorId);
  await auditLog(actorId, 'visit.check_out', 'projects', project.id, `Work finished (${photos} photo(s))`);
  await sendWorkFinished(project.id, { reminder: false });
  const pt = await parties(project.id);
  if (pt.pro && pt.pro.email) {
    const { notify, shell } = require('./notify');
    await notify({ to: pt.pro.email, subject: `Job #${project.id} finished — waiting for the customer`,
      html: shell('Nice work — job finished', `Hi ${firstName(pt.pro.name)}, we asked the customer to confirm the work. Your payout is created as soon as they confirm; we will email you.`, [['Job', `#${project.id}`]]) }).catch(() => {});
  }
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
}

async function sendWorkFinished(projectId, { reminder }) {
  const pt = await parties(projectId);
  if (!pt.project) return;
  const l = links(projectId, pt.job.customer_id);
  const { workFinishedCustomer } = require('./notify');
  await emailCustomer(pt, reminder ? `Reminder: please confirm your finished job — project #${projectId}` : `Your job is finished — did everything go well? (#${projectId})`,
    workFinishedCustomer({
      customerName: custFirst(pt), techName: proView(pt).techName, projectId, serviceType: pt.job.service_type,
      photoUrls: await completionPhotoUrls(projectId), balanceCents: await require('./billing').balanceCents(projectId),
      autoCharge: await willAutoCharge(projectId), confirmUrl: l.confirmUrl, problemUrl: l.problemUrl, reminder,
    }));
}

// ---------------------------------------------------------------------------
// The customer's side: confirm (sign) or report a problem
// ---------------------------------------------------------------------------
function validateSignOff(b) {
  const errors = {};
  const { isNonEmpty } = require('../middleware');
  if (!isNonEmpty(b.signer_name, 120)) errors.signer_name = 'Type your full name.';
  const sig = typeof b.signature === 'string' ? b.signature : '';
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length < 800) errors.signature = 'Please draw your signature.';
  else if (sig.length > 300000) errors.signature = 'Signature image is too large.';
  const cl = b.checklist && typeof b.checklist === 'object' ? b.checklist : {};
  if (cl.work_complete !== true) errors.work_complete = 'Confirm the work is complete.';
  if (cl.site_clean !== true) errors.site_clean = 'Confirm the work area is clean.';
  if (b.notes && !isNonEmpty(b.notes, 1000)) errors.notes = 'Notes are too long.';
  return errors;
}

// Signs the completion sheet, closes the project and charges the balance.
// `b` must already be validated (validateSignOff).
async function confirmWork(project, { userId, b, ip, via }) {
  if (!['in_progress', 'review', 'completed'].includes(project.stage)) throw err(409, 'The work is not ready for sign-off yet.');
  if (await require('./disputes').openDisputeFor(project.id)) throw err(409, 'There is an open problem report on this project. Helpman support will contact you.', 'DISPUTE_HOLD');
  const ms = await db.prepare('SELECT id, customer_approval FROM milestones WHERE project_id = ?').all(project.id);
  // After the pro's check-out ("work finished"), confirming accepts the whole job.
  const finished = project.stage === 'review' && !!project.departed_at;
  if (!finished && (!ms.length || ms.some(m => m.customer_approval !== 'approved'))) {
    throw err(409, 'Approve every milestone before signing off.');
  }
  if (await db.prepare('SELECT id FROM completion_sheets WHERE project_id = ?').get(project.id)) throw err(409, 'This project is already signed off.');
  try {
    await db.prepare(
      `INSERT INTO completion_sheets (project_id, signer_user_id, signer_name, signature_png, checklist_json, notes, ip)
       VALUES (?,?,?,?,?,?,?)`
    ).run(project.id, userId, b.signer_name.trim(), b.signature, JSON.stringify({ work_complete: true, site_clean: true, via: via || 'portal' }), (b.notes || '').trim() || null, ip || null);
  } catch (e) {
    throw err(409, 'This project is already signed off.'); // UNIQUE(project_id): a simultaneous second signature loses
  }
  if (finished) {
    await db.prepare(`UPDATE milestones SET status = 'completed', customer_approval = 'approved', approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP) WHERE project_id = ? AND customer_approval <> 'approved'`).run(project.id);
  }
  await auditLog(userId, 'project.signed_off', 'projects', project.id, `Signed by ${b.signer_name.trim()} (${via || 'portal'})`);
  const pt = await parties(project.id);
  await emailAdmins(`Customer signed off — project #${project.id}`, `${pt.job ? pt.job.name : 'The customer'} confirmed the finished work${via === 'email' ? ' from the email link' : ''}. The project is now complete.`,
    [['Project', `#${project.id} — ${pt.job ? pt.job.service_type : ''}`], ['Signed by', b.signer_name.trim()]]);

  // Close the project (once): pro's stats, payable, completion emails.
  const closed = await db.prepare(`UPDATE projects SET stage = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND stage IN ('in_progress','review')`).run(project.id);
  if (closed.changes === 1) {
    await require('./events').stage(project.id, project.stage, 'completed', userId);
    await db.prepare(`UPDATE job_requests SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(project.job_request_id);
    const fresh = await db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
    if (fresh.contractor_id) {
      await db.prepare('UPDATE contractors SET jobs_completed = jobs_completed + 1 WHERE id = ?').run(fresh.contractor_id);
      await require('./payables').ensurePayable(fresh);
    }
    await require('./notify').completionEmails(project.id);
  }
  // Owner's 30/70 rule: the balance goes to the saved card now. A card problem never undoes the signature.
  let balance_charge;
  try {
    balance_charge = await require('./billing').chargeBalance(project.id, { actorId: userId, trigger: via === 'email' ? 'signoff_email' : 'signoff' });
  } catch (e) {
    console.error('[balance charge]', e.message);
    balance_charge = { status: 'error' };
  }
  const sheet = await db.prepare('SELECT signed_at FROM completion_sheets WHERE project_id = ?').get(project.id);
  return { signed: true, signed_at: sheet.signed_at, completed: true, balance_charge };
}

const PROBLEM_REASONS = ['quality', 'incomplete', 'no_show', 'damage', 'billing', 'other'];

async function reportProblem(pt, { reason, description }) {
  if (!PROBLEM_REASONS.includes(reason)) throw err(422, 'Choose a reason.');
  const d = String(description || '').trim();
  if (d.length < 10 || d.length > 2000) throw err(422, 'Describe the problem (at least 10 characters).');
  if (!['in_progress', 'review', 'completed'].includes(pt.project.stage)) throw err(409, 'A problem can be reported once the work has started.');
  let id;
  try {
    const info = await db.prepare(`INSERT INTO disputes (project_id, opened_by, opened_by_role, reason, description) VALUES (?,?,?,?,?)`)
      .run(pt.project.id, pt.job.customer_id || null, 'customer', reason, d);
    id = info.lastInsertRowid;
  } catch (e) {
    throw err(409, 'You already reported a problem on this project. Helpman support is on it.');
  }
  await auditLog(pt.job.customer_id || null, 'dispute.opened', 'disputes', id, `customer (email link): ${reason}`);
  await emailAdmins(`Problem reported — project #${pt.project.id}`, 'The customer reported a problem from the "Did everything go well?" email. Payments on this project are on hold until it is resolved.',
    [['Project', `#${pt.project.id} — ${pt.job.service_type}`], ['Reason', reason], ['Details', d.slice(0, 500)]]);
  const { shell } = require('./notify');
  await emailCustomer(pt, `We received your report — project #${pt.project.id}`,
    shell('Thanks for telling us', 'Helpman support will review your report and contact you from your portal. Nothing more is charged while we solve it.', [['Project', `#${pt.project.id}`]]));
  return { dispute_id: id };
}

// ---------------------------------------------------------------------------
// Receipt (once, when the project is paid in full)
// ---------------------------------------------------------------------------
async function sendReceipt(projectId) {
  const billing = require('./billing');
  if (await billing.balanceCents(projectId) >= 100) return false;
  const claim = await db.prepare('UPDATE projects SET receipt_sent_at = CURRENT_TIMESTAMP WHERE id = ? AND receipt_sent_at IS NULL').run(projectId);
  if (claim.changes !== 1) return false;
  const pt = await parties(projectId);
  const sum = async (where) => Number((await db.prepare(`SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE project_id = ? AND status IN ('paid','recorded') AND ${where}`).get(projectId)).s);
  const changes = Number((await db.prepare(`SELECT COALESCE(SUM(price_delta_cents),0) s FROM change_orders WHERE project_id = ? AND status = 'approved'`).get(projectId)).s);
  const deposit = await sum(`kind = 'deposit'`), balance = await sum(`kind IN ('final','milestone')`), refunds = await sum(`kind = 'refund'`);
  const lines = [['Agreed price', Number(pt.project.customer_price_cents) - changes]];
  if (changes) lines.push(['Approved changes', changes]);
  lines.push(['Deposit paid', deposit]);
  if (balance) lines.push(['Balance paid', balance]);
  if (refunds) lines.push(['Refunded', -refunds]);
  const { receiptCustomer } = require('./notify');
  await emailCustomer(pt, `Receipt — project #${projectId} paid in full`,
    receiptCustomer({ customerName: custFirst(pt), projectId, serviceType: pt.job.service_type, lines, totalCents: deposit + balance - refunds }));
  return true;
}

// ---------------------------------------------------------------------------
// Background reminders (hourly)
// ---------------------------------------------------------------------------
async function runLifecycleEmails({ now = new Date() } = {}) {
  const out = { confirm_reminders: 0, escalations: 0, review_reminders: 0 };
  const age = (v) => { const d = toDate(v); return d ? now.getTime() - d.getTime() : -1; };
  // Finished but not confirmed: a reminder at 24 h, support is told at 72 h.
  const waiting = await db.prepare(
    `SELECT p.* FROM projects p WHERE p.stage = 'review' AND p.departed_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM completion_sheets s WHERE s.project_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.project_id = p.id AND d.status IN ('open','investigating'))`
  ).all();
  for (const p of waiting) {
    if (age(p.departed_at) >= 24 * H && !p.confirm_reminder_sent_at) {
      const c = await db.prepare('UPDATE projects SET confirm_reminder_sent_at = CURRENT_TIMESTAMP WHERE id = ? AND confirm_reminder_sent_at IS NULL').run(p.id);
      if (c.changes === 1) { await sendWorkFinished(p.id, { reminder: true }); out.confirm_reminders++; }
    }
    if (age(p.departed_at) >= 72 * H && !p.confirm_escalated_at) {
      const c = await db.prepare('UPDATE projects SET confirm_escalated_at = CURRENT_TIMESTAMP WHERE id = ? AND confirm_escalated_at IS NULL').run(p.id);
      if (c.changes === 1) {
        await emailAdmins(`Customer has not confirmed — project #${p.id}`, 'The pro finished 3 days ago and the customer has not confirmed or reported a problem. Please contact them from Messages.', [['Project', `#${p.id}`]]);
        out.escalations++;
      }
    }
  }
  // Completed, no review after 3 days: one friendly reminder.
  const noReview = await db.prepare(
    `SELECT p.id, s.signed_at FROM projects p JOIN completion_sheets s ON s.project_id = p.id
     WHERE p.stage = 'completed' AND p.review_reminder_sent_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.project_id = p.id)`
  ).all();
  for (const r of noReview) {
    if (age(r.signed_at) < 72 * H) continue;
    const c = await db.prepare('UPDATE projects SET review_reminder_sent_at = CURRENT_TIMESTAMP WHERE id = ? AND review_reminder_sent_at IS NULL').run(r.id);
    if (c.changes !== 1) continue;
    const pt = await parties(r.id);
    const { reviewRequestCustomer } = require('./notify');
    await emailCustomer(pt, `How did we do? — project #${r.id}`, reviewRequestCustomer({ customerName: custFirst(pt), techName: proView(pt).techName, projectId: r.id, reminder: true }));
    out.review_reminders++;
  }
  return out;
}

module.exports = {
  VISIT_TTL_MS, PROBLEM_REASONS, links, loadByToken, parties, completionPhotoUrls, willAutoCharge,
  onTheWay, checkIn, checkOut, sendWorkFinished, validateSignOff, confirmWork, reportProblem, sendReceipt, runLifecycleEmails,
};
