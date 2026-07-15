-- Beauty OS — Migration 005: Flexible Pricing Settings
-- Run: sudo -u postgres psql -d beauty_os -f migrations/005_pricing_settings.sql

-- ─── 1. App Settings (key-value store for admin-managed settings) ─────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 2. Seed default pricing ─────────────────────────────────────────────────
INSERT INTO app_settings (key, value, description) VALUES

-- Main plan (one-time)
('plan_main', '{
  "name": "AI Business Builder",
  "type": "one_time",
  "duration_months": 3,
  "active": true,
  "prices": {
    "UAH": 2999,
    "EUR": 59,
    "KZT": 13000,
    "PLN": 249,
    "AED": 220
  }
}', 'Основной план — разовая оплата, доступ 3 месяца'),

-- Bot plan Про (monthly)
('plan_bot_pro', '{
  "name": "AI-директор Про",
  "type": "monthly",
  "active": true,
  "features": ["daily_report", "weekly_report", "alerts", "1_recipient"],
  "prices": {
    "UAH": 999,
    "EUR": 19,
    "KZT": 4500,
    "PLN": 79,
    "AED": 70
  }
}', 'AI-директор Про — ежедневные и еженедельные отчёты, 1 получатель'),

-- Bot plan Команда (monthly)
('plan_bot_team', '{
  "name": "AI-директор Команда",
  "type": "monthly",
  "active": true,
  "features": ["daily_report", "weekly_report", "monthly_report", "alerts", "custom_alerts", "5_recipients", "interactive_bot"],
  "prices": {
    "UAH": 1999,
    "EUR": 39,
    "KZT": 9000,
    "PLN": 159,
    "AED": 140
  }
}', 'AI-директор Команда — все отчёты, 5 получателей, интерактивный бот'),

-- Countries config
('countries_config', '{
  "supported": ["Украина", "Казахстан", "Польша", "Испания", "Германия", "ОАЭ", "Чехия"],
  "bot_available": ["Украина", "Казахстан", "Польша", "Германия"],
  "csv_available": ["Испания", "ОАЭ", "Чехия"],
  "currency_map": {
    "Украина": "UAH",
    "Казахстан": "KZT",
    "Польша": "PLN",
    "Испания": "EUR",
    "Германия": "EUR",
    "ОАЭ": "AED",
    "Чехия": "EUR"
  }
}', 'Список поддерживаемых стран и доступность функций'),

-- Promo codes
('promo_codes', '{}', 'Активные промокоды: {"CODE": {"discount_pct": 20, "plan": "all", "expires": "2025-12-31", "max_uses": 100, "uses": 0}}'),

-- Trial settings
('trial_settings', '{
  "bot_trial_days": 7,
  "trial_active": true
}', 'Настройки пробного периода')

ON CONFLICT (key) DO NOTHING;

-- ─── 3. Promo codes table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT UNIQUE NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'all',   -- 'all' | 'plan_main' | 'plan_bot_pro' | 'plan_bot_team'
  discount_type TEXT NOT NULL DEFAULT 'percent' CHECK (discount_type IN ('percent','fixed')),
  discount_value NUMERIC(10,2) NOT NULL,
  currency    TEXT,                           -- for fixed discounts: which currency
  max_uses    INT,                            -- NULL = unlimited
  uses_count  INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 4. Promo code uses log ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_uses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id    UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan        TEXT NOT NULL,
  discount_applied NUMERIC(10,2),
  used_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (promo_id, user_id)   -- one use per user per code
);

-- ─── 5. Indexes ──────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_promo_codes_code   ON promo_codes(code);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_promo_codes_active ON promo_codes(active);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_promo_uses_user    ON promo_uses(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_promo_uses_promo   ON promo_uses(promo_id);

-- ─── 6. Verify ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  settings_count INT;
BEGIN
  SELECT COUNT(*) INTO settings_count FROM app_settings;
  ASSERT settings_count >= 5, 'app_settings not seeded properly';
  ASSERT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'promo_codes'), 'promo_codes missing';
  RAISE NOTICE 'Migration 005 OK — pricing settings seeded (% rows)', settings_count;
END $$;
