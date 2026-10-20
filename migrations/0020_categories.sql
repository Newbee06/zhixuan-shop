-- v20（商品分类目录）：扁平列表，内置代充 / 成品号 / 卡密。
-- 只读镜像：唯一权威来源是 src/worker.js 的 MIGRATIONS v20；不得用 wrangler d1 migrations apply 直接执行。
-- INSERT OR IGNORE：已改过显示名或停用状态的内置分类不会被迁移重置（迁移本身只跑一次）。
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cat_key TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_key ON categories(cat_key);
INSERT OR IGNORE INTO categories (cat_key, name, is_active, sort) VALUES ('recharge', '代充', 1, 10);
INSERT OR IGNORE INTO categories (cat_key, name, is_active, sort) VALUES ('account', '成品号', 1, 20);
INSERT OR IGNORE INTO categories (cat_key, name, is_active, sort) VALUES ('card', '卡密', 1, 30);
