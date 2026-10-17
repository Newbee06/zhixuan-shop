-- 迁移 v13：第十轮补丁2（刷新 App 图标暗版：Telegram 泛洪填充去白底）
--
-- ⚠️ 本文件为只读镜像，仅供审计与 Schema 对照。权威迁移来源是 src/worker.js 的 MIGRATIONS 数组（见 migrations/README.md）。
-- 不要用 wrangler d1 migrations apply 直接执行本文件，必须经 Worker 的 runMigrations 执行，或先用 GET /api/admin/schema-check 预检。
--
-- 内容：种子暗版再次变更（Telegram）时，v12 已标记已应用不会重跑；v13 重新执行同一 UPDATE，把全部暗版刷为当前种子值。
-- 以后每次种子暗版变更，都须追加新迁移版本重刷（已应用的迁移不重跑）。
-- 暗版新值取自 worker.js 的 APP_ICON_SEED 中 theme='dark' 的行；镜像口径如下（以 worker.js 为准）：

-- UPDATE app_icons SET image_data = <APP_ICON_SEED 暗版行 image_data> WHERE app_key = <app_key> AND theme = 'dark';

INSERT OR IGNORE INTO schema_migrations (version) VALUES (13);
