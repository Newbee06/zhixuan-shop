# 容量模型（Capacity Model）

| 字段 | 值 |
|---|---|
| 核验日期 | **2026-10-19**（Asia/Shanghai） |
| 依据 tip | `fix/txid-race-safety-2026-10-18` |
| 官方来源 | Workers / D1 Limits & Pricing（见文末） |
| 声明 | 本模型为 **估算 + 公式**；Dashboard 实数标为 **未验证**。**不保证**永远免费或无限承载。 |

---

## 1. 输入假设

| 假设 | 值 | 类型 |
|---|---|---|
| 生产 cron | `*/1` + `0 2 * * *` | 实测 wrangler |
| staging cron | 同生产（若部署） | 实测配置；是否在线 **未验证** |
| 空闲无 pending | cron 不调链上 RPC | 实测代码路径 |
| 待付款批大小 | `LIMIT 100`（轮询）/ 过期候选 `LIMIT 500` | 实测 |
| EVM 分页 | `EVM_SCAN_PAGE_BLOCKS = 1000` | 实测 |
| 公开 RPC | OKX X Layer / BSC dataseed（免费） | 实测默认；可用性 **未验证** |
| 前端支付状态轮询 | 无（仅本地倒计时） | 实测 frontend |
| HTML 托管 | Worker 内嵌，非 Static Assets | 实测 |
| PBKDF2 | 100000 次 | 实测 |

---

## 2. Workers 请求模型

### 2.1 日请求分解

\[
R_{\text{day}} = R_{\text{cron}} + R_{\text{html}} + R_{\text{api}} + R_{\text{abuse}}
\]

| 分量 | 公式 / 估计 | 类型 |
|---|---|---|
| \(R_{\text{cron,prod}}\) | \(1440 + 1 = 1441\) | 估算 |
| \(R_{\text{cron,stg}}\) | 若 staging 触发器生效：再 +1441 | 估算 / 未验证是否启用 |
| \(R_{\text{html}}\) | UV × 人均页面加载；每次 `/` 计 1 | 估算 |
| \(R_{\text{api}}\) | 下单/查单/管理端/ captcha / products | 估算 |
| \(R_{\text{abuse}}\) | 恶意 GET/刷 captcha | 未验证上界；理论可打满 100k |

**Free 上限**：\(R_{\text{day}} \le 100\,000\)（UTC 日切）。

**剩余容量（仅扣生产 cron）**：

\[
R_{\text{remain}} \approx 100000 - 1441 = 98559
\]

示例（估算）：若日均 2000 UV、人均 3 次 HTML + 5 次 API ≈ 16000，总约 17.5k，占用 ~17.5%，余量仍大。  
反例：脚本对 `/` 或 `/api/products` 打满 → 余量归零（与业务量无关）。

### 2.2 CPU 时间模型

| 调用类型 | Free 上限 | 关键成本驱动 | 风险等级 |
|---|---|---|---|
| HTTP | 10 ms CPU | PBKDF2、大列表序列化、`cardStatsMap` 聚合 | 高（认证路径） |
| Cron | 10 ms CPU | 多笔 `checkChainPayment` + `scanEvmChain` 循环中的 JS | 高（有积压） |
| 等待网络 | **不计入** CPU | `fetch` RPC / D1 等待 | — |

**估算提示**：官方称平均 Worker ~2.2 ms；认证类常 10–20 ms。本仓库 PBKDF2(100k) **很可能**接近或超过 Free 10 ms——须用 Dashboard Metrics / Tail 的 `cpuTime` **实测**后才能定论（当前 **NOT VERIFIED**）。

**安全约束**：即使 CPU 吃紧，也不得降低链确认数或跳过金额/合约校验；不得缓存「付款成功」替代账本；不得关闭审计或库存原子预留。

可选优化（须 CTO + 所有者批准，另开 PR）：将 PBKDF2 迭代评估为「安全下限 vs Free CPU」专题；把重 CPU 工作拆到多次 cron；升级 Paid（需费用批准）。

### 2.3 Subrequest（50 / 调用）

| 操作 | 约消耗 | 说明 |
|---|---|---|
| D1 `prepare().run/first/all` | 计为 subrequest（平台口径） | Free 每调用合计 ≤50 |
| `eth_blockNumber` / `eth_getLogs` / `eth_getTransactionReceipt` | 各至少 1 | 多 RPC URL 重试累加 |
| ProdSeller API | 1+ | 上游轮询 / 同步 |

**估算**：空闲 cron ≈ 数次 D1 ≪ 50。有 pending 时：每地址分页 logs + receipt → 易逼近 50；代码已按链/地址批处理并分页，但仍须监控 Cron 失败（**未验证**线上是否已触顶）。

---

## 3. D1 模型

### 3.1 存储

| 驱动 | 影响 | 类型 |
|---|---|---|
| `cards` 明文卡密 | 行数 × 码长 | 估算 |
| `app_icons.image_data` base64 JPEG | 种子图标体积大 | 实测存在；合计字节 **未验证** |
| `admin_audit` / `payments` / 限流表 | 随时间增长；日清理有限 | 估算 |
| Free 单库 | **500 MB** | 官方 |

\[
S_{\text{remain}} = 500\text{MB} - S_{\text{used}}
\]

\(S_{\text{used}}\)：**未验证**。

### 3.2 行读 / 行写（日）

| 指标 | Free 日限额 | 空闲估算 | 高峰风险 |
|---|---|---|---|
| rows read | 5000000 | cron 索引点查：通常 ≪ 限额 | 无索引全表扫、`GROUP BY` 卡密统计 |
| rows written | 100000 | 限流 INSERT + 少量 UPDATE | 刷单到限流上限、大量导入卡密 |

**索引（tip）**：`idx_orders_status`、`idx_orders_created`、`idx_payments_*`、`idx_cards_*`、金额唯一部分索引等。`main` 缺 v16–v18 时旧库可能缺部分索引（合并前风险）。

### 3.3 每调用 50 查询

`runPolling` 对最多 100 笔订单循环；每笔可能多次 D1。若单次 cron 内查询数 >50，后续语句失败 → 付款延迟。

**缓解（方案级，未改代码）**：减小 `LIMIT`、拆链分 cron、或 Paid 升至 1000 查询/调用（费用批准）。

---

## 4. 场景表（估算）

| 场景 | 日请求量级 | CPU | D1 | 判定 |
|---|---|---|---|---|
| A. 空闲店（几乎无单） | ~1.5k cron + 少量浏览 | 低 | 低 | Free **可承载**（估算） |
| B. 日销 50 单、UV 500 | ~5–15k | 中（登录/取密） | 中 | Free **大概率可** |
| C. 日销 500、持续有 pending | 15–40k + 重 cron | **高** | 中高 | Free **临界**；须测 CPU |
| D. 被刷首页/API | →100k | — | 读涨 | **1027**；业务中断 |
| E. 生产+staging 双 cron + 活动流量 | 基线 ~2.9k + 业务 | 同 C | 双库存储 | 注意账号 Cron 数 ≤5 |

---

## 5. 链上扫描容量

| 项 | 行为 | 类型 |
|---|---|---|
| 游标表 | `scan_cursors(chain, last_block)` | 实测 |
| 推进条件 | 整页扫描成功才推进；RPC 失败不推进 | 实测 |
| 断点恢复 | 重启后从 last_block 继续 | 设计 PASS |
| 确认数 | X Layer 默认 1；BEP20 默认 15 | 实测常量 |
| 付费 RPC | 未引入 | 实测；换付费 RPC 须费用审批 |

积压时：游标落后 → 单次 cron 多页 logs → CPU/subrequest 风险上升。容量上应限制「每 cron 最大页数」（方案，待 CTO）。

---

## 6. 剩余容量一句话

| 资源 | 空闲剩余（估算） | 未验证项 |
|---|---|---|
| Workers 请求 | ~98%（仅扣生产 cron） | 真实日请求、staging 是否计费 |
| CPU | **未知** | p50/p99 cpuTime、Error 1102 |
| D1 存储 | **未知** | 库 MB |
| D1 行读/写 | 空闲通常充足 | 日峰值 meta |
| Cron 槽位 | 账号 5，已用约 4 | Dashboard 确认 |

---

## 7. 来源

1. https://developers.cloudflare.com/workers/platform/limits/
2. https://developers.cloudflare.com/workers/platform/pricing/
3. https://developers.cloudflare.com/d1/platform/limits/
4. https://developers.cloudflare.com/d1/platform/pricing/
5. `wrangler.toml`；`src/worker.js`（`runPolling`、`scanEvmChain`、限流常量、`PBKDF2_ITERATIONS`）
