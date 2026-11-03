// Corte 8: offering a job to a professional — by dispatch (manual) or by the
// platform itself (automatic, owner decision 2026-11-03):
//   * as soon as the deposit is in, the job is offered to the best-ranked pro;
//   * it is offered again ONLY when an offer expires or is declined, never to a
//     pro who already had it, and at most `auto_offer_max_attempts` times —
//     after that (or when nobody fits) support is told to assign by hand.
// Nothing here moves money and nothing reaches the customer: the pro sees the
// work, the budget and city + ZIP, exactly like a manual offer.
'use strict';
const db = require('../db');
const { auditLog } = require('./audit');
const { notify, esc } = require('./notify');
const settings = require('./settings');

const OFFERABLE_JOB_STATUSES = ['deposit_paid', 'assigned', 'scheduled', 'in_progress', 'review'];

function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }

async function recordEvent(projectId, contractorId, type, detail) {
  if (!projectId || !contractorId) return;
  await db.prepare(
    'INSERT INTO contractor_offer_events (project_id, contractor_id, event_type, detail) VALUES (?,?,?,?)'
  ).run(projectId, contractorId, type, detail || null);
}

async function depositIn(p) {
  const job = await db.prepare('SELECT status FROM job_requests WHERE id = ?').get(p.job_request_id);
  return !!job && OFFERABLE_JOB_STATUSES.includes(job.status);
}

// The gates every offer passes, manual or automatic. Returns an error message or null.
async function checkOfferable(p, c) {
  if (!c) return 'Contractor not found.';
  if (c.status !== 'active') return 'Contractor is not active.';
  // The customer sees the technician's photo — no photo, no offer.
  if (!c.photo_filename) return 'This contractor has no profile photo. Ask them to upload one from their portal before offering jobs.';
  if (!await depositIn(p)) return 'The deposit has not been paid yet. Offer the job after the deposit is recorded.';
  return null;
}

// Send the offer (24 h, one-click accept / decline). `auto` marks who decided.
// Returns false when someone else changed the project first.
async function offerProject(p, c, { actorId, auto }) {
  const offers = require('./offers');
  const expiresAt = new Date(Date.now() + offers.OFFER_TTL_MS).toISOString();
  if (auto) {
    // Claim the project only if it is still free (no double offer from a race).
    const r = await db.prepare(
      `UPDATE projects SET contractor_id = ?, contractor_status = 'offered', offer_expires_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND contractor_id IS NULL AND (contractor_status IS NULL OR contractor_status = '')`
    ).run(c.id, expiresAt, p.id);
    if (r.changes !== 1) return false;
  } else {
    await db.prepare(
      `UPDATE projects SET contractor_id = ?, contractor_status = 'offered', offer_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(c.id, expiresAt, p.id);
  }
  await recordEvent(p.id, c.id, 'offered', auto ? 'auto' : 'manual');
  await auditLog(actorId || null, auto ? 'project.auto_offered' : 'project.contractor_offered', 'projects', p.id,
    auto ? `Project offered automatically to contractor #${c.id}` : `Project offered to contractor #${c.id}`);

  const cu = await db.prepare('SELECT name, email FROM users WHERE id = ?').get(c.user_id);
  const job = await db.prepare('SELECT * FROM job_requests WHERE id = ?').get(p.job_request_id);
  if (cu && cu.email && job) {
    const { jobOfferContractor } = require('./notify');
    const links = offers.offerLinks(p.id, c.id);
    await notify({
      to: cu.email,
      subject: `New job offer — ${job.service_type} (#${p.id})`,
      html: jobOfferContractor({
        name: firstName(cu.name), projectId: p.id, serviceType: job.service_type,
        // City + ZIP only: the street address is released when the pro accepts.
        address: [job.city, job.zip].filter(Boolean).join(' ') || 'Service area',
        budget: '$' + (Number(p.contractor_cost_cents || 0) / 100).toFixed(2),
        acceptUrl: links.acceptUrl, declineUrl: links.declineUrl,
        expiresNote: 'The offer expires in 24 hours.',
      }),
    }).catch(() => {});
  }
  return true;
}

function specialtiesOf(c) {
  let s = c.specialties;
  if (!Array.isArray(s)) {
    try { s = JSON.parse(s || '[]'); } catch (e) { s = String(s || '').split(','); }
  }
  return (Array.isArray(s) ? s : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

// Who could get this job automatically, best first. Only independent
// contractors (company technicians are assigned by dispatch), active, with a
// photo, fully verified (the ranking's own compliance guardrail), doing this
// trade, inside their service radius when both locations are known, and who
// never had this project before.
async function candidatesFor(p) {
  const job = await db.prepare('SELECT service_type, lat, lng FROM job_requests WHERE id = ?').get(p.job_request_id);
  if (!job) return [];
  const seen = await db.prepare('SELECT DISTINCT contractor_id FROM contractor_offer_events WHERE project_id = ?').all(p.id);
  const excluded = new Set(seen.map((r) => Number(r.contractor_id)));
  const rows = await db.prepare(
    `SELECT c.*, u.name AS user_name FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.status = 'active'`
  ).all();
  const load = await db.prepare(
    `SELECT contractor_id, COUNT(*) AS n FROM projects
     WHERE contractor_id IS NOT NULL AND stage IN ('assigned','scheduled','in_progress','review')
     GROUP BY contractor_id`
  ).all();
  const workloadBy = Object.fromEntries(load.map((r) => [r.contractor_id, Number(r.n)]));
  const geo = require('./geocode');
  const trade = String(job.service_type || '').trim().toLowerCase();
  const pool = rows
    .filter((c) => (c.provider_type || 'contractor') === 'contractor')
    .filter((c) => c.photo_filename)
    .filter((c) => !excluded.has(Number(c.id)))
    .filter((c) => trade && specialtiesOf(c).includes(trade))
    .map((c) => ({
      ...c,
      specialties: [job.service_type], // already matched (case-insensitive) above
      distance_miles: geo.miles(job, c),
      license_verified: !!c.license_verified,
      insurance_verified: !!c.insurance_verified,
      current_workload: workloadBy[c.id] || 0,
    }))
    .filter((c) => c.distance_miles == null || c.distance_miles <= Number(c.service_radius_miles || 25));
  const { rankContractors } = require('./matching');
  return rankContractors({
    id: p.id, service_type: job.service_type,
    customer_price_cents: p.customer_price_cents, contractor_cost_cents: p.contractor_cost_cents,
  }, pool).map((x) => x.contractor);
}

async function tellSupport(p, subject, text) {
  const job = await db.prepare('SELECT service_type FROM job_requests WHERE id = ?').get(p.job_request_id);
  const admins = await db.prepare("SELECT email FROM users WHERE role = 'admin'").all();
  for (const a of admins) {
    await notify({
      to: a.email,
      subject,
      html: `<p>${esc(text)}</p><p>Project #${p.id} (${esc(job ? job.service_type : '')}). Open Projects › Assign in the admin panel.</p>`,
    }).catch(() => {});
  }
}

// Offer the job automatically. `reason`: 'deposit' | 'declined' | 'expired'.
// Never throws: a failure here must not break the payment or the reply that
// triggered it — dispatch can always assign by hand.
async function autoOffer(projectId, { reason } = {}) {
  try {
    if (!await settings.get('auto_offer_enabled')) return { offered: false, why: 'disabled' };
    const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!p) return { offered: false, why: 'missing' };
    if (p.contractor_id || p.contractor_status) return { offered: false, why: 'taken' };
    if (p.stage !== 'assigned') return { offered: false, why: 'stage' };
    if (!await depositIn(p)) return { offered: false, why: 'no_deposit' };

    const max = await settings.get('auto_offer_max_attempts');
    const made = await db.prepare(
      "SELECT COUNT(*) AS n FROM contractor_offer_events WHERE project_id = ? AND event_type = 'offered' AND detail = 'auto'"
    ).get(p.id);
    if (Number(made.n) >= max) {
      await stopOnce(p, `Automatic offers stopped after ${max} attempt(s)`,
        `Helpman offered this job automatically ${max} time(s) and nobody took it. Please assign a professional by hand.`);
      return { offered: false, why: 'max_attempts' };
    }
    const list = await candidatesFor(p);
    if (list.length) {
      const c = list[0];
      if (await offerProject(p, c, { actorId: null, auto: true })) {
        return { offered: true, contractor_id: c.id, reason: reason || null };
      }
      return { offered: false, why: 'taken' }; // someone else claimed it meanwhile
    }
    await stopOnce(p, 'No professional available automatically',
      reason === 'deposit'
        ? 'The deposit is in, but no verified professional with this trade and a profile photo is available for an automatic offer. Please assign one by hand.'
        : 'The offer was not taken and no other verified professional with this trade is available for an automatic offer. Please assign one by hand.');
    return { offered: false, why: 'no_candidate' };
  } catch (e) {
    console.error('[dispatch] auto offer failed for project', projectId, e.message);
    return { offered: false, why: 'error' };
  }
}

// One email to support per project and reason (the sweep runs every few minutes).
async function stopOnce(p, title, text) {
  const action = 'project.auto_offer_stopped';
  const rows = await db.prepare('SELECT details FROM admin_audit WHERE action = ? AND entity = ? AND entity_id = ?')
    .all(action, 'projects', p.id);
  if (rows.some((r) => r.details === title)) return;
  await auditLog(null, action, 'projects', p.id, title);
  await tellSupport(p, `${title} — project #${p.id} needs a contractor`, text);
}

module.exports = { checkOfferable, offerProject, autoOffer, candidatesFor, recordEvent, OFFERABLE_JOB_STATUSES };
