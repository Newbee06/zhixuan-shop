// 浏览器验收（第二轮）：真实 Playwright Chromium + 本地 wrangler dev --local（D1 本地环境）。
// 【已废弃 / 手动脚本】本文件不再由任何 npm 脚本或 CI 运行（package.json test:browser 走 browser-acceptance-ci.mjs）。
// 保留仅供手动参考；手动运行时需先在 wrangler dev 环境配置 ZHIXUAN_SETUP_TOKEN，并用建站令牌登录（B-P0 起不再接受默认密码）。
// 与 CI 版（browser-acceptance-ci.mjs）同一浏览器启动方式（npm `playwright` 包 + --no-sandbox，
// 不用本机 /opt/meta-chromium/chrome——该系统 Chromium 的本地网络访问检查会挡 127.0.0.1，导致脚本在 VM 环境无法运行）。
// 覆盖：下单成功页（内存凭证）→ 刷新后凭证不恢复 → POST 查单（URL 无凭证）→ 后台已付款订单无取消按钮 → 异常/退款流程 → 无横向溢出 → 控制台无 JS 错误
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:8791';
let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) { pass++; console.log('PASS:', name); } else { fail++; console.log('FAIL:', name, extra); } }
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

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
  const login = await api('POST', '/api/admin/login', { setup_token: process.env.ZHIXUAN_SETUP_TOKEN || 'test-setup-token' });
  if (!login.json || !login.json.ok) { console.error('FATAL: setup admin login failed'); process.exit(1); }
  const ck = jar[jar.length - 1] || '';
  const chg1 = await api('POST', '/api/admin/change-password', { old_password: '', new_password: 'browser-setup-temp-123' }, ck);
  if (!chg1.json || !chg1.json.ok) { console.error('FATAL: setup change-password failed'); process.exit(1); }
  const setAddr = await api('POST', '/api/admin/settings', { settings: { usdt_addresses: JSON.stringify({ 'OKX|X Layer': '0x1111111111111111111111111111111111111111', 'Binance|BEP20': '0x2222222222222222222222222222222222222222' }) } }, ck);
  if (!setAddr.json || !setAddr.json.ok) { console.error('FATAL: setup usdt_addresses failed', JSON.stringify(setAddr.json)); process.exit(1); }
  console.log('SETUP: usdt_addresses configured');
}
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(String(e)));
// 只收 JS 错误：过滤“Failed to load resource”（网络/代理环境问题，如 VM 代理挡外部二维码服务），不是 JS 错误。
page.on('console', (m) => { if (m.type() === 'error' && !String(m.text()).includes('Failed to load resource')) jsErrors.push(m.text()); });

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
// P1-13：刷新后渲染“恢复支付信息”表单（订单号预填 + 独立验证码），恢复后重新显示收款地址与 /pay 验证码。
check('after reload: recover payment form shown', (await page.content()).includes('恢复支付信息'));
check('after reload: recover order no prefilled', await page.evaluate((no) => (document.getElementById('recoverOrderNo') || {}).value === no, orderNo));
check('after reload: recover captcha image shown', await page.evaluate(() => !!document.getElementById('recoverCaptchaImg')));
const recCap = await page.evaluate(() => {
  const img = document.getElementById('recoverCaptchaImg');
  const svg = img ? decodeURIComponent(img.src.split(',').slice(1).join(',')) : '';
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  return Array.from(doc.querySelectorAll('text')).map((t) => t.textContent).join('');
});
check('recover captcha parsed from image SVG', recCap.length === 4, recCap);
await page.fill('#recoverCaptchaCode', recCap);
await page.click('button:has-text("恢复支付信息")');
await page.waitForTimeout(1500);
const recoveredHtml = await page.content();
check('recover flow: pay address restored', recoveredHtml.includes('收款地址') && recoveredHtml.includes('data-full-addr="0x2222222222222222222222222222222222222222"'));
check('recover flow: /pay captcha input shown', await page.evaluate(() => !!document.getElementById('payCaptchaCode')));

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
check('query via UI: pay address shown for pending_payment order', qres.includes('收款地址') && qres.includes('0x2222222222222222222222222222222222222222') && qres.includes('addrBox-' + orderNo) && qres.includes('data-copy-target="addrBox-' + orderNo + '"'));
check('query via UI: password input shown (P3-39: exact qpw-<orderNo>)', qres.includes('qpw-' + orderNo));
check('query: URL has no credential', !page.url().includes('password=') && !page.url().includes('token=') && !page.url().includes('browser-pw123'));
// 错误密码 → 401 提示
await page.fill('#qpw-' + orderNo, 'wrongpw123');
await page.click('button:has-text("查看卡密")');
await page.waitForTimeout(1000);
const qres2 = await page.evaluate((no) => (document.getElementById('qsec-' + no) || {}).innerHTML || '', orderNo);
check('secret wrong password: exact error shown (P3-38)', qres2.includes('查询密码错误'));
// 正确密码（订单未付款 → 尚未付款提示，不泄露卡密）
await page.fill('#qpw-' + orderNo, queryPassword);
await page.click('button:has-text("查看卡密")');
await page.waitForTimeout(1000);
const qres3 = await page.evaluate((no) => (document.getElementById('qsec-' + no) || {}).innerHTML || '', orderNo);
check('secret correct password on unpaid order: not-paid hint, no card leak',
  (qres3.includes('尚未付款') || qres3.includes('暂无交付内容')) && !qres3.includes('BROWSER-'));
// P1-6：邮箱双查是现有产品功能（邮箱 + 图形验证码可查订单概要，≠ 邮箱所有权证明）；概要不得泄露卡密。
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
check('query by email: order listed (dual query), no secret leak',
  qresEmail.includes(orderNo) && !qresEmail.includes('BROWSER-'));

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
  const ord = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: pid, quantity: 1, customer_fields: { contact_email: 'browser-paid@test.example' }, contact: 'browser-paid@test.example', pay_method: 'OKX', pay_chain: 'X Layer', query_password: 'browser-pw123', captcha_id: cap.captcha_id, captcha_code: code }) }).then((r) => r.json());
  const ordRow = await fetch('/api/admin/orders?q=' + encodeURIComponent(ord.order.order_no)).then((r) => r.json());
  const oid = ordRow.orders[0].id;
  const conf = await fetch('/api/admin/orders/' + oid + '/confirm-payment', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-API': '1' }, body: JSON.stringify({ reason: '浏览器验收确认' , manual_confirm: true }) }).then((r) => r.json());
  return { me, pid, oid, conf, orderNo: ord.order.order_no };
});
check('admin setup: paid order created', adminSetup.conf && adminSetup.conf.ok === true, JSON.stringify(adminSetup.conf).slice(0, 200));
// 在后台订单页搜索该订单并打开详情
await page.evaluate(async () => { await adminTab('orders'); });
await page.waitForTimeout(800);
check('P2-6: admin orders table has thead/tbody + td data-label',
  await page.evaluate(() => Array.from(document.querySelectorAll('.adm-table')).every((tb) => tb.querySelector('thead') && tb.querySelector('tbody') && Array.from(tb.querySelectorAll('tbody td')).every((td) => td.hasAttribute('data-label')))));
await page.fill('#ordQ', adminSetup.orderNo);
await page.click('button:has-text("搜索")');
await page.waitForTimeout(1000);
await page.evaluate(() => {
  const btn = document.querySelector('button[onclick*="adminOrderDetail"]');
  if (btn) btn.click();
});
await page.waitForTimeout(1000);
// 取消按钮检查必须限定在订单详情抽屉（#drawerPanel）内：订单列表里未付款订单本就有取消按钮，全页检查会误报（与 CI 版一致）。
const detailHtml = await page.evaluate(() => (document.getElementById('drawerPanel') || {}).innerHTML || '');
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
// P1-5：退款确认弹窗有“已在上游后台作废该上游订单”复选框，须勾选（无上游订单时按弹窗提示直接勾选）。
check('refund modal: upstream-voided checkbox shown', (await page.content()).includes('已在上游后台作废该上游订单'));
await page.evaluate(() => { const cb = document.getElementById('refundVoided'); if (cb) cb.checked = true; });
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
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(BASE + '/#/query', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const overflowM = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('mobile 390 query: no horizontal overflow', overflowM <= 1, 'overflow=' + overflowM);

// ===== 7b. P2-12：浏览器计算样式真实断言（与 CI 版 8b 同款）=====
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
{
  const s = await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    const sold = document.createElement('button'); sold.className = 'pcard-btn pcard-btn-soldout'; document.body.appendChild(sold);
    const h1 = document.querySelector('.home-h1');
    const hero = document.querySelector('.home-hero');
    const out = {
      soldBg: getComputedStyle(sold).getPropertyValue('background-color'),
      soldColor: getComputedStyle(sold).getPropertyValue('color'),
      h1: h1 ? getComputedStyle(h1).getPropertyValue('font-size') : 'none',
      heroDisplay: hero ? getComputedStyle(hero).getPropertyValue('display') : 'none',
    };
    sold.remove();
    delete document.documentElement.dataset.theme;
    return out;
  });
  // PR2 移植后：深色售罄统一为 PR2 配色（.28 / #ff9d97），取代 PR3 的 .20 / #ff9d99。
  check('P2-12: 深色售罄按钮背景与文字', s.soldBg === 'rgba(255, 69, 58, 0.28)' && s.soldColor === 'rgb(255, 157, 151)', JSON.stringify(s));
  check('P2-12: Hero 布局与标题字号（1440）', s.h1 === '52px' && s.heroDisplay === 'flex', JSON.stringify(s));
}
for (const w of [390, 360]) {
  await page.setViewportSize({ width: w, height: 844 });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const h = await page.evaluate(() => {
    const h1 = document.querySelector('.home-h1');
    const title = document.querySelector('.home-section-title');
    const chip = document.querySelector('.home-chip');
    return {
      h1: h1 ? getComputedStyle(h1).getPropertyValue('font-size') : 'none',
      titleOneLine: title ? title.scrollWidth <= title.clientWidth + 2 : false,
      chip: chip ? getComputedStyle(chip).getPropertyValue('font-size') : 'none',
    };
  });
  // PR2 移植后：移动端 Hero 标题 10px（与缩放卡内“智选”渲染约 9.6px 统一，用户确认），取代移植前 36px。
  check(`P2-12: Hero 标题字号 ${w}`, h.h1 === '10px', JSON.stringify(h));
  check(`P2-12: 合集标题 ${w} 一行`, h.titleOneLine === true, JSON.stringify(h));
  // PR2 移植后：芯片不再手调移动端字号，取桌面基础 13px（视觉上由 scale(0.37) 缩小），取代移植前移动端覆盖 12px。
  check(`P2-12: 浮动卡片字号 ${w}`, h.chip === '13px', JSON.stringify(h));
}
{
  const c = await page.evaluate(async () => {
    const mk = (uid, ms) => payBlockHTML({ actual_amount: 10, total_usdt: 10, order_no: uid, pay_method: 'OKX', pay_chain: 'X Layer', pay_address: '0x1111111111111111111111111111111111111111', expires_at: new Date(Date.now() + ms).toISOString() }, uid);
    const wrap = document.createElement('div'); wrap.innerHTML = mk('b-cd', 90000); document.body.appendChild(wrap);
    const t0 = document.getElementById('countdown-b-cd').textContent;
    startCountdown();
    await new Promise((r) => setTimeout(r, 1300));
    const t1 = document.getElementById('countdown-b-cd').textContent;
    const past = document.createElement('div');
    past.innerHTML = payBlockHTML({ actual_amount: 1, total_usdt: 1, order_no: 'b-past', pay_method: 'OKX', pay_chain: 'X Layer', pay_address: '0x1111111111111111111111111111111111111111', expires_at: '2000-01-01T00:00:00Z' }, 'b-past');
    document.body.appendChild(past);
    startCountdown();
    await new Promise((r) => setTimeout(r, 150));
    const pastText = document.getElementById('countdown-b-past').textContent;
    const pastBox = document.getElementById('deadline-b-past');
    wrap.remove(); past.remove(); stopCountdown();
    return { t0, t1, pastText, pastExpired: !!(pastBox && pastBox.classList.contains('pay-deadline-expired')) };
  });
  check('P2-12: 付款块倒计时每秒更新', c.t0 !== c.t1, JSON.stringify(c));
  check('P2-12: 付款块到期变红', c.pastText === '已过期，请重新下单' && c.pastExpired, JSON.stringify(c));
}
{
  const a = await page.evaluate(() => {
    APP_ICONS = { 'b-icon': { light: 'data:image/png;base64,TElHSFQ=', dark: 'data:image/png;base64,REFSSw==' } };
    document.documentElement.dataset.theme = 'light';
    const holder = document.createElement('div');
    holder.innerHTML = productImgHtml({ app_icon_key: 'b-icon' }, 'prod-img', 'prod-img prod-emoji');
    document.body.appendChild(holder);
    const img = holder.querySelector('img[data-app-icon]');
    const lightSrc = img ? img.getAttribute('src') : '';
    const containerBg = img ? getComputedStyle(img).getPropertyValue('background-color') : 'none';
    document.documentElement.dataset.theme = 'dark';
    refreshAppIcons();
    const darkSrc = img ? img.getAttribute('src') : '';
    holder.remove();
    delete document.documentElement.dataset.theme;
    return { lightSrc, darkSrc, containerBg };
  });
  check('P2-12: App 图标真实 src 随主题切换', a.lightSrc === 'data:image/png;base64,TElHSFQ=' && a.darkSrc === 'data:image/png;base64,REFSSw==', JSON.stringify(a));
  check('P2-12: App 图标容器背景', a.containerBg === 'rgb(255, 255, 255)', JSON.stringify(a));
}
{
  const pb = await page.evaluate(() => {
    const base = { total_usdt: 5, actual_amount: 5, order_no: 'B-PAY', pay_method: 'OKX', pay_chain: 'X Layer', expires_at: new Date(Date.now() + 600000).toISOString() };
    const empty = document.createElement('div'); empty.innerHTML = payBlockHTML(Object.assign({}, base, { pay_address: '' }), 'b-empty');
    const good = document.createElement('div'); good.innerHTML = payBlockHTML(Object.assign({}, base, { pay_address: '0x1111111111111111111111111111111111111111' }), 'b-good');
    return {
      emptyHidden: !empty.querySelector('#addrBox-b-empty') && !empty.querySelector('.pay-qr img') && empty.innerHTML.includes('付款已暂停'),
      goodShown: !!good.querySelector('#addrBox-b-good') && !!good.querySelector('.pay-qr img') && !!good.querySelector('[data-copy-target="addrBox-b-good"]'),
    };
  });
  check('P2-12: 空地址隐藏地址盒/二维码并显暂停', pb.emptyHidden === true, JSON.stringify(pb));
  check('P2-12: 正常地址显地址盒/二维码/复制', pb.goodShown === true, JSON.stringify(pb));
}

// 本地 QR：解码结果 == pay_address；明文地址一并展示
{
  const qr = await page.evaluate(() => {
    const addr = '0x2222222222222222222222222222222222222222';
    const url = payQrDataUrl(addr);
    if (!url || url.indexOf('data:image/') !== 0) return { ok: false, reason: 'no-data-url' };
    const lib = payQrLib();
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = function () {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth || img.width;
          c.height = img.naturalHeight || img.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const id = ctx.getImageData(0, 0, c.width, c.height);
          const decoded = lib.decodeQR({ data: id.data, width: c.width, height: c.height });
          const box = document.createElement('div');
          box.innerHTML = payBlockHTML({ actual_amount: 2, total_usdt: 2, order_no: 'CI-QR', pay_method: 'Binance', pay_chain: 'BEP20', pay_address: addr, expires_at: new Date(Date.now() + 600000).toISOString() }, 'ciqr');
          const plain = ((box.querySelector('#addrBox-ciqr') || {}).textContent || '').replace(/\s/g, '');
          resolve({ ok: decoded === addr, decoded, plainHas: plain.indexOf(addr) !== -1, dataQr: !!box.querySelector('img[data-pay-qr="ok"]') });
        } catch (e) { resolve({ ok: false, reason: String(e && e.message || e) }); }
      };
      img.onerror = () => resolve({ ok: false, reason: 'img-error' });
      img.src = url;
    });
  });
  check('local-qr: decode === pay_address', qr && qr.ok === true, JSON.stringify(qr));
  check('local-qr: plaintext address visible', qr && qr.plainHas === true, JSON.stringify(qr));
}

{
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '/#/product/1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const al = await page.evaluate(() => {
    const input = document.getElementById('contact');
    const r = input ? input.getBoundingClientRect() : null;
    showModal({ title: '对齐检查', bodyHTML: '<p>x</p>', confirmText: 'OK' });
    const m = document.querySelector('.modal');
    const mr = m ? m.getBoundingClientRect() : null;
    closeModal();
    return { inputIn: !!r && r.left >= 0 && r.right <= 390, modalIn: !!mr && mr.left >= 4 && mr.right <= 386 };
  });
  check('P2-12: 手机端输入框与弹窗对齐', al.inputIn === true && al.modalIn === true, JSON.stringify(al));
  await page.setViewportSize({ width: 1440, height: 900 });
}
{
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const ts = await page.evaluate(() => {
    window.turnstile = { render: (el, opts) => { window._tsOpts = window._tsOpts || {}; window._tsOpts[el.getAttribute('data-ts-scope')] = opts; return 'widget-' + el.getAttribute('data-ts-scope'); }, reset: () => {} };
    CFG = Object.assign({}, CFG, { turnstile_enabled: true, turnstile_site_key: 'test-site-key' });
    const holder = document.createElement('div');
    holder.innerHTML = turnstileBoxHTML('pay-AIS-A') + turnstileBoxHTML('pay-AIS-B');
    document.body.appendChild(holder);
    renderTurnstileWidgets();
    window._tsOpts['pay-AIS-A'].callback('tok-A');
    window._tsOpts['pay-AIS-B'].callback('tok-B');
    const ok = tsToken('pay-AIS-A') === 'tok-A' && tsToken('pay-AIS-B') === 'tok-B';
    holder.remove();
    return { ok };
  });
  check('P2-12: TXID 多订单 Turnstile Token 独立', ts.ok === true, JSON.stringify(ts));
  let captured = null;
  await page.route('**/api/orders/*/pay', async (route) => {
    try { captured = JSON.parse(route.request().postData() || '{}'); } catch (_) { captured = null; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, message: 'TXID 已提交' }) });
  });
  await page.evaluate(async () => {
    CFG = Object.assign({}, CFG, { turnstile_enabled: false, turnstile_site_key: '' });
    document.body.insertAdjacentHTML('beforeend', '<input id="txid" value="  BHASH123  "><input id="payCaptchaCode" value="ABCD"><img id="payCaptchaImg">');
    window._payCaptchaId = 'cap-b';
    await submitTxid('AIS-B-1');
  });
  await page.waitForTimeout(300);
  check('P2-12: TXID 提交用 trim 后串', captured && captured.txid === 'BHASH123', JSON.stringify(captured));
  await page.unrouteAll({ behavior: 'wait' });
}
{
  await page.goto(BASE + '/#/product/1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  let orderCalls = 0;
  await page.route('**/api/orders', async (route) => { if (route.request().method() === 'POST') orderCalls++; await route.abort(); });
  await page.evaluate(() => {
    let req = document.querySelector('[data-required]');
    if (!req) { const first = document.querySelector('[data-k]'); if (first) { first.setAttribute('data-required', '1'); req = first; } }
    if (req) req.value = '   ';
    const btn = document.querySelector('[data-pid]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(800);
  check('P2-12: 必填未填时网络层无下单请求', orderCalls === 0, 'orderCalls=' + orderCalls);
  await page.unrouteAll({ behavior: 'wait' });
}

// ===== 8. 控制台无 JS 错误 =====
check('no JS console errors', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

await browser.close();
console.log('\nBROWSER ACCEPTANCE DONE pass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
