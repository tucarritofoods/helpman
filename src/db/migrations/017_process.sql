-- 017_process.sql — Corte 7: automatic deposit reminder bookkeeping. Mirrors src/db.js.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deposit_reminder_sent_at TIMESTAMP;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deposit_escalated_at TIMESTAMP;
