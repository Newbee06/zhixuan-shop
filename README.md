# 智选（zhixuan-shop）— Cloudflare Worker + D1 轻量版虚拟商品商城

AI 会员 / 代充 / 成品号 / 卡密商城，单 Worker + 单 D1，Cloudflare 免费版，无 npm 构建链（vanilla JS + CSS 内嵌）。

**线上状态（2026-10-16）**：已部署。Worker 名 `aisou-lite`、D1 名 `aisou-lite-db`（内部名未随品牌改名），前台站名 `智选`，地址 <https://aisou-lite.f-00a.workers.dev>。

## 完整链路（一句话）

客户付给你（USDT 到你的收款地址）→ CF cron 每 1 分钟轮询链上到账（精确金额匹配）→ 若商品 `source=prodseller` 则调 ProdSeller 拿货；若 `source=self` 则本地卡密自动发或人工发货 → 交付内容在站内查单页查看（**不发邮件**）。

三条收款确认路径（CF 轮询 / 手动 TXID 核验 / 管理员确认收款）都复用同一个 `fulfillAfterPayment(env, order, txHash, ctx)`，不写三份重复发货逻辑。币安 UID 站内转账无链上 TXID，走手动兜底：客户提交币安订单 ID，管理员核对后点确认收款，同样走 `fulfillAfterPayment`（上游商品也要走 ProdSeller 拿货，不要只发本地卡密）。

## 功能

- 前台：商品列表（分类：代充 / 成品号 / 卡密 + 搜索）、商品详情、下单表单（自定义字段 + 数量 + Binance/OKX + X Layer/TRC20/ERC20/BEP20）、下单成功页（订单号 + **精确应付金额 actual_amount + 收款地址 + 20 分钟倒计时** + 复制 + QR + 支付教程链接，文案“付完不用做任何事，等 1-3 分钟自动发货”）、订单查询页（凭邮箱或订单号查状态与交付内容，**无查询密码**）。
- 订单状态：`pending_payment / pending_fulfill / pending_activation / pending_upstream / completed / cancelled`。
  - `pending_activation`：上游已付款（paid），等待轮询到 delivered 才发货，deliveredKey 出现前不发。
  - `pending_upstream`：上游暂不可发货（402 余额不足 / 409 缺货 / 429 限速 / 500），后台置顶告警，不发货。
- 商品来源自营 + 上游并存（见下“商品来源”）。
- **邮件已移除**：`sendEmail` 直接返回 `email_removed`，不再发任何邮件。交付内容只在站内查单页可见；设置里的 `email_from / email_enabled / delivery_mode` 为历史残留，不再生效。
- 后台（单管理员）：PBKDF2（100000 次）+ salt + httpOnly session cookie，初始密码 `admin` 首次登录强制改密；左侧导航（数据 / 订单 / 商品 / 卡密 / 设置 / 上游），进后台默认打开“数据”页，统计卡只在“数据”页显示；商品 CRUD、卡密批量导入 / 禁用、订单确认收款 / 发货 / 取消、上游管理（同步 / 余额 / 导入 / 告警 / 上游订单）、设置。
- 7 天清理：cron 每天跑，`fulfilled_at` 超过 7 天的已完成订单清空卡密 / 账号交付数据并标记 `data_expired`，前台按同样规则隐藏。
- 支付：**CF 轮询自动发货**：下单生成 `actual_amount = 基础价 + 随机尾数 0.0001-0.0099`，锁定 20 分钟（`expires_at`），同地址同窗口唯一；cron 每 1 分钟查 D1 有无 `pending_payment`，无则零 RPC；有则查 Tronscan / 公开 RPC 匹配 to + 金额。超时自动取消，释放金额占用。
- 下单防护：图形验证码（一次性、5 分钟过期、最多试 3 次）+ 同 IP 下单限流。

## 库存口径（前后台统一）

| 商品类型 | 库存来源 |
|---|---|
| 对接商品（`source=prodseller`） | ProdSeller 同步的 `in_stock` |
| 自营卡密 / 成品号（`source=self`，`stock_type=card`） | `cards` 表中 `is_used=0 AND is_disabled=0` 的真实数量 |
| 自营人工发货（`source=self`，`stock_type=manual`） | 后台设置的 `in_stock`（有货/缺货） |

- 后台商品 API 额外返回 `card_stock`，商品卡显示“卡密库存：N”，为 0 时提示“需补货”。
- 下单时自营卡密 / 成品号会再次检查卡密数量，不足时返回“卡密库存不足，补货中”。
- 发卡用条件更新 `WHERE is_used = 0`，已抢到的卡不足数量时回滚本次已领取卡，降低并发重复发同一张卡的风险。
- 前台 `in_stock=0` 显示“缺货 · 补货中”并禁用购买按钮。

## 商品来源：自营 + 上游并存

`products` 表字段（新库直接建表，老库 Worker 启动时 `ensureProductColumns` 自动 ALTER 补列）：

| 字段 | 说明 |
|---|---|
| `source` | `self` 自营 / `prodseller` 上游，默认 `self` |
| `prodseller_id` | 上游商品 ID |
| `cost_price` | 成本价（上游导入时取上游 cost） |
| `sell_price` | 前台售价。兼容旧 `price_usdt`：读时优先 `sell_price` |
| `requires_email_activation` | 是否激活类（1 = 必须填激活邮箱） |
| `delivery_method` | `onsite` 仅站内 / `email` 仅邮件 / `both` 站内+邮件，默认 `both`（历史字段，邮件已移除，实际交付只看站内） |
| `stock_type` | `card` 卡密自动发 / `manual` 人工发货 |
| `in_stock` | 人工商品的手动库存；卡密/上游商品不靠它决定库存 |

- 自营商品：后台 CRUD，新增 `delivery_method` 选择、`form_fields` 自定义。
- 上游商品：后台 → 上游 → 同步（`POST /api/admin/upstream/sync`，拉 `GET https://prodseller.com/v1/products`，结果存 `upstream_cache` 表 `payload + fetched_at`，前台不直接拉上游）→ 导入（`POST /api/admin/upstream/import`，从缓存读，售价 = `cost × markup + fixed`，`markup` / `fixed` 在设置里配，默认 `1.2 / 0`）。同步限速 **300/15min**（`admin_meta` 存窗口计数），要缓存，不要高频拉。
- 新增表：`upstream_orders`（`order_id / prodseller_order_id / status / amount / delivered_keys / created_at`）+ `upstream_cache`（`key / payload / fetched_at`）。

## 后台商品表单说明（给管理员看的）

- **slug**：新增商品时可留空，前端自动生成类似 `p-<时间编码>` 的唯一标识；手动填写时会转小写、去掉非法字符并用连字符连接。它是数据库里的唯一商品标识。**注意：编辑商品时改 slug 不会保存**（见“已知限制”）。
- **上游商品 ID**：来源为“自营”时隐藏；来源为“上游”时显示。正常通过“上游”页同步、导入，系统自动填写。对接商品付款后靠该 ID 调 ProdSeller 下单拿货，**不需要手动添加卡密**。
- **分类与发货方式联动**：选分类时自动设库存类型并提示——卡密/成品号 → “卡密自动发”（付款后从本地卡密库自动取货）；代充 → “人工发货”（付款后进入待发货，管理员在订单页填写交付内容）。
- **自营卡密导入**：自营卡密/成品号商品卡有“导入卡密”按钮，点击跳到“卡密”页并自动预填商品 ID，管理员只需每行粘贴一条卡密/账号后导入。对接商品和自营人工代充不显示该按钮。
- **商品分组**：对接商品默认折叠，自营商品默认展开，两组可独立展开/收起。
- **人工库存状态**：人工发货商品表单有“有货/缺货”开关；卡密商品和对接商品不显示，由真实卡密数或上游同步决定。

## ProdSeller 对接（服务端 Secret，绝不暴露前端）

- Env：`PRODSELLER_API_KEY`（wrangler secret）、`PRODSELLER_BASE_URL`（默认 `https://prodseller.com/v1`，`wrangler.toml` `[vars]` 可覆盖，设置里 `prodseller_base_url` 也可配，优先级 Env > 设置 > 默认）。
- 下单流程：客户付给你（CF 轮询确认）→ Worker 调 `POST /v1/orders`，Header `X-API-Key` + `Idempotency-Key = 你的 order_no`（防重复扣费），Body `productId / quantity / email` 或 `emails`（仅当 `requiresEmailActivation=true` 时必传激活邮箱）。
- 响应：
  - `status=delivered` → 立刻取 `deliveredKey / deliveredKeys` 发货；
  - `status=paid`（激活类）→ 存 `prodseller_order_id`，置 `pending_activation`，Cron/轮询调 `GET /v1/orders/:id` 直到 delivered 才发货，`deliveredKey` 出现前不发。
- 异常：`402` 余额不足 → 订单置 `pending_upstream`、后台置顶告警（后台 → 上游 → 置顶告警）、不发货；`409` 缺货 → 标记缺货、转人工；`429` 限速 → 退避重试（下次轮询继续）；`500` → 重试 + 日志（`admin_note`）。所有上游调用验状态码，记录 `prodseller_order_id / amount / discount`（`discount` 记入 `admin_note`，不暴露前端）。
- `pending_upstream` 且尚无上游单号时，激活轮询会重试下单（同一 `Idempotency-Key=order_no` 防重复扣费）；已有单号时只轮询 `GET /v1/orders/:id`。

## 邮箱字段（历史说明）

下单 body 里 `customer_fields` 仍包含 `contact_email / delivery_email / activation_email`（按需），后端校验格式与两次激活邮箱一致：

| 邮箱 | 用途 | 何时必填 |
|---|---|---|
| ① `contact_email` 联系邮箱 | 所有订单的联系方式 | 所有订单都要 |
| ② `delivery_email` 交付邮箱 | 历史字段，可与联系邮箱相同 | 自营邮件发货类曾必填，邮件移除后不再用于发货 |
| ③ `activation_email` 激活邮箱 | **要开通会员的邮箱**，必须填对，不是备注 | 仅 ProdSeller `requiresEmailActivation` 商品必填 |

激活类必须填 `activation_email` 并校验格式 + 二次输入 + 勾选确认 + 二次确认弹窗“这是要开通的邮箱，填错无法开通”。

## CF 轮询自动收款（scheduled 分发）

`wrangler.toml` 已有 2 个 cron：`0 2 * * *` 清理 + `*/1 * * * *` 轮询。`scheduled` 按 `event.cron` 分发：

| cron | 动作 |
|---|---|
| `*/1 * * * *` | `runPolling`（复用已有函数，不重写）+ `pollUpstreamActivations`（上游激活轮询） |
| `0 2 * * *` | `cleanupExpired` + `pollUpstreamActivations` |
| 无 `event.cron` | 按时间判断：UTC 02:00 跑清理分支，否则跑轮询分支（两分支都顺带跑上游激活轮询） |

`runPolling` 已存在，不要重写，只确保 `scheduled` 真正调用它。下单生成 `actual_amount` 复用已有 `genActualAmount`。

## 完整版故意没做的

- TG Bot 自动通知（现为 TG 客服链接占位，需手动联系）
- 多管理员、角色权限、多账号、退款 / 售后工单、分销 / 分站、优惠券、秒杀
- 国内支付（支付宝 / 微信）与发票
- 邮件通知（已移除）

## 合规提示（请保留在页面与运营中）

- 仅售卖自己有合法货源的虚拟商品 / 代充服务，不要售卖盗号 / 共享 / 违反平台 ToS 的账号。
- 虚拟商品一经交付不退换，需在页面明示（前台已明示）。
- 不要用本项目从事欺诈、洗钱或其它违法行为；USDT 收款请遵守当地法律法规与交易所规则。

## 技术

- 单 Worker + 单 D1 + 2 个 cron，Cloudflare 免费版，无付费功能，无 npm 构建链（vanilla JS + CSS 内嵌）。
- `src/worker.js`：API + 路由（import 前端 HTML，Text 规则，无构建）。
- `src/frontend.html`：前端（iOS 气泡琉璃风格：毛玻璃 + 大圆角 + 柔和高光 + 浅色/深色跟随系统 + 手机端适配）。
- `schema.sql`：`products / cards / orders / settings / admin_meta / sessions / upstream_orders / upstream_cache / captcha_codes / order_rate`。
- 全部参数化查询，输入校验；PBKDF2 迭代 100000（Workers 生产 WebCrypto 上限，不要用 120000）。
- ProdSeller / Resend 密钥只走 `wrangler secret`，绝不进代码 / 前端 / 日志。Resend 密钥已不再使用（邮件移除）。

## 配置说明

### Secret 设置（bash 管道写法，不要经 Python subprocess 传 stdin）

```bash
printf %s "$VAL" | npx wrangler secret put PRODSELLER_API_KEY
```

`$VAL` 请在执行前于当前 shell 赋值（如 `VAL=你的key`），不要把真实 key 写进任何文件。`PRODSELLER_BASE_URL` 在 `wrangler.toml` `[vars]`，默认 `https://prodseller.com/v1`，不用 secret。

### 加价设置（后台 → 设置）

- `upstream_markup`：默认 `1.2`；`upstream_fixed`：默认 `0`。导入售价 = `cost × markup + fixed`。
- `prodseller_base_url`：上游 Base URL（Env 优先于此设置）。
- `poll_enabled`：`1` 开轮询 / `0` 关轮询（关了只走手动 TXID / 管理员确认）。
- `site_name`：前台站名，当前为 `智选`。
- `cny_rate`：前台 CNY 展示汇率，当前 `7.2`。

### RPC / 合约地址在哪改（后台 → 设置，不改代码）

- `rpc_urls`：JSON，键是链，如 `{"X Layer":["https://xlayerrpc.okx.com"],"ERC20":[...],"BEP20":[...]}`。轮询 EVM 链时按此拉 `eth_getLogs`。
- `usdt_contracts`：JSON，键是链，如 `{"X Layer":"0x你的XLayer合约","ERC20":"0xdAC17F...","BEP20":"0x55d398...","TRC20":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"}`。TRC20 轮询走 Tronscan。
- `usdt_addresses`：JSON，键是 `支付方式|链`，如 `Binance|X Layer`。改完保存即生效。
- `binance_uid`：币安 UID 站内转账的收款 UID（后台设置）。

### 域名：阿里云买的 + 解析到 CF

- 阿里云域名解析到 Cloudflare、代码放在 CF（Workers）上 → **无需 ICP 备案**，备案看的是服务器位置，不是域名在哪买的。
- 阿里云域名仍需做**实名认证**，否则解析会被停。
- 在阿里云域名控制台把 NS 改为 Cloudflare 分配的 NS，或在 CF 添加 A/CNAME 解析（按 CF 的 DNS 引导操作），生效后用 `https://<你的域名>/` 访问。
- 若未来把源站换到大陆服务器，则需要备案。

## 部署步骤

```bash
cd zhixuan-shop

# 1. 创建 D1（记下 database_id，填到 wrangler.toml）
npx wrangler d1 create aisou-lite-db

# 2. 建表 + 种子数据（示例商品/设置均为占位）
npx wrangler d1 execute aisou-lite-db --file=schema.sql --remote

# 3. 设置 secret（见上“Secret 设置”，不要把 key 写进文件）
printf %s "$VAL" | npx wrangler secret put PRODSELLER_API_KEY

# 4. 本地开发（可选）
npx wrangler dev

# 5. 部署
npx wrangler deploy
```

### 改密与设置（部署后第一件事）

1. 打开 `https://<你的域名>/` → 点“后台” → 用 `admin` 登录 → 首次登录强制改密（至少 8 位）。
2. 后台 → 设置：把 `usdt_addresses` 里的占位地址换成你真实的 Binance / OKX 收款地址，把 `tg_link`、`announcement`、`order_notice`、`pay_tutorials` 换成真实值；按上文配好 `upstream_markup` / `upstream_fixed` / `rpc_urls` / `usdt_contracts`。
3. 后台 → 商品：删除 / 替换示例商品；后台 → 卡密：删除演示卡密，导入真实卡密。
4. 不要把真实密码 / secret 写进代码、日志或 README。

## API 列表

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/config | 公开配置（收款地址、公告、须知、TG） |
| GET | /api/products | 商品列表（含 `source / sell_price / requires_email_activation / delivery_method / in_stock`，库存按真实口径推导） |
| GET | /api/products/:id | 商品详情（同上） |
| POST | /api/orders | 下单（`customer_fields` 含 `contact_email / delivery_email / activation_email` 按需；需图形验证码） |
| GET | /api/orders?contact=<邮箱> | 按邮箱查单（无查询密码） |
| GET | /api/orders/:no | 按订单号查单（无查询密码） |
| POST | /api/orders/:no/pay | 提交 TXID（可选兜底；币安 UID 填订单 ID 走手动核对） |
| POST | /api/admin/login | 后台登录 |
| POST | /api/admin/logout | 退出 |
| GET | /api/admin/me | 是否需改密 |
| POST | /api/admin/change-password | 改密 |
| GET | /api/admin/stats | 仪表盘统计（含 `pending_upstream / pending_activation`） |
| GET | /api/admin/orders | 订单列表 |
| POST | /api/admin/orders/:id/confirm-payment | 确认收款（复用 `fulfillAfterPayment`：自营卡密自动发，上游走 ProdSeller） |
| POST | /api/admin/orders/:id/fulfill | 发货（手动交付内容） |
| POST | /api/admin/orders/:id/cancel | 取消 |
| GET/POST | /api/admin/products | 商品列表 / 新增（含 `source / prodseller_id / cost_price / sell_price / requires_email_activation / delivery_method`；列表额外返回 `card_stock`） |
| PUT/DELETE | /api/admin/products/:id | 商品编辑 / 删除（PUT 不更新 slug，见“已知限制”） |
| GET | /api/admin/cards | 卡密列表 |
| POST | /api/admin/cards/import | 卡密批量导入 |
| POST | /api/admin/cards/:id/disable | 卡密禁用/启用 |
| DELETE | /api/admin/cards/:id | 卡密删除 |
| GET/POST | /api/admin/settings | 设置读取 / 保存 |
| POST | /api/admin/cleanup | 手动执行 7 天清理 |
| POST | /api/admin/upstream/sync | 上游同步（缓存到 `upstream_cache`，限速 300/15min） |
| GET | /api/admin/upstream/cache | 查看上游缓存 |
| GET | /api/admin/upstream/balance | 上游余额 |
| POST | /api/admin/upstream/import | 从缓存导入上游商品（售价 = cost×markup+fixed） |
| GET | /api/admin/upstream/orders | 上游订单列表 |
| GET | /api/admin/upstream/alerts | 置顶告警（`pending_upstream` 订单） |
| POST | /api/admin/upstream/orders/:id/retry | 重试上游轮询（`pollUpstreamActivations`） |

## 本地校验

- `node --check src/worker.js` 通过；前端 `<script>` 提取后 `node --check` 通过；`schema.sql` 用 Python `sqlite3 executescript` 通过。
- Mock 全链路（`tests/mock-test.mjs`，`node tests/mock-test.mjs`）：用 mock fetch 模拟 ProdSeller（delivered / paid / 402 / 409）、Tronscan、Resend，**未调任何真实接口**。覆盖：自营卡密 → 轮询确认 → 自动发货；上游普通 → 调 ProdSeller → 发货；上游激活 → paid → 轮询到 delivered → 发货；402 → 不发货 + 告警；409 → pending_upstream；重复轮询不重复发货；超时取消；管理员确认收款走 ProdSeller；`Idempotency-Key = order_no`。
- 库存专项（`tests/stock-test.mjs`，`node tests/stock-test.mjs`）：覆盖真实库存口径（上游同步值 / 真实卡密数 / 人工库存）、卡密不足下单拦截、发卡条件更新与回滚。

## 已知限制（待处理，未声称已修复）

1. **通用缺货后端拦截未完成**：订单 API 只强制拦截“自营卡密/成品号库存不足”；自营人工商品或对接商品 `in_stock=0` 时，前台按钮会禁用，但直接调用订单 API 仍可能创建订单。应在订单 API 服务端统一用真实库存口径拦截所有缺货商品。
2. **卡密未在下单时预留**：下单只检查库存，实际卡密要到账后才领取；多个不同邮箱可能在只有 1 张卡时同时建立待付款订单，第一笔付款拿走卡后，第二笔可能付款但无法发货。需设计卡密预留与订单超时释放，或明确采用其他防超卖方案。
3. **现有商品数据仍有配置矛盾**：示例商品 `Cursor 成品号示例`（slug `cursor-account`）是 `category=account`、`stock_type=manual`；Worker 因 `category=account` 会按卡密自动发逻辑处理，但后台编辑表单仍可能显示“人工发货”。应将该商品标准化为 `stock_type=card`，并在服务端保存时强制校验/规范化分类与库存类型，不能只靠前端 onchange。
4. **编辑 slug 的表单与后端不一致**：后台编辑表单仍显示可编辑 slug，但 Worker 的商品 PUT SQL 没有更新 slug，用户修改 slug 后实际不会保存。应选择：编辑时设为只读并解释，或服务端支持唯一性校验后更新。
5. **后台人用流程仍可继续审计**：卡密导入 API 是否应拒绝对接商品/人工商品尚未加严格校验；删除商品后关联卡密如何处理尚未完整审计；订单卡可能对所有状态都显示确认收款/发货/取消按钮，后端会拒绝非法操作，但 UX 仍可能让人困惑，应按订单状态只显示当前可执行动作。

## 目录

- `wrangler.toml` — Worker 配置（name aisou-lite，D1 绑定，`[vars] PRODSELLER_BASE_URL`，cron 2 个：`0 2 * * *` 清理 + `*/1 * * * *` 轮询）
- `schema.sql` — 建表 + 默认设置 + 4 个示例商品 + 演示卡密
- `src/worker.js` — Worker + API + 路由（含 `fulfillAfterPayment / pollUpstreamActivations / prodseller*`）
- `src/frontend.html` — 前端（独立 HTML，经 Text import 引入，无构建）
- `tests/mock-test.mjs` — mock 全链路测试（ProdSeller / Tronscan / Resend 均为 mock）
- `tests/stock-test.mjs` — 库存口径专项测试
- `translations-zh.json / translations-zh.sql` — 上游商品中文标题/简介翻译（品牌名保留英文，链接/格式原样保留）
- `README.md` — 本文件
