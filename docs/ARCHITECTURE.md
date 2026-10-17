# 架构说明（智选商城）

单 Worker + 单 D1，Cloudflare 免费版。无 npm 构建链：`src/worker.js`（Worker + API + 路由）+ `src/frontend.html`（独立 HTML，经 import 引入，无构建）。

## 组件

| 组件 | 说明 |
|---|---|
| Worker | `src/worker.js`，全部 API 与路由；`fetch` / `scheduled` 两个入口 |
| D1 | `aisou-lite-db`（生产）/ `zhixuan-shop-staging-db`（staging），`schema.sql` 为新库基表，旧库由 Worker 启动时按版本迁移（v1–v15） |
| Cron | `*/1 * * * *` 轮询付款 + 上游激活轮询；`0 2 * * *` 7 天清理 + 上游轮询 |
| 上游 | ProdSeller（`prodseller.com/v1`），仅 `source=prodseller` 商品走它；`prodseller_enabled` 门禁默认关闭 |
| 邮件 | 已移除（`sendEmail` 返回 `email_removed`）；交付内容只在站内查单页可见 |

## 请求流

```
浏览器 → Worker fetch → ensureMigrated（轻量版本检查）→ handleApi
  ├─ 公开接口：/api/config、/api/products、/api/orders（下单/查单/取卡密/提交 TXID）
  └─ 管理接口：/api/admin/*（会话 + 改密拦截 + CSRF）
Cron → scheduled → runPolling（付款轮询）+ pollUpstreamActivations（上游激活轮询）
```

## 订单状态机

```
pending_payment ──付款核验通过──▶ pending_fulfill ──发卡/人工发货──▶ completed
       │                              │
       │  上游商品已付款待激活          │ 上游商品需采购
       ▼                              ▼
  pending_activation            pending_upstream ──轮询到 delivered──▶ completed
       │                              │
       └────── 异常（refund_needed） ──▶ refund_pending ──系统外退款+确认──▶ cancelled
pending_payment ──超时 20 分钟──▶ cancelled（自动，释放预留）
pending_payment ──管理员取消──▶ cancelled（仅未付款且未认领）
```

- 终态：`completed`、`cancelled`。终态不可发货/取消/重复确认。
- 已付款订单（`pending_fulfill` / `pending_activation` / `pending_upstream` / `refund_pending`）不得普通取消；无法交付走异常 → `refund_pending` → 系统外真实退款 → 管理员确认已退款 → `cancelled`。系统不执行真实资金退款。
- 全部状态转移为条件 UPDATE（带状态/认领令牌条件），并发下只允许一个成功。

## 库存与并发

- 自营卡密：下单时立即预留（原子条件更新 `reserved_order_id IS NULL`），抢不到回滚删单；取消/超时释放；发货优先用本单预留卡。
- 认领租约：`claim_token` + `claimed_at`，处理者崩溃后超租约可被接管；接管时识别上次副作用（上游单号/已标记卡密），不重复采购、不重复发卡。
- TXID 认领：同一链上交易只能被一个订单认领（`txid_claims` 唯一，严格先到先得，永不抢占）。
- 付款账本：`payments` 表，同一事件（`chain, tx_hash, event_key`）唯一，重复轮询/并发提交不重复入账。
- 上游幂等：`Idempotency-Key = order_no`，重试不重复采购；`upstream_orders` 按 `order_id` 唯一。

## 支付（摘要，详见 docs/PAYMENT_FLOW.md）

仅 OKX|USDT0·X Layer 与 Binance|USDT·BEP20。TRC20 / ERC20 / 站内转账代码已删除。收款确认三条路径（轮询 / TXID 核验 / 管理员确认）复用同一 `fulfillAfterPayment`。

## 查单与凭证（摘要，详见 docs/SECURITY.md）

- 下单必填查询密码（6–64 位），服务端只存随机 16 字节 salt + PBKDF2(100k) 哈希。
- 查单仅按订单号（+ 图形验证码）→ 概要列表；卡密按单走 `/secret` 验密码。
- 邮箱不是查询凭证。旧订单（系统凭证 / 旧明文密码 / v14 无 salt 哈希）各有兼容路径，v14 无 salt 哈希仅走管理员流程。

## 管理端

单管理员。PBKDF2(100k) + salt + httpOnly session cookie（HTTPS 下 Secure，SameSite=Lax，7 天过期）。首次登录强制改密，未改密会话只能调 me / change-password / logout。登录限流（IP 15 分钟失败 5 次封禁 15 分钟 + 全站计数）。管理端写操作 CSRF 同源校验。全部关键操作记 `admin_audit`（不记密码、凭证、完整卡密、API Key）。
