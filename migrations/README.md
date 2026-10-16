# 数据库迁移说明

## 两种迁移方式（二选一，勿重复执行）

### 方式 A：Worker 自动迁移（默认，推荐）

Worker 每次 API 请求 / 定时任务先做轻量版本检查（`SELECT MAX(version) FROM schema_migrations`）。
版本落后时才执行 `runMigrations`（见 `src/worker.js` 的 `MIGRATIONS`），逐个版本 apply，成功才标记版本。
失败时返回明确的版本号与原因，不伪装成功。

- 新库：直接用 `schema.sql`（已含全部列/表，且预置全部迁移版本），不跑迁移。
- 旧库：部署新版 Worker 后首次请求自动升级，幂等、可重试。

管理员也可显式触发：`POST /api/admin/migrate`（返回本次应用的版本），或查询状态：`GET /api/admin/migrate`。

### 方式 B：wrangler d1 migrations apply（可选，供审计/手动执行）

本目录的 `0001~0007` SQL 文件与 Worker 内迁移一一对应。
注意：SQLite 的 `ALTER TABLE ADD COLUMN` 不支持 `IF NOT EXISTS`，重复执行已存在的列会报错（但不破坏数据）。
因此用方式 B 时，请先用 `PRAGMA table_info(orders)` 等确认列不存在，或用 Worker 方式 A（自动做 PRAGMA 检查）。

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

## 生产上线前（本任务不执行任何生产步骤）

1. 备份生产 D1（`wrangler d1 export` 或 CF 面板快照）。
2. 在测试 D1 上先演练迁移（见测试报告的迁移测试）。
3. 部署新版 Worker，首次请求自动迁移；用 `GET /api/admin/migrate` 确认 `current_version = 7`。
4. 回滚：重新部署旧版 Worker；新列/新表旧版代码不读取，不影响旧版运行。
