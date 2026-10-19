# Cloudflare 免费层审计（智选商城 / zhixuan-shop）

| 字段 | 值 |
|---|---|
| 核验日期 | **2026-10-19**（Asia/Shanghai，UTC+8） |
| 审计 tip | `fix/txid-race-safety-2026-10-18`（比裸 `main` 更接近支付安全基线；含迁移 v16–v18） |
| 审计方式 | 只读：官方文档 WebFetch + 仓库代码 / `wrangler.toml` / migrations；**未**登录 Cloudflare Dashboard，**未**部署、**未**查询生产 D1 体积或 Workers Analytics |
| 结论总览 | 空闲与轻量流量下可落在 Free 内；**CPU 10ms** 与 **滥用刷请求** 是主要风险；不得用缓存替代付款核验 |

**证据类型图例**

| 标记 | 含义 |
|---|---|
| **实测** | 本仓库文件内容可直接核对 |
| **估算** | 由代码路径与官方限额推导，非 Dashboard 实数 |
| **未验证** | 需所有者 Dashboard / 线上日志 / 生产 D1 查询才能确认 |

---

## 1. 官方限额摘录（核验日 2026-10-19）

### 1.1 Workers Free

来源：[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)（文档 Last updated Oct 12, 2026）、[Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)（Last updated Oct 2, 2026）

| 项目 | Free | 对本项目含义 |
|---|---|---|
| 请求量 | **100,000 / 天**（UTC 午夜重置） | 超限 → Error **1027** |
| CPU / HTTP | **10 ms** / 调用 | PBKDF2(100k)、大 JSON 序列化最吃紧 |
| CPU / Cron | **10 ms** / 调用 | 有待付款时扫链 + D1 批量最吃紧 |
| 内存 | 128 MB / isolate | 一般够用；勿一次缓冲超大响应 |
| Subrequests | **50** / 调用 | 含 `fetch`、D1 等；链上 RPC 分页须控页数 |
| Cron Triggers / 账号 | **5** | 生产 2 + staging 2 = 4，余量 1 |
| Workers / 账号 | 100 | 当前 2（生产+staging） |
| 静态资源请求 | Pricing 脚注：Workers Static Assets **免费且不限** | **本项目未用 Static Assets**；HTML 经 Worker `import` 返回，**计入** 100k |

### 1.2 D1 Free

来源：[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)（Last updated Apr 21, 2026）、[D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)（同日）

| 项目 | Free | 对本项目含义 |
|---|---|---|
| 单库大小 | **500 MB** | 卡密明文、`app_icons` base64、审计表会涨 |
| 账号库数 | 10 | 生产+staging = 2 |
| 账号存储合计 | 5 GB | 与单库 500MB 同时约束 |
| 行读 | **500 万 / 天** | 全表扫无索引时易暴涨 |
| 行写 | **10 万 / 天** | 下单/限流表/轮询写 `last_checked_at` |
| 每次 Worker 调用查询次数 | **50**（Paid 为 1000） | Cron 有积压时易逼近 |
| 单条 SQL 时长 | 30 s | 一般够 |
| Time Travel | 7 天 | 误删恢复窗口短 |

---

## 2. 仓库实测配置

### 2.1 `wrangler.toml`（实测）

| 环境 | Worker | D1 binding | database_id | Cron |
|---|---|---|---|---|
| 生产（顶层） | `aisou-lite` | `aisou-lite-db` | `c492fc6c-23d3-4c16-8c49-5a1a3cdf680c` | `0 2 * * *`、`*/1 * * * *` |
| staging | `zhixuan-shop-staging` | `zhixuan-shop-staging-db` | `4fb3878b-02bf-4cac-b833-716c050242e6` | 同上 |

- `compatibility_date = "2024-01-01"`（偏旧；升日可能改变运行时行为，须回归后再改）。
- **无** R2 / KV / Queues / Durable Objects 绑定。
- 密钥走 `wrangler secret`（`PRODSELLER_API_KEY` 等）；注释仍提 `RESEND_API_KEY`，但 `ARCHITECTURE.md` 写明邮件已移除——**勿为邮件再开付费**。
- staging 与生产 **D1 与 Worker 名均分离**（隔离 PASS，见 `COST_GUARDRAILS.md`）。

### 2.2 运行时路径（实测，tip 分支）

| 路径 | 行为 |
|---|---|
| `scheduled` `*/1` | `runPolling` + `pollUpstreamActivations` |
| `scheduled` `0 2 * * *` | `cleanupExpired` + `pollUpstreamActivations` |
| `runPolling` | 先 `expireUnpaidOrders`；`poll_enabled=0` 时 **零 RPC**；无 `pending_payment` 时「zero RPC」 |
| 链上扫描 | `scan_cursors` 游标；`EVM_SCAN_PAGE_BLOCKS=1000`；RPC 失败不推进游标 |
| 前端 | `import FRONTEND_HTML from './frontend.html'`；`cache-control: no-store` |
| 前端轮询 | **无** 订单状态 API `setInterval`；仅本地倒计时 `setInterval(tick, 1000)` |

### 2.3 限流与防滥用（实测常量）

| 机制 | 常量 | 窗口 |
|---|---|---|
| 下单 | `ORDER_RATE_LIMIT=10` / IP | 10 分钟 |
| 查单/取密 | `LOOKUP_RATE_LIMIT=30` / IP | 10 分钟 |
| `/pay` | 订单 5 次、IP 20 次 | 10 分钟 |
| 登录 | IP 5 失败封 15 分钟；全局 30 失败 / 15 分钟 | — |
| 验证码 | 最多 3 次尝试；TTL 5 分钟 | — |
| Turnstile | 可选；密钥缺失 fail-closed | — |

---

## 3. 容量与剩余空间（估算）

### 3.1 Workers 请求

| 项 | 计算 | 类型 |
|---|---|---|
| 生产 cron 基线 | \(1440 + 1 = 1441\) 次/天 | 估算 |
| staging 若同时跑 cron | 再 +1441 | 估算；staging 是否在线 **未验证** |
| 占总额度 | \(1441 / 100000 \approx 1.4\%\)（仅生产 cron） | 估算 |
| 剩余给 HTTP | 约 **9.8 万**（仅扣生产 cron） | 估算 |
| 首页每次访问 | 1 次 Worker（非 Static Assets） | 实测路径 |

**滥用面**：无 CDN 缓存的 HTML + 公开 `/api/products`、`/api/captcha`、查单接口可被刷满 10 万 → 合法用户 1027。限流主要护写操作，**GET 公开读未全局限流**（见 `USAGE_BUDGET.md`）。

### 3.2 CPU 10ms

| 场景 | 风险 | 类型 |
|---|---|---|
| 空闲 cron（仅查 pending 为空） | 低 | 估算 |
| 管理员登录 / `/secret` / 下单写查询密码 | **高**：`PBKDF2_ITERATIONS=100000` | 实测常量；耗时 **未验证**（需 DevTools/日志 `cpuTime`） |
| 有积压时 cron：最多 100 笔 pending + `eth_getLogs` 分页 | **高**：CPU + subrequest 50 | 估算 |
| `ensureMigrated` 每请求轻量版本检查 | 低（已非全量迁移） | 实测注释 |

**不得**为省 CPU 降低确认数、跳过金额匹配、用缓存冒充已付款。

### 3.3 D1

| 项 | 说明 | 类型 |
|---|---|---|
| 生产库体积 | Dashboard / 体积查询 | **未验证** |
| 行读日额 | 空闲 cron：每分钟数次索引查询，通常远低于 500 万 | 估算 |
| 行写日额 | cron 推进 `last_checked_at`、限流表 INSERT；高峰下单吃 10 万写 | 估算 |
| 50 查询/调用 | `runPolling` 对每笔 pending 多次 prepare；积压时须控批（当前 LIMIT 100） | 估算 |
| 索引 | v1–v18 含 `idx_orders_status`、`idx_payments_*`、`scan_cursors` 等 | tip **实测**；`main` 是否已含 v16–v18 **取决于是否合并 PR #3/#4** |

---

## 4. 按任务核对清单

| # | 任务 | 状态 | 摘要 |
|---|---|---|---|
| 1 | Workers 请求与 CPU 预算 | **PASS**（文档层） | 见上；实数 **NOT VERIFIED** |
| 2 | D1 行读/写/存储 | **PASS**（限额）+ **NOT VERIFIED**（体积） | 见 `CAPACITY_MODEL.md` |
| 3 | Cron 频率与开销 | **PASS** | 2 条；空闲零 RPC；有单才扫链 |
| 4 | 静态资源 / 索引 / 分页 / 前端轮询 | **PASS** / 风险 | HTML 计入请求；管理端 `page_size≤100`；前端无 API 轮询 |
| 5 | 链上增量扫描 / 游标 / 重试 | **PASS**（设计） | 失败不推进；公开 RPC；无付费 RPC |
| 6 | 恶意访问与额度 | **FAIL 风险**（防刷不完整） | 写路径有限流；读路径可打满 100k |
| 7 | 用量统计与预警 | **BLOCKED** 待建 | 见 `OBSERVABILITY.md`（无 Dashboard 权限） |
| 8 | 测试/生产隔离 | **PASS** | 独立 Worker + D1 + triggers |

---

## 5. 明确不做 / 不做的理由

- **不**建议关闭 `runPolling` 付款核验、审计写入、库存预留来「省额度」。
- **不**建议用 KV/Cache API 缓存「已付款」状态替代链上/账本核验。
- **不**在未经所有者批准时升级 Workers Paid、购买付费 RPC、启用 Logpush（Paid）等。
- 若 Free 在真实流量下不够：在 `COST_GUARDRAILS.md` 列出需批准的替代方案，**不得默默关功能**。

---

## 6. 建议基准与后续（供 CTO）

1. 合入 PR #3 → #4 后再以 tip 为支付/容量审计基线（与安全 Bot 一致）。
2. 所有者在 1:1 授权 Cloudflare 只读或贴：Workers 日请求、CPU p99、D1 体积与行读/写、Error 1027/1102 历史。
3. 文档落地后，基础设施变更（如 HTML 改 Static Assets、`cache-control`、cron 降频）须 CTO 审查 + 所有者批准后单独 PR，**禁止本审计 PR 改 `src/` 或部署生产**。

---

## 7. 来源脚注

1. https://developers.cloudflare.com/workers/platform/limits/ — Workers Free 限额（核验 2026-10-19）
2. https://developers.cloudflare.com/workers/platform/pricing/ — 请求/CPU/静态资源计费说明
3. https://developers.cloudflare.com/d1/platform/limits/ — D1 库大小与 50 查询/调用
4. https://developers.cloudflare.com/d1/platform/pricing/ — D1 行读 500 万/天、行写 10 万/天
5. 仓库：`wrangler.toml`、`src/worker.js`（tip）、`docs/ARCHITECTURE.md`、`migrations/0016`–`0018`
