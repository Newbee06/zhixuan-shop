# 可观测性与预警设计（Observability）

| 字段 | 值 |
|---|---|
| 核验日期 | **2026-10-19**（Asia/Shanghai） |
| 状态 | **设计文档**；Dashboard 实装与告警通道 **NOT VERIFIED / BLOCKED**（执行者无 Cloudflare 账号权限） |
| 原则 | 观测不得削弱付款核验、审计与库存保护；优先免费 Workers Logs / Dashboard Metrics |

---

## 1. 现状（实测 vs 未验证）

| 能力 | 状态 | 说明 |
|---|---|---|
| `console.error` + `request_id` | **实测** | API 500 脱敏，关联 ID 进日志 |
| Workers Logs（Free） | 官方：20 万事件/天，保留 3 天 | 账号是否开启 **未验证** |
| Dashboard Workers Metrics | 请求、错误、CPU | **未验证**（无权限） |
| D1 Metrics（rows read/written、size） | 官方提供 | **未验证** |
| Cron Events（近 100 次） | 官方 Dashboard | **未验证** |
| Logpush / 付费分析 | Paid | **禁止**默认启用；须费用批准 |
| 外发告警（邮件/TG） | 邮件已移除 | 告警通道需所有者指定（TG Bot 等） |

---

## 2. 必须监控的信号

### 2.1 配额类（Free 存活）

| 信号 | 来源 | 告警阈值（建议） | 类型 |
|---|---|---|---|
| Workers 日请求 | Dashboard / GraphQL | >70k 警告；>90k 紧急 | 设计 |
| Error 1027 计数 | Metrics / 用户反馈 | >0 紧急 | 设计 |
| Error 1102 / exceededCpu | Metrics | >0 紧急（标路径：cron vs login） | 设计 |
| D1 库大小 | D1 Metrics | >350 MB 警告；>450 MB 紧急 | 设计 |
| D1 日 rows read/written | D1 Metrics | >70% 日限额警告 | 设计 |
| Cron 失败 / outcome≠ok | Cron Events / Logs | 连续失败 ≥3 紧急 | 设计 |

### 2.2 业务正确性（不可为额度关闭）

| 信号 | 建议采集 | 说明 |
|---|---|---|
| `pending_payment` 积压时长 | 管理端 stats + 定时日志 | 积压过大 → cron 批不够或 RPC 失败 |
| `scan_cursors` 落后最新块 | 管理只读 API 或日志 | 游标不推进 → RPC 失败 |
| `txid_claims` / `payments` 异常态 | 已有 admin payments | 超额 `overpaid_pending` 须人工 |
| 上游 `pending_activation` 卡住 | `pollUpstreamActivations` + alerts API | 已有 upstream alerts |
| 审计 `audit_failed` | API 响应字段 | 业务成功但审计失败须补记 |

### 2.3 安全 / 滥用

| 信号 | 说明 |
|---|---|
| 登录全局封禁触发 | `LOGIN_GLOBAL_MAX_FAIL` |
| `/pay`、查单、下单限流命中率骤升 | 可能扫号或刷 TXID |
| 单 IP 对 `GET /`、`/api/products` 的异常 QPS | 当前应用层弱；靠 Cloudflare 网络分析 / WAF（配置须批准） |

---

## 3. 仪表盘清单（所有者可建）

无需付费即可在 Dashboard 固定查看：

1. **Workers → aisou-lite → Metrics**：Requests（24h）、Errors（1027/1102）、CPU time  
2. **Triggers → Cron Events**：最近执行 outcome  
3. **D1 → aisou-lite-db → Metrics**：Storage size、Row read/write  
4. **Staging 同名面板**（`zhixuan-shop-staging`）：确认测试流量与 staging cron 是否烧请求额度  

**BLOCKED**：本 Bot 无法代建；请所有者截图或授权只读后由平台工程师回填「实测基线」表。

---

## 4. 日志规范（与现有代码对齐）

| 级别 | 用途 | 禁止 |
|---|---|---|
| `console.error('[req_…] …')` | 5xx、迁移失败、候选查询失败 | 密码、卡密明文、API Key、无关 PII |
| 业务审计 `admin_audit` | 管理操作、取消、确认收款 | 替代不了 Workers 配额监控 |
| 付款账本 `payments` | 链上事实与对账 | 不得为省写额度跳过入账 |

Workers Logs Free 日 20 万事件；高流量时避免每个成功 GET 打 info 级日志。

---

## 5. 告警通道设计（待所有者确认）

| 优先级 | 示例 | 建议通道 |
|---|---|---|
| P0 | 1027；付款 cron 连续失败；D1 无法写 | 所有者手机/TG；立即响应 |
| P1 | 请求 >70k；CPU 1102 偶发；游标落后 | 当日处理 |
| P2 | 存储 >350 MB；staging 异常 | 周内处理 |

实现选项（均须批准）：Cloudflare 账号通知；外部 uptime 探活 `GET /api/config`（耗请求预算）；管理 TG 人工转发。  
**不**重新引入 Resend 付费邮件，除非所有者显式批准。

---

## 6. 故障恢复剧本（与额度相关）

| 故障 | 立即 | 次步 | 禁止 |
|---|---|---|---|
| 1027 | 确认是否攻击；WAF/限速（若有区） | 评估 Static Assets；讨论 Paid | 关闭 `poll_enabled` 当长期方案且不告知 |
| Cron CPU 超时 | 查 pending 数量；临时 `poll_enabled=0` **仅**停扫描（过期清理仍跑） | 降批大小 PR；Paid | 跳过确认数/金额校验 |
| RPC 全挂 | 游标不推进（安全）；用户走 TXID/人工确认 | 换备用公开 RPC | 未批准买付费 RPC |
| D1 写满 | 停导入；清理策略 | 归档 / Paid 存储 | 删 `payments` / `txid_claims`「腾地方」 |
| 误部署生产 | 见 `COST_GUARDRAILS.md`；回滚 Worker 版本 | 核对 D1 | — |

`poll_enabled=0`：仍执行过期清理、零 RPC——可用于紧急降载，但自动发现收款停止，必须公告并尽快恢复。

---

## 7. 容量评估节奏

| 触发 | 动作 |
|---|---|
| 每周 | 导出日请求峰值、D1 体积填入基线表 |
| 大促 / 上新前 | 用 `USAGE_BUDGET.md` 情景 C/D 预估 |
| 合并支付相关 PR 后 | 重测 cron 在「有 20/50/100 pending」下的日志与错误 |
| 出现 1027/1102 后 | 24h 内出事故短报 |

### 基线表（待填实测）

| 日期 (上海) | 请求/日 | 1027 | 1102 | D1 MB | rows_read | rows_written | 备注 |
|---|---|---|---|---|---|---|---|
| 2026-10-19 | *未验证* | *未验证* | *未验证* | *未验证* | *未验证* | *未验证* | 审计日占位 |

---

## 8. 免费工具 vs 付费边界

| 工具 | Free？ | 本项目态度 |
|---|---|---|
| Dashboard Metrics / D1 Metrics | 是 | 首选 |
| Workers Logs | 有日 cap | 开启；控制刷屏 |
| Logpush | Paid | 默认不用 |
| 付费 APM / 第三方 | 可能收费 | 须批准 |
| GraphQL Analytics | 视账号 | 只读拉取用量 OK |

---

## 9. 来源

1. https://developers.cloudflare.com/workers/platform/limits/
2. https://developers.cloudflare.com/workers/platform/pricing/
3. https://developers.cloudflare.com/d1/platform/pricing/
4. https://developers.cloudflare.com/workers/configuration/cron-triggers/
5. `src/worker.js`：`scheduled`、`runPolling`、`poll_enabled`、错误 `request_id`
