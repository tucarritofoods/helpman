// "Panel de enchufes" — the owner's plug-in checklist.
//
// Helpman is delivered in a "just plug it in" state: everything is built, and
// what is left is configuration the OWNER provides (accounts, keys, a paid plan).
// This module reports, for each plug, whether it is in place — WITHOUT ever
// returning a secret value — and runs a harmless live test where possible.
//
// Plug codes match the closing plan (E1..E6):
//   E1 Stripe · E2 Hosting + database · E3 Photo storage · E4 Email
//   E5 Initial access & security · E6 Optional services
'use strict';
const db = require('../db');
const mailer = require('./mailer');
const storage = require('./storage');

const present = (k) => !!(process.env[k] && String(process.env[k]).trim());
const envList = (keys) => keys.map(k => ({ name: k, set: present(k) }));
const isProd = () => process.env.NODE_ENV === 'production';
const diskDbPath = () => /^\/var\/data\//.test(String(process.env.DB_PATH || ''));

function stripeMode() {
  const sk = String(process.env.STRIPE_SECRET_KEY || '');
  const pk = String(process.env.STRIPE_PUBLISHABLE_KEY || '');
  const m = (k) => (/_live_/.test(k) ? 'live' : /_test_/.test(k) ? 'test' : null);
  return { secret: m(sk), publishable: m(pk) };
}

function item(code, id, label, status, detail, env, extra) {
  return { code, id, label, status, detail, env: env ? envList(env) : [], ...(extra || {}) };
}

// status: 'ok' | 'missing' | 'warning' | 'manual' | 'optional'
async function report() {
  const items = [];

  // ---- E1 Stripe ----
  {
    // Connect (pro payouts) needs its own webhook secret: Stripe Dashboard > Webhooks > "Connected accounts".
    const env = ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET'];
    const mode = stripeMode();
    let status = env.every(present) ? 'ok' : 'missing';
    let detail = status === 'ok'
      ? `Connected in ${mode.secret || 'unknown'} mode.`
      : 'Activate the Stripe account and Connect (Express), then paste the secret and publishable keys and the two webhook signing secrets (account events and Connect events).';
    if (status === 'ok' && mode.secret && mode.publishable && mode.secret !== mode.publishable) {
      status = 'warning'; detail = 'The secret and publishable keys are from different modes (test vs live).';
    } else if (status === 'ok' && isProd() && mode.secret === 'test') {
      status = 'warning'; detail = 'Production is running with TEST keys: no real money moves.';
    }
    items.push(item('E1', 'stripe', 'Stripe payments', status, detail, env, { testable: present('STRIPE_SECRET_KEY') }));
  }

  // ---- E2 Hosting + database ----
  {
    let dbOk = false;
    try { dbOk = !!(await db.prepare('SELECT 1 AS ok').get()); } catch (e) { dbOk = false; }
    const pg = present('DATABASE_URL');
    const diskDb = !pg && diskDbPath();
    let status = !dbOk ? 'missing' : (pg || diskDb) ? 'ok' : 'missing';
    let detail = !dbOk ? 'The database does not answer.'
      : pg ? 'PostgreSQL (persistent, with the backups of your plan).'
      : diskDb ? 'SQLite on the persistent disk (no managed backups).'
      : 'SQLite on the ephemeral filesystem: data is WIPED on every restart or deploy. Move to Render Starter + Postgres (or a persistent disk).';
    items.push(item('E2', 'database', 'Database (persistent)', status, detail, ['DATABASE_URL', 'DB_SSL'], { testable: true }));
    items.push(item('E2', 'hosting', 'Always-on hosting plan', 'manual',
      'Render free instances sleep: reminders, follow-ups and the email queue stop while asleep. Confirm the web service is on the Starter plan (or higher) in the Render dashboard.',
      ['NODE_ENV', 'PUBLIC_URL']));
    const url = String(process.env.PUBLIC_URL || '');
    items.push(item('E2', 'public_url', 'Public URL (HTTPS)', /^https:\/\//.test(url) ? 'ok' : 'missing',
      /^https:\/\//.test(url) ? `Links in emails point to ${url}.` : 'Set PUBLIC_URL=https://helpman.app so email links work.', ['PUBLIC_URL']));
  }

  // ---- E3 Photo storage ----
  {
    const s3 = storage.isConfigured();
    const disk = present('UPLOADS_DIR') && /^\/var\/data\//.test(String(process.env.UPLOADS_DIR));
    items.push(item('E3', 'storage', 'Photo storage (persistent)', s3 || disk ? 'ok' : 'missing',
      s3 ? 'Private S3-compatible bucket (signed links).' : disk ? 'Persistent disk (UPLOADS_DIR).' : 'Photos are stored on the ephemeral filesystem and are LOST on restart. Create a private R2/S3 bucket.',
      ['S3_BUCKET', 'S3_REGION', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'], { testable: s3 }));
  }

  // ---- E4 Email ----
  {
    const provider = mailer.activeProvider();
    const auth = mailer.senderIsAuthenticatable();
    const postal = present('COMPANY_POSTAL_ADDRESS');
    let status = provider === 'console' ? 'missing' : (!auth || !postal) ? 'warning' : 'ok';
    const detail = provider === 'console'
      ? 'Email is in LOG mode: nothing is really delivered. Add the provider key and verify the helpman.app domain (SPF, DKIM, DMARC).'
      : !auth ? `The sender ${mailer.FROM_EMAIL} is a free mailbox: it cannot be authenticated and will land in spam. Use an address on your domain.`
      : !postal ? 'Set COMPANY_POSTAL_ADDRESS: the law requires it in the footer of marketing email.'
      : `Delivering through ${provider} as ${mailer.FROM_NAME} <${mailer.FROM_EMAIL}>.`;
    items.push(item('E4', 'email', 'Email delivery', status, detail,
      ['EMAIL_PROVIDER', 'SENDGRID_API_KEY', 'HANDYMAN_FROM_EMAIL', 'COMPANY_POSTAL_ADDRESS'], { testable: provider !== 'console' }));
  }

  // ---- E5 Initial access & security ----
  {
    const jwtOk = String(process.env.JWT_SECRET || '').length >= 32;
    const totpOk = String(process.env.TOTP_ENC_KEY || '').length >= 32;
    let owners = [];
    try {
      owners = await db.prepare("SELECT id, totp_enabled FROM users WHERE role = 'admin' AND (staff_role IS NULL OR staff_role = 'owner')").all();
    } catch (e) { owners = []; }
    const without2fa = owners.filter(o => !o.totp_enabled).length;
    items.push(item('E5', 'secrets', 'Signing keys', jwtOk && totpOk ? 'ok' : 'missing',
      jwtOk && totpOk ? 'Session and two-step keys are set and long enough.' : 'JWT_SECRET and TOTP_ENC_KEY must each be at least 32 random characters (set TOTP_ENC_KEY once and never change it).',
      ['JWT_SECRET', 'TOTP_ENC_KEY']));
    items.push(item('E5', 'owner_2fa', 'Owner two-step verification', owners.length && !without2fa ? 'ok' : 'missing',
      !owners.length ? 'No owner account exists yet (set ADMIN_EMAIL + ADMIN_PASSWORD before the first boot).'
        : without2fa ? `${without2fa} owner account(s) without two-step verification. Turn it on in the Security tab.`
        : 'Every owner account uses two-step verification.',
      ['ADMIN_EMAIL', 'ADMIN_PASSWORD']));
    items.push(item('E5', 'production', 'Production mode', isProd() ? 'ok' : 'warning',
      isProd() ? 'NODE_ENV=production: fail-fast checks and required two-step verification are on.'
        : 'NODE_ENV is not "production": two-step verification is not enforced and, without Stripe, an accepted quote records the deposit with no money collected. Set NODE_ENV=production together with the Stripe keys (E1).',
      ['NODE_ENV']));
    // Variables that no code reads: clutter, and secrets nobody rotates.
    const UNUSED = ['VITE_API_URL', 'REFRESH_TOKEN_SECRET', 'SESSION_SECRET'];
    const leftovers = UNUSED.filter(present);
    if (leftovers.length) {
      items.push(item('E5', 'leftovers', 'Unused variables', 'warning',
        `Helpman does not read ${leftovers.join(', ')}. Delete them from Render.`, leftovers));
    }
    if (present('ADMIN_PASSWORD') && (present('DATABASE_URL') || diskDbPath())) {
      items.push(item('E5', 'admin_password', 'First-boot password still set', 'warning',
        'ADMIN_PASSWORD is only used to create the first admin on an empty database. With persistent data, delete it from Render.', ['ADMIN_PASSWORD']));
    }
  }

  // ---- E6 Optional ----
  items.push(item('E6', 'sms', 'Text messages (Twilio)', ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'].every(present) ? 'ok' : 'optional',
    'Optional: every notice also goes out by email.', ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']));
  items.push(item('E6', 'ai', 'AI assistance (OpenAI)', present('OPENAI_API_KEY') ? 'ok' : 'optional',
    'Optional: drafts and photo hints. The estimator works without it.', ['OPENAI_API_KEY']));
  items.push(item('E6', 'geocode', 'Distance matching (Mapbox)', present('GEOCODE_API_KEY') ? 'ok' : 'optional',
    'Optional: adds distance to contractor matching.', ['GEOCODE_API_KEY']));

  const required = items.filter(i => !['optional'].includes(i.status));
  const ready = required.every(i => i.status === 'ok' || i.status === 'manual');
  return {
    ready,
    summary: {
      ok: items.filter(i => i.status === 'ok').length,
      missing: items.filter(i => i.status === 'missing').length,
      warning: items.filter(i => i.status === 'warning').length,
      manual: items.filter(i => i.status === 'manual').length,
      optional: items.filter(i => i.status === 'optional').length,
    },
    items,
    checked_at: new Date().toISOString(),
  };
}

// Live tests. Each returns { ok, detail } and never exposes a secret.
async function runTest(id, user) {
  if (id === 'database') {
    const t0 = Date.now();
    await db.prepare('SELECT 1 AS ok').get();
    return { ok: true, detail: `Database answered in ${Date.now() - t0} ms.` };
  }
  if (id === 'stripe') {
    if (!present('STRIPE_SECRET_KEY')) return { ok: false, detail: 'STRIPE_SECRET_KEY is not set.' };
    const stripe = require('./stripe').getClient();
    const bal = await stripe.balance.retrieve();
    return { ok: true, detail: `Stripe answered (${bal.livemode ? 'live' : 'test'} mode).` };
  }
  if (id === 'storage') {
    if (!storage.isConfigured()) return { ok: false, detail: 'S3_BUCKET is not set.' };
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), `plug-test-${Date.now()}.txt`);
    fs.writeFileSync(tmp, 'helpman storage test');
    const key = `healthchecks/${Date.now()}.txt`;
    try {
      await storage.putObject({ key, filePath: tmp, contentType: 'text/plain' });
      await storage.deleteObject(key);
    } finally { try { fs.unlinkSync(tmp); } catch (e) { /* gone */ } }
    return { ok: true, detail: 'Wrote and deleted a test object in the bucket.' };
  }
  if (id === 'email') {
    if (mailer.activeProvider() === 'console') return { ok: false, detail: 'Email is in log mode (no provider key).' };
    const { notify, shell } = require('./notify');
    const r = await notify({
      to: user.email,
      subject: 'Helpman — email plug test',
      html: shell('Email works', 'This test message was sent from the plug-in panel.', [['Sender', `${mailer.FROM_NAME} <${mailer.FROM_EMAIL}>`]]),
    });
    return r && r.ok === false ? { ok: false, detail: 'The provider refused the message. Check the key and the verified sender.' }
      : { ok: true, detail: `Test email sent to ${user.email}.` };
  }
  return { ok: false, detail: 'There is no live test for this item.' };
}

module.exports = { report, runTest };
