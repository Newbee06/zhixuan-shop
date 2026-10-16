-- v1 订单轮询字段（幂等：重复执行不报错、不破坏数据）
-- 对应 worker.js MIGRATIONS v1。SQLite 不支持 IF NOT EXISTS 加列，需由 Worker 的 addColumnIfMissing 做 PRAGMA 检查后执行；
-- 本文件供审计与 wrangler d1 migrations apply 使用，执行前请确认列不存在（重复 ADD COLUMN 会报错，但不破坏数据）。
ALTER TABLE orders ADD COLUMN actual_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN pay_address TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN expires_at TEXT;
ALTER TABLE orders ADD COLUMN last_checked_at TEXT;
ALTER TABLE orders ADD COLUMN tx_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_orders_actual ON orders(pay_address, actual_amount, status);
CREATE INDEX IF NOT EXISTS idx_orders_txhash ON orders(tx_hash);
CREATE INDEX IF NOT EXISTS idx_orders_expires ON orders(status, expires_at);
