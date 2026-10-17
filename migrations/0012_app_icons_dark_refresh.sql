-- 迁移 v12：第十轮补丁（刷新 App 图标暗版：黑底白 Logo / 彩色 Logo 深底）
--
-- ⚠️ 本文件为只读镜像，仅供审计与 Schema 对照。权威迁移来源是 src/worker.js 的 MIGRATIONS 数组（见 migrations/README.md）。
-- 不要用 wrangler d1 migrations apply 直接执行本文件，必须经 Worker 的 runMigrations 执行，或先用 GET /api/admin/schema-check 预检。
--
-- 内容：v11 种子用 INSERT OR IGNORE，已有库的暗版图标不会被新版覆盖；v12 用 UPDATE 把暗版刷为最新种子值。
-- 仅更新 image_data（图标库无后台改名/改图入口，name 恒为种子值）。
-- 暗版新值取自 worker.js 的 APP_ICON_SEED 中 theme='dark' 的行；镜像口径如下（以 worker.js 为准）：

-- UPDATE app_icons SET image_data = <APP_ICON_SEED 暗版行 image_data> WHERE app_key = <app_key> AND theme = 'dark';

INSERT OR IGNORE INTO schema_migrations (version) VALUES (12);
