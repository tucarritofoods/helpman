// Database layer: SQLite (better-sqlite3) by default, PostgreSQL when
// DATABASE_URL is set. Both expose the same async-compatible API:
//   await db.prepare(sql).get(...params) -> row | undefined
//   await db.prepare(sql).all(...params) -> rows[]
//   await db.prepare(sql).run(...params) -> { lastInsertRowid, changes }
//   await db.exec(sql)
//   await db.transaction(async (t) => { ... })
//
// Money is stored in integer CENTS everywhere to avoid float errors.
if (process.env.DATABASE_URL) {
  module.exports = require('./db/pg');
  return;
}

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'handyman.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer','contractor','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contractors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  legal_name TEXT NOT NULL,
  city TEXT,
  service_base TEXT,
  service_radius_miles INTEGER DEFAULT 25,
  years_experience INTEGER DEFAULT 0,
  specialties TEXT,
  license_number TEXT,
  insurance_info TEXT,
  license_verified INTEGER NOT NULL DEFAULT 0,
  insurance_verified INTEGER NOT NULL DEFAULT 0,
  background_check TEXT NOT NULL DEFAULT 'pending' CHECK (background_check IN ('pending','passed','failed')),
  photo_filename TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  has_license INTEGER NOT NULL DEFAULT 1,
  license_exempt INTEGER NOT NULL DEFAULT 0,
  contractor_kind TEXT NOT NULL DEFAULT 'independent' CHECK (contractor_kind IN ('independent','inhouse')),
  rating_avg REAL DEFAULT 0,
  jobs_completed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  address TEXT NOT NULL,
  city TEXT,
  state TEXT,
  zip TEXT,
  service_type TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'standard' CHECK (urgency IN ('standard','urgent')),
  description TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','ai_analyzed','quote_sent','deposit_paid','assigned','scheduled','in_progress','review','completed','lost','cancelled')),
  lead_score INTEGER NOT NULL DEFAULT 0,
  source TEXT DEFAULT 'web',
  claim_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER REFERENCES job_requests(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime TEXT,
  size_bytes INTEGER,
  width INTEGER,
  height INTEGER,
  kind TEXT NOT NULL DEFAULT 'request' CHECK (kind IN ('request','progress','completion','signoff')),
  vision_json TEXT DEFAULT '{}',
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  low_cents INTEGER NOT NULL,
  high_cents INTEGER NOT NULL,
  line_items_json TEXT NOT NULL DEFAULT '[]',
  missing_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER NOT NULL DEFAULT 0,
  factors_json TEXT NOT NULL DEFAULT '[]',
  engine_version TEXT NOT NULL DEFAULT '1.0',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  estimate_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL,
  customer_price_cents INTEGER NOT NULL,
  contractor_cost_cents INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL,
  deposit_pct INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  valid_until TEXT,
  sent_at TEXT,
  responded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  contractor_id INTEGER REFERENCES contractors(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'assigned' CHECK (stage IN ('assigned','scheduled','in_progress','review','completed','cancelled')),
  scheduled_start TEXT,
  scheduled_end TEXT,
  offer_expires_at TEXT,
  arrival_window TEXT,
  schedule_status TEXT NOT NULL DEFAULT 'pending',
  schedule_token TEXT,
  schedule_expires_at TEXT,
  customer_price_cents INTEGER NOT NULL,
  contractor_cost_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
  customer_approval TEXT NOT NULL DEFAULT 'pending' CHECK (customer_approval IN ('pending','approved','rejected')),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bookkeeping only. Stripe is NOT integrated (see ROADMAP.md).
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('deposit','milestone','final','refund')),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','pending','failed')),
  provider TEXT NOT NULL DEFAULT 'manual' CHECK (provider IN ('manual','stripe_stub')),
  provider_ref TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  segment TEXT NOT NULL,
  template_id INTEGER REFERENCES email_templates(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','sending','done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  to_name TEXT,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  provider TEXT NOT NULL DEFAULT 'console',
  error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER REFERENCES email_outbox(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER REFERENCES contractors(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  referrer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  referred_email TEXT,
  referred_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','redeemed')),
  discount_pct INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  redeemed_at TEXT
);

CREATE TABLE IF NOT EXISTS followup_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER REFERENCES job_requests(id) ON DELETE CASCADE,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON job_requests(status);
CREATE INDEX IF NOT EXISTS idx_jobs_email ON job_requests(email);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_projects_stage ON projects(stage);
CREATE INDEX IF NOT EXISTS idx_projects_contractor ON projects(contractor_id);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON email_outbox(status);

-- PRO 100%: mediated messaging (client<->support, support<->contractor).
-- Direct client<->contractor contact is PROHIBITED by business rule: the
-- platform owns the customer relationship. Two thread kinds per project.
CREATE TABLE IF NOT EXISTS message_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('client_support','support_contractor')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, kind)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer','contractor','admin')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_threads_project ON message_threads(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

-- PRO 100%: admin audit trail.
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_admin ON admin_audit(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON admin_audit(entity, entity_id);

-- Legal: append-only log of Terms acceptances (client quote acceptance,
-- contractor job acceptance). This is the legal proof of who accepted what
-- version and when. Rows are never updated or deleted by the app.
CREATE TABLE IF NOT EXISTS terms_acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('client_quote','contractor_job')),
  reference_id INTEGER NOT NULL,
  terms_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip TEXT,
  UNIQUE (kind, reference_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_terms_user ON terms_acceptances(user_id);
CREATE INDEX IF NOT EXISTS idx_terms_ref ON terms_acceptances(kind, reference_id);

CREATE TABLE IF NOT EXISTS ai_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,provider TEXT NOT NULL,model TEXT,
  job_request_id INTEGER REFERENCES job_requests(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  input_summary TEXT,output_json TEXT NOT NULL DEFAULT '{}',confidence INTEGER,
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','fallback','failed')),
  error_code TEXT,duration_ms INTEGER,created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_job ON ai_runs(job_request_id);
CREATE INDEX IF NOT EXISTS idx_ai_runs_project ON ai_runs(project_id);

CREATE TABLE IF NOT EXISTS job_scope_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,source TEXT NOT NULL CHECK(source IN ('customer','ai','admin','contractor')),
  scope_json TEXT NOT NULL,confidence INTEGER,created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),UNIQUE(job_request_id,version_no)
);
CREATE TABLE IF NOT EXISTS risk_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  severity TEXT NOT NULL DEFAULT 'low' CHECK(severity IN ('low','medium','high','critical')),
  flags_json TEXT NOT NULL DEFAULT '[]',requires_human_review INTEGER NOT NULL DEFAULT 0,
  requires_license_review INTEGER NOT NULL DEFAULT 0,requires_permit_review INTEGER NOT NULL DEFAULT 0,
  notes TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,token_hash TEXT NOT NULL,user_agent TEXT,ip_prefix TEXT,
  expires_at TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','critical')),
  ip_prefix TEXT,user_agent TEXT,detail TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);


CREATE TABLE IF NOT EXISTS operations_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,detail TEXT,entity_type TEXT,entity_id INTEGER,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','blocked','done','dismissed')),
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,due_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','system','sla','payment','dispatch','compliance','customer')),
  fingerprint TEXT,created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  completed_at TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ops_tasks_status_priority ON operations_tasks(status,priority);
CREATE INDEX IF NOT EXISTS idx_ops_tasks_assignee ON operations_tasks(assigned_to);

CREATE TABLE IF NOT EXISTS operations_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,entity_id INTEGER NOT NULL,body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'internal' CHECK(visibility IN ('internal')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ops_notes_entity ON operations_notes(entity_type,entity_id);

CREATE TABLE IF NOT EXISTS sla_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE,label TEXT NOT NULL,
  threshold_minutes INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
INSERT OR IGNORE INTO sla_policies(code,label,threshold_minutes,enabled) VALUES
 ('new_lead_first_action','New lead first action',60,1),
 ('quote_response_followup','Quote follow-up',2880,1),
 ('unassigned_project','Accepted project assignment',240,1),
 ('contractor_offer_response','Contractor offer response',120,1),
 ('customer_approval_wait','Customer approval wait',2880,1),
 ('payment_failure','Payment failure attention',30,1);

CREATE TABLE IF NOT EXISTS operations_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT NOT NULL,entity_type TEXT,entity_id INTEGER,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','critical')),
  summary TEXT NOT NULL,detail TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ops_events_created ON operations_events(created_at);
CREATE TABLE IF NOT EXISTS dispatch_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  match_score REAL,
  status TEXT NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','accepted','declined','expired','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_project ON dispatch_assignments(project_id);



CREATE TABLE IF NOT EXISTS contractor_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  skill_code TEXT NOT NULL,
  proficiency TEXT NOT NULL DEFAULT 'experienced' CHECK (proficiency IN ('basic','experienced','expert')),
  years_experience INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contractor_id,skill_code)
);
CREATE TABLE IF NOT EXISTS contractor_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT,end_time TEXT,is_available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contractor_id,weekday)
);
CREATE TABLE IF NOT EXISTS contractor_blackouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,end_date TEXT NOT NULL,reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,label TEXT,document_number TEXT,issuer TEXT,expires_on TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','verified','rejected','expired')),
  storage_key TEXT,original_name TEXT,mime TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,reviewed_at TEXT,rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_daily_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,summary TEXT NOT NULL,hours_worked REAL,blockers TEXT,
  customer_visible INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_offer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('offered','viewed','accepted','declined','expired')),
  detail TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_quality_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,points INTEGER NOT NULL DEFAULT 0,note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contractor_skills_contractor ON contractor_skills(contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_documents_contractor ON contractor_documents(contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_offer_events ON contractor_offer_events(contractor_id,project_id);


CREATE TABLE IF NOT EXISTS change_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reason TEXT,
  price_delta_cents INTEGER NOT NULL DEFAULT 0,
  schedule_delta_days INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','approved','rejected','cancelled')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at TEXT,
  responded_at TEXT,
  customer_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_change_orders_project ON change_orders(project_id);
CREATE INDEX IF NOT EXISTS idx_change_orders_status ON change_orders(status);

CREATE TABLE IF NOT EXISTS project_schedule_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  preferred_date TEXT,
  time_window TEXT CHECK (time_window IN ('morning','afternoon','evening','anytime')),
  flexibility TEXT CHECK (flexibility IN ('exact','plus_minus_1','plus_minus_3','flexible')),
  notes TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_customer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  actor_role TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_events_project ON project_customer_events(project_id);

`;

db.exec(SCHEMA);

// ---- Lightweight migrations for pre-existing databases ----
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
if (!columnExists('users', 'email_verified')) {
  db.exec(`ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`);
}
if (!columnExists('users', 'verify_token')) {
  db.exec(`ALTER TABLE users ADD COLUMN verify_token TEXT`);
}
if (!columnExists('users', 'verify_expires')) {
  db.exec(`ALTER TABLE users ADD COLUMN verify_expires TEXT`);
}
if (!columnExists('users', 'reset_token')) {
  db.exec(`ALTER TABLE users ADD COLUMN reset_token TEXT`);
}
if (!columnExists('users', 'reset_expires')) {
  db.exec(`ALTER TABLE users ADD COLUMN reset_expires TEXT`);
}
if (!columnExists('projects', 'contractor_status')) {
  db.exec(`ALTER TABLE projects ADD COLUMN contractor_status TEXT CHECK (contractor_status IN ('offered','accepted','declined'))`);
}
// ---- 2026-10-07: contractor licensing + kind (independent vs in-house) ----
if (!columnExists('contractors', 'has_license')) {
  db.exec(`ALTER TABLE contractors ADD COLUMN has_license INTEGER NOT NULL DEFAULT 1`);
}
if (!columnExists('contractors', 'license_exempt')) {
  db.exec(`ALTER TABLE contractors ADD COLUMN license_exempt INTEGER NOT NULL DEFAULT 0`);
}
if (!columnExists('contractors', 'contractor_kind')) {
  db.exec(`ALTER TABLE contractors ADD COLUMN contractor_kind TEXT NOT NULL DEFAULT 'independent'`);
}
// ---- 2026-10-07: negotiation offers (contractor counter-offers, CaliFix-style) ----
db.exec(`CREATE TABLE IF NOT EXISTS contractor_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  proposed_cents INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','superseded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// ---- 2026-10-07: photos.kind CHECK gains 'signoff' (signed close-out sheet) ----
try {
  const psql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='photos'`).get();
  if (psql && psql.sql && !psql.sql.includes("'signoff'")) {
    db.exec(`
      CREATE TABLE photos_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_request_id INTEGER REFERENCES job_requests(id) ON DELETE CASCADE,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        original_name TEXT,
        mime TEXT,
        size_bytes INTEGER,
        width INTEGER,
        height INTEGER,
        kind TEXT NOT NULL DEFAULT 'request' CHECK (kind IN ('request','progress','completion','signoff')),
        vision_json TEXT DEFAULT '{}',
        uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        storage_key TEXT,
        storage_provider TEXT NOT NULL DEFAULT 'local',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO photos_new (id, job_request_id, project_id, filename, original_name, mime, size_bytes, width, height, kind, vision_json, uploaded_by, storage_key, storage_provider, created_at)
        SELECT id, job_request_id, project_id, filename, original_name, mime, size_bytes, width, height, kind, vision_json, uploaded_by, storage_key, storage_provider, created_at
        FROM photos;
      DROP TABLE photos;
      ALTER TABLE photos_new RENAME TO photos;
    `);
    console.log('[migrate] photos table: kind CHECK now includes signoff');
  }
} catch (e) {
  console.error('[migrate] photos table migration failed:', e.message);
}
if (!columnExists('photos', 'storage_key')) {
  db.exec(`ALTER TABLE photos ADD COLUMN storage_key TEXT`);
}
// ---- 2026-10-07: follow-up automation (auto-emailed flag) ----
if (!columnExists('followup_tasks', 'auto_emailed')) {
  db.exec(`ALTER TABLE followup_tasks ADD COLUMN auto_emailed INTEGER NOT NULL DEFAULT 0`);
}
if (!columnExists('photos', 'storage_provider')) {
  db.exec(`ALTER TABLE photos ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'local'`);
}

// ---- Hardening migrations (mirrored for PostgreSQL in src/db/migrations/002_hardening.sql) ----
if (!columnExists('users', 'token_version')) {
  db.exec(`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0`);
}
db.exec(`CREATE TABLE IF NOT EXISTS ai_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('message_reply','dispute_reply')),
  thread_id INTEGER REFERENCES message_threads(id) ON DELETE SET NULL,
  dispute_id INTEGER REFERENCES disputes(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  audience TEXT NOT NULL CHECK (audience IN ('customer','contractor')),
  provider TEXT NOT NULL,
  model TEXT,
  body TEXT NOT NULL,
  flags TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','discarded')),
  final_body TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
if (!columnExists('projects', 'reminder_sent_at')) {
  db.exec(`ALTER TABLE projects ADD COLUMN reminder_sent_at TEXT`);
}
db.exec(`CREATE TABLE IF NOT EXISTS sms_consents (
  phone TEXT PRIMARY KEY,
  opted_in INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  provider TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS visit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed','customer_no_show','contractor_no_show','rescheduled')),
  by_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
if (!columnExists('users', 'totp_enabled')) {
  db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE users ADD COLUMN totp_recovery TEXT`);
}
if (!columnExists('users', 'staff_role')) {
  db.exec(`ALTER TABLE users ADD COLUMN staff_role TEXT`);
}
if (!columnExists('messages', 'flagged')) {
  db.exec(`ALTER TABLE messages ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0`);
}
if (!columnExists('messages', 'flag_reason')) {
  db.exec(`ALTER TABLE messages ADD COLUMN flag_reason TEXT`);
}
if (!columnExists('job_requests', 'lat')) {
  db.exec(`ALTER TABLE job_requests ADD COLUMN lat REAL`);
  db.exec(`ALTER TABLE job_requests ADD COLUMN lng REAL`);
}
if (!columnExists('contractors', 'lat')) {
  db.exec(`ALTER TABLE contractors ADD COLUMN lat REAL`);
  db.exec(`ALTER TABLE contractors ADD COLUMN lng REAL`);
}
if (!columnExists('contractors', 'provider_type')) {
  // 'contractor' = independent (offers, own license/insurance, paid per job); 'employee' = company technician.
  db.exec(`ALTER TABLE contractors ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'contractor' CHECK (provider_type IN ('contractor','employee'))`);
}
db.exec(`CREATE TABLE IF NOT EXISTS email_suppressions (
  email TEXT PRIMARY KEY,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Payment reminders sent to customers (cool-down + audit of who asked for what).
db.exec(`CREATE TABLE IF NOT EXISTS collection_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_collection_reminders_project ON collection_reminders(project_id)`);

// Business events: WHEN things happened (project stage changes, payments confirmed). The KPIs use this for
// accurate completion dates and cycle times; it is also a per-project timeline. Never blocks a flow.
db.exec(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_id INTEGER,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity, entity_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, created_at)`);

// Completion sheet: the customer's signed acceptance of finished work.
db.exec(`CREATE TABLE IF NOT EXISTS completion_sheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  signer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  signer_name TEXT NOT NULL,
  signature_png TEXT NOT NULL,
  checklist_json TEXT,
  notes TEXT,
  ip TEXT,
  signed_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Money owed to contractors: one payable per completed project.
db.exec(`CREATE TABLE IF NOT EXISTS contractor_payables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  payable_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','cancelled')),
  due_at TEXT,
  paid_at TEXT,
  paid_method TEXT,
  paid_reference TEXT,
  paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Disputes: a formal channel for "this work is not right" (customer) or "the customer will not
// approve" (contractor). One open dispute per project, enforced by the partial unique index.
db.exec(`CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  opened_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  opened_by_role TEXT NOT NULL CHECK (opened_by_role IN ('customer','contractor')),
  reason TEXT NOT NULL CHECK (reason IN ('quality','incomplete','no_show','damage','billing','other')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','withdrawn')),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('no_action','rework','partial_refund','full_refund')),
  resolution_notes TEXT,
  refund_cents INTEGER NOT NULL DEFAULT 0,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_dispute_open_per_project ON disputes(project_id) WHERE status IN ('open','investigating')`);
db.exec(`CREATE TABLE IF NOT EXISTS dispute_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_role TEXT NOT NULL CHECK (author_role IN ('customer','contractor','admin')),
  visibility TEXT NOT NULL CHECK (visibility IN ('customer','contractor','staff')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// ---- Corte 2: money (30/70, card on file, Stripe Connect payouts, chargebacks) ----
// Mirrored for PostgreSQL in src/db/migrations/013_money.sql.
db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
if (!columnExists('users', 'stripe_customer_id')) db.exec(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`);
if (!columnExists('contractors', 'stripe_account_id')) db.exec(`ALTER TABLE contractors ADD COLUMN stripe_account_id TEXT`);
if (!columnExists('contractors', 'payouts_enabled')) db.exec(`ALTER TABLE contractors ADD COLUMN payouts_enabled INTEGER NOT NULL DEFAULT 0`);
if (!columnExists('contractors', 'payout_details_submitted')) db.exec(`ALTER TABLE contractors ADD COLUMN payout_details_submitted INTEGER NOT NULL DEFAULT 0`);
if (!columnExists('contractors', 'payout_requirements')) db.exec(`ALTER TABLE contractors ADD COLUMN payout_requirements TEXT`);
if (!columnExists('change_orders', 'contractor_cost_delta_cents')) db.exec(`ALTER TABLE change_orders ADD COLUMN contractor_cost_delta_cents INTEGER NOT NULL DEFAULT 0`);
if (!columnExists('change_orders', 'applied_at')) db.exec(`ALTER TABLE change_orders ADD COLUMN applied_at TEXT`);
if (!columnExists('contractor_payables', 'transfer_id')) db.exec(`ALTER TABLE contractor_payables ADD COLUMN transfer_id TEXT`);
if (!columnExists('contractor_payables', 'reversed_cents')) db.exec(`ALTER TABLE contractor_payables ADD COLUMN reversed_cents INTEGER NOT NULL DEFAULT 0`);
if (!columnExists('projects', 'balance_charge_status')) db.exec(`ALTER TABLE projects ADD COLUMN balance_charge_status TEXT`);
if (!columnExists('projects', 'balance_charge_error')) db.exec(`ALTER TABLE projects ADD COLUMN balance_charge_error TEXT`);
if (!columnExists('projects', 'balance_charge_attempts')) db.exec(`ALTER TABLE projects ADD COLUMN balance_charge_attempts INTEGER NOT NULL DEFAULT 0`);
if (!columnExists('projects', 'cancellation_kind')) db.exec(`ALTER TABLE projects ADD COLUMN cancellation_kind TEXT`);
if (!columnExists('projects', 'cancelled_at')) db.exec(`ALTER TABLE projects ADD COLUMN cancelled_at TEXT`);
// The customer's authorization to charge the remaining balance to the card used for the deposit.
db.exec(`CREATE TABLE IF NOT EXISTS payment_authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  stripe_customer_id TEXT,
  payment_method_id TEXT,
  consent_text_version TEXT NOT NULL,
  ip TEXT,
  authorized_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
)`);
// Card disputes (chargebacks) reported by Stripe: they freeze the pro's payout.
db.exec(`CREATE TABLE IF NOT EXISTS chargebacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  stripe_dispute_id TEXT NOT NULL UNIQUE,
  stripe_charge_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// ---- Corte 3: the visit (arrival, finished work, confirmation) and lifecycle emails ----
// Mirrored for PostgreSQL in src/db/migrations/014_visit.sql.
for (const [col, type] of [['arrived_at', 'TEXT'], ['departed_at', 'TEXT'], ['on_my_way_at', 'TEXT'],
  ['confirm_reminder_sent_at', 'TEXT'], ['confirm_escalated_at', 'TEXT'], ['review_reminder_sent_at', 'TEXT'], ['receipt_sent_at', 'TEXT']]) {
  if (!columnExists('projects', col)) db.exec(`ALTER TABLE projects ADD COLUMN ${col} ${type}`);
}

// ---- Corte 4: CRM Clients (tags, internal notes, client tasks) ----
// Mirrored for PostgreSQL in src/db/migrations/015_crm_clients.sql.
db.exec(`CREATE TABLE IF NOT EXISTS customer_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, tag)
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_customer_tags_tag ON customer_tags(tag)`);
db.exec(`CREATE TABLE IF NOT EXISTS customer_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','email')),
  subject TEXT,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_customer_notes_customer ON customer_notes(customer_id)`);
for (const [col, type] of [['customer_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE'], ['assigned_to', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
  ['created_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'], ['notes', 'TEXT'], ['done_at', 'TEXT']]) {
  if (!columnExists('followup_tasks', col)) db.exec(`ALTER TABLE followup_tasks ADD COLUMN ${col} ${type}`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_followup_tasks_customer ON followup_tasks(customer_id)`);

// ---- Corte 5: CRM Campaigns (saved segments, scheduling, per-recipient results) ----
// Mirrored for PostgreSQL in src/db/migrations/016_campaigns.sql.
db.exec(`CREATE TABLE IF NOT EXISTS crm_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// campaigns: wider status CHECK (scheduled, cancelled) + the composed message and schedule.
// SQLite cannot alter a CHECK, so the table is rebuilt once (foreign keys off so the
// outbox rows that point at it are kept).
try {
  const t = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='campaigns'`).get();
  if (t && t.sql && !t.sql.includes("'scheduled'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE campaigns_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        segment TEXT NOT NULL,
        template_id INTEGER REFERENCES email_templates(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','queued','sending','done','cancelled')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO campaigns_new (id, name, segment, template_id, status, created_at) SELECT id, name, segment, template_id, status, created_at FROM campaigns;
      DROP TABLE campaigns;
      ALTER TABLE campaigns_new RENAME TO campaigns;
    `);
    db.pragma('foreign_keys = ON');
  }
} catch (e) {
  try { db.pragma('foreign_keys = ON'); } catch (_) { /* ignore */ }
  console.error('[migrate] campaigns table migration failed:', e.message);
}
for (const [col, type] of [['segment_id', 'INTEGER REFERENCES crm_segments(id) ON DELETE SET NULL'], ['filters_json', 'TEXT'], ['subject', 'TEXT'],
  ['body_text', 'TEXT'], ['button_label', 'TEXT'], ['button_url', 'TEXT'], ['scheduled_at', 'TEXT'], ['started_at', 'TEXT'], ['completed_at', 'TEXT'],
  ['cancelled_at', 'TEXT'], ['created_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'], ['audience_count', 'INTEGER'], ['test_sent_at', 'TEXT'], ['updated_at', 'TEXT']]) {
  if (!columnExists('campaigns', col)) db.exec(`ALTER TABLE campaigns ADD COLUMN ${col} ${type}`);
}
for (const [col, type] of [['body_text', 'TEXT'], ['button_label', 'TEXT'], ['button_url', 'TEXT']]) {
  if (!columnExists('email_templates', col)) db.exec(`ALTER TABLE email_templates ADD COLUMN ${col} ${type}`);
}
for (const [col, type] of [['delivered_at', 'TEXT'], ['opened_at', 'TEXT'], ['clicked_at', 'TEXT'], ['bounced_at', 'TEXT'], ['unsubscribed_at', 'TEXT'],
  ['open_count', 'INTEGER NOT NULL DEFAULT 0'], ['click_count', 'INTEGER NOT NULL DEFAULT 0'], ['recipient_user_id', 'INTEGER']]) {
  if (!columnExists('email_outbox', col)) db.exec(`ALTER TABLE email_outbox ADD COLUMN ${col} ${type}`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_outbox_campaign ON email_outbox(campaign_id)`);

// ---- Corte 7: automatic deposit reminder bookkeeping ----
// Mirrored for PostgreSQL in src/db/migrations/017_process.sql.
for (const col of ['deposit_reminder_sent_at', 'deposit_escalated_at']) {
  if (!columnExists('projects', col)) db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT`);
}

// ---- Migrate payments.provider CHECK to include 'stripe' (was manual/stripe_stub) ----
// Also adds 'paid' to the status CHECK for Stripe-confirmed payments.
// 2026-10-07: also adds 'simulated' provider for the test payment mode.
try {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'`).get();
  if (sql && sql.sql && (!sql.sql.includes("'stripe'") || !sql.sql.includes("'simulated'"))) {
    db.exec(`
      CREATE TABLE payments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('deposit','milestone','final','refund')),
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','pending','paid','failed')),
        provider TEXT NOT NULL DEFAULT 'manual' CHECK (provider IN ('manual','stripe','simulated')),
        provider_ref TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO payments_new (id, project_id, kind, amount_cents, status, provider, provider_ref, notes, created_at)
        SELECT id, project_id, kind, amount_cents, status,
               CASE WHEN provider = 'stripe_stub' THEN 'manual' ELSE provider END,
               provider_ref, notes, created_at
        FROM payments;
      DROP TABLE payments;
      ALTER TABLE payments_new RENAME TO payments;
    `);
    console.log('[migrate] payments table: provider CHECK now includes stripe, status includes paid');
  }
} catch (e) {
  console.error('[migrate] payments table migration failed:', e.message);
}

module.exports = db;

// ---- Async-compatible API (mirrors src/db/pg.js) ----
// New pattern: await db.transaction(async (t) => { await t.prepare(...).run(...); })
// On SQLite this is best-effort (no multi-statement atomicity); on PostgreSQL
// it is a real transaction.
{
  const asyncDb = {
    _isPg: false,
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        get: async (...p) => stmt.get(...p),
        all: async (...p) => stmt.all(...p),
        run: async (...p) => stmt.run(...p),
      };
    },
    exec: async (sql) => db.exec(sql),
  };
  // Real transaction: BEGIN IMMEDIATE / COMMIT / ROLLBACK, one at a time.
  // LIMIT (single SQLite connection): a write from ANOTHER request that lands
  // while a transaction is awaiting joins that transaction. That is acceptable
  // for tests and low traffic; production must use PostgreSQL (DATABASE_URL),
  // where every transaction owns its own connection.
  let txChain = Promise.resolve();
  db.transaction = (fn) => {
    const run = txChain.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(asyncDb);
        db.exec('COMMIT');
        return result;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
        throw e;
      }
    });
    txChain = run.catch(() => {});
    return run;
  };
}
