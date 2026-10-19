# 前端 UI 审计（T4-1）

- **角色**：Bot 4｜Apple 风格前端工程师  
- **基准 tip**：`fix/txid-race-safety-2026-10-18` @ `7e9f70b`（D-001）  
- **审计日期**：2026-10-19（Asia/Shanghai）  
- **范围**：只读核对 `src/frontend.html` 及浏览器相关测试脚本；**未**改 `src/`、**未**部署、**未**开写窗  
- **对照**：产品目标（Apple 风格商城 + 管理后台）、安全边界（服务端权威）、Bot2 激活字段说明

## 文件盘点

| 路径 | 职责 | 备注 |
|---|---|---|
| `src/frontend.html` | 商城前台 + 管理后台（单文件 vanilla HTML/CSS/JS） | tip 约 181KB；明显新于裸 `main` |
| `tests/browser-acceptance*.mjs` | 浏览器验收 | tip 上 Bot5 报告 mock/本地全绿（见 PR #7） |
| `tests/extract-frontend-check.mjs` | 前端静态抽取检查 | 同上 |

无独立 CSS/组件目录；**不得**未经 CTO 批准迁移 React / Next / 新构建链。

## 状态矩阵

| 项 | 标记 | 说明 |
|---|---|---|
| 架构约束（Workers 内嵌 vanilla，不迁框架） | **PASS** | 单文件 hash 路由 `#/`、`#/product/:id`、`#/success/:id`、`#/query`、`#/admin` |
| 设计系统（CSS 变量、圆角、毛玻璃、留白） | **PASS** | `--bg/--text/--card/--accent` 等；`backdrop-filter` 存在 |
| 浅色 / 深色主题 | **PASS** | `prefers-color-scheme` + `localStorage.theme` 手动切换 |
| 响应式（≤640/720/860） | **PASS（结构）** | 多段 `@media`；PR #2 移动端 Hero/合集标题后置 |
| 首页 / 搜索 / 排序 / 库存筛选 | **PASS** | 标题搜索、精选/价格/名称排序、全部/有货 |
| 商品详情 / 下单 / 付款说明 / 查单 | **PASS（骨架）** | 详情、支付块、倒计时、查询密码/恢复支付 |
| 前台商品**分类**筛选 | **FAIL / 缺口** | 无代充/成品号/卡密 pill；卡片文案写死「数字产品」 |
| 前台商品**来源**标识（自营 vs ProdSeller） | **FAIL / 缺口** | 后台有对接/自营分栏；商品卡与详情无来源徽章 |
| 激活类购买字段对齐后端 | **PASS** | 见下一节；与 Bot2 T2-1 对齐 |
| `form_fields` 额外自定义项 | **PASS（设计）** | 动态 `data-k` 输入；legacy `contact` 字段已跳过 |
| 管理后台（商品/卡密/上游/订单/设置/审计/收款） | **PASS** | tip 含 `/api/admin/pay-config`、ProdSeller 测连等 |
| 状态 UI（loading / toast / 缺货 / 空列表） | **部分 PASS** | toast、缺货徽章、按钮 loading 有；空态多为单行文案，无统一 empty-state |
| 前端不硬编码收款地址 / API Key | **PASS** | 地址/开关来自 `CFG.pay_config`；Key 仅显示已配置/未配置 |
| 支付与管理员权限由服务端判断 | **PASS（代码意图）** | 前端先拦无效支付方式；权威在后端 |
| 无敏感订单高频轮询 | **PASS** | 仅支付倒计时 `setInterval(1s)` |
| 浏览器实机 / staging 视觉验收 | **NOT VERIFIED** | 本轮无截图、无 staging 打开 |
| 与生产视觉一致性 | **BLOCKED** | 无生产验收授权 |

## 激活字段对齐（更正）

与 @后端 + ProdSeller 工程师 T2-1 对齐后的权威约定：

- **不是**靠 `form_fields` 表达激活邮箱。  
- 后端：商品列 `requires_email_activation`；下单强制 `customer_fields.activation_email`（及 confirm，以后端为准）。  
- 前台：当 `requires_email_activation` 为真时渲染**独立**激活邮箱输入（警告文案），并提交到 `activation_email`；通用邮箱/`contact` 映射另有规则。  
- `form_fields`：**仅**额外自定义项；legacy 联系方式字段由 `isLegacyContactField` 过滤，不再渲染。

标记：**PASS**（字段模型对齐）。多件 `quantity>1` 时后端 `emails` 长度问题属 Bot2 FAIL②，前端多邮箱 UI **未做**，随 FAIL② 修复再开（当前 **NOT VERIFIED / 待排期**）。

## 建议第一批 UI 改动（代码窗开启后）

1. 商品卡 + 详情：统一来源徽章（自营 / 上游）与真实 `category` 标签（去掉写死「数字产品」）。  
2. 首页：分类 pill（`recharge` / `account` / `card` / 全部），与列表过滤联动。  
3. 统一 empty / error / loading 样式（商城列表 + 后台表格）。  
4. 详情页按来源切换购买提示与交付说明（字段仍走后端约定）。  
5. 择机评审合入 [PR #2](https://github.com/Newbee06/zhixuan-shop/pull/2) 移动端裁剪（后置）。  
6. Bot2 修 FAIL② 后：激活多件数量的邮箱列表 UI + 与 API 联调。

## 明确不做

- 不迁移 React / Next / 新构建链  
- 不在前端存 API Key、私钥、完整卡密  
- 不以隐藏按钮代替后端权限  
- 代码窗未开前不改 `src/frontend.html` / `worker.js` / schema  

## 测试说明

- 本 PR **仅 docs**，无运行时测试要求。  
- tip 上前端相关自动化结果引用 Bot5 [PR #7](https://github.com/Newbee06/zhixuan-shop/pull/7)（mock/本地 **PASS**）；实机仍 **NOT VERIFIED**。
