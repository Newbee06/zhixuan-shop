# 智选商城 — 上线就绪报告（Release Readiness，第四轮）

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
