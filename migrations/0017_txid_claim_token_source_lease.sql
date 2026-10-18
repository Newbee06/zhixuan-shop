-- 迁移 v17：P1-1/P1-2（TXID 认领令牌化 + 人工/链上共享全局认领）
--
-- ⚠️ 本文件为只读镜像，仅供审计与 Schema 对照。权威迁移来源是 src/worker.js 的 MIGRATIONS 数组（见 migrations/README.md）。
-- 不要用 wrangler d1 migrations apply 直接执行本文件，必须经 Worker 的 runMigrations 执行，或先用 GET /api/admin/schema-check 预检。
--
-- 内容：txid_claims 加 3 列（均为 ADD COLUMN，幂等；旧库真正加列，新库 schema.sql 已含，执行为 no-op）：
--   claim_token TEXT NOT NULL DEFAULT '' —— 每次新认领的密码学安全随机令牌（randomHex(32)），认领行的唯一持有凭证。
--     回滚删除必须在单条条件删除语句中同时匹配 (tx_hash, order_id, claim_token) + 当前订单租约仍属本请求
--     （EXISTS orders.claim_token = 本请求租约）。租约被接管后旧请求回滚条件不再满足，删不掉新请求在用的认领。
--     claim_token 为空 = v17 前遗留认领行，永远不被令牌回滚删除（宁可保留，不冒险释放他人依赖的认领）。
--   source TEXT NOT NULL DEFAULT 'chain_verified' —— 认领来源：'chain_verified'（链上验证通过后认领）
--     或 'manual_confirmed'（管理员系统外核对后人工确认认领）。人工确认与链上确认共享同一 txid_claims
--     全局原子认领（tx_hash 主键），不再另建防重表、不再靠先 SELECT 后 INSERT；胜负由主键唯一约束决定。
--     manual_confirmed 仅表示人工确认，不构成链上证据，不伪造回执/区块高度/确认数。
--   order_lease_token TEXT NOT NULL DEFAULT '' —— 认领时持有者的订单租约令牌（orders.claim_token）。
--     同订单租约接管时新持有者收养认领行（UPDATE order_lease_token = 新租约），旧持有者回滚因租约已变而失败。
-- 现有数据兼容：旧行三列均为默认值，不清空/重建/丢失现有 txid_claims 记录；旧行 source 默认 'chain_verified'
-- （v17 前只有链上路径写 txid_claims，人工路径只写 payments manual_confirmed 行；claimTxid 对遗留人工行有兼容检查）。
-- 顺序语义：fulfillAfterPayment 改为租约-first（先原子获取订单 claim_token 租约，再执行 TXID 全局认领），
-- 未获租约的请求不触碰 TXID 认领；认领失败释放本请求租约（清 paid_at），不触碰认领行；账本失败保留认领、释放租约。

ALTER TABLE txid_claims ADD COLUMN claim_token TEXT NOT NULL DEFAULT '';
ALTER TABLE txid_claims ADD COLUMN source TEXT NOT NULL DEFAULT 'chain_verified';
ALTER TABLE txid_claims ADD COLUMN order_lease_token TEXT NOT NULL DEFAULT '';

INSERT OR IGNORE INTO schema_migrations (version) VALUES (17);
