# AI_TEAM_STATUS｜六人团队状态板

更新：2026-10-19 23:50 Asia/Shanghai | 基准 tip：`7e9f70b`（txid-race-safety）

| Bot | 角色 | 当前任务 | 状态 | 阻塞 |
|---|---|---|---|---|
| 1 | CTO 总指挥 | 仓库审计 + 六份规范文档 + 基准决策 | 审计文档已产出 | 所有者确认 merge #3/#4；生产权限无 |
| 2 | 后端 + ProdSeller | 等待基准后审计状态机/库存/上游 | 只读待命 | 等 D-001 宣贯 |
| 3 | 链上支付 | tip 支付路径核验 | 只读已初报；待正式核验表 | 主网验收 BLOCKED |
| 4 | Apple 前端 | UI 只读；等任务窗 | 待命 | 等排期 |
| 5 | 安全审计 + QA | tip 回归与支付/发货复核 | 待命实跑 | 未实跑 → NOT VERIFIED |
| 6 | Cloudflare 平台 | 额度/CPU/监控 | 只读结论已出 | Dashboard **BLOCKED** |

## 统一命令

- 开发前：`git fetch && git checkout fix/txid-race-safety-2026-10-18 && git pull`
- 汇报格式：任务范围 / 变更文件 / 测试结果（CI 或本地命令） / PR 链接 / 风险 / NOT VERIFIED
- 标记：PASS | FAIL | BLOCKED | NOT VERIFIED

## 第一批批准条件

1. 本目录规范文档合入（本 PR）  
2. 所有者确认 D-001 merge 策略  
3. Bot5 tip 回归报告到手后，CTO 再批准 Bot2/3/4 的**代码**窗口  
