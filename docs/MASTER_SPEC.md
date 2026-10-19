# MASTER_SPEC｜智选商城统一规范

> 状态：CTO 草案（2026-10-19 Asia/Shanghai）  
> 工作基准 tip：`fix/txid-race-safety-2026-10-18` @ `7e9f70b`  
> 标记约定：`PASS` / `FAIL` / `BLOCKED` / `NOT VERIFIED` — 计划≠完成，模拟≠主网验收。

## 1. 产品目标

安全、可靠、Apple 风格的虚拟商品自动发卡商城。两类商品统一展示、统一下单，按 `products.source` 走不同采购/交付路径：

| 来源 | 行为 |
|---|---|
| `prodseller` | 同步目录、设售价、付款后用 Idempotency-Key 采购、轮询激活、站内交付 |
| `self` + `stock_type=card` | 管理员导入卡密；下单预留；付款后原子发卡 |
| `self` + `stock_type=manual` | 付款后 `pending_fulfill`，管理员人工填写交付内容 |

## 2. 支付硬规则（开发前再核验）

仅两种组合（见 `docs/PAYMENT_FLOW.md`）：

| 方式 | 链 | 资产 | 合约（2026-10-16 文档值） | decimals | 默认确认数 |
|---|---|---|---|---|---|
| OKX | X Layer | USDT0 | `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` | 运行时 `decimals()`（文档 6） | 1 |
| Binance | BEP20 | USDT | `0x55d398326f99059fF775485246999027B3197955` | 运行时 `decimals()`（文档 18） | 15 |

- 金额：`actual_amount` 与链上 Transfer 按 BigInt **精确相等**；decimals 读失败 → fail-closed。
- 未达确认数 → 不入账、不履约。
- 三条收款路径（轮询 / TXID `/pay` / 管理员 `confirm-payment`）共用 `fulfillAfterPayment`。
- 真实主网验收：**BLOCKED / NOT VERIFIED**（无主网 TXID+履约证据前不得宣称通过）。

## 3. 安全硬规则

1. 仅服务端验证付款后才可上游采购或发放卡密。
2. 支付 / 采购 / 发卡路径必须幂等（TXID 全局认领、订单租约 claim、上游 Idempotency-Key、卡密条件更新）。
3. 禁止把 API Key、私钥、助记词、管理员密码、真实卡密写入 Git 或聊天。
4. 禁止在真实生产环境跑普通测试。
5. 核心改动须有对应测试；高风险须独立审计。
6. 未经所有者明确批准：禁止合并高风险变更、部署生产 Worker、改生产 D1、启用真实收款、创建付费资源。

## 4. 订单状态机（权威列表）

代码常量 `ORDER_STATUSES`：

`pending_payment` →（付款认领）→ `pending_fulfill` | `pending_activation` | `pending_upstream` → `completed`  
异常：`refund_pending` → `cancelled`；超时/取消 → `cancelled`。

| 状态 | 含义 | 谁可推进 |
|---|---|---|
| pending_payment | 待付款（精确金额锁定） | 链上匹配 / TXID / 管理员确认；超时取消 |
| pending_fulfill | 自营待发货（卡密抢占失败兜底或人工） | 管理员发货 / 系统发卡完成 |
| pending_activation | 上游 paid，等 delivered | Cron 轮询上游 |
| pending_upstream | 上游 402/409/429/500 等 | 告警 + 重试/人工 |
| refund_pending | 异常待退款（系统外退款） | 管理员 refund-confirm → cancelled |
| completed | 已交付（终态） | 7 天清理清空交付内容 |
| cancelled | 已取消（终态） | — |

规则：待付款不可直接发货；completed/cancelled 不可再发货/重复确认；人工发货仅从待发货/激活/上游异常进入。

## 5. 幂等与防重（基准 tip 要求）

- **TXID**：`txid_claims` 令牌化 + 租约-first；人工确认与链上路径共享全局防重（PR #4 / v17）。
- **订单认领**：`claim_token` + `claimed_at` 租约；仅认领成功方可履约。
- **金额占用**：`(pay_address, actual_amount)` 在 `pending_payment` 唯一（排除历史 BinanceUID）。
- **卡密**：下单预留 `reserved_order_id`；发卡 `WHERE is_used=0`；completed 订单禁止还卡。
- **上游**：`Idempotency-Key = order_no`；`upstream_orders.order_id` 唯一；`upstream_lock` 租约。

## 6. 技术与费用约束

- 栈：单 Cloudflare Worker + 单 D1；vanilla HTML/CSS/JS；无擅自引入大型框架/复杂构建链/付费服务。
- 密钥：`wrangler secret`（PRODSELLER_API_KEY 等）；不写仓库。
- 免费版红线（Bot6）：Workers 日请求 / **10ms CPU**；D1 500MB、每请求 ≤50 query。PBKDF2(100k)+RPC+批量 D1 同请求时需特别评估。
- Resend/邮件：代码路径已移除；勿为邮件开通付费。

## 7. 协作与发布

- 公共接口 / schema / 状态机以本文件 + `ARCHITECTURE.md` 为准。
- 各 Bot 独立分支 + PR；禁止同时覆盖同一核心文件（见 `IMPLEMENTATION_PLAN.md` 文件所有权）。
- CTO 组织发布评审；**无擅自生产发布权**。
