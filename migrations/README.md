# 数据库迁移说明

## 唯一权威来源（第四轮 D-01 整改）

**`src/worker.js` 的 `MIGRATIONS` 数组是唯一权威迁移来源。**

- `migrations/*.sql` 是只读镜像，仅供审计与 Schema 对照，**不得**用 `wrangler d1 migrations apply` 直接执行。
  原因：SQLite 的 `ALTER TABLE ADD COLUMN` 不支持 `IF NOT EXISTS`；部分迁移含去重/数据修复与失败不标记版本语义，
  文件版无法完整表达；0001–0006 不写版本记录，与内嵌迁移不互通（旧问题，已废止该用法）。
- `schema.sql` 是新库建表脚本（已含全部终态表结构 + 预置 v1–v10），新库直接用它建库，不跑迁移。
- 旧库升级只走 Worker 的 `runMigrations`（幂等、失败不标记版本、下次重试）。

禁止长期依赖人工同步两套迁移。新增迁移时只改 `MIGRATIONS` 数组，同时更新本目录的镜像文件与 `schema.sql`，并在 PR 中说明。

## 执行方式

### 方式 A：Worker 自动迁移（默认，推荐）

Worker 每次 API 请求 / 定时任务先做轻量版本检查（`SELECT MAX(version) FROM schema_migrations`）。
版本落后时才执行 `runMigrations`（见 `src/worker.js` 的 `MIGRATIONS`），逐个版本 apply，成功才标记版本。
失败时返回明确的版本号与原因，不伪装成功。并发请求同时迁移时，版本标记用 `INSERT OR IGNORE`，避免唯一冲突。

- 新库：直接用 `schema.sql`（已含全部列/表，且预置 v1–v10），不跑迁移。
- 旧库：部署新版 Worker 后首次请求自动升级，幂等、可重试。

管理员也可显式触发：`POST /api/admin/migrate`（返回本次应用的版本），或查询状态：`GET /api/admin/migrate`。

### 预检（第四轮新增，部署前必跑）

`GET /api/admin/schema-check`（只读，不改数据）：校验实际 Schema 是否与目标版本一致——
表、列、索引、关键唯一约束（`idx_upstream_orders_order_unique`、`idx_payments_event_unique`、
`idx_orders_amount_claim`、`idx_orders_contact_pending`）、重复待付款金额。

版本号与 Schema 内容不一致时报告差异，不得静默放行。预检有问题时先按 `docs/RELEASE_READINESS.md` 修复，再部署。

## 版本总览

| 版本 | 内容 |
|---|---|
| v1 | 订单轮询字段（actual_amount / pay_address / expires_at / last_checked_at / tx_hash）+ 索引 |
| v2 | 商品上游字段（source / prodseller_id / cost_price / sell_price / requires_email_activation / delivery_method / image_data / in_stock）+ sell_price 回填 |
| v3 | 上游订单与缓存表 |
| v4 | 第一轮安全加固（query_token_hash / 卡密预留列 / admin_audit / login_attempts / category=account 数据修复） |
| v5 | 验证码与下单限流表 |
| v6 | 第二轮（claim_token / claimed_at / exception_reason / refund_status / refund_ref / txid_claims / lookup_rate） |
| v7 | 第二轮补（上游轮询租约列 upstream_lock / upstream_lock_expires_at；upstream_orders.order_id 去重 + 唯一索引） |
| v8 | 第四轮（payments 付款账本 + scan_cursors 扫描游标 + pay_rate /pay 限流 + 金额/联系人部分唯一索引 + ProdSeller/Turnstile/确认数设置默认值） |
| v9 | 第六轮（金额唯一索引排除 BinanceUID：DROP 后重建 `idx_orders_amount_claim`，条件加 `pay_method != 'BinanceUID'`） |
| v10 | 第九轮（X Layer 合约占位符替换为核实的 USDT0 合约，仅精确占位符；管理员显式配置不动） |
| v11 | 第十轮（App 图标库 `app_icons`（明/暗两版）+ `products.app_icon_key` + 标题自动匹配；种子在 `worker.js` 的 `APP_ICON_SEED`） |
| v12 | 第十轮补丁（刷新 App 图标暗版：黑底白 Logo / 彩色 Logo 深底） |
| v13 | 第十轮补丁 2（再次刷新 App 图标暗版：Telegram 泛洪填充去白底） |
| v14 | 查单改 aisou.pro 方向（`orders.query_password_hash` + `secret_attempts` 按单取卡密尝试记录） |
| v15 | P0（查询密码必填 + 随机 salt PBKDF2 + 移除邮箱查询：`orders.query_password_salt`） |
| v16 | P2-4（补 6 个查询索引：`idx_cards_product`、`idx_cards_used`、`idx_orders_no`、`idx_orders_status`、`idx_orders_created`、`idx_sessions_expires`；仅补 MIGRATIONS v1–v15 真缺失的，schema.sql 新库已含，`IF NOT EXISTS` 幂等；不删历史数据，不加 claim_token 列） |
| v17 | P1-1/P1-2（`txid_claims` 加 `claim_token`（每次新认领的密码学安全随机令牌；无回滚删除入口，已消费认领永久保留）+ `source`（`chain_verified` / `manual_confirmed`，人工与链上共享同一全局原子认领）+ `order_lease_token`（认领时持有者的订单租约，接管时收养更新）；`ADD COLUMN` 幂等，旧库真正加列、新库 schema.sql 已含为 no-op；现有认领记录保留，旧行三列为默认值） |
| v18 | 资金安全（`orders.pending_tx_hash` 未核验候选 TXID + `orders.payment_state` 超额付款态（`''` / `'overpaid_pending'`）+ `lookup_attempts`（/lookup 按单原子记数，与 /secret 同口径）；`ADD COLUMN` / `CREATE TABLE IF NOT EXISTS` 幂等，旧库真正加列/建表、新库 schema.sql 已含为 no-op） |

> v17 核对（与 `src/worker.js` MIGRATIONS v17 + `migrations/0017_txid_claim_token_source_lease.sql` 一致）：三列均为 `ADD COLUMN`；`claim_token` 为 `randomHex(32)`；`source` 默认 `'chain_verified'`（v17 前只有链上路径写认领表）；`order_lease_token` 默认空。`GET /api/admin/schema-check` 按 `expectedTables` 校验 `txid_claims` 六列齐全。预置版本仍为 10（`schema.sql` 只预置 v1–v10），v11–v18 由 Worker 按序执行，不得把预置版本改到 18（否则 v11 图标种子等会被跳过）。
>
> v18 核对（与 `src/worker.js` MIGRATIONS v18 + `migrations/0018_pending_tx_hash_payment_state_lookup_attempts.sql` 一致）：`orders.pending_tx_hash` / `orders.payment_state` 为 `ADD COLUMN`；`lookup_attempts` 为 `CREATE TABLE IF NOT EXISTS` + 索引 `idx_lookup_attempts_order`。`GET /api/admin/schema-check` 按 `expectedTables` 校验 `orders` 含 `pending_tx_hash` / `payment_state`、`lookup_attempts` 三列齐全。预置版本仍为 10（`schema.sql` 只预置 v1–v10），v11–v18 由 Worker 按序执行。

## 管理员首次建站（B-P0）

新数据库首次登录不再接受公开默认密码。未设管理员密码时，登录须提供与环境变量 `ZHIXUAN_SETUP_TOKEN` 匹配的建站令牌（请求体 `setup_token` 字段；密码可为空）；未配置该环境变量时登录 fail-closed（503 并提示配置）。登录后必须改密（`must_change_password`），改密时旧密码可留空（会话本身已由建站令牌授权）。已有密码哈希的数据库行为不变（走密码校验）。**该令牌是建站凭证，不得写进代码/仓库/日志，前端登录页仅提供输入框。**

## 兼容性

- 新版 Worker 可读旧库（迁移前版本号落后时自动升级；升级完成前请求会返回迁移错误，不得伪装成功）。
- 旧版 Worker 可读新库（新表/新列/新索引旧版代码不读取，不影响旧版运行；但新库的 v8 唯一索引会约束旧版下单——
  旧版无 INSERT 重试逻辑，金额冲突时旧版下单会直接报 500。回滚到旧版前需确认无高并发下单场景，见 RELEASE_READINESS 兼容矩阵）。
- 只能向前修复，不能直接回滚 Schema：新表/新列不删除，回滚时保留；唯一索引如需回退，须人工评估重复数据后 `DROP INDEX`。

## 生产上线前（本任务不执行任何生产步骤）

1. 备份生产 D1（`wrangler d1 export` 或 CF 面板快照）。
2. 在测试 D1 上先演练迁移（见测试报告的迁移测试）。
3. 部署前跑 `GET /api/admin/schema-check` 预检（只读），确认无差异。
4. 部署新版 Worker，首次请求自动迁移；用 `GET /api/admin/migrate` 确认 `current_version = 18`。
5. 回滚：重新部署旧版 Worker；新列/新表旧版代码不读取，不影响旧版运行。
