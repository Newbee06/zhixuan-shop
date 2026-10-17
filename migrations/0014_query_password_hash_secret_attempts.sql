-- 迁移 v14：查单改 aisou.pro 方向（买家自设查询密码（只存哈希）+ 按单密码取卡密）
--
-- ⚠️ 本文件为只读镜像，仅供审计与 Schema 对照。权威迁移来源是 src/worker.js 的 MIGRATIONS 数组（见 migrations/README.md）。
-- 不要用 wrangler d1 migrations apply 直接执行本文件，必须经 Worker 的 runMigrations 执行，或先用 GET /api/admin/schema-check 预检。
--
-- 内容：
-- 1. orders.query_password_hash 列：买家下单时自设的查询密码的哈希（绝不存明文）。空 = 未设密码。
--    旧订单兼容：query_password（旧明文密码）与 query_token_hash（旧系统凭证）保留，老路径继续可用。
--    注意：v14 的哈希为 SHA-256；v15 起改为 salt + PBKDF2（见 0015）。
-- 2. secret_attempts 表：按单密码取卡密的尝试记录（order_no + ip + 时间），防针对单订单的密码爆破。

ALTER TABLE orders ADD COLUMN query_password_hash TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS secret_attempts (order_no TEXT NOT NULL, ip TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_secret_attempts_order ON secret_attempts(order_no, created_at);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (14);
