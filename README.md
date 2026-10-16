# 智选（zhixuan-shop）— Cloudflare Worker + D1 轻量版虚拟商品商城

AI 会员 / 代充 / 成品号 / 卡密商城，单 Worker + 单 D1，Cloudflare 免费版，无 npm 构建链（vanilla JS + CSS 内嵌）。

**线上状态（2026-10-16）**：已部署。Worker 名 `aisou-lite`、D1 名 `aisou-lite-db`（内部名未随品牌改名），前台站名 `智选`，地址 <https://aisou-lite.f-00a.workers.dev>。

**⚠️ 后台重构与安全加固（2026-10-16）**：在分支 `feat/admin-overhaul-security` 上完成，**尚未合并到 main、尚未部署到线上**。线上仍跑旧版 main 代码。本任务不授权部署线上 Worker、修改生产 D1。上线前请按文末“部署注意事项”操作。

## 完整链路（一句话）

客户付给你（USDT 到你的收款地址）→ CF cron 每 1 分钟轮询链上到账（精确金额匹配）→ 若商品 `source=prodseller` 则调 ProdSeller 拿货；若 `source=self` 则本地卡密自动发或人工发货 → 交付内容在站内查单页查看（**不发邮件**）。

三条收款确认路径（CF 轮询 / 手动 TXID 核验 / 管理员确认收款）都复用同一个 `fulfillAfterPayment(env, order, txHash, ctx)`，不写三份重复发货逻辑。币安 UID 站内转账无链上 TXID，走手动兜底：客户提交币安订单 ID，管理员核对后点确认收款，同样走 `fulfillAfterPayment`（上游商品也要走 ProdSeller 拿货，不要只发本地卡密）。

## 功能

- 前台：商品列表（分类：代充 / 成品号 / 卡密 + 搜索）、商品详情、下单表单（自定义字段 + 数量 + Binance/OKX + X Layer/TRC20/ERC20/BEP20）、下单成功页（订单号 + **查单凭证（只展示一次）** + **精确应付金额 actual_amount + 收款地址 + 20 分钟倒计时** + 复制 + QR + 支付教程链接，文案“付完不用做任何事，等 1-3 分钟自动发货”）、订单查询页（凭**订单号 + 查单凭证**查看详情与交付内容；或凭邮箱查看订单概要，不含交付内容；旧订单用旧查询密码只看概要，交付内容联系客服）。
- 订单状态：`pending_payment / pending_fulfill / pending_activation / pending_upstream / completed / cancelled`。状态机由服务端统一校验：待付款订单不能直接发货；已完成/已取消为终态，不可发货/取消/重复确认；人工发货仅从待发货/激活待处理/上游异常进入（显式兜底）。
  - `pending_activation`：上游已付款（paid），等待轮询到 delivered 才发货，deliveredKey 出现前不发。
  - `pending_upstream`：上游暂不可发货（402 余额不足 / 409 缺货 / 429 限速 / 500），后台置顶告警，不发货。
- 商品来源自营 + 上游并存（见下“商品来源”）。
- **邮件已移除**：`sendEmail` 直接返回 `email_removed`，不再发任何邮件。交付内容只在站内查单页可见；设置里的 `email_from / email_enabled / delivery_mode` 为历史残留，不再生效。
- 后台（单管理员）：PBKDF2（100000 次）+ salt + httpOnly session cookie（HTTPS 下自动加 Secure，SameSite=Lax）；初始密码 `admin` 首次登录强制改密，**未改密的会话不能调用除改密/退出外的任何管理接口（后端拦截，不只靠前端隐藏）**；登录限流（同一 IP 15 分钟内失败 5 次封禁 15 分钟）；管理端写操作带 Origin 时必须同源（CSRF）；改密后作废除当前会话外的所有会话。左侧导航（数据总览 / 订单管理 / 商品管理 / 卡密库存 / 上游管理 / 系统设置 / 操作审计），进后台默认打开“数据总览”。订单按状态只显示合法操作按钮（后端同样独立校验）；商品为表格 + 弹窗表单；卡密支持筛选/分页/禁用/启用/导入统计；上游支持目录浏览 + 批量导入 + 售价预览；设置按类型分区并校验；所有关键操作（确认收款/发货/取消/上游重试/配置修改）记入 `admin_audit` 操作审计（不记密码、凭证、完整卡密、API Key）。
- 7 天清理：cron 每天跑，`fulfilled_at` 超过 7 天的已完成订单清空卡密 / 账号交付数据并标记 `data_expired`，前台按同样规则隐藏；同时释放过期预留。
- 支付：**CF 轮询自动发货**：下单生成 `actual_amount = 基础价 + 随机尾数 0.0001-0.0099`，锁定 20 分钟（`expires_at`），同地址同窗口唯一；cron 每 1 分钟查 D1 有无 `pending_payment`，无则零 RPC；有则查 Tronscan / 公开 RPC 匹配 to + 金额。超时自动取消，释放金额占用与卡密预留。
- 下单防护：图形验证码（一次性、5 分钟过期、最多试 3 次）+ 同 IP 下单限流。

## 库存口径（前后台统一）

| 商品类型 | 库存来源 |
|---|---|
| 对接商品（`source=prodseller`） | ProdSeller 同步的 `in_stock` |
| 自营卡密 / 成品号（`source=self`，`stock_type=card`） | `cards` 表中 `is_used=0 AND is_disabled=0 AND reserved_order_id IS NULL` 的可用数量（已预留不算可用） |
| 自营人工发货（`source=self`，`stock_type=manual`） | 后台设置的 `in_stock`（有货/缺货） |

- 后台商品 API 额外返回 `card_stock`（可用）、`card_reserved`（已预留）、`card_used`（已用）、`card_disabled`（禁用），卡密页按商品展示四项统计。
- **卡密预留（防超卖）**：下单时立即预留所需数量的卡密（原子条件更新 `reserved_order_id IS NULL`，抢不到则回滚并删单报错，绝不静默创建注定无法交付的订单）；订单取消或支付超时后自动释放预留；发货时优先分配本订单预留的卡，预留丢失时兜底补抢，仍不足则转人工。预留卡不计入可用库存，其他订单无法重复预留同一张卡。
- 发卡用条件更新 `WHERE is_used = 0`，已抢到的卡不足数量时回滚本次已领取卡，降低并发重复发同一张卡的风险。
- 下单时服务端统一校验所有商品类型：对接商品 `in_stock=0`、人工商品 `in_stock=0`、卡密商品可用卡不足时均直接拦截，绕过前端按钮也无法下单。
- 前台 `in_stock=0` 显示“缺货 · 补货中”并禁用购买按钮。

## 商品来源：自营 + 上游并存

`products` 表字段（新库直接建表，老库 Worker 启动时 `ensureProductColumns` 自动 ALTER 补列）：

| 字段 | 说明 |
|---|---|
| `source` | `'self'` 自营 / `'prodseller'` 上游，默认 `'self'` |
| `prodseller_id` | 上游商品 ID |
| `cost_price` | 成本价（上游导入时取上游 cost） |
| `sell_price` | 前台售价。兼容旧 `price_usdt`：读时优先 `sell_price` |
| `requires_email_activation` | 是否激活类（1 = 必须填激活邮箱） |
| `delivery_method` | `'onsite'` 仅站内 / `'email'` 仅邮件 / `'both'` 站内+邮件，默认 `'both'`（历史字段，邮件已移除，实际交付只看站内） |
| `stock_type` | `'card'` 卡密自动发 / `'manual'` 人工发货 |
| `in_stock` | 人工商品的手动库存；卡密/上游商品不靠它决定库存 |

- 自营商品：后台 CRUD，新增 `delivery_method` 选择、`form_fields` 自定义。
- 上游商品：后台 → 上游 → 同步（`POST /api/admin/upstream/sync`，拉 `GET https://prodseller.com/v1/products`，结果存 `upstream_cache` 表 `payload + fetched_at`，前台不直接拉上游）→ 导入（`POST /api/admin/upstream/import`，从缓存读，售价 = `cost × markup + fixed`，`markup` / `fixed` 在设置里配，默认 `1.2 / 0`）。同步限速 **300/15min**（`admin_meta` 存窗口计数），要缓存，不要高频拉。
- 新增表：`upstream_orders`（`order_id / prodseller_order_id / status / amount / delivered_keys / created_at`）+ `upstream_cache`（`key / payload / fetched_at`）。

## 后台商品表单说明（给管理员看的）

- **slug**：新增商品时可留空，前端自动生成类似 `p-<时间编码>` 的唯一标识；手动填写时会转小写、去掉非法字符并用连字符连接。它是数据库里的唯一商品标识。编辑时也可以修改 slug，后端做唯一性校验（与其它商品冲突时报错）。
- **上游商品 ID**：来源为“自营”时隐藏；来源为“上游”时显示。正常通过“上游”页同步、导入，系统自动填写。对接商品付款后靠该 ID 调 ProdSeller 下单拿货，**不需要手动添加卡密**。
- **分类与发货方式联动**：选分类时自动设库存类型并提示——卡密/成品号 → “卡密自动发”（付款后从本地卡密库自动取货）；代充 → “人工发货”（付款后进入待发货，管理员在订单页填写交付内容）。后端保存时统一规范化分类/来源/库存类型（自营卡密/成品号强制 `stock_type=card`），不只靠前端。
- **自营卡密导入**：自营卡密/成品号商品有“导入卡密”按钮，点击跳到“卡密”页并自动预填商品 ID，管理员只需每行粘贴一条卡密/账号后导入。对接商品和自营人工代充不显示该按钮。导入返回新增/重复/无效/总行数统计（此前把循环次数误当成功数量已修复）。
- **商品分组**：后台商品管理改为统一表格（搜索/筛选/分页/上下架），不再按来源分组折叠。
- **人工库存状态**：人工发货商品表单有“有货/缺货”开关；卡密商品和对接商品不显示，由真实卡密数或上游同步决定。
- **删除商品保护**：有关联订单的商品拒绝删除（提示先下架）；还有卡密的商品拒绝删除（提示先处理卡密）。

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
- `schema.sql`：`products / cards / orders / settings / admin_meta / sessions / upstream_orders / upstream_cache / captcha_codes / order_rate / admin_audit / login_attempts`（含 `orders.query_token_hash`、`cards.reserved_order_id / reserved_at`）。
- 全部参数化查询，输入校验；PBKDF2 迭代 100000（Workers 生产 WebCrypto 上限，不要用 120000）。
- ProdSeller / Resend 密钥只走 `wrangler secret`，绝不进代码 / 前端 / 日志。Resend 密钥已不再使用（邮件移除）。

## 配置说明

### Secret 设置（bash 管道写法，不要经 Python subprocess 传 stdin）

```bash
printf '%s' "$VAL" | npx wrangler secret put PRODSELLER_API_KEY
```

`$VAL` 请在执行前于当前 shell 赋值（如 `VAL='你的key'`），不要把真实 key 写进任何文件。`PRODSELLER_BASE_URL` 在 `wrangler.toml` `[vars]`，默认 `https://prodseller.com/v1`，不用 secret。

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
printf '%s' "$VAL" | npx wrangler secret put PRODSELLER_API_KEY

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
| GET | /api/orders?contact=<邮箱> | 按邮箱查单，**只返回概要**（订单号/商品/金额/状态，不含交付内容、客户字段、联系方式、TXID、后台备注、收款地址） |
| GET | /api/orders/:no?query_token=<查单凭证> | 按订单号查单，**需查单凭证**（订单号 + 凭证）。凭证正确返回完整详情含交付内容；旧订单无凭证时可用旧查询密码，只返回概要 |
| POST | /api/orders/:no/pay | 提交 TXID（可选兜底；币安 UID 填订单 ID 走手动核对） |
| POST | /api/admin/login | 后台登录 |
| POST | /api/admin/logout | 退出 |
| GET | /api/admin/me | 是否需改密 |
| POST | /api/admin/change-password | 改密 |
| GET | /api/admin/stats | 仪表盘统计（含 `pending_upstream / pending_activation`） |
| GET | /api/admin/orders | 订单列表（支持搜索/状态/日期/分页） |
| GET | /api/admin/orders/:id | 单订单管理员详情（后台抽屉用） |
| GET | /api/admin/audit | 操作审计列表（支持 action / order_id / 分页） |
| POST | /api/admin/orders/:id/confirm-payment | 确认收款（复用 `fulfillAfterPayment`：自营卡密自动发，上游走 ProdSeller） |
| POST | /api/admin/orders/:id/fulfill | 发货（手动交付内容） |
| POST | /api/admin/orders/:id/cancel | 取消 |
| GET/POST | /api/admin/products | 商品列表 / 新增（含 `source / prodseller_id / cost_price / sell_price / requires_email_activation / delivery_method`；列表支持搜索/分类/来源/上下架/库存/分页，额外返回 `card_stock / card_reserved / card_used / card_disabled`） |
| PUT/DELETE | /api/admin/products/:id | 商品编辑 / 删除（PUT 支持更新 slug，唯一性校验；删除前检查关联订单与卡密） |
| GET | /api/admin/cards | 卡密列表（支持商品/状态/关键词/分页，状态含未用/已用/禁用/已预留） |
| POST | /api/admin/cards/import | 卡密批量导入（只允许自营卡密/成品号商品；返回新增/重复/无效/总行数） |
| POST | /api/admin/cards/:id/disable | 卡密禁用/启用（已用或已预留卡不能禁用） |
| DELETE | /api/admin/cards/:id | 卡密删除（已用或已预留卡不能删除） |
| GET/POST | /api/admin/settings | 设置读取 / 保存（保存前按类型校验全部字段，敏感键拒绝普通写入；修改记审计） |
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
- 安全专项（`tests/security-test.mjs`，`node tests/security-test.mjs`）：覆盖未授权/伪造/过期 Session、初始改密拦截、退出失效、登录失败限流、人工/上游缺货拦截、卡密预留争抢与取消释放、待付款不可发货、已完成/已取消不可重复处理、查单凭证正确/错误/缺失、邮箱只返回概要、旧订单兼容路径、审计不含敏感数据。

## 已知限制（`feat/admin-overhaul-security` 分支已修复以下 5 项，上线前请先合并部署）

1. ~~通用缺货后端拦截未完成~~ → **已修复**：订单 API 服务端统一用真实库存口径拦截所有缺货商品（对接商品 `in_stock=0`、人工商品 `in_stock=0`、卡密商品可用卡不足），绕过前端按钮也无法下单。
2. ~~卡密未在下单时预留~~ → **已修复**：下单时立即原子预留卡密，取消/超时自动释放，发货优先分配本订单预留卡，预留卡不计入可用库存。
3. ~~现有商品数据仍有配置矛盾~~ → **已修复**：示例商品 `cursor-account` 的 `stock_type` 已标准化为 `card`；服务端保存时强制校验/规范化分类与库存类型，不只靠前端 onchange。
4. ~~编辑 slug 的表单与后端不一致~~ → **已修复**：服务端 PUT 支持更新 slug 并做唯一性校验。
5. ~~后台人用流程仍可继续审计~~ → **已修复**：卡密导入只允许自营卡密/成品号商品；删除商品前检查关联订单与卡密；订单按状态只显示合法操作按钮（后端同样独立校验）；关键操作记入操作审计。

**仍真实存在的限制**（未声称修复）：

- 单管理员、无角色权限、无多账号；无退款/售后工单、分销/分站、优惠券、秒杀。
- 国内支付（支付宝/微信）与发票未做；邮件通知已移除；TG Bot 自动通知未做（仅客服链接占位）。
- 上游激活类商品仍依赖 ProdSeller 轮询，`deliveredKey` 出现前不发货；上游 402/409/429/500 由 `pending_upstream` + 后台告警处理，需人工介入。
- 查单凭证只在下单成功页展示一次，刷新/关闭后不再显示；旧订单无凭证，只能按旧查询密码看概要、联系客服核实交付内容。
- 前台查单、商品列表等公开接口无登录，查单凭证即唯一保护；请勿将订单号+凭证截图外传。

## 数据库迁移（兼容旧库，幂等、非破坏性）

新库直接用 `schema.sql` 建表；**旧库无需手动迁移**，Worker 启动时 `ensureSecurityTables()` 自动补：

- `products.in_stock`、`orders.query_token_hash`、`cards.reserved_order_id`、`cards.reserved_at` 列（`ALTER TABLE ... ADD COLUMN`，`IF NOT EXISTS` 风格检查，不覆盖已有数据）。
- `admin_audit`（操作审计）、`login_attempts`（登录失败限流）表。
- 新增索引：订单状态/过期时间、卡密预留、审计操作/订单。

所有迁移不删表、不改列类型、不清空数据。部署后建议先在测试库验证：登录→改密→下单→查单（凭证）→取消释放预留→审计列表，全部通过后再上线。

## 部署注意事项（`feat/admin-overhaul-security` 分支）

1. **不要直接部署本分支到生产**：先在 GitHub 上审 PR、合并到 main，再按“部署步骤”部署。本任务不授权直接部署。
2. 部署后第一次打开后台，用 `admin` 登录会强制改密（至少 8 位）；改密后旧会话全部作废。
3. 旧订单没有查单凭证：客户用旧查询密码只能看概要，交付内容需联系客服核实；新订单从部署后开始带查单凭证。
4. 部署前备份生产 D1（`wrangler d1 export` 或 CF 面板快照），以防回滚。
5. 回滚方案：重新部署 main 分支的旧版 Worker 即可；旧库的 `query_token_hash` / `reserved_*` / `admin_audit` / `login_attempts` 列和表可保留，旧版代码不读取它们，不影响旧版运行。

## 目录

- `wrangler.toml` — Worker 配置（name aisou-lite，D1 绑定，`[vars] PRODSELLER_BASE_URL`，cron 2 个：`0 2 * * *` 清理 + `*/1 * * * *` 轮询）
- `schema.sql` — 建表 + 默认设置 + 4 个示例商品 + 演示卡密
- `src/worker.js` — Worker + API + 路由（含 `fulfillAfterPayment / pollUpstreamActivations / prodseller*`）
- `src/frontend.html` — 前端（独立 HTML，经 Text import 引入，无构建）
- `tests/mock-test.mjs` — mock 全链路测试（ProdSeller / Tronscan / Resend 均为 mock）
- `tests/stock-test.mjs` — 库存口径专项测试
- `tests/security-test.mjs` — 安全专项测试（鉴权/订单状态机/查单凭证/卡密预留/审计）
- `translations-zh.json / translations-zh.sql` — 上游商品中文标题/简介翻译（品牌名保留英文，链接/格式原样保留）
- `README.md` — 本文件
