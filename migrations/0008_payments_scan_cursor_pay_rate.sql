-- 迁移 v8：第四轮（Release Readiness）付款账本 + 扫描游标 + /pay 限流 + 金额/联系人唯一性
--
-- ⚠️ 本文件为只读镜像，仅供审计与 Schema 对照。权威迁移来源是 src/worker.js 的 MIGRATIONS 数组（见 migrations/README.md）。
-- 不要用 wrangler d1 migrations apply 直接执行本文件：部分语句在已有重复数据的旧库上会失败（如唯一索引），
-- 必须经 Worker 的 runMigrations（带幂等检查与失败不标记版本）执行，或先用 GET /api/admin/schema-check 预检。
--
-- 内容：
-- 1. payments 付款账本（独立记录每一笔链上付款事件，状态机 submitted→discovered→verified→confirmed→posted，异常 duplicate/mismatch/unmatched/reconciled）
-- 2. scan_cursors 链上扫描游标（每链已扫描区块高度，持久化）
-- 3. pay_rate /pay 独立限流
-- 4. idx_orders_amount_claim：金额部分唯一索引（仅待付款订单）
-- 5. idx_orders_contact_pending：联系人去重部分唯一索引（仅待付款且 contact 非空）
--
-- 注意：若旧库已有重复待付款金额，建 idx_orders_amount_claim 会失败，迁移不标记版本，需先手动处理重复订单（见 docs/RELEASE_READINESS.md 预检）。

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  chain TEXT NOT NULL DEFAULT '',
  asset TEXT NOT NULL DEFAULT 'USDT',
  pay_address TEXT NOT NULL DEFAULT '',
  tx_hash TEXT NOT NULL DEFAULT '',
  event_key TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  amount_unit TEXT NOT NULL DEFAULT 'USDT',
  block_number INTEGER,
  confirmations INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'submitted',
  reconcile_status TEXT NOT NULL DEFAULT '',
  reconcile_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_event_unique ON payments(chain, tx_hash, event_key);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_txhash ON payments(tx_hash);

CREATE TABLE IF NOT EXISTS scan_cursors (
  chain TEXT PRIMARY KEY,
  last_block INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pay_rate (
  key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pay_rate_key ON pay_rate(key, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_amount_claim ON orders(pay_address, actual_amount) WHERE status = 'pending_payment';
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_contact_pending ON orders(contact, product_id) WHERE status = 'pending_payment' AND contact != '';

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('prodseller_enabled', '0'),
  ('turnstile_enabled', '0'),
  ('turnstile_site_key', ''),
  ('chain_confirmations', '{"X Layer":1,"ERC20":12,"BEP20":15,"TRC20":19}');
