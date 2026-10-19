# 安全审计报告 — zhixuan-shop

| 项 | 值 |
|---|---|
| 执行时间 | 2026-10-19 23:47–23:56 Asia/Shanghai (CST, UTC+8) |
| 审计角色 | 独立安全审计 + QA（不负责主功能开发） |
| 审计基线分支 | `fix/txid-race-safety-2026-10-18` |
| 审计基线 SHA | `7e9f70b851f6daef632216160f932c2e9f694fb2` |
| 对比基线 | `origin/main` @ `7a71ca46db7795a974aa506c8e5fa43ae70bd4b6`（PR #1 已合后 tip） |
| 方法 | 源码审读 + 本地实跑测试套件（node:sqlite mock / wrangler --local）；**未**接触生产 D1、**未**主网收款、**未**真实客户数据 |
| 总评 | tip 分支支付/履约路径设计与本地回归整体 **PASS**；**不得**把 `main` 当作支付安全基线；生产/主网/真实 ProdSeller **NOT VERIFIED** |

## 1. 范围与约束

### 已检查

- 管理员登录、PBKDF2 密码哈希、会话、初始改密、登录限速（IP + 全局）
- CSRF、XSS 输出转义、参数化 SQL、敏感字段脱敏
- 订单查询凭证、`/secret` 交付、管理端审计与卡密掩码
- 支付伪造/重复入账/重复采购/重复发货（TXID 认领、租约、账本状态机）
- 卡密预留/竞争、库存超卖、并发状态覆盖
- ProdSeller 密钥暴露面、wrangler secrets 约定、日志与 staging/生产隔离配置

### 硬约束遵守情况

- 禁止生产部署 / 改生产 D1 / 真实主网收款 / 真实客户数据：**遵守**
- 禁止把 API Key、私钥、助记词、管理员密码、真实卡密写入文件或聊天：**遵守**（测试仅用虚构口令/卡密）
- 标记口径：PASS / FAIL / BLOCKED / NOT VERIFIED（见下文与 `docs/QA_REPORT.md`）

## 2. 分支与合并态势（再核验）

| 对象 | 状态 | 说明 |
|---|---|---|
| `main` | 默认分支，**未开 branch protection** | `gh api .../protection` → 404 Branch not protected |
| PR #1 `feat/admin-overhaul-security` | MERGED | 已在 main |
| PR #3 `fix/review-findings-2026-10-18` → main | OPEN | 相对 main 约 **5** commits（审查整改 P1/P2/P3） |
| PR #4 `fix/txid-race-safety-2026-10-18` → **#3 分支** | OPEN, MERGEABLE, CI 全绿 | tip = 本审计基线；相对 main 约 **32** commits；含 v17/v18 TXID 竞态根治 |
| `feat/favicon-z1` / `fix/mobile-hero-collection-title` | 存在 | 非资金路径优先 |

**结论：** 资金相关审计必须以 tip `7e9f70b`（或合并后的等价 tip）为准。裸 `main` **缺少** tip 上的 `ZHIXUAN_SETUP_TOKEN` 建站门禁、`PAYMENT_TRANSITIONS`、`code_masked`/`reveal`、`manual_confirmed` 全局认领、`order_lease_token`、`pending_tx_hash` 等关键加固（对照计数 tip ≫ main）。

## 3. 发现列表

严重度：Critical / High / Medium / Low / Info。每条含位置、触发、复现、影响、建议。

### H-01 — `main` 无保护且落后 tip 的支付安全修复（High）

| 字段 | 内容 |
|---|---|
| 严重度 | **High**（若生产仍部署 main 或可被强推覆盖 tip 修复，则升级为 **Critical** 运营风险） |
| 位置 | GitHub 仓库设置：`main` 无 protection；代码差距：`origin/main` vs `7e9f70b`（约 32 commits） |
| 触发条件 | 任何人有写权限即可 force-push / 直推 main；或生产 Worker 仍指向未含 PR #3/#4 的构建 |
| 复现 | `gh api repos/Newbee06/zhixuan-shop/branches/main/protection` → 未保护；`git log origin/main..7e9f70b` 可见 TXID/租约相关提交 |
| 影响 | 支付竞态/重复认领类问题可能在旧代码路径复现；关键修复可被意外覆盖 |
| 建议 | 1) 启用 `main` branch protection + 必需 CI；2) 先合 #3 再合 #4（或等价整合）；3) 生产部署仅允许经审计 tip；4) 禁止未批准生产部署 |

### H-02 — 生产环境与真实密钥/主网验收缺口（High · 验收缺口）

| 字段 | 内容 |
|---|---|
| 严重度 | **High**（验收口径，非 tip 代码新洞） |
| 位置 | 部署面：Cloudflare 生产 Worker / 生产 D1 / `PRODSELLER_API_KEY` / 链上收款地址 |
| 触发条件 | 仅本地 mock + wrangler `--local` 通过即上线 |
| 复现 | 本轮未持有生产或真实 ProdSeller 凭证（故意） |
| 影响 | mock ≠ 真实上游；测试网/本地 ≠ 主网确认数与 RPC 行为；CI 绿 ≠ 生产安全 |
| 建议 | 所有者批准后在 **staging** 做真实 ProdSeller 只读/小额沙箱与主网只读核验清单；禁止用客户数据做普通测试 |

### M-01 — 缺少浏览器安全响应头（Medium）

| 字段 | 内容 |
|---|---|
| 严重度 | **Medium** |
| 位置 | `src/worker.js` 静态 HTML / JSON 响应（`json()` / 首页 HTML 返回处）；全文件无 `Content-Security-Policy` / `X-Frame-Options` / `X-Content-Type-Options` |
| 触发条件 | 任意访客加载站点 |
| 复现 | 审读 `json()`（约 L91–95）与 HTML 响应路径；`rg Content-Security src/worker.js` 无匹配 |
| 影响 | 降低 XSS 纵深防御；可被 iframe 嵌入（点击劫持风险，管理端同域 Cookie SameSite=Lax 部分缓解） |
| 建议 | 为 HTML 加保守 CSP（先 Report-Only）、`X-Frame-Options: DENY` 或 `frame-ancestors 'none'`、`X-Content-Type-Options: nosniff` |

### M-02 — D1 无跨语句事务的残余竞态面（Medium · 已缓解）

| 字段 | 内容 |
|---|---|
| 严重度 | **Medium**（残余；tip 已大量 fail-closed） |
| 位置 | `fulfillAfterPayment` / `claimTxid` / `claimOrderForPayment`（约 L1652–2235）；注释明确「不得假设多条 D1 写构成事务」 |
| 触发条件 | 极高并发下部分写入成功、后续失败 |
| 复现 | 本地 `txid-race-deterministic-test` / `concurrency-test` 覆盖主要场景并通过；真实生产负载 **NOT VERIFIED** |
| 影响 | 理论上出现「认领已占用但履约未完成」等中间态；设计为认领永久保留 + 同单重试收养，避免 TXID 被他单抢走 |
| 建议 | 保持 tip 顺序（租约 → 认领 → 账本 → 副作用）；运维 runbook 保留「认领存在但订单未完成」人工恢复步骤；勿重新引入 `releaseTxidClaim` 自动删除 |

### M-03 — devDependency Playwright SSL 校验漏洞（Medium）

| 字段 | 内容 |
|---|---|
| 严重度 | **Medium**（供应链 / CI 工具链；不直接暴露生产 Worker） |
| 位置 | `package-lock.json` → `playwright@1.55.0`（GHSA-7mvr-c777-76hp，npm audit high） |
| 触发条件 | CI/本地执行 `npx playwright install` 下载浏览器 |
| 复现 | `npm audit` 报告 high；engine 要求与锁定版本冲突时勿盲 `audit fix --force` |
| 影响 | 恶意中间人可能污染浏览器二进制（开发/CI 环境） |
| 建议 | CTO 评估后锁定升级到 ≥1.55.1（或当前安全补丁线），并回归浏览器 Job |

### M-04 — 管理端无第二因素 / 单管理员角色（Medium · 产品约束）

| 字段 | 内容 |
|---|---|
| 严重度 | **Medium** |
| 位置 | `/api/admin/login`（约 L3136+）；会话模型为单一 `sessions` token |
| 触发条件 | 管理员密码或会话被盗 |
| 复现 | 代码无 TOTP/WebAuthn；改密会废除其他会话（已有） |
| 影响 | 会话窃取后可人工确认收款、发货、看卡密 |
| 建议 | 后续加 2FA 或至少 IP allowlist / 短会话 + 敏感操作二次确认；保持 CSRF + httpOnly |

### L-01 — 遗留明文 `query_password` 列仍存在（Low）

| 字段 | 内容 |
|---|---|
| 严重度 | **Low** |
| 位置 | `orders.query_password`；`/lookup` 明文兼容路径（约 L2957–2964）在验证成功后迁移为 salt+PBKDF2 并清空明文 |
| 触发条件 | 极旧订单尚未被查单迁移 |
| 复现 | schema 仍含列；新订单写空字符串 |
| 影响 | DB 备份泄露时旧行可能含明文查询密码 |
| 建议 | 维护窗口批量迁移清空；确认无明文后考虑弃用列 |

### L-02 — `showModal`/`openDrawer` 的 `bodyHTML` 信任调用方（Low）

| 字段 | 内容 |
|---|---|
| 严重度 | **Low** |
| 位置 | `src/frontend.html` ~L407 / L433：`opts.bodyHTML` / `bodyHTML` 直接拼进 `innerHTML` |
| 触发条件 | 未来调用方把未 `escH` 的用户/上游字符串传入 |
| 复现 | 当前主要调用点对动态字段使用 `escH`（抽查激活邮箱确认等） |
| 影响 | 管理端 XSS 可能 |
| 建议 | 约定「只传已转义 HTML」或改为结构化 DOM API；加 lint/review 清单 |

### L-03 — 本地迁移脚本默认端口 8791 与沙箱 egress 冲突（Low · 环境）

| 字段 | 内容 |
|---|---|
| 严重度 | **Low** |
| 位置 | `tests/d1-local-test.sh` `PORT=8791`；本机 `sand-egress-tun` 占用 8791 |
| 触发条件 | 在占用 8791 的环境直接跑脚本 |
| 复现 | 未改端口时 wrangler 报 Address already in use，curl 空响应 → FAIL；改 `PORT=18791` 后 **PASS** |
| 影响 | 本地/部分沙箱误判迁移失败 |
| 建议 | 脚本改为可配置端口或自动选空闲端口；CI（ubuntu runner）不受影响 |

### I-01 — 公开仓库中的 D1 `database_id`（Info）

| 字段 | 内容 |
|---|---|
| 严重度 | **Info** |
| 位置 | `wrangler.toml` 生产/staging `database_id` |
| 影响 | ID 非密钥，但暴露资源标识；真正密钥须走 `wrangler secret` |
| 建议 | 维持 secret 不进库；确认 CF 账号 IAM 最小化 |

### I-02 — `X-Admin-API: 1` 可代替 Origin（Info · 设计如此）

| 字段 | 内容 |
|---|---|
| 严重度 | **Info** |
| 位置 | `checkCsrf` ~L892–906 |
| 影响 | 非浏览器客户端显式声明；同源 XSS 已能持 Cookie，额外风险有限 |
| 建议 | 文档写清；勿在无会话场景依赖该头 |

## 4. 检查清单结论（按审计项）

| 检查项 | 结论 | 摘要 |
|---|---|---|
| 管理员登录 / PBKDF2 / 会话 / 初始改密 / 限速 | **PASS**（本地） | `ZHIXUAN_SETUP_TOKEN` fail-closed；PBKDF2 100k；httpOnly+SameSite=Lax；IP+全局限速；改密废除其他会话 |
| 权限绕过 | **PASS**（本地） | 未登录 401；未改密仅 me/change-password/logout；管理写操作 CSRF |
| CSRF | **PASS**（本地） | Origin / Sec-Fetch-Site / X-Admin-API |
| XSS | **PASS**（主要路径）+ **L-02** | 前后端 `esc`/`escH`；交付内容经转义；缺 CSP → M-01 |
| SQL 注入 | **PASS**（审读） | 业务查询均 `prepare().bind()`；DDL 表名来自硬编码迁移 |
| 敏感信息泄露 | **PASS**（本地） | `sanitizeOrderForPublic`；卡密 `code_masked` + `/reveal`；settings 不回传 API Key |
| 订单查询凭证 / 交付泄露 | **PASS**（本地） | `/query` 无 delivery；`/secret` 需密码+限流；7 天过期清空 |
| 后台审计 | **PASS**（本地） | `admin_audit`；审计失败有 warning 路径；审计不含卡密正文 |
| 支付伪造 / 重复入账 / 重复采购 / 重复发货 | **PASS**（本地 mock） | 租约-first + `txid_claims` PK + 账本终态；人工/链上共享认领；上游 Idempotency-Key |
| 卡密竞争 / 超卖 / 并发覆盖 | **PASS**（本地） | 预留+条件 UPDATE；取消释放；并发套件通过 |
| ProdSeller 密钥 / Secrets / 日志 / 环境隔离 | **PASS**（配置审读）+ **H-02** | Key 仅 env；`prodseller_base_url` 域名白名单；staging 独立 D1；真实上游 **NOT VERIFIED** |

## 5. 剩余风险与未验证项

| ID | 标记 | 说明 |
|---|---|---|
| R1 | **NOT VERIFIED** | 真实 ProdSeller API（采购成功/激活/缺货/余额不足/超时）——仅 mock HTTP |
| R2 | **NOT VERIFIED** | 主网 X Layer / BEP20 真实确认与 RPC 稳定性 |
| R3 | **NOT VERIFIED** | 生产 Worker/D1 当前部署是否已是 tip；生产 secrets 是否齐全 |
| R4 | **NOT VERIFIED** | 生产负载下 D1 延迟与租约窗口是否足够 |
| R5 | **BLOCKED** | 破坏性生产测试 / 生产部署（规则禁止，未执行） |

## 6. 建议 CTO 的一句话基准

**以 `fix/txid-race-safety-2026-10-18` @ `7e9f70b`（含 PR #3 基底的 PR #4 tip）为唯一支付/履约安全基准；先合 #3 再合 #4，保护 `main`，勿把裸 `main` 当生产安全基线。**

## 7. 相关文档

- 测试矩阵与命令级结果：`docs/QA_REPORT.md`
- 既有威胁模型：`docs/SECURITY.md`（与 tip 一致处本报告不再重复全文）
