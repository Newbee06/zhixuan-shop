# IMPLEMENTATION_AUDIT｜仓库实现审计

> 审计日：2026-10-19（Asia/Shanghai）  
> 方法：GitHub API + 本地 clone 全部分支 diff / CI `gh run list` / 精读 tip 核心文件。  
> **本机未对 tip 重新跑完整 test suite**（标记 NOT VERIFIED）；CI 结果来自 GitHub Actions。

## 1. 分支与 PR

| 分支 | tip SHA | 相对 main | PR | 结论 |
|---|---|---|---|---|
| `main` | `7a71ca46` | — | — | 默认分支；含已合并 PR #1 后台安全大改 |
| `fix/review-findings-2026-10-18` | `166c45ed` | +5 commits | [#3](https://github.com/Newbee06/zhixuan-shop/pull/3) → main | OPEN，MERGEABLE；审查 P1/P2/P3 整改 |
| `fix/txid-race-safety-2026-10-18` | `7e9f70b8` | +32 vs main（含 #3） | [#4](https://github.com/Newbee06/zhixuan-shop/pull/4) → #3 分支 | OPEN，MERGEABLE；TXID 竞态 v17 + 迁移 0016–0018 + 大量前端/CI |
| `fix/mobile-hero-collection-title` | `b90f692` | UI 提交 | [#2](https://github.com/Newbee06/zhixuan-shop/pull/2) → main | OPEN；多数改动已移植进 #4 tip |
| `feat/favicon-z1` | `e83520cf` | 基于移动端线 | 无 PR | 低优先；favicon |
| `feat/admin-overhaul-security` | `6719e729` | **落后** main（main 领先 1） | #1 closed | 可忽略，勿再基于此开发 |

Ancestry：**main ⊂ PR3 ⊂ PR4**（PASS）。

## 2. main 相对 tip 的关键缺口

`main...fix/txid-race-safety` 约 **+6239 / -714**，33 files，重点：

- `src/worker.js` 大改：TXID claim 令牌化、租约-first、共享全局防重、pay-config 等
- `migrations/0016–0018`
- `tests/txid-race-deterministic-test.mjs` 等
- `src/frontend.html` 移动端与审查整改
- CI / docs 同步

**裸 `main` 不得作为支付安全基线**（与 Bot3/5/6 一致）— **PASS（判断）**。

## 3. CI（GitHub Actions）

| 对象 | 最近结论 | 标记 |
|---|---|---|
| tip `fix/txid-race-safety` push `7e9f70b` | success（Static / Business / D1 / Browser×2） | **PASS**（远程 CI） |
| 中间一次 pay-config 提交 | failure 后已有后续 success | 历史 FAIL 已覆盖 |
| PR #3 | success | **PASS** |
| PR #2 | success | **PASS** |
| 本审计环境本地全量 `npm test` | 未跑 | **NOT VERIFIED** |

## 4. 核心文件抽检（tip）

| 项 | 结果 | 标记 |
|---|---|---|
| `wrangler.toml` 单 Worker+D1+双 cron；staging 隔离 | 与描述一致 | PASS |
| 支付白名单仅 X Layer USDT0 + BEP20 USDT | `PAYMENT_FLOW.md` + worker 文案一致 | PASS（文档/代码一致）；合约主网再核验 → NOT VERIFIED |
| 订单状态常量含 refund_pending | `ORDER_STATUSES` 7 态 | PASS |
| 履约单入口 `fulfillAfterPayment` | 存在 | PASS |
| TXID / 订单 claim 租约 | tip 含 v17 | PASS（代码存在）；主网并发 → NOT VERIFIED |
| ProdSeller 门禁默认关 | settings `prodseller_enabled=0` | PASS |
| 密钥未进仓库 | secret 注释 + 无明文 Key | PASS（抽检） |
| README 仍写「admin-overhaul 未合 main」 | 与 PR #1 已合事实冲突 | FAIL（文档陈旧） |
| 真实链上验收 | 文档自标 BLOCKED | BLOCKED / NOT VERIFIED |
| 生产 D1 体积 / CPU / 套餐 | 需 Dashboard | BLOCKED（Bot6） |

## 5. 建议基准分支

**开发与审计工作树：`fix/txid-race-safety-2026-10-18` tip（`7e9f70b`）。**  
**合入 main 顺序：先 merge PR #3，再 merge PR #4（改 base 为 main 或 ff）；PR #2 / favicon 后置，合并前再 diff 防重复。**

理由：支付竞态与审查整改均在 tip；CI 全绿；main 缺 0016–0018 与 v17 防重。

## 6. Top 风险（最多 5）

1. **main 落后 tip 的资金路径** — 若误在 main 上开发/部署，TXID 竞态未修。  
2. **Free CPU 10ms** — PBKDF2 + RPC + D1 同请求超时（Bot6）。  
3. **主网支付未验收** — BLOCKED。  
4. **PR #4 含大量 UI + 支付同分支** — 回滚粒度粗；合并评审需拆关注点。  
5. **文档漂移** — README 与分支状态/邮件路径不一致。

## 7. 未验证 / 阻塞清单

- 本地全量回归：**NOT VERIFIED**
- 合约地址与确认数主网再核验：**NOT VERIFIED**（Bot3）
- Cloudflare Dashboard 用量：**BLOCKED**（需所有者）
- 生产部署与真实收款：**BLOCKED**（政策）
