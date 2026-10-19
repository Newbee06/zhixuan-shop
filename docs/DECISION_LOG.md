# DECISION_LOG｜架构与协作决策

## 模板

```
### D-XXX — 标题
- 日期：
- 决策人：CTO / 所有者
- 背景：
- 选项：
- 决定：
- 影响文件/Bot：
- 状态：Proposed | Accepted | Superseded
```

---

### D-001 — 开发基准分支
- 日期：2026-10-19
- 决策人：CTO 总指挥
- 背景：main 未含审查整改与 TXID 竞态修复；团队一致认为裸 main 不能作支付基线。
- 选项：A) main B) PR3 tip C) PR4 tip（含 PR3）
- 决定：**C）工作基准 = `fix/txid-race-safety-2026-10-18` @ `7e9f70b`**；合入顺序 **PR #3 → PR #4**；PR #2 / favicon 后置。
- 影响：全体 Bot 只读/开发基于 tip；禁止基于落后的 `feat/admin-overhaul-security`。
- 状态：Accepted（待所有者确认是否立即 merge 到 main）

### D-002 — 生产发布权限
- 日期：2026-10-19
- 决定：CTO 仅组织评审；**部署生产 Worker / 改生产 D1 / 真实收款 / 付费资源**必须所有者明确批准。
- 状态：Accepted

### D-003 — 核心文件串行修改
- 日期：2026-10-19
- 决定：`src/worker.js` / schema / migrations 同时仅一个主责 Bot 的 PR 落地；冲突先记本日志再改代码。
- 状态：Accepted

### D-004 — 支付组合冻结
- 日期：2026-10-19（沿用项目既有）
- 决定：仅 OKX×X Layer×USDT0 与 Binance×BEP20×USDT；扩展新链须新决策 + 主网核验。
- 状态：Accepted
