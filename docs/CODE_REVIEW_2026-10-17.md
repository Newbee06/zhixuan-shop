# 完整代码审查报告（智选商城，2026-10-17）

- 范围：`src/worker.js`（2821 行）、`src/frontend.html`（1512 行）、`tests/`、`schema.sql`、`migrations/`、`wrangler.toml`、`.github/workflows/ci.yml`、`docs/`、`README.md`
- 分支：`feat/admin-overhaul-security`，HEAD `72e995c`；只审查，未改任何代码
- 方法：四路并行审查（Worker 安全 / Worker 正确性与并发 / 前端 / 测试·配置·文档），关键结论（P0、schema 版本）由主任务亲手复核确认
- 汇总：**P0 1 项，P1 19 项，P2 20 项，P3 43 项**。P0/P1 无直接可利用的 SQL 注入、认证绕过、XSS；P1 多为特定条件下的资金/生命周期风险。

## P0

### P0-1. `wrangler.toml`：生产 `[triggers]` 在本分支被删，合并后生产将失去 cron
- **证据（已复核）**：当前分支 `wrangler.toml` 全文无顶层 `[triggers]`，仅有 `[env.staging.triggers]`；`main` 的 `wrangler.toml` 有 `[triggers] crons = ["0 2 * * *", "*/1 * * * *"]`。
- **影响**：合并后若按此配置部署生产，生产 Worker 无 cron → 付款轮询不跑（客户付款后订单永不自动发货）、超时取消不跑（待付款订单永久占位）、7 天交付清理不跑。`ARCHITECTURE.md`、RUNBOOK、PRODUCTION_CHECKLIST 仍按 cron 存在来写，文档与配置矛盾。Staging 部署（`--env staging`）不受影响。
- **修复**：恢复顶层 `[triggers] crons = ["0 2 * * *", "*/1 * * * *"]`；CI 增加断言“wrangler.toml 顶层含 `[triggers]` 且含两条 cron”。

## P1

### P1-1. `prodseller_enabled` 门禁被上游激活轮询绕过 → 管理员关闸后仍发起真实采购
- 位置：`worker.js:913`（`pollUpstreamActivations` 重试创建）、`:1399-1401`（门禁关闭路径）、`:803`（`prodsellerCreateOrder` 无门禁检查）
- 证据：门禁只在 `fulfillAfterPayment` 检查，关闭时订单进 `pending_upstream` 且 `psId` 为空；但 `pollUpstreamActivations` 在 `:913` 无门禁检查直接调 `prodsellerCreateOrder`，该函数内部也无门禁检查。Cron 每分钟跑，管理员重试接口同样调它。
- 修复：在 `prodsellerCreateOrder` 入口统一检查 `prodseller_enabled === '1'`（单点门禁）。

### P1-2. 管理员确认收款不认领 TXID → 同一笔链上付款可重复用于第二笔订单
- 位置：`worker.js:1359`（`if (isChainHash && txVerified)`）、`:2208`（confirm-payment 传 `txVerified: false`）、`:2212`（传入订单已存的 `tx_hash || txid`）
- 利用链：买家经 `/pay` 提交真实 TXID 但当时确认数不足 → TXID 存入订单、核验失败 → 管理员在系统外看到到账后点确认收款（不认领）→ 攻击者另建订单（下单响应直接返回 `actual_amount`，可反复建单直到随机尾数与原订单一致，约 1/99 概率/单）→ 对新订单提交同一 TXID → 链上核验通过 → `claimTxid` 查不到占用 → 新订单被履行。**一笔付款，两次发货。**
- 修复：`fulfillAfterPayment` 中只要 `isChainHash` 为真即认领 TXID（伪造 TXID 认领无害——它永远通不过链上核验）。

### P1-3. 陈旧认领永久钉死 `pending_payment` 订单：无法超时取消、无法管理员取消，金额占用与卡密预留永不释放
- 位置：`worker.js:1236-1247`、`:1489`、`:2275`
- 证据：认领时无条件写入 `paid_at`；超时取消与管理员取消均要求 `status='pending_payment' AND paid_at IS NULL AND claim_token 为空`；`claim_token` 全库仅在 `completeOrder` 与手动发货被清空，无任何陈旧认领回收逻辑；`releaseStaleReservations` 只释放 `cancelled/completed` 订单的预留。
- 影响：认领后处理者崩溃（如管理员确认收款走 `fulfillAfterPayment` 且无链上付款可供轮询接管），订单停在 `pending_payment` + `paid_at` 已置 + `claim_token` 陈旧，之后超时取消恒为 0 行、管理员取消被挡回、金额占用永久、预留卡密永不释放。唯一恢复途径是手动改 D1。
- 修复：取消条件放宽为租约过期也可取消（`claimed_at < datetime('now','-5 minutes')`），或增加清理任务清除超租约的陈旧 `claim_token`；口径须与 5 分钟租约一致。

### P1-4. 上游终态（cancelled / failed / expired / refunded）无任何处理，订单永久卡死在轮询里
- 位置：`worker.js:926-934`、`:1376-1395`
- 证据：轮询 GET 分支只有 `delivered` 处理，非 `delivered` 一律 `still_pending`；全文件无一处匹配上游 `cancelled/failed/expired`。`fulfillAfterPayment` 同理。
- 影响：上游订单被取消/失败后，本系统订单永远停在 `pending_activation`/`pending_upstream`，每分钟轮询永不退出；客户已付款却永无交付、永不触发退款。
- 修复：对上游终态失败枚举（至少 `cancelled/failed/expired/refunded`，以 ProdSeller 实际枚举为准）转异常或置顶告警 + 停止轮询。

### P1-5. 异常/退款/手动发货均不取消上游订单：退款后上游仍可能交付，客户“退款 + 收货”双重得利
- 位置：`worker.js:2287-2311`（exception）、`:2313-2331`（refund-confirm）、`:2222-2257`（手动 fulfill）
- 证据：三处均仅改本地订单状态，全文件无上游取消/作废 API 调用。订单一旦进 `refund_pending`/`completed`，上游订单即脱离系统视野，但上游侧仍为已付款有效订单。
- 修复：增加上游取消/作废调用（若 ProdSeller 提供）；若无取消接口，exception 时至少把上游单号记入告警并由管理员到上游后台作废，退款确认前要求确认上游已作废；手动发货 `pending_activation`/`pending_upstream` 订单时先展示上游单号与状态，要求管理员确认。

### P1-6. 补偿回滚用 `slice(0, marked)` 假设“前 N 张成功”，失败时可能漏还卡
- 位置：`worker.js:1263-1280`（`markCardsUsed` 只返回数量不返回 id）、`:1303`、`:1320`
- 证据：补偿为 `unmarkCards(env, orderId, toMark.map(...).slice(0, marked))`；并发下若实际成功不是前缀子集（如成功 `{A,C}`，`marked=2`），补偿只还 `[A,B]`，C 漏还，永久处于 `is_used=1, order_id=本订单` 的“已用未交付”状态；若之后管理员手动填写交付内容完成该订单，C 既不被交付、也不被释放 → 一张卡永久烧掉。
- 修复：`markCardsUsed` 返回成功 id 列表，补偿只还这些确切 id；手动发货在 `delivery` 非空时也应检查并处理本订单名下 `is_used=1` 的残留卡。

### P1-7. `unmarkCards` 无“订单已完成”保护 + 手动发货无认领租约，并发重复发货下已交付的卡可被还回池子再卖一次
- 位置：`worker.js:1281-1286`（`unmarkCards`）、`:2222-2256`（手动发货，无 claim 租约）
- 证据：`unmarkCards` 不检查订单状态（对比 `releaseClaimedButUndeliveredCards` 有 `status === 'completed'` 保护）。触发链（窄竞态）：两个管理员并发手动发货同一 `pending_fulfill` 订单 + 一方补偿；另一方在此期间拿走该卡并完成订单；随后失败方的 `unmarkCards` 把已交付的卡还回；次日清理因订单已 `completed` 将其彻底释放 → **同一张卡被卖给两个客户**。触发条件苛刻，但后果是 P0 级。
- 修复：`unmarkCards` 增加订单状态保护（仅当订单非 `completed` 时才还卡）；手动发货引入认领租约。

### P1-8. `fulfillAfterPayment` 成功路径从不释放剩余预留，预留卡最长被冻结约 24 小时
- 位置：`worker.js:1444-1464`（成功分支无 `releaseReservation`）；对比手动发货 `:2252` 有
- 证据：`releaseReservation` 调用点仅 4 处（超时取消、手动发货、管理员取消、退款确认），自动发货成功路径没有。任一卡经步骤 1 复用或步骤 3 兜底补抢获得，就有等量预留卡未被消耗，直到次日 02:00 UTC 清理才释放，期间可售库存被低估，可能误判缺货。
- 修复：`fulfillAfterPayment` 卡密分支 `completeOrder` 成功后调用一次 `releaseReservation`（只动 `is_used=0` 的预留卡，不会误动已用卡）。

### P1-9. `/secret` 取卡密不校验 7 天过期：清理的唯一公开交付路径绕过了前台隐藏与 `data_expired`
- 位置：`worker.js:2018-2019`（`/secret`）、`:1571`（`sanitizeOrderForPublic` 有过期逻辑）、`:1626-1628`（`cleanupExpired`）
- 证据：`/secret` 直接返回原始行，无任何 `data_expired` / `isExpired7d` 判断。7 天清理完全依赖每日 02:00 UTC cron 成功执行；一旦 cron 未配置/失败，`delivery_content` 仍在库中，买家凭查询密码经 `/secret` 可无限期取回“已过期应清空”的卡密。
- 修复：`/secret` 返回前加与 `sanitizeOrderForPublic` 相同的判断，或复用 `sanitizeOrderForPublic(ordS,'full')` 再取 `delivery_content`。

### P1-10. 上游 `delivered` 完成时不校验 keys 数量与订单 `quantity`，少发也直接完成
- 位置：`worker.js:921`、`:931-932`、`:1381`、`:1425`
- 证据：完成条件均为 `st === 'delivered' && keys`（非空即通过），全程无 `keys 数量 >= quantity` 校验。卡密路径严格按 `quantity` 领取，上游路径无对等校验。
- 影响：上游 `quantity=3` 只返回 1 个 key 时，订单直接 `completed`，客户少收 2 件且订单已终态，无法再自动补发。
- 修复：完成前校验 `delivered keys` 行数 `>= quantity`；不足时不完成，转 `pending_activation` + 告警。

### P1-11. 重复采购窗口：上游请求已发出但响应丢失时，本地无任何上游单号记录，重试会再次下单
- 位置：`worker.js:812`、`:1416-1418`、`:910-923`、`:1807-1810`
- 证据：`prodsellerCreateOrder` 发 POST 后若 fetch 抛错或响应丢失，`upstream_orders` 无行；下一分钟轮询见 `!psId` 即再次创建。代码注释自认上游 `Idempotency-Key` 语义“尚未获得真实服务商证据”。同类变体：创建成功但响应中无单号字段时，`upsert` 写入空 `psId`，下次轮询同样再次创建。
- 影响：若 ProdSeller 不兑现 `Idempotency-Key` 去重（目前无证据），一次网络抖动即造成上游重复扣费/重复采购。**若后续证实上游忽略该 Key，本项升级为 P0。**
- 修复：上线前用真实上游沙箱验证 `Idempotency-Key` 重放语义并留存证据；“成功但无单号”响应不立即重试创建，先按 `order_no` 查询上游订单或转人工。

### P1-12. 手动发货可直接完成 `refund_pending` 订单并清空退款标记，抹掉待退款义务
- 位置：`worker.js:2244`
- 证据：完成 UPDATE 含 `refund_status=''` 且状态白名单含 `refund_pending`，注释称“退款待处理发货后退款不再需要”。`refund_pending` 无法区分“尚未退款”和“已在系统外退完、还没点确认”。
- 影响：管理员已在系统外退完款、尚未点 refund-confirm 时，若另一人点手动发货，订单变 `completed` 且退款标记被清空，客户同时获得退款 + 货物。
- 修复：禁止手动发货直接完成 `refund_pending`；如需兜底，要求单独的“撤销退款义务”动作（写明退款未执行 + 审计）。

### P1-13. 成功页刷新后收款地址丢失，买家无法付款
- 位置：`frontend.html:603`（`window._lastOrder`）+ `:606-624`（`renderSuccess`）
- 证据：`renderSuccess` 只读内存 `window._lastOrder`；刷新后为 `null`，地址框为空、二维码不渲染、应付显示 `¥0.00`。查询页待付款详情只显示“精确应付”，不显示收款地址；`GET /api/orders/:no` 返回 summary 会剥离 `pay_address`。成功页是收款地址的唯一展示位置。
- 修复：任选其一：① 后端在 `/api/orders/query` 列表中对 `pending_payment` 订单附带 `pay_address`（收款地址是商家公开地址，非买家隐私）；② 成功页刷新时用订单号调查询接口恢复支付信息。不要把地址存 `localStorage`。

### P1-14. `schema.sql` 迁移版本预置只到 v10，缺 v11–v15 全部产物，与自身注释和迁移文档矛盾
- 位置：`schema.sql:225`（`INSERT … VALUES (1)…(10)`）；全文无 `app_icons` / `query_password_hash` / `query_password_salt` / `secret_attempts`（已复核 grep 零命中）
- 影响：新库建库后实际是 v10，需靠 Worker 首次请求时跑 v11–v15 迁移才到 v15。若运行时迁移被跳过/失败，新库下单（INSERT 含 `query_password_hash`）直接 500、`/api/app-icons` 500。CI 浏览器任务正是用 schema.sql 建库，全靠首次请求迁移兜底。
- 修复：把 v11–v15 产物补进 schema.sql（`app_icons` 表、`query_password_hash`/`query_password_salt` 列、`secret_attempts` 表），预置版本改为 1–15，并与 `MIGRATIONS` 数组逐项对齐。

### P1-15. `schema.sql` 种子设置含已删除支付组合 + 已删除概念的面向用户文案
- 证据：种子 `usdt_addresses` 含 `Binance|TRC20` / `Binance|ERC20` / `OKX|TRC20` / `OKX|ERC20`；`rpc_urls` 含 `ERC20`；`usdt_contracts` 含 `ERC20` + `TRC20`；`chain_confirmations` 含 `ERC20:12` / `TRC20:19`；`binance_uid` 键仍存在；种子 `order_notice` 写“凭订单号 + 查单凭证查询订单与交付内容”。
- 影响：`order_notice` 是面向用户的（`frontend.html:532` 在商品详情页渲染）——新库用户会看到“查单凭证”这一 v15 已删除的概念。种子里的 TRC20/ERC20 键虽被白名单挡住不生效，但新库管理员会以为这些组合仍可配。
- 修复：种子只留 `OKX|X Layer` / `Binance|BEP20` 键与合约；`order_notice` 改为“凭订单号 + 查询密码查询”；删 `binance_uid` 种子键。

### P1-16. `migrations/` 镜像与 `migrations/README.md` 停留在 v8，未随 v9–v15 更新
- 证据：镜像文件只有 `0001–0008`，无 `0009–0015`；`migrations/README.md` 版本表只到 v8，且“生产上线前”第 4 步写“确认 `current_version = 8`”（应为 15）。而 README 自身要求“新增迁移时只改 MIGRATIONS 数组，同时更新本目录的镜像文件与 schema.sql”。
- 修复：补 `0009–0015` 镜像（标注只读），README 版本表补到 v15，第 4 步改为 15。

### P1-17. `docs/PRODUCTION_CHECKLIST.md` §C 部署步骤指向 staging 脚本；RUNBOOK 无生产部署路径
- 证据：PRODUCTION_CHECKLIST §C 写“部署命令：先 `rm -rf .wrangler`，再用 staging 部署脚本（见 RUNBOOK）”。这是一份**生产**上线清单，却让执行者跑 staging 部署脚本。
- 修复：清单 §C 改为“生产部署须用户明确授权后另行执行，不在此列；staging 部署见 RUNBOOK”，或在授权流程下写明生产部署命令与核对步骤。

### P1-18. 回滚文档夸大安全性，遗漏已知的 v8 唯一索引回滚风险
- 证据：`README.md:269` 与 `docs/RUNBOOK.md` 回滚节均称旧版代码“不读取它们，不影响旧版运行”。但 `migrations/README.md` 明确记录：“新库的 v8 唯一索引会约束旧版下单——旧版无 INSERT 重试逻辑，金额冲突时旧版下单会直接报 500”。且两处回滚清单遗漏 `secret_attempts` / `payments` / `scan_cursors` / `pay_rate` / `app_icons` 等新增表。
- 修复：回滚节补 v8 唯一索引 caveat（回滚前确认无高并发下单场景，或先评估 DROP 索引），并补全新增表清单。

### P1-19. CI 不校验生产 cron 触发器，P0-1 的回归正是从 CI 漏网
- 证据：`.github/workflows/ci.yml` static 任务只做 `wrangler.toml` 解析（`tomllib.load`），不检查 `[triggers]` 存在。
- 修复：static 任务加断言：顶层含 `[triggers]` 且 `crons` 含 `"0 2 * * *"` 与 `"*/1 * * * *"`。

## P2

### P2-1. `/lookup` 的 `full` 级别把 `admin_note`（内部备注）泄露给买家
- 位置：`worker.js:1958`（token 路径返回 `sanitizeOrderForPublic(ordL, 'full')`）；`:1536-1576`（`full` 分支只删 `refund_ref/exception_reason/upstream_lock`，未删 `admin_note`）
- 影响：持旧系统凭证的买家可看到管理员内部备注（如风控备注、人工核对记录）。
- 修复：`full` 分支同样 `delete out.admin_note`；管理端详情改走显式的 `admin` 级别而非默认 `full`。

### P2-2. 旧订单明文查询密码仍在库中且仍可经 `/lookup` 验证
- 位置：`worker.js:225`（基表 `query_password TEXT`）、`:1961`（`cred === ordL.query_password` 明文比较）
- 影响：v14 之前订单的买家密码以明文存库；库泄露即全部旧密码泄露（用户可能在别处复用）。
- 修复：迁移旧密码为 salt+PBKDF2 哈希（与 v15 同方案），或关闭 legacy 明文路径、强制走管理员流程。

### P2-3. 下单重复联系人检查向未认证调用方泄露他人订单号
- 位置：`worker.js:1794`（`err('该联系方式已有一笔待付款订单（' + po.order_no + '）…')`）
- 影响：任何人用他人邮箱下单，即可获知该邮箱对应的待付款订单号（存在性预言 + 订单号泄露），进而查询该订单概要。
- 修复：错误文案去掉订单号，改为通用提示“该联系方式已有一笔待付款订单”。

### P2-4. `GET /api/orders/:no` 无任何限流/验证码，且订单号熵低
- 位置：`worker.js:1935-1941`（单订单 GET 直接返回 summary，无限流、无验证码）；`:112-117`（`genOrderNo`：`AIS` + 时间戳 base36 + 仅 3 字节随机 hex，约 12 bit 熵）
- 影响：与有验证码+限流的 `/query` 不一致。知道大致下单时间的攻击者可高速枚举订单号（4096 个后缀/时间点），批量获取订单概要。
- 修复：该接口同样加 `checkLookupRateLimit`；新订单号随机部分增至至少 8 字节。

### P2-5. 图形验证码 SVG 可被脚本直接解析，基本无机器人防护
- 位置：`worker.js:132-149`（`genCaptchaSVG`：验证码以明文 `<text>` 元素输出，仅旋转/颜色干扰）
- 影响：任何脚本用正则提取 `<text>` 内容即可 100% 破解验证码，下单/查单的验证码层形同虚设（仅剩 IP 限流）。
- 修复：验证码字符渲染为路径/点阵、加粘连与背景干扰；或对公开写接口启用 Turnstile（已有 fail-closed 实现）。

### P2-6. `rpc_urls` 设置校验允许 `http://`，中间人可伪造链上日志
- 位置：`worker.js:2681`（校验仅要求 `indexOf('http') === 0`）
- 影响：管理员一旦配置明文 RPC，中间人可返回伪造的 Transfer 日志，伪造日志能通过全部链上检查（合约地址、topics、金额、确认数均由 RPC 响应提供），导致误认付款并发货。
- 修复：`rpc_urls` 校验要求 `https://` 前缀。

### P2-7. 登录全局限流可被用于锁定管理员（可用性）
- 位置：`worker.js:616-640`（全局 30 次失败 → 锁 5 分钟）、`:2067-2079`（登录流程）
- 影响：6 个以上 IP 各失败 5 次即可触发全站登录锁定；且窗口计数未在锁定时重置，实际锁定可延续至约 15 分钟。攻击者可反复锁定管理员，阻断后台管理。
- 修复：锁定后失败计数清零（锁满即解锁，不延长）；或全局锁仅针对高频 IP 段而非全站一刀切。

### P2-8. 查询列表读了后端不返回的 `has_delivery`，提示文案错误 + legacy 提示成死代码
- 位置：`frontend.html:676`、`:683`
- 证据：后端 `/api/orders/query` 明确不返回 `has_delivery`。前端 `else if (!o.has_delivery)` 恒为真——已完成且有交付内容的订单也会显示“暂无交付内容”；`else if (o.status !== 'pending_payment' && o.has_delivery)` 恒为假——legacy 订单的“联系客服”提示永远不出现，legacy 订单反而显示错误的“暂无交付内容”。密码输入/`/secret` 功能本身正常，仅文案误导。
- 修复：删除对 `has_delivery` 的依赖；按 `credential_type` 分支：`password`/`token` 显示输入框，`legacy` 显示“联系客服”提示，不再声称“暂无交付内容”。

### P2-9. 管理端订单详情的异常原因/退款凭证永远看不到（后端 sanitizer 误删）
- 位置：`frontend.html:931`（前端渲染）；根因 `worker.js:1536-1570`（`sanitizeOrderForPublic`）
- 证据：前端按 `o.exception_reason || o.refund_status` 渲染“异常 / 退款”区并展示 `o.refund_ref`。但后端 `sanitizeOrderForPublic` 在 `summary` 与 `else` 两个分支里都 `delete out.refund_ref; delete out.exception_reason;`，而管理端详情接口（`:2199`）调用时未传 level，走 `else` 分支——同样被删。后果：`refund_ref` 永远为空；仅记录异常原因未退款时，整个异常区直接隐藏。审计日志的 note 里还带有原因与凭证，可在“处理记录”里找回，不是数据丢失。
- 修复：后端为管理端详情单独加 `level='admin'` 分支，保留 `exception_reason`/`refund_ref`；或管理端详情接口不走 `sanitizeOrderForPublic`。

### P2-10. 轮询 `LIMIT 100 ORDER BY id ASC` + 死订单永不退出 = 队头阻塞，后续订单永久饿死
- 位置：`worker.js:892`（`pollUpstreamActivations`）、`:1480`（`runPolling`）
- 证据：两处均固定取最旧 100 笔。结合 P1-3/P1-4：钉死订单与终态失败的上游订单永不离开集合，每分钟都被重新取回、占用名额。
- 修复：轮询时跳过近期多次失败/已判定终态失败的订单（失败计数 + 退避时间戳），或按 `last_checked_at` 轮转取批；并修复 P1-3/P1-4 使死订单退出集合。

### P2-11. `scanEvmChain` 游标无条件推进：匹配到的付款若履约失败（`r.ok=false`），该区块永不再扫
- 位置：`worker.js:1139-1151`
- 证据：`:1139` 调 `fulfillOrderByPayment`，仅 `r.ok` 时才标记 `posted`；但 `scannedTo` 与 `setScanCursor` 不看履约结果，整页成功即推进。
- 影响：瞬时 DB 错误等导致履约 `ok:false` 时，该笔付款的区块已被游标越过；逐单兜底 `checkEvmPayment` 仅回溯 `latest - 200`。超过 200 区块后，该笔已到账付款永久无人处理。
- 修复：页内若有 `matched` 但履约 `!r.ok`（且非终态拒绝），`scannedTo` 不越过该事件所在区块；或把失败事件记入待重试队列由逐单路径重放。

### P2-12. `BinanceUID` 订单被 `runPolling` 完全排除：既不核验，也不超时自动取消，卡密预留永久占用
- 位置：`worker.js:1480`
- 证据：`SELECT … WHERE status='pending_payment' AND pay_method != 'BinanceUID' …`。`cleanupExpired` 不碰 `pending_payment`。
- 影响：BinanceUID 订单用户不付款、管理员不处理时，订单永久 `pending_payment`；若为卡密商品，下单时预留的卡永久被占。只能靠管理员逐单取消。
- 修复：`runPolling` 超时取消循环中单独包含 BinanceUID 订单（只取消、不链上核验），或给 BinanceUID 订单加独立的过期清理。

### P2-13. `upsertUpstreamOrder` 不受 `claim_token` 约束：过期租约的陈旧处理者可覆盖新处理者的上游单号/状态/keys
- 位置：`worker.js:833`（`upsertUpstreamOrder`）、`:1344`、`:901`（`upstream_lock`）
- 证据：UPSERT 按 `order_id` 无条件写；`fulfillAfterPayment` 全程不持有 `upstream_lock`（该锁仅 `pollUpstreamActivations` 使用）。
- 修复：`upsertUpstreamOrder` 增加 `claim_token`（或 `upstream_lock`）条件写入，`changes===0` 时放弃；或 `fulfillAfterPayment` 的上游分支也使用 `upstream_lock` 租约。

### P2-14. 后台告警只覆盖 `pending_upstream`，`pending_activation` 卡死的订单无告警面
- 位置：`worker.js:2629`
- 证据：告警查询仅 `status='pending_upstream'`。`pending_activation` 是上游 `paid` 后等 `delivered` 的状态，P1-4/P1-10 的卡死大多发生在这里，却不在告警列表中。
- 修复：告警覆盖 `pending_activation`（至少覆盖超期如 >30 分钟未 `delivered` 的），并区分“等待中”与“异常卡死”。

### P2-15. `pending_activation` / `pending_upstream` 无超期升级机制，可无限期挂起
- 位置：`worker.js:883-945`、`:1489`
- 证据：超时自动取消只处理 `pending_payment`；已付款的中间态没有任何最大等待时长、自动异常或升级逻辑。
- 修复：增加超期阈值（如 `pending_activation` 超 2 小时、`pending_upstream` 超 N 次重试），自动转异常/告警。

### P2-16. `/query` 的 IP 限流与 `/pay` 的 per-IP 限流无测试覆盖
- 证据：`worker.js:17` `LOOKUP_RATE_LIMIT = 30`，`:70` `PAY_RATE_PER_IP = 20`；`docs/SECURITY.md` 均有声明。但 `tests/` 中无任何测试提交 31 次查单或 21 次 `/pay`（仅 release-readiness 测了 per-order 5 次 → 第 6 次 429）。
- 修复：补测试：同 IP 30 次查单后第 31 次 429；同 IP 20 次 `/pay` 后第 21 次 429。

### P2-17. ac82de2 前端修复（未付款订单也显示密码输入框）无 Node 级回归测试
- 证据：`tests/app-icons-test.mjs:259` 只断言 `doQueryList()` 等函数名存在，未断言 `pending_payment` 订单分支下有密码输入框。仅浏览器测试覆盖。
- 修复：app-icons 增加静态断言：`doQueryList` 内密码输入分支不在 `pending_payment` 的 `else if` 链内。

### P2-18. 无回滚测试：旧版 Worker + v15 库的兼容路径从未被验证
- 证据：`tests/` 中无回滚场景；`d1-local-test.sh` 只测正向迁移、幂等、失败恢复。
- 修复：加测试：v15 库 + 模拟旧版下单路径（无 INSERT 重试）→ 同金额并发下单应可复现 500，或至少文档化该已知行为并由人工演练确认。

### P2-19. `docs/RELEASE_READINESS.md` 顶部判定为第四轮快照，与 v15 附录混排且无隔离标识
- 证据：文件标题即“第四轮”；§一–§八为第四轮内容，内含已 supersede 的描述（如确认数表“X Layer 1、ERC20 12、BEP20 15、TRC20 19”、Tronscan 分页、“统一入口为订单号 + 查单凭证”）；v15 内容只在文末附录。
- 修复：文件顶加横幅“§一–§八为第四轮历史快照，仅文末附录为最新状态”，或把当前判定/确认数表抽到文件顶。

### P2-20. `tests/d1-local-test.sh`：注释过期 + 承诺了未执行的 fresh-DB 下单测试
- 证据：注释写“版本=7”“迁移到 v8”等，而断言实际查 15；文末注释“新库下单 → 查单凭证流程（POST lookup）”后代码只取了 product id 就 kill 服务器，未真正下单/查单；且“查单凭证”术语已过期。
- 修复：更新注释为 v15；文末补真正的新库下单 + 查询密码查单断言；术语改为查询密码。

## P3

| # | 问题 | 位置 | 修复建议 |
|---|---|---|---|
| 1 | `sanitizeOrderForPublic` 未删除 `query_password_salt`，salt 随所有订单响应外泄（单独无用，但无必要暴露） | `worker.js:1536-1576` | `delete out.query_password_salt` |
| 2 | `sanitizeOrderForPublic` 默认级别为 `full`（fail-open）；管理端详情 `:2199` 不传 level 即拿到 full | `worker.js:1536`, `:2199` | 默认 `summary`，调用方显式传级别 |
| 3 | `/pay` 无条件 `UPDATE orders SET txid = ?`，可覆盖受害订单已提交的真实 TXID；同时为未核验 TXID 建 `submitted` 账本行（可刷垃圾行） | `worker.js:2062`, `:2044` | 仅当 `txid` 为空时写入；核验失败不建账本行或建后标记 invalid |
| 4 | `/pay` 无验证码，知订单号者可耗尽该订单的 `/pay` 配额（5 次/10 分钟）；轮询不受影响，属轻微 DoS | `worker.js:2021-2066` | `/pay` 增加验证码 |
| 5 | 限流 TOCTOU：`checkLookupRateLimit` / `checkPayRateLimit` / 下单限流均为先查后插，并发突发可超限（`/secret` 按单计数是原子单语句，无此问题） | `worker.js:1919`, `:602`, `:1804` | 改为原子 `INSERT…SELECT…WHERE count < N`（同 `/secret` 模式） |
| 6 | `reset-query-password` 未清遗留明文 `query_password` 列；审计结果未检查（其他操作均检查） | `worker.js:2346`, `:2347` | 同步 `query_password=''`；检查 `logAudit` 返回值 |
| 7 | `exception` 不退款路径用无条件 `UPDATE`（无状态守卫），并发完成时可覆盖已完成订单的 `admin_note` | `worker.js:2308` | 加 `AND status != 'completed'` 条件并检查 changes |
| 8 | 上游告警接口返回未脱敏的原始订单行（含遗留明文密码、哈希、salt、`claim_token`、交付内容、联系方式） | `worker.js:2627-2630` | 走 `sanitizeOrderForPublic(x, 'summary')` |
| 9 | 管理端搜索的 `LIKE` 未转义 `%`/`_`（订单/卡密/商品三处） | `worker.js:2178`, `:2502`, `:2403` | 转义通配符或改用 `instr()` |
| 10 | 卡密列表（返回完整 code）与卡密导入无审计记录 | `worker.js:2490`, `:2514` | 读/写卡密记审计（操作 + 商品 + 数量，不记 code） |
| 11 | `logout` 无 CSRF 校验，可被跨站请求登出管理员（仅骚扰级） | `worker.js:2096` | logout 走通用 CSRF 门 |
| 12 | 改密不校验新密码 ≠ 旧密码 | `worker.js:2110-2138` | 加 `newPw !== oldPw` 检查 |
| 13 | 哈希比较用 `!==`（非恒定时间）：管理员登录、`/lookup` token、`/secret` 三处；PBKDF2 主导耗时，风险可忽略 | `worker.js:2086`, `:1957`, `:2017` | 改用恒定时间比较 |
| 14 | `GET /api/captcha` 无限流，可无限制生成验证码行（DB 垃圾） | `worker.js:1757-1766` | 加 IP 限流（如 30 次/10 分钟） |
| 15 | X Layer 确认数仅 1（文档化的产品决策），大额订单有重组风险 | `worker.js:67` | 大额订单提高确认数，或按金额分级 |
| 16 | `pollUpstreamActivations` 的 `admin_note` 覆盖未校验租约持有，租约过期后可覆盖接管者的备注（仅 cosmetic） | `worker.js:916-922` | `UPDATE … WHERE id=? AND upstream_lock=?` |
| 17 | `GET /api/orders` 的 410 文案仍引用已删除的 v14 流程（“查单凭证，下单成功页展示一次”） | `worker.js:1933` | 更新为 v15 文案（订单号 + 查询密码） |
| 18 | `/query` 返回 `credential_type`，泄露订单类型；`/lookup` 错误文案区分新旧订单 | `worker.js:1985`, `:1954` | 统一文案/不返回类型（低优先级） |
| 19 | 订单创建的重复联系人检查全量拉取待付款订单（无 LIMIT），待付款积压时变慢 | `worker.js:1788-1796` | 改为按联系方式精确查询（`WHERE contact = ?`） |
| 20 | 审计失败返回 500 时副作用已提交，操作员易误以为操作未生效而重复操作 | `worker.js:2213-2216` 等 5 处 | 审计失败时记录日志 + 返回成功并附带 `audit_failed` 警告，或同批提交 |
| 21 | `/pay` 提交 TXID 成功路径后，无条件覆盖 `txid` 列，无状态守卫（与 #3 同根，因入口校验与 UPDATE 间有异步间隙） | `worker.js:2062` | 加 `AND status='pending_payment'` 条件 |
| 22 | 上游重试接口对非上游状态订单也返回 `ok:true`，造成“重试成功”假象 | `worker.js:2632-2644` | 非 `pending_activation/pending_upstream` 时返回 409 |
| 23 | 轮询完成订单时不清空 `claim_token`，与 `completeOrder`/手动发货的行为不一致（仅状态卫生） | `worker.js:921`, `:932` | 两处完成 UPDATE 加上 `claim_token=''` |
| 24 | 自动发货完成不清空 `exception_reason`（手动发货会清），终态订单残留过期异常标记 | `worker.js:1330-1339` | `completeOrder` 中同步清空 `exception_reason` |
| 25 | 轮询 GET 失败时不更新任何可见信息（无 `admin_note`、无失败计数），重复失败不可见 | `worker.js:927` | 记录失败原因与次数到 `admin_note`，404 单独处理 |
| 26 | `claimTxid` 在 `claimOrder` 成功之前写入，失败不回滚 | `worker.js:1360`, `:1364` | 调换顺序或在 `claimOrder` 失败时删除刚写入的 `txid_claims` 行 |
| 27 | `payments` 同一笔交易会产生两行（`/pay` 的 `event_key=''` 与扫描的 `event_key=logIndex`） | `worker.js:2040`, `:1130` | 扫描时先按 `(chain, tx_hash)` 查已有行并回填 `event_key`，或 `/pay` 不建行 |
| 28 | 迁移无分布式锁，并发首次迁移有 `ALTER` 竞态（瞬时 500，下次重试成功，无数据破坏） | `worker.js:528`, `:498`, `:208` | `ALTER` 失败时若列已存在则忽略 |
| 29 | `scanEvmChain` 未防范 RPC 的 `eth_getLogs` 结果截断 | `worker.js:1103-1145` | 分页时若返回条数触及常见上限则缩小页宽重扫 |
| 30 | `claimTxid` 非冲突型 DB 错误返回误导文案 | `worker.js:1229`, `:1235` | 区分：重读为空时返回“认领失败，请重试” |
| 31 | 卡密导入 SELECT-then-INSERT 存在竞态（DB 唯一约束兜底，无脏数据，仅导入失败报错） | `worker.js:2530-2533` | INSERT 包 `catch` 忽略唯一约束冲突（按“已存在”计入跳过数） |
| 32 | `statusLabel` 未知状态原样返回，未转义（服务端枚举，当前不可注入） | `frontend.html:426` | 兜底改为 `return escH(s)` |
| 33 | 成功页 `actual_amount` 裸插（服务端返回数字，当前无实际风险） | `frontend.html:614` | 改为 `Number(actual) || 0` |
| 34 | 复制按钮的 `delId` 未防单引号（`escH` 不转义 `'`；订单号为服务端生成的字母数字，属理论风险） | `frontend.html:651`, `:697-698` | 用 `data-` 属性 + 事件委托，或 `encodeURIComponent` |
| 35 | 过期注释误导：`// 按单取卡密…无密码直接返回`，后端 `/secret` 空密码已返回 401 | `frontend.html:691` | 注释改为“空密码由后端 401 拒绝” |
| 36 | 支付教程链接缺 `rel="noopener"`，无教程时 `href=""` | `frontend.html:622` | 加 `rel="noopener noreferrer"`；`tut` 为空时不渲染教程行 |
| 37 | 收款二维码走第三方 qrserver.com（商家收款地址以明文查询参数发给第三方；地址本就是公开收款信息） | `frontend.html:610` | 接受现状或改客户端 QR 生成库；至少在文档中注明该第三方调用 |
| 38 | 浏览器测试弱断言：错密码检查接受任意含“错误”的文本（500 页面“服务器内部错误”也含“错误”，会误通过） | `browser-acceptance-ci.mjs:184`、`browser-acceptance.mjs:133` | 只断言精确的 `查询密码错误` |
| 39 | 浏览器测试弱断言：密码输入框存在性检查带通用 OR 兜底 | `browser-acceptance-ci.mjs:177` | 只断言 `qpw-<订单号>` |
| 40 | `/secret` 门限顺序未测：正确密码在 5 次尝试后是否也被 429 | `app-icons-test.mjs:238` | 补一条：5 次尝试后用正确密码调 `/secret`，期望 429 |
| 41 | 游标“成功后推进”未断言（永不推进游标的 bug 会全绿，仅浪费 RPC） | `payment-whitelist-test.mjs` §10 | §10 后断言成功扫描后 `scan_cursors.last_block` 已推进 |
| 42 | `docs/PR_REVIEW.md` 为 2026-10-16 历史复审记录，但无 supersede 标识（“订单号 + 查单凭证”已被 v15 取代；“安全 98/98”已过期） | `PR_REVIEW.md:62`, `:89` | 文件顶加“历史记录，部分结论已被 v15 取代” |
| 43 | 其他小项：`README.md:123` schema 表清单过期（漏 `payments`/`scan_cursors`/`pay_rate`/`app_icons`/`secret_attempts`）；`migrations/0008` 镜像无版本记录行；`d1-local-test.sh` 去重断言用 `grep -o '1'` 应改为精确解析 COUNT；浏览器测试 35/22 处固定 `waitForTimeout` 睡眠有 flaky 风险；`compatibility_date = "2024-01-01"` 较旧但稳定，不必顺手改 | — | 按项清理 |

## 已核实无问题（四路逐项确认）

- **无 SQL 注入**：全部用户输入经 `.bind()`；动态 SQL 片段均为硬编码或 allowlist。
- **无认证绕过**：会话 128 bit 随机 token、7 天服务端过期、退出删会话、改密作废其他会话、未改密拦截、Cookie `HttpOnly; SameSite=Lax` + HTTPS 下 `Secure`、CSRF 覆盖全部管理端写接口。
- **无 XSS / 凭证泄露**：前端 43 处 `innerHTML` 全部经 `escH`；`localStorage` 仅存 `theme`；URL 无 `password=`/`token=`；成功页无 token；无硬编码密钥/地址。
- **无终态复活路径**：confirm-payment / fulfill / cancel / exception / refund-confirm 均有状态前置与条件 UPDATE。
- **无必现的超卖/重复发货**：认领 + 条件 UPDATE + 唯一键（`payments`、`txid_claims`、卡密条件更新）真实存在；三条收款路径复用同一 `fulfillAfterPayment`。
- **CI 跑全套测试**，无密钥暴露风险（`permissions: contents: read`，无 secrets 引用）。
- **Mock 忠实度**：ProdSeller mock 与连接器文档一致；EVM mock 不过滤地址/区块范围，但 Worker 自身严格校验，故未掩盖此类 bug。
- **退款流程覆盖**：security 测试覆盖异常 → `refund_pending` → `refund-confirm` 及重复确认拒绝；`/secret` 按单限流边界（5 次后第 6 次 429）与 legacy 分支均有测试覆盖。
- **文档无 dummy 地址冒充真实地址**：`0x111…` / `0x222…` 只出现在测试夹具与历史记录中且标注为测试地址。

## 建议修复顺序

1. P0-1（恢复生产 cron）—— 合并前必须修，否则生产上线即无轮询。
2. P1-1（门禁单点）+ P1-2（确认收款认领 TXID）—— 资金防线。
3. P1-3（陈旧认领回收）+ P1-4（上游终态）+ P1-5（上游取消）—— 生命周期不完整，三者一起修。
4. P1-13（成功页收款地址）+ P1-9（`/secret` 过期校验）+ P1-10（delivered 数量校验）+ P1-12（`refund_pending` 禁直接发货）+ P1-6/P1-7（卡密补偿）+ P1-8（释放剩余预留）+ P1-11（验证 `Idempotency-Key` 真实语义，上线前必须有证据）。
5. P1-14/P1-15/P1-16（schema 与迁移镜像）+ P1-17/P1-18/P1-19（文档与 CI）+ P2 + P3 批量清理。

## 修复前需定口径（两处）

- P1-3 修复涉及“正在处理中订单可否被取消/覆盖”的语义取舍（租约过期后的所有权）。
- P2-11 的“履约失败不推进游标”需确认失败类型的终态划分（终态拒绝不应阻塞游标）。

## 修复记录（2026-10-17 晚，审查全部发现修复）

- **P0-1 已修复**：`wrangler.toml` 恢复顶层 `[triggers]`；`ci.yml` 增加生产 cron 断言（顶层含 `[triggers]` 且含两条 cron）。另把新测试文件 `tests/review-fixes-test.mjs` 接入 CI regression 任务。
- **P1 全部 19 项已修复**：P1-1 门禁单点（`prodsellerCreateOrder` 入口统一检查）；P1-2 只要 `isChainHash` 即认领 TXID；P1-3 取消放宽为租约过期（`claimed_at` 超 5 分钟）也可取消；P1-4 上游终态失败转 `refund_pending` + 告警 + 停轮询；P1-5 确认旗标路径（`upstream_voided`，后端不调用上游取消接口）；P1-6 补偿只还确切 id；P1-7 `unmarkCards` 完成保护 + 手动发货 `upstream_lock` 租约；P1-8 自动发货成功后释放剩余预留；P1-9 `/secret` 校验 7 天过期（410）；P1-10 delivered keys 数量校验；P1-11 创建成功无单号时置 `no_psid_awaiting_manual` 不再重建；P1-12 手动发货拒 `refund_pending`；P1-13 `/query` 对 `pending_payment` 附带 `pay_address` + 前端恢复支付信息表单；P1-14 `schema.sql` 结构补 v11–v15（见下口径调整）；P1-15 种子收口（仅 X Layer/BEP20，`order_notice` 改查询密码）；P1-16 迁移镜像 0009–0015 + README 到 v15；P1-17 生产部署口径（须授权另行执行）；P1-18 回滚文档补 v8 唯一索引 caveat + 全表清单；P1-19 CI 生产 cron 断言。
- **P2 全部 20 项已修复**：P2-1 `full` 删 `admin_note` + 管理端详情 `admin` 级别；P2-2 legacy 验证成功时升级为 salt+PBKDF2 并清空明文；P2-3 重复联系人文案去订单号；P2-4 单订单 GET 加查单限流 + 订单号随机 8 字节；P2-5 不改 SVG（验证码加 IP 限流 + SECURITY.md 注明减速带口径）；P2-6 `rpc_urls` 要求 `https://`；P2-7 全局锁触发时计数清零；P2-8 删 `has_delivery` 依赖；P2-9 管理端详情异常/退款字段由 `admin` 级别返回；P2-10 轮询失败退避；P2-11 游标不越过非终态失败事件；P2-12 BinanceUID 只做超时取消；P2-13 `upsertUpstreamOrder` 租约条件写入；P2-14 告警覆盖超期 `pending_activation`；P2-15 超期升级只记告警（不改状态，见口径）；P2-16 IP 限流测试；P2-17 前端解耦静态断言；P2-18 回滚测试；P2-19 RELEASE_READINESS 横幅；P2-20 d1-local 注释 v15 + 真实新库下单断言 + 精确 COUNT 解析。
- **P3 全部 43 项已修复**：见各文件改动（sanitize 默认 summary、`/pay` 验证码、原子限流、logout CSRF、恒定时间比较、captcha 限流、X Layer 大额确认数分级 `large_order_usdt=100` / `large_order_confirmations=12`、审计失败返回成功 + `audit_failed`、游标回填、截断防护等）。
- **口径调整（与审查原文不同处，均经确认）**：
  - P1-14：`schema.sql` 结构补 v11–v15，但版本预置保持 10（不改到 15），否则 v11 图标种子被跳过、新库 `app_icons` 为空。另修复协调员改 `schema.sql` 时误删的 `CREATE TABLE schema_migrations`（已恢复并验证独立执行通过）。
  - P2-15：超期升级只记告警（`exception_reason` + `admin_note` + 审计，仅一次），不改状态、不自动转退款（自动转退款会停轮询，慢但有效的上游订单会被误判）。
  - P1-7：手动发货租约用 `upstream_lock` 而非 `claim_token`（`fulfillAfterPayment` 转中间态时会保留 `claim_token`，用它会挡住手动发货最长 5 分钟）。
  - P3-18：`credential_type` 保留返回（前端必需，低敏感），仅统一 `/lookup` 错误文案。
  - P2-5：SVG `<text>` 不改路径（会破坏浏览器验收解析），改做 captcha IP 限流 + 文档注明。
  - P1-11：ProdSeller 连接器无按业务单号查询接口，故“创建成功无单号”时置人工标记，不盲目重建。
- **仍 BLOCKED**：仅 P1-11 的真实上游沙箱验证（`Idempotency-Key` 重放语义无真实服务商证据）——绝不调用真实 ProdSeller 接口，未验证。
- **测试证据（协调员亲手重跑，全绿，退出码 0）**：app-icons 112/112、security 104/104、concurrency 115/115、release-readiness 90/90、mock ALL DONE、payment-whitelist ALL PASS、stock 17/17、review-fixes 226/226、d1-local ALL OK。浏览器测试未执行（子代理无法操作 live browser），由 CI 运行 `browser-acceptance-ci.mjs`。
