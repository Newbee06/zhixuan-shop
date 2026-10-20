-- v19（定价模板）：加价倍率 + 固定加价 + 可选控价上下限。
-- 只读镜像：唯一权威来源是 src/worker.js 的 MIGRATIONS v19；不得用 wrangler d1 migrations apply 直接执行。
-- 与全局 upstream_markup / upstream_fixed 并存：未指定模板时导入仍用全局两档。
-- 重新导入不写 sell_price（管理员自定义售价保留）；套用模板是单独的显式操作。
CREATE TABLE IF NOT EXISTS pricing_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  markup REAL NOT NULL DEFAULT 1,
  fixed_add REAL NOT NULL DEFAULT 0,
  price_floor REAL,
  price_ceiling REAL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pricing_templates_active ON pricing_templates(is_active, id);
