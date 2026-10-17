-- v4 第一轮安全加固（ADD COLUMN 幂等说明同 v1；其余 IF NOT EXISTS）
ALTER TABLE orders ADD COLUMN query_token_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN reserved_order_id INTEGER;
ALTER TABLE cards ADD COLUMN reserved_at TEXT;
CREATE INDEX IF NOT EXISTS idx_cards_reserved ON cards(reserved_order_id);
CREATE INDEX IF NOT EXISTS idx_cards_avail ON cards(product_id, is_used, is_disabled, reserved_order_id);
CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, action TEXT NOT NULL DEFAULT '', before_status TEXT NOT NULL DEFAULT '', after_status TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_audit_order ON admin_audit(order_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit(created_at);
CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, blocked_until TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')));
-- 数据修复（条件 UPDATE，幂等）：category=account 的自营商品必须走卡密自动发
UPDATE products SET stock_type='card' WHERE category='account' AND source='self' AND stock_type <> 'card';
