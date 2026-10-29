import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// 智选前端审计修复回归测试（audit-front 线，2026-10-30）。
// 静态断言：src/frontend.html 含本次修复的关键文案/调用；脚本块逐个 node --check。
// 浏览器断言（需 wrangler dev --local 在 BASE 上运行，默认 8793）：页内直接调用前端函数，
// 不依赖真实订单/真实密钥；若 BASE 不可达则跳过浏览器段、仅以静态段为准（打印 SKIP-BROWSER）。
// 运行：BASE=http://127.0.0.1:8793 node tests/audit-front-fixes-test.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8793';
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; failures.push(name + (extra ? ' | ' + extra : '')); console.log('FAIL:', name, extra || ''); }
}
const html = readFileSync(new URL('../src/frontend.html', import.meta.url), 'utf-8');
function has(name, needle) { check('static: ' + name, html.includes(needle), 'missing: ' + needle.slice(0, 80)); }

// 1 验证码失败可见
has('captcha error text', '验证码加载失败，请刷新重试');
has('captcha helper setCaptchaError', 'function setCaptchaError');
has('captcha helper clears on success', 'clearCaptchaError(img)');
// 2 Turnstile 失败与未完成区分
has('turnstile load-fail text', '验证组件加载失败，请检查网络后刷新');
has('turnstile mark fn', 'function markTurnstileLoadFailed');
has('turnstile not-done hint kept', '请完成验证后继续');
// 3 过期停付
has('expired pay block', '订单已过期，请重新下单');
has('expired pay block no-qr branch', '不渲染二维码、收款地址与任何复制按钮');
// 4 后台总览子接口失败
has('admin data pending load-fail', '加载失败');
has('admin data alerts load-fail branch', "if (!alerts || !alerts.ok)");
// 5 设置统一保存
has('save-all button', '保存全部设置（通用 + 收款 + 首页通知）');
has('save-all fn', 'function adminSaveAllSettings');
has('save-all summary', '保存未全部成功');
// 6 Hero 字号
has('hero h1 22px mobile', '.home-h1{font-size:22px}');
has('hero eyebrow 14px mobile', '.home-eyebrow{font-size:14px');
has('hero sub 14px mobile', '.home-sub{font-size:14px');
has('hero cta 14px mobile', '.home-cta{font-size:14px');
// 7 loading 与防重复
has('txid in-flight guard', 'window._txidSubmitting');
has('txid button loading', 'setBtnLoading(_txBtn, true)');
has('query button loading', 'doQueryList(this)');
has('secret button loading', 'doQuerySecret(this.dataset.no, this.dataset.pw, this)');
// 8 查单列表 TXID 入口
has('list txid input', "id=\"qtxid-' + escH(o.order_no)");
// 9 恢复付款不回落首单
check('static: no first-order fallback', !html.includes('found = (r.orders || [])[0]'), 'fallback still present');
has('recover exact-match comment', '绝不回落到列表首单');
// 10 商品卡 USDT 价
has('card usdt price', "约 ' + Number(p.price_usdt || 0).toFixed(2) + ' USDT</div></div>'");
// 11 图片切换不丢图
has('image orig kept', '未上传新图时保存保留原图');
has('image save orig fallback', 'window._productOrigImage');
// 12 数量提示
has('qty decimal hint', '数量仅支持整数，已取整为');
has('qty blank hint', '数量不能为空，已恢复为 1 件');
has('qty hint element', 'id="qtyHint"');
// 13 卡密下拉分页+搜索
has('cards paginated loader', 'function loadAllAdminProducts');
has('cards search input', 'id="cardProdSearch"');
check('static: no page_size=100-only dropdown', !html.includes('用商品列表的前 100 件'), 'old comment still present');
// 14 输入框 16px
has('input 16px', 'input,select,textarea{width:100%;padding:12px 13px;border-radius:14px;border:1px solid var(--zx-border);background:var(--card2);color:var(--text);font-size:16px');
// 16 /pay 带 query_password + GET 摘要辅助
has('pay carries query_password', 'body.query_password = qpTxEl.value.trim()');
has('pay qp input success', 'id="payQueryPassword"');
has('summary helper', 'function fetchOrderSummary');
has('summary helper captcha params', 'captcha_id=');
// 17 配置失败闭合
has('config load flag', 'window._configLoadFailed = !r.ok');
has('config fail banner', '配置加载失败，请刷新重试');
check('static: payAvailable fail-closed', html.includes('function payAvailable(){\n  if (!CFG) return false;'), 'payAvailable still defaults true');

// 脚本块语法检查（与 extract-frontend-check.mjs 同款）
{
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = []; let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  check('frontend script blocks exist', blocks.length >= 2, 'blocks=' + blocks.length);
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'audit-front-check-'));
  try {
    blocks.forEach((code, i) => {
      const f = join(dir, 'block-' + i + '.js');
      writeFileSync(f, code);
      try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); check('syntax block ' + i, true); }
      catch (e) { check('syntax block ' + i, false, String(e.stderr || e.stdout || e).slice(0, 300)); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 浏览器段
let serverUp = false;
for (let i = 0; i < 8 && !serverUp; i++) {
  try { const r = await fetch(BASE + '/api/config'); if (r.ok || r.status < 500) serverUp = true; } catch (_) {}
  if (!serverUp) await new Promise((r) => setTimeout(r, 1000));
}
if (!serverUp) {
  console.log('SKIP-BROWSER: dev server not reachable at ' + BASE + ' (start: npx wrangler dev --local --port 8793)');
} else {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const width of [390, 360]) {
      const ctx = await browser.newContext({ viewport: { width, height: 844 } });
      const page = await ctx.newPage();
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      // 冷启动的 dev 服务器首屏渲染可能慢于固定 800ms：先等 hero 出现再量字号，避免首跑误报。
      await page.waitForSelector('.home-h1', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800);
      const hero = await page.evaluate(() => {
        const cs = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).fontSize : ''; };
        return { h1: cs('.home-h1'), eyebrow: cs('.home-eyebrow'), sub: cs('.home-sub'), cta: cs('.home-cta'), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      check('browser ' + width + ': hero h1 >=20px', parseFloat(hero.h1) >= 20, hero.h1);
      check('browser ' + width + ': hero eyebrow/sub >=14px', parseFloat(hero.eyebrow) >= 14 && parseFloat(hero.sub) >= 14, hero.eyebrow + '/' + hero.sub);
      check('browser ' + width + ': hero cta >=14px', parseFloat(hero.cta) >= 14, hero.cta);
      check('browser ' + width + ': no horizontal overflow', hero.overflow <= 1, 'overflow=' + hero.overflow);
      const inputFs = await page.evaluate(() => { const e = document.querySelector('#q'); return e ? getComputedStyle(e).fontSize : ''; });
      check('browser ' + width + ': search input 16px', inputFs === '16px', inputFs);
      await ctx.close();
    }
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const dom = await page.evaluate(() => {
      const out = {};
      const past = new Date(Date.now() - 3600 * 1000).toISOString();
      const future = new Date(Date.now() + 3600 * 1000).toISOString();
      const base = { order_no: 'AIS-TEST-0001', total_usdt: 10, actual_amount: 10.01, pay_address: '0x1111111111111111111111111111111111111111', pay_method: 'OKX', pay_chain: 'X Layer' };
      const eh = payBlockHTML(Object.assign({}, base, { expires_at: past }), 't-exp');
      out.expiredHasMsg = eh.includes('订单已过期，请重新下单');
      out.expiredNoQr = !eh.includes('data-pay-qr="ok"') && !eh.includes('addrBox-');
      out.expiredNoCopy = !eh.includes('data-copy-target');
      const fh = payBlockHTML(Object.assign({}, base, { expires_at: future }), 't-ok');
      out.freshHasQr = fh.includes('data-pay-qr="ok"') || fh.includes('data-pay-qr="err"');
      out.freshHasAddr = fh.includes('addrBox-');
      document.body.insertAdjacentHTML('beforeend', '<input id="qty" class="qty-input" value="2.5"><div id="qtyHint"></div>');
      const v1 = clampQty();
      out.qtyDecimal = { v: v1, hint: document.getElementById('qtyHint').textContent };
      document.getElementById('qty').value = '';
      const v2 = clampQty();
      out.qtyBlank = { v: v2, hint: document.getElementById('qtyHint').textContent };
      document.getElementById('qty').remove(); document.getElementById('qtyHint').remove();
      const wrap = document.createElement('div');
      wrap.innerHTML = '<div class="row"><img id="captchaImg" style="width:120px;height:44px"></div>';
      document.body.appendChild(wrap);
      setCaptchaError(document.getElementById('captchaImg'), '验证码加载失败，请刷新重试');
      out.captchaErr = !!document.getElementById('captchaImg-err') && document.getElementById('captchaImg-err').textContent.includes('验证码加载失败');
      wrap.remove();
      const slot = document.createElement('div');
      slot.innerHTML = '<div class="turnstile-slot" data-ts-scope="order"></div>';
      document.body.appendChild(slot);
      TS.failed = true; markTurnstileLoadFailed();
      out.tsFail = document.body.innerHTML.includes('验证组件加载失败，请检查网络后刷新');
      slot.remove(); TS.failed = false;
      const origApi = window.api;
      let captured = '';
      window.api = function (u) { captured = u; return Promise.resolve({ ok: true }); };
      window._qCaptchaId = 'cap-1';
      const inp = document.createElement('input'); inp.id = 'qCaptchaCode'; inp.value = 'AB12'; document.body.appendChild(inp);
      fetchOrderSummary('AIS-TEST-0001');
      out.summaryUrl = captured;
      inp.remove(); window.api = origApi; window._qCaptchaId = '';
      out.configFailClosed = (function () { const oldCfg = CFG; const oldFlag = window._configLoadFailed; CFG = null; window._configLoadFailed = true; const r = payAvailable(); CFG = oldCfg; window._configLoadFailed = oldFlag; return r === false; })();
      return out;
    });
    check('browser: expired block message', dom.expiredHasMsg);
    check('browser: expired block hides qr/addr', dom.expiredNoQr, JSON.stringify(dom));
    check('browser: expired block hides copy buttons', dom.expiredNoCopy, JSON.stringify(dom));
    check('browser: fresh block keeps qr/addr', dom.freshHasQr && dom.freshHasAddr, JSON.stringify(dom));
    check('browser: qty 2.5 hinted + floored', dom.qtyDecimal.v === 2 && dom.qtyDecimal.hint.includes('仅支持整数'), JSON.stringify(dom.qtyDecimal));
    check('browser: qty blank hinted + reset 1', dom.qtyBlank.v === 1 && dom.qtyBlank.hint.includes('不能为空'), JSON.stringify(dom.qtyBlank));
    check('browser: captcha error visible', dom.captchaErr);
    check('browser: turnstile load-fail visible', dom.tsFail);
    check('browser: summary url carries captcha', dom.summaryUrl.includes('captcha_id=cap-1') && dom.summaryUrl.includes('captcha_code=AB12'), dom.summaryUrl);
    check('browser: config-fail payAvailable false', dom.configFailClosed);
    // 加标后二维码：白圈（38px 标）覆盖后的模块级解码
    const qr = await page.evaluate(async () => {
      const addr = '0x1111111111111111111111111111111111111111';
      const url = payQrDataUrl(addr);
      if (!url) return { ok: false, reason: 'no qr url' };
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const n = img.naturalWidth;
      const cv = document.createElement('canvas'); cv.width = n; cv.height = n;
      const c = cv.getContext('2d'); c.drawImage(img, 0, 0, n, n);
      c.fillStyle = '#ffffff'; c.beginPath(); c.arc(n / 2, n / 2, (19 / 180) * n, 0, Math.PI * 2); c.fill();
      const data = c.getImageData(0, 0, n, n);
      try { const dec = paulmillrQr.decodeQR({ data: data.data, width: n, height: n }); return { ok: dec === addr, n, dec: dec || '' }; }
      catch (e) { return { ok: false, n, reason: String(e).slice(0, 200) }; }
    });
    check('browser: post-logo QR decodes (module level, not phone scan)', qr.ok, JSON.stringify(qr));
    await ctx.close();
  } finally { await browser.close(); }
}
console.log('AUDIT-FRONT-FIXES DONE pass=' + pass + ' fail=' + fail);
if (fail) { console.log('FAILURES: ' + failures.join(' ; ')); process.exit(1); }
