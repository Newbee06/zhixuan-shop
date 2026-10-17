-- v5 验证码与下单限流表（IF NOT EXISTS，完全幂等）
CREATE TABLE IF NOT EXISTS captcha_codes (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS order_rate (ip TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_order_rate_ip ON order_rate(ip, created_at);
