# zhixuan-shop 支付核验只读审计（阶段一）

日期：2026-10-19（Asia/Shanghai）
审计 tip：`fix/txid-race-safety-2026-10-18` @ `7e9f70b`
对比：`main`（支付安全修复未合入）
范围：EVM 收款核验 / TXID / 扫描游标 / 幂等 / 对账；不含商品、前端、完整订单业务改写。
真实主网验收：**BLOCKED / NOT VERIFIED**（无真实 TXID + 履约证据）

## 1. 参数核验

| 项 | 代码/文档值 | 公开资料 | 结论 |
|---|---|---|---|
| X Layer chainId | 代码未硬编码 chainId 做核验；RPC 默认同 `xlayerrpc.okx.com` | OKX OnchainOS / ethereum-lists：**196** | PASS（合约+RPC 绑定网络；建议后续显式校验 `eth_chainId==0xc4`） |
| X Layer USDT0 | `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` | OKX help + OKLink + xlayer-tokenlist：同址，decimals **6**；旧 USDT `0x1e4a…` 明确不同资产 | PASS |
| BEP20 / BSC | 合约 `0x55d398326f99059fF775485246999027B3197955`；RPC `bsc-dataseed*` | BscScan / 多源：chainId **56**，Binance-Peg USDT，decimals **18** | PASS |
| decimals | `getTokenDecimals()` 运行时读；失败 fail-closed | 与上表一致 | PASS |
| 确认数 | X Layer 1（大额可升 12）；BEP20 15 | 策略合理；非官方强制值 | PASS（策略）/ NOT VERIFIED（主网重组实测） |
| 旧 USDT 混淆 | 代码注释+默认只认 USDT0；白名单双组合 | OKX FAQ 明确旧址淘汰 | PASS |

核验来源（2026-10-19）：
- https://web3.okx.com/onchainos/dev-docs/payments/supported-networks
- https://www.okx.com/en-us/help/usdt0-faq
- https://www.oklink.com/x-layer/evm/token/0x779ded0c9e1022225f8e0630b35a9b54be713736
- https://github.com/okx/xlayer-tokenlist
- https://bscscan.com/token/0x55d398326f99059ff775485246999027b3197955

## 2. 统一核验入口

| 路径 | 链上证据 | 履约入口 |
|---|---|---|
| 轮询 `checkChainPayment` → `processVerifiedPayment` | eth_getLogs / 金额 / 确认数 | `fulfillAfterPayment`（租约→claimTxid→账本→副作用） |
| 全局 `scanEvmChain` | 同上，经 `processVerifiedPayment` | 同上 |
| `/pay` `checkTxidPayment` | eth_getTransactionReceipt + Transfer | 同上 |
| 管理员 `confirm-payment` | 无链上证明；可共享 `txid_claims`（manual_confirmed） | 同上履约栈 |

结论：**PASS（设计）** — tip 分支三条自动路径复用 `processVerifiedPayment` / `fulfillAfterPayment`；人工确认走共享认领表但不伪造链上证据。

关键符号（`src/worker.js` tip）：
- `PAY_WHITELIST` L10；`DEFAULT_USDT_CONTRACTS` L84；`DEFAULT_CHAIN_CONFIRMATIONS` L73
- `scanEvmChain` L1442；`checkChainPayment` L1567；`checkTxidPayment` L1579
- `claimTxid` L1652；`claimOrderForPayment` L1735；`fulfillAfterPayment` L1951；`processVerifiedPayment` L2249

## 3. 硬性场景矩阵（tip 分支，代码证据；未主网实测）

| 场景 | 标记 | 证据摘要 |
|---|---|---|
| 少付/多付（金额≠订单） | PASS（设计） | BigInt 精确相等；mismatch 账本；第二笔→overpaid_pending 不重复发货 |
| 错误代币 | PASS（设计） | 日志 address 必须=配置合约 |
| 错误链/组合 | PASS（设计） | `validPayCombo` 白名单；非白名单不扫描/不 /pay |
| 错误收款地址 | PASS（设计） | Transfer `to` topic 必须=订单地址 |
| 重复扫描/重复提交 | PASS（设计） | event_key + txid_claims PK + posted 去重 |
| 同 TXID 争抢多订单 | PASS（设计，PR#4 核心） | `txid_claims.tx_hash` 主键；租约-first；无自动删除认领 |
| RPC 失败 / 游标 | PASS（设计） | 失败不推进游标；decimals 失败跳过该 RPC |
| 链重组 | PARTIAL | 确认数门槛有；重组回滚后已履约订单恢复 **NOT VERIFIED** |
| 订单超时竞态 | PASS（设计） | 过期取消需无消费认领/付款事实/有效租约；候选 SQL + tryExpireOrder 双重守卫 |
| 前端「付款成功」触发履约 | PASS（设计） | 履约仅服务端核验后 |

## 4. main vs tip（支付安全）

- `main`：**不能**作支付安全基线（与 QA/CF 一致）。
- PR #3 `fix/review-findings` → main（未合）。
- PR #4 `fix/txid-race-safety` → #3 base（未合）：v17/v18 认领令牌化、租约-first、人工/链上共享防重、pending_tx_hash、overpaid_pending 等。
- 建议基准：先合 #3→#4 再开支付改动（与 CTO/CF/QA 对齐）。

## 5. 测试

存在：`tests/payment-whitelist-test.mjs`、`concurrency-test.mjs`、`review-fixes-test.mjs` 等（模拟/确定性钩子）。
本轮：**未实跑** → 测试结果 **NOT VERIFIED**。
真实主网：**BLOCKED**。

## 6. 剩余风险 / 下一步（只读建议）

1. 等 CTO 定基准 = tip 后再实跑 payment/concurrency/review 测试（隔离环境）。
2. 可选加固：RPC 响应显式 `eth_chainId` 校验（196 / 56）。
3. 生产收款地址/合约 settings：**未经所有者批准不改**。
4. 真实验收需 staging + 小额真链 TXID + 订单履约证据三联。

状态汇总：参数核验 **PASS**｜统一入口 tip **PASS**｜main 支付基线 **FAIL（不足）**｜模拟测试实跑 **NOT VERIFIED**｜主网验收 **BLOCKED**
