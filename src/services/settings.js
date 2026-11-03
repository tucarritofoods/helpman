// Business rules the OWNER sets (admin > Setup > Business rules), stored in
// app_settings. Every rule has a safe default; the values marked `owner_decision`
// are the owner's legal/commercial call (closing plan, C9) and default to the
// most customer-friendly option until he sets them.
'use strict';
const db = require('../db');

const RULES = {
  deposit_pct: {
    label: 'Deposit to book the visit (% of the agreed price)',
    type: 'int', min: 1, max: 100,
    default: () => Number(process.env.DEPOSIT_PCT) || 30,
    help: 'Charged when the customer accepts the quote. The rest is charged automatically to the same card when the customer confirms the work.',
  },
  payout_hold_days: {
    label: 'Days between full payment and the pro\'s automatic payout',
    type: 'int', min: 0, max: 60,
    default: () => (process.env.PAYOUT_TERMS_DAYS !== undefined ? Number(process.env.PAYOUT_TERMS_DAYS) : 7),
    help: 'A short hold lets a customer report a problem before the money leaves Helpman.',
  },
  cancel_free_hours: {
    label: 'Free cancellation until (hours before the visit)',
    type: 'int', min: 0, max: 720, owner_decision: true,
    default: () => 24,
    help: 'A customer who cancels earlier than this gets the whole deposit back.',
  },
  late_cancel_fee_pct: {
    label: 'Late cancellation: % of the deposit Helpman keeps',
    type: 'int', min: 0, max: 100, owner_decision: true,
    default: () => 0,
    help: 'Applies when the customer cancels inside the free window above.',
  },
  customer_no_show_fee_pct: {
    label: 'Customer not home: % of the deposit Helpman keeps',
    type: 'int', min: 0, max: 100, owner_decision: true,
    default: () => 0,
    help: 'Applies when the pro arrives and the customer is not there and the visit is cancelled.',
  },
  // Corte 6.2: operating timeframes (before: fixed in the code).
  confirm_reminder_hours: {
    group: 'timing',
    label: 'Remind the customer to confirm the finished work after (hours)',
    type: 'int', min: 1, max: 168,
    default: () => 24,
    help: 'After the pro marks the job finished, the customer gets one reminder if they have not confirmed or reported a problem.',
  },
  confirm_escalate_hours: {
    group: 'timing',
    label: 'Tell support the customer has not confirmed after (hours)',
    type: 'int', min: 2, max: 336,
    default: () => 72,
    help: 'Support gets an email to follow up. Must be later than the reminder.',
  },
  review_request_days: {
    group: 'timing',
    label: 'Ask again for a review after (days)',
    type: 'int', min: 1, max: 30,
    default: () => 3,
    help: 'One friendly reminder if the customer has not left a review since confirming.',
  },
  client_lost_after_days: {
    group: 'timing',
    label: 'A prospect counts as "lost" after (days without activity)',
    type: 'int', min: 14, max: 730,
    default: () => 90,
    help: 'Used by the client list and by campaign audiences.',
  },
};

async function rawAll() {
  try {
    const rows = await db.prepare('SELECT key, value, updated_at FROM app_settings').all();
    return Object.fromEntries(rows.map(r => [r.key, r]));
  } catch (e) { return {}; }
}

function coerce(key, v) {
  const r = RULES[key];
  const n = Number(v);
  if (r.type === 'int' && Number.isInteger(n) && n >= r.min && n <= r.max) return n;
  return null;
}

async function get(key) {
  const r = RULES[key];
  if (!r) throw new Error('Unknown setting: ' + key);
  const row = (await rawAll())[key];
  const v = row ? coerce(key, row.value) : null;
  return v === null ? r.default() : v;
}

async function all() {
  const raw = await rawAll();
  return Object.entries(RULES).map(([key, r]) => {
    const stored = raw[key] ? coerce(key, raw[key].value) : null;
    return {
      key, label: r.label, help: r.help, type: r.type, min: r.min, max: r.max, group: r.group || 'money',
      value: stored === null ? r.default() : stored,
      is_default: stored === null,
      owner_decision: !!r.owner_decision,
      pending_owner: !!r.owner_decision && stored === null,
      updated_at: raw[key] ? raw[key].updated_at : null,
    };
  });
}

// Returns { errors } or { saved: [...] }.
async function update(values, userId) {
  const errors = {};
  const ok = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!RULES[k]) { errors[k] = 'Unknown setting.'; continue; }
    const c = coerce(k, v);
    if (c === null) errors[k] = `Whole number from ${RULES[k].min} to ${RULES[k].max}.`;
    else ok[k] = c;
  }
  if (Object.keys(errors).length) return { errors };
  // Support must hear about an unconfirmed job AFTER the customer's reminder.
  const remind = ok.confirm_reminder_hours !== undefined ? ok.confirm_reminder_hours : await get('confirm_reminder_hours');
  const escalate = ok.confirm_escalate_hours !== undefined ? ok.confirm_escalate_hours : await get('confirm_escalate_hours');
  if (escalate <= remind) return { errors: { confirm_escalate_hours: 'Must be later than the customer reminder.' } };
  for (const [k, v] of Object.entries(ok)) {
    // Explicit RETURNING: the pg adapter adds "RETURNING id" otherwise, and this table has no id.
    const sql = db._isPg
      ? `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP RETURNING key`
      : `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`;
    await db.prepare(sql).run(k, String(v), userId || null);
  }
  return { saved: Object.keys(ok) };
}

module.exports = { RULES, get, all, update };
