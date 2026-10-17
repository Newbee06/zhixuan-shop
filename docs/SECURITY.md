# 安全说明（智选商城）

## 威胁模型

- 攻击者可访问公开接口、构造请求、并发提交、枚举订单号、爆破查询密码、伪造跨站请求。
- 攻击者**不能**：绕过服务端校验、读取他人交付内容、重复认领同一笔链上付款、伪造上游/链上到账。
- 管理员是可信方，但会话可能被盗用：会话有过期、CSRF 校验、审计日志兜底。

## 查询密码与查单

- 下单必填查询密码（6–64 位）。存储 = 每订单随机 16 字节 salt（base64）+ PBKDF2(100,000 次，SHA-256，256 位) 哈希，绝不存明文。PBKDF2 迭代数取 Workers 生产上限 100,000（超过即 500）。
- 查单仅按订单号（`POST /api/orders/query`，需图形验证码 + IP 限流 30 次/10 分钟）。**邮箱不是查询凭证**：关键词含邮箱只返回与“订单不存在”相同的通用空结果，不泄露其为邮箱。
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
- 收款二维码走第三方 qrserver.com（前端调 `api.qrserver.com` 生成，收款地址以查询参数传给第三方）；收款地址本就是公开收款信息，接受现状。

## 管理端鉴权

- 会话：32 字节随机 token，7 天过期，httpOnly + SameSite=Lax + HTTPS 下 Secure。退出时删除服务端会话。改密后作废除当前会话外的所有会话。
- 入口：全部 `/api/admin/*` 需有效会话（401）；未改密会话只能调 `me` / `change-password` / `logout`（403 拦截，不只靠前端隐藏）。
- CSRF：全部管理端写操作（POST/PUT/DELETE）需同源证明（Origin 或 Sec-Fetch-Site），缺失或不符 → 403。改密接口单独校验。
- 登录限流：同一 IP 15 分钟失败 5 次封禁 15 分钟 + 全站失败计数。密码校验 PBKDF2，失败不区分“用户不存在/密码错误”。
- 审计：全部关键操作记 `admin_audit`（操作、订单、旧状态、新状态、原因），不记密码、凭证、完整卡密、API Key。审计写入失败时操作返回 500（不伪装成功）。

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
- `/pay` 无验证码：同一订单的 `/pay` 限流（5 次/10 分钟）可缓解滥用，但知道订单号的攻击者仍可消耗该订单的 `/pay` 配额。公开 `/pay` 不用 Cookie，故 CSRF 不适用。
- 邮件通知已移除；无售后工单、分销、优惠券。退款为人工流程，系统不执行真实资金退款。
- 真实链上到账验收需真实转账证据；当前状态见 docs/RELEASE_READINESS.md（BLOCKED / NOT VERIFIED 除非有证据）。
