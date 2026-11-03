// What each side of the marketplace is allowed to SEE.
//
// GOLDEN RULE (owner, non-negotiable): customers and contractors never get a way
// to contact each other directly. The platform owns the relationship; support
// sits in the middle of every conversation.
//
// This module is the single place that decides what leaves the API for a
// customer or a contractor:
//   1. role serializers (projectForContractor, projectForCustomer, quoteForCustomer,
//      changeOrderForContractor, ...) build WHITELISTED objects;
//   2. redactContacts() removes phone numbers, emails and "reach me elsewhere"
//      handles from free text written by the other side;
//   3. responseGuard (mounted once in server.js) is the safety net: for every JSON
//      response sent to a customer or a contractor it deep-removes keys that side
//      must never receive (other people's contact data, the other side's money,
//      secrets and capability tokens), even if a route forgets to serialize.
'use strict';

// ---------------------------------------------------------------------------
// Free-text redaction
// ---------------------------------------------------------------------------
const REDACTED = '[contact removed — message Helpman support]';
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// 10+ digits with the usual separators — "(707) 555-0199", "+1 707.555.0199",
// "7075550199" — while ordinary quantities ("400 sqft", "$1,250") survive.
const PHONE_RE = /(?:\+?\d[\s().-]{0,2}){9,}\d/g;
const HANDLE_RE = /\b(?:whats\s?app|telegram|signal|venmo|zelle|cash\s?app|facebook|instagram|tiktok|snapchat)\b(?:[^\n.,;[]|\.(?=\S)){0,40}/gi;
const AT_HANDLE_RE = /(^|\s)@[A-Za-z0-9_.]{3,30}\b/g;

function redactContacts(text) {
  if (text === null || text === undefined) return text;
  let t = String(text);
  // Messaging-app mentions first, so "whatsapp 707…" is removed as ONE piece.
  t = t.replace(HANDLE_RE, REDACTED);
  t = t.replace(EMAIL_RE, REDACTED);
  t = t.replace(PHONE_RE, REDACTED);
  t = t.replace(AT_HANDLE_RE, (m, lead) => `${lead}${REDACTED}`);
  return t;
}

// Applies redactContacts to every string inside a JSON-like value.
function redactDeep(v) {
  if (typeof v === 'string') return redactContacts(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = redactDeep(x);
    return out;
  }
  return v;
}

// "Carlos Martínez Pérez" -> "Carlos M." — enough to recognise the person at the
// door, not enough to look them up and go around the platform.
function displayName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}
const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || '';

function pick(obj, keys) {
  const out = {};
  if (!obj) return out;
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

// ---------------------------------------------------------------------------
// Contractor views
// ---------------------------------------------------------------------------
const PROJECT_FIELDS_FOR_CONTRACTOR = [
  'id', 'job_request_id', 'contractor_id', 'contractor_status', 'stage',
  'scheduled_start', 'scheduled_end', 'arrival_window', 'schedule_status', 'offer_expires_at',
  'contractor_cost_cents', 'created_at', 'updated_at', 'completion_signed_at',
  'arrived_at', 'departed_at', 'on_my_way_at',
];
const MILESTONE_FIELDS = ['id', 'project_id', 'title', 'sort_order', 'status', 'customer_approval', 'approved_at', 'created_at'];
const PHOTO_FIELDS = ['id', 'filename', 'original_name', 'mime', 'kind', 'created_at'];

// The request as the assigned contractor sees it: what the work is and where,
// never who to call. The street address is released only once the contractor has
// ACCEPTED the job (before that: city + ZIP, enough to decide).
function jobForContractor(job, project) {
  if (!job) return null;
  const accepted = project && project.contractor_status === 'accepted';
  let scope = {};
  try { scope = typeof job.scope_json === 'string' ? JSON.parse(job.scope_json || '{}') : (job.scope || {}); } catch (e) { scope = {}; }
  return {
    id: job.id,
    service_type: job.service_type,
    urgency: job.urgency,
    description: redactContacts(job.description || ''),
    scope: redactDeep(scope),
    customer_first_name: firstName(job.name),
    city: job.city || null,
    state: job.state || null,
    zip: job.zip || null,
    address: accepted ? (job.address || null) : null,
    address_note: accepted ? null : 'The exact address is shared once you accept the job.',
  };
}

function projectForContractor(full) {
  if (!full) return full;
  const out = pick(full, PROJECT_FIELDS_FOR_CONTRACTOR);
  if (Array.isArray(full.milestones)) out.milestones = full.milestones.map(m => pick(m, MILESTONE_FIELDS));
  if (Array.isArray(full.photos)) out.photos = full.photos.map(p => pick(p, PHOTO_FIELDS));
  if (full.job) out.job = jobForContractor(full.job, full);
  return out;
}

// Change orders: the contractor proposes scope/schedule; the CUSTOMER price change
// is set by Helpman and is not the contractor's business.
function changeOrderForContractor(co) {
  if (!co) return co;
  const { price_delta_cents, customer_note, ...rest } = co;
  return rest;
}

// Reviews arrive from customers: strip anything that would let the pro reach them.
function reviewForContractor(r) {
  if (!r) return r;
  return { id: r.id, project_id: r.project_id, rating: r.rating, comment: redactContacts(r.comment), created_at: r.created_at };
}

// ---------------------------------------------------------------------------
// Customer views
// ---------------------------------------------------------------------------
const CUSTOMER_PROJECT_HIDDEN = ['contractor_cost_cents', 'schedule_token', 'schedule_expires_at'];

function contractorForCustomer(c, photoUrl) {
  if (!c) return null;
  const full = c.name || c.user_name || '';
  return {
    first_name: firstName(full),
    display_name: displayName(full),
    photo_url: photoUrl || null,
    rating_avg: c.rating_avg,
    jobs_completed: c.jobs_completed,
    license_verified: !!c.license_verified,
    insurance_verified: !!c.insurance_verified,
  };
}

function projectForCustomer(full, photoUrl) {
  if (!full) return full;
  const out = { ...full };
  for (const k of CUSTOMER_PROJECT_HIDDEN) delete out[k];
  if (out.job) { const { claim_token, ...job } = out.job; out.job = job; }
  out.contractor = full.contractor ? contractorForCustomer(full.contractor, photoUrl) : null;
  return out;
}

// What the customer pays is theirs to see; what Helpman pays the pro (= the
// platform margin) is not.
function quoteForCustomer(q) {
  if (!q) return q;
  const { contractor_cost_cents, ...rest } = q;
  return rest;
}

// ---------------------------------------------------------------------------
// Safety net: responseGuard
// ---------------------------------------------------------------------------
// Never sent to a customer or a contractor, whatever the route.
const SECRET_KEYS = new Set([
  'password_hash', 'reset_token', 'reset_expires', 'verify_token', 'verify_expires',
  'totp_secret', 'totp_secret_enc', 'totp_recovery', 'totp_recovery_json', 'recovery_codes',
  'token_version', 'schedule_token', 'stripe_secret', 'signer_ip',
  'stripe_customer_id', 'payment_method_id',
]);
// Never sent to a contractor: the customer's money, identity and location.
const CONTRACTOR_HIDDEN = new Set([
  'customer_price_cents', 'deposit_cents', 'deposit_pct', 'price_delta_cents', 'margin_cents', 'margin_note',
  'amount_cents', 'refund_cents', 'customer_id', 'customer_note', 'claim_token', 'lat', 'lng',
  'customer_email', 'customer_phone', 'customer_name', 'customer_address',
  'balance_charge_status', 'balance_charge_error', 'balance_charge_attempts', 'cancellation_kind',
]);
// Never sent to a customer: what Helpman pays the pro, and the pro's identity documents.
const CUSTOMER_HIDDEN = new Set([
  'contractor_cost_cents', 'payable_cents', 'margin_cents', 'margin_note', 'proposed_cents',
  'legal_name', 'license_number', 'insurance_info', 'contractor_email', 'contractor_phone',
  'user_email', 'user_phone', 'service_base', 'service_radius_miles',
  'contractor_cost_delta_cents', 'stripe_account_id', 'payouts_enabled', 'payout_details_submitted',
  'payout_requirements', 'transfer_id', 'reversed_cents',
]);
const CONTACT_KEYS = new Set(['email', 'phone', 'to_email', 'to_phone']);
const CONTRACTOR_MARKERS = ['contractor_kind', 'legal_name', 'license_number', 'rating_avg', 'jobs_completed', 'provider_type'];
const CONTRACTORISH_PARENT = /contractor|technician|tech\b|^pro$|^cont$|^assignee/i;

const digits = (s) => String(s || '').replace(/\D/g, '');
const lower = (s) => String(s || '').trim().toLowerCase();

function isOwnContact(key, value, user) {
  if (value === null || value === undefined || value === '') return true;
  if (key.includes('email')) return lower(value) === lower(user.email);
  const d = digits(value);
  return d.length > 0 && d === digits(user.phone);
}

function scrub(value, role, user, parentKey, depth) {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(v => scrub(v, role, user, parentKey, depth + 1));
  const looksContractor = CONTRACTOR_MARKERS.some(k => k in value) || CONTRACTORISH_PARENT.test(parentKey || '');
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(k)) continue;
    if (role === 'contractor') {
      if (CONTRACTOR_HIDDEN.has(k)) continue;
      // A contractor never receives anybody's contact details but their own.
      if (CONTACT_KEYS.has(k) && !isOwnContact(k, v, user)) continue;
    } else if (role === 'customer') {
      if (CUSTOMER_HIDDEN.has(k)) continue;
      // A customer never receives a pro's contact details.
      if (CONTACT_KEYS.has(k) && looksContractor && !isOwnContact(k, v, user)) continue;
    }
    out[k] = scrub(v, role, user, k, depth + 1);
  }
  return out;
}

function guardPayload(body, user) {
  if (!user || !['customer', 'contractor'].includes(user.role)) return body;
  return scrub(body, user.role, user, '', 0);
}

// Express middleware: wraps res.json once per request. The role is read when the
// response is SENT (routers authenticate after this middleware runs).
function responseGuard(req, res, next) {
  const original = res.json.bind(res);
  res.json = (body) => {
    try {
      return original(guardPayload(body, req.user));
    } catch (e) {
      console.error('[responseGuard]', e && e.message);
      return original(body && typeof body === 'object' && body.error ? { error: body.error } : { error: 'Something went wrong on our end. Please try again.' });
    }
  };
  next();
}

module.exports = {
  REDACTED, redactContacts, redactDeep, displayName, firstName,
  jobForContractor, projectForContractor, changeOrderForContractor, reviewForContractor,
  contractorForCustomer, projectForCustomer, quoteForCustomer,
  guardPayload, responseGuard,
  _sets: { SECRET_KEYS, CONTRACTOR_HIDDEN, CUSTOMER_HIDDEN },
};
