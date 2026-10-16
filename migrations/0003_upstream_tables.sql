-- v3 上游订单与缓存表（IF NOT EXISTS，完全幂等）
CREATE TABLE IF NOT EXISTS upstream_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, prodseller_order_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0, delivered_keys TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY(order_id) REFERENCES orders(id));
CREATE INDEX IF NOT EXISTS idx_upstream_orders_order ON upstream_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_upstream_orders_psid ON upstream_orders(prodseller_order_id);
CREATE TABLE IF NOT EXISTS upstream_cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '', fetched_at TEXT NOT NULL DEFAULT (datetime('now')));
