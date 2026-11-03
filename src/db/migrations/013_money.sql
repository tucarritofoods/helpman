-- 013_money.sql — Corte 2: 30/70 with card on file, Stripe Connect payouts, chargebacks,
-- change orders that move price and payout, cancellation records. Mirrors src/db.js.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS payouts_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS payout_details_submitted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS payout_requirements TEXT;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS contractor_cost_delta_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS applied_at TIMESTAMP;
ALTER TABLE contractor_payables ADD COLUMN IF NOT EXISTS transfer_id TEXT;
ALTER TABLE contractor_payables ADD COLUMN IF NOT EXISTS reversed_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS balance_charge_status TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS balance_charge_error TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS balance_charge_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cancellation_kind TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
CREATE TABLE IF NOT EXISTS payment_authorizations (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  stripe_customer_id TEXT,
  payment_method_id TEXT,
  consent_text_version TEXT NOT NULL,
  ip TEXT,
  authorized_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS chargebacks (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  payment_id BIGINT REFERENCES payments(id) ON DELETE SET NULL,
  stripe_dispute_id TEXT NOT NULL UNIQUE,
  stripe_charge_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','closed')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
