// 前端审查修复测试（review-findings-2026-10-18，前端部分）：真实 Playwright Chromium + 本地 wrangler dev。
// 规则：UI 结论一律用计算样式 / 真实 DOM / 模拟交互断言；字符串断言只用于业务条件/配置。
// 不访问真实上游/链上；Turnstile 用本地 stub 模拟 render/token 回调；不使用真实 Turnstile 密钥。
// 运行前需 wrangler dev 已启动（与 browser-acceptance-ci.mjs 同款 BASE）。测试用一次性测试值。
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
    try { const r = await fetch(BASE + '/api/config'); if (r.ok) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
if (!(await waitForServer())) { console.error('FAIL: dev server not reachable at ' + BASE); process.exit(1); }

// ===== 0. 前置：管理员密码（复用 CI 约定；若为全新库则 admin 改密为 review-admin-123）=====
let ADMIN_PW = '';
{
  const jar = [];
  async function api(method, path, body, cookie) {
    const headers = { 'content-type': 'application/json', 'X-Admin-API': '1' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) jar.push(sc.split(';')[0]);
    let j = null; try { j = await res.json(); } catch (_) {}
    return { status: res.status, json: j, cookie: jar[jar.length - 1] || '' };
  }
  let ck = '';
  const tryLogin = async (pw) => {
    const r = await api('POST', '/api/admin/login', { password: pw });
    if (r.json && r.json.ok) { ck = r.cookie; return true; }
    return false;
  };
  if (await tryLogin('browser-ci-admin-123')) ADMIN_PW = 'browser-ci-admin-123';
  else if (await tryLogin('review-admin-123')) ADMIN_PW = 'review-admin-123';
  else {
    // B-P0: new DB first login uses setup token (runner injects via ZHIXUAN_SETUP_TOKEN); no public default password.
    const setupToken = process.env.ZHIXUAN_SETUP_TOKEN || '';
    if (setupToken) {
      const r = await api('POST', '/api/admin/login', { setup_token: setupToken });
      if (r.json && r.json.ok) {
        ck = r.cookie;
        const chg = await api('POST', '/api/admin/change-password', { old_password: '', new_password: 'review-admin-123' }, ck);
        if (chg.json && chg.json.ok) ADMIN_PW = 'review-admin-123';
      }
    }
  }
if (!ADMIN_PW) { console.error('FATAL: admin setup failed (tried browser-ci-admin-123 / review-admin-123 / setup token)'); process.exit(1); }
  // 收款地址（下单/支付块渲染需要有效地址）
  await api('POST', '/api/admin/settings', { settings: { usdt_addresses: JSON.stringify({ 'OKX|X Layer': '0x1111111111111111111111111111111111111111', 'Binance|BEP20': '0x2222222222222222222222222222222222222222' }) } }, ck);
  // 卡密测试：找一个可导入卡密的商品，否则新建一个一次性测试商品；导入一条已知掩码测试卡密。
  let cardPid = null;
  const prods = await api('GET', '/api/admin/products?page_size=100', undefined, ck);
  const list = (prods.json && prods.json.products) || [];
  const elig = list.find((p) => p.stock_type === 'card' || p.category === 'card' || p.category === 'account');
  if (elig) cardPid = elig.id;
  else {
    const created = await api('POST', '/api/admin/products', { title: 'REVIEW-TEST-CARD-PRODUCT', category: 'card', sell_price: 1, cost_price: 0, stock_type: 'card', description: 'review test only', form_fields: [], image_emoji: 'box', is_active: 1, in_stock: 1 }, ck);
    if (created.json && created.json.ok && created.json.product) cardPid = created.json.product.id;
    else if (created.json && created.json.id) cardPid = created.json.id;
  }
  if (cardPid) {
    await api('POST', '/api/admin/cards/import', { product_id: cardPid, codes: 'REVIEW-TEST-CODE-12345' }, ck);
  }
  console.log('SETUP: admin ready, cardPid=' + cardPid);
}

// 注意：同 URL 的 goto 只触发 hash 变化、不重载页面，页内 CFG 改动会泄漏到下一个测试；
// 需要新鲜 JS/CFG 的用例一律走 gotoFresh（goto 后强制 reload）。
async function gotoFresh(pg, url) {
  await pg.goto(url, { waitUntil: 'networkidle' });
  await pg.reload({ waitUntil: 'networkidle' });
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push('pageerror: ' + String(e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  if (text.includes('ERR_TUNNEL_CONNECTION_FAILED')) return;
  if (text.includes('favicon.ico')) return;
  // 预期内的错误响应：401（退出/会话过期恢复）与 404（reveal 接口未就绪模拟），与 CI 过滤口径一致。
  if (text.includes('401')) return;
  if (text.includes('404')) return;
  jsErrors.push(text);
});

// ===== 1. P3-19 fmtCountdown 日期解析 =====
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const cd = await page.evaluate(() => {
  function withOffset(ms, offH) {
    const d = new Date(ms + offH * 3600e3);
    const p = (n) => String(n).padStart(2, '0');
    const sign = offH >= 0 ? '+' : '-';
    const a = Math.abs(offH);
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + 'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + sign + p(a) + ':00';
  }
  const future = Date.now() + 65000;
  const z = new Date(future).toISOString();
  const plus8 = withOffset(future, 8);
  const minus7 = withOffset(future, -7);
  const toSec = (s) => { const m = /^(\d+):(\d{2}):(\d{2})$/.exec(s); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : -1; };
  return {
    z: fmtCountdown(z),
    zSec: toSec(fmtCountdown(z)),
    plus8: fmtCountdown(plus8),
    plus8Sec: toSec(fmtCountdown(plus8)),
    minus7: fmtCountdown(minus7),
    minus7Sec: toSec(fmtCountdown(minus7)),
    noTzEq: fmtCountdown('2099-01-01 00:00:00') === fmtCountdown('2099-01-01T00:00:00Z'),
    expired: fmtCountdown('2000-01-01T00:00:00Z'),
    invalid: fmtCountdown('not-a-date'),
    absInvalid: fmtExpiryAbsolute('not-a-date'),
    absOk: fmtExpiryAbsolute('2099-01-01T00:00:00Z').length > 0,
  };
});
check('P3-19: +08:00 与 Z 同一时刻倒计时一致（±1 秒边界容差）', Math.abs(cd.zSec - cd.plus8Sec) <= 1, JSON.stringify(cd));
check('P3-19: -07:00 与 Z 同一时刻倒计时一致（±1 秒边界容差）', Math.abs(cd.zSec - cd.minus7Sec) <= 1, JSON.stringify(cd));
check('P3-19: 无时区按 UTC 解析（与 Z 相等）', cd.noTzEq === true, JSON.stringify(cd));
check('P3-19: 已过期显示过期文案', cd.expired === '已过期，请重新下单', cd.expired);
check('P3-19: 非法日期显示安全错误态而非 NaN', cd.invalid === '时间格式错误' && !cd.invalid.includes('NaN'), cd.invalid);
check('P3-19: 非法日期绝对时间为空', cd.absInvalid === '' && cd.absOk, JSON.stringify(cd));

// ===== 2. P1-4 统一倒计时：多订单各显各的时间、每秒更新、到期变红 =====
const cd2 = await page.evaluate(async () => {
  const mk = (uid, ms) => {
    const o = { actual_amount: 10, total_usdt: 10, order_no: uid, pay_method: 'OKX', pay_chain: 'X Layer', pay_address: '0x1111111111111111111111111111111111111111', expires_at: new Date(Date.now() + ms).toISOString() };
    return payBlockHTML(o, uid);
  };
  const wrap = document.createElement('div');
  wrap.innerHTML = mk('cd-a', 90000) + mk('cd-b', 3661000);
  document.body.appendChild(wrap);
  const t0a = document.getElementById('countdown-cd-a').textContent;
  const t0b = document.getElementById('countdown-cd-b').textContent;
  const hasDataExpires = !!document.getElementById('countdown-cd-a').getAttribute('data-expires');
  startCountdown();
  await new Promise((r) => setTimeout(r, 1300));
  const t1a = document.getElementById('countdown-cd-a').textContent;
  const past = document.createElement('div');
  past.innerHTML = payBlockHTML({ actual_amount: 1, total_usdt: 1, order_no: 'cd-past', pay_method: 'OKX', pay_chain: 'X Layer', pay_address: '0x1111111111111111111111111111111111111111', expires_at: '2000-01-01T00:00:00Z' }, 'cd-past');
  document.body.appendChild(past);
  startCountdown();
  await new Promise((r) => setTimeout(r, 150));
  const pastText = document.getElementById('countdown-cd-past').textContent;
  const pastBox = document.getElementById('deadline-cd-past');
  wrap.remove(); past.remove(); stopCountdown();
  return { t0a, t0b, t1a, hasDataExpires, pastText, pastExpiredClass: !!(pastBox && pastBox.classList.contains('pay-deadline-expired')) };
});
check('P1-4: 倒计时节点带 data-expires', cd2.hasDataExpires === true, JSON.stringify(cd2));
check('P1-4: 多订单各显各的时间', cd2.t0a !== cd2.t0b && cd2.t0a.includes('01:') && cd2.t0b.includes('1:'), JSON.stringify(cd2));
check('P1-4: 倒计时每秒更新', cd2.t0a !== cd2.t1a, JSON.stringify(cd2));
check('P1-4: 到期变红 + 过期文案', cd2.pastText === '已过期，请重新下单' && cd2.pastExpiredClass, JSON.stringify(cd2));

// ===== 3. P1-3 Turnstile：本地 stub、多订单独立 Token、fail-closed =====
const ts = await page.evaluate(() => {
  const calls = [];
  window.turnstile = {
    render: (el, opts) => { calls.push(el.getAttribute('data-ts-scope')); window._tsOpts = window._tsOpts || {}; window._tsOpts[el.getAttribute('data-ts-scope')] = opts; return 'widget-' + el.getAttribute('data-ts-scope'); },
    reset: (wid) => { calls.push('reset:' + wid); },
  };
  CFG = Object.assign({}, CFG, { turnstile_enabled: true, turnstile_site_key: 'test-site-key' });
  const holder = document.createElement('div');
  holder.innerHTML = turnstileBoxHTML('order') + turnstileBoxHTML('pay-AIS-1') + turnstileBoxHTML('pay-AIS-2');
  document.body.appendChild(holder);
  renderTurnstileWidgets();
  const firstRenderCount = calls.length;
  renderTurnstileWidgets();
  const secondRenderCount = calls.length;
  window._tsOpts['pay-AIS-1'].callback('tok-A');
  window._tsOpts['pay-AIS-2'].callback('tok-B');
  window._tsOpts['order'].callback('tok-O');
  const before = { a: tsToken('pay-AIS-1'), b: tsToken('pay-AIS-2'), o: tsToken('order') };
  resetTurnstile('pay-AIS-1');
  const after = { a: tsToken('pay-AIS-1'), b: tsToken('pay-AIS-2') };
  // fail-closed：开启但 Site Key 缺失
  CFG = Object.assign({}, CFG, { turnstile_enabled: true, turnstile_site_key: '' });
  const fcHtml = turnstileBoxHTML('order');
  const fc = { failClosed: tsFailClosed(), htmlHasWarn: fcHtml.includes('未配置'), htmlHasSlot: fcHtml.includes('turnstile-slot') };
  holder.remove();
  return { firstRenderCount, secondRenderCount, before, after, resetCalled: calls.includes('reset:widget-pay-AIS-1'), fc };
});
check('P1-3: 三个 Widget 各自显式 render', ts.firstRenderCount === 3, JSON.stringify(ts));
check('P1-3: 重复渲染不新建多个 Widget', ts.secondRenderCount === 3, JSON.stringify(ts));
check('P1-3: 多订单 Token 独立隔离', ts.before.a === 'tok-A' && ts.before.b === 'tok-B' && ts.before.o === 'tok-O', JSON.stringify(ts));
check('P1-3: reset 只清本订单 Token、不动他单', ts.after.a === '' && ts.after.b === 'tok-B' && ts.resetCalled, JSON.stringify(ts));
check('P1-3: 开启但 Site Key 缺失时 fail-closed（提示、无 Slot）', ts.fc.failClosed && ts.fc.htmlHasWarn && !ts.fc.htmlHasSlot, JSON.stringify(ts));

// ===== 4. P3-18 TXID trim + P2-8 成功清空/刷新 + P1-3 Token 随请求 + 失败清 Token =====
{
  let captured = null; let payCalls = 0;
  await page.route('**/api/orders/*/pay', async (route) => {
    payCalls++;
    try { captured = JSON.parse(route.request().postData() || '{}'); } catch (_) { captured = null; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, message: 'TXID 已提交' }) });
  });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const r1 = await page.evaluate(async () => {
    CFG = Object.assign({}, CFG, { turnstile_enabled: false, turnstile_site_key: '' });
    document.body.insertAdjacentHTML('beforeend', '<input id="txid" value="  ABC123xyz  "><input id="payCaptchaCode" value="ABCD"><img id="payCaptchaImg">');
    window._payCaptchaId = 'cap-before';
    const beforeCap = window._payCaptchaId;
    await submitTxid('AIS-TEST-9');
    await new Promise((r) => setTimeout(r, 400));
    const txCleared = document.getElementById('txid').value === '';
    const capCleared = document.getElementById('payCaptchaCode').value === '';
    const capRefreshed = window._payCaptchaId !== beforeCap;
    const toast = (document.querySelector('.toast') || {}).textContent || '';
    return { txCleared, capCleared, capRefreshed, toast };
  });
  check('P3-18: TXID 载荷用 trim 后规范化串', captured && captured.txid === 'ABC123xyz', JSON.stringify(captured));
  check('P2-8: TXID 成功后清空输入', r1.txCleared === true, JSON.stringify(r1));
  check('P2-8: TXID 成功后清已消费验证码并加载新验证码', r1.capCleared === true && r1.capRefreshed === true, JSON.stringify(r1));
  // 仅空格 / 过短不发请求
  const beforeCalls = payCalls;
  await page.evaluate(async () => {
    document.getElementById('txid').value = '   ';
    await submitTxid('AIS-TEST-9');
    document.getElementById('txid').value = 'ab';
    await submitTxid('AIS-TEST-9');
  });
  await page.waitForTimeout(300);
  check('P3-18: 仅空格/过短 TXID 不发请求', payCalls === beforeCalls, 'calls=' + payCalls + ' before=' + beforeCalls);
  // Turnstile Token 随请求提交，成功后清 Token
  const r2 = await page.evaluate(async () => {
    CFG = Object.assign({}, CFG, { turnstile_enabled: true, turnstile_site_key: 'test-site-key' });
    TS.tokens['pay-AIS-TS1'] = 'tok-xyz';
    document.getElementById('txid').value = 'TSHASH123';
    await submitTxid('AIS-TS1');
    return { tokenAfter: tsToken('pay-AIS-TS1') };
  });
  check('P1-3: TXID 提交携带本次订单 Token', captured && captured.turnstile_token === 'tok-xyz', JSON.stringify(captured));
  check('P2-8: Turnstile 成功后 Token 重置', r2.tokenAfter === '', JSON.stringify(r2));
  // 失败清 Token
  await page.unrouteAll({ behavior: 'wait' });
  await page.route('**/api/orders/*/pay', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '反机器人验证失败，请刷新后重试' }) });
  });
  const r3 = await page.evaluate(async () => {
    CFG = Object.assign({}, CFG, { turnstile_enabled: true, turnstile_site_key: 'test-site-key' });
    TS.tokens['pay-AIS-TS2'] = 'tok-bad';
    document.getElementById('txid').value = 'FAILHASH1';
    await submitTxid('AIS-TS2');
    return { tokenAfter: tsToken('pay-AIS-TS2') };
  });
  check('P2-9: 验证失败后清失效 Token', r3.tokenAfter === '', JSON.stringify(r3));
  await page.unrouteAll({ behavior: 'wait' });
  // fail-closed 时 submitTxid 不发请求
  let fcCalls = 0;
  await page.route('**/api/orders/*/pay', async (route) => { fcCalls++; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); });
  await page.evaluate(async () => {
    CFG = Object.assign({}, CFG, { turnstile_enabled: true, turnstile_site_key: '' });
    document.getElementById('txid').value = 'FCHASH123';
    await submitTxid('AIS-FC1');
  });
  await page.waitForTimeout(300);
  check('P1-3: 配置缺失 fail-closed 时不发请求', fcCalls === 0, 'fcCalls=' + fcCalls);
  await page.unrouteAll({ behavior: 'wait' });
}

// ===== 5. P1-5 必填未填时网络层无下单请求 =====
{
  await gotoFresh(page, BASE + '/#/product/1');
  await page.waitForTimeout(1000);
  let orderCalls = 0;
  await page.route('**/api/orders', async (route) => {
    if (route.request().method() === 'POST') { orderCalls++; }
    await route.abort();
  });
  const r = await page.evaluate(() => {
    let req = document.querySelector('[data-required]');
    let injected = false;
    if (!req) {
      const first = document.querySelector('[data-k]');
      if (first) { first.setAttribute('data-required', '1'); first.setAttribute('data-label', first.getAttribute('data-label') || '测试字段'); req = first; injected = true; }
    }
    if (req) req.value = '   ';
    const btn = document.querySelector('[data-pid]');
    if (btn) btn.click();
    return { hasRequired: !!req, injected };
  });
  await page.waitForTimeout(800);
  const toastText = await page.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
  check('P1-5: 必填全空格时无下单请求', r.hasRequired && orderCalls === 0, 'orderCalls=' + orderCalls + ' toast=' + toastText + ' injected=' + r.injected);
  check('P1-5: 必填未填时提示字段', toastText.includes('请填写'), 'toast=' + toastText);
  await page.unrouteAll({ behavior: 'wait' });
}

// ===== 6. P2-10 数量钳 + 激活邮箱校验（模拟交互，拦截 /api/orders）=====
{
  await gotoFresh(page, BASE + '/#/product/1');
  await page.waitForTimeout(1000);
  const qty = await page.evaluate(() => {
    const q = document.getElementById('qty');
    q.value = '0'; const a = clampQty();
    q.value = '250'; const b = clampQty();
    q.value = '5'; const c = clampQty();
    return { a, b, c, el: q.value };
  });
  check('P2-10: 数量越界钳到 1–99', qty.a === 1 && qty.b === 99 && qty.c === 5 && qty.el === '5', JSON.stringify(qty));
  let orderCalls = 0;
  await page.route('**/api/orders', async (route) => {
    if (route.request().method() === 'POST') {
      orderCalls++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, order: { order_no: 'AIS-TEST-X', total_usdt: 1, actual_amount: 1, pay_address: '0x1111111111111111111111111111111111111111', expires_at: new Date(Date.now() + 600000).toISOString(), pay_method: 'OKX', pay_chain: 'X Layer', has_query_password: 1 } }) });
    } else await route.continue();
  });
  const act = await page.evaluate(async () => {
    window._curProduct = Object.assign({}, window._curProduct, { requires_email_activation: 1 });
    // 多邮箱（P-2 第二步）后数量 >1 会按件渲染邮箱输入；本用例只测单件路径，先把数量还原为 1。
    { const qe = document.getElementById('qty'); if (qe) qe.value = '1'; }
    document.querySelectorAll('[data-k]').forEach((el) => { el.value = 'filled@test.example'; });
    const contact = document.getElementById('contact'); if (contact) contact.value = 'buyer@test.example';
    const qp = document.getElementById('query_password'); if (qp) qp.value = 'testpw123';
    const cap = document.getElementById('captchaCode'); if (cap) cap.value = 'ABCD';
    window._captchaId = 'cap-x';
    document.body.insertAdjacentHTML('beforeend', '<input id="activation_email"><input id="activation_email_confirm"><input type="checkbox" id="activation_confirm">');
    const run = async () => { await submitOrder(1); await new Promise((r) => setTimeout(r, 200)); };
    // 格式错误
    document.getElementById('activation_email').value = 'not-an-email';
    document.getElementById('activation_email_confirm').value = 'not-an-email';
    document.getElementById('activation_confirm').checked = true;
    await run();
    // 不一致
    document.getElementById('activation_email').value = 'a@test.example';
    document.getElementById('activation_email_confirm').value = 'b@test.example';
    await run();
    // 未勾选
    document.getElementById('activation_email').value = 'a@test.example';
    document.getElementById('activation_email_confirm').value = 'a@test.example';
    document.getElementById('activation_confirm').checked = false;
    await run();
    // 合法 + 勾选：出现确认弹窗，点确认后提交
    document.getElementById('activation_confirm').checked = true;
    const p = submitOrder(1);
    await new Promise((r) => setTimeout(r, 400));
    const modalShown = !!document.getElementById('modalConfirm');
    if (modalShown) document.getElementById('modalConfirm').click();
    await p;
    await new Promise((r) => setTimeout(r, 300));
    return { modalShown };
  });
  await page.waitForTimeout(300);
  check('P2-10: 激活邮箱格式/不一致/未勾选均不提交', orderCalls === 1, 'orderCalls=' + orderCalls);
  check('P2-10: 合法激活邮箱出现确认弹窗并提交', act.modalShown === true, JSON.stringify(act));
  await page.unrouteAll({ behavior: 'wait' });
}

// ===== 6b. 多邮箱 qty=3 提交 + 改数量复位确认勾选（拦截 /api/orders）=====
{
  await gotoFresh(page, BASE + '/#/product/1');
  await page.waitForTimeout(1000);
  let captured = null;
  await page.route('**/api/orders', async (route) => {
    if (route.request().method() === 'POST') {
      try { captured = JSON.parse(route.request().postData() || '{}'); } catch (e) { captured = { parseError: true }; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, order: { order_no: 'AIS-TEST-Q3', total_usdt: 3, actual_amount: 3, pay_address: '0x1111111111111111111111111111111111111111', expires_at: new Date(Date.now() + 600000).toISOString(), pay_method: 'OKX', pay_chain: 'X Layer', has_query_password: 1 } }) });
    } else await route.continue();
  });
  const m = await page.evaluate(async () => {
    window._curProduct = Object.assign({}, window._curProduct, { requires_email_activation: 1 });
    if (!document.getElementById('activation_email')) document.body.insertAdjacentHTML('beforeend', '<label>a</label><input id="activation_email"><label>b</label><input id="activation_email_confirm"><div id="actMultiBox"></div><input type="checkbox" id="activation_confirm">');
    const q = document.getElementById('qty');
    q.value = '1'; updateTotal();
    // 改数量复位勾选：先勾选，再 +1 / 改输入，均应取消勾选
    const cb = document.getElementById('activation_confirm');
    cb.checked = true; changeQty(1);
    const uncheckedByBtn = cb.checked === false;
    cb.checked = true; q.value = '3'; q.dispatchEvent(new Event('input')); 
    const uncheckedByInput = cb.checked === false;
    cb.checked = true; updateTotal();
    const keptWhenSame = cb.checked === true;
    const pairs = document.querySelectorAll('[data-act-t="e"]').length;
    const emails = ['one@test.example', 'two@test.example', 'one@test.example'];
    emails.forEach((e, i) => {
      document.querySelector('[data-act-t="e"][data-act-i="' + i + '"]').value = e;
      document.querySelector('[data-act-t="c"][data-act-i="' + i + '"]').value = e;
    });
    document.querySelectorAll('[data-k]').forEach((el) => { el.value = 'filled@test.example'; });
    const contact = document.getElementById('contact'); if (contact) contact.value = 'buyer@test.example';
    const qp = document.getElementById('query_password'); if (qp) qp.value = 'testpw123';
    const cap = document.getElementById('captchaCode'); if (cap) cap.value = 'ABCD';
    window._captchaId = 'cap-x';
    cb.checked = true;
    const p = submitOrder(1);
    await new Promise((r) => setTimeout(r, 400));
    const modalShown = !!document.getElementById('modalConfirm');
    if (modalShown) document.getElementById('modalConfirm').click();
    await p;
    await new Promise((r) => setTimeout(r, 300));
    return { uncheckedByBtn, uncheckedByInput, keptWhenSame, pairs, modalShown };
  });
  await page.waitForTimeout(300);
  const cf = (captured && captured.customer_fields) || {};
  check('Q3: 改数量（按钮）取消确认勾选', m.uncheckedByBtn === true, JSON.stringify(m));
  check('Q3: 改数量（输入框）取消确认勾选', m.uncheckedByInput === true, JSON.stringify(m));
  check('Q3: 数量未变不误取消勾选', m.keptWhenSame === true, JSON.stringify(m));
  check('Q3: qty=3 渲染 3 对激活邮箱输入', m.pairs === 3, JSON.stringify(m));
  check('Q3: qty=3 请求 quantity=3', captured && captured.quantity === 3, JSON.stringify(captured));
  check('Q3: activation_emails 长度 3（允许重复）', Array.isArray(cf.activation_emails) && cf.activation_emails.length === 3 && cf.activation_emails[0] === cf.activation_emails[2], JSON.stringify(cf));
  check('Q3: activation_emails_confirm 与 activation_emails 逐项相等', JSON.stringify(cf.activation_emails_confirm) === JSON.stringify(cf.activation_emails), JSON.stringify(cf));
  check('Q3: customer_fields.activation_confirm === true', cf.activation_confirm === true, JSON.stringify(cf));
  await page.unrouteAll({ behavior: 'wait' });
}

// ===== 7. P2-5/P2-12 深色模式计算样式 =====
{
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const dark = await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    const mk = (tag, cls) => { const e = document.createElement(tag); e.className = cls; document.body.appendChild(e); return e; };
    const img = mk('div', 'pcard-img');
    const sold = mk('button', 'pcard-btn pcard-btn-soldout');
    const cap = mk('img', 'captcha-img');
    const cs = (e, prop) => getComputedStyle(e).getPropertyValue(prop);
    const out = { imgBg: cs(img, 'background-color'), soldBg: cs(sold, 'background-color'), soldColor: cs(sold, 'color'), capBg: cs(cap, 'background-color') };
    img.remove(); sold.remove(); cap.remove();
    return out;
  });
  check('P2-5: 手动深色 .pcard-img 容器底色', dark.imgBg === 'rgb(28, 28, 30)', dark.imgBg);
  // PR2 移植后：深色售罄统一为 PR2 配色（.28 / #ff9d97），取代 PR3 的 .20 / #ff9d99。
  check('P2-12: 深色售罄按钮背景与文字', dark.soldBg === 'rgba(255, 69, 58, 0.28)' && dark.soldColor === 'rgb(255, 157, 151)', JSON.stringify(dark));
  check('P3-20: 深色验证码背景协调', dark.capBg === 'rgb(44, 44, 46)', dark.capBg);
  // 跟随系统深色
  await page.evaluate(() => { delete document.documentElement.dataset.theme; try { localStorage.removeItem('theme'); } catch (_) {} });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const sys = await page.evaluate(() => {
    const img = document.querySelector('.pcard-img');
    const accent = document.querySelector('.home-h1-accent');
    return { imgBg: img ? getComputedStyle(img).getPropertyValue('background-color') : 'none', accent: accent ? getComputedStyle(accent).getPropertyValue('color') : 'none' };
  });
  check('P2-5: 跟随系统深色图片容器底色', sys.imgBg === 'rgb(28, 28, 30)', JSON.stringify(sys));
  check('P2-5: 跟随系统深色 Hero 强调色', sys.accent === 'rgb(142, 166, 255)', JSON.stringify(sys));
  await page.emulateMedia({ colorScheme: 'light' });
  // 浅色不受影响
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const light = await page.evaluate(() => {
    const img = document.querySelector('.pcard-img');
    return { imgBg: img ? getComputedStyle(img).getPropertyValue('background-color') : 'none' };
  });
  check('P2-5: 浅色图片容器底色不变', light.imgBg === 'rgb(255, 255, 255)', JSON.stringify(light));
}

// ===== 8. P2-12/P3-14 Hero 与合集标题（390/360）=====
for (const w of [390, 360]) {
  await page.setViewportSize({ width: w, height: 844 });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const hero = await page.evaluate(() => {
    const h1 = document.querySelector('.home-h1');
    const chip = document.querySelector('.home-chip');
    const title = document.querySelector('.home-section-title');
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return {
      h1: h1 ? getComputedStyle(h1).getPropertyValue('font-size') : 'none',
      chip: chip ? getComputedStyle(chip).getPropertyValue('font-size') : 'none',
      chipTrunc: chip ? chip.scrollWidth <= chip.clientWidth + 1 : false,
      titleOneLine: title ? title.scrollWidth <= title.clientWidth + 2 : false,
      overflow,
    };
  });
  // PR2 移植后：移动端 Hero 标题 10px（与缩放卡内“智选”渲染约 9.6px 统一，用户确认），取代 PR3 冻结规格的 36px。
  check('P2-12: Hero 标题字号 ' + w + '（PR2：10px，与缩放卡内智选统一）', hero.h1 === '10px', JSON.stringify(hero));
  // PR2 移植后：芯片不再手调移动端字号，取桌面基础 13px（视觉上由 scale(0.37) 缩小），取代移植前移动端覆盖 12px。
  check('P3-14: 浮动卡片字号 ' + w + ' 可读且不截断', hero.chip === '13px' && hero.chipTrunc, JSON.stringify(hero));
  check('P2-12: 合集标题 ' + w + ' 一行', hero.titleOneLine === true, JSON.stringify(hero));
  check('P2-12: ' + w + ' 无横向溢出', hero.overflow <= 1, JSON.stringify(hero));
}
await page.setViewportSize({ width: 1440, height: 900 });

// ===== 9. P3-23 空收款地址 + P2-12 付款块地址盒/复制 =====
{
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  const pay = await page.evaluate(() => {
    const base = { total_usdt: 5, actual_amount: 5, order_no: 'PAY-T', pay_method: 'OKX', pay_chain: 'X Layer', expires_at: new Date(Date.now() + 600000).toISOString() };
    const empty = document.createElement('div');
    empty.innerHTML = payBlockHTML(Object.assign({}, base, { pay_address: '' }), 'empty');
    const bad = document.createElement('div');
    bad.innerHTML = payBlockHTML(Object.assign({}, base, { pay_address: 'short' }), 'bad');
    const good = document.createElement('div');
    good.innerHTML = payBlockHTML(Object.assign({}, base, { pay_address: '0x1111111111111111111111111111111111111111' }), 'good');
    return {
      emptyNoAddr: !empty.querySelector('#addrBox-empty'),
      emptyNoQr: !empty.querySelector('.pay-qr img'),
      emptyNoCopy: !empty.querySelector('[data-copy-target="addrBox-empty"]'),
      emptyPaused: empty.innerHTML.includes('付款已暂停'),
      badPaused: bad.innerHTML.includes('付款已暂停'),
      goodHasAddr: !!good.querySelector('#addrBox-good'),
      goodHasQr: !!good.querySelector('.pay-qr img'),
      goodHasCopy: !!good.querySelector('[data-copy-target="addrBox-good"]'),
    };
  });
  check('P3-23: 空地址不显地址框/二维码/复制', pay.emptyNoAddr && pay.emptyNoQr && pay.emptyNoCopy, JSON.stringify(pay));
  check('P3-23: 空地址显暂停付款提示', pay.emptyPaused === true, JSON.stringify(pay));
  check('P3-23: 非法地址同样暂停', pay.badPaused === true, JSON.stringify(pay));
  check('P2-12: 正常地址显地址盒/二维码/复制', pay.goodHasAddr && pay.goodHasQr && pay.goodHasCopy, JSON.stringify(pay));
}

// ===== 10. P3-17 App 图标 key 安全转义 =====
{
  const esc = await page.evaluate(() => {
    APP_ICONS = { 'ok-key_1': { light: 'https://example.com/a.png', dark: 'https://example.com/b.png' } };
    return {
      badQuote: appIconSrc('bad"key'),
      badSq: appIconSrc("x' onmouseover='alert(1)"),
      badJs: (() => { APP_ICONS['ok2'] = { light: 'javascript:alert(1)' }; return appIconSrc('ok2'); })(),
      good: appIconSrc('ok-key_1'),
      esc: escH("a'b\"c<d>&"),
      prodBad: productImgHtml({ app_icon_key: 'bad"key', image_emoji: 'box' }, 'prod-img', 'prod-img prod-emoji'),
    };
  });
  check('P3-17: 双引号 key 被白名单拒绝', esc.badQuote === '', JSON.stringify(esc));
  check('P3-17: 单引号注入 key 被白名单拒绝', esc.badSq === '', JSON.stringify(esc));
  check('P3-17: javascript: URL 被拒绝', esc.badJs === '', JSON.stringify(esc));
  check('P3-17: 合法 key 正常返回图标', esc.good === 'https://example.com/a.png', JSON.stringify(esc));
  check('P3-17: escH 转义引号/尖括号/&', esc.esc === 'a&#39;b&quot;c&lt;d&gt;&amp;', esc.esc);
  check('P3-17: 非法 key 不拼进 HTML 属性', !esc.prodBad.includes('onmouseover') && !esc.prodBad.includes('bad"key'), esc.prodBad);
}

// ===== 11. P2-11 查单空关键词 + P3-15 renderList 判空 + P3-21 防重复提交 =====
{
  await gotoFresh(page, BASE + '/#/query');
  await page.waitForTimeout(600);
  await page.evaluate(() => { const kw = document.getElementById('qkeywords'); if (kw) kw.value = ''; doQueryList(); });
  await page.waitForTimeout(400);
  const toastText = await page.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
  check('P2-11: 查单空关键词提示统一', toastText === '请输入订单号或邮箱', 'toast=' + toastText);
  const guard = await page.evaluate(() => { try { const l = document.getElementById('list'); if (l) l.remove(); renderList(); return true; } catch (e) { return false; } });
  check('P3-15: renderList 在 list 节点缺失时不抛错', guard === true, '');
  const dbl = await page.evaluate(() => {
    let n = 0;
    showModal({ title: 'T', bodyHTML: '<p>x</p>', confirmText: 'OK', onConfirm: () => { n++; return true; } });
    document.getElementById('modalConfirm').click();
    const btn2 = document.getElementById('modalConfirm');
    if (btn2) btn2.click();
    return n;
  });
  check('P3-21: 确认按钮双击只提交一次', dbl === 1, 'n=' + dbl);
  await page.evaluate(() => { closeModal(); });
}

// ===== 12. P2-6 管理端表格 + P2-7 卡密掩码/单条查看 + P3-22 401 恢复登录 =====
{
  await gotoFresh(page, BASE + '/#/admin');
  await page.waitForTimeout(600);
  const loginForm = await page.evaluate(() => !!document.getElementById('apwd'));
  check('P3-22: 未登录管理端显登录界面', loginForm === true, '');
  if (loginForm) {
    await page.fill('#apwd', ADMIN_PW);
    await page.click('#loginBtn');
    await page.waitForTimeout(1200);
  }
  const tables = await page.evaluate(async () => {
    const out = {};
    for (const tab of ['data', 'orders', 'products', 'cards', 'upstream', 'audit']) {
      await adminTab(tab);
      await new Promise((r) => setTimeout(r, 700));
      const ts2 = Array.from(document.querySelectorAll('.adm-table')).map((tb) => ({
        hasThead: !!tb.querySelector('thead'),
        hasTbody: !!tb.querySelector('tbody'),
        thCount: tb.querySelectorAll('thead th').length,
        tdLabels: Array.from(tb.querySelectorAll('tbody td')).every((td) => td.hasAttribute('data-label')),
      }));
      out[tab] = ts2;
    }
    return out;
  });
  let tablesOk = true;
  for (const [tab, arr] of Object.entries(tables)) {
    for (const tb of arr) { if (!tb.hasThead || !tb.hasTbody || tb.thCount === 0 || !tb.tdLabels) tablesOk = false; }
  }
  check('P2-6: 全部管理端表格有 thead/tbody 且 td 带 data-label', tablesOk === true, JSON.stringify(tables));
  // 卡密掩码
  await page.evaluate(async () => { await adminTab('cards'); await new Promise((r) => setTimeout(r, 700)); });
  await page.waitForTimeout(300);
  const cardDom = await page.evaluate(() => ({
    hasFull: document.body.innerText.includes('REVIEW-TEST-CODE-12345'),
    hasMasked: document.body.innerText.includes('REVI****'),
  }));
  check('P2-7: 卡密列表不含完整卡密、只显掩码', cardDom.hasFull === false && cardDom.hasMasked === true, JSON.stringify(cardDom));
  // reveal：后端接口未就绪时（404）不泄露明文
  await page.route('**/api/admin/cards/*/reveal', async (route) => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '接口未就绪' }) });
  });
  const reveal = await page.evaluate(async () => {
    const rows = Array.from(document.querySelectorAll('.adm-table tbody tr'));
    const row = rows.find((tr) => (tr.textContent || '').includes('REVI****'));
    if (!row) return { found: false };
    const btn = row.querySelector('button');
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 600));
    return { found: true, toast: (document.querySelector('.toast') || {}).textContent || '', hasFull: document.body.innerText.includes('REVIEW-TEST-CODE-12345') };
  });
  check('P2-7: reveal 失败时不泄露完整卡密', reveal.found === true && reveal.hasFull === false, JSON.stringify(reveal));
  check('P2-7: reveal 失败时明确提示', (reveal.toast || '').includes('接口未就绪') || (reveal.toast || '').includes('失败'), JSON.stringify(reveal));
  await page.unrouteAll({ behavior: 'wait' });
  // P3-22：会话过期后管理端 API 401 → 显登录界面
  const unauth = await page.evaluate(async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    await api('/api/admin/stats');
    await new Promise((r) => setTimeout(r, 600));
    return { loginShown: !!document.getElementById('apwd'), stillHasAdminBtn: !!document.querySelector('[data-tab="orders"]') };
  });
  check('P3-22: 会话过期后及时显登录界面', unauth.loginShown === true, JSON.stringify(unauth));
  check('P3-22: 401 后不保留可点敏感按钮', unauth.stillHasAdminBtn === false, JSON.stringify(unauth));
}

// ===== 13. P2-12 移动端输入框与弹窗对齐（390）=====
{
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoFresh(page, BASE + '/#/product/1');
  await page.waitForTimeout(1000);
  const align = await page.evaluate(() => {
    const input = document.getElementById('contact');
    const r = input ? input.getBoundingClientRect() : null;
    showModal({ title: '对齐检查', bodyHTML: '<p>x</p>', confirmText: 'OK' });
    const m = document.querySelector('.modal');
    const mr = m ? m.getBoundingClientRect() : null;
    closeModal();
    return {
      inputIn: !!r && r.left >= 0 && r.right <= 390,
      modalIn: !!mr && mr.left >= 4 && mr.right <= 386,
    };
  });
  check('P2-12: 手机端输入框与弹窗对齐', align.inputIn === true && align.modalIn === true, JSON.stringify(align));
  await page.setViewportSize({ width: 1440, height: 900 });
}

// ===== 14. 控制台无 JS 错误 =====
check('no JS console errors', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

await browser.close();
console.log('\nREVIEW FRONTEND DONE pass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
