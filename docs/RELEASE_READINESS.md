> ⚠️ §一–§八为第四轮历史快照，仅文末附录为最新状态。
>
> 文末附录（本次整改，2026-10-18）为最新状态；旧章节中与附录冲突的表述（邮箱查单、审计失败、`/pay` 验证码、商品卡字号）以附录及 `docs/SECURITY.md` / `docs/ARCHITECTURE.md` 为准。历史章节不改写（保留当时快照）。
>
> # 智选商城 — 上线就绪报告（Release Readiness，第四轮）

> 分支：`feat/admin-overhaul-security`（未合并 `main`，未部署生产）
> 基线：`c511f39b`（第三轮验收，CI 全绿）
> 本轮：基于真实代码修复生产上线阻塞项，新增迁移 v8、付款账本、扫描游标、门禁、预检与专项测试。
> 本文档中的生产迁移命令仅为计划，**不得实际执行**。生产 D1 状态未知，本轮不连接、不读取、不修改生产 D1。

## 一、最终判定

| 判定 | 结论 | 依据 |
|---|---|---|
| A. 能否部署预发布环境 | **CONDITIONAL** | 代码与迁移已在本地全量验证（见 §7），但预发布需真实 D1 + 真实 RPC + Turnstile 配置后复验；ProdSeller 门禁默认关闭，预发布可开 Mock 或保持关闭。 |
| B. 能否对真实客户公开销售 | **BLOCKED** | 真实收款链路（链上确认、ProdSeller 履约）尚未经真实服务商/链上环境验证；邮箱查单已关闭但需告知老用户新查单方式；Turnstile 未配置（默认 SVG 验证码）。详见 §8。 |
| C. 能否开放真实链上付款及 ProdSeller 自动履约 | **BLOCKED** | 需 §8 列出的真实服务商证据：ProdSeller Idempotency-Key/状态枚举/402·409·429 语义/限速、真实链上到账（各链确认数策略需在真实网络复验）、真实收款地址配置。门禁默认关闭，未提供证据前不得开启。 |

CI 全绿 ≠ 真实交易链路生产就绪。上述判定以真实证据为准，不以 CI 状态为准。

## 二、本轮修复（代码与文件）

### 2.1 P0 付款账本（A-05）

- 新增 `payments` 表（迁移 v8，见 `schema.sql` / `migrations/0008_payments_scan_cursor_pay_rate.sql`）：
  `id`、`order_id`（不唯一，同一订单可多笔）、`chain`、`asset`、`pay_address`、`tx_hash`、`event_key`、
  `amount`、`amount_unit`、`block_number`、`confirmations`、`first_seen_at`、`status`、`reconcile_status`、`reconcile_note`、`created_at`、`updated_at`。
- 唯一键 `idx_payments_event_unique (chain, tx_hash, event_key)`：同一链上事件只能入账一次。
  `event_key`：EVM 为日志索引（`logIndex`），TRC20 为 `block_ts:quant`；`/pay` 提交时未知为空，核验后回填。
- 状态机：`submitted`（用户提交 TXID）→ `discovered`（轮询发现）→ `verified`（链上核验通过）
  → `confirmed`（达到该链确认数）→ `posted`（已入账，履约已触发）。
  异常：`duplicate`（同一事件已入账）、`mismatch`（金额与订单预期不符）、`unmatched`（无法归属订单）、`reconciled`（管理员人工对账）。
- 集成点：`/pay` 提交时记 `submitted`，核验通过记 `verified`，履约成功记 `posted`，TXID 已属他单记 `duplicate`；
  轮询发现记 `verified`，金额不符记 `mismatch`，履约成功记 `posted`；全局扫描无法归属记 `unmatched`。
- 管理端：`GET /api/admin/payments`（按状态/订单筛选）、`POST /api/admin/payments/:id/reconcile`（人工对账，仅能标记 `reconciled`，不得直接改 `posted`）。
- 关键保证：同一链上事件重复轮询/并发提交不重复入账（唯一键 + 幂等写入）；同一订单第二笔付款保留独立记录；
  重复/部分/超额/金额不符/无法归属均进入明确对账流程；失败不把订单误标已付款。

### 2.2 P0 金额唯一性（§4.1）

- 新增部分唯一索引 `idx_orders_amount_claim (pay_address, actual_amount) WHERE status='pending_payment'`（迁移 v8）。
  过期未取消的待付款订单仍占位（轮询 1 分钟内自动取消后释放）；冲突时下单 INSERT 捕获唯一约束错误并重新生成金额重试（最多 5 次），不得静默复用。
- `genActualAmount`：查重循环 20→50 次，兜底不再“不再查重”，最终由 INSERT 唯一约束裁决。
- 同联系方式去重 TOCTOU：新增部分唯一索引 `idx_orders_contact_pending (contact, product_id) WHERE status='pending_payment' AND contact != ''`，
  与下单 SELECT 查重逻辑一致，但由数据库原子保证；INSERT 冲突时返回明确重复提示。

### 2.3 P0 链上扫描可靠性（§4.2）

- 新增 `scan_cursors` 表（迁移 v8）：每链已扫描区块高度，持久化；RPC 失败不推进，重启可恢复。
- 新增 `scanEvmChain` 全局扫描：按链游标分页（`EVM_SCAN_PAGE_BLOCKS=1000`），范围 `[游标, 最新-确认数]`，
  整页成功后才推进游标；首次扫描回溯 200 区块（与旧口径一致）；只扫有待付款订单的链与地址；
  每个日志记账本并按 to+金额匹配订单，无法归属记 `unmatched`，金额不符记 `mismatch`。
- 各链确认数策略（可经 `settings.chain_confirmations` 覆盖，默认）：X Layer 1、ERC20 12、BEP20 15、TRC20 19。
  不再全链 1 确认。`checkEvmPayment` / `checkTxidPayment` 均按该策略过滤；未达确认数不入账、不履约（防重组）。
- Tronscan 分页：上限 10→20 页（1000 笔）。评估：单地址 1 分钟内 >1000 笔 USDT 转账极少；
  命中上限且未找到付款时记 `console.warn`，不得静默漏账，运营需人工在 Tronscan 核查并对账。
- 轮询仍保留逐单检查（快路径）+ 全局扫描（补扫漏检：回溯不足 / 停机恢复 / 延迟到账），两者均经账本去重，安全叠加。

### 2.4 P0 上游幂等（§5）

- `upsertUpstreamOrder` 空值保护：`prodseller_order_id` 与 `delivered_keys` 非空时，空字符串不得覆盖。
  占位行（`insufficient_balance` / `upstream_error` / `gateway_closed`）传入空值时不再抹掉已成功的上游单号与已交付 keys。
- 上游履约调用限流：`prodsellerCreateOrder` / `prodsellerGetOrder` 复用 300/15min 计数，超限返回 429 语义，
  调用方按 `pending_upstream` + 下次轮询重试，不得误判为上游失败或重复采购。
- `Idempotency-Key`：代码仍传 `order_no` 作为键，但**无任何官方证据证明 ProdSeller 支持该头、其作用域与有效期**，
  列为待验证（见 §8），不得当作已证实行为。重试路径（Cron / 管理员重试 / 履约内创建）均复用同一键与“已有单号只轮询不重建”逻辑。

### 2.5 P0 统一迁移（D-01，§6）

- 唯一权威来源：`src/worker.js` 的 `MIGRATIONS` 数组。
  `migrations/*.sql` 为只读镜像（仅审计与 Schema 对照），**不得**用 `wrangler d1 migrations apply` 直接执行。
  `schema.sql` 为新库建表脚本（终态 + 预置版本）。
- 新增 `GET /api/admin/schema-check`（只读预检）：校验表、列、索引、关键唯一约束
  （`idx_upstream_orders_order_unique` / `idx_payments_event_unique` / `idx_orders_amount_claim` / `idx_orders_contact_pending`）、重复待付款金额。
  版本号与 Schema 内容不一致时报告差异，不得静默放行。
- 迁移并发：版本标记改 `INSERT OR IGNORE`，两请求同时迁移不因唯一冲突失败。
- 兼容性：新版 Worker 可读旧库（自动升级）；旧版 Worker 可读新库（新表/列不读取），但新库 v8 唯一索引会约束旧版下单
  （旧版无 INSERT 重试，金额冲突时旧版下单直接 500）。只能向前修复，不能直接回滚 Schema。
- 历史 Schema 已改但迁移记录不完整：预检报告差异，运营按 §5 修复后重试，不得简单把 v1–v8 全标已执行，
  不得对未知 Schema 直接跑一遍全部 `ALTER TABLE`。

### 2.6 P0 公开接口（§7）

- **E-02 邮箱查单已关闭**：`GET /api/orders?contact=` 返回 410（“邮箱查单已关闭，请使用订单号 + 查单凭证查询”）。
  统一入口为订单号 + 高强度查单凭证（`POST /api/orders/:no/lookup`）。无邮箱 OTP 兼容路径（邮件已移除，无法发送 OTP）。
  前端查单页已移除邮箱查单 UI。
- **E-01 验证码**：SVG 验证码仍可用（低门槛），但并发重放已修复——成功路径用单条原子 `DELETE WHERE id + code_hash` 认领，
  两个并发请求同时验同一验证码时只一个能消费。
- **Turnstile（评估 + 可选接入）**：`settings.turnstile_enabled`（0/1，默认 0）+ `settings.turnstile_site_key`（公开）+
  环境变量 `TURNSTILE_SECRET_KEY`（密钥，绝不进代码/settings/日志）。开启时前端渲染官方 widget，服务端调
  `siteverify` 校验 token；密钥缺失时 fail-closed（拒绝请求，绝不静默降级为无验证）；服务不可用时拒绝请求，用户刷新重试。
  本地测试经 `env.__fetch` Mock siteverify（生产无此 Mock）。配置见 §5.4。
- **`/pay` 限流**：新增 `pay_rate` 表，同一订单 10 分钟最多 5 次，同一 IP 10 分钟最多 20 次，超限 429。
  受限不影响后台轮询继续核验已到账付款，订单不会因限流永久无法处理。
- **错误脱敏**：顶层 500 不再返回 `e.message`，改通用错误 + 关联 ID（`req_<16位>`），内部详情只记 Worker 日志（`console.error`）。
  公开接口绝不返回 SQL、数据库结构、内部路径、堆栈或凭据。

### 2.7 P0 ProdSeller 门禁（§8）

- 新增 `settings.prodseller_enabled`（0/1，默认 0）。关闭时：下单拦截（403“该商品暂未开放购买”），
  履约拦截（转 `pending_upstream` + `gateway_closed`，不发起真实采购）。开启需提供 §8 证据并由管理员显式开启。
- 待验证项（均无真实证据，不得猜测）：Idempotency-Key 支持/作用域/有效期；创建成功但响应超时后的查询与恢复；
  真实状态枚举及转换；402/409/429 具体语义；限速及重试规则。

### 2.8 Low 11 项复核

| Low | 状态 | 证据/处理 |
|---|---|---|
| 金额兜底冲突 | 已修复 | §2.2（唯一索引 + INSERT 重试 + 50 次查重） |
| UPSERT 空值覆盖 | 已修复 | §2.4（CASE WHEN 空值保护） |
| EVM 区块扫描范围 | 已修复 | §2.3（游标 + 分页 + 全局扫描） |
| 上游履约调用限速 | 已修复 | §2.4（300/15min，超限 429 重试） |
| 首次迁移并发失败 | 已修复 | §2.5（INSERT OR IGNORE） |
| 历史迁移验证缺口 | 已修复 | §2.5（schema-check 预检） |
| 验证码并发重放 | 已修复 | §2.6（原子 DELETE 认领） |
| 同联系方式下单去重 TOCTOU | 已修复 | §2.2（部分唯一索引） |
| /pay 独立限流 | 已修复 | §2.6（pay_rate） |
| 500 错误泄露数据库信息 | 已修复 | §2.6（通用错误 + 关联 ID） |
| 登录限流只按 IP | 已修复 | 全局限流：全站 15 分钟失败超 30 次时全部登录拒绝 5 分钟，防换 IP 分布式暴力破解 |

## 三、新增测试

- `tests/release-readiness-test.mjs`（53 断言，全部通过）：付款账本（提交→入账、重复事件、同一订单多笔、对账）、
  金额唯一索引 + 5 并发下单金额互不相同、EVM 游标读写、UPSERT 空值保护、schema-check（含缺表检出与恢复）、
  邮箱查单 410、Turnstile 成功/失败/密钥缺失 fail-closed、/pay 限流（第 6 次 429）、500 脱敏、
  ProdSeller 门禁（关 403 / 开可下单）、验证码并发重放（仅一个成功）、同一 TXID 并发提交（仅一行付款记录、仅发一次卡）。
- 更新的旧测试（口径随新行为更新，非弱化）：安全测试 98/98（邮箱查单 410、门禁 403/缺货、版本 8）；
  并发测试 114/114（A-04 改为 ERC20 12 确认：0/11 确认延迟，12 确认接受；迁移失败 500 改为脱敏断言）；
  D1 迁移测试（旧库→v8、去重、幂等、失败不标版本、修复后恢复、新库 up_to_date）。
- 故障测试覆盖：同一付款事件并发进入、同一订单多笔付款、已入账订单重复轮询、RPC 失败后游标不推进、
  迁移到一半失败、上游占位行空值不覆盖、验证码同时被两个请求消费、公开接口错误脱敏。
- 未覆盖（需真实环境）：真实链上到账（各链确认数需真实网络复验）、真实 ProdSeller 行为（见 §8）、
  Worker 在付款记录与履约之间中断的真实崩溃恢复（本地用幂等 + 租约接管模拟，未做真实进程杀死测试）。

## 四、本地验收结果（真实命令与输出）

```bash
npm run test:static        # Worker 语法 + 前端脚本 2/2
npm run test:regression    # mock + stock 17/17 + security 98/98 + concurrency 114/114 + release-readiness 53/53
bash tests/d1-local-test.sh # 旧库→v8、去重、幂等、失败不标版本、修复后恢复、新库 up_to_date：D1 LOCAL TEST ALL OK
BASE=http://127.0.0.1:8791 node tests/browser-acceptance-ci.mjs  # 48/48
```

## 五、本地验收与迁移演练步骤

### 5.1 本地验收

```bash
cd zhixuan-shop
git checkout feat/admin-overhaul-security && git pull
node --check src/worker.js
npm run test:static
npm run test:regression
bash tests/d1-local-test.sh
# 浏览器验收（需 wrangler + playwright）
rm -rf .wrangler/state
npx wrangler d1 execute aisou-lite-db --local --file=schema.sql
npx wrangler dev --local --port 8791 &
BASE=http://127.0.0.1:8791 node tests/browser-acceptance-ci.mjs
```

### 5.2 旧数据库迁移演练（本地隔离 D1，禁止生产）

```bash
# 1. 复制旧库结构（剥离 v8），写入旧数据（含重复 upstream_orders）
#    见 tests/d1-local-test.sh（自动执行）
# 2. 启动本地 Worker，首次请求自动迁移
# 3. 用 GET /api/admin/migrate 确认 current_version = 8
# 4. 用 GET /api/admin/schema-check 确认 ok=true（无差异）
# 5. 核对旧订单、卡密、付款记录保留
```

### 5.3 只读预检

```bash
# 登录后（Cookie）：
curl -s -b cookie.jar https://<域名>/api/admin/schema-check
# 返回 { precheck: { ok, current_version, latest_version, issues: [], checks } }
# issues 非空时不得部署，先按 §5.5 修复。
```

### 5.4 生产迁移前置条件（仅计划，不得执行）

1. 备份生产 D1（`wrangler d1 export` 或 CF 面板快照），并验证备份可恢复。
2. 在测试 D1 上演练迁移（§5.2），确认无差异。
3. 跑 `GET /api/admin/schema-check` 预检，确认 `ok=true`。
4. 确认无重复待付款金额（预检会报告；如有，先手动处理重复订单）。
5. 确认 `prodseller_enabled=0`（默认关闭），`turnstile_enabled` 按需配置（见下）。
6. 部署新版 Worker，首次请求自动迁移，用 `GET /api/admin/migrate` 确认 `current_version = 8`。
7. 部署后复检：`schema-check` + 付款账本 + 轮询 + 上游门禁。

Turnstile 配置（可选，未配置则默认 SVG 验证码）：

```bash
# 1. 在 Cloudflare Dashboard → Turnstile 创建站点，拿到 Site Key（公开）与 Secret Key（密钥）。
# 2. 后台设置填入 site key：
#    POST /api/admin/settings { "turnstile_site_key": "<Site Key>", "turnstile_enabled": "1" }
# 3. Secret Key 经环境变量注入（绝不写进代码/settings）：
printf '%s' "$TURNSTILE_SECRET" | npx wrangler secret put TURNSTILE_SECRET_KEY
# 4. 验证：下单时 widget 出现，提交后服务端校验通过；删掉 Secret 后下单应被拒绝（fail-closed）。
```

### 5.5 数据备份与恢复演练

```bash
# 备份（仅计划，不得对生产执行）：
npx wrangler d1 export aisou-lite-db --output=backup-<日期>.sql
# 恢复演练（本地隔离库）：
npx wrangler d1 execute aisou-lite-db --local --file=backup-<日期>.sql
# 验证：订单、付款、卡密数量与备份前一致；GET /api/admin/schema-check ok=true。
```

### 5.6 Worker 与数据库版本兼容矩阵

| Worker 版本 | DB 版本 | 兼容 | 说明 |
|---|---|---|---|
| 新版（v8） | v8 | ✅ | 正常 |
| 新版（v8） | v7 及以下 | ✅ | 首次请求自动迁移到 v8 |
| 旧版（v7） | v8 | ⚠️ 有条件 | 新表/列旧版不读取，但 v8 唯一索引约束旧版下单（旧版无 INSERT 重试，金额冲突时旧版下单 500）。回滚前确认无高并发下单。 |
| 旧版（v7） | v7 | ✅ | 正常 |

### 5.7 失败时的停止及恢复方案

- 迁移失败：Worker 返回 500（脱敏 + 关联 ID），版本不标记。用关联 ID 查 Worker 日志定位，
  按日志修复 D1 后重试（迁移幂等）。不得手动把版本标为已执行。
- 预检有差异：停止部署，按差异修复（补表/补列/补索引/处理重复数据），重新预检到 `ok=true` 再部署。
- 付款异常（mismatch/unmatched/duplicate）：在 `GET /api/admin/payments?status=<状态>` 中查看，
  人工核查链上交易后，用 `POST /api/admin/payments/:id/reconcile` 标记已处理并写备注。不得直接改 `posted`。
- 上游门禁误开：立即将 `prodseller_enabled` 置 0，已发起的采购需在 ProdSeller 后台核查，不得重复采购。
- 回滚：重新部署旧版 Worker（见 §5.6 兼容矩阵）；新表/新列保留，不删除。

### 5.8 上线后监控指标

- 付款失败：`payments` 中 `status='mismatch' / 'unmatched' / 'duplicate'` 的数量与明细。
- 重复认领：`txid_claims` 中同一 TXID 被多订单尝试认领的拒绝次数（日志）。
- 待处理订单：`orders` 中 `pending_payment`（超时未到账）、`pending_upstream`（上游阻塞）、`refund_pending`（待退款）的数量。
- 上游错误：`upstream_orders` 中 `status='upstream_error' / 'insufficient_balance' / 'out_of_stock' / 'gateway_closed'` 的数量。
- 库存异常：卡密可用数为 0 但商品 `in_stock=1` 的不一致；`payments` 中金额不符的订单。
- 扫描游标：`scan_cursors` 各链 `last_block` 与最新区块的差距（差距持续扩大 = 扫描停滞）。
- 限流：`pay_rate` / `order_rate` / `lookup_rate` 的 429 次数（突增 = 攻击或误伤）。

### 5.9 关闭/暂停方法

- 关闭真实收款：后台设置 `poll_enabled=0`（停止轮询自动发货）；或下架全部商品（`is_active=0`）。
- 关闭上游销售：后台设置 `prodseller_enabled=0`（门禁关闭，上游商品禁止下单与采购）。
- 暂停履约：`poll_enabled=0` + 手动处理 `pending_activation` / `pending_upstream` 订单（管理员重试入口仍可用，需逐笔确认）。
- 人工处理异常：`GET /api/admin/payments?status=mismatch|unmatched` 查看 → 链上核查 → `POST /api/admin/payments/:id/reconcile` 标记。

## 六、仍需真实服务商或链上环境验证的项目（解除门禁/上线所需证据）

1. **ProdSeller**：Idempotency-Key 是否支持、作用域、有效期；创建成功但响应超时后的查询与恢复机制；
   真实状态枚举及转换；402/409/429 具体语义；限速及重试规则。需官方文档或隔离沙箱验证，不得猜测。
2. **链上**：各链（X Layer / ERC20 / BEP20 / TRC20）真实到账、确认数策略在真实网络的表现、重组场景、
   Tronscan 高频地址分页（>1000 笔）的真实表现。
3. **Turnstile**：真实 Site Key + Secret Key 配置后的端到端验证（本轮仅 Mock 验证逻辑）。
4. **生产 D1**：实际 Schema 与迁移记录（本轮只提供只读预检能力，未连接生产 D1）。

## 七、第五轮：预发布部署准备（2026-10-16，部署阻塞，待授权后续跑）

**状态：部署前准备全部完成；实际 Cloudflare 部署 BLOCKED，原因见下。未合并 PR，未部署生产，未触碰生产 D1。**

#### 第一阶段核查结论（真实代码，提交 `9a79984`）

- 远端分支 = 预期基线 `9a79984`，PR #1 OPEN / MERGEABLE / CLEAN，CI 运行 38872380812 四项全部通过。
- 迁移触发：`handleApi` 开头调 `ensureMigrated(env)`，首个 `/api/*` 请求自动迁移（`/` 静态页不触发）；`scheduled` 亦先调 `ensureMigrated`。
  `MIGRATIONS` 数组为唯一权威来源；`migrations/*.sql` 不被 Worker 执行。
- `schema-check`：只读（仅 `PRAGMA table_info` + `SELECT sqlite_master` + 重复金额 `SELECT`），需管理员登录（未登录 401）。
- 无隐含生产绑定：`worker.js` / `frontend.html` 无硬编码生产 D1 ID 或生产域名；D1 绑定只来自 `wrangler.toml` 的 `env.DB`。
- Cron/履约：`*/1 * * * *` 跑 `runPolling` + `pollUpstreamActivations`；`0 2 * * *` 跑清理 + 上游激活轮询。
  上游履约门禁：`prodseller_enabled != '1'` 时订单转 `pending_upstream`（`gateway_closed`），不发起真实采购；
  下单时上游商品亦被 403 拦截。`poll_enabled=0` 时轮询直接跳过（`skipped: poll_disabled`），零 RPC。
- 路由：`wrangler.toml` 无 `routes` / 自定义域名，默认 `workers.dev` 子域，staging 不会接管生产域名。

#### 第三阶段部署前测试（本轮真实重跑，提交 `9a79984`）

- `npm run test:static`：通过（Worker 语法 + 前端脚本 2/2）
- `npm run test:regression`：Mock 通过（`emails=0 upstreamCalls=10`）、库存 17/17、安全 98/98、并发 114/114、第四轮专项 53/53
- `bash tests/d1-local-test.sh`：`D1 LOCAL TEST ALL OK`（旧库→v8、新库 up_to_date）
- 浏览器验收：48/48（Playwright Chromium，本地 wrangler dev）

#### Staging 配置方案（待授权后应用，保留生产配置不动）

向 `wrangler.toml` 追加独立 `[env.staging]`（不改现有顶层生产配置）：

```toml
[env.staging]
name = "zhixuan-shop-staging"
compatibility_date = "2024-01-01"
main = "src/worker.js"

[[env.staging.d1_databases]]
binding = "DB"
database_name = "zhixuan-shop-staging-db"
database_id = "<新建 staging D1 后填入的 UUID>"

[env.staging.vars]
PRODSELLER_BASE_URL = "https://prodseller.com/v1"

[[env.staging.rules]]
type = "Text"
globs = ["**/*.html"]
fallthrough = true

[env.staging.triggers]
crons = ["0 2 * * *", "*/1 * * * *"]
```

部署后第一步（部署后验收前）：登录 staging 后台，把 `poll_enabled` 置 `0`（默认 `1`；置 `0` 后轮询零 RPC），
确认 `prodseller_enabled` 为 `0`（默认关闭），再创建测试订单。验收时如需验证轮询，可短暂置 `poll_enabled=1` 观察后立即改回 `0`。

#### 授权后续跑命令（待 Cloudflare 安全授权后执行，顺序不可乱）

```bash
# 1. 核实授权与同名资源（不得删除/覆盖已存在资源）
npx wrangler whoami
npx wrangler d1 list   # 确认无名为 zhixuan-shop-staging-db 的 D1（有则核实归属，不得覆盖）
npx wrangler deployments list --name zhixuan-shop-staging  # 确认无同名 Worker（有则核实归属）

# 2. 创建独立 staging D1（确认专用于测试后）
npx wrangler d1 create zhixuan-shop-staging-db
# 记下返回的 database_id，填入 wrangler.toml [env.staging]，提交到功能分支并等 CI 全绿

# 3. 部署前再次核对目标（显式 staging，不得用默认生产配置）
#    目标 Worker: zhixuan-shop-staging
#    目标 D1: zhixuan-shop-staging-db（新 UUID，与生产 D1 不同）
#    地址: https://zhixuan-shop-staging.<子域>.workers.dev（不绑定生产自定义域名）
npx wrangler deploy --env staging

# 4. 首次请求（触发自动迁移到 v8，指向 staging D1）
curl -s https://zhixuan-shop-staging.<子域>.workers.dev/api/config | head -c 300
# 登录后：GET /api/admin/schema-check → precheck.ok=true；GET /api/admin/migrate → current_version=8
```

#### 阻塞原因（诚实记录，不得绕过）

- `npx wrangler whoami` 返回未登录；Secure Vault 无已存 Cloudflare 登录。
- 一份工具结果未通过安全检查，其描述的凭据/部署脚本路径未被使用（未运行、未采纳）。
- 按任务要求：凭据不可用时停在相应步骤并说明安全授权方式，不得用聊天粘贴的 PAT/密钥替代。
- 安全授权方式：用户在自己终端执行 `npx wrangler login`（OAuth 浏览器授权），或经 Muse 安全入口提交 Cloudflare API Token（绝不粘贴到聊天）。
  授权完成后，按上文“授权后续跑命令”继续，部署前仍需重核远端 SHA / PR / CI。

## 八、第六轮：Cloudflare 实际部署 staging 并完成验收（2026-10-16，已部署并通过验收）

**状态：staging 已实际部署并可访问，部署后验收通过。未合并 PR，未部署生产，未触碰生产 D1。**

**部署信息（真实执行结果）**

- 部署候选提交：`8288db0bdcbc5e5c64657479ffa7138aa462cdde`（含两项真实缺陷修复，见下）
- Worker：`zhixuan-shop-staging`
- staging URL：`https://zhixuan-shop-staging.f-00a.workers.dev`
- staging D1：`zhixuan-shop-staging-db`，ID `4fb3878b-02bf-4cac-b833-716c050242e6`（新创建，独立，与生产 D1 不同）
- 部署方式：Cloudflare Workers Script Upload API（`PUT /workers/scripts/zhixuan-shop-staging`，multipart：`worker.js` + `frontend.html`，D1 绑定指向 staging D1 ID）；子域 serving 显式启用；Cron 通过 Schedules API 设置（`0 2 * * *`、`*/1 * * * *`）
- 授权：用户经 Muse 安全入口提交 Cloudflare API Token（最小权限：Account Settings:Read、Workers Scripts:Edit、D1:Edit；Token 未写入代码/提交/日志/报告）。已存旧凭据验证 401 失效，已替换。
- 生产未变更：生产 Worker `aisou-lite` 修改时间仍为部署前时间；生产 D1 未连接/读取/修改；未配置生产域名/路由。
- Schema：staging 首次请求自动迁移至 v9；`GET /api/admin/migrate` → `current_version=9, latest_version=9, up_to_date=true`；`GET /api/admin/schema-check` → `precheck.ok=true`，18 张表全部 ok，issues 为空。
- 隔离设置（显式设置，非默认值）：`poll_enabled=0`、`prodseller_enabled=0`（已通过管理接口设置并验证）。

**本轮发现并修复的真实缺陷（2 项，均有回归断言，修复后重新全绿 CI）**

1. **真正空库首次迁移失败（v1 假设基表已存在）**：全新空 D1（未导入 `schema.sql`）首次请求时，`runMigrations` 直接跑 v1 的 `ALTER TABLE orders ADD COLUMN`，因 `orders` 表不存在而 500。此路径此前未被测试覆盖（D1 本地测试只覆盖旧库→v8 与已导入 schema 的新库）。
   修复：`runMigrations` 先判断库是否全新（除迁移表与内部表外无用户表；排除 `schema_migrations`、`sqlite_%`、`_cf_%` 如 `_cf_METADATA`），全新时先建 6 张基表（与 `schema.sql` 定义一致），再跑 v1–v9。仅全新空库建基表；已有部分表但缺基表（如 `orders` 被误删）不静默重建空表掩盖数据丢失，仍让 v1 自然失败、版本不标记（并发测试迁移失败场景仍通过）。
   回归：D1 本地测试新增真正空库段（建基表 + 迁移到 v9 + schema-check ok）。
2. **v9：金额唯一索引误伤 BinanceUID 订单（下单 500）**：v8 的部分唯一索引 `idx_orders_amount_claim (pay_address, actual_amount) WHERE status='pending_payment'` 未排除 BinanceUID。BinanceUID 订单无链上地址（`pay_address=''`）且金额=总价无随机尾数，同金额待付款 BinanceUID 订单触发唯一冲突，下单代码对 BinanceUID 唯一冲突直接 throw → 500。staging 验收复现：已有 1 笔待付款 BinanceUID 订单（5 USDT）时，第二笔同金额 BinanceUID 订单必 500。
   修复（追加式 v9，不改已应用的 v8）：DROP 旧索引，重建为 `WHERE status='pending_payment' AND pay_method != 'BinanceUID'`。BinanceUID 走管理员手动核对，不靠链上 (地址,金额) 匹配。旧索引约束更严，数据一定满足新条件，DROP 后重建不会失败。`schema.sql` 同步新索引定义与迁移版本 9。
   回归：Release Readiness 新增 v9 专项 4 断言（旧索引 + 待付款 BinanceUID 订单 → 迁移 v9 后同金额第二笔 BinanceUID 订单成功）。

**部署前测试（本轮真实执行，部署候选提交 `8288db0`）**

- `node --check src/worker.js`：通过
- `npm run test:static`：通过（Worker 语法 + 前端脚本 2/2）
- `npm run test:regression`：Mock 通过（`emails=0 upstreamCalls=10`）、库存 17/17、安全 98/98、并发 114/114、Release Readiness 57/57（含新增 v9 专项 4 断言）
- `bash tests/d1-local-test.sh`：`D1 LOCAL TEST ALL OK`（旧库→v9、故障恢复、新库 up_to_date、真正空库→v9）
- 浏览器验收：48/48（CI，Playwright；同代码）
- CI 运行 38893207661（push，提交 `8288db0`）：Static / Regression / D1 迁移 / Browser 四项全部成功

**部署后验收（staging 真实执行，17/17 通过）**

- 前台 `GET /` 200，含“智选”。
- 管理员登录、改密（随机强密码，仅本次会话使用，验收后已重置为默认 `admin`、首次登录强制改密）、`me`、登出、登出后 `me` 401。
- 未登录访问 `/api/admin/orders` → 401。
- 创建测试商品（自营卡密）+ 导入测试卡密 2 张。
- 验证码解析 + 下单（BinanceUID，避开主网 RPC）成功；同一验证码重复使用被拒绝（一次性消费）。
- 订单号 + 查单凭证查单成功；`GET /api/orders` → 410（旧邮箱查单已关闭）；`GET` 单订单仅概要，无交付内容泄露。
- ProdSeller 门禁：对接商品下单被拦截（“该商品暂未开放购买（上游服务验证中）”），未发起真实采购。
- `/pay` 限流：同一订单前 5 次 200，第 6 次 429。
- 付款账本接口正常；404 返回“接口不存在”（脱敏）；500 响应为通用错误 + 关联 ID（不泄露 SQL/堆栈，见本轮 staging 500 实测）。
- 支付/履约：BinanceUID 订单走人工核对，未触发主网 RPC；`poll_enabled=0`，轮询不运行；`prodseller_enabled=0`，无真实采购。

**未执行项目及原因**

- 浏览器验收未在本 VM 对 staging URL 执行：Playwright Chromium 经代理隧道失败（`ERR_TUNNEL_CONNECTION_FAILED`），为本 VM 浏览器代理配置限制，非 staging 缺陷。同代码已在 CI 通过 48/48 浏览器验收；staging 前台已通过 curl + API 验收（17/17）验证。
- 真实链上收款、真实 ProdSeller 采购、真实 RPC 确认数/扫描游标/重组处理未验证（按任务要求未发起真实交易；见 §六）。

**决策矩阵（本轮真实证据）**

| 项 | 判定 | 依据 |
| --- | --- | --- |
| A. staging 是否已实际部署并可访问 | PASS | Worker 已上传、子域已启用、URL 可访问、迁移至 v9 |
| B. staging 是否通过部署后验收 | PASS | 部署后验收 17/17，隔离设置已验证 |
| C. PR 是否具备提交人工审查的条件 | PASS | 候选提交 `8288db0` CI 全绿 + 两项缺陷已修复并有回归断言；仅代表可进入人工审查，不代表自动合并 |
| D. 是否已经获得生产部署批准 | BLOCKED | 未获得生产部署批准，本轮不部署生产 |
| E. 是否可以开放真实客户销售 | BLOCKED | 真实链上收款未验证 |
| F. 是否可以启用真实链上收款 | BLOCKED | 真实链上测试未执行 |
| G. 是否可以启用 ProdSeller 自动采购与履约 | BLOCKED | 真实 ProdSeller 行为未验证，门禁保持关闭 |

**staging 管理员密码交接**：验收后已将 staging 管理员密码重置为默认 `admin`，首次登录强制改密。请尽快登录 staging 后台改为强密码。

## 九、第七轮：统一邮箱输入框、修复交付邮箱映射及 Staging 实际验收（2026-10-16，已部署并通过验收）

**代码提交**：`e450b0a`（功能分支 `feat/admin-overhaul-security`；仅修改功能分支，未合并 PR #1，未部署生产）
**CI**：push 运行 [38899010902](https://github.com/Newbee06/zhixuan-shop/actions/runs/38899010902)（Static / Regression / D1 迁移 / Browser 四项全部成功）；PR 运行 [38899018407](https://github.com/Newbee06/zhixuan-shop/actions/runs/38899018407) 同样全部成功。
**Staging 部署**：Worker `zhixuan-shop-staging`，部署后修改时间 `2026-10-16T12:16:10Z`（部署前 `11:22:43Z`）；D1 仍为独立 `zhixuan-shop-staging-db`（`4fb3878b…`），未动生产。

### 原始问题现象

商品详情页出现两个输入框：`联系方式（邮箱/TG）*` 与 `邮箱地址`。用户只在唯一的“邮箱地址”框填了合法邮箱，点击“立即购买”后仍看到：`请填写正确的交付邮箱 delivery_email（用于接收卡密/账号）`。

### 根因与代码证据

1. **重复字段**：详情页由两部分组成——商品 `form_fields` 动态渲染（历史商品含旧默认字段 `{ key:'contact', label:'联系方式（邮箱/TG）', required:true }`，渲染为第一个框）+ 硬编码 `邮箱地址` 输入框（`id="contact"`，第二个框）。
2. **映射缺失**：旧 `submitOrder` 只把 `cust`（`[data-k]` 收集，含旧 `cust.contact`）与顶层 `contact` 提交，从不设置 `customer_fields.delivery_email` / `contact_email`。
3. **后端无回退**：旧 `POST /api/orders` 中 `deliveryEmail = String(cust.delivery_email || '').trim()`，只读 `customer_fields.delivery_email`，无任何回退；自营卡密/成品号且 `delivery_method=email|both` 时 `deliveryEmail` 为空即拒绝。前端填了邮箱也必然失败。
4. **管理端重加旧字段**：新建/编辑商品保存时默认 `form_fields = [{ key:'contact', label:'联系方式（邮箱/TG）', required:true }]`，编辑历史商品时原样保留旧字段，旧字段不断再生。

### 改动内容

**`src/frontend.html`**
- 新增 `isLegacyContactField(f)`（`key + label` 精确匹配）与 `validEmail(s)`（与后端同一正则）。
- 详情页渲染动态字段时跳过旧字段；`邮箱地址` 改为 `邮箱地址 *`（`type="email"`）+ 辅助文案“用于订单联系；需要邮件交付的商品，也会使用该邮箱接收卡密或账号。”
- `submitOrder`：读唯一邮箱框并 trim；为空 / 格式错误时 toast 拦截不提交；统一设置 `cust.contact_email = emailValue`、`cust.delivery_email = emailValue`、`contact = emailValue`。
- 新建/编辑商品保存时不再自动加入旧字段；编辑历史商品时过滤掉旧字段（保留管理员其他自定义字段）。

**`src/worker.js`**
- 新增同名 `isLegacyContactField(f)`；动态必填校验跳过旧字段（历史商品不再因它必填而拒单）。
- 兼容回退：需要邮件交付且 `delivery_email` 为空时，若 `contact`（`contact_email` 或顶层 `contact`）为有效邮箱则回填 `delivery_email`；仅接受有效邮箱，Telegram 用户名等非邮箱文本不回填；仅对需要邮件交付的商品生效。
- 统一持久化：`contact_email` / `delivery_email` 以 trim 后规范化值落库，避免主表与 `customer_fields` 不一致。
- 邮件交付路径：`orderMailTo` 仍从已持久化订单读取（`delivery_email || contact_email || order.contact`）。注意：`sendEmail` 仍为 `email_removed` 存根（本轮未改动），实际交付以站内查单页为准；本轮验证的是“交付路径能从已保存订单取到正确收件人”，不是“真实邮件已发出”。

**不删除的数据**：历史商品 `form_fields` 中的旧字段仍保留在库中（仅渲染/校验时过滤），未删除 `orders.contact` 列，未清空已有订单数据。

### 新增测试与真实测试结果（本地）

- `npm run test:static`：通过（Worker 语法 + 前端脚本 2/2）。
- `npm run test:regression`：Mock 通过（`emails=0 upstreamCalls=10`）、库存 17/17、安全 98/98、并发 114/114、Release Readiness **90/90**（原 57 + 第七轮新增 33）。
  - 新增覆盖：旧客户端仅传顶层 `contact`（兼容回填成功 + 落库三字段一致）；旧 `cust.contact` 为空不再拒单；TG 用户名被拒；新客户端完整映射 + 自定义字段保留；首尾空格规范化；显式无效 `delivery_email` 仍被拒；`orderMailTo` 从持久化订单读正确收件人（提取真实函数，非复制逻辑）；人工商品不强制 `delivery_email`；激活类商品仍独立校验激活邮箱（缺失/不一致被拒、正确通过、激活邮箱与联系/交付邮箱分离）；`GET /api/orders?contact=` 仍 410；前端静态补充（旧默认不再自动加入、统一映射存在、渲染过滤存在、前端邮箱校验存在、旧标签只在匹配谓词中）。
- `bash tests/d1-local-test.sh`：`D1 LOCAL TEST ALL OK`。
- 浏览器验收（本地 Playwright + wrangler dev，`tests/browser-acceptance-ci.mjs`）：**64/64**（原 48 + 第七轮新增 16）。新增 6c 用例：创建含旧字段的历史卡密商品并导入卡密，访问详情页验证无旧字段、唯一邮箱框、自定义字段保留；真实点击“立即购买”，拦截请求验证载荷三字段映射且无旧 `cust.contact`；订单创建成功并验证落库一致。测试过程修掉两个测试自身缺陷（6b 抽屉遮挡按钮 → 进页后 Escape 关闭；`page.content()` 含 script 源码误报旧标签 → 改查 `innerText`），非放宽断言。

### Staging 实际验收（真实执行）

- 部署前核对：本地 HEAD = 部署候选 `e450b0a`（CI 全绿）；生产 Worker `aisou-lite` 修改时间仍为 `2026-10-16T04:03:50Z`，未动。
- 部署方式：同第六轮（Workers Script Upload API，multipart 上传 `worker.js` + `frontend.html`，D1 绑定明确指向 staging D1，子域显式启用，Schedules 保持 `0 2 * * *` + `*/1 * * * *`）。
- 隔离设置再验：`poll_enabled=0`、`prodseller_enabled=0`。
- **旧版载荷复验**：用旧客户端形态（`customer_fields:{}`，只传顶层 `contact`）对商品 11（历史旧字段、自营卡密、`delivery_method=both`）下单 → 成功，订单号 `AISMVAXMT9B27ACBF`。落库验证：`orders.contact`、`customer_fields.contact_email`、`customer_fields.delivery_email` 均为同一测试邮箱，无旧 `contact` 键；卡密已预留 1 张。
- **查单**：订单号 + 查单凭证查询成功（凭证字段为 `token`；前端查单用 `credential`，后端两者均接受）；`GET /api/orders?contact=` → 410；`GET` 单订单仅概要，无 `customer_fields`/`contact` 泄露。
- **真实浏览器验收**（live browser，虚构测试邮箱，未付款、未登录后台、未改设置）：
  - 商品 11：可见文字无“联系方式（邮箱/TG）”；标签“邮箱地址 *”+ 辅助文案正常；仅 1 个 `id=contact` 输入框。但商品 11 显示“缺货 · 补货中”、购买按钮禁用（因 API 订单已预留其唯一卡密，属正确库存行为），未发出下单请求，故浏览器侧无法验证该商品的错误文案。
  - 商品 1：同样页面检查通过；真实点击“立即购买”成功，跳转成功页，订单号 `AISMVAXQD9H01F68E`（`actual_amount=5.0057`，OKX · X Layer，未付款）。落库验证：三字段均为浏览器填写的测试邮箱，无旧 `contact` 键——以落库数据补齐了浏览器工具无法拦截请求体的缺口。
  - 浏览器工具限制（诚实记录）：该浏览器任务无 JS 执行与网络拦截能力，故未直接观测 POST 请求体与控制台；请求体证据来自本地 Playwright 拦截（64/64）+ Staging 落库数据；控制台零错误仅由本地 Playwright 验证，未由 staging 浏览器任务验证。
- VM 本地 Playwright 仍无法直连 staging URL（`ERR_TUNNEL_CONNECTION_FAILED`，直连/代理均失败，第六轮同款 VM 限制），故 staging 浏览器验收改走 live browser；同代码本地 Playwright 64/64。

### 未验证项目与残留风险

- 真实链上收款、真实 ProdSeller 采购、真实 RPC 确认数/游标/重组、真实邮件发送（邮件发送仍为存根）未验证。
- 浏览器任务观察到一次 SPA 导航残留：从商品 11 直接跳转 `#/product/1` 时页面短暂残留商品 11 表单内容，刷新后正确渲染。未确认为缺陷（可能是观察时机早于异步渲染完成），商品 1 订单最终成功；列为待观察项，未在本轮改动路由。
- **Staging 管理员密码状态变更**：本轮尝试用默认 `admin` 登录 staging 后台返回“密码错误”，说明用户已在第六轮提醒后改了密码（第六轮记录的“已重置为默认 admin”已过期）。本轮未尝试恢复、未索取新密码；需要后台操作请用户自行登录。

### 决策矩阵（本轮真实证据）

| 项 | 判定 | 依据 |
| --- | --- | --- |
| A. staging 是否已实际部署并可访问 | PASS | Worker 已上传（`12:16:10Z`）、子域启用、API 可访问 |
| B. staging 是否通过部署后验收 | PASS | 旧载荷下单成功 + 浏览器真实下单成功 + 落库三字段一致 |
| C. PR 是否具备提交人工审查的条件 | PASS | 提交 `e450b0a` CI 全绿 + 回归断言；仅代表可进入人工审查，不代表自动合并 |
| D. 是否已经获得生产部署批准 | BLOCKED | 未获得生产部署批准，本轮不部署生产 |
| E. 是否可以开放真实客户销售 | BLOCKED | 真实链上收款未验证 |
| F. 是否可以启用真实链上收款 | BLOCKED | 真实链上测试未执行 |
| G. 是否可以启用 ProdSeller 自动采购与履约 | BLOCKED | 真实 ProdSeller 行为未验证，门禁保持关闭 |

## 第八轮：全站 emoji 替换为简约线条图标（2026-10-16）

### 改动（提交 `4caf793`）

- 新增 `ICONS` 图标集（14 个 24×24 线条 SVG：shop/search/moon/sun/box/cart/book/clipboard/chart/receipt/card/link/settings/warn，stroke currentColor，`.ic` 统一截图蓝 `#5b7bff`）+ `ic()` 辅助。
- 替换全部彩色 emoji：顶部导航、主题切换、搜索框、商品图（3 处渲染）、详情页、付款/说明/须知标题、2 处警告框、后台 7 个标签页。
- `image_emoji` 由 emoji 字符改为图标 key（`'box'`）；`ic()` 对旧库里的 `🤖`/`📦` 自动回退为 box 图标，兼容已有数据；`worker.js` 3 处默认值同步为 `'box'`。
- 保留箭头/关闭 ✕/菜单 ☰ 等纯文本符号（非 emoji），不做范围外改动。
- 下单、付款、履约、上游逻辑零改动。

### 测试

- 本地：静态 + Release Readiness 90/90 + 浏览器 64/64。
- CI（push 38921527595）：四项全绿。
- 本地浏览器测试注意事项：需先 `wrangler d1 execute --local --file=schema.sql` 播种子数据，否则 `product/1` 不存在；本地 D1 残留待付款订单会导致联系方式冲突，删 `.wrangler/state` 后重跑通过。

### Staging 实际验收（真实执行）

- 部署方式：`cf_wrangler.py deploy --env staging`（`wrangler.toml` 的 `[env.staging]` 配置齐全，Worker 名/D1 绑定/cron 均指向 staging，与第六、七轮的 Script Upload API 等效；部署前删 `.wrangler` 防缓存陷阱）。
- 部署后版本 `d48f9d30`，Worker 修改时间 `2026-10-16T15:11:11Z`；生产 Worker `aisou-lite` 修改时间仍为 `2026-10-16T04:03:50Z`，未动。
- Staging 首页实测：含 17 处 `svg class="ic"`、0 个 emoji；`/api/config` 正常（`site_name=智选`、`cny_rate=7.2`）。
- 部署只换代码未动 D1，`poll_enabled=0`、`prodseller_enabled=0` 保持。
- 本轮未在 staging 新建测试订单：改动为纯 UI，下单链路零改动，本地浏览器 64/64 已覆盖完整下单流程；不在 staging 留多余待付款订单。

### 决策矩阵（本轮真实证据）

| 项 | 判定 | 依据 |
| --- | --- | --- |
| A. staging 是否已实际部署并可访问 | PASS | Worker 已部署（`15:11:11Z`）、新代码已生效（17 处 SVG、0 emoji） |
| B. staging 是否通过部署后验收 | PASS | 首页图标渲染正常 + 配置接口正常 + 本地完整流程 64/64 |
| C. PR 是否具备提交人工审查的条件 | PASS | 提交 `4caf793` CI 全绿；仅代表可进入人工审查，不代表自动合并 |
| D. 是否已经获得生产部署批准 | BLOCKED | 未获得生产部署批准，本轮不部署生产 |
| E. 是否可以开放真实客户销售 | BLOCKED | 真实链上收款未验证 |
| F. 是否可以启用真实链上收款 | BLOCKED | 真实链上测试未执行 |
| G. 是否可以启用 ProdSeller 自动采购与履约 | BLOCKED | 真实 ProdSeller 行为未验证，门禁保持关闭 |


## 第九轮：智选商城双链支付收口与收款安全修复（2026-10-17）

### 目标（用户明确授权范围）

新订单只允许两个支付组合：

1. `pay_method=OKX` + `pay_chain=X Layer`（USDT0）
2. `pay_method=Binance` + `pay_chain=BEP20`（Binance-Peg USDT）

明确禁止新订单：Plasma、OKX+BEP20、Binance+X Layer、TRC20、ERC20、`BinanceUID`+站内转账、未知方式/链/缺失字段。

历史订单、支付账本、旧设置不得删除或篡改；历史订单恢复能力保留。

本轮禁止：部署生产、合并 PR、访问/修改生产 D1、发起真实链上转账；不开启 `poll_enabled`/`prodseller_enabled`；不调用真实 ProdSeller 采购接口；不删除历史订单；不用修改历史数据绕过测试。

### 本轮发现的真实代码问题（修复前）

1. 服务端支付白名单过宽：`validPayCombo()` 只限制 `BinanceUID` 配站内转账，其他渠道可配任意非站内链；前端只显示 X Layer/BEP20，但可绕过前端直接 API 创建其他组合。
2. 无收款地址也能成功创建订单：下单读取 `addrMap[method|chain]` 未校验为空/格式非法。
3. 所有 EVM 链硬编码 6 位精度：BEP20 合约实际 18 位，原核验会漏认真实到账，并有把按 6 位构造的极小粉尘误当足额付款的风险。
4. 全局 EVM 游标仅按链保存：一条链多地址时，地址 A 推进的游标可能让地址 B 跳过较早区块，造成漏账。
5. 日志合约地址缺少二次严格校验：依赖 `eth_getLogs` 的 `address` 参数，未在遍历返回日志时再次比较 `log.address`。
6. 种子 `usdt_contracts` 的 X Layer 为占位符 `0xYOUR_XLAYER_USDT_CONTRACT`，会覆盖代码默认值且格式非法，导致 X Layer 核验 fail-closed。
7. Worker 完全信任 RPC 的 `fromBlock/toBlock` 过滤，未校验返回日志的区块是否在请求范围内（mock 不过滤时暴露）。

### 改动

**`src/worker.js`**
- 新增严格白名单 `PAY_WHITELIST = [['OKX','X Layer'], ['Binance','BEP20']]`；`PAY_METHODS`/`PAY_CHAINS` 从白名单派生；`validPayCombo()` 改为组合级明确白名单；API 拒绝文案仅支持“欧易 USDT0 · X Layer、币安 USDT · BEP20”。
- 下单时强制收款地址符合 `^0x[0-9a-fA-F]{40}$`，为空或非法直接拒绝，不创建订单。
- X Layer 默认合约改为 USDT0 `0x779Ded0c9e1022225f8E0630b35a9b54bE713736`（旧版 `0x1e4a...` 仅注释说明，不作为自动接受资产）。
- 新增 `getTokenDecimals()`（`eth_call decimals()`，失败 fail-closed）、`isValidEvmAddress()`、`amountToRaw()`/`rawToAmount()`（BigInt 精确换算）。
- `checkEvmPayment()`：合约/收款地址合法性、实际 decimals、BigInt 金额比较、`log.address` 二次校验、Transfer topic 与收款地址 topic 校验、确认数、区块范围校验、RPC 失败不认账。
- `checkTxidPayment()`：同上实际精度核验（receipt 路径已有确认数校验）。
- `scanEvmChain()`：同上收紧；游标键改为 `链|地址`（旧按链游标不删除、不再用于新扫描）；日志区块范围校验。
- 迁移 v10：仅替换 `usdt_contracts` 中精确占位符 `0xYOUR_XLAYER_USDT_CONTRACT` 为核实的 USDT0 合约；管理员已显式配置的任何其他合约一律不动。
- 设置校验提示更新为 `OKX|X Layer`、`Binance|BEP20`。

**`src/frontend.html`**
- X Layer 按钮改为“USDT0 · X Layer”；新增 `payTokenLabel()`；成功页新增防误转警告（X Layer 收款为 USDT0，旧版 USDT 与 USDT0 是不同资产，误转不自动发货）。
- 删除“币安 UID 站内转账填订单 ID”提示；后台设置说明更新为仅支持两个组合、旧键保留但新订单不使用、`binance_uid` 标记为历史订单恢复用途；后台新增 `chain_confirmations` 输入项；前端 JSON 校验加入 `chain_confirmations`；管理员确认付款示例不再用币安 UID 文案。

**`schema.sql`**
- `usdt_contracts` 种子 X Layer 改为核实的 USDT0 合约；`schema_migrations` 预置版本增至 10。

### 合约核实（证据等级说明）

- X Layer USDT0 `0x779Ded0c9e1022225f8E0630b35a9b54bE713736`、6 位精度：来自 2025-09-09 起 OKX/Tether 公开资料与多份二级报道/文档的交叉核对（搜索结果摘要、GitHub 文档）。尚未完成“直接打开 OKX/Tether/USDT0 官方资料 + X Layer RPC 只读查询 `chainId/decimals()/symbol()/name()`”的最终核对，文档结论标记为资料核验中，不得夸大为真实提币验证。
- BEP20 `0x55d398326f99059fF775485246999027B3197955`、18 位精度：BscScan 合约源码 `_decimals = 18`，名称/符号对应 Binance-Peg USDT / BSC-USD 体系。建议补做 BNB Smart Chain RPC 只读核验（Chain ID 56、`decimals()=18`），不发送交易。
- 真实链上验证（真实转账）仍 BLOCKED / NOT VERIFIED，只能安排在独立 Staging；本轮未部署 Staging。

### 测试（全部本地真实执行）

- 新测试 `tests/payment-whitelist-test.mjs`：65/65 PASS。覆盖：两个白名单组合下单、14 种非白名单组合拒绝、缺/畸形收款地址拒单、X Layer 只接受 USDT0（旧版不履约）、BEP20 错合约/粉尘/错地址/错金额不履约、管理员覆盖合约、未达确认数不发货、RPC 故障不推进游标、重复扫描不重复发卡/记账、游标按地址隔离、历史 TRC20/BinanceUID 订单恢复、前端 USDT0/BEP20 展示一致。
- 旧测试迁移（不削弱断言）：新订单组合改为白名单；需历史订单的 TRC20/ERC20/BinanceUID 场景改为直接插库历史订单；EVM mock 补 `eth_call`；mock-test 补 EVM mock（eth_call/eth_blockNumber/eth_getLogs，交易哈希按订单唯一，避免去重误杀）；浏览器测试在脚本开头经 HTTP 配置有效收款地址；d1-local 与各测试的版本断言由 v9 更新为 v10。
- 全量：`npm run test:static` PASS；`npm run test:regression` 全绿（mock 53、stock 17、security 98、concurrency 114、release-readiness 90、payment-whitelist 65）；`bash tests/d1-local-test.sh` PASS（旧库迁移 v10、去重、失败不标记、空库迁移）；`npm run test:browser` 64/64（本地 wrangler dev，`BASE=http://127.0.0.1:8791`）。
- `package.json` 的 `test:regression` 与 `.github/workflows/ci.yml` 已加入新测试。

### 决策矩阵（本轮真实证据）

| 项 | 判定 | 依据 |
| --- | --- | --- |
| A. staging 是否已实际部署并可访问 | BLOCKED | 本轮未部署 staging（代码与本地测试已通过，staging 部署待用户明确授权后独立进行） |
| B. staging 是否通过部署后验收 | BLOCKED | 未部署 staging |
| C. PR 是否具备提交人工审查的条件 | PASS（待 CI 验证） | 代码已提交至功能分支，CI 结果见 PR 页面；仅代表可进入人工审查，不代表自动合并 |
| D. 是否已经获得生产部署批准 | BLOCKED | 未获得生产部署批准，本轮不部署生产 |
| E. 是否可以开放真实客户销售 | BLOCKED | 真实链上收款未验证 |
| F. 是否可以启用真实链上收款 | BLOCKED | 真实链上测试未执行（仅 mock 核验） |
| G. 是否可以启用 ProdSeller 自动采购与履约 | BLOCKED | 真实 ProdSeller 行为未验证，门禁保持关闭 |


### CI 与推送（2026-10-17 00:47 CST 补记）

- 主提交 `0e31e6b`（代码+测试+文档）经 `gh` 推送成功；CI 提交 `95d6f26` 含 `.github/workflows/ci.yml`，`gh` 缺 `workflow` 权限被拒，改走 PAT（细粒度，仅限本仓库，Contents+Workflows 读写，经安全入口提交、用完即丢）经 Git Data API 推送，远端提交 `4462d60`，`git diff` 与本地逐字节一致，ci.yml blob SHA 一致。
- CI：push `38934786472` success、PR `38934792012` success；PR #1 仍 OPEN、MERGEABLE、CLEAN，未合并。
- PR #1 不合并、不部署生产；真实链上验证仍 BLOCKED / NOT VERIFIED。

## 第十轮：App 图标库（明/暗两版）+ 商品图片三选一（2026-10-17）

### 目标（用户授权）

- 找到生产店全部品牌（30 个：29 个生产品牌 + ChatGPT）的 iOS 图标，每 App 两张（明版/暗版），随主题切换。
- 添加商品表单加 App 选择框：选 App 图标 / 自己上传 / 不选（默认 📦 线条 logo）。
- 提交 GitHub、部署 zhixuan staging 测试；不部署生产。

### 图标来源与处理

- 24 个品牌：iTunes Search API 官方 App 图标（512×512，如 ChatGPT、Claude、多邻国、Gmail、Canva、Gemini、Notion、Figma、Spotify、Telegram、Cursor、iLovePDF、CapCut、Miro、edX、HBO Max、Apple TV、Scribd、ElevenLabs、Wispr Flow、Avira、Outlook、Adobe、Prime Video）。
- 6 个无 iOS App 的品牌用品牌 Logo 兜底：Codex（OpenAI favicon）、JetBrains（Wikimedia Logo）、Framer（favicon）、Muse AI（muse.ai favicon）、Autodesk（Wikimedia Logo）、Microsoft 365（Wikimedia 365 Logo）。Clearbit 兜底被拒后改用 Google favicon / Wikimedia。
- 处理：统一 160×160、iOS 圆角、JPEG；明版白底、暗版深色底（#1c1c1e）；近单色深色 Logo（Autodesk）在暗版反色为白，彩色 Logo 不反色。总 base64 约 282KB。

### 改动

**`src/worker.js`**
- 迁移 v11：新建 `app_icons(app_key, theme, name, image_data)`，`products` 加 `app_icon_key` 列，种子 60 行图标；现有商品按标题自动匹配 App 图标（仅空值时，幂等）。
- 新增公开 `GET /api/app-icons`（返回 `{key: {name, light, dark}}`，表不存在时返回空库不 500）。
- 商品列表/详情返回 `app_icon_key`；新建/编辑校验 `app_icon_key`（格式小写字母数字 + 必须在图标库中存在）；App 图标与上传图互斥（选图标则清空上传图）。
- 上游导入按标题自动匹配 App 图标（仅新导入时；重导入不覆盖人工选的图标）。
- `expectedTables` 加入 `app_icons` 与 `products.app_icon_key`。

**`src/frontend.html`**
- 启动加载 `/api/app-icons` 存 `APP_ICONS`；`appIconSrc(key)` 按当前主题取图；`productImgHtml()` 渲染优先级：App 图标 > 上传图 > 默认 📦；`refreshAppIcons()` 主题切换时更新全部 App 图标 `src`。
- 三处渲染（列表缩略图、商品卡、详情大图）均接入 App 图标。
- 商品表单“商品图片”改为三选一：App 图标（30 图标网格点选，当前主题预览）、自己上传（原有上传）、不选（默认 📦）；保存时按模式发送 `app_icon_key` / `image_data`。

### 测试（全部本地真实执行）

- 新测试 `tests/app-icons-test.mjs`：69/69 PASS（迁移 v11、图标库 30×2、标题自动匹配、新建/编辑三态切换、不传保留旧值、伪造 key 拒绝、上游导入匹配、前端选择器/主题切换）。
- 全量：`npm run test:static` PASS；`npm run test:regression` 全绿（mock、全量、stock 17、security 98、concurrency 114、release-readiness 90、whitelist 65、app-icons 69）；`bash tests/d1-local-test.sh` PASS（v11）；`npm run test:browser` 64/64。
- 本地 wrangler dev 实测：`/api/app-icons` 返回 30 App；种子商品（ChatGPT/Claude/Cursor 示例）已按标题自动匹配图标。
- 其他测试版本断言由 v10 升为 v11；concurrency/d1-local 的旧库剥离正则改为 `(11)` 可选（schema.sql 种子只到 v10，强制匹配会剥离失败）。

### 决策矩阵（本轮真实证据）

| 项 | 判定 | 依据 |
| --- | --- | --- |
| A. staging 是否已实际部署并可访问 | 待部署后补记 | 本轮代码已提交，staging 部署待执行 |
| B. staging 是否通过部署后验收 | 待部署后补记 | — |
| C. PR 是否具备提交人工审查的条件 | PASS（待 CI 验证） | 代码已提交至功能分支，CI 结果见 PR 页面；仅代表可进入人工审查，不代表自动合并 |
| D. 是否已经获得生产部署批准 | BLOCKED | 未获得生产部署批准，本轮不部署生产 |
| E. 是否可以开放真实客户销售 | BLOCKED | 真实链上收款未验证 |
| F. 是否可以启用真实链上收款 | BLOCKED | 真实链上测试未执行（仅 mock 核验） |
| G. 是否可以启用 ProdSeller 自动采购与履约 | BLOCKED | 真实 ProdSeller 行为未验证，门禁保持关闭 |

### Staging 验收与 CI（2026-10-17 09:40 CST 补记）

- 部署：`wrangler deploy --env staging` 成功，Worker `zhixuan-shop-staging`，版本 `f1463aed-ad81-403c-b95e-7e319e146e35`，上传 594.85 KiB / gzip 264.27 KiB。迁移 v11 在首次请求时自动执行，`/api/app-icons` 返回 30 App。
- 浏览器端到端验收（staging，全部通过）：管理员登录 → 新增商品 → 表单三选一（App 图标 / 自己上传 / 不选）→ 图标网格 30 个 → 选 Claude 保存（ID 12，slug p-mvbq8zse）→ 前台卡片渲染 `<img data-app-icon="claude">` → 主题切换时 img src 在明/暗版间切换 → 编辑改“不选”后恢复默认 📦 线条图标 → 删除测试商品，staging 恢复 11 个商品。未动其他商品，未动支付/订单。
- 说明：本地浏览器无法访问 127.0.0.1（浏览器工具拦回环地址，Cloudflare Tunnel 被网络拦），故验收在 staging 进行；staging 管理员密码由用户经安全入口提交，浏览器用保存的登录完成。
- CI：push `38985323892` success、PR `38985330274` success。PR #1 仍 OPEN，未合并，未部署生产。
- 决策矩阵更新：A staging 部署 PASS、B staging 验收 PASS、C PASS（CI 全绿）；D/E/F/G 仍 BLOCKED（未获生产部署批准、真实链上未验证）。

### 第十轮补丁：暗版图标 + 容器底色（2026-10-17 11:13 CST）

- 问题：用户截图反馈深色模式下图标仍是白方块。根因两层：① 7 个黑 Logo 白底图标（ChatGPT/Codex/Notion/CapCut/Cursor/ElevenLabs/iLovePDF）暗版未反色；5 个彩色 Logo 白底图标（Figma/Gemini/Gmail/edX/Outlook）暗版仍白底；② 卡片图片容器 `.pcard-img`（及 `.prod-img`、`.detail-img-photo`）硬编码白底，深色模式无覆盖，深色图标嵌在白方块里。
- 修复：① 7 个单色图标暗版整体反色（白底黑 Logo → 黑底白 Logo）；5 个彩色图标暗版选择性变换（仅近白像素映射深色，彩色 Logo 不动）；② CSS 加深色覆盖 `.pcard-img/.prod-img/.detail-img-photo` 背景 `#1c1c1e`。
- 关键坑：种子用 `INSERT OR IGNORE`，已有库的暗版不会被新种子覆盖；新增 v12 迁移（UPDATE 暗版 image_data），`APP_ICON_SEED` 提升为模块作用域供 v11/v12 共用。测试：app-icons 73/73（含 v12 刷新测试 + CSS 覆盖测试），回归全绿，d1-local 全绿。
- Staging 验证：v12 部署后 `/api/app-icons` 暗版中央亮度 Codex 0.34 / ChatGPT 0.36 / Gmail 0.33 / Figma 0.32；浏览器深色模式实测 `.pcard-img` 计算背景 rgb(28,28,30)，图标黑底白结，无白方块残留。
- PR #1 仍 OPEN，未合并，未部署生产。

### 第十轮补丁2：Telegram 暗版 + v13（2026-10-17 11:30 CST）

- 问题：Telegram 暗版在选择器里仍是白方块。根因：原图为蓝圈 + 白纸飞机 + 白底（白底占 52%），上轮修复未覆盖；且 v12 已在上一轮部署时标记已应用，种子更新后 v12 不重跑，staging 一直返回旧暗版。
- 修复：Telegram 暗版用泛洪填充去白底（仅与边框连通的白底映射深色，蓝圈与被蓝圈包住的白纸飞机保留）；新增 v13 迁移重新执行暗版 UPDATE（以后每次种子暗版变更都须追加新迁移版本，已应用的迁移不重跑）。测试：app-icons 76/76（含 v13 刷新测试），回归全绿，d1-local v13 全绿。
- Staging 验证：`/api/app-icons` Telegram 暗版边缘亮度 0.11（原 0.54），中心蓝色；浏览器选择器网格深色模式下 Telegram 为深色底 + 蓝圈 + 白纸飞机，非白方块。
- PR #1 仍 OPEN，未合并，未部署生产。

### 移动端商品编辑弹窗对齐 + 防横滑（2026-10-17 12:22 CST，用户实测确认）

- 对齐：商品编辑弹窗加 `fullBleed`，移动端（≤720px）去掉弹窗左右内边距，输入框（含底部说明框）撑满弹窗宽度与边缘对齐；标题与取消/保存按钮保持内缩。
- 防横滑：图标网格标签 `white-space:nowrap`（如 Microsoft 365）把网格撑到约 580px 超出弹窗，且 `.modal` 只写了 `overflow-y:auto`（另一轴按 CSS 规则算成 auto），弹窗可被横向划走、导致输入框与弹窗错位（实测差 250px）。修复：`.modal` 加 `overflow-x:hidden`，网格按钮加 `min-width:0`（标签正常省略号）。用户实测确认“可以了”。
- PR #1 仍 OPEN，未合并，未部署生产。

### 商品管理子目录：对接商品 / 自营商品（2026-10-17 12:30 CST）

- 左侧导航：商品管理下挂缩进子项“对接商品”（上游 prodseller）与“自营商品”（self），分开管理；父项在任一子目录下保持高亮。
- 子目录锁定来源筛选（工具栏无来源下拉），新增商品默认归属当前目录；切回“商品管理”全部视图时自动清掉残留来源筛选，显示全部商品。
- Staging 验证：对接商品 5 件全上游；自营商品 6 件全自营；商品管理显示全部 11 件（5 上游 + 6 自营），来源下拉为“全部来源”。未改任何数据。
- PR #1 仍 OPEN，未合并，未部署生产。

### 查单改 aisou.pro 方向：买家自设查询密码 + 邮箱/订单号查列表 + 按单密码取卡密（v14，2026-10-17 13:10 CST）
- 下单页新增“查询密码”（可选，只存 SHA-256 哈希，绝不存明文）；新订单不再生成系统查单凭证；成功页提示牢记自设密码。
- 查询页重做：订单号/邮箱 + 图形验证码 → 订单列表（不含交付内容）；卡密按单走 POST /api/orders/:no/secret 验密码（未设密码直接显示；按单+IP 10 分钟 5 次尝试限流）。
- 管理端订单详情加“清除查询密码”（忘密码客服兜底，记审计）。旧订单兼容：系统凭证/旧密码走老 /lookup；/secret 拒旧订单避免语义混淆。
- 测试：app-icons 99/99（含 19 项查单新流程）、security 100/100、concurrency 114/114、release 90/90、d1-local 全过。提交 2326266，已部署 staging。
- Staging 浏览器实测全部通过：订单 AISMVBXRPO98B06AF（邮箱 test-qf@example.com，密码 test1234），错密码报“查询密码错误”不显示卡密，正确密码显示 TEST-CARD-BROWSER-001；邮箱查询同样找到订单。测试站收款地址已填测试 dummy 地址（0x111…/0x222…），无真实资金。
- 事故：首个浏览器任务误跑到 aisou.pro（对标站）并建了未付款订单 112261017125907404（1.0246 USDT，未付款、未输密码），已关停该任务；订单超时自动取消。教训：浏览器任务须在任务文中写明“只许访问测试站域名，严禁其他站点”。

### 生产级修复总任务：v15（查询密码 salt + 支付收口删除 TRC20/ERC20，2026-10-17 晚）

- **P0 查单**：查询密码必填（6–64 位）；存储改为每订单随机 16 字节 salt + PBKDF2(100k) 哈希（与管理员密码同方案）；邮箱查询入口禁用（关键词含邮箱返回通用空结果）；列表/概要永不含 `delivery_content`（管理端列表改为 `summary` 级别）。
- **P0 /secret**：IP 限流 + 按单原子记数（`INSERT...SELECT...WHERE count < 5`，D1 串行化防并发绕过）；空密码 401；系统凭证订单 410；v14 无 salt 哈希订单 403 仅管理员流程；PBKDF2 校验失败通用 401。
- **P1 支付收口（用户拍板：只保留欧易 X Layer + 币安 BEP20）**：TRC20 代码全部删除（`checkTrc20Payment`、Tronscan 调用、`USDT_TRC20_ID`、`TRONSCAN_MAX_PAGES`）；ERC20 从合约/确认数/RPC 默认配置中删除；BinanceUID 站内转账支付路径删除（下单校验已拒，`/pay` 分支与钱包分支为死代码，一并删除）。白名单封堵四处：`checkChainPayment`、`checkTxidPayment`、`/pay`、 `scanEvmChain`（`PAY_CHAINS` 检查）。旧 TRC20/ERC20/站内转账订单不自动认账（轮询跳过、`/pay` 拒绝），只保留超时自动取消，转管理员人工处理。旧设置键保留不删。
- **修复**：下单 INSERT 占位符 19→20（加 salt 列时漏占位符，致下单 500，测试抓出）。
- **测试**：app-icons 107/107（含 v15 查单 25 项）、security 101/101、concurrency 114/114（含 §3b cron 单跑认领、A-04 BEP20 15 确认）、release 90/90、mock 全过、payment-whitelist 全过、stock 17/17。浏览器验收测试重写为新合同（下单设必填密码 → 成功页无 token → 查询页 /secret 正确/错误密码路径，邮箱查为空）。
- **审计**：订单状态机（全部条件 UPDATE + 已付款保护 + 退款不造假）、管理端鉴权（会话 7 天过期 + 改密拦截 + CSRF + 登录限流）均通过。
- **文档**：新增 docs/ARCHITECTURE.md、docs/SECURITY.md、docs/PAYMENT_FLOW.md、docs/PRODUCTION_CHECKLIST.md、docs/RUNBOOK.md；README 更新为 v15（删 TRC20/ERC20/BinanceUID/查单凭证/邮箱查询描述）。
- PR #1 仍 OPEN，未合并，未部署生产。真实链上验收仍 BLOCKED / NOT VERIFIED（无真实转账证据）。

### 浏览器验收实测（staging，2026-10-17 14:51–14:53 CST）+ 前端缺陷修复

- 首轮验收（订单 AISMVC1EW6345A2DC，staging 测试商品，¥36.00 约 5.00 USDT，OKX|X Layer，待付款，未真实付款）：首页/下单/成功页/查询列表/邮箱查为空/URL 无密码参数均通过。发现缺陷：未付款订单在查询列表里无密码输入框/查看卡密按钮，/secret 的“尚未付款”路径在 UI 上不可达。根因：doQueryList 的 else if 链把未付款订单挡在密码输入分支之外。
- 修复（提交 ac82de2）：状态提示与凭证输入解耦，未付款订单也显示密码输入框，买家可在付款前验证密码；/secret 对未付款订单返回“尚未付款”。app-icons 107/107、security 101/101 回归通过（worker.js 未变，其余套件结果继续有效）。已重部署 staging（Version 23b0da10）。
- 复验全部通过：查询列表出现密码输入框 + 查看卡密按钮；错密码 → “查询密码错误”；对密码 → “订单尚未付款或暂无交付内容”；URL 全程无 password=/token= 参数。
- 备注：首轮下单时商品 2、4（staging 对接商品）提示“上游服务验证中”无法下单，为 prodseller_enabled=0 门禁预期行为，非缺陷。

### 最终合并前验收（2026-10-17 晚，HEAD 62d8797）
- PR #1：OPEN、MERGEABLE、CLEAN，57 提交，CI 四 Job 全绿（review-fixes 262/262、browser 76/76）。
- Staging：备份成功，部署 Version 375c8e5e，浏览器 + API 端到端验收通过（详见 docs/CODE_REVIEW_2026-10-17.md“最终合并前验收”）。
- 结论：代码与 CI PASS、Staging 部署 PASS、Staging 验收 PASS；真实链上支付 NOT VERIFIED、P1-11 BLOCKED。
- 建议合 PR #1（仍需用户授权）；合并 ≠ 可部署生产 ≠ 可开放真实销售。生产真实收款地址、真实链上小额验收、ProdSeller 真实密钥仍 BLOCKED。

---

## 附录：本次整改（2026-10-18，分支 `fix/review-findings-2026-10-18`，仅文档）

本附录只改文档（`docs/` + 根目录 `README.md`），不改代码/测试/迁移/CI，不 commit、不 push、不部署、不碰生产。文档结论以代码为准：编写前已实际阅读 `src/worker.js` 与 `src/frontend.html` 核对（见“核验口径”）。

### 审查发现（文档与代码不一致处）

| 编号 | 旧文档表述 | 代码事实 | 处理 |
|---|---|---|---|
| P1-6 | “邮箱不是查询凭证”“查单仅按订单号”“邮箱查单已关闭” | `POST /api/orders/query` 已实现订单号/邮箱双查：关键词含 `@` 按邮箱精确匹配（大小写不敏感），匹配键为订单号 OR `LOWER(contact)` OR `LOWER(customer_fields.contact_email)`；`activation_email` 不是查询键 | 文档改写为双查口径；历史章节不改写，以本附录为准 |
| P1-6 | 未说明邮箱查单的隐私含义 | 邮箱 + 图形验证码 ≠ 所有权证明；知邮箱可枚举订单概要 | 文档新增隐私风险说明与最小化响应清单；邮件 OTP 未实现，不得声称可用 |
| P1-6 | `GET /api/orders` 410 文案称“邮箱查单已关闭” | 目标文案应为“旧接口停用，请用订单号或下单邮箱+验证码走当前查单流程”；**`src/worker.js` 中的 410 文案仍是旧文案** | 文档写目标文案；**需协调人改 worker.js 410 文案**（本文档不改代码） |
| P1-7 | “审计写入失败时操作返回 500” | 代码返回 `ok:true` + `audit_failed:true` + `warning`，业务已提交 | 文档改写为“不得改回 500，不得重复操作，立即核查 `admin_audit` 并手动补记” |
| P3-11 | 未说明 `pay_address` 例外 | 代码仅对 `pending_payment` 订单在查单列表附带 `pay_address` | 文档新增例外说明（见 `docs/PAYMENT_FLOW.md`） |
| P3-8 | 文档中无“名称 10px、介绍 8px”数值注释（已全库检索确认）；但外部流传的该组数值与代码不符 | 真实 CSS 见 `docs/ARCHITECTURE.md`“前端商品卡字号”表（商品卡名称 16px / 介绍 13px / 价格 24px / 按钮 14px / 箭头 18px，图区 `aspect-ratio: 4/3`，全视口同一值） | 文档新增真实值对照表，不改设计 |
| 其他 | `docs/SECURITY.md` 称“`/pay` 无验证码” | 代码 `/pay` 已调 `verifyCaptcha`（图形验证码 + 独立限流） | 文档已更正 |
| 残余（代码侧，未改） | 前端查单页文案仍称“邮箱不能作为查询凭证”（`src/frontend.html` 查单页） | 后端已支持邮箱双查，前端 `doQueryList` 亦接受邮箱关键词；该文案与行为矛盾 | **需协调人安排代码侧修正前端文案**（本文档不改代码） |

`docs/PR_REVIEW.md`、`docs/CODE_REVIEW_2026-10-17.md` 为历史记录，本次未改写；其中与本附录冲突的旧表述以本附录为准。

### 修改内容

- `docs/SECURITY.md`：查单双查口径 + 隐私风险 + 响应最小化 + 邮件 OTP 未实现 + 410 目标文案（附代码待办）；审计失败 `ok:true` + `audit_failed:true`；`/pay` 验证码更正。
- `docs/ARCHITECTURE.md`：查单与凭证章节改写为双查口径；新增前端商品卡字号真实值对照表（P3-8）。
- `docs/RUNBOOK.md`：审计失败行改写（不得重复操作、核查并手动补记）；新增 410 排查行。
- `docs/PAYMENT_FLOW.md`：新增“查单列表 pay_address 例外（P3-11）”。
- `README.md`：查询页、`/query` API 表、本地校验安全专项三处“邮箱不是查询凭证”改写为双查口径。
- 本附录：审查发现、修改内容、BLOCKED 项、PR 状态、核验口径。

### 仍 BLOCKED / 未验证（未声称完成）

- **P1-11 真实上游幂等仍 BLOCKED**：`Idempotency-Key` 重放语义无真实服务商证据；绝不调用真实 ProdSeller 接口，未验证。
- **双链真实付款未验证（NOT VERIFIED）**：OKX|X Layer 与 Binance|BEP20 均无真实转账证据；真实链上小额验收、真实收款地址配置仍待执行。
- **ProdSeller 自动采购关闭**：`prodseller_enabled` 门禁默认关闭，未提供证据前不得开启；真实幂等继续 BLOCKED。
- 支付只保留 OKX|X Layer + Binance|BEP20；TRC20 / ERC20 / 站内转账代码已删，旧订单不自动认账。

### PR 状态

- **PR #1：已合并**（本地 `git log` 可见合并提交 `7a71ca4` “Merge pull request #1”）。
- **PR #2：TODO（协调人填）**：分支 `fix/mobile-hero-collection-title` 存在，PR 是否仍开放须协调人在 GitHub 核实后填写。
- **本次新 PR：TODO（协调人填）**：分支 `fix/review-findings-2026-10-18` 的新 PR 链接、状态由协调人填写。

### 核验口径（代码验证 vs 本地 Mock vs 真实 Staging，三者不得混同）

| 层级 | 含义 | 本次状态 |
|---|---|---|
| 代码验证 | 实际阅读 `src/worker.js` / `src/frontend.html` 核对行为与文案 | ✅ 本次已做（文档结论的唯一依据） |
| 本地 Mock | 本地测试用 mock fetch 模拟 ProdSeller / EVM RPC，未调任何真实接口 | TODO（协调人填：测试数量、命令与退出码；不得编造数字） |
| 真实 Staging | 已部署的 Staging Worker + 独立 Staging D1 + 真实浏览器/API 验收，仍不发起真实链上转账 | TODO（协调人填：CI 结果、Staging 部署与验收证据、最新 SHA、PR 链接） |

CI 结果、Staging 部署与验收证据、最新 SHA、PR 链接一律留 TODO 给协调人填，本文档不预填任何数字或链接。
