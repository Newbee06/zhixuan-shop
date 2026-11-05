-- 0021 镜像（只读镜像，唯一权威来源是 src/worker.js 的 MIGRATIONS v21；不得用 wrangler d1 migrations apply 直接执行，见 migrations/README.md）
-- txid_claims 加 order_id 索引（按订单查认领）。幂等、可重试；失败不标记版本。
CREATE INDEX IF NOT EXISTS idx_txid_claims_order ON txid_claims(order_id);
