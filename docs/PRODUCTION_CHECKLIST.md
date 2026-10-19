# 上线检查清单（智选商城）

上线前逐项确认，全部通过方可部署生产。任何一项未通过即为上线阻塞项。

## A. 代码与测试（发布候选）

- [x] 分支与 PR：PR #1 已审（2026-10-17 最终验收，见 docs/CODE_REVIEW_2026-10-17.md“最终合并前验收”），未合并前不得部署生产。
- [x] 全套测试全绿（本地全套 + CI 五 Job；计数见下“本分支”行与 docs/RELEASE_READINESS.md 附录，均为本轮收尾实际执行结果）：
  - `node tests/app-icons-test.mjs`
  - `node tests/security-test.mjs`
  - `node tests/concurrency-test.mjs`
  - `node tests/release-readiness-test.mjs`
  - `node tests/mock-test.mjs`
  - `node tests/payment-whitelist-test.mjs`
  - `node tests/stock-test.mjs`
  - `bash tests/d1-local-test.sh`（仅 `--local`，绝不 `--remote`）
- [x] 浏览器验收（staging）：下单 → 查询密码取卡密 → 错密码拒绝 → 管理端操作全流程。（2026-10-17 最终验收通过，HEAD 62d8797，staging Version 375c8e5e；另有 API 直测覆盖白名单负向、/secret、/pay 假 TXID。）
- [x] 无未提交变更；HEAD 与远端同步。（文档更新提交后复核。）
- [ ] 本分支 `fix/txid-race-safety-2026-10-18`（代码冻结 HEAD `3fc5ab7de8e0d004116aef99eb61aafd9b0ce7c3`，P1-1/P1-2 + 本轮收尾 v18 已实现；已推送，见 PR #4）：本地 txid-race-deterministic 234/234、review-p1-backend 139/139、review-fixes 273/273、review-config 53/53、mock ALL DONE、stock 17/17、security 104/104、concurrency 118/118、release-readiness 91/91、payment-whitelist ALL PASS、app-icons 111/111、本地浏览器 acceptance-ci 103/103、review-frontend 64/64、d1-local ALL OK（`current_version=18`）。**Staging 只读核验见 docs/RELEASE_READINESS.md 附录（2026-10-18 14:42:15–14:45:09 UTC，Version 34e3f190，v17）**；本轮未部署 Staging，部署须逐项授权。旧 pre-existing `#captchaCode` 超时本轮本地未复现；最终以 GitHub CI 为准。文档数字同步提交 (c) 不改代码/测试/CI，最终 HEAD 即提交 (c) 本身（SHA 见 PR #4 本轮评论与 CI run）。

## B. 真正可收款运营（与 A 分开，不得混同）

- [ ] 收款地址已填**真实**地址（`usdt_addresses`：`OKX|X Layer`、`Binance|BEP20`），非测试 dummy 地址。
- [ ] 真实小额转账验收：向真实收款地址转一笔真实小额 USDT（X Layer 与 BEP20 各一笔），核验轮询自动发货 + TXID 核验 + 订单履约记录。无此证据则为 BLOCKED / NOT VERIFIED。
- [ ] ProdSeller：已配真实 API Key（Env Secret），`prodseller_enabled` 按需开启；上游余额充足；上游商品已同步且售价已确认。
- [ ] 站名、公告、须知、客服链接已填真实内容；测试 dummy 数据已清除。
- [ ] 管理员密码已改为强密码（首次登录强制改密已完成）；旧默认密码 `admin` 已失效。
- [ ] 生产 D1 已备份（`wrangler d1 export` 或 CF 面板快照）。

## C. 部署

- [ ] 生产部署须用户明确授权后另行执行，不在此列；staging 部署见 RUNBOOK。
- [ ] 部署后验证：`/api/config` 200、首页 200、schema-check `up_to_date: true`、后台登录正常。
- [ ] 回滚方案已确认：重新部署 main 分支旧版 Worker 即可（见 RUNBOOK）。

## D. 上线后监控（首 24 小时）

- [ ] 观察 cron 轮询日志（无异常 500、无 RPC 失败刷屏）。
- [ ] 观察待付款订单：超时自动取消是否正常；无卡密预留泄漏。
- [ ] 观察后台告警：上游 402/409/429、异常订单。
- [ ] 首笔真实订单全流程人工跟进（下单 → 到账 → 发货 → 买家取卡密）。

## F. TXID 认领安全（v17 + v18，P1-1/P1-2，本分支新增）

- [ ] 迁移 v18 已应用：`GET /api/admin/migrate` → `current_version = 18`；`schema-check` → `ok=true`（含 `orders.pending_tx_hash` / `orders.payment_state`、`lookup_attempts` 三列、`txid_claims` 六列：`tx_hash` / `order_id` / `claimed_at` / `claim_token` / `source` / `order_lease_token`）。v16（6 个查询索引）与 v17 已应用，不是“尚未应用”。
- [ ] 租约-first：`fulfillAfterPayment` 先原子获取订单租约再碰认领表；无租约不触碰认领；认领失败只释放本请求租约、不触碰认领行。
- [ ] 永久保留：已消费 TXID 认领永不被普通 API、租约接管、失败恢复或订单取消自动删除（`releaseTxidClaim` 已删除，无自动释放入口）；`orders.tx_hash` 保留第一笔已消费 TXID，不被未验证候选覆盖；未核验候选只写 `pending_tx_hash`；新 TXID 通过核验后成为第二笔付款事件（独立认领行 + 账本行）。
- [ ] 认领查询异常 fail-closed；Schema 迁移不完整时不许降级写入（v17/v18 列缺失即报迁移错误，不回退旧插入、不回退写 `tx_hash`）。
- [ ] 链上认领与账本写入安全顺序：`processVerifiedPayment`（已入账去重 → 旧认领账本恢复 → 金额一致性 → 第二笔分流 → 租约 → 认领 → 账本 → 副作用 → 入账标 `posted`）；获得全局消费权前绝不写付款事实语义账本行。账本与认领归属不一致时 `restoreOldClaimLedgers` 先补齐旧账本；账本行归属他单时返回冲突、绝不覆盖。
- [ ] 第二笔 / 超额 / 对账语义：第二笔真实付款记 `verified/overpaid_pending` + `payment_state='overpaid_pending'`，不重复发货；对账为 `reconciled` 后无其他超额行时清 `payment_state`；退款为人工流程，系统不执行真实资金退款。
- [ ] 过期清理与链上扫描解耦：`poll_enabled=0` 时零 RPC，但过期清理仍运行；过期候选只选真正过期订单、按有效过期时间排序；取消守卫为已过期 + 无已消费付款事实 +（未认领或租约已过期），取消绝不删除认领/账本，重复运行幂等；候选查询失败 fail-closed。
- [ ] 人工与链上共享全局认领：同一 `txid_claims`，`tx_hash` 主键决定胜负；`source` 首次写入获胜不改写；`manual_confirmed` 仅表示人工确认，不构成链上证据，不伪造回执/区块高度/确认数。无 TXID / 非 64 位时不写认领行，但仍记一笔 `manual_confirmed` 账本行（对账可追溯）。
- [ ] 人工账本 fail-closed：账本写入失败时不推订单为已付款/已交付；仅重读确认已有同订单 + 同 TXID + 同状态 `manual_confirmed` 行才可幂等继续，否则释放租约、认领保留、同订单重试。
- [ ] 查单与验证码：`/lookup` 按单原子记数（`lookup_attempts`，与 `/secret` 同口径）；`/secret` 认证前失败路径统一 401“查询密码错误”；验证码字符为 5×7 点阵 `<rect>`（无 `<text>` 节点）；`/pay` / 登录 / 上游限流检查异常时 fail-closed。
- [ ] 确定性测试证据：`tests/txid-race-deterministic-test.mjs` 234/234（Barrier/Deferred 确定性交错，不依赖调度/时间窗口；覆盖同订单认领回滚竞态、租约接管 + 过期回滚、双管理员并发人工确认、人工/链上双向竞态、账本失败恢复、已消费认领永久保留、真正同时竞争、过期清理公平筛选含第 501 笔订单、v18 候选/已消费分离与第二笔/超额语义、认领查询 fail-closed、迁移不完整不降级写入、`/lookup` 按单记数、`/secret` 统一文案、验证码点阵化、限流 fail-closed）。
- [ ] 未验证项仍 BLOCKED / NOT VERIFIED：真实 Turnstile Widget、真实链上收款、P1-11 真实上游幂等。本地 Mock / CI / Staging 浏览器操作不得描述为真实链上支付或真实上游采购验证。自动采购门禁（`prodseller_enabled=0`）保持关闭。

## E. 域名上线（zhixuanpro.com，仅清单；本轮只更新清单，不注册/改 DNS/绑生产域名）

- [ ] 所有权与 DNS 托管已确认：域名注册人/所有权归属、DNS 托管方（注册商 / Cloudflare）、注册商与 DNS 管理权限持有人已确认；任何过户/转入/改 NS 须独立审批。
- [ ] Cloudflare Zone：域名已加入正确的生产 Cloudflare 账号 Zone（非 staging 账号），Zone 状态 Active，NS 与注册商侧一致。
- [ ] Route / Custom Domain：生产域名（`zhixuanpro.com`，含 www 与否按 canonical 决策）只指向生产 Worker `aisou-lite`；绝不指向 staging Worker `zhixuan-shop-staging`。
- [ ] TLS / 重定向 / canonical：SSL 模式 Full (Strict)，HTTP→HTTPS 重定向，www 与 apex 的 canonical 唯一且一致，无混合内容。
- [ ] DNS 与路由冲突：无重复/冲突的 A/CNAME/Route 记录；旧测试记录已清理；TTL 已按切换窗口设置。
- [ ] Staging 不被生产域名替换：staging 仍可通过 `https://zhixuan-shop-staging.f-00a.workers.dev` 访问；生产域名上线后复核 staging 未被替换/别名。
- [ ] 独立审批与回滚：域名切换须用户单独明确审批（与代码部署审批分开）；回滚 = 恢复切换前 DNS/Route 并验证，切换前已记录旧值快照。
- [ ] 未验证项：真实链上付款仍 NOT VERIFIED（见 B）；域名切换本身未经真实演练前为未验证；本清单的勾选须以真实验证输出为准，不得仅凭“已配置”勾选。
