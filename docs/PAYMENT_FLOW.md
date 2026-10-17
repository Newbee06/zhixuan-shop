# 支付流程（智选商城）

## 支持的支付组合（仅两种）

| 支付方式 | 链 | 资产 | 合约地址（核验来源：2026-10-16，见下） | 精度 | 确认数 |
|---|---|---|---|---|---|
| OKX | X Layer | USDT0 | `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` | 6（运行时读 `decimals()`） | 1 |
| Binance | BEP20 | USDT（Binance-Peg） | `0x55d398326f99059fF775485246999027B3197955` | 18（运行时读 `decimals()`） | 15 |

- 合约地址核验来源：X Layer USDT0 与 BEP20 USDT 均为 2026-10-16 经公开资料核对的官方合约；运行时仍以链上 `decimals()` 为准，不硬编码精度做金额匹配。X Layer 旧版 USDT（`0x1e4a...`）与 USDT0 是不同资产，绝不混为同种。
- 其余组合（OKX+BEP20、Binance+X Layer、任意+TRC20/ERC20、BinanceUID+站内转账、未知/缺失组合）一律拒绝。TRC20 / ERC20 / 站内转账代码已删除。

## 下单与付款

1. 下单：选组合（白名单校验）→ 服务端生成 `actual_amount = 基础价 + 随机尾数 0.0001–0.0099`（同地址同窗口唯一）→ 收款地址来自 `usdt_addresses`（`支付方式|链`）。
2. 买家按**精确金额**付款到收款地址，20 分钟内到账（`expires_at`）。超时自动取消，释放金额占用与卡密预留。
3. 买家无需提交任何东西（轮询自动发现）；也可主动提交 TXID（`/pay`）加速核验。

## 收款确认三条路径（复用同一 `fulfillAfterPayment`）

1. **轮询**（`runPolling`，cron 每 1 分钟）：先逐单 `checkChainPayment`，再全局 `scanEvmChain`（游标按 `链|地址` 独立存储，RPC 失败不推进）。仅白名单链可扫描。
2. **TXID 核验**（`/pay`）：`checkTxidPayment` 查 receipt 日志，按该链确认数核验；通过即自动发货并认领 TXID。
3. **管理员确认**（`confirm-payment`）：管理员在系统外核对到账后点确认，无链上证明，不认领 TXID。

## 链上核验规则（全部必须满足，否则不认账）

- 合约地址格式合法且等于配置的 USDT 合约（不因同名代币接受其他合约）。
- 日志为 Transfer 事件（topic0），`to` 等于订单收款地址。
- 金额：按合约实际 `decimals()` 精确换算为 BigInt，与订单 `actual_amount` 精确相等。decimals 读取失败 → 该 RPC 不认账（fail-closed）。
- 确认数：收据区块号 ≤ 最新区块 − 该链确认数（X Layer 1、BEP20 15），防链重组。
- 同一链上事件（`chain, tx_hash, event_key`）只入账一次；同一 TXID 只被一个订单认领（严格先到先得）。

## 旧订单

- 白名单生效前已存在的 TRC20 / ERC20 / 站内转账订单：**不自动认账**，轮询跳过核验（只保留超时自动取消），`/pay` 拒绝。需管理员在系统外核对到账后点“确认收款”人工处理，或走异常/退款流程。
- 旧设置键（如 `usdt_addresses` 里的 `Binance|TRC20`）保留不删除（不破坏管理员配置），但支付代码不再读取它们。

## 付款账本（`payments`）

状态：`submitted`（用户提交）→ `discovered`（轮询发现）→ `verified`（链上核验通过）→ `confirmed`（达到确认数）→ `posted`（已入账，履约已触发）。异常：`duplicate`（同一事件已入账）、`mismatch`（金额不符，需人工对账）、`unmatched`（无法归属）。管理员可对账（`reconcile`）。

## 上游采购

- 仅 `source=prodseller` 商品走 ProdSeller；`prodseller_enabled` 门禁默认关闭。
- 采购 `Idempotency-Key = order_no`，重试不重复采购；`upstream_orders` 按 `order_id` 唯一。
- 上游 `paid` → `pending_activation`，轮询到 `delivered` 才发货；402/409/429/500 → `pending_upstream` + 后台告警，需人工介入。

## 真实链上验收状态

**BLOCKED / NOT VERIFIED**：除非有可核验的真实转账证据（真实 TXID + 链上查询 + 订单履约记录），否则不宣称真实链上验收完成。当前无此证据（见 docs/RELEASE_READINESS.md）。
