-- Beauty OS — Migration 004: Integrations + Telegram Bot + Cached Metrics
-- Run: sudo -u postgres psql -d beauty_os -f migrations/004_integrations_and_bot.sql

-- ─── 1. CRM Integrations ─────────────────────────────────────────────────────
-- Stores connection credentials for each CRM/booking system
CREATE TABLE IF NOT EXISTS integrations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service     TEXT NOT NULL,  -- 'dikidi' | 'yclients' | 'poster' | 'booksy' | 'timify' | 'shore' | 'simplybook' | 'manual' | 'fresha_csv' | 'treatwell_csv'
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','error')),
  -- API-key based (DIKIDI, Yclients, Booksy, etc.)
  api_key     TEXT,           -- encrypted at app level before storing
  api_secret  TEXT,           -- for services that need secret
  company_id  TEXT,           -- company/salon ID in external system
  extra       JSONB,          -- service-specific config (branch_id, timezone, etc.)
  -- CSV upload based (Fresha, Treatwell)
  last_csv_at TIMESTAMPTZ,    -- when last CSV was uploaded
  last_csv_period TEXT,       -- e.g. '2025-07' — which month the CSV covers
  -- Status tracking
  last_sync_at   TIMESTAMPTZ,
  last_error     TEXT,
  error_count    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, service)
);

-- ─── 2. Cached Metrics ───────────────────────────────────────────────────────
-- Stores parsed/fetched data from CRM per day
-- AI uses this for reports without hitting external APIs every time
CREATE TABLE IF NOT EXISTS cached_metrics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  source      TEXT NOT NULL,  -- which integration provided this data
  metrics     JSONB NOT NULL DEFAULT '{}',
  -- Snapshot of key metrics for quick queries:
  revenue     NUMERIC(12,2),  -- total revenue for this day
  visits      INT,            -- number of appointments
  avg_check   NUMERIC(10,2),  -- average check
  new_clients INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, date)      -- one record per user per day
);

-- ─── 3. Manual Data Entry ────────────────────────────────────────────────────
-- For countries/users without CRM integration
CREATE TABLE IF NOT EXISTS manual_metrics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period      TEXT NOT NULL,  -- 'YYYY-MM' for monthly, 'YYYY-WW' for weekly
  period_type TEXT NOT NULL DEFAULT 'month' CHECK (period_type IN ('day','week','month')),
  data        JSONB NOT NULL DEFAULT '{}',
  -- Quick-access columns:
  revenue     NUMERIC(12,2),
  visits      INT,
  avg_check   NUMERIC(10,2),
  new_clients INT,
  return_rate NUMERIC(5,2),  -- retention %
  fot_pct     NUMERIC(5,2),  -- payroll as % of revenue
  materials_pct NUMERIC(5,2),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, period, period_type)
);

-- ─── 4. Telegram Bot Subscriptions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  -- Subscription status
  plan            TEXT NOT NULL DEFAULT 'inactive' CHECK (plan IN ('inactive','active','trial')),
  trial_ends_at   TIMESTAMPTZ,
  sub_expires_at  TIMESTAMPTZ,
  -- Payment
  monthly_price   NUMERIC(10,2),
  currency        TEXT DEFAULT 'UAH',
  -- Report schedule settings
  daily_enabled   BOOLEAN NOT NULL DEFAULT true,
  daily_time      TIME NOT NULL DEFAULT '20:00',    -- local time
  weekly_enabled  BOOLEAN NOT NULL DEFAULT true,
  weekly_day      INT NOT NULL DEFAULT 5,           -- 5 = Friday
  weekly_time     TIME NOT NULL DEFAULT '18:00',
  monthly_enabled BOOLEAN NOT NULL DEFAULT true,
  monthly_day     INT NOT NULL DEFAULT 1,           -- 1st of month
  monthly_time    TIME NOT NULL DEFAULT '09:00',
  -- Alert settings
  alerts_enabled  BOOLEAN NOT NULL DEFAULT true,
  alert_load_threshold  INT NOT NULL DEFAULT 50,    -- alert if daily load < 50%
  alert_revenue_drop    INT NOT NULL DEFAULT 30,    -- alert if revenue drops > 30%
  alert_cancellations   INT NOT NULL DEFAULT 3,     -- alert if 3+ cancellations
  -- Timezone
  timezone        TEXT NOT NULL DEFAULT 'Europe/Kiev',
  -- Metadata
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 5. Telegram Recipients ──────────────────────────────────────────────────
-- Multiple people can receive reports for one salon
CREATE TABLE IF NOT EXISTS bot_recipients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id         BIGINT NOT NULL,        -- Telegram chat_id
  telegram_username TEXT,
  display_name    TEXT,
  role            TEXT DEFAULT 'owner' CHECK (role IN ('owner','manager','admin')),
  -- What this recipient receives
  receives_daily   BOOLEAN NOT NULL DEFAULT true,
  receives_weekly  BOOLEAN NOT NULL DEFAULT true,
  receives_monthly BOOLEAN NOT NULL DEFAULT true,
  receives_alerts  BOOLEAN NOT NULL DEFAULT true,
  -- Status
  is_active       BOOLEAN NOT NULL DEFAULT true,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ,
  UNIQUE (user_id, chat_id)
);

-- ─── 6. Report Log ───────────────────────────────────────────────────────────
-- Track what was sent, when, to whom
CREATE TABLE IF NOT EXISTS bot_report_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id     BIGINT NOT NULL,
  report_type TEXT NOT NULL CHECK (report_type IN ('daily','weekly','monthly','alert','interactive')),
  period_date DATE,           -- which date/period this report covers
  status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','skipped')),
  error       TEXT,
  tokens_used INT,            -- Claude API tokens consumed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 7. Add bot subscription flag to profiles ────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS has_bot_access  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bot_expires_at  TIMESTAMPTZ;

-- ─── 8. Indexes ──────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_integrations_user     ON integrations(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_integrations_service  ON integrations(service);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_integrations_status   ON integrations(status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cached_metrics_user   ON cached_metrics(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cached_metrics_date   ON cached_metrics(user_id, date DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_manual_metrics_user   ON manual_metrics(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_manual_period         ON manual_metrics(user_id, period_type, period);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bot_subs_user         ON bot_subscriptions(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bot_subs_plan         ON bot_subscriptions(plan);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bot_recipients_user   ON bot_recipients(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bot_recipients_chat   ON bot_recipients(chat_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bot_log_user          ON bot_report_log(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bot_log_created       ON bot_report_log(created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_bot_access   ON profiles(has_bot_access);

-- ─── 9. Auto-update triggers ─────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'integrations_updated_at') THEN
    CREATE TRIGGER integrations_updated_at
      BEFORE UPDATE ON integrations
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'manual_metrics_updated_at') THEN
    CREATE TRIGGER manual_metrics_updated_at
      BEFORE UPDATE ON manual_metrics
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bot_subs_updated_at') THEN
    CREATE TRIGGER bot_subs_updated_at
      BEFORE UPDATE ON bot_subscriptions
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- ─── 10. Verify ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  ASSERT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'integrations'),    'integrations missing';
  ASSERT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cached_metrics'),  'cached_metrics missing';
  ASSERT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'manual_metrics'),  'manual_metrics missing';
  ASSERT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bot_subscriptions'), 'bot_subscriptions missing';
  ASSERT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bot_recipients'),  'bot_recipients missing';
  ASSERT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bot_report_log'),  'bot_report_log missing';
  RAISE NOTICE 'Migration 004 OK — 6 tables created';
END $$;

-- ─── 10. Bot link tokens (for /start?token=xxx) ───────────────────────────────
CREATE TABLE IF NOT EXISTS bot_link_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bot_link_tokens_token ON bot_link_tokens(token);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bot_link_tokens_user  ON bot_link_tokens(user_id);
