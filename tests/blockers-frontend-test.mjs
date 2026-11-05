// 智选前端拦路 bug 回归测试（F1 / F2，2026-10-30，分支 fix/blockers-frontend）。
// 只跑本地 Playwright + setContent，不起 wrangler dev、不占端口、不访问真实上游/链上、
// 不用真实 Turnstile 密钥（window.turnstile 用本地 stub 伪造 render 计数验证）。
// 原理：从 src/frontend.html 提取内嵌脚本（QR 库 + 主脚本，去掉尾部 load() 以免发 /api 请求），
// 注入空白页后真实调用前端函数，模拟 doQueryList / doQueryLegacy 的 DOM 重渲染与倒计时 tick。
// 运行：node tests/blockers-frontend-test.mjs
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; failures.push(name + (extra ? ' | ' + extra : '')); console.log('FAIL:', name, extra); }
}

const html = readFileSync(new URL('../src/frontend.html', import.meta.url), 'utf-8');
const blocks = [];
{
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
}
check('harness: frontend has >=3 inline script blocks', blocks.length >= 3, 'blocks=' + blocks.length);
check('harness: block[1] is QR lib', blocks[1] && blocks[1].includes('paulmillrQr'), '');
check('harness: block[2] is main script', blocks[2] && blocks[2].includes('function payBlockHTML'), '');
let mainCode = blocks[2] || '';
// 主脚本尾部 load() 会拉 /api/config 并进路由渲染；本地无服务器测试必须去掉，
// 只保留函数定义（与真实页面里同一批函数、同一行为）。
if (!/\nload\(\);\s*$/.test(mainCode)) {
  check('harness: main script ends with load() to strip', false, 'tail=' + mainCode.slice(-80));
} else {
  mainCode = mainCode.replace(/\nload\(\);\s*$/, '\n');
  check('harness: trailing load() stripped', !/\nload\(\);\s*$/.test(mainCode), '');
}
const qrCode = blocks[1] || '';

async function freshPage(browser) {
  const page = await browser.newPage();
  await page.setContent('<html><head><meta charset="utf-8"></head><body><div id="app"></div><div id="qres"></div><div id="qsec-LEG"></div></body></html>');
  await page.addScriptTag({ content: qrCode });
  await page.addScriptTag({ content: mainCode });
  const ok = await page.evaluate(() =>
    typeof payBlockHTML === 'function' && typeof renderTurnstileWidgets === 'function' &&
    typeof startCountdown === 'function' && typeof turnstileBoxHTML === 'function' &&
    typeof renderQueryOrderDetail === 'function');
  check('harness: frontend functions loaded', ok === true, String(ok));
  return page;
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  // ===== F1：查单页二次查询，Turnstile 应重新渲染 =====
  const page = await freshPage(browser);
  const f1list = await page.evaluate(() => {
    CFG = { turnstile_enabled: true, turnstile_site_key: 'test-site-key', cny_rate: 7.2 };
    window._calls = [];
    window.turnstile = {
      render: (el) => { window._calls.push(el.getAttribute('data-ts-scope')); return 'w-' + el.getAttribute('data-ts-scope'); },
      reset: () => {},
    };
    const order = { actual_amount: 10, total_usdt: 10, order_no: 'F1-ORDER', pay_method: 'OKX', pay_chain: 'X Layer', pay_address: '0x1111111111111111111111111111111111111111', expires_at: new Date(Date.now() + 3600000).toISOString() };
    // doQueryList 的关键两步：#qres.innerHTML = 含 slot 的新 HTML；随后 renderTurnstileWidgets()。
    const frag = () => payBlockHTML(order, 'F1-ORDER') + '<label>人机验证</label>' + turnstileBoxHTML('pay-F1-ORDER');
    const qres = document.getElementById('qres');
    qres.innerHTML = frag(); renderTurnstileWidgets(); const c1 = window._calls.length;
    renderTurnstileWidgets(); const c1b = window._calls.length; // 同一 DOM 再调一次：应去重，不重复 render
    qres.innerHTML = frag(); renderTurnstileWidgets(); const c2 = window._calls.length; // 二次查询：旧 slot 已销毁，新 slot 必须重新 render
    return { c1, c1b, c2 };
  });
  check('F1 list: first query renders Turnstile once', f1list.c1 === 1, JSON.stringify(f1list));
  check('F1 list: same DOM re-render does NOT duplicate widget', f1list.c1b === 1, JSON.stringify(f1list));
  check('F1 list: second query re-renders Turnstile (stale widget pruned)', f1list.c2 === 2, JSON.stringify(f1list));

  // F1：doQueryLegacy 路径（qsec 盒子重渲染，同一订单的 detail 块 + pay- 槽）。
  const f1leg = await page.evaluate(() => {
    const before = window._calls.length;
    const order = { product_snapshot: { title: 'T' }, status: 'pending_payment', total_usdt: 3, actual_amount: 3, order_no: 'LEG', pay_method: 'OKX', pay_chain: 'X Layer', pay_address: '0x2222222222222222222222222222222222222222', expires_at: new Date(Date.now() + 3600000).toISOString(), txid: '' };
    const box = document.getElementById('qsec-LEG');
    box.innerHTML = renderQueryOrderDetail(order, false); renderTurnstileWidgets(); const d1 = window._calls.length - before;
    box.innerHTML = renderQueryOrderDetail(order, false); renderTurnstileWidgets(); const d2 = window._calls.length - before - d1;
    return { d1, d2 };
  });
  check('F1 legacy: first legacy render renders Turnstile once', f1leg.d1 === 1, JSON.stringify(f1leg));
  check('F1 legacy: legacy box re-render re-renders Turnstile', f1leg.d2 === 1, JSON.stringify(f1leg));

  // F1：SVG 路径不受影响（Turnstile 关闭时 turnstileBoxHTML 为空，付款块仍正常渲染）。
  const svg = await page.evaluate(() => {
    CFG = { turnstile_enabled: false, cny_rate: 7.2 };
    const boxHtml = turnstileBoxHTML('pay-SVG');
    const h = payBlockHTML({ actual_amount: 5, total_usdt: 5, order_no: 'SVG-1', pay_method: 'OKX', pay_chain: 'X Layer', pay_address: '0x1111111111111111111111111111111111111111', expires_at: new Date(Date.now() + 3600000).toISOString() }, 'SVG-1');
    return { boxEmpty: boxHtml === '', hasQr: h.includes('data-pay-qr'), hasAddr: h.includes('addrBox-SVG-1') };
  });
  check('F1 SVG path: Turnstile off => turnstileBoxHTML empty', svg.boxEmpty === true, JSON.stringify(svg));
  check('F1 SVG path: pay block still renders QR/addr when Turnstile off', svg.hasQr && svg.hasAddr, JSON.stringify(svg));
  await page.close();

  // ===== F2：倒计时 tick 跨过过期点，付款块应变过期分支 =====
  const page2 = await freshPage(browser);
  const f2 = await page2.evaluate(async () => {
    CFG = { turnstile_enabled: false, cny_rate: 7.2 };
    const mk = (uid, exp) => ({ actual_amount: 10, total_usdt: 10, order_no: uid, pay_method: 'OKX', pay_chain: 'X Layer', pay_address: '0x1111111111111111111111111111111111111111', expires_at: exp });
    const wrapA = document.createElement('div'); wrapA.className = 'glass';
    const wrapB = document.createElement('div'); wrapB.className = 'glass';
    wrapA.innerHTML = payBlockHTML(mk('F2-SOON', new Date(Date.now() + 2500).toISOString()), 'F2-SOON');
    wrapB.innerHTML = payBlockHTML(mk('F2-LATER', new Date(Date.now() + 3600000).toISOString()), 'F2-LATER');
    document.body.appendChild(wrapA); document.body.appendChild(wrapB);
    const before = {
      soonQr: !!wrapA.querySelector('.pay-qr-box'),
      soonAddr: !!wrapA.querySelector('.pay-addrbox'),
      soonCopy: wrapA.querySelectorAll('.pay-copy').length,
    };
    startCountdown();
    await new Promise((r) => setTimeout(r, 4200)); // 跨过 2.5s 过期点，tick 每秒跑一次
    // 防循环：过期重渲染后 wrapper 应稳定，不应在每个 tick 都被反复重建。
    const w1 = wrapA.querySelector('[data-payblock]');
    await new Promise((r) => setTimeout(r, 1300));
    const wrapStable = !!w1 && wrapA.querySelector('[data-payblock]') === w1;
    const after = {
      soonQr: !!wrapA.querySelector('.pay-qr-box'),
      soonAddr: !!wrapA.querySelector('.pay-addrbox'),
      soonCopy: wrapA.querySelectorAll('.pay-copy').length,
      soonAddrText: wrapA.textContent.includes('0x1111111111111111111111111111111111111111'),
      soonExpiredText: wrapA.textContent.includes('订单已过期'),
      soonCountdown: (document.getElementById('countdown-F2-SOON') || {}).textContent || '',
      laterQr: !!wrapB.querySelector('.pay-qr-box'),
      laterAddr: !!wrapB.querySelector('.pay-addrbox'),
      laterCopy: wrapB.querySelectorAll('.pay-copy').length,
      wrapStable,
    };
    stopCountdown();
    return { before, after };
  });
  check('F2 tick: before expiry the soon block HAS qr/addr/copy (not vacuous)', f2.before.soonQr && f2.before.soonAddr && f2.before.soonCopy > 0, JSON.stringify(f2.before));
  check('F2 tick: after expiry QR gone', f2.after.soonQr === false, JSON.stringify(f2.after));
  check('F2 tick: after expiry address box gone', f2.after.soonAddr === false, JSON.stringify(f2.after));
  check('F2 tick: after expiry all copy buttons gone', f2.after.soonCopy === 0, JSON.stringify(f2.after));
  check('F2 tick: after expiry address text gone', f2.after.soonAddrText === false, JSON.stringify(f2.after));
  check('F2 tick: after expiry expired notice shown', f2.after.soonExpiredText === true && f2.after.soonCountdown === '已过期，请重新下单', JSON.stringify(f2.after));
  check('F2 tick: other unexpired order NOT wiped', f2.after.laterQr && f2.after.laterAddr && f2.after.laterCopy > 0, JSON.stringify(f2.after));
  check('F2 tick: expired wrapper stable across later ticks (no re-render loop)', f2.after.wrapStable === true, JSON.stringify(f2.after));

  // F2：渲染瞬间已过期（已有行为，不得破坏）+ expires_at 空/非法 fail-closed。
  const f2static = await page2.evaluate(() => {
    const base = { actual_amount: 5, total_usdt: 5, order_no: 'F2-STATIC', pay_method: 'OKX', pay_chain: 'X Layer', pay_address: '0x1111111111111111111111111111111111111111' };
    const chk = (h) => ({ qr: h.includes('pay-qr-box'), addr: h.includes('addrBox-'), copy: h.includes('data-copy-target'), addrText: h.includes('0x1111111111111111111111111111111111111111'), reorder: h.includes('请重新下单') });
    return {
      past: chk(payBlockHTML(Object.assign({}, base, { expires_at: '2000-01-01T00:00:00Z' }), 'F2-PAST')),
      empty: chk(payBlockHTML(Object.assign({}, base, { expires_at: '' }), 'F2-EMPTY')),
      undef: chk(payBlockHTML(Object.assign({}, base), 'F2-UNDEF')),
      bad: chk(payBlockHTML(Object.assign({}, base, { expires_at: 'not-a-date' }), 'F2-BAD')),
      ws: chk(payBlockHTML(Object.assign({}, base, { expires_at: '   ' }), 'F2-WS')),
    };
  });
  const noPayable = (x) => !x.qr && !x.addr && !x.copy && !x.addrText;
  check('F2 static: already-expired at render has no qr/addr/copy', noPayable(f2static.past) && f2static.past.reorder, JSON.stringify(f2static.past));
  check('F2 static: expires_at empty => no payable block', noPayable(f2static.empty) && f2static.empty.reorder, JSON.stringify(f2static.empty));
  check('F2 static: expires_at missing => no payable block', noPayable(f2static.undef) && f2static.undef.reorder, JSON.stringify(f2static.undef));
  check('F2 static: expires_at illegal => no payable block', noPayable(f2static.bad) && f2static.bad.reorder, JSON.stringify(f2static.bad));
  check('F2 static: expires_at whitespace => no payable block', noPayable(f2static.ws) && f2static.ws.reorder, JSON.stringify(f2static.ws));
  await page2.close();
} finally {
  await browser.close();
}

console.log('BLOCKERS-FRONTEND DONE pass=' + pass + ' fail=' + fail);
if (fail) { console.log('FAILURES: ' + failures.join(' ; ')); process.exit(1); }
