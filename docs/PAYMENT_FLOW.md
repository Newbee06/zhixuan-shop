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

1. **轮询**（`runPolling`，cron 每 1 分钟）：先过期清理（`expireUnpaidOrders`，独立职责），再逐单 `checkChainPayment`，再全局 `scanEvmChain`（游标按 `链|地址` 独立存储，RPC 失败不推进）。仅白名单链可扫描。`poll_enabled=0` 时跳过全部链上扫描/RPC（零链上调用），但过期清理仍运行，避免过期未付款订单永久冻结卡密预留。过期取消守卫：仅已过期 + 无已消费付款事实（无 `txid_claims` 认领、无 `verified/confirmed/posted/manual_confirmed` 账本行）+（未认领或租约已过期）才可取消；取消绝不删除认领或账本，重复运行幂等。
2. **TXID 核验**（`/pay`）：`checkTxidPayment` 查 receipt 日志，按该链确认数核验；通过即自动发货并认领 TXID。
3. **管理员确认**（`confirm-payment`）：管理员在系统外核对到账后点确认，须填人工原因（记入审计）并显式确认 `manual_confirm=true`。**人工确认不是“不写认领表”**：只要订单带有 64 位十六进制 TXID，人工确认与链上确认共享同一 `txid_claims` 全局原子认领，写 `source='manual_confirmed'` 的认领行 + `payments` 的 `manual_confirmed` 账本行 + 审计 + 订单 `【人工确认收款】` 备注标记。`manual_confirmed` 仅表示管理员系统外核对后人工确认，**不构成链上证据**，不伪造回执/区块高度/确认数。无 TXID（或非 64 位十六进制）的订单走人工确认时不写认领行/账本行，只走订单租约与发货，不伪造认领。

## 链上核验规则（全部必须满足，否则不认账）

- 合约地址格式合法且等于配置的 USDT 合约（不因同名代币接受其他合约）。
- 日志为 Transfer 事件（topic0），`to` 等于订单收款地址。
- 金额：按合约实际 `decimals()` 精确换算为 BigInt，与订单 `actual_amount` 精确相等。decimals 读取失败 → 该 RPC 不认账（fail-closed）。
- 确认数：收据区块号 ≤ 最新区块 − 该链确认数（X Layer 1、BEP20 15），防链重组。
- 同一链上事件（`chain, tx_hash, event_key`）只入账一次；同一 TXID 只被一个订单认领（严格先到先得，永不抢占；胜负由 `txid_claims.tx_hash` 主键唯一约束决定，见下节 v17）。

## TXID 认领安全（v17，P1-1/P1-2）

- **租约-first**：`fulfillAfterPayment` 先原子获取订单租约（`claimOrderForPayment`，`orders.claim_token` + `claimed_at`，租约 5 分钟），再碰 `txid_claims`。无租约的请求不触碰认领；认领失败只释放本请求租约（清 `paid_at`，本次未建立付款事实），不触碰认领行。
- **认领令牌化**：每次新认领生成密码学安全随机令牌 `randomHex(32)` 存入 `txid_claims.claim_token`，为该认领行的唯一持有凭证。已消费认领永久保留：`releaseTxidClaim` 回滚原语已在本轮删除，不存在自动删除认领的入口（见下）。
- **永久保留，无自动回滚**：已成功写入 `txid_claims` 的认领永不被任何普通 API、租约接管或失败恢复流程自动删除。历史上存在过的 `releaseTxidClaim`（单条条件删除）已删除：没有任何调用方可以证明“该认领从未成为付款事实”，任何删除都会把已消费 TXID 放回全局可用池。归属争议只允许管理员在 D1 中人工对账处理（独立授权、可审计证据、严格流程），不在代码中提供自动删除入口。
- **同订单接管收养**：同订单已有认领时不新建行，只把 `order_lease_token` 重绑为新租约持有者的订单租约令牌；`source` 首次写入获胜，永不改写（不伪造来源）。同一订单提交新 TXID 时：旧 TXID 已有认领则保留旧认领，`orders.tx_hash` 保持为第一笔已消费 TXID（不被未验证候选覆盖）；新 TXID 只有通过完整链上核验并取得自身认领后，才作为该订单的第二笔付款事件（独立认领行 + 账本行），绝不通过覆盖 `tx_hash` 或删除历史认领来伪造只有一笔付款。
- **人工与链上共享全局认领**：人工确认与链上确认共用同一 `txid_claims`（`tx_hash PRIMARY KEY`），不再另建防重表、不再靠先 SELECT 后 INSERT。`source` 区分 `'chain_verified'`（链上验证通过后认领）与 `'manual_confirmed'`（管理员系统外核对后人工确认认领）。人工确认写认领时若 TXID 已归属他单则拒绝；v17 前遗留的人工 `payments manual_confirmed` 行仍做兼容检查（归属他单则拒绝），之后以认领表为准。
- **人工账本 fail-closed**：人工确认的 `payments manual_confirmed` 行写入失败时绝不静默把订单推为已付款/已交付；仅当重读确认已有同订单 + 同 TXID + 同状态 `manual_confirmed` 行时才可按幂等重试继续，否则释放本请求租约、认领保留、返回失败，同订单可安全重试，不向他单开放 TXID。审计写入失败语义仍为 P1-7（`ok:true` + `audit_failed:true`，不得重复业务副作用）。
- **迁移**：v17 为 `txid_claims` 加 `claim_token` / `source` / `order_lease_token` 三列，均为 `ADD COLUMN` 幂等；`schema.sql` 新库已含三列；预置版本保持 10（v11–v17 由 Worker 按序执行，旧库真正加列、新库为 no-op）。现有认领行保留，旧行 `source` 默认 `'chain_verified'`（v17 前只有链上路径写认领表）。

## 旧订单

- 白名单生效前已存在的 TRC20 / ERC20 / 站内转账订单：**不自动认账**，轮询跳过核验（只保留超时自动取消），`/pay` 拒绝。需管理员在系统外核对到账后点“确认收款”人工处理，或走异常/退款流程。
- 旧设置键（如 `usdt_addresses` 里的 `Binance|TRC20`）保留不删除（不破坏管理员配置），但支付代码不再读取它们。

## 付款账本（`payments`）

状态：`submitted`（用户提交）→ `discovered`（轮询发现）→ `verified`（链上核验通过）→ `confirmed`（达到确认数）→ `posted`（已入账，履约已触发）。异常：`duplicate`（同一事件已入账）、`mismatch`（金额不符，需人工对账）、`unmatched`（无法归属）。管理员可对账（`reconcile`）。

## 上游采购

- 仅 `source=prodseller` 商品走 ProdSeller；`prodseller_enabled` 门禁默认关闭。
- 采购 `Idempotency-Key = order_no`，重试不重复采购；`upstream_orders` 按 `order_id` 唯一。
- 上游 `paid` → `pending_activation`，轮询到 `delivered` 才发货；402/409/429/500 → `pending_upstream` + 后台告警，需人工介入。

## 查单列表 pay_address 例外（P3-11）

- **仅未付款订单付款信息恢复**：`POST /api/orders/query` 列表中，仅 `status === 'pending_payment'` 的订单附带 `pay_address`；已付款/已完成/已取消等其他状态订单不附带。用途：成功页刷新后用订单号 + 图形验证码恢复付款信息（收款地址 + 精确应付金额），避免用户因刷新丢失收款地址而付错地址。
- **性质**：`pay_address` 是商家公开收款地址（与 `/api/config` 公开的 `usdt_addresses` 同一类信息），**非用户钱包/秘密**。附带它不改变查单列表的最小化原则，与 P1-6 最小字段一致。
- **不连带泄露**：附带 `pay_address` 时仍不返回 `delivery_content`、`customer_fields`、`contact`、`txid` / 完整 `tx_hash`、查询密码/哈希/盐、`claim_token`、管理备注（`admin_note` / `refund_ref` / `exception_reason` / `upstream_lock`）。完整 TX 哈希、客户字段、交付内容一律不随列表返回。
- 下单成功响应（买家自己的新订单）同样返回该单的 `pay_address` / `wallet_address`，属当次交易信息，不属列表例外。

## 真实链上验收状态

**BLOCKED / NOT VERIFIED**：除非有可核验的真实转账证据（真实 TXID + 链上查询 + 订单履约记录），否则不宣称真实链上验收完成。当前无此证据（见 docs/RELEASE_READINESS.md）。
