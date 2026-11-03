-- 016_campaigns.sql — Corte 5: CRM Campaigns (saved segments, scheduling, per-recipient results). Mirrors src/db.js.
CREATE TABLE IF NOT EXISTS crm_segments (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check CHECK (status IN ('draft','scheduled','queued','sending','done','cancelled'));
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS segment_id BIGINT REFERENCES crm_segments(id) ON DELETE SET NULL;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS filters_json TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS body_text TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS button_label TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS button_url TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS started_at TIMESTAMP;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_count INTEGER;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS test_sent_at TIMESTAMP;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS body_text TEXT;
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS button_label TEXT;
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS button_url TEXT;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMP;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMP;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMP;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS open_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS click_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS recipient_user_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_outbox_campaign ON email_outbox(campaign_id);
