-- 015_crm_clients.sql — Corte 4: CRM Clients (tags, internal notes, client tasks). Mirrors src/db.js.
CREATE TABLE IF NOT EXISTS customer_tags (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_customer_tags_tag ON customer_tags(tag);
CREATE TABLE IF NOT EXISTS customer_notes (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','email')),
  subject TEXT,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_customer_notes_customer ON customer_notes(customer_id);
ALTER TABLE followup_tasks ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE followup_tasks ADD COLUMN IF NOT EXISTS assigned_to BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE followup_tasks ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE followup_tasks ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE followup_tasks ADD COLUMN IF NOT EXISTS done_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_followup_tasks_customer ON followup_tasks(customer_id);
