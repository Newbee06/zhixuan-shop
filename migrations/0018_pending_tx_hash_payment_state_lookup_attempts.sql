-- v18（资金安全，2026-10-18）：orders.pending_tx_hash（未核验候选 TXID）+ payment_state（超额付款态）+ lookup_attempts（/lookup 按单记数）。
-- 只读镜像：唯一权威来源是 src/worker.js 的 MIGRATIONS v18；不得用 wrangler d1 migrations apply 直接执行。
-- 语义：
--   orders.pending_tx_hash：用户提交的未核验候选 TXID。orders.tx_hash 只代表已消费（已取得全局消费权）TXID，
--     候选绝不直接写 tx_hash；认领成功后 tx_hash 才填第一笔已消费 TXID，pending 清空。
--   orders.payment_state：''（正常）/ 'overpaid_pending'（已有入账付款后又收到第二笔真实付款，待人工对账/退款，
--     不重复发货）。清除路径：管理员在 /api/admin/payments/:id/reconcile 对账该笔超额付款为 reconciled 后，
--     若本订单无其他 overpaid_pending 账本行，payment_state 清空。
--   lookup_attempts：/lookup 按单原子记数（与 /secret 的 secret_attempts 同口径：5 次/10 分钟，成功后清零）。
ALTER TABLE orders ADD COLUMN pending_tx_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN payment_state TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS lookup_attempts (order_no TEXT NOT NULL, ip TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_lookup_attempts_order ON lookup_attempts(order_no, created_at);
