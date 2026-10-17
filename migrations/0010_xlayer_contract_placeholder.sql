-- 迁移 v10：第九轮（X Layer 合约占位符替换为核实的 USDT0 合约，仅精确占位符）
--
-- ⚠️ 本文件为只读镜像，仅供审计与 Schema 对照。权威迁移来源是 src/worker.js 的 MIGRATIONS 数组（见 migrations/README.md）。
-- 不要用 wrangler d1 migrations apply 直接执行本文件，必须经 Worker 的 runMigrations 执行，或先用 GET /api/admin/schema-check 预检。
--
-- 内容：种子/旧配置里的 X Layer 合约占位符 0xYOUR_XLAYER_USDT_CONTRACT 会覆盖代码默认值且格式非法，
-- 导致 X Layer 核验 fail-closed（永远不认账）。仅替换精确占位符为核实的 USDT0 合约；
-- 管理员已显式配置的任何其他合约一律不动（保留显式配置能力）。

UPDATE settings SET value = REPLACE(value, '"X Layer":"0xYOUR_XLAYER_USDT_CONTRACT"', '"X Layer":"0x779Ded0c9e1022225f8E0630b35a9b54bE713736"') WHERE key = 'usdt_contracts' AND value LIKE '%0xYOUR_XLAYER_USDT_CONTRACT%';

INSERT OR IGNORE INTO schema_migrations (version) VALUES (10);
