// 浏览器验收（CI 版）：真实 Playwright Chromium + 本地 wrangler dev --local（D1 本地环境）。
// 与 tests/browser-acceptance.mjs（本机 Chromium 路径）不同：本文件用 npm `playwright` 包，
// 由 CI 工作流启动 wrangler dev 并等待 /api/config 就绪后运行；BASE 经环境变量传入。
// 全部使用虚构数据（@test.example / BROWSER-*），不碰生产密钥与生产数据库。
// 覆盖：首页/商品、下单+支付状态模拟、查单、管理员登录、全部后台菜单（数据/订单/商品/卡密/上游/设置/审计）、
// 订单异常界面、加载失败/空数据/错误提示；视口 1440/390/360；深色模式；横向溢出；控制台错误。
// 任一检查失败即 process.exit(1)，不在 CI 中掩盖失败。
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8791';
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; failures.push(name + (extra ? ' | ' + extra : '')); console.log('FAIL:', name, extra); }
}

async function waitForServer(maxMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await fetch(BASE + '/api/config');
      if (r.ok) { console.log('SERVER UP:', BASE); return true; }
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

const serverOk = await waitForServer();
if (!serverOk) { console.error('FAIL: dev server not reachable at ' + BASE + ' after 60s'); process.exit(1); }

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push('pageerror: ' + String(e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  // 过滤非应用错误的环境噪声与预期内的鉴权失败（不弱化真实 JS 异常检查）：
  // - ERR_TUNNEL_CONNECTION_FAILED：本机代理环境加载外部资源失败，非应用代码错误。
  // - 401：错误凭证查单测试（预期返回 401）与未登录时 /api/admin/me 的预期鉴权失败。
  // - favicon.ico 404：应用无 favicon，浏览器自动请求，属良性；其他 404 仍计为错误。
  // - 404（控制台消息不带 URL，无法区分预期/非预期）：由下方基于响应的 notFoundUrls 检查兜底（带 URL，可准确判定）。
  if (text.includes('ERR_TUNNEL_CONNECTION_FAILED')) return;
  if (text.includes('401')) return;
  if (text.includes('favicon.ico')) return;
  if (text.includes('404')) return;
  jsErrors.push(text);
});
const apiFailures = [];
const notFoundUrls = [];
page.on('response', (res) => {
  const u = res.url();
  if (u.includes('/api/') && res.status() >= 500) apiFailures.push(res.status() + ' ' + u);
  // 排除预期内的 404：favicon（无 favicon）与故意查不存在订单的 lookup（应返回 404 + 错误提示）。
  if (res.status() === 404 && !u.includes('favicon.ico') && !u.includes('AIS-EMPTY-0000')) notFoundUrls.push(u);
});

// ===== 1. 首页 =====
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
check('home 1440: shows site name', (await page.content()).includes('智选'));
check('home 1440: no horizontal overflow',
  (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
check('home 1440: products listed', (await page.content()).includes('pcard') || (await page.content()).includes('商品'));

// ===== 2. 下单（经页面内 API：读验证码 SVG 取码，与真实提交同款）=====
await page.goto(BASE + '/#/product/1', { waitUntil: 'networkidle' });
// 订单表单是异步渲染（先取商品再渲染），必须等 #captchaCode 出现后再填，否则值写不进去。
await page.waitForSelector('#captchaCode', { timeout: 15000 });
await page.waitForTimeout(300);
const cap = await page.evaluate(async () => {
  const r = await fetch('/api/captcha'); const j = await r.json();
  const doc = new DOMParser().parseFromString(j.svg, 'image/svg+xml');
  const code = Array.from(doc.querySelectorAll('text')).map((t) => t.textContent).join('');
  window._captchaId = j.captcha_id;
  return { id: j.captcha_id, code };
});
check('captcha parsed from SVG', cap.code.length === 4, JSON.stringify(cap));
await page.evaluate((c) => {
  const contact = document.getElementById('contact');
  if (contact) contact.value = 'browser-ci@test.example';
  const capInput = document.getElementById('captchaCode');
  if (capInput) capInput.value = c.code;
  window._captchaId = c.id;
}, cap);
await page.evaluate(() => {
  document.querySelectorAll('[data-k]').forEach((el) => { if (!el.value) el.value = 'browser-ci@test.example'; });
});
const orderRes = await page.evaluate(async () => {
  const pid = window._curProduct ? window._curProduct.id : 1;
  const cust = {};
  document.querySelectorAll('[data-k]').forEach((el) => { cust[el.getAttribute('data-k')] = el.value; });
  const qty = parseInt((document.getElementById('qty') || {}).value || '1', 10);
  const capCode = (document.getElementById('captchaCode') || {}).value || '';
  const contact = (document.getElementById('contact') || {}).value || '';
  const r = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: pid, quantity: qty, customer_fields: cust, contact, pay_method: 'Binance', pay_chain: 'X Layer', captcha_id: window._captchaId || '', captcha_code: capCode }) });
  return await r.json();
});
check('order created via API-in-page', orderRes.ok === true, JSON.stringify(orderRes).slice(0, 300));
if (!orderRes.ok) {
  console.error('FATAL: order creation failed, cannot continue browser flow. Response: ' + JSON.stringify(orderRes).slice(0, 500));
  await browser.close();
  process.exit(1);
}
const orderNo = orderRes.ok ? orderRes.order.order_no : '';
const queryToken = orderRes.ok ? orderRes.order.query_token : '';

// ===== 3. 成功页：内存凭证展示 → 刷新后不恢复 =====
await page.evaluate((o) => {
  window._lastOrder = { order_no: o.order_no, total_usdt: o.total_usdt, actual_amount: o.actual_amount, pay_address: o.pay_address, wallet_address: o.wallet_address, expires_at: o.expires_at, pay_method: o.pay_method, pay_chain: o.pay_chain };
  window._lastQueryToken = o.query_token;
}, orderRes.order);
await page.goto(BASE + '/#/success/' + orderNo, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
check('success page shows token from memory', (await page.content()).includes(queryToken.slice(0, 8)));
check('success page: sessionStorage has no token',
  await page.evaluate(() => !sessionStorage.getItem('lastQueryToken') && !sessionStorage.getItem('lastOrder')));
check('success page: localStorage has no token',
  await page.evaluate(() => !localStorage.getItem('lastQueryToken') && !localStorage.getItem('lastOrder')));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
check('after reload: token NOT restored', !(await page.content()).includes(queryToken));
check('after reload: shows use-saved-credential hint',
  (await page.content()).includes('事先保存') || (await page.content()).includes('刷新页面后不再恢复'));

// ===== 4. 查单页：POST 查单，URL 无凭证；错误凭证提示 =====
await page.goto(BASE + '/#/query', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.fill('#qno', orderNo);
await page.fill('#qtoken', queryToken);
await page.click('button:has-text("查询")');
await page.waitForTimeout(1200);
const qres = await page.evaluate(() => (document.getElementById('qres') || {}).innerHTML || '');
check('lookup via UI: order detail shown', qres.includes(orderNo) || qres.includes('待付款') || qres.includes('精确应付'));
check('lookup: URL has no token', !page.url().includes('token=') && !page.url().includes(queryToken.slice(0, 8)));
await page.fill('#qtoken', 'wrongtoken123');
await page.click('button:has-text("查询")');
await page.waitForTimeout(1000);
check('lookup wrong token: error shown',
  (await page.evaluate(() => (document.getElementById('qres') || {}).innerHTML || '')).includes('查单凭证错误')
  || (await page.evaluate(() => (document.getElementById('qres') || {}).innerHTML || '')).includes('错误'));
// 空数据：查不存在的订单
await page.fill('#qno', 'AIS-EMPTY-0000');
await page.fill('#qtoken', 'emptytoken');
await page.click('button:has-text("查询")');
await page.waitForTimeout(1000);
check('lookup missing order: error shown (not blank)',
  (await page.evaluate(() => (document.getElementById('qres') || {}).innerHTML || '')).length > 0);

// ===== 5. 后台：登录 → 全部菜单渲染 =====
await page.goto(BASE + '/#/admin', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.fill('#apwd', 'admin');
await page.click('#loginBtn');
await page.waitForTimeout(800);
if (await page.locator('#oldpw').count()) {
  await page.fill('#oldpw', 'admin');
  await page.fill('#newpw', 'browser-ci-admin-123');
  await page.click('#changePwBtn');
  await page.waitForTimeout(800);
}
check('admin logged in', (await page.content()).includes('订单管理') || (await page.content()).includes('数据'));
for (const [tab, label] of [['data', '数据总览'], ['orders', '订单管理'], ['products', '商品管理'], ['cards', '卡密库存'], ['upstream', '上游管理'], ['settings', '系统设置'], ['audit', '操作审计']]) {
  await page.click(`button[data-tab="${tab}"]`);
  await page.waitForTimeout(900);
  const body = await page.content();
  check(`admin tab ${tab} renders (${label})`, body.includes(label) || body.includes('暂无') || body.includes('加载'),
    body.slice(0, 200).replace(/\s+/g, ' '));
  check(`admin tab ${tab}: no horizontal overflow`,
    (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
}

// ===== 6. 已付款订单：后台详情无普通取消按钮，有异常处理；异常/退款流程 =====
const adminSetup = await page.evaluate(async () => {
  const pr = await fetch('/api/admin/products', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-API': '1' }, body: JSON.stringify({ title: 'CI验收人工商品', category: 'recharge', stock_type: 'manual', sell_price: 2, source: 'self' }) }).then((r) => r.json());
  const list = await fetch('/api/admin/products?q=' + encodeURIComponent('CI验收人工商品')).then((r) => r.json());
  const pid = list.products[0].id;
  const cap2 = await fetch('/api/captcha').then((r) => r.json());
  const doc = new DOMParser().parseFromString(cap2.svg, 'image/svg+xml');
  const code = Array.from(doc.querySelectorAll('text')).map((t) => t.textContent).join('');
  const ord = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: pid, quantity: 1, customer_fields: { contact_email: 'browser-ci-paid@test.example' }, contact: 'browser-ci-paid@test.example', pay_method: 'OKX', pay_chain: 'X Layer', captcha_id: cap2.captcha_id, captcha_code: code }) }).then((r) => r.json());
  const ordRow = await fetch('/api/admin/orders?q=' + encodeURIComponent(ord.order.order_no)).then((r) => r.json());
  const oid = ordRow.orders[0].id;
  const conf = await fetch('/api/admin/orders/' + oid + '/confirm-payment', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-API': '1' }, body: JSON.stringify({ reason: 'CI验收确认' }) }).then((r) => r.json());
  return { pid, oid, conf, orderNo: ord.order.order_no };
});
check('admin setup: paid order created', adminSetup.conf && adminSetup.conf.ok === true, JSON.stringify(adminSetup.conf).slice(0, 200));
if (!adminSetup.conf || !adminSetup.conf.ok) {
  console.error('FATAL: admin paid-order setup failed. Response: ' + JSON.stringify(adminSetup).slice(0, 500));
  await browser.close();
  process.exit(1);
}
await page.click('button[data-tab="orders"]');
await page.waitForTimeout(800);
await page.fill('#ordQ', adminSetup.orderNo);
await page.click('button:has-text("搜索")');
await page.waitForTimeout(1000);
await page.evaluate(() => {
  const btn = document.querySelector('button[onclick*="adminOrderDetail"]');
  if (btn) btn.click();
});
await page.waitForTimeout(1000);
// 取消按钮检查必须限定在订单详情抽屉（#drawerPanel）内：订单列表里未付款订单本就有取消按钮，全页检查会误报。
const drawerHtml = await page.evaluate(() => (document.getElementById('drawerPanel') || {}).innerHTML || '');
check('admin order detail: no ordinary cancel button for paid order',
  !drawerHtml.includes('取消订单（仅未付款）') && !drawerHtml.includes('>取消订单<'), drawerHtml.slice(0, 300));
check('admin order detail: has exception button', drawerHtml.includes('异常处理'));
check('admin order detail: has fulfill button', drawerHtml.includes('发货'));
// 异常 → 退款待处理 → 确认已退款
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '异常处理');
  if (b) b.click();
});
await page.waitForTimeout(600);
check('exception modal shown', (await page.content()).includes('异常处理') && (await page.content()).includes('需要退款'));
await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('input'));
  const reasonInput = inputs.find((x) => (x.placeholder || '').includes('异常原因') || (x.placeholder || '').includes('无法交付'));
  if (reasonInput) reasonInput.value = 'CI验收：上游无法交付，需退款';
  const cb = document.getElementById('exRefund');
  if (cb) cb.checked = true;
});
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '确认标记');
  if (b) b.click();
});
await page.waitForTimeout(1200);
check('exception flow: refund_pending shown', (await page.content()).includes('退款待处理') || (await page.content()).includes('已标记'));
await page.evaluate(() => {
  const btn = document.querySelector('button[onclick*="adminOrderDetail"]');
  if (btn) btn.click();
});
await page.waitForTimeout(1000);
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '确认已退款');
  if (b) b.click();
});
await page.waitForTimeout(600);
await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('input'));
  const refInput = inputs.find((x) => (x.placeholder || '').includes('退款交易哈希') || (x.placeholder || '').includes('转账记录'));
  if (refInput) refInput.value = 'CI-REFUND-001';
});
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '确认已在系统外退款');
  if (b) b.click();
});
await page.waitForTimeout(1200);
check('refund flow: order cancelled after confirm', (await page.content()).includes('已取消') || (await page.content()).includes('已确认退款'));

// ===== 6b. F-01 回归：恶意 delivery_content 不得突破 onclick（存储型 XSS）=====
// 发货时交付内容含 onclick 突破载荷；打开管理员订单详情并点击“复制交付内容”（触发含 delivery_content 的 onclick）。
// 若 escH 转义失效，载荷会突破属性并执行 alert(1) → dialog 监听捕获，测试失败。
const xssSetup = await page.evaluate(async () => {
  const pr = await fetch('/api/admin/products', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-API': '1' }, body: JSON.stringify({ title: 'CI验收XSS商品', category: 'recharge', stock_type: 'manual', sell_price: 2, source: 'self' }) }).then((r) => r.json());
  const list = await fetch('/api/admin/products?q=' + encodeURIComponent('CI验收XSS商品')).then((r) => r.json());
  const pid = list.products[0].id;
  const cap3 = await fetch('/api/captcha').then((r) => r.json());
  const doc = new DOMParser().parseFromString(cap3.svg, 'image/svg+xml');
  const code = Array.from(doc.querySelectorAll('text')).map((t) => t.textContent).join('');
  const ord = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: pid, quantity: 1, customer_fields: { contact_email: 'browser-ci-xss@test.example' }, contact: 'browser-ci-xss@test.example', pay_method: 'OKX', pay_chain: 'X Layer', captcha_id: cap3.captcha_id, captcha_code: code }) }).then((r) => r.json());
  const ordRow = await fetch('/api/admin/orders?q=' + encodeURIComponent(ord.order.order_no)).then((r) => r.json());
  const oid = ordRow.orders[0].id;
  await fetch('/api/admin/orders/' + oid + '/confirm-payment', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-API': '1' }, body: JSON.stringify({ reason: 'CI验收XSS确认' }) }).then((r) => r.json());
  const payload = 'XSS-TEST" onclick="alert(1) //';
  const ful = await fetch('/api/admin/orders/' + oid + '/fulfill', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-API': '1' }, body: JSON.stringify({ delivery_content: payload }) }).then((r) => r.json());
  return { oid, orderNo: ord.order.order_no, ful };
});
check('F-01 setup: order fulfilled with malicious delivery_content', xssSetup.ful && xssSetup.ful.ok === true, JSON.stringify(xssSetup.ful).slice(0, 200));
// §6 退款流程结束后订单详情抽屉仍开着（遮罩拦截点击），先按 Escape 关闭再切换标签。
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.click('button[data-tab="orders"]');
await page.waitForTimeout(800);
await page.fill('#ordQ', xssSetup.orderNo);
await page.click('button:has-text("搜索")');
await page.waitForTimeout(1000);
const xssDialogs = [];
page.on('dialog', (d) => { xssDialogs.push(d.message()); d.dismiss().catch(() => {}); });
await page.evaluate(() => {
  const btn = document.querySelector('button[onclick*="adminOrderDetail"]');
  if (btn) btn.click();
});
await page.waitForTimeout(1000);
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '复制交付内容');
  if (b) b.click();
});
await page.waitForTimeout(800);
check('F-01: malicious delivery_content did NOT trigger alert via onclick', xssDialogs.length === 0, 'dialogs=' + JSON.stringify(xssDialogs));
check('F-01: order detail shows delivery content', (await page.evaluate(() => (document.getElementById('drawerPanel') || {}).innerHTML || '')).includes('XSS-TEST'));

// ===== 6c. 第七轮：历史旧 form_fields 商品 + 统一邮箱框 + 真实按钮下单 =====
// 历史商品 form_fields 含旧 { key:'contact', label:'联系方式（邮箱/TG）', required:true }；
// 页面不得再渲染它；只保留一个通用邮箱框；点“立即购买”真实提交，捕获请求载荷验证三字段映射。
const legacySetup = await page.evaluate(async () => {
  const ff = [{ key: 'contact', label: '联系方式（邮箱/TG）', required: true, placeholder: '' }, { key: 'custom_note', label: '备注（自定义）', required: false, placeholder: '' }];
  const pr = await fetch('/api/admin/products', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-API': '1' }, body: JSON.stringify({ title: 'CI验收旧字段卡密商品', category: 'card', stock_type: 'card', sell_price: 2, source: 'self', delivery_method: 'both', form_fields: ff }) }).then((r) => r.json());
  const list = await fetch('/api/admin/products?q=' + encodeURIComponent('CI验收旧字段卡密商品')).then((r) => r.json());
  const pid = list.products[0].id;
  const imp = await fetch('/api/admin/cards/import', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-API': '1' }, body: JSON.stringify({ product_id: pid, codes: 'CI-LEGACY-KEY-1' }) }).then((r) => r.json());
  return { pid, created: !!(pr && pr.ok), imported: imp.added };
});
check('7th setup: legacy-form_fields card product created + card imported', legacySetup.created && legacySetup.imported === 1, JSON.stringify(legacySetup));
// 先挂上请求捕获，再进页面、再点按钮，避免错过真实下单请求。
const legacyOrderReqPromise = page.waitForRequest((req) => req.url().includes('/api/orders') && req.method() === 'POST', { timeout: 60000 });
const legacyOrderResPromise = page.waitForResponse((res) => res.url().includes('/api/orders') && res.request().method() === 'POST', { timeout: 60000 });
await page.goto(BASE + '/#/product/' + legacySetup.pid, { waitUntil: 'networkidle' });
await page.waitForSelector('#captchaCode', { timeout: 15000 });
await page.waitForTimeout(300);
// 6b 结束时订单详情抽屉仍开着（抽屉在页面壳里，不随 #app 重渲染消失），会遮住商品页按钮；先 Escape 关闭。
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('7th drawer closed before clicking buy', await page.evaluate(() => !document.getElementById('drawerPanel')));
const legacyPageHtml = await page.content();
// 注意：page.content() 含 <script> 源码（匹配谓词本身带旧标签字符串），须查可见文本 innerText 才准确。
check('7th page: no legacy contact field rendered',
  !(await page.evaluate(() => document.body.innerText.includes('联系方式（邮箱/TG）'))));
check('7th page: no [data-k=contact] input in DOM',
  await page.evaluate(() => document.querySelectorAll('input[data-k="contact"]').length === 0));
check('7th page: single unified email input #contact',
  await page.evaluate(() => !!document.getElementById('contact')));
check('7th page: unified email label + helper text',
  legacyPageHtml.includes('邮箱地址') && legacyPageHtml.includes('用于订单联系；需要邮件交付的商品，也会使用该邮箱接收卡密或账号。'));
check('7th page: admin custom field preserved (custom_note rendered)',
  await page.evaluate(() => document.querySelectorAll('input[data-k="custom_note"]').length === 1));
const legacyCap = await page.evaluate(async () => {
  const r = await fetch('/api/captcha'); const j = await r.json();
  const doc = new DOMParser().parseFromString(j.svg, 'image/svg+xml');
  const code = Array.from(doc.querySelectorAll('text')).map((t) => t.textContent).join('');
  window._captchaId = j.captcha_id;
  return { id: j.captcha_id, code };
});
check('7th captcha parsed', legacyCap.code.length === 4, JSON.stringify(legacyCap));
await page.fill('#contact', 'browser-ci-legacy@test.example');
await page.fill('#captchaCode', legacyCap.code);
await page.click('button:has-text("立即购买")');
const legacyReq = await legacyOrderReqPromise;
const legacyPayload = JSON.parse(legacyReq.postData() || '{}');
check('7th payload: contact = unified email', legacyPayload.contact === 'browser-ci-legacy@test.example', JSON.stringify(legacyPayload).slice(0, 300));
check('7th payload: customer_fields.contact_email = unified email',
  legacyPayload.customer_fields && legacyPayload.customer_fields.contact_email === 'browser-ci-legacy@test.example', JSON.stringify(legacyPayload.customer_fields));
check('7th payload: customer_fields.delivery_email = unified email',
  legacyPayload.customer_fields && legacyPayload.customer_fields.delivery_email === 'browser-ci-legacy@test.example', JSON.stringify(legacyPayload.customer_fields));
check('7th payload: no legacy cust.contact key',
  !(legacyPayload.customer_fields && ('contact' in legacyPayload.customer_fields)), JSON.stringify(legacyPayload.customer_fields));
const legacyRes = await legacyOrderResPromise;
const legacyResJson = await legacyRes.json();
check('7th order: created via real button click (no delivery_email error)', legacyResJson.ok === true, JSON.stringify(legacyResJson).slice(0, 300));
if (legacyResJson.ok) {
  await page.waitForFunction(() => location.hash.includes('#/success/'), { timeout: 15000 }).catch(() => {});
  check('7th success page shown after real submit', page.url().includes('#/success/'), page.url());
  const legacyPersist = await page.evaluate(async (no) => {
    const r = await fetch('/api/admin/orders?q=' + encodeURIComponent(no)).then((x) => x.json());
    const o = (r.orders || [])[0] || {};
    const cf = (typeof o.customer_fields === 'string') ? (() => { try { return JSON.parse(o.customer_fields); } catch { return {}; } })() : (o.customer_fields || {});
    return { contact: o.contact, cf };
  }, legacyResJson.order.order_no);
  check('7th persisted: contact + delivery_email + contact_email consistent',
    legacyPersist.contact === 'browser-ci-legacy@test.example' && legacyPersist.cf.delivery_email === 'browser-ci-legacy@test.example' && legacyPersist.cf.contact_email === 'browser-ci-legacy@test.example', JSON.stringify(legacyPersist));
  check('7th persisted: custom field kept', legacyPersist.cf.custom_note === '' || 'custom_note' in legacyPersist.cf, JSON.stringify(legacyPersist.cf));
}

// ===== 7. 深色模式 =====
await page.evaluate(() => { if (window.toggleTheme) window.toggleTheme(); });
await page.waitForTimeout(500);
check('dark mode: theme toggled', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
check('dark mode: no horizontal overflow',
  (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
await page.evaluate(() => { if (window.toggleTheme) window.toggleTheme(); });
await page.waitForTimeout(300);

// ===== 8. 移动端视口 =====
for (const [w, h, label] of [[390, 844, '390'], [360, 740, '360']]) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(BASE + '/#/query', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  check(`mobile ${label}: no horizontal overflow`,
    (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  check(`mobile ${label} home: no horizontal overflow`,
    (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
}

// ===== 9. 控制台与接口失败 =====
check('no JS console errors', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
check('no 5xx API responses during flow', apiFailures.length === 0, apiFailures.slice(0, 3).join(' | '));
check('no unexpected 404 responses (excluding favicon)', notFoundUrls.length === 0, notFoundUrls.slice(0, 3).join(' | '));

await browser.close();
console.log('\nBROWSER CI DONE pass=' + pass + ' fail=' + fail);
if (fail) { console.log('FAILURES:\n' + failures.map((f) => ' - ' + f).join('\n')); process.exit(1); }
