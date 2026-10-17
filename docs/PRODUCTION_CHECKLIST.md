# 上线检查清单（智选商城）

上线前逐项确认，全部通过方可部署生产。任何一项未通过即为上线阻塞项。

## A. 代码与测试（发布候选）

- [ ] 分支与 PR：PR #1 已审，未合并前不得部署生产。
- [ ] 全套测试全绿（命令与退出码见 docs/RELEASE_READINESS.md）：
  - `node tests/app-icons-test.mjs`
  - `node tests/security-test.mjs`
  - `node tests/concurrency-test.mjs`
  - `node tests/release-readiness-test.mjs`
  - `node tests/mock-test.mjs`
  - `node tests/payment-whitelist-test.mjs`
  - `node tests/stock-test.mjs`
  - `bash tests/d1-local-test.sh`（仅 `--local`，绝不 `--remote`）
- [ ] 浏览器验收（staging）：下单 → 查询密码取卡密 → 错密码拒绝 → 管理端操作全流程。
- [ ] 无未提交变更；HEAD 与远端同步。

## B. 真正可收款运营（与 A 分开，不得混同）

- [ ] 收款地址已填**真实**地址（`usdt_addresses`：`OKX|X Layer`、`Binance|BEP20`），非测试 dummy 地址。
- [ ] 真实小额转账验收：向真实收款地址转一笔真实小额 USDT（X Layer 与 BEP20 各一笔），核验轮询自动发货 + TXID 核验 + 订单履约记录。无此证据则为 BLOCKED / NOT VERIFIED。
- [ ] ProdSeller：已配真实 API Key（Env Secret），`prodseller_enabled` 按需开启；上游余额充足；上游商品已同步且售价已确认。
- [ ] 站名、公告、须知、客服链接已填真实内容；测试 dummy 数据已清除。
- [ ] 管理员密码已改为强密码（首次登录强制改密已完成）；旧默认密码 `admin` 已失效。
- [ ] 生产 D1 已备份（`wrangler d1 export` 或 CF 面板快照）。

## C. 部署

- [ ] 部署命令：先 `rm -rf .wrangler`，再用 staging 部署脚本（见 RUNBOOK）。**绝不用生产部署脚本误部署 staging；绝不直接部署分支到生产。**
- [ ] 部署后验证：`/api/config` 200、首页 200、schema-check `up_to_date: true`、后台登录正常。
- [ ] 回滚方案已确认：重新部署 main 分支旧版 Worker 即可（见 RUNBOOK）。

## D. 上线后监控（首 24 小时）

- [ ] 观察 cron 轮询日志（无异常 500、无 RPC 失败刷屏）。
- [ ] 观察待付款订单：超时自动取消是否正常；无卡密预留泄漏。
- [ ] 观察后台告警：上游 402/409/429、异常订单。
- [ ] 首笔真实订单全流程人工跟进（下单 → 到账 → 发货 → 买家取卡密）。
