# 安全说明（智选商城）

## 威胁模型

- 攻击者可访问公开接口、构造请求、并发提交、枚举订单号、爆破查询密码、伪造跨站请求。
- 攻击者**不能**：绕过服务端校验、读取他人交付内容、重复认领同一笔链上付款、伪造上游/链上到账。
- 管理员是可信方，但会话可能被盗用：会话有过期、CSRF 校验、审计日志兜底。

## 查询密码与查单

- 下单必填查询密码（6–64 位）。存储 = 每订单随机 16 字节 salt（base64）+ PBKDF2(100,000 次，SHA-256，256 位) 哈希，绝不存明文。PBKDF2 迭代数取 Workers 生产上限 100,000（超过即 500）。
- 查单（`POST /api/orders/query`，需图形验证码 + IP 限流 30 次/10 分钟，结果上限 10 条）：**订单号/邮箱双查**。关键词含 `@` 按邮箱精确匹配（大小写不敏感，不部分匹配）；不含 `@` 按订单号精确匹配。匹配键：订单号 OR `LOWER(contact)` OR `LOWER(customer_fields.contact_email)`。**`activation_email` 不是查询键**（它是待开通账号，不是联系身份；下单时若未填 `contact_email` 会回填为 `activation_email`，故覆盖）。注：下单防重复逻辑内部还会比对 `activation_email`，那只是防重复下单，不作查询键。
- **邮箱 + 图形验证码 ≠ 所有权证明**：邮箱只是联系方式，任何人知道邮箱都能查到该邮箱的订单概要；图形验证码只是减速带（防自动化枚举），不是身份验证。卡密/交付内容仍必须按单走 `/secret` + 查询密码（或旧订单 `/lookup` 凭证）才能取。
- **隐私风险（已接受，须告知）**：知道邮箱即可枚举该邮箱的订单概要（订单号、商品、金额、状态、创建时间、待付款订单的 `pay_address` 例外见下）。缓解：验证码 + IP 限流（30 次/10 分钟）+ 结果上限 10 条 + 响应最小化（见下）。**邮件 OTP 未实现**：系统无任何邮件 OTP 发送/校验路径（`sendEmail` 为 `email_removed` 存根），不得声称“已发邮箱验证码”或“邮箱验证码可作所有权验证”。
- **响应最小化**：查单列表/概要永不返回 `delivery_content`、查询密码、密码哈希、盐、`claim_token`、`customer_fields`、完整 `tx_hash`/`txid`、管理备注（`admin_note` / `refund_ref` / `exception_reason` / `upstream_lock`）。**唯一例外**：待付款（`pending_payment`）订单在查单列表中附带 `pay_address`——它是商家公开收款地址（见 `docs/PAYMENT_FLOW.md`“查单列表 pay_address 例外”），非用户钱包/秘密；已付款/其他状态订单不附带。
- 旧接口 `GET /api/orders` 返回 410，文案为“旧接口停用，请用订单号或下单邮箱+验证码走当前查单流程”（不得再称“邮箱查单已关闭”）。已落地：`src/worker.js` 中的 410 文案已改为上述目标文案（2026-10-18 整改集成）。
- `/query` 返回 `credential_type` 是 deliberate 的低敏感 UI 提示：前端需它选择密码/token 输入（`password` / `token` / `legacy`），不含任何凭证本身；`/query` 错误文案已统一为通用文案，不区分订单类型细节。
- 取卡密（`POST /api/orders/:no/secret`）：IP 限流 + 按单原子记数（单条 `INSERT...SELECT...WHERE count < 5`，D1 串行化防并发绕过，`changes=0` 即 429）。空密码 → 401；密码错误 → 通用 401；认证通过后才按状态返回卡密或“尚未付款”。
- 历史订单：
  - 系统凭证订单（`query_token_hash`）：走老 `/lookup` 验证凭证哈希，返回完整详情。
  - 旧明文密码订单（`query_password`）：走老 `/lookup` 验证明文，只返回概要。
  - v14 遗留无 salt 哈希订单（`query_password_salt` 为空 + `query_password_hash` 非空）：`/secret` 返回 403，`/lookup` 返回 401，**仅管理员流程**（管理员可在后台查看交付内容 / 重置查询密码），绝不匿名返回卡密。
- 管理端重置查询密码（`reset-query-password`）：管理员提供新密码，服务端 salt+PBKDF2 存储，记审计，响应不回显密码。
- 列表/概要接口（`summary` 级别）永不返回 `delivery_content`、`customer_fields`、`contact`、`txid`、`tx_hash`、`admin_note`、钱包地址、`refund_ref`、`exception_reason`、`upstream_lock`。管理端订单列表同样为 `summary` 级别。

## 支付安全（摘要，详见 docs/PAYMENT_FLOW.md）

- 支付组合白名单：仅 `OKX|X Layer` 与 `Binance|BEP20`。下单、轮询、TXID 核验、扫描四处均校验白名单；非白名单订单不自动认账，只保留超时自动取消。
- 链上核验严格：合约地址校验、Transfer 事件、收款地址、按合约实际 `decimals()` 精确 BigInt 金额匹配、按链确认数（X Layer 1、BEP20 15）防重组。decimals 读取失败 fail-closed。
- TRC20 / ERC20 / 站内转账代码已删除，无任何外部调用路径。
- TXID 认领安全（v17）：租约-first（先原子获取订单租约，再碰认领表；无租约不触碰认领）；认领令牌化（每次新认领 `randomHex(32)` 的 `claim_token`，回滚须同时匹配令牌 + 当前订单租约；遗留空令牌行永不被令牌回滚删除）；同订单接管收养认领（重绑 `order_lease_token`，`source` 不改写）；失败路径不删认领行。
- 人工与链上共享同一 `txid_claims` 全局原子认领（`tx_hash` 主键决定胜负），`source` 区分 `'chain_verified'` / `'manual_confirmed'`；`manual_confirmed` 仅表示管理员系统外核对后人工确认，不构成链上证据，不伪造回执/区块高度/确认数。人工账本写入失败时 fail-closed：仅重读确认已有同订单 + 同 TXID + 同状态 `manual_confirmed` 行才可幂等继续，否则释放本请求租约、认领保留、返回失败。
- 收款二维码走第三方 qrserver.com（前端调 `api.qrserver.com` 生成，收款地址以查询参数传给第三方）；收款地址本就是公开收款信息，接受现状。

## 管理端鉴权

- 会话：32 字节随机 token，7 天过期，httpOnly + SameSite=Lax + HTTPS 下 Secure。退出时删除服务端会话。改密后作废除当前会话外的所有会话。
- 入口：全部 `/api/admin/*` 需有效会话（401）；未改密会话只能调 `me` / `change-password` / `logout`（403 拦截，不只靠前端隐藏）。
- CSRF：全部管理端写操作（POST/PUT/DELETE）需同源证明（Origin 或 Sec-Fetch-Site），缺失或不符 → 403。改密接口单独校验。
- 登录限流：同一 IP 15 分钟失败 5 次封禁 15 分钟 + 全站失败计数。密码校验 PBKDF2，失败不区分“用户不存在/密码错误”。
- 审计：全部关键操作记 `admin_audit`（操作、订单、旧状态、新状态、原因），不记密码、凭证、完整卡密、API Key。**审计写入失败时不得把已提交业务改回 500**：业务已提交则返回 `ok:true` + `audit_failed:true` + `warning`（“操作已执行，但审计记录写入失败，请立即检查 admin_audit 表并手动补记……”），操作员**不得重复操作**，须立即核查 `admin_audit` 表并手动补记（见 `docs/RUNBOOK.md`）。

## 通用防护

- 全部响应带 `cache-control: no-store`（含错误响应）。
- 错误脱敏：公开接口只返回稳定通用错误 + 关联 ID，绝不返回 SQL、数据库结构、内部路径、堆栈、凭据；详情只记 Worker 日志。
- 参数化查询（无字符串拼接 SQL）；输入长度/格式校验；金额用 BigInt 精确比较，禁止 float 比较。
- 图形验证码：4 位、5 分钟过期、最多试 3 次，失败计数；下单、查单列表均需验证码。SVG 验证码只是减速带（字符以明文 `<text>` 输出，可被脚本解析），真正防线是 IP 限流；Turnstile 保持条件加载现状（仅 `turnstile_enabled=1` 时启用）。
- 下单限流：同 IP 限流（`order_rate`）。
- `/pay` 限流：同一订单 10 分钟 5 次，同一 IP 10 分钟 20 次。限流不影响后台轮询继续核验已到账付款。
- 管理端卡密列表（`GET /api/admin/cards`）返回完整卡密 code：这是管理员权限操作（需登录，无导出接口，分页），保留现状。卡密不在任何公开接口返回。

## 已知限制（未声称修复）

- 单管理员，无角色权限、无多账号。
- `/pay` 需图形验证码（一次性、5 分钟过期、最多试 3 次，成功路径原子认领防重放）+ 独立限流（同一订单 10 分钟 5 次，同一 IP 10 分钟 20 次）。知道订单号的攻击者仍可消耗该订单的 `/pay` 配额；公开 `/pay` 不用 Cookie，故 CSRF 不适用。
- 邮件通知已移除；无售后工单、分销、优惠券。退款为人工流程，系统不执行真实资金退款。
- 真实链上到账验收需真实转账证据；当前状态见 docs/RELEASE_READINESS.md（BLOCKED / NOT VERIFIED 除非有证据）。
