// P1 支付修复回归测试（2026-10-29，分支 fix/p1-payment-20261029）
// 覆盖三项修复，全部 Mock，不访问真实上游/链上：
//  P1-A：扫描先发现的 unmatched 账本行可被匹配订单收养为 verified，不再卡死履约。
//  P1-B：ProdSeller 返回字符串形式 delivered_keys 时不再被丢弃，已 delivered 订单能完成。
//  P1-C：同一笔链上交易以大写/无 0x 变体提交时被认作同一笔，第二单拒绝 409。
// 运行：node tests/p1-payment-fixes-test.mjs
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
const ADDR_OKX = '0x1111111111111111111111111111111111111111';
const ADDR_BIN = '0x2222222222222222222222222222222222222222';
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
// 当前 /pay 应核验到的收据（按订单设置）
let evmState = { tx: '', amount: 0, blockTimeSec: null, extraLogs: [] };
let upstreamDelivered = { status: 'delivered', delivered_keys: 'UP-KEY-A\nUP-KEY-B' };
async function mockFetch(url, opts = {}) {
  const u = String(url); const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('api.resend.com')) return new Response(JSON.stringify({ id: 'mock-mail' }), { status: 200 });
  if (u.includes('prodseller.com/v1/balance') && method === 'GET') return new Response(JSON.stringify({ balance: 123.45 }), { status: 200 });
  if (u.includes('prodseller.com/v1/products') && method === 'GET') return new Response(JSON.stringify([]), { status: 200 });
  if (u.includes('prodseller.com/v1/orders') && method === 'POST') {
    return new Response(JSON.stringify(Object.assign({ id: 'PS-TEST-1' }, upstreamDelivered)), { status: 200 });
  }
  if (u.includes('prodseller.com/v1/orders/') && method === 'GET') return new Response(JSON.stringify(Object.assign({ id: 'PS-TEST-1' }, upstreamDelivered)), { status: 200 });
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
    if (body && body.method === 'eth_getBlockByNumber') {
      const sec = evmState.blockTimeSec != null ? evmState.blockTimeSec : Math.floor(Date.now() / 1000) + 30;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { number: body.params && body.params[0], timestamp: '0x' + sec.toString(16) } }), { status: 200 });
    }
    if (body && body.method === 'eth_getTransactionReceipt') {
      const receipt = {
        status: '0x1', blockNumber: '0x' + (9000).toString(16), transactionHash: evmState.tx,
        logs: [{ address: USDT0_XLAYER, blockNumber: '0x' + (9000).toString(16), transactionHash: evmState.tx, logIndex: '0x0',
          topics: [TOPIC0, '0x' + '0'.repeat(64), toTopic(ADDR_OKX)],
          data: '0x' + amountToRaw(evmState.amount, 6).toString(16).padStart(64, '0') }].concat(evmState.extraLogs || []),
      };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: receipt }), { status: 200 });
    }
    if (body && body.method === 'eth_getLogs') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
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
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); } console.log('PASS: ' + msg); }
function q(sql, ...a) { return db.prepare(sql).get(...a); }
function setSetting(key, value) { db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
let capSeq = 0;
function mkCaptcha(codeStr) {
  const id = 'cap-p1-' + (++capSeq);
  const h = createHash('sha256').update(codeStr).digest('hex');
  const exp = new Date(Date.now() + 300000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?,?,0)').run(id, h, exp);
  return id;
}
let contactSeq = 0;
function freshContact() { return 'p1fix' + (++contactSeq) + '@test.example'; }
async function orderCall(payMethod, payChain, productId) {
  const cid = mkCaptcha('AB12');
  db.prepare('DELETE FROM order_rate').run();
  const c = freshContact();
  return call('POST', '/api/orders', { product_id: productId, quantity: 1, contact: c, query_password: 'test-query-password-123', pay_method: payMethod, pay_chain: payChain, captcha_id: cid, captcha_code: 'AB12' });
}
async function payCall(orderNo, txid) {
  const cid = mkCaptcha('AB12');
  return call('POST', '/api/orders/' + encodeURIComponent(orderNo) + '/pay', { txid, captcha_id: cid, captcha_code: 'AB12' });
}

// ---- 基础设置 ----
setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_OKX, 'Binance|BEP20': ADDR_BIN }));
setSetting('rpc_urls', JSON.stringify({ 'X Layer': ['https://mock-xlayer'], 'BEP20': ['https://mock-bsc'] }));
setSetting('chain_confirmations', JSON.stringify({ 'X Layer': 1, 'BEP20': 15 }));
setSetting('poll_enabled', '1');
setSetting('prodseller_enabled', '0');
let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
assert(r.json && r.json.ok, 'admin login');
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await call('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'test-admin-password-123' }, cookie);
assert(r.json && r.json.ok, 'change-password');
cookie = (r.headers.get('set-cookie') || '').split(';')[0] || cookie;

// 自营卡密商品
r = await call('POST', '/api/admin/products', { slug: 'p1fix-card', title: 'P1Fix Card', category: 'card', price_usdt: 10, sell_price: 10, source: 'self', delivery_method: 'both', stock_type: 'card', form_fields: [] }, cookie);
assert(r.json && r.json.ok, 'create card product: ' + JSON.stringify(r.json));
const cardProd = q('SELECT * FROM products WHERE slug=?', 'p1fix-card');
for (let i = 1; i <= 30; i++) db.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(cardProd.id, 'P1FIX-KEY-' + String(i).padStart(3, '0'));

// ===== P1-A + P1-C：unmatched 行收养 + 大写 TXID 规范化 =====
const TX_CANON = '0x' + 'a'.repeat(64);
const TX_UPPER = '0x' + 'A'.repeat(64);
let ordA;
{
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(r.json && r.json.ok, 'A order created: ' + JSON.stringify(r.json));
  ordA = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  assert(ordA && ordA.pay_address === ADDR_OKX, 'A order pay_address = X Layer address');
  // 模拟扫描先发现：账本里已有一行 unmatched 观察行（当时无归属订单），同一 tx、event_key 为空。
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, status, reconcile_status) VALUES (NULL, ?, ?, ?, '0', ?, 'unmatched', '')").run('X Layer', ADDR_OKX, TX_CANON, Number(ordA.actual_amount));
  evmState = { tx: TX_CANON, amount: Number(ordA.actual_amount) };
  // 用户提交的是大写变体：规范化后应与 unmatched 行同一笔，不产生第二行认领，且履约成功。
  r = await payCall(ordA.order_no, TX_UPPER);
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), 'A /pay uppercase TXID fulfills: ' + JSON.stringify(r.json));
  const afterA = q('SELECT * FROM orders WHERE order_no=?', ordA.order_no);
  assert(afterA && afterA.status === 'completed' && (afterA.delivery_content || '').startsWith('P1FIX-KEY-'), 'A order completed with card key: ' + (afterA && afterA.status));
  assert(afterA && afterA.tx_hash === TX_CANON, 'A order tx_hash stored canonical lowercase: ' + (afterA && afterA.tx_hash));
  const ledRowsA = db.prepare('SELECT * FROM payments WHERE tx_hash=?').all(TX_CANON);
  const ledA = ledRowsA[0];
  assert(ledRowsA.length === 1 && ledA && ledA.event_key === '0' && ledA.status !== 'unmatched' && Number(ledA.order_id) === Number(ordA.id), 'A unmatched logIndex 0 adopted in place: ' + JSON.stringify(ledRowsA));
  const claimsA = db.prepare('SELECT * FROM txid_claims WHERE LOWER(tx_hash)=?').all(TX_CANON);
  assert(claimsA.length === 1 && claimsA[0].tx_hash === TX_CANON, 'A exactly one txid_claim, canonical: ' + JSON.stringify(claimsA.map((x) => x.tx_hash)));
}
// ===== P1-C：同一笔钱第二单再提交（小写）必须 409 =====
{
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(r.json && r.json.ok, 'B order created');
  const ordB = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  // 让 B 的应付金额与 A 同一笔链上金额一致（否则核验本身就过不了，测不到防重）。
  db.prepare('UPDATE orders SET actual_amount=? WHERE order_no=?').run(Number(ordA.actual_amount), ordB.order_no);
  evmState = { tx: TX_CANON, amount: Number(ordA.actual_amount) };
  r = await payCall(ordB.order_no, TX_CANON);
  assert(r.status === 409 && /已用于其他订单/.test((r.json && r.json.error) || ''), 'B /pay same tx lowercase rejected 409: ' + r.status + ' ' + JSON.stringify(r.json));
  const afterB = q('SELECT * FROM orders WHERE order_no=?', ordB.order_no);
  assert(afterB && afterB.status === 'pending_payment', 'B order still pending_payment after 409');
  const claimsB = db.prepare('SELECT * FROM txid_claims WHERE LOWER(tx_hash)=?').all(TX_CANON);
  assert(claimsB.length === 1, 'still exactly one txid_claim after B 409');
}
// ===== P1-C 跨形态：裸哈希认领后，带 0x 形态再提交同一笔必须 409 =====
{
  const TX_BARE = 'c'.repeat(64);
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(r.json && r.json.ok, 'C order created');
  const ordC = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  evmState = { tx: TX_BARE, amount: Number(ordC.actual_amount) };
  r = await payCall(ordC.order_no, 'C'.repeat(64));
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), 'C /pay bare uppercase TXID fulfills: ' + JSON.stringify(r.json));
  const afterC = q('SELECT * FROM orders WHERE order_no=?', ordC.order_no);
  assert(afterC && afterC.tx_hash === '0x' + TX_BARE, 'C order tx_hash stored 0x+lowercase: ' + (afterC && afterC.tx_hash));
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(r.json && r.json.ok, 'D order created');
  const ordD = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.prepare('UPDATE orders SET actual_amount=? WHERE order_no=?').run(Number(ordC.actual_amount), ordD.order_no);
  evmState = { tx: TX_BARE, amount: Number(ordC.actual_amount) };
  r = await payCall(ordD.order_no, '0x' + TX_BARE);
  assert(r.status === 409 && /已用于其他订单/.test((r.json && r.json.error) || ''), 'D /pay prefixed form of same tx rejected 409: ' + r.status + ' ' + JSON.stringify(r.json));
}
// ===== P1-B：上游字符串 delivered_keys 能完成订单 =====
{
  setSetting('prodseller_enabled', '1');
  r = await call('POST', '/api/admin/products', { slug: 'p1fix-up', title: 'P1Fix Upstream', category: 'recharge', price_usdt: 10, sell_price: 10, source: 'prodseller', prodseller_id: 'PS-P1FIX', delivery_method: 'both', stock_type: 'manual', form_fields: [] }, cookie);
  assert(r.json && r.json.ok, 'create upstream product: ' + JSON.stringify(r.json));
  const upProd = q('SELECT * FROM products WHERE slug=?', 'p1fix-up');
  r = await orderCall('OKX', 'X Layer', upProd.id);
  assert(r.json && r.json.ok, 'U order created: ' + JSON.stringify(r.json));
  const ordU = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const TX_U = '0x' + 'b'.repeat(64);
  evmState = { tx: TX_U, amount: Number(ordU.actual_amount) };
  r = await payCall(ordU.order_no, TX_U);
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), 'U /pay fulfills upstream order: ' + JSON.stringify(r.json));
  const afterU = q('SELECT * FROM orders WHERE order_no=?', ordU.order_no);
  assert(afterU && afterU.status === 'completed' && (afterU.delivery_content || '').includes('UP-KEY-A'), 'U order completed with string-form upstream key: ' + (afterU && afterU.status) + ' / ' + (afterU && afterU.delivery_content));
  assert(!(afterU && afterU.status === 'pending_activation'), 'U order not stuck pending_activation');
}
// ===== 并发：带 0x 与不带 0x 只能成功一单，另一单 409 =====
{
  const bare = 'd'.repeat(64);
  const canon = '0x' + bare;
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  const o1 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  const o2 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.exec('DROP INDEX IF EXISTS idx_orders_amount_claim');
  db.prepare('UPDATE orders SET actual_amount=? WHERE id=?').run(Number(o1.actual_amount), o2.id);
  evmState = { tx: canon, amount: Number(o1.actual_amount), blockTimeSec: null };
  let arrivals = 0;
  const waiters = [];
  env.__testHooks = {
    beforeTxidInsert: async () => {
      arrivals++;
      if (arrivals < 2) await new Promise((res) => waiters.push(res));
      else while (waiters.length) waiters.shift()();
    },
  };
  const [p1, p2] = await Promise.all([payCall(o1.order_no, '0x' + 'D'.repeat(64)), payCall(o2.order_no, bare)]);
  env.__testHooks = {};
  assert(arrivals === 2, 'concurrent claims met at insert: ' + arrivals);
  const wins = [p1, p2].filter((x) => x.json && x.json.ok && /已自动发货/.test(x.json.message || ''));
  const loses = [p1, p2].filter((x) => x.status === 409);
  assert(wins.length === 1 && loses.length === 1, 'one fulfill and one 409: ' + JSON.stringify([p1.status, p1.json, p2.status, p2.json]));
  const claims = db.prepare('SELECT tx_hash FROM txid_claims WHERE tx_hash = ? OR tx_hash = ?').all(canon, bare);
  assert(claims.length === 1 && claims[0].tx_hash === canon, 'one canonical claim: ' + JSON.stringify(claims));
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_amount_claim ON orders(pay_address, actual_amount) WHERE status = 'pending_payment' AND pay_method != 'BinanceUID'");
}
// ===== 存量大写行：迁移后变成 0x+小写，等值查询能挡住第二单 =====
{
  const bare = 'e'.repeat(64);
  const upper = '0x' + 'E'.repeat(64);
  const canon = '0x' + bare;
  db.exec('DROP INDEX IF EXISTS idx_txid_claims_canon');
  db.exec('DROP INDEX IF EXISTS idx_payments_canon_event');
  db.prepare('DELETE FROM schema_migrations WHERE version = 21').run();
  db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, source) VALUES (?, ?, datetime(\'now\'), ?)').run(upper, ordA.id, 'chain_verified');
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, status) VALUES (?, 'X Layer', ?, ?, '', 1, 'verified')").run(ordA.id, ADDR_OKX, upper);
  db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, source) VALUES (?, ?, datetime(\'now\'), ?)').run(bare, ordA.id, 'chain_verified');
  const logs = [];
  const origErr = console.error;
  console.error = (...a) => { logs.push(a.map(String).join(' ')); };
  r = await call('POST', '/api/admin/migrate', {}, cookie);
  console.error = origErr;
  assert(r.json && r.json.ok === true, 'same-order uppercase/bare rows migrate: ' + JSON.stringify(r.json) + ' ' + logs.join('\n'));
  const left = db.prepare('SELECT tx_hash, order_id FROM txid_claims WHERE order_id = ? AND (tx_hash = ? OR tx_hash = ? OR tx_hash = ?)').all(ordA.id, upper, bare, canon);
  assert(left.length === 1 && left[0].tx_hash === canon, 'uppercase claim collapsed to canonical: ' + JSON.stringify(left));
  const payLeft = db.prepare("SELECT tx_hash FROM payments WHERE order_id = ? AND event_key = '' AND amount = 1").all(ordA.id);
  assert(payLeft.length === 1 && payLeft[0].tx_hash === canon, 'uppercase payment collapsed to canonical: ' + JSON.stringify(payLeft));
  r = await orderCall('OKX', 'X Layer', cardProd.id);
  const ordE = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  evmState = { tx: canon, amount: Number(ordE.actual_amount), blockTimeSec: null };
  r = await payCall(ordE.order_no, bare);
  assert(r.status === 409, 'legacy uppercase row blocks bare resubmit after migration: ' + JSON.stringify(r.json));
}
// ===== 跨订单冲突：迁移失败，不删行 =====
{
  const bare = 'f'.repeat(64);
  const upper = '0x' + 'F'.repeat(64);
  db.exec('DROP INDEX IF EXISTS idx_txid_claims_canon');
  db.exec('DROP INDEX IF EXISTS idx_payments_canon_event');
  db.prepare('DELETE FROM schema_migrations WHERE version = 21').run();
  db.prepare('INSERT INTO txid_claims (tx_hash, order_id) VALUES (?, 9101)').run(upper);
  db.prepare('INSERT INTO txid_claims (tx_hash, order_id) VALUES (?, 9102)').run(bare);
  const before = db.prepare('SELECT tx_hash, order_id FROM txid_claims WHERE order_id IN (9101, 9102) ORDER BY order_id').all();
  const logs = [];
  const origErr = console.error;
  console.error = (...a) => { logs.push(a.map(String).join(' ')); };
  r = await call('POST', '/api/admin/migrate', {}, cookie);
  console.error = origErr;
  assert(r.status === 500, 'cross-order conflict fails migration: ' + r.status + ' ' + JSON.stringify(r.json));
  const blob = logs.join('\n');
  assert(blob.includes('9101') && blob.includes('9102') && blob.includes('txid_claims'), 'conflict list names both orders: ' + blob.slice(0, 500));
  const after = db.prepare('SELECT tx_hash, order_id FROM txid_claims WHERE order_id IN (9101, 9102) ORDER BY order_id').all();
  assert(JSON.stringify(after) === JSON.stringify(before), 'conflict rows were not deleted or rewritten');
  assert(!q('SELECT version FROM schema_migrations WHERE version = 21'), 'failed migration did not mark v21');
  db.prepare('DELETE FROM txid_claims WHERE order_id IN (9101, 9102)').run();
  r = await call('POST', '/api/admin/migrate', {}, cookie);
  assert(r.json && r.json.ok === true && q('SELECT version FROM schema_migrations WHERE version = 21'), 'migration succeeds after conflicts are cleared');
}
{
  const upper = '0x' + 'ab'.repeat(32);
  const bare = 'ab'.repeat(32);
  db.exec('DROP INDEX IF EXISTS idx_txid_claims_canon');
  db.exec('DROP INDEX IF EXISTS idx_payments_canon_event');
  db.prepare('DELETE FROM schema_migrations WHERE version = 21').run();
  db.prepare("INSERT INTO payments (order_id, chain, tx_hash, event_key, amount, status) VALUES (11, 'X Layer', ?, '', 1, 'posted')").run(upper);
  db.prepare("INSERT INTO payments (order_id, chain, tx_hash, event_key, amount, status) VALUES (11, 'X Layer', ?, '', 1, 'verified')").run(bare);
  const before = db.prepare("SELECT tx_hash, status, amount FROM payments WHERE order_id=11 AND (tx_hash=? OR tx_hash=?) ORDER BY tx_hash").all(upper, bare);
  const logs = [];
  const origErr = console.error;
  console.error = (...a) => { logs.push(a.map(String).join(' ')); };
  r = await call('POST', '/api/admin/migrate', {}, cookie);
  console.error = origErr;
  assert(r.status === 500, 'same-order posted/verified rows fail migration: ' + r.status);
  const blob = logs.join('\n');
  assert(blob.includes('posted') && blob.includes('verified') && blob.includes('不合并'), 'status mismatch is listed: ' + blob.slice(0, 600));
  const after = db.prepare("SELECT tx_hash, status, amount FROM payments WHERE order_id=11 AND (tx_hash=? OR tx_hash=?) ORDER BY tx_hash").all(upper, bare);
  assert(JSON.stringify(after) === JSON.stringify(before), 'inconsistent payment rows were not merged');
  assert(!q('SELECT version FROM schema_migrations WHERE version = 21'), 'status mismatch did not mark v21');
  db.prepare('DELETE FROM payments WHERE order_id=11 AND (tx_hash=? OR tx_hash=?)').run(upper, bare);
  r = await call('POST', '/api/admin/migrate', {}, cookie);
  assert(r.json && r.json.ok === true, 'migration resumes after inconsistent rows are removed: ' + JSON.stringify(r.json));
}
// ===== 金额 / 地址 / 区块时间不符时不收养 =====
async function unmatchedOrder() {
  const rr = await orderCall('OKX', 'X Layer', cardProd.id);
  assert(rr.json && rr.json.ok, 'unmatched fixture order: ' + JSON.stringify(rr.json));
  return q('SELECT * FROM orders WHERE order_no=?', rr.json.order.order_no);
}
{
  const ord = await unmatchedOrder();
  const tx = '0x' + '1'.repeat(64);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, block_number, status) VALUES (NULL, 'X Layer', ?, ?, '', 0.01, 9000, 'unmatched')").run(ADDR_OKX, tx);
  evmState = { tx, amount: Number(ord.actual_amount), blockTimeSec: null };
  r = await payCall(ord.order_no, tx);
  assert(r.json && r.json.ok === false && /金额不符/.test(r.json.error || ''), 'amount mismatch not adopted: ' + JSON.stringify(r.json));
  const row = q('SELECT order_id, status FROM payments WHERE tx_hash=?', tx);
  const after = q('SELECT status FROM orders WHERE id=?', ord.id);
  assert(row && row.order_id == null && row.status === 'unmatched' && after.status === 'pending_payment', 'amount mismatch left unmatched: ' + JSON.stringify(row) + ' ' + after.status);
}
{
  const ord = await unmatchedOrder();
  const tx = '0x' + '2'.repeat(64);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, block_number, status) VALUES (NULL, 'X Layer', ?, ?, '', ?, 9000, 'unmatched')").run('0x' + '9'.repeat(40), tx, Number(ord.actual_amount));
  evmState = { tx, amount: Number(ord.actual_amount), blockTimeSec: null };
  r = await payCall(ord.order_no, tx);
  assert(r.json && r.json.ok === false && /收款地址不符/.test(r.json.error || ''), 'address mismatch not adopted: ' + JSON.stringify(r.json));
  const row = q('SELECT order_id, status FROM payments WHERE tx_hash=?', tx);
  assert(row && row.order_id == null && row.status === 'unmatched' && q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment', 'address mismatch left unmatched');
}
{
  const ord = await unmatchedOrder();
  const tx = '0x' + '3'.repeat(64);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, block_number, status) VALUES (NULL, 'X Layer', ?, ?, '', ?, 9000, 'unmatched')").run(ADDR_OKX, tx, Number(ord.actual_amount));
  evmState = { tx, amount: Number(ord.actual_amount), blockTimeSec: 1000 };
  r = await payCall(ord.order_no, tx);
  assert(r.json && r.json.ok === false && /区块时间/.test(r.json.error || ''), 'block before order creation not adopted: ' + JSON.stringify(r.json));
  assert(q('SELECT order_id, status FROM payments WHERE tx_hash=?', tx).status === 'unmatched', 'early transfer stays unmatched');
  assert(q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment', 'early transfer does not complete order');
}
{
  const ord = await unmatchedOrder();
  const tx = '0x' + '4'.repeat(64);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, block_number, status) VALUES (NULL, 'X Layer', ?, ?, '', ?, 9000, 'unmatched')").run(ADDR_OKX, tx, Number(ord.actual_amount));
  evmState = { tx, amount: Number(ord.actual_amount), blockTimeSec: Math.floor(Date.now() / 1000) + 86400 * 30 };
  r = await payCall(ord.order_no, tx);
  assert(r.json && r.json.ok === false && /区块时间/.test(r.json.error || ''), 'block after expiry not adopted: ' + JSON.stringify(r.json));
  assert(q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment', 'late transfer does not complete order');
  evmState.blockTimeSec = null;
}
function secOf(sqlTime) { return Math.floor(Date.parse(String(sqlTime).replace(' ', 'T') + 'Z') / 1000); }
function payRowsFor(tx) { return db.prepare('SELECT id, status, event_key, order_id FROM payments WHERE tx_hash=? OR tx_hash=?').all(tx, tx.startsWith('0x') ? tx.slice(2) : '0x' + tx); }
{
  const ord = await unmatchedOrder();
  const tx = '0x' + '8'.repeat(64);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, block_number, status) VALUES (NULL, 'X Layer', ?, ?, '0', ?, 9000, 'unmatched')").run(ADDR_OKX, tx, Number(ord.actual_amount));
  evmState = { tx, amount: Number(ord.actual_amount), blockTimeSec: secOf(ord.created_at), extraLogs: [] };
  r = await payCall(ord.order_no, tx);
  assert(r.json && r.json.ok === false && /区块时间/.test(r.json.error || ''), 'block time equal to created_at is not inside the window: ' + JSON.stringify(r.json));
  const rows = payRowsFor(tx);
  assert(rows.length === 1 && rows[0].status === 'unmatched' && rows[0].order_id == null, 'created_at boundary leaves the unmatched row and adds no verified row: ' + JSON.stringify(rows));
  assert(q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment', 'created_at boundary does not complete the order');
}
{
  const ord = await unmatchedOrder();
  const tx = '0x' + '9'.repeat(64);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, block_number, status) VALUES (NULL, 'X Layer', ?, ?, '0', ?, 9000, 'unmatched')").run(ADDR_OKX, tx, Number(ord.actual_amount));
  evmState = { tx, amount: Number(ord.actual_amount), blockTimeSec: secOf(ord.expires_at), extraLogs: [] };
  r = await payCall(ord.order_no, tx);
  assert(r.json && r.json.ok === false && /区块时间/.test(r.json.error || ''), 'block time equal to expires_at is not inside the window: ' + JSON.stringify(r.json));
  const rows = payRowsFor(tx);
  assert(rows.length === 1 && rows[0].status === 'unmatched' && rows.filter((x) => x.status === 'verified' || x.status === 'posted').length === 0, 'expires_at boundary adds no verified row: ' + JSON.stringify(rows));
}
{
  const ord = await unmatchedOrder();
  const tx = '0x' + '7'.repeat(64);
  const other = '0x' + 'ab'.repeat(20);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, block_number, status) VALUES (NULL, 'X Layer', ?, ?, '0', ?, 9000, 'unmatched')").run(ADDR_OKX, tx, Number(ord.actual_amount));
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, block_number, status) VALUES (NULL, 'X Layer', ?, ?, '1', ?, 9000, 'unmatched')").run(other, tx, 1);
  evmState = {
    tx, amount: Number(ord.actual_amount), blockTimeSec: null, extraLogs: [{
      address: USDT0_XLAYER, blockNumber: '0x' + (9000).toString(16), transactionHash: tx, logIndex: '0x1',
      topics: [TOPIC0, '0x' + '0'.repeat(64), toTopic(other)],
      data: '0x' + amountToRaw(1, 6).toString(16).padStart(64, '0'),
    }],
  };
  r = await payCall(ord.order_no, tx);
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), 'two logs: only the matching log is adopted: ' + JSON.stringify(r.json));
  const rows = payRowsFor(tx);
  assert(rows.length === 2, 'two logs stay two rows, no extra verified row: ' + JSON.stringify(rows));
  const adopted = rows.filter((x) => x.event_key === '0')[0];
  const otherRow = rows.filter((x) => x.event_key === '1')[0];
  assert(adopted && Number(adopted.order_id) === Number(ord.id) && adopted.status !== 'unmatched', 'logIndex 0 adopted in place: ' + JSON.stringify(adopted));
  assert(otherRow && otherRow.status === 'unmatched' && otherRow.order_id == null, 'non-matching log stays unmatched: ' + JSON.stringify(otherRow));
  assert(!rows.some((x) => x.event_key === ''), 'no empty event_key row was inserted');
  evmState.extraLogs = [];
}
{
  const ord = await unmatchedOrder();
  const tx = '0x' + '6a'.repeat(32);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, block_number, status) VALUES (NULL, 'X Layer', ?, ?, '0', ?, 9000, 'unmatched')").run(ADDR_OKX, tx, Number(ord.actual_amount));
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, block_number, status) VALUES (NULL, 'X Layer', ?, ?, '1', ?, 9000, 'unmatched')").run(ADDR_OKX, tx, Number(ord.actual_amount));
  evmState = {
    tx, amount: Number(ord.actual_amount), blockTimeSec: null, extraLogs: [{
      address: USDT0_XLAYER, blockNumber: '0x' + (9000).toString(16), transactionHash: tx, logIndex: '0x1',
      topics: [TOPIC0, '0x' + '0'.repeat(64), toTopic(ADDR_OKX)],
      data: '0x' + amountToRaw(Number(ord.actual_amount), 6).toString(16).padStart(64, '0'),
    }],
  };
  r = await payCall(ord.order_no, tx);
  assert(r.json && r.json.ok === false && /多条/.test(r.json.error || ''), 'two matching logs go to manual review: ' + JSON.stringify(r.json));
  const rows = payRowsFor(tx);
  assert(rows.length === 2 && rows.every((x) => x.status === 'unmatched' && x.order_id == null), 'two matching logs are not adopted and no verified row is added: ' + JSON.stringify(rows));
  assert(q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment', 'two matching logs leave the order pending');
  evmState.extraLogs = [];
}
// ===== 含逗号的卡密按一张算；条数不够不完成，但已到的卡密要写出来 =====
{
  const upProd = q('SELECT * FROM products WHERE slug=?', 'p1fix-up');
  upstreamDelivered = { status: 'delivered', delivered_keys: 'CODE,WITH,COMMA' };
  r = await orderCall('OKX', 'X Layer', upProd.id);
  assert(r.json && r.json.ok, 'comma-key order: ' + JSON.stringify(r.json));
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.prepare('UPDATE orders SET quantity=2 WHERE id=?').run(ord.id);
  const tx = '0x' + '5'.repeat(64);
  evmState = { tx, amount: Number(ord.actual_amount), blockTimeSec: null };
  r = await payCall(ord.order_no, tx);
  const after = q('SELECT status, delivery_content FROM orders WHERE id=?', ord.id);
  assert(after.status === 'pending_activation', 'short key count stays pending_activation: ' + after.status + ' ' + JSON.stringify(r.json));
  assert(after.delivery_content === 'CODE,WITH,COMMA', 'comma stays inside one key and is shown: ' + after.delivery_content);
  upstreamDelivered = { status: 'delivered', delivered_keys: ['CODE,WITH,COMMA', 'SECOND'] };
  r = await orderCall('OKX', 'X Layer', upProd.id);
  const ord2 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.prepare('UPDATE orders SET quantity=2 WHERE id=?').run(ord2.id);
  const tx2 = '0x' + '6'.repeat(64);
  evmState = { tx: tx2, amount: Number(ord2.actual_amount), blockTimeSec: null };
  r = await payCall(ord2.order_no, tx2);
  const after2 = q('SELECT status, delivery_content FROM orders WHERE id=?', ord2.id);
  assert(after2.status === 'completed' && after2.delivery_content === 'CODE,WITH,COMMA\nSECOND', 'array path keeps commas and completes when count matches: ' + after2.status + ' / ' + after2.delivery_content);
}
console.log('P1 PAYMENT FIXES TEST DONE');

