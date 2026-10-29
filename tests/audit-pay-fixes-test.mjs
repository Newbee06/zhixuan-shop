// 审计支付修复回归测试（2026-10-30，工作树 audit-pay）
// 覆盖 15 项审计修复，全部 Mock，不访问真实上游/链上，不用真实密钥与地址。
// 运行：node tests/audit-pay-fixes-test.mjs
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
const ADDR_MIXED = '0x' + 'Ab'.repeat(20);
const ADDR_LOWER = '0x' + 'ab'.repeat(20);
const USDT0_XLAYER = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
const TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function toTopic(addr) { return '0x' + '0'.repeat(24) + String(addr).slice(2).toLowerCase(); }
function amountToRaw(amount, decimals) {
  const s = String(amount); const parts = s.split('.');
  const intPart = parts[0] || '0'; let fracPart = parts[1] || '';
  if (fracPart.length > decimals) fracPart = fracPart.slice(0, decimals);
  while (fracPart.length < decimals) fracPart += '0';
  return BigInt(intPart) * (10n ** BigInt(decimals)) + BigInt(fracPart || '0');
}
const SUSPECT_TX = 'd'.repeat(64);
let evmState = { tx: '', amount: 0, block: 9000, addr: ADDR_LOWER };
let psMode = 'delivered';
let logsMode = { on: false, tx: '', amount: 0, block: 9000 };
async function mockFetch(url, opts = {}) {
  const u = String(url); const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('api.resend.com')) return new Response(JSON.stringify({ id: 'mock-mail' }), { status: 200 });
  if (u.includes('prodseller.com/v1/orders') && method === 'POST') {
    if (psMode === 'hang') return new Promise((_, rej) => { const sig = opts.signal; if (sig) sig.addEventListener('abort', () => rej(new Error('The operation was aborted'))); });
    if (psMode === '403') return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    if (psMode === 'paid') return new Response(JSON.stringify({ id: 'PS-PAID-1', status: 'paid' }), { status: 200 });
    if (psMode === 'delivered-dup') return new Response(JSON.stringify({ id: 'PS-DUP-1', status: 'delivered', deliveredKeys: ['K1', 'K1', 'K2'] }), { status: 200 });
    return new Response(JSON.stringify({ id: 'PS-TEST-1', status: 'delivered', delivered_keys: 'UP-KEY-A\nUP-KEY-B' }), { status: 200 });
  }
  if (u.includes('prodseller.com/v1/orders/') && method === 'GET') {
    if (psMode === 'hang') return new Promise((_, rej) => { const sig = opts.signal; if (sig) sig.addEventListener('abort', () => rej(new Error('The operation was aborted'))); });
    if (psMode === '404') return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    if (psMode === 'paid') return new Response(JSON.stringify({ id: 'PS-PAID-1', status: 'paid' }), { status: 200 });
    if (psMode === 'delivered-dup') return new Response(JSON.stringify({ id: 'PS-DUP-1', status: 'delivered', deliveredKeys: ['K1', 'K1', 'K2'] }), { status: 200 });
    return new Response(JSON.stringify({ id: 'PS-TEST-1', status: 'delivered', delivered_keys: 'UP-KEY-A\nUP-KEY-B' }), { status: 200 });
  }
  if (u.includes('prodseller.com/v1/balance') && method === 'GET') return new Response(JSON.stringify({ balance: 123.45 }), { status: 200 });
  if (u.includes('mock-xlayer') || u.includes('mock-bsc')) {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (body && body.method === 'eth_chainId') {
      const id = u.includes('mock-bsc') ? '0x38' : '0xc4';
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: id }), { status: 200 });
    }
    if (body && body.method === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (10000).toString(16) }), { status: 200 });
    if (body && body.method === 'eth_call') {
      const to = String((body.params && body.params[0] && body.params[0].to) || '').toLowerCase();
      const dec = to === USDT0_XLAYER.toLowerCase() ? 6 : 18;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + dec.toString(16).padStart(64, '0') }), { status: 200 });
    }
    if (body && body.method === 'eth_getTransactionReceipt') {
      const reqTx = String(body.params && body.params[0]).toLowerCase().replace(/^0x/, '');
      if (reqTx === SUSPECT_TX) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
      // 双链并发测试需要：BEP20 收据用 BEP20 合约/地址/18 位精度，X Layer 用 USDT0/6 位。
      const isBsc = u.includes('mock-bsc');
      const rcContract = isBsc ? '0x55d398326f99059fF775485246999027B3197955' : USDT0_XLAYER;
      const rcAddr = isBsc ? '0x2222222222222222222222222222222222222222' : evmState.addr;
      const rcDec = isBsc ? 18 : 6;
      const receipt = {
        status: '0x1', blockNumber: '0x' + (evmState.block).toString(16), transactionHash: evmState.tx,
        logs: [{ address: rcContract, blockNumber: '0x' + (evmState.block).toString(16), transactionHash: evmState.tx, logIndex: '0x0',
          topics: [TOPIC0, '0x' + '0'.repeat(64), toTopic(rcAddr)],
          data: '0x' + amountToRaw(evmState.amount, rcDec).toString(16).padStart(64, '0') }],
      };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: receipt }), { status: 200 });
    }
    if (body && body.method === 'eth_getLogs') {
      if (logsMode.on) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{
          address: USDT0_XLAYER, blockNumber: '0x' + (logsMode.block).toString(16), transactionHash: '0x' + logsMode.tx, logIndex: '0x0',
          topics: [TOPIC0, '0x' + '0'.repeat(64), toTopic(ADDR_LOWER)],
          data: '0x' + amountToRaw(logsMode.amount, 6).toString(16).padStart(64, '0') }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
  }
  return new Response(JSON.stringify({}), { status: 200 });
}
globalThis.fetch = mockFetch;
const env = {
  DB: { prepare: (sql) => wrapStmt(sql), async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } },
  ZHIXUAN_SETUP_TOKEN: 'test-setup-token',
  PRODSELLER_API_KEY: 'test-ps-key',
  PRODSELLER_BASE_URL: 'https://prodseller.com/v1',
  __fetch: mockFetch,
};
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
async function scheduled() { const ctx = makeCtx(); await worker.scheduled({ cron: '*/1 * * * *' }, env, ctx); await ctx.drain(); }
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); } console.log('PASS: ' + msg); }
function q(sql, ...a) { return db.prepare(sql).get(...a); }
function qa(sql, ...a) { return db.prepare(sql).all(...a); }
function setSetting(key, value) { db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
let capSeq = 0;
function mkCaptcha(codeStr) {
  const id = 'cap-ap-' + (++capSeq);
  const h = createHash('sha256').update(codeStr).digest('hex');
  const exp = new Date(Date.now() + 300000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?,?,0)').run(id, h, exp);
  return id;
}
let contactSeq = 0;
function freshContact() { return 'apfix' + (++contactSeq) + '@test.example'; }
async function orderCall(payMethod, payChain, productId) {
  const cid = mkCaptcha('AB12');
  db.prepare('DELETE FROM order_rate').run();
  const c = freshContact();
  return call('POST', '/api/orders', { product_id: productId, quantity: 1, contact: c, query_password: 'test-query-password-123', pay_method: payMethod, pay_chain: payChain, captcha_id: cid, captcha_code: 'AB12' });
}
let ipSeq = 0;
async function payCall(orderNo, txid) {
  const cid = mkCaptcha('AB12');
  db.prepare('DELETE FROM pay_rate').run();
  const ip = '10.9.0.' + (++ipSeq);
  return call('POST', '/api/orders/' + encodeURIComponent(orderNo) + '/pay', { txid, captcha_id: cid, captcha_code: 'AB12' }, undefined, { 'x-forwarded-for': ip });
}
async function adminCall(method, p, body, cookie) { return call(method, p, body, cookie); }

// ---- 基础设置（收款地址故意用混合大小写，验证小写落库） ----
setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_MIXED, 'Binance|BEP20': '0x2222222222222222222222222222222222222222' }));
setSetting('rpc_urls', JSON.stringify({ 'X Layer': ['https://mock-xlayer'], 'BEP20': ['https://mock-bsc'] }));
setSetting('poll_enabled', '1');
setSetting('prodseller_enabled', '1');
let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
assert(r.json && r.json.ok, 'admin login');
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await call('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'test-admin-password-123' }, cookie);
assert(r.json && r.json.ok, 'change-password');
cookie = (r.headers.get('set-cookie') || '').split(';')[0] || cookie;

r = await call('POST', '/api/admin/products', { slug: 'ap-card', title: 'AP Card', category: 'card', price_usdt: 10, sell_price: 10, source: 'self', delivery_method: 'both', stock_type: 'card', form_fields: [] }, cookie);
assert(r.json && r.json.ok, 'create card product');
const cardProd = q('SELECT * FROM products WHERE slug=?', 'ap-card');
for (let i = 1; i <= 60; i++) db.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(cardProd.id, 'AP-KEY-' + String(i).padStart(3, '0'));
r = await call('POST', '/api/admin/products', { slug: 'ap-bigcard', title: 'AP BigCard', category: 'card', price_usdt: 200, sell_price: 200, source: 'self', delivery_method: 'both', stock_type: 'card', form_fields: [] }, cookie);
assert(r.json && r.json.ok, 'create big card product');
const bigProd = q('SELECT * FROM products WHERE slug=?', 'ap-bigcard');
for (let i = 1; i <= 10; i++) db.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(bigProd.id, 'BIG-KEY-' + i);
r = await call('POST', '/api/admin/products', { slug: 'ap-manual', title: 'AP Manual', category: 'recharge', price_usdt: 10, sell_price: 10, source: 'self', delivery_method: 'both', stock_type: 'manual', form_fields: [] }, cookie);
assert(r.json && r.json.ok, 'create manual product');
const manualProd = q('SELECT * FROM products WHERE slug=?', 'ap-manual');
r = await call('POST', '/api/admin/products', { slug: 'ap-up', title: 'AP Upstream', category: 'recharge', price_usdt: 10, sell_price: 10, source: 'prodseller', prodseller_id: 'PS-AP', delivery_method: 'both', stock_type: 'manual', form_fields: [] }, cookie);
assert(r.json && r.json.ok, 'create upstream product');
const upProd = q('SELECT * FROM products WHERE slug=?', 'ap-up');

// ===== 1. 确认数：默认 12 + 显式配置优先于大额分级 =====
{
  setSetting('chain_confirmations', '{}');
  db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run('large_order_usdt', 'large_order_confirmations');
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(r.json && r.json.ok, '1 O1 created');
  const o1 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const T1 = 'e'.repeat(64);
  evmState = { tx: '0x' + T1, amount: Number(o1.actual_amount), block: 9995, addr: ADDR_LOWER };
  r = await payCall(o1.order_no, '0x' + T1);
  assert(r.json && r.json.ok && r.json.auto === false, '1 default 12 rejects 5-conf payment (candidate only): ' + JSON.stringify(r.json));
  assert(q('SELECT status FROM orders WHERE id=?', o1.id).status === 'pending_payment', '1 O1 still pending_payment at 5 conf');
  setSetting('chain_confirmations', JSON.stringify({ 'X Layer': 3 }));
  r = await payCall(o1.order_no, '0x' + T1);
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), '1 explicit 3 accepts 5-conf payment: ' + JSON.stringify(r.json));
  const o1a = q('SELECT * FROM orders WHERE id=?', o1.id);
  assert(o1a.status === 'completed' && o1a.tx_hash === T1, '1 O1 completed, tx_hash bare: ' + o1a.tx_hash);
  // 大额 + 显式：显式 3 优先于大额 12
  setSetting('large_order_usdt', '100');
  setSetting('large_order_confirmations', '12');
  r = await orderCall('OKX', 'X Layer', bigProd.id);
  assert(r.json && r.json.ok, '1 O2 created');
  const o2 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  assert(Number(o2.actual_amount) >= 100, '1 O2 is large order: ' + o2.actual_amount);
  evmState = { tx: '0x' + 'f'.repeat(64), amount: Number(o2.actual_amount), block: 9995, addr: ADDR_LOWER };
  r = await payCall(o2.order_no, 'f'.repeat(64));
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), '1 explicit beats large tier (5 conf fulfills large order): ' + JSON.stringify(r.json));
  // 无显式时大额分级生效：5 conf 被 12 挡住，1000 conf 通过
  setSetting('chain_confirmations', '{}');
  r = await orderCall('OKX', 'X Layer', bigProd.id);
  assert(r.json && r.json.ok, '1 O3 created');
  const o3 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  evmState = { tx: '0x' + 'a'.repeat(64), amount: Number(o3.actual_amount), block: 9995, addr: ADDR_LOWER };
  r = await payCall(o3.order_no, 'a'.repeat(64));
  assert(r.json && r.json.ok && r.json.auto === false, '1 large tier blocks 5-conf without explicit config');
  evmState = { tx: '0x' + 'a'.repeat(64), amount: Number(o3.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(o3.order_no, 'a'.repeat(64));
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), '1 large tier passes at 1000 conf');
  setSetting('chain_confirmations', JSON.stringify({ 'X Layer': 1, 'BEP20': 15 }));
}

// ===== 2. 收款地址小写落库 =====
{
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(r.json && r.json.ok, '2 order created');
  const ol = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  assert(ol.pay_address === ADDR_LOWER, '2 pay_address lowercase: ' + ol.pay_address);
  assert(ol.wallet_address === ADDR_LOWER, '2 wallet_address lowercase: ' + ol.wallet_address);
  const snap = JSON.parse(ol.product_snapshot || '{}');
  assert(snap.pay_address === ADDR_LOWER && snap.stock_type === 'card', '2 snapshot lowercase address + stock_type: ' + ol.product_snapshot);
}

// ===== 15. 跨形态并发：裸形与带 0x 形并发只能产生一行认领 =====
{
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  const oa = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  // 第二单走 BEP20：收款地址不同，(pay_address, actual_amount) 待付款唯一索引不冲突；
  // 但 txid_claims 与认领防重是全局（不分链）的，同一笔哈希仍只能被一单认领。
  r = await orderCall('Binance', 'BEP20', cardProd.id);
  const ob = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.prepare('UPDATE orders SET actual_amount=? WHERE id=?').run(Number(oa.actual_amount), ob.id);
  const TXC = 'a1b2c3d4'.repeat(8);
  evmState = { tx: '0x' + TXC, amount: Number(oa.actual_amount), block: 9000, addr: ADDR_LOWER };
  let arrived = 0; let releaseFn;
  const released = new Promise((res) => { releaseFn = res; });
  env.__testHooks = { beforeTxidInsert: async () => { arrived++; if (arrived >= 2) releaseFn(); else await released; } };
  const [ra, rb] = await Promise.all([payCall(oa.order_no, '0x' + TXC), payCall(ob.order_no, TXC)]);
  env.__testHooks = {};
  const okOne = (ra.json && ra.json.ok && /已自动发货/.test(ra.json.message || '')) || (rb.json && rb.json.ok && /已自动发货/.test(rb.json.message || ''));
  const badOne = ra.status === 409 || rb.status === 409;
  assert(okOne && badOne, '15 concurrent bare vs prefixed: one fulfills, one 409: ' + JSON.stringify([ra.status, rb.status]));
  const claims = qa('SELECT * FROM txid_claims WHERE tx_hash=?', TXC);
  assert(claims.length === 1, '15 exactly one bare claim: ' + JSON.stringify(claims.map((x) => x.tx_hash)));
  assert(qa('SELECT * FROM txid_claims WHERE tx_hash=?', '0x' + TXC).length === 0, '15 no prefixed claim row');
  // 遗留认领行改写：0x 形认领被本单收养后改写为规范形
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  const oc = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const TXL = '8'.repeat(64);
  db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?, ?, ?, ?, ?, ?)').run('0x' + TXL, oc.id, '2026-01-01 00:00:00', 'tok-legacy', 'chain_verified', '');
  evmState = { tx: '0x' + TXL, amount: Number(oc.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(oc.order_no, TXL);
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), '15 legacy claim adopted: ' + JSON.stringify(r.json));
  assert(qa('SELECT * FROM txid_claims WHERE tx_hash=?', TXL).length === 1, '15 legacy claim rewritten to bare');
  assert(qa('SELECT * FROM txid_claims WHERE tx_hash=?', '0x' + TXL).length === 0, '15 no prefixed claim left');
  // 遗留账本行改写：0x 形 unmatched 行被收养后改写为规范形
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  const od = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const TXP = '7'.repeat(64);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, status, reconcile_status) VALUES (NULL, 'X Layer', ?, ?, '', ?, 'unmatched', '')").run(ADDR_LOWER, '0x' + TXP, Number(od.actual_amount));
  evmState = { tx: '0x' + TXP, amount: Number(od.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(od.order_no, TXP);
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), '15 legacy ledger adopted: ' + JSON.stringify(r.json));
  const ledP = q('SELECT * FROM payments WHERE tx_hash=?', TXP);
  assert(ledP && ledP.status === 'posted' && Number(ledP.order_id) === Number(od.id), '15 legacy ledger rewritten bare + posted');
}

// ===== 3. 扫描漏单兜底：超窗口 unmatched 行被重匹配找回 =====
{
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  const oor = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const TXR = '6'.repeat(64);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, block_number, confirmations, status, reconcile_status) VALUES (NULL, 'X Layer', ?, ?, '0x0', ?, 100, 5000, 'unmatched', '')").run(ADDR_LOWER, TXR, Number(oor.actual_amount));
  evmState = { tx: '0x' + TXR, amount: Number(oor.actual_amount), block: 9000, addr: ADDR_LOWER };
  await scheduled();
  const after = q('SELECT * FROM orders WHERE id=?', oor.id);
  assert(after.status === 'completed' && (after.delivery_content || '').startsWith('AP-KEY-'), '3 over-window unmatched rematched to completed');
  const rowR = q('SELECT * FROM payments WHERE tx_hash=?', TXR);
  assert(rowR && rowR.status === 'posted', '3 rematched ledger posted');
  // 扫描回填：submitted 行 event_key 被回填（先清游标，保证本轮扫描覆盖到 9000 区块）
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  const os = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const TXS = '5'.repeat(64);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, status, reconcile_status) VALUES (?, 'X Layer', ?, ?, '', ?, 'submitted', '')").run(os.id, ADDR_LOWER, TXS, Number(os.actual_amount));
  // 回填真场景：日志区块 100 在逐单 2000 区块回溯窗口之外（逐单核验 miss），但在扫描游标范围内（游标倒回 50），
  // 只有扫描回填能把 submitted 行的 event_key 补上；此前逐单已建同事件行的场景下回填会撞唯一索引，属预期内失败。
  db.prepare("INSERT INTO scan_cursors (chain, last_block, updated_at) VALUES (?, 50, ?) ON CONFLICT(chain) DO UPDATE SET last_block=50").run('X Layer|' + ADDR_LOWER, '2026-01-01 00:00:00');
  logsMode = { on: true, tx: TXS, amount: Number(os.actual_amount), block: 100 };
  await scheduled();
  logsMode = { on: false, tx: '', amount: 0, block: 9000 };
  const osAfter = q('SELECT * FROM orders WHERE id=?', os.id);
  assert(osAfter.status === 'completed', '3 scan-backfill order completed');
  const rowS = q('SELECT * FROM payments WHERE tx_hash=? AND order_id=?', TXS, os.id);
  assert(rowS && rowS.event_key === '0x0' && rowS.status === 'posted', '3 submitted ledger event_key backfilled + posted: ' + (rowS && rowS.event_key) + '/' + (rowS && rowS.status));
}

// ===== 4. 管理端恢复：mismatch / 已取消 / refund_pending 第二笔 =====
let ofOrder;
{
  // 4a mismatch 履约：账本金额与预期不符，但链上实收等于预期时经重验转为 verified 并履约
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  const om = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, status, reconcile_status, reconcile_note) VALUES (?, 'X Layer', ?, ?, '', ?, 'mismatch', 'pending', '金额与订单预期不符，需人工对账')").run(om.id, ADDR_LOWER, '4'.repeat(64), Number(om.actual_amount) + 1);
  const misRow = q('SELECT * FROM payments WHERE tx_hash=?', '4'.repeat(64));
  evmState = { tx: '0x' + '4'.repeat(64), amount: Number(om.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await adminCall('POST', '/api/admin/orders/' + om.id + '/adopt-payment', { payment_id: misRow.id, mode: 'fulfill' }, cookie);
  assert(r.json && r.json.ok, '4a adopt mismatch fulfills: ' + JSON.stringify(r.json));
  assert(q('SELECT status FROM orders WHERE id=?', om.id).status === 'completed', '4a mismatch order completed');
  const misAfter = q('SELECT * FROM payments WHERE id=?', misRow.id);
  assert(misAfter.status === 'verified' || misAfter.status === 'posted', '4a mismatch row converted: ' + misAfter.status);
  // 4b 过期后到账的已取消订单：公开 /pay 仍拒绝，只有管理员接口能恢复
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  const ox = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  r = await adminCall('POST', '/api/admin/orders/' + ox.id + '/cancel', { reason: 'test cancel' }, cookie);
  assert(r.json && r.json.ok, '4b cancel ok: ' + JSON.stringify(r.json));
  evmState = { tx: '0x' + '3'.repeat(64), amount: Number(ox.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(ox.order_no, '3'.repeat(64));
  assert(r.json && !r.json.ok && /已取消/.test(r.json.error || ''), '4b public pay still rejects cancelled: ' + JSON.stringify(r.json));
  r = await adminCall('POST', '/api/admin/orders/' + ox.id + '/adopt-payment', { tx_hash: '3'.repeat(64), mode: 'fulfill' }, cookie);
  assert(r.json && r.json.ok, '4b admin adopt revives cancelled: ' + JSON.stringify(r.json));
  assert(q('SELECT status FROM orders WHERE id=?', ox.id).status === 'completed', '4b cancelled order revived to completed');
  assert(qa('SELECT * FROM txid_claims WHERE tx_hash=?', '3'.repeat(64)).length === 1, '4b revived claim bare');
  // 4c refund_pending 第二笔付款：实收额入账，不过预期额
  r = await orderCall('OKX', 'X Layer', manualProd.id);
  ofOrder = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  evmState = { tx: '0x' + '2'.repeat(64), amount: Number(ofOrder.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(ofOrder.order_no, '2'.repeat(64));
  assert(r.json && r.json.ok && /等待人工代充/.test(r.json.message || ''), '4c manual order pending_fulfill: ' + JSON.stringify(r.json));
  r = await adminCall('POST', '/api/admin/orders/' + ofOrder.id + '/exception', { reason: 'test exception', refund_needed: true }, cookie);
  assert(r.json && r.json.ok, '4c exception to refund_pending: ' + JSON.stringify(r.json));
  assert(q('SELECT status FROM orders WHERE id=?', ofOrder.id).status === 'refund_pending', '4c order refund_pending');
  const secondAmt = Number(ofOrder.actual_amount) + 2;
  evmState = { tx: '0x' + '1'.repeat(64), amount: secondAmt, block: 9000, addr: ADDR_LOWER };
  r = await adminCall('POST', '/api/admin/orders/' + ofOrder.id + '/adopt-payment', { tx_hash: '1'.repeat(64), mode: 'fulfill' }, cookie);
  assert(r.json && r.json.ok, '4c adopt second payment: ' + JSON.stringify(r.json));
  const secondRow = q('SELECT * FROM payments WHERE tx_hash=?', '1'.repeat(64));
  assert(secondRow && secondRow.status === 'verified' && secondRow.reconcile_status === 'overpaid_pending', '4c second row overpaid_pending');
  assert(secondRow && Math.abs(Number(secondRow.amount) - secondAmt) < 0.000001, '14 second row records real received amount: ' + (secondRow && secondRow.amount));
  assert(q('SELECT status FROM orders WHERE id=?', ofOrder.id).status === 'refund_pending', '4c order stays refund_pending');
}

// ===== 4d. refund-confirm：有超额行时拒绝；无超额行时追加备注不覆盖超额前缀 =====
{
  r = await adminCall('POST', '/api/admin/orders/' + ofOrder.id + '/refund-confirm', { refund_ref: 'REF-1', note: 'refund-note-xyz' }, cookie);
  assert(r.json && !r.json.ok && /超额付款/.test(r.json.error || ''), '4d refund-confirm blocked by overpaid row: ' + JSON.stringify(r.json));
  const secondRow = q('SELECT * FROM payments WHERE tx_hash=?', '1'.repeat(64));
  r = await adminCall('POST', '/api/admin/payments/' + secondRow.id + '/reconcile', { note: 'second payment reconciled' }, cookie);
  assert(r.json && r.json.ok, '4d reconcile overpaid row: ' + JSON.stringify(r.json));
  r = await adminCall('POST', '/api/admin/orders/' + ofOrder.id + '/refund-confirm', { refund_ref: 'REF-1', note: 'refund-note-xyz' }, cookie);
  assert(r.json && r.json.ok, '4d refund-confirm after reconcile: ' + JSON.stringify(r.json));
  const ofAfter = q('SELECT * FROM orders WHERE id=?', ofOrder.id);
  assert(ofAfter.status === 'cancelled', '4d order cancelled after refund-confirm');
  assert((ofAfter.admin_note || '').indexOf('【超额付款待对账】') !== -1, '4d overpaid prefix preserved: ' + ofAfter.admin_note);
  assert((ofAfter.admin_note || '').indexOf('refund-note-xyz') !== -1, '4d refund note appended: ' + ofAfter.admin_note);
  r = await payCall(ofOrder.order_no, '2'.repeat(64));
  assert(r.json && !r.json.ok && /已取消/.test(r.json.error || ''), '4d public pay rejects cancelled after refund');
}

// ===== 5. 第二笔经 /pay 复用旧行收养 + alreadySettled 补标 posted =====
{
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  const ot = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  evmState = { tx: '0x' + 'c'.repeat(64), amount: Number(ot.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(ot.order_no, 'c'.repeat(64));
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), '5 first payment completes');
  const deliveryBefore = q('SELECT delivery_content FROM orders WHERE id=?', ot.id).delivery_content;
  // /pay 证据 event_key 为空，故预置旧行 event_key 同为空时才构成“复用旧行”（同交易不同 logIndex 属不同事件，不得混用）。
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, status, reconcile_status) VALUES (NULL, 'X Layer', ?, ?, '', ?, 'unmatched', '')").run(ADDR_LOWER, 'b'.repeat(64), Number(ot.actual_amount));
  evmState = { tx: '0x' + 'b'.repeat(64), amount: Number(ot.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(ot.order_no, 'b'.repeat(64));
  assert(r.json && r.json.ok && r.json.overpaid === true, '5 second payment overpaid flag: ' + JSON.stringify(r.json));
  const sRow = q('SELECT * FROM payments WHERE tx_hash=?', 'b'.repeat(64));
  assert(sRow && sRow.status === 'verified' && sRow.reconcile_status === 'overpaid_pending' && Number(sRow.order_id) === Number(ot.id), '5 second old row adopted via updatePayment');
  assert(q('SELECT delivery_content FROM orders WHERE id=?', ot.id).delivery_content === deliveryBefore, '5 no duplicate delivery');
  // alreadySettled：verified 未 posted + pending_activation，早返后补标 posted
  r = await orderCall('OKX', 'X Layer', upProd.id);
  const ou = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const TXP2 = '9'.repeat(64);
  db.prepare('UPDATE orders SET status=? WHERE id=?').run('pending_activation', ou.id);
  db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?, ?, ?, ?, ?, ?)').run(TXP2, ou.id, '2026-01-01 00:00:00', 'tok-p', 'chain_verified', '');
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, status, reconcile_status) VALUES (?, 'X Layer', ?, ?, '0x0', ?, 'verified', '')").run(ou.id, ADDR_LOWER, TXP2, Number(ou.actual_amount));
  evmState = { tx: '0x' + TXP2, amount: Number(ou.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(ou.order_no, TXP2);
  assert(r.json && r.json.ok, '5 alreadySettled pay ok: ' + JSON.stringify(r.json));
  const pRow = q('SELECT * FROM payments WHERE tx_hash=?', TXP2);
  assert(pRow && pRow.status === 'posted', '5 alreadySettled row marked posted');
}

// ===== 5b. mismatch 受控重验入口 =====
{
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  const orv = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const TXRV = '0badf00d'.repeat(8);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, status, reconcile_status, reconcile_note) VALUES (?, 'X Layer', ?, ?, '', ?, 'mismatch', 'pending', '金额不符')").run(orv.id, ADDR_LOWER, TXRV, Number(orv.actual_amount) + 3);
  const rvRow = q('SELECT * FROM payments WHERE tx_hash=?', TXRV);
  evmState = { tx: '0x' + TXRV, amount: Number(orv.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await adminCall('POST', '/api/admin/payments/' + rvRow.id + '/reverify', {}, cookie);
  assert(r.json && r.json.ok, '5b reverify mismatch to verified: ' + JSON.stringify(r.json));
  assert(q('SELECT status FROM payments WHERE id=?', rvRow.id).status === 'verified', '5b row verified after reverify');
  r = await adminCall('POST', '/api/admin/payments/' + rvRow.id + '/reverify', {}, cookie);
  assert(r.json && !r.json.ok, '5b reverify non-mismatch rejected');
  r = await payCall(orv.order_no, TXRV);
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), '5b reverified payment fulfills');
}

// ===== 6/9/10. 上游去重 + paid 同步 + 404 阈值 + 限流计数 =====
{
  psMode = 'delivered-dup';
  r = await orderCall('OKX', 'X Layer', upProd.id);
  const ud = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const TXD = 'deadbeef'.repeat(8);
  evmState = { tx: '0x' + TXD, amount: Number(ud.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(ud.order_no, TXD);
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), '6 dedup upstream fulfills: ' + JSON.stringify(r.json));
  const udAfter = q('SELECT * FROM orders WHERE id=?', ud.id);
  assert(udAfter.delivery_content === 'K1\nK2', '6 delivery content deduped: ' + udAfter.delivery_content);
  assert(qa("SELECT * FROM admin_audit WHERE order_id=? AND action='upstream_keys_deduped'", ud.id).length >= 1, '6 dup keys audited');
  // paid 同步：pending_upstream + GET paid -> pending_activation，且失败计数被清零
  psMode = 'paid';
  r = await orderCall('OKX', 'X Layer', upProd.id);
  const up = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.prepare('UPDATE orders SET status=? WHERE id=?').run('pending_upstream', up.id);
  db.prepare('INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, ?, ?, ?, ?)').run(up.id, 'PS-PAID-9', 'pending_upstream', Number(up.actual_amount), '');
  db.prepare('INSERT INTO upstream_cache (key, payload, fetched_at) VALUES (?, ?, ?)').run('upstream_fail:' + up.id, JSON.stringify({ count: 2, nextRetryAt: 9999999999999, lastError: 'x' }), '2026-01-01 00:00:00');
  r = await adminCall('POST', '/api/admin/upstream/orders/' + up.id + '/retry', { reason: 'test paid sync' }, cookie);
  assert(r.json && r.json.ok, '10 paid sync retry ok: ' + JSON.stringify(r.json));
  assert(q('SELECT status FROM orders WHERE id=?', up.id).status === 'pending_activation', '10 GET paid syncs to pending_activation');
  assert(!q('SELECT * FROM upstream_cache WHERE key=?', 'upstream_fail:' + up.id), '10 fail counter cleared on successful paid GET');
  // 限流计数走 pay_rate 条件 INSERT（相对增量）
  const beforeRate = Number((q("SELECT COUNT(*) as c FROM pay_rate WHERE key='upstream:global'").c) || 0);
  r = await adminCall('POST', '/api/admin/upstream/orders/' + up.id + '/retry', { reason: 'test rate' }, cookie);
  assert(r.json && r.json.ok, '11 rate retry ok');
  const afterRate = Number((q("SELECT COUNT(*) as c FROM pay_rate WHERE key='upstream:global'").c) || 0);
  assert(afterRate - beforeRate >= 1, '11 upstream rate counted atomically via pay_rate: ' + beforeRate + ' -> ' + afterRate);
  // 连续 404 达 5 次转人工
  psMode = '404';
  r = await orderCall('OKX', 'X Layer', upProd.id);
  const u4 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.prepare('UPDATE orders SET status=? WHERE id=?').run('pending_activation', u4.id);
  db.prepare('INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, ?, ?, ?, ?)').run(u4.id, 'PS-404-1', 'paid', Number(u4.actual_amount), '');
  for (let i = 0; i < 5; i++) {
    r = await adminCall('POST', '/api/admin/upstream/orders/' + u4.id + '/retry', { reason: 'test 404 ' + i }, cookie);
    assert(r.json && r.json.ok, '10 404 retry ' + i + ' ok');
  }
  const u4After = q('SELECT * FROM orders WHERE id=?', u4.id);
  assert((u4After.admin_note || '').indexOf('上游连续 404') !== -1, '10 404 threshold marks manual: ' + u4After.admin_note);
  assert(qa("SELECT * FROM admin_audit WHERE order_id=? AND action='upstream_404_manual'", u4.id).length === 1, '10 404 manual audit exactly once');
  // 403 区分：上游 403 -> upstream_error；本地门禁 -> gateway_closed
  psMode = '403';
  setSetting('prodseller_enabled', '1');
  r = await orderCall('OKX', 'X Layer', upProd.id);
  const ug = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const TXUG = 'beefcafe'.repeat(8);
  evmState = { tx: '0x' + TXUG, amount: Number(ug.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(ug.order_no, TXUG);
  assert(r.json && r.json.ok, '7 upstream 403 pay ok');
  const ugUp = q('SELECT * FROM upstream_orders WHERE order_id=?', ug.id);
  assert(ugUp && ugUp.status === 'upstream_error', '7 upstream 403 is upstream_error, not gateway_closed: ' + (ugUp && ugUp.status));
  assert(q('SELECT status FROM orders WHERE id=?', ug.id).status === 'pending_upstream', '7 upstream 403 order pending_upstream');
  // 门禁关闭时上游商品禁下单：先在开闸时下单，再关闸付款，验证履约侧门禁分支
  r = await orderCall('OKX', 'X Layer', upProd.id);
  const ug2 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  setSetting('prodseller_enabled', '0');
  psMode = 'delivered';
  const TXG2 = 'cafe1234'.repeat(8);
  evmState = { tx: '0x' + TXG2, amount: Number(ug2.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(ug2.order_no, TXG2);
  assert(r.json && r.json.ok, '7 gate pay ok');
  const ug2Up = q('SELECT * FROM upstream_orders WHERE order_id=?', ug2.id);
  assert(ug2Up && ug2Up.status === 'gateway_closed', '7 local gate is gateway_closed: ' + (ug2Up && ug2Up.status));
  setSetting('prodseller_enabled', '1');
}

// ===== 13. pending_fulfill 告警 + 补货恢复 =====
{
  psMode = 'delivered';
  r = await call('POST', '/api/admin/products', { slug: 'ap-pf', title: 'AP PF', category: 'card', price_usdt: 10, sell_price: 10, source: 'self', delivery_method: 'both', stock_type: 'card', form_fields: [] }, cookie);
  assert(r.json && r.json.ok, '13 pf product created');
  const pfProd = q('SELECT * FROM products WHERE slug=?', 'ap-pf');
  db.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(pfProd.id, 'PF-ONLY-KEY');
  r = await orderCall('OKX', 'X Layer', pfProd.id);
  const pf = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.prepare('UPDATE cards SET is_disabled=1 WHERE reserved_order_id=? AND is_used=0').run(pf.id);
  const TXPF2 = '0'.repeat(64);
  evmState = { tx: '0x' + TXPF2, amount: Number(pf.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(pf.order_no, TXPF2);
  assert(r.json && r.json.ok && /库存不足/.test(r.json.message || ''), '13 out_of_stock to pending_fulfill: ' + JSON.stringify(r.json));
  assert(q('SELECT status FROM orders WHERE id=?', pf.id).status === 'pending_fulfill', '13 order pending_fulfill');
  r = await adminCall('GET', '/api/admin/upstream/alerts', undefined, cookie);
  assert(r.json && r.json.ok && (r.json.alerts || []).some((a) => a.order_no === pf.order_no && (a.alert_reason || '').indexOf('pending_fulfill') !== -1), '13 pending_fulfill in admin alerts');
  db.prepare('UPDATE cards SET is_disabled=0 WHERE reserved_order_id=? AND is_used=0').run(pf.id);
  db.prepare("UPDATE orders SET claimed_at=datetime('now', '-60 minutes') WHERE id=?").run(pf.id);
  await scheduled();
  const pfAfter = q('SELECT * FROM orders WHERE id=?', pf.id);
  assert(pfAfter.status === 'completed' && pfAfter.delivery_content === 'PF-ONLY-KEY', '13 pending_fulfill recovered after restock: ' + pfAfter.status);
}

// ===== 12. 快照 stock_type 优先 =====
{
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  const ps = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const snap = JSON.parse(ps.product_snapshot || '{}');
  assert(snap.stock_type === 'card', '12 snapshot stock_type card');
  db.prepare('UPDATE products SET stock_type=? WHERE id=?').run('manual', cardProd.id);
  evmState = { tx: '0x' + '6'.repeat(64), amount: Number(ps.actual_amount), block: 9000, addr: ADDR_LOWER };
  // 6 哈希已在第 3 节完成，换新哈希
  const TXPS = '5'.repeat(64);
  // 5 哈希已在第 3 节完成，换新哈希
  const TXPS2 = '4'.repeat(64);
  // 4 哈希已在第 4 节完成，换新哈希
  const TXPS3 = '9'.repeat(64);
  // 9 哈希已在第 5 节完成，换新哈希：使用 b 哈希（第 5 节第二笔）亦已占用；改用全新的 1234 组合需为 64 位十六进制
  const TXPS4 = '1234567890abcdef'.repeat(4);
  evmState = { tx: '0x' + TXPS4, amount: Number(ps.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(ps.order_no, TXPS4);
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), '12 snapshot type wins over live type change: ' + JSON.stringify(r.json));
  db.prepare('UPDATE products SET stock_type=? WHERE id=?').run('card', cardProd.id);
}

// ===== 1b. 已 posted 单重组复核：收据消失标异常 =====
{
  const sus = q('SELECT * FROM payments WHERE tx_hash=?', SUSPECT_TX);
  if (!sus) {
    // 造一个已 posted 行（复核目标）：直接入库，收据 mock 对该哈希返回 null
    const anyOrder = q("SELECT * FROM orders WHERE status='completed' ORDER BY id ASC LIMIT 1");
    db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, block_number, status, reconcile_status) VALUES (?, 'X Layer', ?, ?, '0x0', ?, 9000, 'posted', '')").run(anyOrder.id, ADDR_LOWER, SUSPECT_TX, 10);
  }
  evmState = { tx: '0x' + SUSPECT_TX, amount: 10, block: 9000, addr: ADDR_LOWER };
  await scheduled();
  const susAfter = q('SELECT * FROM payments WHERE tx_hash=?', SUSPECT_TX);
  assert(susAfter && susAfter.reconcile_status === 'reorg_suspect', '1b posted reorg suspect flagged: ' + (susAfter && susAfter.reconcile_status));
  assert(qa("SELECT * FROM admin_audit WHERE action='payment_reorg_suspect'").length >= 1, '1b reorg suspect audited');
}

// ===== 8. 上游 fetch 超时（约 15s，mock 挂起 + abort） =====
{
  psMode = 'hang';
  r = await orderCall('OKX', 'X Layer', upProd.id);
  const uh = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const TXH = 'abcdef0123456789'.repeat(4);
  evmState = { tx: '0x' + TXH, amount: Number(uh.actual_amount), block: 9000, addr: ADDR_LOWER };
  const t0 = Date.now();
  r = await payCall(uh.order_no, TXH);
  const elapsed = Date.now() - t0;
  assert(elapsed >= 14000 && elapsed < 40000, '8 upstream timeout elapsed ~15s: ' + elapsed + 'ms');
  assert(r.json && r.json.ok && /上游处理/.test(r.json.message || ''), '8 timeout degrades to pending_upstream: ' + JSON.stringify(r.json));
  assert(q('SELECT status FROM orders WHERE id=?', uh.id).status === 'pending_upstream', '8 timeout order pending_upstream');
  const uhUp = q('SELECT * FROM upstream_orders WHERE order_id=?', uh.id);
  assert(uhUp && uhUp.status === 'upstream_error', '8 timeout is upstream_error: ' + (uhUp && uhUp.status));
}
console.log('AUDIT PAY FIXES TEST DONE');
