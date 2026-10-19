# 费用护栏（Cost Guardrails）

| 字段 | 值 |
|---|---|
| 核验日期 | **2026-10-19**（Asia/Shanghai） |
| 适用范围 | zhixuan-shop Cloudflare 资源与一切可能产生费用的外部依赖 |
| 首要目标 | 在不牺牲付款核验、审计、库存保护的前提下，尽量稳定运行在 **Free** |

---

## 1. 硬性禁止（未经所有者书面/聊天明确批准）

| 禁止项 | 原因 |
|---|---|
| 升级 Workers Paid / 任何自动扣费套餐 | 产生月费与超量费 |
| 启用 Workers Logpush、付费 Observability 超量包 | 按量计费 |
| 购买 Alchemy/Infura 等付费 RPC 包 | 持续费用；先用尽公开 RPC 与多 endpoint 故障转移 |
| 引入 R2/KV/Queues/DO/Vectorize 等「先免后费」资源并默认打开 | 超免费额后扣费；且增架构复杂度 |
| 重新接入 Resend 或其他付费邮件 | ARCHITECTURE：邮件已移除 |
| 生产 `wrangler deploy`、改生产 D1、开真实收款开关 | 资金与数据风险（总任务安全规则） |
| 为省额度关闭：付款核验、确认数、幂等认领、审计、卡密预留 | **安全红线** |
| 用 Cache/KV「已支付」缓存替代链上/账本核验 | **资金红线** |

批准必须：**谁批准、批准什么、费用上限、有效期** 留痕（群聊或 issue）。

---

## 2. 环境隔离（实测 PASS）

| 项 | 生产 | Staging |
|---|---|---|
| Worker name | `aisou-lite` | `zhixuan-shop-staging` |
| D1 | `aisou-lite-db` | `zhixuan-shop-staging-db` |
| database_id | `c492fc6c-…680c` | `4fb3878b-…242e6` |
| Cron | 顶层 `[triggers]` | `[env.staging.triggers]` |
| 自定义域 / 真实收款 | 生产配置 | 文档称不绑生产域；`prodseller_enabled` 默认 0 |

**护栏**：CI / 本地默认指向 staging；生产部署需所有者显式命令；密钥分环境；禁止用生产 D1 压测；staging cron 与生产共享账号请求日限额与 Cron 槽位。收款：staging 不得填生产收款地址做「真钱」测试。

---

## 3. 变更分级

| 级别 | 示例 | 所需批准 |
|---|---|---|
| L0 文档/注释 | 本审计五件套 | CTO 审 PR 即可 |
| L1 可逆 Free 内优化 | 索引、减小 cron `LIMIT`、HTML `cache-control`、Static Assets | CTO + 代码审；生产部署仍要所有者 |
| L2 行为变更 | `poll_enabled` 默认、确认数、限流阈值 | CTO + 安全审 + 所有者 |
| L3 费用相关 | Paid、付费 RPC、新计费产品 | **所有者明确费用批准** |
| L4 资金路径 | 合约地址、履约门禁、txid 认领 | 安全审计 + 所有者；禁默默合并 |

本 PR 仅为 **L0**。

---

## 4. Free 不够时的替代方案（须显式选择）

| 选项 | 费用 | 保留支付核验？ | 备注 |
|---|---|---|---|
| A. 边缘限流 / WAF / Turnstile 打满读路径 | 视站点计划 | 是 | 优先打滥用 |
| B. HTML → Workers Static Assets（请求免费） | Free 内 | 是 | API 仍计请求 |
| C. 降低 cron 频率（如 `*/2`） | Free | 是但到账变慢 | 须产品接受 |
| D. 缩小每 cron 批处理 | Free | 是 | 积压延迟增加 |
| E. Workers Paid $5 起 | **有费用** | 是 | CPU/请求放宽 |
| F. 付费 RPC | **有费用** | 是 | 仅公开 RPC 不稳时 |
| G. 临时 `poll_enabled=0` | Free | 自动扫链停；TXID/人工仍在 | **临时**+公告 |

选型必须写进群：原因、风险、回滚、费用。**禁止静默关功能。**

---

## 5. 密钥与兼容性

| 项 | 护栏 |
|---|---|
| API Key / Turnstile Secret | 仅 `wrangler secret`；禁止进 Git/聊天 |
| 钱包私钥 / 助记词 | 禁止引入需付 gas 的自动化转账 |
| 管理员密码 PBKDF2 | 禁止未经安全评审降迭代「省 CPU」 |
| `compatibility_date = 2024-01-01` | 升日须 staging 回归；不与付费升级捆绑 |

---

## 6. PR / 部署检查清单（费用视角）

- [ ] `wrangler.toml` 未新增付费 binding  
- [ ] 未新增 cron 导致账号 Cron >5  
- [ ] 未引入默认开启的外部付费 SDK  
- [ ] 未删除或弱化：核验、审计、库存、限流  
- [ ] 生产/staging 目标环境明确  
- [ ] 若触及 L3/L4：附件中有所有者批准摘录  

---

## 7. 审计结论与护栏状态

| 项 | 标记 |
|---|---|
| 当前架构意图（单 Worker + D1 + 2 cron） | **PASS** 对齐 Free |
| 生产/staging 隔离配置 | **PASS**（代码/配置实测） |
| 账号是否确为 Free、有无历史扣费 | **NOT VERIFIED** |
| 滥用打满 100k 的防护完整性 | **FAIL 风险**（读路径） |
| CPU 10ms vs PBKDF2 | **NOT VERIFIED**（需指标） |
| 默默关核验的压力 | 护栏 **禁止** |

---

## 8. 来源与相关文档

1. https://developers.cloudflare.com/workers/platform/pricing/  
2. https://developers.cloudflare.com/workers/platform/limits/  
3. https://developers.cloudflare.com/d1/platform/limits/  
4. `wrangler.toml`、`docs/ARCHITECTURE.md`、tip `src/worker.js`  

相关：`CLOUDFLARE_FREE_TIER_AUDIT.md`、`CAPACITY_MODEL.md`、`USAGE_BUDGET.md`、`OBSERVABILITY.md`
