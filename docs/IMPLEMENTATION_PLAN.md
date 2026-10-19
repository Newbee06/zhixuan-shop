# IMPLEMENTATION_PLAN｜分阶段计划与文件所有权

## 阶段 0 — 冻结与基准（当前）

- [x] 分支盘点  
- [ ] 所有者确认：允许按「#3 → #4」合入 main（**不授权生产部署**）  
- [ ] Bot5 在 tip 实跑回归并出报告  
- [ ] Bot3 合约/确认数/幂等路径核验表  

## 阶段 1 — 合入安全基线（需所有者批准 merge）

1. Merge PR #3 → main  
2. 将 PR #4 retarget → main（或继续叠合）并 merge  
3. 文档：修正 README 关于 admin-overhaul / 基准分支的过时陈述  
4. **不**部署生产；staging 由所有者决定是否更新  

## 阶段 2 — 第一批开发任务（合入后或基于 tip 分支并行只读后开工）

| ID | 负责人 | 范围 | 允许修改的文件 | 禁止 | 依赖 | 验收 |
|---|---|---|---|---|---|---|
| T2-1 | Bot2 | tip 上订单状态机/库存/ProdSeller 路径审计报告 + 缺口列表 | 仅 `docs/` 或自有 `docs/bot2-*.md`；代码改动另开 PR 经 CTO | 不改支付匹配核心 | 基准 tip | 报告含 PASS/FAIL/NOT VERIFIED |
| T3-1 | Bot3 | 支付白名单、确认数、金额匹配、TXID 幂等核验 | 优先 `docs/`；代码仅限支付区且经 CTO 排期 | 不改商品/前端整页 | tip | 核验表 + 单测引用 |
| T4-1 | Bot4 | 前台/后台 UI 只读盘点与小改进提案 | `src/frontend.html` 仅在 CTO 排期窗口；先文档 | 不绕过服务端校验 | tip | 提案 + 截图规格 |
| T5-1 | Bot5 | tip 回归：security / payment-whitelist / concurrency / txid-race / browser | `tests/` 可补强断言；不改业务逻辑除非修测试债 | 生产禁测 | tip CI | QA_REPORT + 实跑日志摘要 |
| T6-1 | Bot6 | 免费额度与 cron/CPU 风险清单；staging 对照 | `docs/`；`wrangler.toml` 改动须 CTO+费用说明 | 不创建付费资源 | Dashboard 授权 | 容量备忘录 |

## 文件所有权矩阵（核心）

| 文件 | 主责 | 次责（需协调） |
|---|---|---|
| `src/worker.js` 支付/扫描/TXID | Bot3 | Bot2（履约衔接） |
| `src/worker.js` 订单/商品/上游/发卡 | Bot2 | Bot3（claim 接口） |
| `src/frontend.html` | Bot4 | Bot2（API 字段变更） |
| `schema.sql` / `migrations/*` | CTO 审批 + 提出方 Bot | Bot5 测迁移 |
| `wrangler.toml` | Bot6 | CTO |
| `tests/*` | Bot5 | 功能 Bot 补场景 |
| `docs/MASTER_SPEC.md` 等规范 | CTO | 全员只读遵守 |

**同时修改 `src/worker.js`：必须分 PR、分时段，CTO 在 DECISION_LOG 登记。**

## 阶段 3 — 功能增强（示例，未批准）

- 自营/上游体验打磨、对账工具、监控告警  
- 任何付费 API / 套餐升级 → 单独费用评估 + 所有者书面批准  

## 完成定义（DoD）

每个 PR：范围说明、测试结果（真实命令/CI 链接）、剩余风险、NOT VERIFIED 项、无密钥。
