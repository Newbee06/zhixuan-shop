-- 迁移 v11：第十轮（App 图标库（明/暗两版）+ 商品 app_icon_key + 标题自动匹配）
--
-- ⚠️ 本文件为只读镜像，仅供审计与 Schema 对照。权威迁移来源是 src/worker.js 的 MIGRATIONS 数组（见 migrations/README.md）。
-- 不要用 wrangler d1 migrations apply 直接执行本文件，必须经 Worker 的 runMigrations 执行，或先用 GET /api/admin/schema-check 预检。
--
-- 内容：
-- 1. app_icons 表：每 App 两行（light/dark），前端随主题切换；图标为官方 iOS 图标/品牌 Logo 处理后的 160x160 JPEG。
-- 2. products.app_icon_key 列：关联 app_icons.app_key；为空 = 未匹配图标。
-- 3. 种子图标：由 worker.js 的 APP_ICON_SEED 逐行 INSERT OR IGNORE（base64 体积大，不重复进本镜像；以 worker.js 为准）。
--    镜像口径：INSERT OR IGNORE INTO app_icons (app_key, theme, name, image_data) VALUES (<APP_ICON_SEED 行>);
-- 4. 现有商品按标题自动匹配 App 图标（仅当 app_icon_key 为空时；幂等；匹配规则见 worker.js 的 matchAppIconKey）。

CREATE TABLE IF NOT EXISTS app_icons (app_key TEXT NOT NULL, theme TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', image_data TEXT NOT NULL DEFAULT '', PRIMARY KEY (app_key, theme));
ALTER TABLE products ADD COLUMN app_icon_key TEXT NOT NULL DEFAULT '';
-- 种子插入与标题自动匹配由 Worker 的 MIGRATIONS v11 执行（见上），不在本镜像重复展开。

INSERT OR IGNORE INTO schema_migrations (version) VALUES (11);
