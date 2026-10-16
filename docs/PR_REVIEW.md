# PR #1 第三轮质量验收 — 复审与修复记录（+ 第四轮上线阻塞项整改）

- PR：https://github.com/Newbee06/zhixuan-shop/pull/1
- 分支：`feat/admin-overhaul-security` → `main`
- 日期：2026-10-16（第三轮）+ 第四轮（Release Readiness，见 §八）
- 状态：PR open，未合并，未部署，未访问/修改生产数据。
- 上线就绪报告：`docs/RELEASE_READINESS.md`（第四轮判定：A 预发布 CONDITIONAL / B 公开销售 BLOCKED / C 真实付款+自动履约 BLOCKED）。

## 一、复审类型与范围

**复审类型：同一 Agent 的新一轮独立复核（非第三方独立审计）。** 复审者未参与本轮代码编写，但与修复者为同一 Agent 体系，结论不具备第三方独立审计的效力。

复审方式：只读检查 `feat/admin-overhaul-security` 相对 `main` 的真实差异（`git diff origin/main...HEAD`），实际阅读 `src/worker.js`、`src/frontend.html`、`schema.sql`、迁移 v1–v7、测试与 Wrangler 配置。**未运行测试**，仅基于代码报告问题。修复由另一轮工作完成，每项修复均经代码核实 + 正式回归断言验证（非仅复审者口头确认）。

## 二、复审发现汇总

| 级别 | 数量 | 处理 |
|---|---|---|
| Critical | 0 | — |
| High | 2 | 全部修复 + 回归断言 |
| Medium | 12 | 8 项修复 + 回归断言；4 项明确记录为未修复/设计限制 |
| Low | 11 | 全部记录为未修复（见第三节） |
| 当前环境无法验证 | 5 | 明确记录，不得写成通过 |
| 测试覆盖缺口 | 4 | 已补关键回归（F-01、A-02、A-03、A-04、B-01、C-01、C-02、E-03、F-02） |

## 三、已修复（High 2 + Medium 8）

### High

**F-01 — 管理员订单详情存储型 XSS。** `src/frontend.html` 约第 814 行：`delivery_content` 经 `JSON.stringify()` 后直接拼入 `onclick`，上游返回含引号的交付内容可突破 HTML 属性，在管理员同源上下文执行 JS。修复：`escH(JSON.stringify(o.delivery_content))`。回归：浏览器测试 §6b，恶意载荷 `XSS-TEST" onclick="alert(1) //`，点击“复制交付内容”无 dialog 触发。

**A-01 — 管理员确认收款会认领未经链上核验的 TXID。** `src/worker.js` 的 `fulfillAfterPayment()`：`txVerified` 只赋值不使用，管理员确认传 `{ txVerified: false }` 但任意 64 位哈希仍进入 `txid_claims`，错误 TXID 可永久污染唯一认领表。修复：仅 `isChainHash && txVerified` 才 `claimTxid`；轮询和 `/pay` 已核验路径仍认领；管理员人工确认不再认领未核验 TXID。回归：并发测试 §5/§5b（87 项基线时已验证）。

### Medium

| 编号 | 问题 | 修复 | 回归 |
|---|---|---|---|
| A-02 | 未付款订单可被异常接口标为 `refund_pending`（制造幽灵退款义务） | `refund_needed=true` 时仅允许已付款订单（`paid_at` 非空且状态为待履约类）；未付款订单拒绝 | 安全测试 A-02×3 |
| A-03 | 付款租约接管时新 TXID 覆盖订单 `tx_hash`，旧认领成孤儿 | `claimOrderForPayment` 覆盖 `tx_hash` 时释放属于本订单的旧 TXID 认领 | 并发测试 A-03×4 |
| A-04 | EVM `/pay` 接受交易收据但未统一要求至少 1 确认 | 第三轮：`/pay` 的 EVM 核验增加 `eth_blockNumber` 检查：收据区块必须 `<= 最新区块 - 1`。**第四轮升级为各链确认策略**（ERC20 12、BEP20 15、X Layer 1、TRC20 19，可经 `settings.chain_confirmations` 覆盖），不再全链 1 确认 | 并发测试 A-04（第四轮更新：0/11 确认延迟，12 确认接受） |
| B-01 | `releaseStaleReservations` 会释放非 `pending_payment` 订单的预留，包括已付款待发货订单 | 仅释放终态（已取消/已完成）订单的预留 | 并发测试 B-01×3 |
| C-01 | 管理员“重试单笔上游订单”实际调用全局轮询，可能处理全部待处理订单，审计只记指定订单 | `pollUpstreamActivations(env, ctx, { orderId })`，重试端点只处理指定订单；Cron 不传参数仍处理全部 | 并发测试 C-01×6 |
| C-02 | Tronscan 只取共享地址最新 50 笔，忙时可能漏到账 | 第三轮：按 `start` 偏移分页（最多 10 页）；页内最旧时间早于订单创建时间即停。**第四轮：上限 10→20 页（1000 笔），命中上限记警告，不得静默漏账** | 并发测试 C-02×2（匹配在第 2 页） |
| E-03 | 公开概要可能泄露 `refund_ref`、`exception_reason`、`upstream_lock` 等内部字段 | `sanitizeOrderForPublic` 的 `summary` 与 `full` 均删除上述字段；`refund_status` 保留 | 安全测试 E-03×4 |
| F-02 | 管理员可改写 `prodseller_base_url`，随后 Worker 可能把 ProdSeller API Key 发往该地址 | 设置接口仅允许官方域名 `https://prodseller.com/`；自定义端点须经环境变量 `PRODSELLER_BASE_URL` | 安全测试 F-02×2 |

## 四、第四轮已修复（A-05 + D-01 + E-01 + E-02 + Low 11）

第四轮（Release Readiness）基于真实代码修复生产上线阻塞项，新增迁移 v8。详见 `docs/RELEASE_READINESS.md`。

### Medium（4 项，第四轮已修复）

- **A-05**：新增 `payments` 付款账本（迁移 v8），状态机 `submitted→discovered→verified→confirmed→posted`，
  异常 `duplicate/mismatch/unmatched/reconciled`；唯一键 `(chain, tx_hash, event_key)` 防重复入账；同一订单可多笔付款；
  管理端 `GET /api/admin/payments` + `POST /api/admin/payments/:id/reconcile`。回归：`tests/release-readiness-test.mjs` §1/§2/§3/§14。
- **D-01**：唯一权威来源为 `src/worker.js` 的 `MIGRATIONS` 数组；`migrations/*.sql` 为只读镜像，不得直接执行；
  新增 `GET /api/admin/schema-check` 只读预检（表/列/索引/唯一约束/重复金额）；版本标记改 `INSERT OR IGNORE`。
  回归：`tests/release-readiness-test.mjs` §7 + D1 迁移测试（旧库→v8）。
- **E-01**：验证码并发重放已修复（成功路径原子 `DELETE WHERE id + code_hash` 认领）；评估并可选接入 Cloudflare Turnstile
  （服务端 `siteverify` 校验，密钥缺失 fail-closed，服务不可用拒绝；密钥经环境变量 `TURNSTILE_SECRET_KEY`）。
  回归：`tests/release-readiness-test.mjs` §9（Mock 成功/失败/密钥缺失）+ §13（并发重放仅一个成功）。
- **E-02**：邮箱查单已关闭（`GET /api/orders?contact=` 返回 410），统一入口为订单号 + 查单凭证；
  前端查单页已移除邮箱查单 UI；无邮箱 OTP 兼容路径（邮件已移除）。回归：`tests/release-readiness-test.mjs` §8 + 安全测试邮箱查单 410。

### Low（11 项，第四轮全部已修复）

精确金额随机兜底未再次查重 → 部分唯一索引 + INSERT 重试 + 50 次查重；UPSERT 空值覆盖 → `CASE WHEN` 空值保护；
EVM 日志只回溯 200 区块 → 游标 + 分页 + 全局扫描；上游限速未覆盖履约调用 → 履约调用 300/15min；
首批并发请求迁移可能短暂 500 → 版本标记 `INSERT OR IGNORE`；历史迁移验证缺口 → `schema-check` 预检；
验证码并发重放 → 原子 DELETE 认领；同联系方式下单去重 TOCTOU → 部分唯一索引；
`/pay` 无独立限流 → `pay_rate`（订单 5/10min + IP 20/10min）；顶层 500 泄露 DB 错误 → 通用错误 + 关联 ID；
登录限流仅按 IP → 全局限流（全站 15 分钟失败超 30 次时全部登录拒绝 5 分钟）。

## 五、未修复 / 已知限制（明确记录，不粉饰）

### 当前环境无法验证（5 项，不得写成通过）

ProdSeller 是否真正支持 `Idempotency-Key = order_no`；ProdSeller 真实状态枚举和错误语义；真实链上确认、重组及 RPC 行为；生产 D1 实际迁移记录/运行时变更状态；生产库是否真正具备 `cards.UNIQUE(product_id, code)`、`products.slug UNIQUE`。

第四轮新增门禁 `prodseller_enabled`（默认 0 关闭）：在提供上述真实证据前，上游商品禁止下单与真实采购。

## 六、测试结果（第三轮 + 第四轮，本地）

| 测试 | 结果 |
|---|---|
| Worker 语法 + 前端内嵌脚本 | 通过（2/2） |
| Mock 全链路 | 通过（`emails=0 upstreamCalls=10`） |
| 库存 | 17/17 |
| 安全 | 98/98（第三轮 97/97 + 第四轮邮箱查单 410、门禁、版本 8） |
| 并发 | 114/114（第三轮 107/107 + 第四轮 A-04 12 确认、迁移 500 脱敏、v8 检查） |
| D1 本地迁移 | 通过（旧库 → v8，数据保留；新库 up_to_date；故障恢复验证） |
| 浏览器验收（Playwright Chromium，本地 wrangler dev） | 48/48，视口 1440/390/360，深色模式 |
| 第四轮专项（Release Readiness） | 53/53（付款账本、金额唯一、游标、UPSERT、预检、Turnstile、限流、脱敏、门禁、故障） |

CI（GitHub Actions，`.github/workflows/ci.yml`）待推送后对最终提交真实运行，须逐个核查 Static / Regression / Migration / Browser Jobs，禁止以本地结果代替 CI 结果。

## 六、CI 工作流

文件：`.github/workflows/ci.yml`。触发：PR 目标为 `main`、推送到 `feat/admin-overhaul-security`、`workflow_dispatch`。安全设置：`permissions: contents: read`，无 `pull_request_target`，无 `continue-on-error`，并发控制取消同一 PR 的旧运行，无生产部署或远程 D1 写操作。

Jobs：Static checks（语法/密钥扫描/远程生产写命令扫描）→ Business regression tests（Mock/Stock/Security/Concurrency/Release-Readiness）→ D1 migration test（local only）→ Browser acceptance（Playwright 真实浏览器）。

## 七、剩余风险

- 真实 ProdSeller、真实链上、生产迁移均未验证（见第五节），上线前须在测试环境真实验证。ProdSeller 门禁默认关闭，未提供证据前不得开启。
- 第四轮后 Medium 12 + Low 11 全部已修复（见第三、四节）；剩余风险为第五节“当前环境无法验证”5 项，不得写成通过。
- 上线判定见 `docs/RELEASE_READINESS.md`：A 预发布 CONDITIONAL / B 公开销售 BLOCKED / C 真实付款+自动履约 BLOCKED。
- 本轮未部署、未合并、未访问/修改生产数据；线上仍跑旧版 `main`。
