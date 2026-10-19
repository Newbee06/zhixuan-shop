# ARCHITECTURE｜系统架构与模块契约（CTO）

> 基于 tip `fix/txid-race-safety-2026-10-18` 实读。  
> 合并前历史长文见同目录 `ARCHITECTURE_LEGACY.md`（由本轮审计改名保留）。  
> **接口与状态机以本节 + `MASTER_SPEC.md` 为准**；实现细节以 `src/worker.js` 为准。

## 1. 运行时拓扑

```
Browser (frontend.html)
    │ HTTPS
    ▼
Cloudflare Worker (aisou-lite / staging: zhixuan-shop-staging)
    ├─ D1 (aisou-lite-db / staging-db)
    ├─ Cron: */1 * * * *  付款扫描 + 上游轮询
    ├─ Cron: 0 2 * * *    7 天清理
    ├─ 公开 EVM RPC（X Layer / BEP20）
    └─ ProdSeller API（secret；prodseller_enabled 门禁）
```

- `wrangler.toml`：`compatibility_date = 2024-01-01`（升日需评估，**NOT VERIFIED**）。
- 无 R2 / KV / Queues / Durable Objects（当前）。

## 2. 核心模块边界

| 模块 | 主要代码 | 拥有者（Bot） |
|---|---|---|
| HTTP 路由 / 鉴权 / 会话 | `src/worker.js` handleApi | Bot2（局部）+ CTO 协调 |
| 订单状态机 / 履约 | `fulfillAfterPayment`, claim* | Bot2 |
| 链上匹配 / TXID / payments | checkChainPayment, scanEvmChain, claimTxid | Bot3 |
| 库存 / 卡密 / 自营商品 | cards, products CRUD | Bot2 |
| ProdSeller 同步采购 | upstream_* API + pollUpstream | Bot2 |
| 前台 + 管理 UI | `src/frontend.html` | Bot4 |
| CI / 回归 / 安全审计 | `tests/`, workflows | Bot5 |
| wrangler / 额度 / 监控 | `wrangler.toml`, Dashboard | Bot6 |

**冲突规则**：同一时刻仅一个 Bot 可改 `src/worker.js` 的同一逻辑区；跨模块改动先记 `DECISION_LOG.md`。

## 3. 数据模型（摘要）

表：`products`, `cards`, `orders`, `settings`, `admin_meta`, `upstream_orders`, `upstream_cache`, `sessions`, `captcha_codes`, `order_rate`, `admin_audit`, `login_attempts`, `txid_claims`, `lookup_rate`, `schema_migrations`, `payments`, `scan_cursors`, `pay_rate`, `app_icons`, `secret_attempts`。

迁移：`migrations/0001`…`0018`（tip 含 0016 查询索引、0017 TXID claim token/source/lease、0018 pending_tx_hash / payment_state / lookup_attempts）。生产迁移须所有者批准。

`products.source`：`self` | `prodseller`。

## 4. 公开 API 契约（稳定面）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 前台配置（无密钥） |
| GET | `/api/products` | 上架商品列表 |
| GET | `/api/app-icons` | 图标 |
| GET | `/api/captcha` | 图形验证码（限流） |
| POST | `/api/orders` | 下单（验证码 + 支付白名单 + 库存预留） |
| GET | `/api/orders` | 列表查询入口（不含交付内容） |
| POST | `/api/orders/:no/lookup` | 凭证查单（交付内容）；凭证在 body |
| POST | `/api/orders/query` | 兼容查单 |

错误：统一 JSON；业务拒绝不泄露可枚举攻击面细节。

## 5. 后台 API 契约（需 admin session）

登录：`POST /api/admin/login`；未改密会话仅允许 me/change-password/logout。

主要面：stats、orders（含 confirm-payment / fulfill / cancel / exception / refund-confirm）、products CRUD、cards import、upstream sync/import/balance/alerts、settings、payments + reconcile、audit、schema-check、migrate、cleanup、pay-config（tip 新增可配收款开关）。

写操作：Origin 同源校验；审计写 `admin_audit`（不记密码/完整卡密/API Key）。

## 6. 履约流水线

```
pending_payment
    │ claimOrderForPayment（租约）
    ▼
fulfillAfterPayment
    ├─ source=self, card  → claimCardsForOrder → completed
    ├─ source=self, manual → pending_fulfill
    └─ source=prodseller → POST /v1/orders (Idempotency-Key=order_no)
            ├─ delivered → completed
            ├─ paid → pending_activation → poll → completed
            └─ 402/409/429/500 → pending_upstream
```

## 7. 支付账本 `payments.status`

`submitted` → `discovered` → `verified` → `confirmed` → `posted`  
异常：`duplicate` | `mismatch` | `unmatched`（人工 reconcile）。

## 8. 前端约束

- 保持 vanilla；不引入 React/Next 等（除非 CTO+所有者批准）。
- 前端校验仅为体验；**资金与发货以后端为准**。
