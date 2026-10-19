# QA 报告 — zhixuan-shop

| 项 | 值 |
|---|---|
| 执行时间 | 2026-10-19 23:47–23:56 Asia/Shanghai (CST, UTC+8) |
| 角色 | 独立安全审计 + QA |
| 审计基线 | `fix/txid-race-safety-2026-10-18` @ `7e9f70b851f6daef632216160f932c2e9f694fb2` |
| 对比 | `origin/main` @ `7a71ca46db7795a974aa506c8e5fa43ae70bd4b6` |
| 运行环境 | box 本地；Node **v22.20.0**（`node:sqlite` + wrangler 4.151 需要 ≥22）；npm 依赖 `npm ci` |
| 数据 | 虚构订单/卡密/口令；**无**真实客户数据；**无**生产 D1；**无**主网收款 |

## 标记口径

- **PASS**：本机实际运行且通过  
- **FAIL**：实际复现失败或漏洞  
- **BLOCKED**：缺权限/环境/前置条件  
- **NOT VERIFIED**：证据不足  

**说明：** mock ≠ 真实 ProdSeller；本地 wrangler ≠ 主网；CI 绿 ≠ 生产安全。

## 1. 盘点摘要

| 类别 | 内容 |
|---|---|
| 源码 | `src/worker.js`（4125 行）、`src/frontend.html` |
| 迁移 | `migrations/0001`–`0015` + 代码内 MIGRATIONS 至 **v18**；`schema.sql` 终态 |
| 配置 | `wrangler.toml`（生产 `aisou-lite` + staging `zhixuan-shop-staging`；secrets 注释约定，无明文 Key） |
| CI | `.github/workflows/ci.yml`：Static / Business regression / D1 local / Browser acceptance / Browser review-frontend |
| PR | #1 MERGED；#3 OPEN→main；#4 OPEN→#3 分支，CI 全 SUCCESS，MERGEABLE |
| tip 相对 main | 约 **32** commits（含审查整改 + TXID 竞态 + 移动端/收款配置等） |

## 2. 测试矩阵（本机实跑）

### 2.1 静态

| 命令 | 环境 | 结论 | 摘要 |
|---|---|---|---|
| `npm run test:static` | Node 22 | **PASS** | `node --check src/worker.js` OK；frontend 2 个 script 块 syntax OK |

### 2.2 `test:regression` 各脚本

| 脚本 | 命令 | 结论 | 计数/摘要 |
|---|---|---|---|
| mock-test | `node tests/mock-test.mjs` | **PASS** | 上游 402/409/超时、验证码、联系人防重、下单限流、图片校验等 |
| stock-test | `node tests/stock-test.mjs` | **PASS** | pass=17 fail=0；卡密库存/预留/取消释放 |
| security-test | `node tests/security-test.mjs` | **PASS** | pass=104 fail=0；登录限流、退款门禁、审计、prodseller_base_url 白名单等 |
| concurrency-test | `node tests/concurrency-test.mjs` | **PASS** | pass=118 fail=0；TXID 认领保留、确认数门槛、审计失败主效应等 |
| release-readiness-test | `node tests/release-readiness-test.mjs` | **PASS** | pass=91 fail=0 |
| payment-whitelist-test | `node tests/payment-whitelist-test.mjs` | **PASS** | ALL PASS；双链、游标恢复、历史 TRC20 拒付等 |
| app-icons-test | `node tests/app-icons-test.mjs` | **PASS** | pass=111 fail=0；含查单/secret 流 |
| review-fixes-test | `node tests/review-fixes-test.mjs` | **PASS** | 281 passed, 0 failed |
| review-p1-backend-test | `node tests/review-p1-backend-test.mjs` | **PASS** | 139 passed, 0 failed |
| txid-race-deterministic-test | `node tests/txid-race-deterministic-test.mjs` | **PASS** | 234 passed, 0 failed（P1-1/P1-2 等） |
| review-config-test | `node tests/review-config-test.mjs` | **PASS** | pass=53 fail=0；仓库密钥自扫描 |
| pay-config-test | `node tests/pay-config-test.mjs` | **PASS** | all assertions passed；test-connection 不触发采购、不回显 Key |

> Node 20 无法加载 `node:sqlite`，回归套件需 Node ≥22。本机已用 Node 22.20.0。

### 2.3 迁移

| 命令 | 环境 | 结论 | 摘要 |
|---|---|---|---|
| `bash tests/d1-local-test.sh`（端口改为 **18791**） | wrangler 4.151 `--local` | **PASS** | 旧库→v18、去重、幂等、失败不标版本、空库/新库、v16/v17/v18 断言；`D1 LOCAL TEST ALL OK` |
| 同脚本默认 `PORT=8791` | 本沙箱 | **BLOCKED→环境冲突** | `sand-egress-tun` 占用 8791，wrangler 起不来 → 空响应；**非产品逻辑缺陷**；CI runner 不受影响 |

### 2.4 浏览器（Playwright Chromium）

| 命令 | 环境 | 结论 | 摘要 |
|---|---|---|---|
| `BASE=http://127.0.0.1:18791 ZHIXUAN_SETUP_TOKEN=test-setup-token node tests/browser-acceptance-ci.mjs` | wrangler `--local` :18791 | **PASS** | pass=123 fail=0；视口/深色/管理端/控制台无 unexpected error |
| 同上 + 全新库 `node tests/review-frontend-test.mjs` | wrangler `--local` :18791 | **PASS** | pass=64 fail=0；Turnstile 缺配置 fail-closed UI、卡密掩码、会话过期等 |

### 2.5 远程 CI（只读核验，非本机重跑）

| 对象 | 结论 | 摘要 |
|---|---|---|
| PR #4 tip `7e9f70b` status checks | **PASS**（远端） | Static / Business regression / D1 migration / Browser acceptance / Browser review-frontend 均为 SUCCESS |

## 3. 按风险补充项

| 场景 | 本轮结果 | 标记 |
|---|---|---|
| 自营卡密并发购买与取消释放 | concurrency / stock / txid-race 覆盖并通过 | **PASS**（本地） |
| 上游采购成功 / 等待激活 / 缺货 / 余额不足 / 超时 | mock-test + review-p1 模拟 HTTP | **PASS**（mock）/ 真实 API **NOT VERIFIED** |
| 未付款禁止履约 | security / concurrency / secret 路径 | **PASS**（本地） |
| 付款事件重复提交与确认失败恢复 | txid-race + concurrency + payment-whitelist | **PASS**（本地） |
| 管理员越权 / 订单越权 / 卡密查询安全 | security + review-p1 + app-icons + browser | **PASS**（本地） |
| 库迁移 | d1-local-test（改端口后） | **PASS** |
| 关键页浏览器验收 | browser-acceptance-ci + review-frontend | **PASS** |
| 真实 ProdSeller | 无密钥、未调用生产上游 | **NOT VERIFIED** / **BLOCKED**（缺密钥且禁止生产） |
| 主网支付核验 | 未连主网 RPC 做真实付款 | **NOT VERIFIED** |
| 生产部署一致性 | 未读生产 Worker 版本 | **NOT VERIFIED** |

## 4. BLOCKED / NOT VERIFIED 清单

| ID | 标记 | 原因 |
|---|---|---|
| B1 | **BLOCKED** | 破坏性生产测试 / 改生产 D1 / 生产部署（规则禁止） |
| B2 | **BLOCKED** | 默认端口 8791 在本沙箱被占用（已用 18791 绕过完成迁移与浏览器测） |
| N1 | **NOT VERIFIED** | 真实 ProdSeller 端到端 |
| N2 | **NOT VERIFIED** | 主网 X Layer / BEP20 真实入账与确认 |
| N3 | **NOT VERIFIED** | 生产当前发布版本是否等于 tip |
| N4 | **NOT VERIFIED** | 生产监控告警与密钥轮换实操 |

## 5. 与安全审计交叉

详见 `docs/SECURITY_AUDIT.md`。摘要：

- Critical（tip 代码新洞）：**未发现**（在本地证据范围内）  
- High：`main` 无保护且落后 tip（H-01）；生产/真实上游验收缺口（H-02）  
- Medium：缺安全响应头；D1 非事务残余；Playwright 依赖 advisory；无 2FA  
- 建议基准：**tip `7e9f70b` / PR #4（含 #3）**，勿用裸 main

## 6. 产物路径

| 文件 | 仓库内 | 副本 |
|---|---|---|
| 本报告 | `/workspace/zhixuan-shop-qa-audit/docs/QA_REPORT.md` | `/workspace/deliverables/QA_REPORT.md` |
| 安全审计 | `/workspace/zhixuan-shop-qa-audit/docs/SECURITY_AUDIT.md` | `/workspace/deliverables/SECURITY_AUDIT.md` |

工作树：`/workspace/zhixuan-shop-qa-audit`（独立 worktree，避免干扰其他代理在 `/workspace/zhixuan-shop` 的改动）。

## 7. 提交 / PR 状态

见执行结束后父代理回报：若 `git push` 成功则附 PR 链接；若认证失败则文档保留于上述路径并标 **BLOCKED（push）**。
