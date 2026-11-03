// Transactional notifications: status-change emails sent through the pluggable
// mailer. Every attempt is recorded in email_log (the mailer's contract), so
// in console/log mode nothing is really delivered but everything is auditable.
// Sender identity is ALWAYS the business account (mailer module default).
const db = require('../db');
const mailer = require('./mailer');
const BRAND = process.env.BRAND_NAME || 'Helpman';

// Greeting name: first word only, no stray spaces ("Hi Ana ," / "Hi ," came
// from names saved with leading/trailing spaces). Falls back to "there".
function greetName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }

async function logEmail(to, subject, status, provider) {
  await db.prepare(
    'INSERT INTO email_log (outbox_id, to_email, subject, status, provider) VALUES (NULL,?,?,?,?)'
  ).run(to, subject, status, provider);
}

async function notify({ to, subject, html }) {
  if (!to) return { ok: false, skipped: 'no recipient' };
  let result;
  try {
    result = await mailer.send({ to, subject, html });
  } catch (e) {
    result = { ok: false, provider: mailer.activeProvider(), error: String(e.message).slice(0, 200) };
  }
  try {
    await logEmail(to, subject, result.ok ? 'sent' : 'failed', result.provider || mailer.activeProvider());
  } catch (e) { /* logging must never break the request */ }
  return result;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Plain status notification. Since Corte 3 it renders inside the branded layout
// (same look and legal footer as every other Helpman email). All values escaped.
function shell(title, intro, rows) {
  const rowHtml = (rows || []).map(([k, v]) =>
    `<tr><td style="color:#8a97a5;font-size:13px;padding:7px 14px 7px 0;vertical-align:top;white-space:nowrap;">${esc(k)}</td><td style="font-size:14px;padding:7px 0;vertical-align:top;color:#1d2a3a;"><strong>${esc(v)}</strong></td></tr>`
  ).join('');
  return brandShell(esc(title), `<p style="margin:0;">${esc(intro)}</p>`,
    rowHtml ? `<table style="margin:16px 0;border-collapse:collapse;" cellpadding="0" cellspacing="0"><tbody>${rowHtml}</tbody></table>` : '');
}

// Look up the people involved in a project for notifications.
async function projectParties(projectId) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!p) return {};
  const job = await db.prepare('SELECT * FROM job_requests WHERE id = ?').get(p.job_request_id);
  const customer = job && (job.customer_id
    ? await db.prepare('SELECT name, email FROM users WHERE id = ?').get(job.customer_id)
    : (job.email ? { name: job.name, email: job.email } : null));
  const contractor = p.contractor_id
    ? await db.prepare('SELECT u.name, u.email FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(p.contractor_id)
    : null;
  const admins = await db.prepare("SELECT name, email FROM users WHERE role = 'admin'").all();
  return { project: p, job, customer, contractor, admins };
}

// Public token-capability URL of a contractor's profile photo (for emails).
function contractorPhotoUrl(c) {
  if (!c || !c.photo_filename) return null;
  return `${baseUrl()}/api/contractor-photos/${c.photo_filename}`;
}

// ---------- Branded lifecycle emails (contractor photo + schedule flow) ----------
// Pro design: white card on soft gray, big logo, navy headlines, brand blue
// buttons, generous spacing. All dynamic values are escaped at the call site;
// `intro`/`bodyHtml` below are authored HTML (never raw user input).

const { baseUrl } = require('./magiclink');

function legalLine() {
  const addr = process.env.COMPANY_POSTAL_ADDRESS ? ` &middot; ${esc(process.env.COMPANY_POSTAL_ADDRESS)}` : '';
  return `Helpman by Mendoza Capital LLC${addr} &middot; <a href="${baseUrl()}/terms.html" style="color:#8a97a5;">Terms</a> &middot; <a href="${baseUrl()}/privacy.html" style="color:#8a97a5;">Privacy</a>`;
}

function logoUrl() { return `${baseUrl()}/img/helpman-logo-primary.png`; }

function brandShell(title, intro, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background-color:#f6f8fb;">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 16px;">
    <div style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(16,36,63,.08);">
      <div style="padding:30px 32px 6px;text-align:center;">
        <img src="${logoUrl()}" alt="Helpman by Mendoza Capital LLC" style="max-width:280px;width:100%;height:auto;display:block;margin:0 auto;">
      </div>
      <div style="padding:6px 36px 10px;">
        <h2 style="color:#143d7a;font-size:22px;line-height:1.35;margin:0 0 12px;">${title}</h2>
        <div style="color:#5b6b7e;font-size:15px;line-height:1.65;margin:0 0 8px;">${intro}</div>
        ${bodyHtml || ''}
      </div>
      <div style="background:#f6f8fb;border-top:1px solid #e2e8f0;padding:16px 36px;">
        <p style="color:#8a97a5;font-size:12px;line-height:1.6;margin:0 0 6px;">This is an automated notification from Helpman by Mendoza Capital LLC. Please do not reply to this email &mdash; message us from your portal instead.</p>
        <p style="color:#8a97a5;font-size:12px;line-height:1.6;margin:0 0 6px;">For everyone&apos;s safety, all contact between customers and pros goes through Helpman support. Never share phone numbers, emails or payment details outside the platform.</p>
        <p style="color:#8a97a5;font-size:12px;line-height:1.6;margin:0;">${legalLine()}</p>
      </div>
    </div>
    <p style="text-align:center;color:#8a97a5;font-size:12px;margin:18px 0 0;letter-spacing:.02em;">Home projects, handled.</p>
  </div></body></html>`;
}

function btn(url, label, color) {
  return `<p style="text-align:center;margin:24px 0 8px;"><a href="${esc(url)}" style="background:${color || '#2b6fe3'};color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;box-shadow:0 2px 6px rgba(43,111,227,.35);">${esc(label)}</a></p>`;
}

function kvRow(k, v) {
  return `<tr><td style="color:#8a97a5;font-size:13px;padding:7px 14px 7px 0;vertical-align:top;white-space:nowrap;">${esc(k)}</td><td style="font-size:14px;padding:7px 0;vertical-align:top;color:#1d2a3a;"><strong>${v}</strong></td></tr>`;
}

// The flexibility promise shown everywhere a time is communicated.
const FLEX_NOTE = 'Arrival times are approximate: your pro arrives within the window shown and confirms the day before. Thanks for keeping the schedule a little flexible.';

// "2026-11-20" -> "Thursday, November 20, 2026" for customer/contractor emails.
function prettyDay(iso) {
  try {
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  } catch (_) { return String(iso || ''); }
}

function flexBox() {
  return `<div style="background:#e9f1fe;border-left:4px solid #2b6fe3;border-radius:0 10px 10px 0;padding:12px 16px;margin:18px 0;"><p style="margin:0;font-size:13.5px;line-height:1.6;color:#143d7a;">&#9200; ${esc(FLEX_NOTE)}</p></div>`;
}

function techPhoto(photoUrl, size) {
  const s = size || 140;
  if (!photoUrl) return '';
  return `<div style="text-align:center;margin:20px 0 6px;"><img src="${esc(photoUrl)}" alt="Your technician" width="${s}" height="${s}" style="width:${s}px;height:${s}px;object-fit:cover;border-radius:50%;border:4px solid #e9f1fe;box-shadow:0 2px 8px rgba(16,36,63,.12);display:block;margin:0 auto;"></div>`;
}

function welcomeCustomer(name) {
  return brandShell('Welcome to Helpman!',
    `<p style="margin:0 0 12px;">Hi <strong>${esc(greetName(name))}</strong>, your account is ready.</p><p style="margin:0;">Request a service, get a fixed quote, and track everything from your portal &mdash; a verified pro, <strong>with photo</strong>, is assigned to every job.</p>`,
    btn(`${baseUrl()}/customer.html`, 'Go to my portal'));
}

function welcomeContractor(name) {
  return brandShell('Welcome aboard, pro!',
    `<p style="margin:0 0 12px;">Hi <strong>${esc(greetName(name))}</strong>, your contractor account is created and pending verification.</p><p style="margin:0;">One important step: <strong>upload your profile photo</strong> &mdash; customers see the photo of the technician assigned to their job, and we cannot offer you work until your photo is on file.</p>`,
    btn(`${baseUrl()}/contractor.html`, 'Complete my profile'));
}

// Sent when a contractor registers without a photo (which is every signup,
// since the form has no upload yet) — and re-sendable by dispatch.
function photoReminder(name) {
  return brandShell('One step left: upload your profile photo',
    `<p style="margin:0 0 12px;">Hi <strong>${esc(greetName(name))}</strong>, when we assign you a job the customer receives your <strong>name and your photo</strong> &mdash; that is how they know who is knocking on their door.</p><p style="margin:0;"><strong>Please upload your profile photo from your contractor portal.</strong> Until your photo is on file we cannot assign you any work.</p>`,
    btn(`${baseUrl()}/contractor.html`, 'Upload my photo now', '#b7791f'));
}

function quoteAcceptedCustomer(name, projectId, serviceType) {
  return brandShell(`You&apos;ve accepted your proposal &mdash; project #${esc(String(projectId))}`,
    `<p style="margin:0 0 12px;">Hi <strong>${esc(greetName(name))}</strong>, great news: your proposal for <strong>${esc(serviceType)}</strong> is accepted and your project is now in our hands.</p><p style="margin:0;"><strong>Next step:</strong> we assign a verified professional to your job. You will receive their <strong>name and photo</strong> by email as soon as they are assigned &mdash; phone numbers are never shared.</p>`,
    btn(`${baseUrl()}/customer.html`, 'Track my project'));
}

// The client-facing "your technician" email: photo + name, NO phone, NO email.
function techAssignedCustomer({ customerName, techName, photoUrl, projectId, serviceType }) {
  return brandShell(`Your technician has been assigned &mdash; project #${esc(String(projectId))}`,
    `<p style="margin:0;">Hi <strong>${esc(greetName(customerName))}</strong>, meet the professional doing your <strong>${esc(serviceType)}</strong> job:</p>`,
    `${techPhoto(photoUrl, 150)}<p style="text-align:center;font-size:19px;margin:10px 0 4px;color:#143d7a;"><strong>${esc(techName)}</strong></p>
    <p style="text-align:center;color:#8a97a5;font-size:13px;margin:0 0 8px;">Verified pro &middot; photo on file</p>
    <p style="color:#5b6b7e;font-size:14px;line-height:1.65;">You will receive the confirmed day and arrival window in a separate email. For your privacy and theirs, <strong>we never share phone numbers</strong> &mdash; message us from your portal any time.</p>`
    + btn(`${baseUrl()}/customer.html`, 'View my project'));
}

// Job-offer email to the contractor with one-click accept / decline.
function jobOfferContractor({ name, projectId, serviceType, address, budget, acceptUrl, declineUrl, expiresNote }) {
  return brandShell(`New job offer &mdash; ${esc(serviceType)} (#${esc(String(projectId))})`,
    `<p style="margin:0;">Hi <strong>${esc(greetName(name))}</strong>, Helpman by Mendoza Capital LLC is offering you a project.${expiresNote ? ` <strong>${esc(expiresNote)}</strong>` : ''}</p>`,
    `<table style="margin:16px 0;border-collapse:collapse;" cellpadding="0" cellspacing="0"><tbody>`
    + kvRow('Project', `#${esc(String(projectId))} &mdash; ${esc(serviceType)}`)
    + kvRow('Area', esc(address) + '<br><span style="font-weight:400;color:#8a97a5;font-size:12px;">Exact address shared once you accept.</span>')
    + kvRow('Your budget', esc(budget))
    + `</tbody></table>
    <p style="color:#5b6b7e;font-size:14px;line-height:1.65;">Answer right from this email &mdash; no login needed. Accepting means you agree to the Independent Contractor Terms.</p>
    <p style="text-align:center;margin:24px 0 8px;">
      <a href="${esc(acceptUrl)}" style="background:#1f8a4c;color:#ffffff;padding:13px 30px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;margin:0 6px 8px 0;box-shadow:0 2px 6px rgba(31,138,76,.35);">Accept job</a>
      <a href="${esc(declineUrl)}" style="background:#ffffff;color:#143d7a;padding:11px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;border:2px solid #e2e8f0;">Decline</a>
    </p>`);
}

// After the contractor accepts the offer: waiting for the day to be confirmed.
function offerAcceptedContractor(name, projectId, serviceType) {
  return brandShell(`Offer accepted &mdash; project #${esc(String(projectId))}`,
    `<p style="margin:0 0 12px;">Hi <strong>${esc(greetName(name))}</strong>, you accepted the <strong>${esc(serviceType)}</strong> job.</p><p style="margin:0;">It is now <strong>waiting for the day to be confirmed</strong>. As soon as dispatch confirms the visit day you will receive another email with the date and arrival window, where you confirm or decline that slot.</p>`,
    '');
}

// Day + arrival window confirmed: contractor confirms or declines the slot.
function scheduleConfirmedContractor({ name, projectId, day, window, acceptUrl, declineUrl, address }) {
  return brandShell(`Appointment confirmed &mdash; ${esc(prettyDay(day))} (#${esc(String(projectId))})`,
    `<p style="margin:0;">Hi <strong>${esc(greetName(name))}</strong>, your appointment is confirmed for <strong>${esc(prettyDay(day))}</strong>${window ? `, arrival window <strong>${esc(window)}</strong>` : ''}.</p>`,
    (address ? `<table style="margin:14px 0;border-collapse:collapse;" cellpadding="0" cellspacing="0"><tbody>${kvRow('Address', esc(address))}</tbody></table>` : '')
    + `<p style="color:#5b6b7e;font-size:14px;line-height:1.65;">Please confirm you can make it, or decline so we can reassign in time. Questions about the job? Message Helpman support from your portal &mdash; never contact the customer directly.</p>
    <p style="text-align:center;margin:24px 0 8px;">
      <a href="${esc(acceptUrl)}" style="background:#1f8a4c;color:#ffffff;padding:13px 30px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;margin:0 6px 8px 0;box-shadow:0 2px 6px rgba(31,138,76,.35);">I confirm</a>
      <a href="${esc(declineUrl)}" style="background:#ffffff;color:#143d7a;padding:11px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;border:2px solid #e2e8f0;">I can&apos;t make it</a>
    </p>`);
}

// Customer version: technician photo + day + window + flexibility note.
function scheduleConfirmedCustomer({ customerName, techName, photoUrl, projectId, day, window }) {
  return brandShell(`Your visit is scheduled &mdash; ${esc(prettyDay(day))} (#${esc(String(projectId))})`,
    `<p style="margin:0;">Hi <strong>${esc(greetName(customerName))}</strong>, your visit is confirmed:</p>`,
    `${techPhoto(photoUrl, 130)}
    <table style="margin:14px auto;border-collapse:collapse;" cellpadding="0" cellspacing="0"><tbody>`
    + kvRow('Technician', esc(techName))
    + kvRow('Day', esc(prettyDay(day)))
    + (window ? kvRow('Arrival window', esc(window)) : '')
    + `</tbody></table>`
    + flexBox()
    + btn(`${baseUrl()}/customer.html`, 'View my project'));
}

// ---------- Corte 3: the visit and its closing emails ----------
const money = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

function twoButtons(okUrl, okLabel, noUrl, noLabel) {
  return `<p style="text-align:center;margin:24px 0 8px;">
      <a href="${esc(okUrl)}" style="background:#1f8a4c;color:#ffffff;padding:13px 30px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;margin:0 6px 8px 0;box-shadow:0 2px 6px rgba(31,138,76,.35);">${esc(okLabel)}</a>
      <a href="${esc(noUrl)}" style="background:#ffffff;color:#b42318;padding:11px 26px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;border:2px solid #f3c1c1;">${esc(noLabel)}</a>
    </p>`;
}
function photoStrip(urls) {
  const list = (urls || []).slice(0, 4);
  if (!list.length) return '';
  return `<div style="margin:16px 0;text-align:center;">${list.map(u =>
    `<img src="${esc(u)}" alt="Finished work" width="130" height="130" style="width:130px;height:130px;object-fit:cover;border-radius:10px;margin:4px;border:1px solid #e2e8f0;">`).join('')}</div>`;
}

function dayBeforeReminderCustomer({ customerName, techName, photoUrl, projectId, serviceType, day, window }) {
  return brandShell(`See you tomorrow &mdash; project #${esc(String(projectId))}`,
    `<p style="margin:0;">Hi <strong>${esc(greetName(customerName))}</strong>, a reminder that your <strong>${esc(serviceType)}</strong> visit is <strong>tomorrow, ${esc(prettyDay(day))}</strong>${window ? `, arrival window <strong>${esc(window)}</strong>` : ''}.</p>`,
    `${techPhoto(photoUrl, 110)}${techName ? `<p style="text-align:center;margin:6px 0 0;color:#143d7a;"><strong>${esc(techName)}</strong></p>` : ''}`
    + flexBox()
    + `<p style="color:#5b6b7e;font-size:14px;line-height:1.65;">Need to change something? Message us from your portal &mdash; please do it before the visit.</p>`
    + btn(`${baseUrl()}/customer.html`, 'Open my project'));
}

function onTheWayCustomer({ customerName, techName, photoUrl, projectId, serviceType }) {
  return brandShell(`Your pro is on the way &mdash; project #${esc(String(projectId))}`,
    `<p style="margin:0;">Hi <strong>${esc(greetName(customerName))}</strong>, <strong>${esc(techName)}</strong> is on the way for your <strong>${esc(serviceType)}</strong> visit.</p>`,
    `${techPhoto(photoUrl, 110)}<p style="color:#5b6b7e;font-size:14px;line-height:1.65;">Please make sure someone 18+ is home and the work area is accessible.</p>`);
}

function arrivedCustomer({ customerName, techName, photoUrl, projectId, serviceType }) {
  return brandShell(`Your pro has arrived &mdash; project #${esc(String(projectId))}`,
    `<p style="margin:0;">Hi <strong>${esc(greetName(customerName))}</strong>, <strong>${esc(techName)}</strong> checked in at your home and is starting your <strong>${esc(serviceType)}</strong> job.</p>`,
    `${techPhoto(photoUrl, 110)}<p style="color:#5b6b7e;font-size:14px;line-height:1.65;">Is this not the person in the photo? Do not let them in and message Helpman support right away from your portal.</p>`);
}

function workFinishedCustomer({ customerName, techName, projectId, serviceType, photoUrls, balanceCents, autoCharge, confirmUrl, problemUrl, reminder }) {
  const pay = balanceCents > 0
    ? (autoCharge
      ? `<p style="color:#5b6b7e;font-size:14px;line-height:1.65;">When you confirm, the remaining balance of <strong>${esc(money(balanceCents))}</strong> is charged to the card you saved with your deposit. No second checkout.</p>`
      : `<p style="color:#5b6b7e;font-size:14px;line-height:1.65;">After you confirm, you can pay the remaining balance of <strong>${esc(money(balanceCents))}</strong> from your portal.</p>`)
    : '';
  return brandShell(`${reminder ? 'Reminder: ' : ''}Your job is finished &mdash; did everything go well?`,
    `<p style="margin:0;">Hi <strong>${esc(greetName(customerName))}</strong>, <strong>${esc(techName)}</strong> finished your <strong>${esc(serviceType)}</strong> job (project #${esc(String(projectId))}). Here is the finished work:</p>`,
    photoStrip(photoUrls) + pay
    + twoButtons(confirmUrl, 'Everything is fine — confirm & sign', problemUrl, 'Report a problem')
    + `<p style="color:#8a97a5;font-size:12.5px;line-height:1.6;">Confirming takes one minute from your phone. If something is not right, report it and Helpman support takes it from there &mdash; payments stay on hold until it is solved.</p>`);
}

function receiptCustomer({ customerName, projectId, serviceType, lines, totalCents }) {
  const rows = (lines || []).map(([k, c]) => kvRow(k, esc(money(c)))).join('');
  return brandShell(`Receipt &mdash; project #${esc(String(projectId))} is paid in full`,
    `<p style="margin:0;">Hi <strong>${esc(greetName(customerName))}</strong>, thank you! Your <strong>${esc(serviceType)}</strong> project is paid in full.</p>`,
    `<table style="margin:16px 0;border-collapse:collapse;" cellpadding="0" cellspacing="0"><tbody>${rows}${kvRow('Total paid', esc(money(totalCents)))}</tbody></table>`
    + btn(`${baseUrl()}/customer.html`, 'See my project'));
}

function reviewRequestCustomer({ customerName, techName, projectId, reminder }) {
  return brandShell(reminder ? 'How did we do? (one minute)' : `Thanks for choosing Helpman &mdash; project #${esc(String(projectId))}`,
    `<p style="margin:0;">Hi <strong>${esc(greetName(customerName))}</strong>, ${reminder ? 'we would love to hear' : 'your project is complete. Tell us'} how <strong>${esc(techName || 'your pro')}</strong> did &mdash; your review helps other neighbors and helps us keep the best pros.</p>`,
    btn(`${baseUrl()}/customer.html#review`, 'Leave a review'));
}

module.exports = { notify, shell, esc, projectParties, greetName,
  brandShell, welcomeCustomer, welcomeContractor, photoReminder,
  quoteAcceptedCustomer, techAssignedCustomer, jobOfferContractor,
  offerAcceptedContractor, scheduleConfirmedContractor, scheduleConfirmedCustomer,
  contractorPhotoUrl, prettyDay, FLEX_NOTE,
  dayBeforeReminderCustomer, onTheWayCustomer, arrivedCustomer, workFinishedCustomer, receiptCustomer, reviewRequestCustomer,
  depositConfirmationEmail, contractorAcceptanceEmail,
  scheduleNotificationEmails, completionEmails };

const SITE = () => (process.env.PUBLIC_URL || 'https://helpman.app').replace(/\/$/, '');

async function depositConfirmationEmail(projectId) {
  const { project, job, customer } = await projectParties(projectId);
  if (!project || !customer || !customer.email) return;
  const dep = await db.prepare(
    `SELECT amount_cents, provider FROM payments WHERE project_id = ? AND kind = 'deposit' AND status IN ('paid','recorded') ORDER BY id DESC LIMIT 1`
  ).get(projectId);
  await notify({
    to: customer.email,
    subject: `Deposit received — project #${project.id} ✓`,
    html: shell('Deposit received ✓', `Hi ${greetName(customer.name || '')}, your deposit is confirmed:`, [
      ['Project', `#${project.id} — ${job.service_type}`],
      ['Amount paid', '$' + ((dep ? dep.amount_cents : project.expected_deposit) / 100).toFixed(2)],
      ['Method', dep && dep.provider === 'stripe' ? 'Card (Stripe)' : dep && dep.provider === 'simulated' ? 'Simulated (test)' : 'Manual'],
      ['Terms of Service', `${SITE()}/terms.html`],
      ['Next step', 'We assign your professional and notify you with the scheduled date.'],
    ]),
  }).catch(() => {});
}

async function contractorAcceptanceEmail(projectId) {
  const { project, job, contractor } = await projectParties(projectId);
  if (!project || !contractor || !contractor.email) return;
  await notify({
    to: contractor.email,
    subject: `You accepted project #${project.id} ✓`,
    html: shell('Job accepted ✓', `Hi ${greetName(contractor.name)}, you accepted this job under the Independent Contractor Terms:`, [
      ['Project', `#${project.id} — ${job.service_type}`],
      ['Your payout', '$' + (project.contractor_cost_cents / 100).toFixed(2)],
      ['Independent Contractor Terms', `${SITE()}/contractor-terms.html`],
      ['Reminder', 'No direct contact with the customer — all communication goes through Helpman support.'],
    ]),
  }).catch(() => {});
}

async function scheduleNotificationEmails(projectId) {
  const { project, job, customer, contractor } = await projectParties(projectId);
  if (!project || !project.scheduled_start) return;
  const dates = project.scheduled_start + (project.scheduled_end && project.scheduled_end !== project.scheduled_start ? ` → ${project.scheduled_end}` : '');
  const addr = [job.address, job.city, job.state, job.zip].filter(Boolean).join(', ');
  if (customer && customer.email) {
    await notify({
      to: customer.email,
      subject: `Your job is approved for ${project.scheduled_start} — project #${project.id}`,
      html: shell('Job approved ✓', 'Your work is approved and scheduled:', [
        ['Project', `#${project.id} — ${job.service_type}`],
        ['Date', dates],
        ['Professional coming', contractor ? contractor.name : 'Assigned pro'],
        ['Address', addr || '—'],
      ]),
    }).catch(() => {});
  }
  if (contractor && contractor.email) {
    await notify({
      to: contractor.email,
      subject: `Scheduled: project #${project.id} — ${project.scheduled_start}`,
      html: shell('You are scheduled 📅', `Hi ${greetName(contractor.name)}, this job is scheduled:`, [
        ['Project', `#${project.id} — ${job.service_type}`],
        ['Date', dates],
        ['Address', addr || '—'],
        ['Reminder', 'Print the close-out sheet, have the customer sign it, and upload photos of the finished work + the signed sheet.'],
      ]),
    }).catch(() => {});
  }
}

async function completionEmails(projectId) {
  const { project, job, customer, contractor } = await projectParties(projectId);
  if (!project) return;
  if (customer && customer.email) {
    await notify({
      to: customer.email,
      subject: `Your project is complete (#${project.id}) 🎉`,
      html: reviewRequestCustomer({
        customerName: String(customer.name || '').split(' ')[0] || 'there',
        techName: contractor ? require('./views').displayName(contractor.name) : null,
        projectId: project.id,
      }),
    }).catch(() => {});
  }
  if (contractor && contractor.email) {
    await notify({
      to: contractor.email,
      subject: `Project #${project.id} closed — thanks!`,
      html: shell('Job closed ✓', `Hi ${greetName(contractor.name)}, this job is marked complete:`, [
        ['Project', `#${project.id} — ${job.service_type}`],
        ['Payout', '$' + (project.contractor_cost_cents / 100).toFixed(2)],
        ['Next step', 'Watch your portal for the next offer.'],
      ]),
    }).catch(() => {});
  }
}
