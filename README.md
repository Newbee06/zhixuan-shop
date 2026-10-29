# 智选（zhixuan-shop）— Cloudflare Worker + D1 轻量版虚拟商品商城

AI 会员 / 代充 / 成品号 / 卡密商城，单 Worker + 单 D1，Cloudflare 免费版，无 npm 构建链（vanilla JS + CSS 内嵌）。

**线上状态（2026-10-16）**：已部署。Worker 名 `aisou-lite`、D1 名 `aisou-lite-db`（内部名未随品牌改名），前台站名 `智选`，地址 <https://aisou-lite.f-00a.workers.dev>。

**⚠️ 后台重构与安全加固（2026-10-16）**：在分支 `feat/admin-overhaul-security` 上完成，**尚未合并到 main、尚未部署到线上**。线上仍跑旧版 main 代码。本任务不授权部署线上 Worker、修改生产 D1。上线前请按文末“部署注意事项”操作。

## 完整链路（一句话）

客户付给你（USDT 到你的收款地址）→ CF cron 每 1 分钟轮询链上到账（精确金额匹配）→ 若商品 `source=prodseller` 则调 ProdSeller 拿货；若 `source=self` 则本地卡密自动发或人工发货 → 交付内容在站内查单页查看（**不发邮件**）。

三条收款确认路径（CF 轮询 / 手动 TXID 核验 / 管理员确认收款）都复用同一个 `fulfillAfterPayment(env, order, txHash, ctx)`，不写三份重复发货逻辑。人工确认与链上确认共享同一 `txid_claims` 全局认领（`source` 区分 `chain_verified` / `manual_confirmed`，后者仅表示人工确认、不构成链上证据）。仅支持 OKX|USDT0·X Layer 与 Binance|USDT·BEP20 两种组合；TRC20 / ERC20 / 站内转账代码已删除，旧订单不自动认账、转管理员人工处理（见 docs/PAYMENT_FLOW.md）。

## 功能

- 前台：商品列表（分类：代充 / 成品号 / 卡密 + 搜索）、商品详情、下单表单（自定义字段 + 数量 + OKX|X Layer / Binance|BEP20 + **必填查询密码 6-64 位**）、下单成功页（订单号 + **牢记查询密码提示** + **精确应付金额 actual_amount + 收款地址 + 20 分钟倒计时** + 复制 + QR + 支付教程链接，文案“付完不用做任何事，等 1-3 分钟自动发货”）、订单查询页（**订单号或下单邮箱** + 图形验证码 → 订单列表（不含交付内容）；卡密按单走查询密码取；**邮箱 + 图形验证码 ≠ 所有权证明**，邮件 OTP 未实现；旧订单走管理员流程）。
- 订单状态：`pending_payment / pending_fulfill / pending_activation / pending_upstream / completed / cancelled`。状态机由服务端统一校验：待付款订单不能直接发货；已完成/已取消为终态，不可发货/取消/重复确认；人工发货仅从待发货/激活待处理/上游异常进入（显式兜底）。
  - `pending_activation`：上游已付款（paid），等待轮询到 delivered 才发货，deliveredKey 出现前不发。
  - `pending_upstream`：上游暂不可发货（402 余额不足 / 409 缺货 / 429 限速 / 500），后台置顶告警，不发货。
- 商品来源自营 + 上游并存（见下“商品来源”）。
- **邮件已废弃**：`sendEmail` 为 stub，直接返回 `email_removed`，不再发任何邮件。交付内容只在站内查单页可见；设置里的 `email_from / email_enabled` **仅为 API 兼容保留、已废弃**（值不代表可用邮箱配置，`email_from` 种子已清空）；`RESEND_API_KEY` 已废弃、**不要再配置**。
- 后台（单管理员）：PBKDF2（100000 次）+ salt + httpOnly session cookie（HTTPS 下自动加 Secure，SameSite=Lax）；初始密码 `admin` 首次登录强制改密，**未改密的会话不能调用除改密/退出外的任何管理接口（后端拦截，不只靠前端隐藏）**；登录限流（同一 IP 15 分钟内失败 5 次封禁 15 分钟）；管理端写操作带 Origin 时必须同源（CSRF）；改密后作废除当前会话外的所有会话。左侧导航（数据总览 / 订单管理 / 商品管理 / 卡密库存 / 上游管理 / 系统设置 / 操作审计），进后台默认打开“数据总览”。订单按状态只显示合法操作按钮（后端同样独立校验）；商品为表格 + 弹窗表单；卡密支持筛选/分页/禁用/启用/导入统计；上游支持目录浏览 + 批量导入 + 售价预览；设置按类型分区并校验；所有关键操作（确认收款/发货/取消/上游重试/配置修改）记入 `admin_audit` 操作审计（不记密码、凭证、完整卡密、API Key）。
- 7 天清理：cron 每天跑，`fulfilled_at` 超过 7 天的已完成订单清空卡密 / 账号交付数据并标记 `data_expired`，前台按同样规则隐藏；同时释放过期预留。
- 支付：**CF 轮询自动发货**：下单生成 `actual_amount = 基础价 + 随机尾数 0.0001-0.0099`，锁定 20 分钟（`expires_at`），同地址同窗口唯一；cron 每 1 分钟查 D1 有无 `pending_payment`，无则零 RPC；有则查 EVM 公开 RPC 匹配 to + 金额（合约地址、Transfer 事件、收款地址、精确金额、确认数严格核验）。超时自动取消，释放金额占用与卡密预留。仅 OKX|X Layer（USDT0，6 位，1 确认）与 Binance|BEP20（USDT，18 位，15 确认）。
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

`wrangler.toml` 已有 2 个 cron：`0 2 * * *` 清理 + `*/1 * * * *` 轮询（**cron 一律按 UTC 解释：`0 2 * * *` = UTC 02:00 = 北京时间 10:00**）。`scheduled` 按 `event.cron` 分发：

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
- `schema.sql`：`products / cards / orders / settings / admin_meta / sessions / upstream_orders / upstream_cache / captcha_codes / order_rate / admin_audit / login_attempts / txid_claims / lookup_rate / schema_migrations / payments / scan_cursors / pay_rate / app_icons / secret_attempts / lookup_attempts / pricing_templates / categories`（含 `orders.query_token_hash`、`cards.reserved_order_id / reserved_at`、`orders.pending_tx_hash / payment_state`、`txid_claims.claim_token / source / order_lease_token`）。
- 全部参数化查询，输入校验；PBKDF2 迭代 100000（Workers 生产 WebCrypto 上限，不要用 120000）。
- ProdSeller 密钥只走 `wrangler secret`，绝不进代码 / 前端 / 日志。`RESEND_API_KEY` 已废弃、不要再配置（邮件已移除，`sendEmail` 为 stub）。

## 配置说明

### Secret 设置（bash 管道写法，不要经 Python subprocess 传 stdin）

```bash
printf '%s' "$VAL" | npx wrangler secret put PRODSELLER_API_KEY
```

`$VAL` 请在执行前于当前 shell 赋值（如 `VAL='你的key'`），不要把真实 key 写进任何文件。`PRODSELLER_BASE_URL` 在 `wrangler.toml` `[vars]`，默认 `https://prodseller.com/v1`，不用 secret。

### 加价设置（后台 → 设置）

- `upstream_markup`：默认 `1.2`；`upstream_fixed`：默认 `0`。导入售价 = `cost × markup + fixed`。
- `prodseller_base_url`：上游 Base URL（Env 优先于此设置）。
- `poll_enabled`：`1` 开链上扫描 / `0` 关链上扫描（关了只走手动 TXID / 管理员确认；**过期清理不受它控制，`poll_enabled=0` 时仍清理过期未付款订单**）。
  代码默认值：`settings` 里无 `poll_enabled` 行时（只走 BASE_TABLES + 迁移建库、settings 为空）默认 **`0`**——未配置前 cron 默认不开链上扫描；首次建库后先填收款地址/链上配置，再显式把 `poll_enabled` 置 `1` 才开扫描。已有 `settings` 行的库不受默认值影响（`schema.sql` 种子显式写 `1` 的库同样不受影响，部署后仍须先核对配置再放行 cron）。
- 开关语义统一（数据线口径，代码与文档一致）：**开关只控制新建上游单与链上扫描，不控制已有上游单号的履约完成**。
  `prodseller_enabled` 只控制新建上游单（`prodsellerCreateOrder` 门禁）；`poll_enabled` 只控制 `runPolling` 的链上支付扫描；已有 `prodseller_order_id` 的已付款订单无论两开关为何值，都会由上游轮询（`pollUpstreamActivations`，本身不受两开关控制）继续轮询到 delivered 并完成。**不要误以为关闸就停一切；也不要改成关闸后已付款订单也不发货（那会 stranded 已付款订单）。**
- `turnstile_configured`（布尔值，只读标志）：`/api/config` 与 `GET /api/admin/settings` 均返回该标志——开关开 + Site Key 已配 + 服务端 Secret（`TURNSTILE_SECRET_KEY`）已配三者齐全才为真，**绝不返回 secret 本身**。未配 secret 时开启 Turnstile 会全站拒单（fail-closed），**启用前必须先配 secret**；前端凭此标志提示管理员补配置（前端显示由前端线配合）。
- `site_name`：前台站名，当前为 `智选`。
- `cny_rate`：前台 CNY 展示汇率，当前 `7.2`。

### RPC / 合约地址在哪改（后台 → 设置，不改代码）

- `rpc_urls`：JSON，键是链，如 `{"X Layer":["https://xlayerrpc.okx.com"],"BEP20":[...]}`。轮询 EVM 链时按此拉 `eth_getLogs`。仅 X Layer / BEP20 有效。
- `usdt_contracts`：JSON，键是链，如 `{"X Layer":"0x779Ded0c9e1022225f8E0630b35a9b54bE713736","BEP20":"0x55d398326f99059fF775485246999027B3197955"}`。仅 X Layer / BEP20 有效。
- `usdt_addresses`：JSON，键是 `支付方式|链`，如 `OKX|X Layer`、`Binance|BEP20`。改完保存即生效。

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

### 建站令牌轮换（2026-10-30 审计修复，必做）

新库首次登录不用默认密码，改用环境变量 `ZHIXUAN_SETUP_TOKEN`（建站令牌）登录，登录后强制改密。
**代码无法作废环境变量**，所以首次改密后必须手动去 Cloudflare 面板处理令牌，否则令牌长期有效是残留风险：

1. Cloudflare Dashboard → Workers & Pages → 找到本 Worker → Settings → Variables and Secrets。
2. 找到 `ZHIXUAN_SETUP_TOKEN` → Rotate（换一个随机值）或 Delete（删除）。
3. 点 Save / 重新部署（改 Secret 后 Worker 需重新部署才生效，按面板提示操作）。
4. 验证：退出后台再登录，必须走“管理员密码”登录；建站令牌登录路径在密码设置后已失效（代码走密码分支），轮换是纵深防御——防止 D1 被清空重建后令牌复活。

注意：轮换/删除前请确认你已牢记新管理员密码，否则将无法登录后台（只能重建 D1 或重新配置令牌恢复）。

### 管理端 CORS 硬性约束

永不为 `/api/admin/*` 加 `Access-Control-Allow-Origin`（尤其带 Credentials）：管理端用 httpOnly Cookie 会话，
CSRF 防护依赖“浏览器跨站请求必须带同源证明”这一扇门；一旦加 CORS，跨站读写接口的隔离即被打开。
本代码库任何位置不得出现该响应头，回归测试断言其不存在。

## API 列表

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/config | 公开配置（收款地址、公告、须知、TG） |
| GET | /api/products | 商品列表（含 `source / sell_price / requires_email_activation / delivery_method / in_stock`，库存按真实口径推导） |
| GET | /api/products/:id | 商品详情（同上） |
| POST | /api/orders | 下单（`customer_fields` 含 `contact_email / delivery_email / activation_email` 按需；需图形验证码） |
| POST | /api/orders/query | 按订单号或下单邮箱查单（邮箱精确匹配、大小写不敏感；`activation_email` 不是查询键；需图形验证码），**只返回概要**（订单号/商品/金额/状态，不含交付内容；待付款订单附带商家公开收款地址 `pay_address`，见 docs/PAYMENT_FLOW.md）。邮箱 + 图形验证码 ≠ 所有权证明；邮件 OTP 未实现 |
| POST | /api/orders/:no/secret | 按单取卡密（需查询密码 + 限流） |
| POST | /api/orders/:no/pay | 提交 TXID（可选兜底；仅 OKX|X Layer / Binance|BEP20） |
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
- Mock 全链路（`tests/mock-test.mjs`，`node tests/mock-test.mjs`）：用 mock fetch 模拟 ProdSeller（delivered / paid / 402 / 409）、EVM RPC、Resend，**未调任何真实接口**。覆盖：自营卡密 → 轮询确认 → 自动发货；上游普通 → 调 ProdSeller → 发货；上游激活 → paid → 轮询到 delivered → 发货；402 → 不发货 + 告警；409 → pending_upstream；重复轮询不重复发货；超时取消；管理员确认收款走 ProdSeller；`Idempotency-Key = order_no`。
- 库存专项（`tests/stock-test.mjs`，`node tests/stock-test.mjs`）：覆盖真实库存口径（上游同步值 / 真实卡密数 / 人工库存）、卡密不足下单拦截、发卡条件更新与回滚。
- 安全专项（`tests/security-test.mjs`，`node tests/security-test.mjs`）：覆盖未授权/伪造/过期 Session、初始改密拦截、退出失效、登录失败限流、人工/上游缺货拦截、卡密预留争抢与取消释放、待付款不可发货、已完成/已取消不可重复处理、查询密码正确/错误/缺失、订单号/邮箱双查、旧订单兼容路径、审计不含敏感数据。

## 已知限制（`feat/admin-overhaul-security` 分支已修复以下 5 项，上线前请先合并部署）

1. ~~通用缺货后端拦截未完成~~ → **已修复**：订单 API 服务端统一用真实库存口径拦截所有缺货商品（对接商品 `in_stock=0`、人工商品 `in_stock=0`、卡密商品可用卡不足），绕过前端按钮也无法下单。
2. ~~卡密未在下单时预留~~ → **已修复**：下单时立即原子预留卡密，取消/超时自动释放，发货优先分配本订单预留卡，预留卡不计入可用库存。
3. ~~现有商品数据仍有配置矛盾~~ → **已修复**：示例商品 `cursor-account` 的 `stock_type` 已标准化为 `card`；服务端保存时强制校验/规范化分类与库存类型，不只靠前端 onchange。
4. ~~编辑 slug 的表单与后端不一致~~ → **已修复**：服务端 PUT 支持更新 slug 并做唯一性校验。
5. ~~后台人用流程仍可继续审计~~ → **已修复**：卡密导入只允许自营卡密/成品号商品；删除商品前检查关联订单与卡密；订单按状态只显示合法操作按钮（后端同样独立校验）；关键操作记入操作审计。

**仍真实存在的限制**（未声称修复）：

- 单管理员、无角色权限、无多账号；无售后工单、分销/分站、优惠券、秒杀。退款为人工流程（异常 → `refund_pending` → 系统外真实退款 → 管理员确认已退款并填凭证），系统不执行真实资金退款。
- 国内支付（支付宝/微信）与发票未做；邮件通知已移除；TG Bot 自动通知未做（仅客服链接占位）。
- 上游激活类商品仍依赖 ProdSeller 轮询，`deliveredKey` 出现前不发货；上游 402/409/429/500 与网络超时由 `pending_upstream` + 后台告警处理，需人工介入（重试用同一 Idempotency-Key，不重复采购）。
- 查询密码由买家下单时自设（必填 6-64 位），服务端只存随机 salt + PBKDF2 哈希；忘记密码请联系客服重置（管理员重置，记审计）。旧订单（无 salt 哈希）仅走管理员流程。
- 前台查单公开接口无登录，查询密码即唯一保护；请勿将订单号+查询密码截图外传。

## 数据库迁移（版本化，兼容旧库，幂等、非破坏性）

新库直接用 `schema.sql` 建表（已含 v1–v17 结构，版本预置到 v10）；**旧库无需手动迁移**，Worker 首次请求时自动按版本顺序执行 `migrations/0001–0017`（v11–v17 幂等运行，v11 种子图标，v16 补 6 个查询索引，v17 给 `txid_claims` 加认领三列）：

- v1：订单轮询字段（`query_token_hash` 等兼容列）。
- v2：商品上游字段（`in_stock` 等）。
- v3：上游表（`upstream_orders`、`upstream_cache`）。
- v4：安全加固（`admin_audit`、`login_attempts`、卡密预留列 `reserved_order_id` / `reserved_at`、索引）。
- v5：验证码与限流（`captcha_codes`、`order_rate`）。
- v6：认领 / TXID / 异常 / 查单限流（`orders.claim_token`、`claimed_at`、`exception_reason`、`refund_status`、`refund_ref`，`txid_claims`、`lookup_rate`、`schema_migrations`）。
- v7：上游轮询租约（`orders.upstream_lock`、`upstream_lock_expires_at`）+ `upstream_orders.order_id` 去重（留最新行）与唯一索引。
- v16：查询索引补齐（`idx_cards_product`、`idx_cards_used`、`idx_orders_no`、`idx_orders_status`、`idx_orders_created`、`idx_sessions_expires`；`IF NOT EXISTS` 幂等，不删历史数据）。
- v17：TXID 认领令牌化 + 人工/链上共享全局认领（`txid_claims` 加 `claim_token`（每次新认领的 `randomHex(32)`）+ `source`（`chain_verified` / `manual_confirmed`）+ `order_lease_token`（认领时持有者的订单租约）；`ADD COLUMN` 幂等，现有认领行保留）。

机制：每次 API 请求先查 `schema_migrations` 当前版本；版本已最新时**只校验关键表/索引是否齐全**（不能只看 `MAX(version)`——版本号已是最新、但某表/索引被误删时，下一请求会自动自愈重跑迁移补齐；自愈失败则报 503 迁移失败），不再执行 PRAGMA / DDL / 历史修复；版本落后时才按序迁移，每个版本成功后才写入版本记录，失败抛带版本号的明确错误且**不标记成功**（自愈重跑失败时已有版本标记保持不变）。
管理员可经 `GET /api/admin/migrate` 查看版本、`POST /api/admin/migrate` 手动触发。迁移失败时 API 返回 **503 + `code: migration_failed`**（与通用 500 区分，未登录调用方只给通用迁移失败文案，已登录管理员的响应里才附 `migration_detail`）；cron 迁移失败时记日志并跳过当次全部的分发支，不静默拖垮；cron 各分支（轮询 / 清理 / 上游轮询）各自 try/catch，一个分支失败记 `scheduled branch failed: <分支名>` 后继续跑下一个分支。

### 干跑预检（真正的 dry-run）与备份副本预检

- **干跑不升库**：`GET /api/admin/schema-check` 是真正的干跑——它在 `ensureMigrated` **之前**执行（仍须管理员鉴权：未登录 401、未改密 403），用 PRAGMA 与只读查询检查当前库结构（表/列/索引/关键唯一约束）与重复数据（重复待付款金额、重复待付款联系方式），**不应用任何迁移**；返回体含 `dry_run: true, migrated: false`。干跑报告另含 `v14_legacy_no_salt_orders`（见下）。
- **正式迁移走 `POST /api/admin/migrate`**（或部署后首次请求自动迁移）。干跑有差异时先修数据再迁移，不得用干跑代替迁移。
- **备份副本预检操作步骤**（正式迁移前必做，绝不在生产库上直接试迁移）：
  1. 备份生产 D1：CF 面板快照，或 `npx wrangler d1 export <生产库名> --remote --output=backup-<日期>.sql`（不要把备份文件提交进仓库）。
  2. 用备份建一个测试副本库（测试 D1 或本地 `--local` 库）：导入备份 SQL。
  3. 在副本上跑干跑：登录管理端后 `GET /api/admin/schema-check`，确认 `issues` 为空；并在副本上直接查版本与重复数据：
     ```sql
     SELECT MAX(version) AS current_version FROM schema_migrations;
     SELECT pay_address, actual_amount, COUNT(*) AS c FROM orders
       WHERE status = 'pending_payment' GROUP BY pay_address, actual_amount HAVING c > 1;
     SELECT contact, product_id, COUNT(*) AS c FROM orders
       WHERE status = 'pending_payment' AND contact != '' GROUP BY contact, product_id HAVING c > 1;
     SELECT COUNT(*) AS v14_no_salt FROM orders
       WHERE query_password_hash != '' AND (query_password_salt IS NULL OR query_password_salt = '');
     ```
  4. 副本上 `POST /api/admin/migrate` 演练到最新版（当前最新 v21）且业务冒烟通过后，才在生产库执行正式迁移。
- **v14 无 salt 订单**：干跑报告的 `v14_legacy_no_salt_orders` = `query_password_hash` 非空且 `salt` 为空的订单数（v14 遗留无 salt 哈希）。影响：这类订单**自助查单/取卡永久 401**（`/secret` 要求 salt + PBKDF2），**只能管理员人工处理**；本线不实现重设密码接口（那是鉴权线的活），不要用重设密码绕过。
- **外键口径**：迁移路径开头尽力执行 `PRAGMA foreign_keys = ON`，但 D1 语句可能不共享连接、无法保证跨语句强制，故正式口径仍是**“外键只声明不强制、靠应用层守卫”**（产品删除、订单取消、认领等路径的条件写 + 预检），不得假装已强制。

所有迁移不删表、不改列类型、不清空数据。部署后建议先在测试库验证：登录→改密→下单→查单（凭证）→取消释放预留→审计列表，全部通过后再上线。

## 部署注意事项（`feat/admin-overhaul-security` 分支）

1. **不要直接部署本分支到生产**：先在 GitHub 上审 PR、合并到 main，再按“部署步骤”部署。本任务不授权直接部署。
2. 部署后第一次打开后台，用 `admin` 登录会强制改密（至少 8 位）；改密后旧会话全部作废。
3. 旧订单（无 salt 哈希）仅走管理员流程：客户联系客服核实交付内容；新订单从部署后开始用查询密码。
4. 部署前备份生产 D1（`wrangler d1 export` 或 CF 面板快照），以防回滚。
5. 回滚方案：重新部署 main 分支的旧版 Worker 即可；旧库新增的列和表可保留（新增表：`upstream_orders` / `upstream_cache` / `captcha_codes` / `order_rate` / `admin_audit` / `login_attempts` / `txid_claims` / `lookup_rate` / `payments` / `scan_cursors` / `pay_rate` / `app_icons` / `secret_attempts` / `lookup_attempts` / `pricing_templates` / `categories`；新增列：`query_token_hash` / `query_password_hash` / `query_password_salt` / `reserved_*` / `claim_token` / `claimed_at` / `exception_reason` / `refund_*` / `upstream_lock` / `upstream_lock_expires_at` / `app_icon_key` / `schema_migrations` / `txid_claims.claim_token` / `txid_claims.source` / `txid_claims.order_lease_token` / `orders.pending_tx_hash` / `orders.payment_state`），旧版代码不读取它们，不影响旧版运行。
  **回滚不对称（必读，回滚前逐项检查）**：
  - **v8 / v9 唯一索引会留下来继续约束旧代码下单**：回滚后新库的 `idx_orders_amount_claim`（v9 重建版，排除 BinanceUID）与 `idx_orders_contact_pending` 仍在，旧版无 INSERT 重试逻辑，高并发下金额/联系人冲突时旧版下单会直接报 500。回滚前确认无高并发下单场景，或先人工评估重复数据后再决定是否 `DROP INDEX`（DROP 前须先查干跑报告的重复待付款金额/联系方式，见上）。
  - **新订单的 salted 查询密码旧代码不认**：v15 起新订单的查询密码是 salt + PBKDF2 哈希（`query_password_hash` + `query_password_salt`）；回滚到旧版 Worker 后，旧代码的查单/取卡路径不认 salted 哈希，新订单的自助查单/取卡会失败（旧订单的明文/旧凭证路径不受影响）。回滚前须确认：要么接受新订单暂时只能管理员人工处理，要么暂缓回滚。
  - 回滚前检查项清单：① 已备份当前 D1；② 待付款订单数与进行中的上游单（`pending_activation / pending_upstream`）已人工确认去向；③ 干跑报告无未处理差异；④ 回滚后立即冒烟：下单、查单、取卡、取消释放预留。

## 目录

- `wrangler.toml` — Worker 配置（name aisou-lite，D1 绑定，`[vars] PRODSELLER_BASE_URL`，cron 2 个：`0 2 * * *` 清理（UTC 02:00 = 北京时间 10:00）+ `*/1 * * * *` 轮询）
- `schema.sql` — 建表 + 默认设置 + 4 个示例商品 + 演示卡密
- `src/worker.js` — Worker + API + 路由（含 `fulfillAfterPayment / pollUpstreamActivations / prodseller*`）
- `src/frontend.html` — 前端（独立 HTML，经 Text import 引入，无构建）
- `tests/mock-test.mjs` — mock 全链路测试（ProdSeller / EVM RPC 均为 mock；邮件已废弃，不再 mock Resend 发邮件）
- `tests/audit-data-fixes-test.mjs` — 数据与部署线审计修复回归测试（干跑、503 迁移失败、自愈、自定义分类编辑、v14 计数、7 天清理与 session 清理、cron 回退与分支隔离、v10→v21 升级、poll 默认关、Turnstile 配置标志）
- `tests/stock-test.mjs` — 库存口径专项测试
- `tests/security-test.mjs` — 安全专项测试（鉴权/订单状态机/查询密码/卡密预留/审计）
- `tests/concurrency-test.mjs` — 并发 / 故障恢复 / 迁移专项测试（真并行 + 屏障，验最终 DB 状态）
- `tests/txid-race-deterministic-test.mjs` — TXID 认领竞态确定性回归测试（v17：Barrier/Deferred 确定性交错，不依赖调度/时间窗口；覆盖同订单认领回滚竞态、租约接管、双管理员并发人工确认、人工/链上双向竞态、账本失败恢复）
- `tests/browser-acceptance.mjs` — 浏览器验收（需 playwright-core + 本机 Chromium + 本地 wrangler dev，见文件头注释）
- `tests/d1-local-test.sh` — Wrangler D1 本地环境迁移验证（仅 `--local`，不碰生产库）
- `migrations/` — 版本化迁移 SQL（0001–0021，只读镜像；唯一权威来源是 `src/worker.js` 的 `MIGRATIONS`）与说明
- `translations-zh.json / translations-zh.sql` — 上游商品中文标题/简介翻译（品牌名保留英文，链接/格式原样保留）
- `README.md` — 本文件
