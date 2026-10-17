-- v6 第二轮：订单认领 / TXID 认领 / 异常退款 / 查单限流（ADD COLUMN 幂等说明同 v1；其余 IF NOT EXISTS）
ALTER TABLE orders ADD COLUMN claim_token TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN claimed_at TEXT;
ALTER TABLE orders ADD COLUMN exception_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN refund_status TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN refund_ref TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_orders_claim ON orders(claim_token);
CREATE TABLE IF NOT EXISTS txid_claims (tx_hash TEXT PRIMARY KEY, order_id INTEGER NOT NULL, claimed_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS lookup_rate (ip TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_lookup_rate_ip ON lookup_rate(ip, created_at);
