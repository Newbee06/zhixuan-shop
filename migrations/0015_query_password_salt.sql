-- 迁移 v15：P0（查询密码必填 + 随机 salt PBKDF2 + 移除邮箱查询）
--
-- ⚠️ 本文件为只读镜像，仅供审计与 Schema 对照。权威迁移来源是 src/worker.js 的 MIGRATIONS 数组（见 migrations/README.md）。
-- 不要用 wrangler d1 migrations apply 直接执行本文件，必须经 Worker 的 runMigrations 执行，或先用 GET /api/admin/schema-check 预检。
--
-- 内容：orders.query_password_salt 列：每订单随机 16 字节 salt（base64），与 hashPassword（PBKDF2 100000 次）配对。
-- salt 为空 + hash 非空 = v14 遗留无 salt 哈希（仅 staging 测试订单），按 legacy 处理（仅管理员流程，不走 /secret）。

ALTER TABLE orders ADD COLUMN query_password_salt TEXT NOT NULL DEFAULT '';

INSERT OR IGNORE INTO schema_migrations (version) VALUES (15);
