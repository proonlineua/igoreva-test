-- Beauty OS — Admin Panel Migration
-- Run: sudo -u postgres psql -d beauty_os -f migrations/002_admin_columns.sql

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_created_at ON payments(created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_status_created ON payments(status, created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_created_at ON users(created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_docs_created_at ON generated_documents(created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_analyses_created_at ON audit_analyses(created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_has_access ON profiles(has_access);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_is_admin ON profiles(is_admin);
