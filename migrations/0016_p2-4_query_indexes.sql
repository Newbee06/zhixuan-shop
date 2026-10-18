-- 迁移 v16：P2-4（补 6 个查询索引：idx_cards_product、idx_cards_used、idx_orders_no、idx_orders_status、idx_orders_created、idx_sessions_expires）
--
-- ⚠️ 本文件为只读镜像，仅供审计与 Schema 对照。权威迁移来源是 src/worker.js 的 MIGRATIONS 数组（见 migrations/README.md）。
-- 不要用 wrangler d1 migrations apply 直接执行本文件，必须经 Worker 的 runMigrations 执行，或先用 GET /api/admin/schema-check 预检。
--
-- 内容：核对结论（2026-10-18）——schema.sql（新库建库脚本）已含这 6 个索引；MIGRATIONS v1–v15 均未建它们，
-- 故经迁移升级的旧库缺失这 6 个索引，新库不缺。v16 只补真缺失的 6 个，不改历史迁移。
-- 均为非唯一普通索引，CREATE INDEX IF NOT EXISTS 幂等，已有索引的库执行为 no-op；
-- 不删历史订单/账本/卡密，不加 claim_token 列（认领仍用 created + claimed_at 持有者戳）。
-- 调用点：orders 按 order_no 查单、按 status 扫待付款、按 created_at 倒序查单；
-- cards 按 product_id/is_used 统计与分配；sessions 按 expires_at 清理过期会话。
-- 注意：schema-check（precheckSchema）对这 6 个索引的覆盖由后端/协调人另行补（本文件与 Worker MIGRATIONS 分区约束：
-- 文档/迁移负责人只追加 MIGRATIONS 条目，不改 worker.js 其他逻辑；见本轮整改报告 P2-4 残余项）。

CREATE INDEX IF NOT EXISTS idx_cards_product ON cards(product_id);
CREATE INDEX IF NOT EXISTS idx_cards_used ON cards(product_id, is_used, is_disabled);
CREATE INDEX IF NOT EXISTS idx_orders_no ON orders(order_no);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (16);
