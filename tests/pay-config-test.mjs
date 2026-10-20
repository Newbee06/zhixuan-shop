// 收款方式配置 + 对接 API 测试（冻结规格 1A/2A/3A/4A/5A/6/7A）
// 覆盖：旧 JSON 迁移（开/关/幂等/新字段为准）、开关（单链关/双关/已有订单不受影响）、地址校验、
// 后台权限 + 响应不含 Key + 前端无硬编码、测试连接（Mock 成功/失败/未配置/限流/不触发采购）。
// 运行：node tests/pay-config-test.mjs
// 测试一律用 dummy 地址与 Mock 上游，绝不填真实 Key、绝不点真实 ProdSeller、绝不真实转账/采购。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
db.exec(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
function wrapStmt(sql) {
  let params = [];
  const api = {
    bind(...a) { params = a; return api; },
    async first() { try { const st = db.prepare(sql); const r = st.get(...params); return r === undefined ? null : r; } catch (e) { throw e; } },
    async all() { const st = db.prepare(sql); const rows = st.all(...params); return { results: rows }; },
    async run() { const st = db.prepare(sql); const info = st.run(...params); return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }; },
  };
  return api;
}
const env = { ZHIXUAN_SETUP_TOKEN: 'test-setup-token', DB: { prepare: (sql) => wrapStmt(sql) }, PRODSELLER_API_KEY: 'test-key', PRODSELLER_BASE_URL: 'https://prodseller.com/v1' };
const ADDR_OKX = '0x1111111111111111111111111111111111111111';
const ADDR_BIN = '0x2222222222222222222222222222222222222222';
const ADDR_NEW_X = '0x4444444444444444444444444444444444444444';
const ADDR_NEW_B = '0x5555555555555555555555555555555555555555';
const ADDR_NEW_X2 = '0x7777777777777777777777777777777777777777';
const ADDR_GENERIC = '0x8888888888888888888888888888888888888888';
const USDT0_XLAYER = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
const BEP20_USDT = '0x55d398326f99059fF775485246999027B3197955';
const TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
let balanceShouldFail = false;
let balanceCalls = 0;
let upstreamPostCalls = 0;
let evmState = { latestBlock: 10000, logs: [] };
function toTopic(addr) { return '0x' + '0'.repeat(24) + String(addr).slice(2).toLowerCase(); }
function amountToRaw(amount, decimals) {
  const s = String(amount); const parts = s.split('.');
  const intPart = parts[0] || '0'; let fracPart = parts[1] || '';
  if (fracPart.length > decimals) fracPart = fracPart.slice(0, decimals);
  while (fracPart.length < decimals) fracPart += '0';
  return BigInt(intPart) * (10n ** BigInt(decimals)) + BigInt(fracPart || '0');
}
async function mockFetch(url, opts = {}) {
  const u = String(url); const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('api.resend.com')) return new Response(JSON.stringify({ id: 'mock-mail' }), { status: 200 });
  if (u.includes('prodseller.com/v1/balance') && method === 'GET') {
    balanceCalls++;
    if (balanceShouldFail) return new Response(JSON.stringify({ error: 'mock upstream down' }), { status: 500 });
    return new Response(JSON.stringify({ balance: 123.45 }), { status: 200 });
  }
  if (u.includes('prodseller.com/v1/products') && method === 'GET') return new Response(JSON.stringify([]), { status: 200 });
  if (u.includes('prodseller.com/v1/orders') && method === 'POST') { upstreamPostCalls++; return new Response(JSON.stringify({ error: 'must not be called in pay-config test' }), { status: 500 }); }
  if (u.includes('prodseller.com/v1/orders/') && method === 'GET') return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  if (u.includes('mock-xlayer') || u.includes('mock-bsc')) {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (body && body.method === 'eth_chainId') {
      const id = u.includes('mock-bsc') ? '0x38' : '0xc4';
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: id }), { status: 200 });
    }
    if (body && body.method === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + evmState.latestBlock.toString(16) }), { status: 200 });
    if (body && body.method === 'eth_call') {
      const to = String((body.params && body.params[0] && body.params[0].to) || '').toLowerCase();
      const dec = to === USDT0_XLAYER.toLowerCase() ? 6 : (to === BEP20_USDT.toLowerCase() ? 18 : undefined);
      if (dec === undefined) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (0).toString(16).padStart(64, '0') }), { status: 200 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + dec.toString(16).padStart(64, '0') }), { status: 200 });
    }
    if (body && body.method === 'eth_getLogs') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: evmState.logs }), { status: 200 });
    if (body && body.method === 'eth_getTransactionReceipt') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
  }
  return new Response(JSON.stringify({}), { status: 200 });
}
globalThis.fetch = mockFetch;
env.__fetch = mockFetch;
let code = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
code = code.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(html) + ';');
code = code.replace('export default {', 'globalThis.__W = {');
const worker = new Function(code + '\nreturn globalThis.__W;')();
function makeCtx() { const c = { pending: [] }; c.waitUntil = (pr) => { c.pending.push(pr); }; c.drain = async () => { while (c.pending.length) { const batch = c.pending.splice(0); await Promise.all(batch.map((x) => x.catch(() => {}))); } }; return c; }
async function call(method, p, body, cookie, extraHeaders) {
  const ctx = makeCtx();
  const headers = { 'content-type': 'application/json', 'X-Admin-API': '1', ...(extraHeaders || {}) };
  if (cookie) headers.Cookie = cookie;
  const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: res.status, json: j, text: txt, headers: res.headers };
}
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); } console.log('PASS: ' + msg); }
function q(sql, ...a) { return db.prepare(sql).get(...a); }
function setSetting(key, value) { db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
function delSetting(key) { db.prepare('DELETE FROM settings WHERE key=?').run(key); }
function delPayKeys() { for (const k of ['pay_xlayer_address', 'pay_xlayer_enabled', 'pay_bep20_address', 'pay_bep20_enabled']) delSetting(k); }
let capSeq = 0;
function mkCaptcha(codeStr) {
  const id = 'cap-pay-' + (++capSeq);
  const h = createHash('sha256').update(codeStr).digest('hex');
  const exp = new Date(Date.now() + 300000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?,?,0)').run(id, h, exp);
  return id;
}
let contactSeq = 0;
function freshContact() { return 'paycfg' + (++contactSeq) + '@test.example'; }
async function orderCall(payMethod, payChain, productId) {
  const cid = mkCaptcha('AB12');
  db.prepare('DELETE FROM order_rate').run();
  const c = freshContact();
  return call('POST', '/api/orders', { query_password: 'query-password-123', product_id: productId, quantity: 1, customer_fields: { contact_email: c, delivery_email: c }, contact: c, pay_method: payMethod, pay_chain: payChain, captcha_id: cid, captcha_code: 'AB12' });
}
function payMethodsOf(cfg) { return (cfg && cfg.pay_config && cfg.pay_config.methods) || []; }
function payEntry(cfg, chain) { return payMethodsOf(cfg).find((m) => m.pay_chain === chain) || null; }
async function runPoll() { const ctx = makeCtx(); await worker.scheduled({ cron: '*/1 * * * *' }, env, ctx); await ctx.drain(); }

// ---- 基础设置：仅旧 JSON，无新字段（迁移模式）----
delPayKeys();
setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_OKX, 'Binance|BEP20': ADDR_BIN }));
setSetting('rpc_urls', JSON.stringify({ 'X Layer': ['https://mock-xlayer'], 'BEP20': ['https://mock-bsc'] }));
setSetting('chain_confirmations', JSON.stringify({ 'X Layer': 1, 'BEP20': 15 }));
setSetting('poll_enabled', '1');
setSetting('prodseller_enabled', '0');
// admin login
let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
assert(r.json && r.json.ok, 'admin login');
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await call('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'test-admin-password-123' }, cookie);
assert(r.json && r.json.ok, 'change-password');
cookie = (r.headers.get('set-cookie') || '').split(';')[0] || cookie;
// 商品
r = await call('POST', '/api/admin/products', { slug: 'paycfg-card', title: 'PayCfg Card', category: 'card', price_usdt: 10, sell_price: 10, source: 'self', delivery_method: 'both', stock_type: 'card', form_fields: [] }, cookie);
assert(r.json && r.json.ok, 'create card product');
const cardProd = q('SELECT * FROM products WHERE slug=?', 'paycfg-card');
for (let i = 1; i <= 30; i++) db.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(cardProd.id, 'PAYCFG-KEY-' + String(i).padStart(3, '0'));

// ===== 1. 旧 JSON 迁移：双地址合法 → 双开关默认开；幂等（GET 不写库）=====
{
  r = await call('GET', '/api/config');
  assert(r.json && r.json.ok, '1. /api/config ok (migration)');
  assert(payEntry(r.json.config, 'X Layer') && payEntry(r.json.config, 'X Layer').enabled === true && payEntry(r.json.config, 'X Layer').address === ADDR_OKX, '1. migration: X Layer enabled=true + address from old JSON');
  assert(payEntry(r.json.config, 'BEP20') && payEntry(r.json.config, 'BEP20').enabled === true && payEntry(r.json.config, 'BEP20').address === ADDR_BIN, '1. migration: BEP20 enabled=true + address from old JSON');
  assert(r.json.config.pay_config.pay_available === true, '1. migration: pay_available=true');
  const r2 = await call('GET', '/api/config');
  assert(JSON.stringify(r2.json.config.pay_config) === JSON.stringify(r.json.config.pay_config), '1. migration idempotent: second read identical');
  assert(!q('SELECT * FROM settings WHERE key=?', 'pay_xlayer_address'), '1. migration is read-only derivation: GET does not create pay_xlayer_address row');
  assert(!q('SELECT * FROM settings WHERE key=?', 'pay_bep20_enabled'), '1. migration is read-only derivation: GET does not create pay_bep20_enabled row');
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(r.json && r.json.ok && r.json.order.pay_address === ADDR_OKX, '1. migration: OKX order uses old JSON address');
}

// ===== 2. 迁移：缺一链地址 → 该链默认关，另一链仍可下单 =====
{
  setSetting('usdt_addresses', JSON.stringify({ 'Binance|BEP20': ADDR_BIN }));
  r = await call('GET', '/api/config');
  assert(payEntry(r.json.config, 'X Layer').enabled === false, '2. migration missing X Layer address -> enabled=false');
  assert(payEntry(r.json.config, 'BEP20').enabled === true, '2. migration missing X Layer -> BEP20 still enabled');
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(!(r.json && r.json.ok) && /收款地址/.test(r.json.error || '') && /收款暂未开放/.test(r.json.error || ''), '2. missing X Layer address order rejected with 收款暂未开放 + 收款地址: ' + JSON.stringify(r.json));
  r = await orderCall('Binance', 'BEP20', cardProd.id);
  assert(r.json && r.json.ok && r.json.order.pay_address === ADDR_BIN, '2. BEP20 order still succeeds when X Layer missing');
  setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_OKX, 'Binance|BEP20': ADDR_BIN }));
}

// ===== 3. 迁移：非法地址 → 该链默认关 =====
{
  setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': 'not-an-address', 'Binance|BEP20': ADDR_BIN }));
  r = await call('GET', '/api/config');
  assert(payEntry(r.json.config, 'X Layer').enabled === false, '3. migration invalid X Layer address -> enabled=false');
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(!(r.json && r.json.ok), '3. invalid X Layer address order rejected');
  setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_OKX, 'Binance|BEP20': ADDR_BIN }));
}

// ===== 4. 保存新表单：新地址生效 + 审计掩码（不含全文）+ 新字段优先于旧 JSON =====
{
  r = await call('POST', '/api/admin/pay-config', { xlayer_address: ADDR_NEW_X, xlayer_enabled: '1', bep20_address: ADDR_NEW_B, bep20_enabled: '1' }, cookie);
  assert(r.json && r.json.ok, '4. POST /api/admin/pay-config ok: ' + JSON.stringify(r.json));
  assert(q('SELECT * FROM settings WHERE key=?', 'pay_xlayer_address').value === ADDR_NEW_X, '4. pay_xlayer_address persisted');
  assert(q('SELECT * FROM settings WHERE key=?', 'pay_bep20_enabled').value === '1', '4. pay_bep20_enabled persisted');
  r = await call('GET', '/api/config');
  assert(payEntry(r.json.config, 'X Layer').address === ADDR_NEW_X && payEntry(r.json.config, 'BEP20').address === ADDR_NEW_B, '4. /api/config reflects new addresses');
  const audit = q('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 1');
  assert(audit && /收款配置/.test(audit.note || ''), '4. audit logged for pay-config save: ' + (audit && audit.note));
  assert(audit && !String(audit.note || '').includes(ADDR_NEW_X) && !String(audit.note || '').includes(ADDR_NEW_B), '4. audit note masks addresses (no full address)');
  assert(audit && audit.note.includes('0x4444...4444') && audit.note.includes('0x5555...5555'), '4. audit note contains masked first6...last4: ' + (audit && audit.note));
  // 新字段为准：旧 JSON 改了也不影响
  setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': '0x6666666666666666666666666666666666666666', 'Binance|BEP20': '0x6666666666666666666666666666666666666666' }));
  r = await call('GET', '/api/config');
  assert(payEntry(r.json.config, 'X Layer').address === ADDR_NEW_X, '4. new fields win over old JSON after save');
  // 新订单地址与下发地址一致
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(r.json && r.json.ok && r.json.order.pay_address === ADDR_NEW_X, '4. new X Layer order pay_address = saved new address');
}

// ===== 5. 地址校验：非法地址拒绝保存，DB 不变 =====
{
  r = await call('POST', '/api/admin/pay-config', { xlayer_address: 'not-an-address', xlayer_enabled: '1' }, cookie);
  assert(!(r.json && r.json.ok) && /格式无效/.test(r.json.error || ''), '5. invalid address save rejected: ' + JSON.stringify(r.json));
  assert(q('SELECT * FROM settings WHERE key=?', 'pay_xlayer_address').value === ADDR_NEW_X, '5. DB unchanged after invalid save');
}

// ===== 6. 开启无有效地址拒绝（新表单 + 普通设置接口两路）=====
{
  r = await call('POST', '/api/admin/pay-config', { xlayer_address: '', xlayer_enabled: '1' }, cookie);
  assert(!(r.json && r.json.ok) && /有效/.test(r.json.error || ''), '6. enable without valid address rejected (pay-config): ' + JSON.stringify(r.json));
  assert(q('SELECT * FROM settings WHERE key=?', 'pay_xlayer_address').value === ADDR_NEW_X, '6. DB unchanged after enable-without-address');
  r = await call('POST', '/api/admin/settings', { settings: { pay_bep20_address: '', pay_bep20_enabled: '1' } }, cookie);
  assert(!(r.json && r.json.ok) && /有效/.test(r.json.error || ''), '6. enable without valid address rejected (generic settings): ' + JSON.stringify(r.json));
}

// ===== 7. 单链关：只显示另一链；关链拒单含“收款暂未开放”，开链可下单 =====
{
  r = await call('POST', '/api/admin/pay-config', { xlayer_enabled: '0' }, cookie);
  assert(r.json && r.json.ok, '7. turn off X Layer ok');
  r = await call('GET', '/api/config');
  assert(payEntry(r.json.config, 'X Layer').enabled === false && payEntry(r.json.config, 'BEP20').enabled === true, '7. config: only BEP20 enabled');
  assert(r.json.config.pay_config.pay_available === true, '7. pay_available=true with one chain on');
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(!(r.json && r.json.ok) && /收款暂未开放/.test(r.json.error || ''), '7. closed X Layer order rejected with 收款暂未开放: ' + JSON.stringify(r.json));
  r = await orderCall('Binance', 'BEP20', cardProd.id);
  assert(r.json && r.json.ok && r.json.order.pay_address === ADDR_NEW_B, '7. open BEP20 order succeeds with new BEP20 address');
  var existingBep20OrderNo = r.json.order.order_no;
  var existingBep20Actual = r.json.order.actual_amount;
  // 记下已有订单，供第 8 节验证开关不影响已有订单
  globalThis.__existingBep20 = { order_no: existingBep20OrderNo, actual_amount: existingBep20Actual, pay_address: ADDR_NEW_B };
}

// ===== 8. 双关：下单拒绝 + “收款暂未开放”；已有订单仍显示原方式 + 轮询继续 =====
{
  r = await call('POST', '/api/admin/pay-config', { xlayer_enabled: '0', bep20_enabled: '0' }, cookie);
  assert(r.json && r.json.ok, '8. turn off both ok');
  r = await call('GET', '/api/config');
  assert(r.json.config.pay_config.pay_available === false, '8. pay_available=false when both closed');
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(!(r.json && r.json.ok) && /收款暂未开放/.test(r.json.error || ''), '8. both closed: X Layer order rejected with 收款暂未开放');
  r = await orderCall('Binance', 'BEP20', cardProd.id);
  assert(!(r.json && r.json.ok) && /收款暂未开放/.test(r.json.error || ''), '8. both closed: BEP20 order rejected with 收款暂未开放');
  // 已有订单快照不变（DB 行）
  const ord = q('SELECT * FROM orders WHERE order_no=?', globalThis.__existingBep20.order_no);
  assert(ord && ord.pay_address === ADDR_NEW_B && ord.pay_method === 'Binance' && ord.pay_chain === 'BEP20' && ord.status === 'pending_payment', '8. existing order snapshot unchanged after switch-off');
  // 已有订单经查单仍显示原收款地址
  const cid = mkCaptcha('AB12');
  r = await call('POST', '/api/orders/query', { keywords: globalThis.__existingBep20.order_no, captcha_id: cid, captcha_code: 'AB12' });
  const found = (r.json && r.json.orders || []).find((o) => o.order_no === globalThis.__existingBep20.order_no);
  assert(found && found.pay_address === ADDR_NEW_B, '8. existing order still shows original pay_address via query: ' + JSON.stringify(r.json).slice(0, 300));
  // 轮询继续：模拟该订单的 BEP20 到账，开关关闭也不 stranded
  evmState.latestBlock = 10000;
  evmState.logs = [{ address: BEP20_USDT, blockNumber: '0x' + (9980).toString(16), transactionHash: '0x' + 'e'.repeat(64), logIndex: '0x0', topics: [TOPIC0, '0x' + '0'.repeat(64), toTopic(ADDR_NEW_B)], data: '0x' + amountToRaw(Number(ord.actual_amount), 18).toString(16).padStart(64, '0') }];
  await runPoll();
  const after = q('SELECT * FROM orders WHERE order_no=?', globalThis.__existingBep20.order_no);
  assert(after && after.status === 'completed' && (after.delivery_content || '').startsWith('PAYCFG-KEY-'), '8. polling still fulfills existing order after switch-off: ' + (after && after.status));
}

// ===== 9. 重新开启 + 新地址：付款页下发地址与新订单地址一致 =====
{
  r = await call('POST', '/api/admin/pay-config', { xlayer_address: ADDR_NEW_X2, xlayer_enabled: '1', bep20_enabled: '1' }, cookie);
  assert(r.json && r.json.ok, '9. re-enable ok');
  r = await call('GET', '/api/config');
  assert(payEntry(r.json.config, 'X Layer').address === ADDR_NEW_X2 && payEntry(r.json.config, 'X Layer').enabled === true, '9. config shows re-enabled X Layer new address');
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(r.json && r.json.ok && r.json.order.pay_address === ADDR_NEW_X2, '9. new order pay_address = re-enabled new address');
}

// ===== 10. 普通设置接口写 pay 键：同样校验 + 掩码审计 =====
{
  r = await call('POST', '/api/admin/settings', { settings: { pay_xlayer_address: ADDR_GENERIC, pay_xlayer_enabled: '1' } }, cookie);
  assert(r.json && r.json.ok, '10. generic settings pay keys ok');
  r = await call('GET', '/api/config');
  assert(payEntry(r.json.config, 'X Layer').address === ADDR_GENERIC, '10. generic settings pay address reflected in config');
  const audit = q('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 1');
  assert(audit && !String(audit.note || '').includes(ADDR_GENERIC), '10. generic settings audit masks full address');
}

// ===== 11. 权限：非管理员不能读/改配置；响应不含 Key =====
{
  r = await call('GET', '/api/admin/pay-config');
  assert(r.status === 401 && !(r.json && r.json.ok), '11. GET pay-config without auth -> 401');
  r = await call('POST', '/api/admin/pay-config', { xlayer_enabled: '0' });
  assert(r.status === 401, '11. POST pay-config without auth -> 401');
  r = await call('POST', '/api/admin/prodseller/test-connection', {});
  assert(r.status === 401, '11. POST test-connection without auth -> 401');
  r = await call('POST', '/api/admin/settings', { settings: { pay_xlayer_enabled: '0' } });
  assert(r.status === 401, '11. POST settings pay keys without auth -> 401');
  r = await call('GET', '/api/config');
  assert(!JSON.stringify(r.json).includes('test-key'), '11. /api/config response contains no API Key');
  r = await call('GET', '/api/admin/settings', undefined, cookie);
  assert(!JSON.stringify(r.json).includes('test-key'), '11. /api/admin/settings response contains no API Key');
  assert(r.json && r.json.prodseller_api_key_configured === true, '11. /api/admin/settings exposes only boolean key status');
  r = await call('GET', '/api/admin/pay-config', undefined, cookie);
  assert(r.json && r.json.prodseller && r.json.prodseller.api_key_configured === true && !JSON.stringify(r.json).includes('test-key'), '11. /api/admin/pay-config exposes only boolean key status');
}

// ===== 12. 测试连接：成功 / 失败 / 未配置 / 限流，均不触发采购 =====
{
  const beforeBalance = balanceCalls;
  r = await call('POST', '/api/admin/prodseller/test-connection', {}, cookie, { 'X-Forwarded-For': '10.0.0.11' });
  assert(r.json && r.json.ok === true && r.json.configured === true && r.json.balance && r.json.balance.balance === 123.45, '12. test-connection success returns balance: ' + JSON.stringify(r.json));
  assert(!JSON.stringify(r.json).includes('test-key'), '12. test-connection success response contains no Key');
  assert(balanceCalls === beforeBalance + 1, '12. test-connection success made exactly 1 upstream call');
  assert(upstreamPostCalls === 0, '12. test-connection never triggers purchase (POST /orders = 0)');
  balanceShouldFail = true;
  r = await call('POST', '/api/admin/prodseller/test-connection', {}, cookie, { 'X-Forwarded-For': '10.0.0.12' });
  assert(r.json && r.json.ok === false && /失败/.test(r.json.error || '') && !JSON.stringify(r.json).includes('test-key'), '12. test-connection failure returns error without Key: ' + JSON.stringify(r.json));
  assert(upstreamPostCalls === 0, '12. test-connection failure still never triggers purchase');
  balanceShouldFail = false;
  // 未配置：删 env Key，不发起真实调用
  const savedKey = env.PRODSELLER_API_KEY;
  const beforeUnconf = balanceCalls;
  delete env.PRODSELLER_API_KEY;
  r = await call('POST', '/api/admin/prodseller/test-connection', {}, cookie, { 'X-Forwarded-For': '10.0.0.13' });
  assert(r.json && r.json.ok === false && r.json.configured === false && /未配置/.test(r.json.error || ''), '12. test-connection unconfigured returns 未配置 without fetch: ' + JSON.stringify(r.json));
  assert(balanceCalls === beforeUnconf, '12. unconfigured test-connection made 0 upstream calls');
  env.PRODSELLER_API_KEY = savedKey;
  // 限流：同一 IP 10 次/10 分钟，第 11 次 429
  let okCount = 0; let rateLimited = false;
  for (let i = 0; i < 11; i++) {
    r = await call('POST', '/api/admin/prodseller/test-connection', {}, cookie, { 'X-Forwarded-For': '10.0.0.99' });
    if (r.status === 429) rateLimited = true;
    else if (r.json && r.json.ok) okCount++;
  }
  assert(okCount === 10 && rateLimited, '12. test-connection rate limited: 10 ok then 429 (okCount=' + okCount + ')');
  assert(upstreamPostCalls === 0, '12. final: no purchase triggered by any test-connection');
}

// ===== 13. 前端无硬编码：无 0x40 地址 / 无上游域名 / 无 Key；含新 UI 入口 =====
{
  const fe = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
  assert(!/0x[0-9a-fA-F]{40}/.test(fe), '13. frontend has no hardcoded 0x+40 address');
  assert(!/prodseller\.com/.test(fe), '13. frontend has no hardcoded ProdSeller API URL');
  assert(!/PRODSELLER_API_KEY/.test(fe), '13. frontend has no API Key reference');
  assert(!/X-API-Key/.test(fe), '13. frontend has no X-API-Key header');
  assert(fe.includes('收款暂未开放'), '13. frontend shows 收款暂未开放');
  assert(fe.includes('/api/admin/pay-config'), '13. frontend calls /api/admin/pay-config');
  assert(fe.includes('/api/admin/prodseller/test-connection'), '13. frontend calls test-connection');
  assert(fe.includes('payXlayerAddress') && fe.includes('payBep20Address'), '13. frontend has per-chain address inputs');
  assert(fe.includes('payXlayerEnabled') && fe.includes('payBep20Enabled'), '13. frontend has per-chain switches');
  assert(fe.includes('已配置/未配置') || fe.includes('已配置'), '13. frontend shows Key configured status text');
}

console.log('pay-config-test: all assertions passed');
