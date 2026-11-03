-- 014_visit.sql — Corte 3: visit check-in / check-out and lifecycle email bookkeeping. Mirrors src/db.js.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMP;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS departed_at TIMESTAMP;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS on_my_way_at TIMESTAMP;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS confirm_reminder_sent_at TIMESTAMP;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS confirm_escalated_at TIMESTAMP;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS review_reminder_sent_at TIMESTAMP;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS receipt_sent_at TIMESTAMP;
