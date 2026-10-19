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
- 查单（`POST /api/orders/query`，图形验证码 + IP 限流 30 次/10 分钟，结果上限 10 条）：**订单号/邮箱双查**。关键词含 `@` 按邮箱精确匹配（大小写不敏感，不部分匹配），匹配键为订单号 OR `LOWER(contact)` OR `LOWER(customer_fields.contact_email)`；`activation_email` 不是查询键。列表仅含订单概要，卡密按单走 `/secret` 验密码。
- **邮箱 + 图形验证码 ≠ 所有权证明**；邮件 OTP 未实现。知邮箱可枚举订单概要（隐私风险，见 SECURITY.md）。
- 旧订单（系统凭证 / 旧明文密码 / v14 无 salt 哈希）各有兼容路径，v14 无 salt 哈希仅走管理员流程。
- 旧接口 `GET /api/orders` → 410，文案“旧接口停用，请用订单号或下单邮箱+验证码走当前查单流程”（已落地，2026-10-18 整改集成）。
- 审计写入失败：业务已提交则 `ok:true` + `audit_failed:true`，不得改回 500，不得重复操作，须立即核查 `admin_audit` 并手动补记。

## 前端商品卡字号（以 src/frontend.html 为准，P3-8）

下表为文档核对时从 `src/frontend.html` 实际 CSS 抄录的真实值；文档中流传过的“名称 10px、介绍 8px”以及“Hero 标题 10px / 眉题 8px / 视觉 scale(0.37)”等数值**与代码不符，不得引用**。不为通过注释改设计：如需改字号，须另走代码变更流程。

| 元素 | 选择器 | 字号 | 视口说明 |
|---|---|---|---|
| 商品卡名称 | `.pcard-title` | 16px | 全视口同一值，无移动端覆盖 |
| 商品卡介绍 | `.pcard-desc` | 13px | 全视口同一值，无移动端覆盖 |
| 价格标签 | `.pcard-price-label` | 11px | 全视口同一值 |
| 价格 | `.pcard-price` | 24px | 全视口同一值 |
| 购买按钮 | `.pcard-btn` | 14px | 全视口同一值 |
| 卡片右上角箭头 | `.pcard-arrow` | 18px | 全视口同一值 |
| 卡片元信息（库存/分类） | `.pcard-meta` | 12px | 全视口同一值；`≤640px` 时仅隐藏 `.pcard-cat`，字号不变 |
| 图区图标 | `.pcard-img .emoji` | 56px | 全视口同一值 |
| 图区高宽比 | `.pcard-img` | `aspect-ratio: 4/3` | 全视口同一值 |
| 首页主标题 | `.home-h1` | 桌面 52px；`≤640px` 时 36px | 仅 640px 断点有覆盖 |
| 首页眉题 / 副文案 / 注脚 | `.home-eyebrow` / `.home-sub` / `.home-note` | 14px / 16px / 13px | 全视口同一值，无移动端覆盖 |
| 合集标题 / 星标 | `.home-section-title` / `.home-section-star` | 26px / 30px | 全视口同一值，无移动端覆盖 |

## 管理端

单管理员。PBKDF2(100k) + salt + httpOnly session cookie（HTTPS 下 Secure，SameSite=Lax，7 天过期）。首次登录强制改密，未改密会话只能调 me / change-password / logout。登录限流（IP 15 分钟失败 5 次封禁 15 分钟 + 全站计数）。管理端写操作 CSRF 同源校验。全部关键操作记 `admin_audit`（不记密码、凭证、完整卡密、API Key）。
