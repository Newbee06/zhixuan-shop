# 运维手册（智选商城）

## 环境

| 环境 | Worker | D1 | 域名 |
|---|---|---|---|
| 生产 | `aisou-lite` | `aisou-lite-db`（ID `c492fc6c-23d3-4c16-8c49-5a1a3cdf680c`） | <https://aisou-lite.f-00a.workers.dev> |
| Staging | `zhixuan-shop-staging` | `zhixuan-shop-staging-db`（ID `4fb3878b-02bf-4cac-b833-716c050242e6`） | <https://zhixuan-shop-staging.f-00a.workers.dev> |

**红线**：不要部署生产、不要合并 PR、不要访问或修改生产 D1、不要发起真实链上转账——除非用户明确授权。浏览器自动化只能访问 staging 域名与本地地址。

**域名**：`zhixuanpro.com` 尚未绑定生产（见下文“域名上线”清单），上线前生产域名仍为 `https://aisou-lite.f-00a.workers.dev`。

## 部署 staging

```bash
cd ~/workspace/aisou-lite
rm -rf .wrangler
PYTHONPATH=/opt/muse/skills/custom-connector-setup/bin python3 ~/workspace/custom-connectors/custom.legacy-cloudflare/bin/cf_wrangler.py deploy --env staging
```

- **绝不能用** `custom.cloudflare-wrangler/bin/deploy.py`（生产脚本）。
- 部署不跑 `schema.sql`，迁移靠请求触发（Worker 首次请求自动迁移）。
- 部署后验证：`/api/config` 200、首页 200、schema-check `up_to_date: true`。

## 生产部署（不在本文档授权范围内）

生产部署须用户明确授权后另行执行，不在本文档授权范围内；本文档只覆盖 staging 部署、常用操作与回滚说明。

## 常用操作

| 操作 | 方法 |
|---|---|
| 查看 staging 日志 | CF 面板 → Workers → `zhixuan-shop-staging` → Logs |
| 备份 D1 | `wrangler d1 export <db> --local/--remote` 或 CF 面板快照（部署生产前必做） |
| 触发迁移 | `POST /api/admin/migrate`（需登录） |
| 检查迁移/表结构 | `GET /api/admin/schema-check`（需登录） |
| 手动触发轮询 | 触发 cron（CF 面板）或等 1 分钟 |
| 管理员改密 | 后台 → 改密（旧密码 + 新密码 ≥8 位） |

## 常见问题

| 现象 | 排查 |
|---|---|
| 下单 500（关联 ID） | 查 Worker 日志，用关联 ID 定位；常见：迁移未完成、设置缺收款地址 |
| 订单超时未自动取消 | 检查 cron 是否正常触发（`*/1 * * * *` 轮询）；`poll_enabled=0` 不挡过期清理（过期清理独立运行，见下）；再查 `tryExpireOrder` 守卫：订单是否真正过期、是否有已消费付款事实（认领/账本行，有则不取消）、租约是否仍有效（有效租约的订单不取消）；候选查询失败时 fail-closed，不取消任何订单 |
| 轮询未发现到账 | 检查收款地址是否正确；检查 `rpc_urls` / `usdt_contracts`；检查确认数（BEP20 需 15）；用链上浏览器核对 Transfer 日志 |
| 上游商品一直 `pending_upstream` | 检查 `prodseller_enabled`、上游余额、上游库存；后台上游管理看告警 |
| 买家忘查询密码 | 后台订单详情 → 重置查询密码（管理员设新密码，记审计，告知买家） |
| 旧订单（v14 无 salt 哈希）买家无法自助取卡 | 仅管理员流程：后台查看交付内容 / 重置查询密码 / 联系客服 |
| 管理员被锁（登录失败过多） | 等 15 分钟自动解封；或 D1 中清 `login_attempts`（需用户授权，生产 D1 禁动） |
| 审计写入失败（响应 `ok:true` + `audit_failed:true`） | **不得重复操作**：业务已提交，重复操作会重复发货/重复确认。立即核查 `admin_audit` 表，确认缺失的审计行后手动补记（操作、订单、旧状态、新状态、原因），再继续后续操作 |
| TXID 已用于其他订单（`/pay` / 人工确认被拒） | 查 `txid_claims` 确认该 TXID 的归属订单（`order_id`）与来源（`source`：`chain_verified` 链上认领 / `manual_confirmed` 人工认领）。归属争议不得由接口自动改写：管理员在 D1 中核查后手动处理。不得删除他人认领行去“释放”TXID |
| 人工确认账本写入失败（“人工确认账本写入失败，请重试”） | fail-closed 恢复：TXID 认领已保留、租约已释放，**同订单直接重试**即可（重试会收养同一认领行，不重复建行）。不得换订单重试同一 TXID（会被主键认领拒绝）；不得手动删认领行 |
| 同订单并发 / 过期租约接管后旧请求仍在跑 | 预期行为：无回滚删除入口，旧请求失败不删除任何认领；新持有者收养认领（`order_lease_token` 重绑），`source` 不改写。若发现认领行丢失，先查 `txid_claims.claim_token` / `order_lease_token` 与 `orders.claim_token`，确认是哪个租约持有者所为，不得凭猜测恢复 |
| 认领行 `claim_token` 为空（v17 前遗留行） | 遗留行永不被自动删除（无回滚删除入口，已消费认领永久保留）。如需处理遗留认领归属，管理员在 D1 中人工核查后手动处理，不得用接口删除认领 |
| 查单接口返回 410 | `GET /api/orders` 为旧接口，文案“旧接口停用，请用订单号或下单邮箱+验证码走当前查单流程”（已落地）。不要让用户以为邮箱查单已关闭 |

## TXID 认领与人工确认（v17，P1-1/P1-2）

### 新机制：如何避免错误删除认领（无回滚删除入口）

旧顺序（先认领 TXID、后抢订单租约）的竞态：请求 A 插认领成功，请求 B 看到同订单已有认领，B 抢到订单租约开始履约，A 订单认领失败触发回滚删掉 B 依赖的认领，第三订单可重认领同一 TXID。（旧机制；`releaseTxidClaim` 已删除，现已无删除认领的路径。）新顺序为**租约-first**：

1. `fulfillAfterPayment` 先原子获取订单租约（`claimOrderForPayment`：单条条件 UPDATE，`status='pending_payment'` 且未认领或租约已超 5 分钟；成功时写 `paid_at`；新候选 TXID 只写 `pending_tx_hash`，绝不覆盖 `tx_hash`；`tx_hash` 只填第一笔已消费 TXID）。
2. 获租约后才碰 `txid_claims`（`claimTxid`）；无租约的请求不触碰认领。
3. 认领失败只释放本请求租约（本订单无认领时清 `paid_at`；已有认领时保留 `paid_at`），不触碰认领行。
4. 无回滚删除入口：`releaseTxidClaim` 已删除。已消费认领永久保留，任何失败/接管/取消路径不得删除；归属争议只允许管理员在 D1 中人工对账处理。
5. 失败路径不再删除认领行：认领保留，同订单重试时收养同一行，不重复建行，不向他单开放 TXID。
6. 同订单接管：新租约持有者收养认领，只重绑 `order_lease_token`；`source` 首次写入获胜，永不改写。新 TXID 通过核验后成为第二笔付款事件（独立认领行），旧认领保留。

### 人工与链上共用全局 TXID 防重，两种来源语义区别

- 同一 `txid_claims`，`tx_hash` 为主键，全局原子消费：两个并发请求（人工/链上任意组合）同时 INSERT 时，胜负由主键唯一约束决定，败者按归属拒绝（同订单收养，他单拒绝）。不再另建防重表，不再靠先 SELECT 后 INSERT。
- `source='chain_verified'`：链上验证通过后认领（网络 + 白名单合约 + 收款地址 + 精确金额 + 回执 + 确认数全部通过）。
- `source='manual_confirmed'`：管理员在系统外核对到账后人工确认认领（须填人工原因 + 显式 `manual_confirm=true`）。**仅表示人工确认，不构成链上证据**，不伪造回执/区块高度/确认数。人工确认写认领 + `payments manual_confirmed` 账本行 + 审计 + 订单 `【人工确认收款】` 备注。
- 仅当订单带有 64 位十六进制 TXID 时人工确认才写认领行；无 TXID / 非 64 位时不写认领行，但仍记一笔 `manual_confirmed` 账本行（TXID 为空或外部凭证编号，保证对账可追溯，B-P1-8），不伪造认领。
- v17 前遗留：人工确认只写 `payments manual_confirmed` 行、不写认领表。`claimTxid` 仍兼容检查遗留人工行（归属他单则拒绝；归属本单则新建认领行收敛到全局认领表，之后以认领表为准）。`claim_token` 为空的遗留认领行永不被自动删除（无回滚删除入口，已消费认领永久保留）。

### 账本写入失败恢复策略

- 人工账本（`payments manual_confirmed`）写入失败时 **fail-closed**：不把订单推为已付款/已交付；仅当重读确认已有同订单 + 同 TXID + 同状态 `manual_confirmed` 行时才按幂等重试继续；否则释放本请求租约、认领保留、返回失败。恢复 = 同订单直接重试（收养同一认领行）。
- 审计写入失败语义仍为 P1-7：业务已提交时返回 `ok:true` + `audit_failed:true`，**不得重复业务副作用**，须立即核查 `admin_audit` 并手动补记（见“常见问题”）。
- 不得用“删除认领行”作为恢复手段；归属争议一律管理员在 D1 中核查 `txid_claims` 后手动处理。

### v17 迁移信息

- `txid_claims` 加 `claim_token`（每次新认领的密码学安全随机令牌 `randomHex(32)`，认领持有凭证；无回滚删除入口）+ `source`（`'chain_verified'` / `'manual_confirmed'`，首次写入获胜）+ `order_lease_token`（认领时持有者的订单租约令牌）。
- 均为 `ADD COLUMN` 幂等；`schema.sql` 新库已含三列；预置版本保持 10（v11–v17 由 Worker 按序执行）。现有认领行保留，旧行 `source` 默认 `'chain_verified'`。
- 部署后验证：`GET /api/admin/migrate` → `current_version = 17`；`GET /api/admin/schema-check` → `ok=true`（含 `txid_claims` 六列校验）。v16（6 个查询索引）已应用，不是“尚未应用”；v17 在其之上追加。

### 本轮再修正（v18，PR #4 收尾，2026-10-18）

- 认领查询异常 fail-closed；Schema 迁移不完整时不许降级写入（v17/v18 列缺失即报迁移错误）。
- 统一付款入口 `processVerifiedPayment`：已入账去重 → 旧认领账本恢复（`restoreOldClaimLedgers`，认领存在但账本缺失时补齐，恢复失败 fail-closed）→ 金额一致性 → 第二笔分流 → `fulfillAfterPayment`（租约 → 认领 → 账本 → 副作用）→ 入账标 `posted`。
- 第二笔真实付款记 `verified/overpaid_pending` + `payment_state='overpaid_pending'`，不重复发货；对账为 `reconciled` 后无其他超额行时清 `payment_state`。
- 候选 vs 已消费分离：`/pay` 未核验候选只写 `pending_tx_hash`；`tx_hash` 只填第一笔已消费 TXID。
- 过期清理公平筛选：候选只选真正过期订单、按有效过期时间排序；`poll_enabled=0` 仍清理、零 RPC；候选查询失败 fail-closed。
- `/lookup` 按单原子记数（`lookup_attempts`，与 `/secret` 同口径）；`/secret` 认证前失败路径统一 401“查询密码错误”；验证码字符改为 5×7 点阵 `<rect>`（无 `<text>`）；限流检查异常时 fail-closed（拒绝，不放行）。
- 语义与对账流程详见 `docs/PAYMENT_FLOW.md`；Staging 只读核验事实与时间戳见 `docs/RELEASE_READINESS.md` 文末附录。

## 回滚

重新部署 main 分支的旧版 Worker 即可。旧库新增的列和表（新增表：`upstream_orders` / `upstream_cache` / `captcha_codes` / `order_rate` / `admin_audit` / `login_attempts` / `txid_claims` / `lookup_rate` / `payments` / `scan_cursors` / `pay_rate` / `app_icons` / `secret_attempts` / `lookup_attempts`；新增列：`query_token_hash` / `query_password_hash` / `query_password_salt` / `reserved_*` / `claim_token` / `claimed_at` / `exception_reason` / `refund_*` / `upstream_lock` / `upstream_lock_expires_at` / `app_icon_key` / `schema_migrations` / `txid_claims.claim_token` / `txid_claims.source` / `txid_claims.order_lease_token` / `orders.pending_tx_hash` / `orders.payment_state`）可保留，旧版代码不读取它们，不影响旧版运行。回滚前备份 D1。

**v8 / v9 唯一索引 caveat**：回滚后新库的 v8 / v9 唯一索引（`idx_orders_amount_claim`（v9 重建版，排除 BinanceUID）/ `idx_orders_contact_pending`）仍会约束旧版下单——旧版无 INSERT 重试逻辑，高并发下金额/联系人冲突时旧版下单会直接报 500。回滚前确认无高并发下单场景，或先评估 DROP 索引（须先人工评估重复数据，见 `migrations/README.md`）。

**回滚不对称（回滚前逐项检查）**：
- v8 / v9 唯一索引会留下来继续约束旧代码下单（见上），DROP 前须先查干跑报告的重复待付款金额/联系方式。
- 新订单的 salted 查询密码旧代码不认：v15 起新订单的查询密码是 salt + PBKDF2 哈希；回滚到旧版 Worker 后，旧代码的查单/取卡路径不认 salted 哈希，新订单的自助查单/取卡会失败，只能管理员人工处理。
- 回滚前检查项：① 已备份当前 D1；② 待付款订单数与进行中的上游单（`pending_activation / pending_upstream`）已人工确认去向；③ 干跑（`GET /api/admin/schema-check`，干跑不升库、正式迁移走 `POST /api/admin/migrate`）无未处理差异；④ 回滚后立即冒烟：下单、查单、取卡、取消释放预留。
- 开关语义（与代码一致）：`prodseller_enabled` 只控制新建上游单、`poll_enabled` 只控制链上扫描；已有上游单号的已付款订单无论两开关为何值都会继续轮询完成，关闸不等于停一切。

## 域名上线（zhixuanpro.com，仅清单与只读验证，不执行切换）

本节只写清单与只读验证命令。任何注册/改 DNS/绑生产域名/改 Route/Custom Domain 操作都须用户单独明确审批（与代码部署审批分开），不在本轮授权内。

清单（逐项勾选，见 `docs/PRODUCTION_CHECKLIST.md` E 节）：所有权与 DNS 托管、CF Zone、Route/Custom Domain 只指向生产 Worker `aisou-lite`、TLS/重定向/canonical、DNS 与路由冲突、Staging workers.dev 不被生产域名替换、独立审批与回滚、未验证项。

切换前必须先记录旧值快照（切换前 DNS 记录 + Route 列表），回滚 = 恢复旧值并验证。

只读验证（不改任何配置）：

```bash
# DNS 解析（期望：指向生产 Worker 的 CF 边缘地址/CNAME，无旧测试记录）
dig +short zhixuanpro.com
dig +short www.zhixuanpro.com
# TLS / 重定向 / canonical（期望：HTTPS 200、无到错误域名的重定向、HSTS 按决策）
curl -sI https://zhixuanpro.com
curl -sI http://zhixuanpro.com
# 生产域名上的 API（期望：200，与 workers.dev 生产域名行为一致）
curl -s https://zhixuanpro.com/api/config | head -c 300; echo
# Staging 未被替换（期望：200，仍可独立访问）
curl -s -o /dev/null -w "%{http_code}\n" https://zhixuan-shop-staging.f-00a.workers.dev/api/config
```

## 数据保留

- 交付内容：`fulfilled_at` 超过 7 天的已完成订单自动清空卡密/账号交付数据并标记 `data_expired`。
- 审计日志：`admin_audit` 保留，不自动清理。
- 验证码：5 分钟过期；查单限流记录 10 分钟窗口。
