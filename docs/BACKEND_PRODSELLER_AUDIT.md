# Bot2 后端 / ProdSeller 只读审计（T2-1）

- **审计 tip**：`fix/txid-race-safety-2026-10-18` @ `7e9f70b`（D-001）
- **日期**：2026-10-19（Asia/Shanghai）
- **范围**：订单状态机、自营库存/卡密预留、ProdSeller 同步·采购·激活·交付
- **约束**：未改 `src/`、未部署、未调用真实 ProdSeller / 主网

## 矩阵

| 项 | 标记 | 说明 |
|---|---|---|
| 订单七态状态机 | PASS | `pending_payment` → `pending_fulfill` / `pending_activation` / `pending_upstream` / `refund_pending` → `completed` \| `cancelled` |
| 付款后才上游采购 | PASS | `fulfillAfterPayment` 仅从 `pending_payment` 认领后走 ProdSeller |
| `prodseller_enabled` 门禁 | PASS | `prodsellerCreateOrder` 单点检查；关闭返回 403，转 `pending_upstream` |
| 自营卡密防超卖 | PASS | `reserveCards` 条件 UPDATE `reserved_order_id IS NULL`；发货优先本单预留 |
| 激活须真实 delivered | PASS | `paid` 保持 `pending_activation`；`delivered` + keys 行数 ≥ quantity 才 complete |
| 上游幂等（代码路径） | PASS | `Idempotency-Key = order_no`；`upstream_orders.order_id` 唯一；无 psId → `no_psid_awaiting_manual` 停重建 |
| API Key 存放 | PASS | `env.PRODSELLER_API_KEY`（Secrets）；仓库未见明文 Key |
| 鉴权头 / Base URL | PASS | 文档：`X-API-Key` + `https://prodseller.com/v1`；代码一致 |
| 402 / 409 / 429 处理 | PASS | 转 `pending_upstream` + 告警路径，不发货 |
| 上游 import 覆盖售价 | **FAIL** | `/api/admin/upstream/import`：`ON CONFLICT(slug) DO UPDATE SET sell_price=excluded.sell_price`（tip 约 L3791）会覆盖管理员自定义售价 |
| 激活 quantity>1 的 emails | **FAIL** | `prodsellerCreateOrder` 固定 `emails=[activation_email]`（约 L979）；文档要求数组长度 = quantity |
| 非激活请求仍带 email 字段 | NOT VERIFIED | 空串是否被官方拒绝未测 |
| `productId` 回退 slug | NOT VERIFIED | `prodseller_id \|\| slug`；slug 非 Mongo id 时风险未证实 |
| 真实 Idempotency-Key 重放 | **BLOCKED** | 禁止打真实上游；无服务商证据 |
| 生产 Secrets 是否已配置 | NOT VERIFIED | 需所有者确认 |

## 建议修复顺序（代码窗开后）

1. **FAIL①**：冲突更新只刷新 `cost_price` / `in_stock` / `requires_email_activation` / `prodseller_id` 等；**保留**已有 `sell_price`（及对外用的 `price_usdt` 若与售价绑定则同步策略写清）。
2. **FAIL②**：`quantity > 1` 时按官方组 `emails`（长度 = quantity）；单件继续 `email`。
3. 补回归测试；交 @安全审计 + QA 工程师 独立复核。
4. 不碰支付核验核心（Bot3）；不部署生产。

## 对照官方文档（已核对）

- Base：`https://prodseller.com/v1`
- Auth：`X-API-Key`
- 幂等：`Idempotency-Key`（≤100 字符）
- 激活：`requiresEmailActivation`；下单需 `email` / `emails`；响应 `paid` 后轮询至 `delivered` 才有 `deliveredKey(s)`
- 错误：401 / 400 / 402 / 404 / 409 / 429 / 500
- 限速：300 / 15 min（代码本地计数；官方 `X-RateLimit-*` 未接入 → NOT VERIFIED）

## 相关

- 决策：D-001 基准 tip
- Bot5：[PR #7](https://github.com/Newbee06/zhixuan-shop/pull/7) 安全/QA 实跑
- 排队：合 PR #3 → #4 后优先修 FAIL①②
