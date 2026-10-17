// 浏览器验收（第二轮）：真实 Chromium + 本地 wrangler dev --local（D1 本地环境）
// 覆盖：下单成功页（内存凭证）→ 刷新后凭证不恢复 → POST 查单（URL 无凭证）→ 后台已付款订单无取消按钮 → 异常/退款流程 → 无横向溢出 → 控制台无 JS 错误
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:8791';
let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) { pass++; console.log('PASS:', name); } else { fail++; console.log('FAIL:', name, extra); } }
const browser = await chromium.launch({ headless: true, executablePath: '/opt/meta-chromium/chrome', args: ['--no-sandbox', '--no-proxy-server', '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks,PrivateNetworkAccessForNavigations'] });

// ===== 0. 前置：配置有效收款地址（支付白名单要求）=====
// 下单需有效收款地址（种子为占位符会拒单）。经 HTTP 管理员接口配置：
// 登录默认密码 → 改密为临时密码（首登强制改密）→ 配地址。
// 注意：改密要求新密码 ≥8 位，无法改回 5 位的默认密码 'admin'；
// 故浏览器内管理员登录改用临时密码登录并继续改密为 'browser-admin-123'（仍测改密流程）。
{
  const jar = [];
  async function api(method, path, body, cookie) {
    const headers = { 'content-type': 'application/json', 'X-Admin-API': '1' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) jar.push(sc.split(';')[0]);
    let j = null; try { j = await res.json(); } catch {}
    return { status: res.status, json: j };
  }
  const login = await api('POST', '/api/admin/login', { password: 'admin' });
  if (!login.json || !login.json.ok) { console.error('FATAL: setup admin login failed'); process.exit(1); }
  const ck = jar[jar.length - 1] || '';
  const chg1 = await api('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'browser-setup-temp-123' }, ck);
  if (!chg1.json || !chg1.json.ok) { console.error('FATAL: setup change-password failed'); process.exit(1); }
  const setAddr = await api('POST', '/api/admin/settings', { settings: { usdt_addresses: JSON.stringify({ 'OKX|X Layer': '0x1111111111111111111111111111111111111111', 'Binance|BEP20': '0x2222222222222222222222222222222222222222' }) } }, ck);
  if (!setAddr.json || !setAddr.json.ok) { console.error('FATAL: setup usdt_addresses failed', JSON.stringify(setAddr.json)); process.exit(1); }
  console.log('SETUP: usdt_addresses configured');
}
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });

// ===== 1. 首页 =====
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
const overflow1 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('home 1440: no horizontal overflow', overflow1 <= 1, 'overflow=' + overflow1);
check('home shows 智选', (await page.content()).includes('智选'));

// ===== 2. 下单（经 UI：读验证码 SVG 取码）=====
await page.goto(BASE + '/#/product/1', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
// 读验证码：GET /api/captcha 返回 SVG，<text> 元素即验证码字符
const cap = await page.evaluate(async () => {
  const r = await fetch('/api/captcha'); const j = await r.json();
  const doc = new DOMParser().parseFromString(j.svg, 'image/svg+xml');
  const code = Array.from(doc.querySelectorAll('text')).map((t) => t.textContent).join('');
  window._captchaId = j.captcha_id;
  return { id: j.captcha_id, code };
});
check('captcha parsed from SVG', cap.code.length === 4, JSON.stringify(cap));
// 填表单：联系邮箱 + 验证码（商品 1 是示例商品，需要的字段由表单渲染决定；这里填通用字段）
await page.evaluate((c) => {
  const contact = document.getElementById('contact');
  if (contact) contact.value = 'browser@test.example';
  const capInput = document.getElementById('captchaCode');
  if (capInput) capInput.value = c.code;
  window._captchaId = c.id;
}, cap);
// 填自定义字段（按 data-k 填充）
await page.evaluate(() => {
  document.querySelectorAll('[data-k]').forEach((el) => { if (!el.value) el.value = 'browser@test.example'; });
});
const orderRes = await page.evaluate(async () => {
  const pid = window._curProduct ? window._curProduct.id : 1;
  const cust = {};
  document.querySelectorAll('[data-k]').forEach((el) => { cust[el.getAttribute('data-k')] = el.value; });
  const qty = parseInt((document.getElementById('qty') || {}).value || '1', 10);
  const capCode = (document.getElementById('captchaCode') || {}).value || '';
  const contact = (document.getElementById('contact') || {}).value || '';
  const r = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: pid, quantity: qty, customer_fields: cust, contact, pay_method: 'Binance', pay_chain: 'BEP20', query_password: 'browser-pw123', captcha_id: window._captchaId || '', captcha_code: capCode }) });
  return await r.json();
});
check('order created via API-in-page', orderRes.ok === true, JSON.stringify(orderRes).slice(0, 300));
const orderNo = orderRes.ok ? orderRes.order.order_no : '';
const queryPassword = 'browser-pw123';

// ===== 3. 成功页：内存订单展示 → 刷新后不恢复；无系统查单凭证 =====
// 通过 SPA 路由进成功页：先模拟 submitOrder 的内存写入（与真实 submitOrder 同款：只写内存）
await page.evaluate((o) => {
  window._lastOrder = { order_no: o.order_no, total_usdt: o.total_usdt, actual_amount: o.actual_amount, pay_address: o.pay_address, wallet_address: o.wallet_address, expires_at: o.expires_at, pay_method: o.pay_method, pay_chain: o.pay_chain };
}, orderRes.order);
await page.goto(BASE + '/#/success/' + orderNo, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const successHtml = await page.content();
check('success page shows order number', successHtml.includes(orderNo));
check('success page reminds to remember query password', successHtml.includes('请牢记您设置的查询密码'));
check('success page: sessionStorage has no order/token', await page.evaluate(() => !sessionStorage.getItem('lastQueryToken') && !sessionStorage.getItem('lastOrder')));
check('success page: localStorage has no order/token', await page.evaluate(() => !localStorage.getItem('lastQueryToken') && !localStorage.getItem('lastOrder')));
// 刷新：内存清空，订单不再从存储恢复
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
check('after reload: storage still has no order/token',
  await page.evaluate(() => !sessionStorage.getItem('lastQueryToken') && !sessionStorage.getItem('lastOrder') && !localStorage.getItem('lastQueryToken') && !localStorage.getItem('lastOrder')));

// ===== 4. 查单页：订单号 + 验证码 → 列表；密码取卡密（未付款提示）；错误密码提示；邮箱不能查；URL 无凭证 =====
async function freshQueryCaptcha() {
  const c = await page.evaluate(async () => {
    const r = await fetch('/api/captcha'); const j = await r.json();
    const doc = new DOMParser().parseFromString(j.svg, 'image/svg+xml');
    const code = Array.from(doc.querySelectorAll('text')).map((t) => t.textContent).join('');
    window._qCaptchaId = j.captcha_id;
    return { id: j.captcha_id, code };
  });
  return c;
}
await page.goto(BASE + '/#/query', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
{
  const qc = await freshQueryCaptcha();
  await page.fill('#qkeywords', orderNo);
  await page.fill('#qCaptchaCode', qc.code);
  await page.evaluate((id) => { window._qCaptchaId = id; }, qc.id);
  await page.click('button:has-text("查询")');
  await page.waitForTimeout(1200);
}
const qres = await page.evaluate(() => (document.getElementById('qres') || {}).innerHTML || '');
check('query via UI: order listed', qres.includes(orderNo));
check('query via UI: password input shown', qres.includes('qpw-' + orderNo) || qres.includes('查询密码'));
check('query: URL has no credential', !page.url().includes('password=') && !page.url().includes('token=') && !page.url().includes('browser-pw123'));
// 错误密码 → 401 提示
await page.fill('#qpw-' + orderNo, 'wrongpw123');
await page.click('button:has-text("查看卡密")');
await page.waitForTimeout(1000);
const qres2 = await page.evaluate((no) => (document.getElementById('qsec-' + no) || {}).innerHTML || '', orderNo);
check('secret wrong password: error shown', qres2.includes('查询密码错误') || qres2.includes('错误'));
// 正确密码（订单未付款 → 尚未付款提示，不泄露卡密）
await page.fill('#qpw-' + orderNo, queryPassword);
await page.click('button:has-text("查看卡密")');
await page.waitForTimeout(1000);
const qres3 = await page.evaluate((no) => (document.getElementById('qsec-' + no) || {}).innerHTML || '', orderNo);
check('secret correct password on unpaid order: not-paid hint, no card leak',
  (qres3.includes('尚未付款') || qres3.includes('暂无交付内容')) && !qres3.includes('BROWSER-'));
// 邮箱不能作为查询凭证
await page.goto(BASE + '/#/query', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
{
  const qc = await freshQueryCaptcha();
  await page.fill('#qkeywords', 'browser@test.example');
  await page.fill('#qCaptchaCode', qc.code);
  await page.evaluate((id) => { window._qCaptchaId = id; }, qc.id);
  await page.click('button:has-text("查询")');
  await page.waitForTimeout(1200);
}
const qresEmail = await page.evaluate(() => (document.getElementById('qres') || {}).innerHTML || '');
check('query by email: generic empty (email is not a credential)',
  qresEmail.includes('未找到相关订单') && !qresEmail.includes(orderNo));

// ===== 5. 后台：登录 → 改密 → 订单详情（已付款订单无取消按钮，有异常处理）=====
await page.goto(BASE + '/#/admin', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.fill('#apwd', 'browser-setup-temp-123');
await page.click('#loginBtn');
await page.waitForTimeout(800);
// 首次改密
if (await page.locator('#oldpw').count()) {
  await page.fill('#oldpw', 'browser-setup-temp-123');
  await page.fill('#newpw', 'browser-admin-123');
  await page.click('#changePwBtn');
  await page.waitForTimeout(800);
}
check('admin logged in', (await page.content()).includes('订单管理') || (await page.content()).includes('数据'));
// 经 API 建一笔已付款订单（人工商品），再在后台打开详情
const adminSetup = await page.evaluate(async () => {
  const me = await fetch('/api/admin/me').then((r) => r.json());
  // 建人工商品
  const pr = await fetch('/api/admin/products', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-API': '1' }, body: JSON.stringify({ title: '浏览器验收人工商品', category: 'recharge', stock_type: 'manual', sell_price: 2, source: 'self' }) }).then((r) => r.json());
  // 查商品 id
  const list = await fetch('/api/admin/products?q=' + encodeURIComponent('浏览器验收人工商品')).then((r) => r.json());
  const pid = list.products[0].id;
  // 下单（经 API：验证码用服务端接口取码）
  const cap = await fetch('/api/captcha').then((r) => r.json());
  const doc = new DOMParser().parseFromString(cap.svg, 'image/svg+xml');
  const code = Array.from(doc.querySelectorAll('text')).map((t) => t.textContent).join('');
  const ord = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: pid, quantity: 1, customer_fields: { contact_email: 'browser-paid@test.example' }, contact: 'browser-paid@test.example', pay_method: 'OKX', pay_chain: 'X Layer', captcha_id: cap.captcha_id, captcha_code: code }) }).then((r) => r.json());
  const ordRow = await fetch('/api/admin/orders?q=' + encodeURIComponent(ord.order.order_no)).then((r) => r.json());
  const oid = ordRow.orders[0].id;
  const conf = await fetch('/api/admin/orders/' + oid + '/confirm-payment', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-API': '1' }, body: JSON.stringify({ reason: '浏览器验收确认' }) }).then((r) => r.json());
  return { me, pid, oid, conf, orderNo: ord.order.order_no };
});
check('admin setup: paid order created', adminSetup.conf && adminSetup.conf.ok === true, JSON.stringify(adminSetup.conf).slice(0, 200));
// 在后台订单页搜索该订单并打开详情
await page.evaluate(() => { window.location.hash = '#/admin/orders'; });
await page.waitForTimeout(800);
await page.fill('#ordQ', adminSetup.orderNo);
await page.click('button:has-text("搜索")');
await page.waitForTimeout(1000);
await page.evaluate(() => {
  const btn = document.querySelector('button[onclick*="adminOrderDetail"]');
  if (btn) btn.click();
});
await page.waitForTimeout(1000);
const detailHtml = await page.content();
check('admin order detail: no ordinary cancel button for paid order', !detailHtml.includes('取消订单（仅未付款）') && !detailHtml.includes('>取消订单<'));
check('admin order detail: has exception button', detailHtml.includes('异常处理'));
check('admin order detail: has fulfill button', detailHtml.includes('发货'));

// ===== 6. 异常 / 退款流程（经 UI）=====
// 点“异常处理” → 填原因 → 勾选需要退款 → 确认
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const b = btns.find((x) => x.textContent.trim() === '异常处理');
  if (b) b.click();
});
await page.waitForTimeout(600);
const modalHtml = await page.content();
check('exception modal shown', modalHtml.includes('异常处理') && modalHtml.includes('需要退款'));
await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('input'));
  const reasonInput = inputs.find((x) => (x.placeholder || '').includes('异常原因') || (x.placeholder || '').includes('无法交付'));
  if (reasonInput) reasonInput.value = '浏览器验收：上游无法交付，需退款';
  const cb = document.getElementById('exRefund');
  if (cb) cb.checked = true;
});
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const b = btns.find((x) => x.textContent.trim() === '确认标记');
  if (b) b.click();
});
await page.waitForTimeout(1200);
const afterEx = await page.content();
check('exception flow: refund_pending shown', afterEx.includes('退款待处理') || afterEx.includes('已标记'));
// 打开详情，点“确认已退款”
await page.evaluate(() => {
  const btn = document.querySelector('button[onclick*="adminOrderDetail"]');
  if (btn) btn.click();
});
await page.waitForTimeout(1000);
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const b = btns.find((x) => x.textContent.trim() === '确认已退款');
  if (b) b.click();
});
await page.waitForTimeout(600);
await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('input'));
  const refInput = inputs.find((x) => (x.placeholder || '').includes('退款交易哈希') || (x.placeholder || '').includes('转账记录'));
  if (refInput) refInput.value = 'BROWSER-REFUND-001';
});
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const b = btns.find((x) => x.textContent.trim() === '确认已在系统外退款');
  if (b) b.click();
});
await page.waitForTimeout(1200);
const afterRefund = await page.content();
check('refund flow: order cancelled after confirm', afterRefund.includes('已取消') || afterRefund.includes('已确认退款'));

// ===== 7. 移动端：390px 无横向溢出 =====
await ctx.setViewportSize({ width: 390, height: 844 });
await page.goto(BASE + '/#/query', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const overflowM = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('mobile 390 query: no horizontal overflow', overflowM <= 1, 'overflow=' + overflowM);

// ===== 8. 控制台无 JS 错误 =====
check('no JS console errors', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

await browser.close();
console.log('\nBROWSER ACCEPTANCE DONE pass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
