# 运维手册（智选商城）

## 环境

| 环境 | Worker | D1 | 域名 |
|---|---|---|---|
| 生产 | `aisou-lite` | `aisou-lite-db`（ID `c492fc6c-23d3-4c16-8c49-5a1a3cdf680c`） | <https://aisou-lite.f-00a.workers.dev> |
| Staging | `zhixuan-shop-staging` | `zhixuan-shop-staging-db`（ID `4fb3878b-02bf-4cac-b833-716c050242e6`） | <https://zhixuan-shop-staging.f-00a.workers.dev> |

**红线**：不要部署生产、不要合并 PR、不要访问或修改生产 D1、不要发起真实链上转账——除非用户明确授权。浏览器自动化只能访问 staging 域名与本地地址。

**域名**：`zhixuanpro.com` 尚未绑定生产（见下文“域名上线”清单），上线前生产域名仍为 `https://aisou-lite.f-00a.workers.dev`。

## 部署 staging

```bash
cd ~/workspace/aisou-lite
rm -rf .wrangler
PYTHONPATH=/opt/muse/skills/custom-connector-setup/bin python3 ~/workspace/custom-connectors/custom.legacy-cloudflare/bin/cf_wrangler.py deploy --env staging
```

- **绝不能用** `custom.cloudflare-wrangler/bin/deploy.py`（生产脚本）。
- 部署不跑 `schema.sql`，迁移靠请求触发（Worker 首次请求自动迁移）。
- 部署后验证：`/api/config` 200、首页 200、schema-check `up_to_date: true`。

## 生产部署（不在本文档授权范围内）

生产部署须用户明确授权后另行执行，不在本文档授权范围内；本文档只覆盖 staging 部署、常用操作与回滚说明。

## 常用操作

| 操作 | 方法 |
|---|---|
| 查看 staging 日志 | CF 面板 → Workers → `zhixuan-shop-staging` → Logs |
| 备份 D1 | `wrangler d1 export <db> --local/--remote` 或 CF 面板快照（部署生产前必做） |
| 触发迁移 | `POST /api/admin/migrate`（需登录） |
| 检查迁移/表结构 | `GET /api/admin/schema-check`（需登录） |
| 手动触发轮询 | 触发 cron（CF 面板）或等 1 分钟 |
| 管理员改密 | 后台 → 改密（旧密码 + 新密码 ≥8 位） |

## 常见问题

| 现象 | 排查 |
|---|---|
| 下单 500（关联 ID） | 查 Worker 日志，用关联 ID 定位；常见：迁移未完成、设置缺收款地址 |
| 订单超时未自动取消 | 检查 `poll_enabled` 是否为 1；检查 cron 是否正常触发 |
| 轮询未发现到账 | 检查收款地址是否正确；检查 `rpc_urls` / `usdt_contracts`；检查确认数（BEP20 需 15）；用链上浏览器核对 Transfer 日志 |
| 上游商品一直 `pending_upstream` | 检查 `prodseller_enabled`、上游余额、上游库存；后台上游管理看告警 |
| 买家忘查询密码 | 后台订单详情 → 重置查询密码（管理员设新密码，记审计，告知买家） |
| 旧订单（v14 无 salt 哈希）买家无法自助取卡 | 仅管理员流程：后台查看交付内容 / 重置查询密码 / 联系客服 |
| 管理员被锁（登录失败过多） | 等 15 分钟自动解封；或 D1 中清 `login_attempts`（需用户授权，生产 D1 禁动） |
| 审计写入失败（响应 `ok:true` + `audit_failed:true`） | **不得重复操作**：业务已提交，重复操作会重复发货/重复确认。立即核查 `admin_audit` 表，确认缺失的审计行后手动补记（操作、订单、旧状态、新状态、原因），再继续后续操作 |
| 查单接口返回 410 | `GET /api/orders` 为旧接口，文案“旧接口停用，请用订单号或下单邮箱+验证码走当前查单流程”（已落地）。不要让用户以为邮箱查单已关闭 |

## 回滚

重新部署 main 分支的旧版 Worker 即可。旧库新增的列和表（新增表：`upstream_orders` / `upstream_cache` / `captcha_codes` / `order_rate` / `admin_audit` / `login_attempts` / `txid_claims` / `lookup_rate` / `payments` / `scan_cursors` / `pay_rate` / `app_icons` / `secret_attempts`；新增列：`query_token_hash` / `query_password_hash` / `query_password_salt` / `reserved_*` / `claim_token` / `claimed_at` / `exception_reason` / `refund_*` / `upstream_lock` / `upstream_lock_expires_at` / `app_icon_key` / `schema_migrations`）可保留，旧版代码不读取它们，不影响旧版运行。回滚前备份 D1。

**v8 唯一索引 caveat**：回滚后新库的 v8 唯一索引（`idx_orders_amount_claim` / `idx_orders_contact_pending`）仍会约束旧版下单——旧版无 INSERT 重试逻辑，高并发下金额/联系人冲突时旧版下单会直接报 500。回滚前确认无高并发下单场景，或先评估 DROP 索引（须先人工评估重复数据，见 `migrations/README.md`）。

## 域名上线（zhixuanpro.com，仅清单与只读验证，不执行切换）

本节只写清单与只读验证命令。任何注册/改 DNS/绑生产域名/改 Route/Custom Domain 操作都须用户单独明确审批（与代码部署审批分开），不在本轮授权内。

清单（逐项勾选，见 `docs/PRODUCTION_CHECKLIST.md` E 节）：所有权与 DNS 托管、CF Zone、Route/Custom Domain 只指向生产 Worker `aisou-lite`、TLS/重定向/canonical、DNS 与路由冲突、Staging workers.dev 不被生产域名替换、独立审批与回滚、未验证项。

切换前必须先记录旧值快照（切换前 DNS 记录 + Route 列表），回滚 = 恢复旧值并验证。

只读验证（不改任何配置）：

```bash
# DNS 解析（期望：指向生产 Worker 的 CF 边缘地址/CNAME，无旧测试记录）
dig +short zhixuanpro.com
dig +short www.zhixuanpro.com
# TLS / 重定向 / canonical（期望：HTTPS 200、无到错误域名的重定向、HSTS 按决策）
curl -sI https://zhixuanpro.com
curl -sI http://zhixuanpro.com
# 生产域名上的 API（期望：200，与 workers.dev 生产域名行为一致）
curl -s https://zhixuanpro.com/api/config | head -c 300; echo
# Staging 未被替换（期望：200，仍可独立访问）
curl -s -o /dev/null -w "%{http_code}\n" https://zhixuan-shop-staging.f-00a.workers.dev/api/config
```

## 数据保留

- 交付内容：`fulfilled_at` 超过 7 天的已完成订单自动清空卡密/账号交付数据并标记 `data_expired`。
- 审计日志：`admin_audit` 保留，不自动清理。
- 验证码：5 分钟过期；查单限流记录 10 分钟窗口。
