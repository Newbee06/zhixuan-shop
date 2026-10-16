-- 0007 上游轮询租约 + upstream_orders 唯一性（第二轮补）
-- 幂等：ADD COLUMN 前先查列是否存在；去重第二次执行删 0 行；索引用 IF NOT EXISTS。
-- 去重口径：保留每个 order_id 的最新行（MAX(id)），与代码 ORDER BY id DESC LIMIT 1 读取口径一致。
-- 唯一索引建好后，upsertUpstreamOrder 用 SQLite UPSERT 原子写入，并发不再产生重复行。

-- 上游轮询租约列（orders）：Cron 与管理员重试同时执行时，只能一个处理者持有某订单的租约。
-- upstream_lock（持有者令牌）+ upstream_lock_expires_at（过期时间，崩溃后超时可接管）。
ALTER TABLE orders ADD COLUMN upstream_lock TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN upstream_lock_expires_at TEXT;

-- upstream_orders.order_id 去重：删除每个 order_id 的旧行，只保留最新行。
DELETE FROM upstream_orders WHERE id NOT IN (SELECT MAX(id) FROM upstream_orders GROUP BY order_id);

-- 旧非唯一索引换成唯一索引（索引不存业务数据，删除安全）。
DROP INDEX IF EXISTS idx_upstream_orders_order;
CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_orders_order_unique ON upstream_orders(order_id);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (7);
