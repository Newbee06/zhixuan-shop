-- 迁移 v9：第六轮（金额唯一索引排除 BinanceUID）
--
-- ⚠️ 本文件为只读镜像，仅供审计与 Schema 对照。权威迁移来源是 src/worker.js 的 MIGRATIONS 数组（见 migrations/README.md）。
-- 不要用 wrangler d1 migrations apply 直接执行本文件，必须经 Worker 的 runMigrations 执行，或先用 GET /api/admin/schema-check 预检。
--
-- 内容：BinanceUID 订单无链上地址（pay_address=''）且金额=总价无随机尾数，v8 的部分唯一索引
-- (pay_address, actual_amount) WHERE status='pending_payment' 会把所有同金额待付款 BinanceUID 订单误判为金额冲突，
-- 下单代码对 BinanceUID 唯一冲突直接 throw，导致 500。BinanceUID 走管理员手动核对，不靠链上 (地址,金额) 匹配，故从索引条件中排除。
-- 旧索引约束更严（已包含 BinanceUID），数据一定满足新条件，DROP 后重建不会失败。

DROP INDEX IF EXISTS idx_orders_amount_claim;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_amount_claim ON orders(pay_address, actual_amount) WHERE status = 'pending_payment' AND pay_method != 'BinanceUID';

INSERT OR IGNORE INTO schema_migrations (version) VALUES (9);
