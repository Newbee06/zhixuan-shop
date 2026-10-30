// 拦路 bug 修复回归测试：P4 /pay 已结算单未核验谎称成功、P6 retryPendingFulfillOrders
// 无锁并发漏卡、A1 匿名摘要泄露 pending_tx_hash。全部 Mock，不访问真实上游/链上，
// 不用真实密钥与地址。运行：node tests/blockers-payops-test.mjs
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
let evmState = { tx: '', amount: 0, block: 9000, addr: ADDR_LOWER };
async function mockFetch(url, opts = {}) {
  const u = String(url); const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('api.resend.com')) return new Response(JSON.stringify({ id: 'mock-mail' }), { status: 200 });
  if (u.includes('mock-xlayer')) {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (body && body.method === 'eth_chainId') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xc4' }), { status: 200 });
    if (body && body.method === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (10000).toString(16) }), { status: 200 });
    if (body && body.method === 'eth_call') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (6).toString(16).padStart(64, '0') }), { status: 200 });
    if (body && body.method === 'eth_getTransactionReceipt') {
      const receipt = {
        status: '0x1', blockNumber: '0x' + (evmState.block).toString(16), transactionHash: evmState.tx,
        logs: [{ address: USDT0_XLAYER, blockNumber: '0x' + (evmState.block).toString(16), transactionHash: evmState.tx, logIndex: '0x0',
          topics: [TOPIC0, '0x' + '0'.repeat(64), toTopic(evmState.addr)],
          data: '0x' + amountToRaw(evmState.amount, 6).toString(16).padStart(64, '0') }],
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
async function scheduledSync() { const ctx = makeCtx(); await worker.scheduled({ cron: '*/1 * * * *' }, env, ctx); await ctx.drain(); }
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); } console.log('PASS: ' + msg); }
function q(sql, ...a) { return db.prepare(sql).get(...a); }
function qa(sql, ...a) { return db.prepare(sql).all(...a); }
function setSetting(key, value) { db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
let capSeq = 0;
function mkCaptcha(codeStr) {
  const id = 'cap-po-' + (++capSeq);
  const h = createHash('sha256').update(codeStr).digest('hex');
  const exp = new Date(Date.now() + 300000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?,?,0)').run(id, h, exp);
  return id;
}
let contactSeq = 0;
function freshContact() { return 'payops' + (++contactSeq) + '@test.example'; }
async function orderCall(productId) {
  const cid = mkCaptcha('AB12');
  db.prepare('DELETE FROM order_rate').run();
  const c = freshContact();
  return call('POST', '/api/orders', { product_id: productId, quantity: 1, contact: c, query_password: 'test-query-password-123', pay_method: 'OKX', pay_chain: 'X Layer', captcha_id: cid, captcha_code: 'AB12' });
}
let ipSeq = 0;
async function payCall(orderNo, txid) {
  const cid = mkCaptcha('AB12');
  db.prepare('DELETE FROM pay_rate').run();
  const ip = '10.8.0.' + (++ipSeq);
  return call('POST', '/api/orders/' + encodeURIComponent(orderNo) + '/pay', { txid, captcha_id: cid, captcha_code: 'AB12', query_password: 'test-query-password-123' }, undefined, { 'x-forwarded-for': ip });
}
async function adminCall(method, p, body, cookie) { return call(method, p, body, cookie); }
function futureISO(min) { return new Date(Date.now() + min * 60000).toISOString().replace('T', ' ').slice(0, 19); }
// 把 API 建单强制为 pending_fulfill + 已有 posted 付款事实（retry 的前置条件），保留下单时预留的卡。
async function makePendingFulfillOrder(productId) {
  const r = await orderCall(productId);
  assert(r.json && r.json.ok, 'P6 order created: ' + JSON.stringify(r.json));
  const o = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, status, reconcile_status) VALUES (?, 'X Layer', ?, ?, 'payops-p6', ?, 'posted', '')").run(o.id, ADDR_LOWER, 'payops-p6-' + o.id, Number(o.actual_amount));
  db.prepare("UPDATE orders SET status='pending_fulfill', claim_token='', claimed_at=NULL, upstream_lock='', upstream_lock_expires_at=NULL WHERE id=?").run(o.id);
  return q('SELECT * FROM orders WHERE id=?', o.id);
}

setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_MIXED }));
setSetting('rpc_urls', JSON.stringify({ 'X Layer': ['https://mock-xlayer'] }));
setSetting('poll_enabled', '1');
setSetting('chain_confirmations', JSON.stringify({ 'X Layer': 1 }));
let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
assert(r.json && r.json.ok, 'admin login');
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await call('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'test-admin-password-123' }, cookie);
assert(r.json && r.json.ok, 'change-password');
cookie = (r.headers.get('set-cookie') || '').split(';')[0] || cookie;

r = await call('POST', '/api/admin/products', { slug: 'payops-card', title: 'PayOps Card', category: 'card', price_usdt: 10, sell_price: 10, source: 'self', delivery_method: 'both', stock_type: 'card', form_fields: [] }, cookie);
assert(r.json && r.json.ok, 'create payops-card product');
const payCard = q('SELECT * FROM products WHERE slug=?', 'payops-card');
for (let i = 1; i <= 20; i++) db.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(payCard.id, 'PAY-KEY-' + String(i).padStart(3, '0'));

// ===== P4：已完成单提交未核验 TXID 应 409 且不写候选；已核验第二笔仍正常分流 =====
let completedOrder;
{
  r = await orderCall(payCard.id);
  assert(r.json && r.json.ok, 'P4 completed order created');
  completedOrder = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const FIRST = 'a1'.repeat(32);
  evmState = { tx: '0x' + FIRST, amount: Number(completedOrder.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(completedOrder.order_no, FIRST);
  assert(r.json && r.json.ok && /已自动发货/.test(r.json.message || ''), 'P4 first payment completes: ' + JSON.stringify(r.json));
  completedOrder = q('SELECT * FROM orders WHERE id=?', completedOrder.id);
  assert(completedOrder.status === 'completed' && completedOrder.tx_hash === FIRST, 'P4 order completed with first tx');
  const deliveryBefore = completedOrder.delivery_content;
  const pendingBefore = completedOrder.pending_tx_hash;
  // 未核验：链上金额不符（evmState.amount != 预期），核验返回 null
  const UNVERIFIED = 'c2'.repeat(32);
  evmState = { tx: '0x' + UNVERIFIED, amount: Number(completedOrder.actual_amount) + 1, block: 9000, addr: ADDR_LOWER };
  r = await payCall(completedOrder.order_no, UNVERIFIED);
  assert(r.status === 409, 'P4 completed + unverified TXID is 409 (not lying 200): ' + r.status + ' ' + JSON.stringify(r.json));
  assert(r.json && /未记录为候选/.test(r.json.error || ''), 'P4 409 message says no candidate written: ' + JSON.stringify(r.json));
  assert(!(r.json && /轮询会在/.test(r.json.error || '')), 'P4 409 does not promise polling will verify');
  const after409 = q('SELECT * FROM orders WHERE id=?', completedOrder.id);
  assert(after409.pending_tx_hash === pendingBefore, 'P4 completed order pending_tx_hash unchanged after 409');
  assert(after409.delivery_content === deliveryBefore, 'P4 completed order delivery unchanged after 409');
  assert(!q('SELECT * FROM payments WHERE tx_hash=?', UNVERIFIED), 'P4 no ledger row for unverified TXID on settled order');
  // 已核验第二笔：金额一致 + 确认充足，走 overpaid 分流，不重复发货
  const SECOND = 'e3'.repeat(32);
  evmState = { tx: '0x' + SECOND, amount: Number(completedOrder.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await payCall(completedOrder.order_no, SECOND);
  assert(r.json && r.json.ok && r.json.overpaid === true, 'P4 verified second payment still diverts to overpaid: ' + JSON.stringify(r.json));
  const secondRow = q('SELECT * FROM payments WHERE tx_hash=?', SECOND);
  assert(secondRow && secondRow.status === 'verified' && secondRow.reconcile_status === 'overpaid_pending' && Number(secondRow.order_id) === Number(completedOrder.id), 'P4 second row overpaid_pending');
  assert(q('SELECT delivery_content FROM orders WHERE id=?', completedOrder.id).delivery_content === deliveryBefore, 'P4 second payment does not duplicate delivery');
}

// ===== P4：待履约单提交未核验 TXID 同样 409；待付款单候选路径不受影响 =====
let pfOrderP4;
{
  pfOrderP4 = await makePendingFulfillOrder(payCard.id);
  assert(pfOrderP4.status === 'pending_fulfill' && (pfOrderP4.pending_tx_hash || '') === '', 'P4 pending_fulfill setup');
  const UNV2 = 'c4'.repeat(32);
  evmState = { tx: '0x' + UNV2, amount: Number(pfOrderP4.actual_amount) + 1, block: 9000, addr: ADDR_LOWER };
  r = await payCall(pfOrderP4.order_no, UNV2);
  assert(r.status === 409, 'P4 pending_fulfill + unverified TXID is 409: ' + r.status + ' ' + JSON.stringify(r.json));
  const pfAfter = q('SELECT * FROM orders WHERE id=?', pfOrderP4.id);
  assert(pfAfter.status === 'pending_fulfill' && (pfAfter.pending_tx_hash || '') === '', 'P4 pending_fulfill gains no orphan candidate on 409');
}
let pendingCandidateOrder;
let pendingCandidateTx;
{
  r = await orderCall(payCard.id);
  assert(r.json && r.json.ok, 'P4 pending order created');
  pendingCandidateOrder = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  pendingCandidateTx = 'd5'.repeat(32);
  evmState = { tx: '0x' + pendingCandidateTx, amount: Number(pendingCandidateOrder.actual_amount) + 1, block: 9000, addr: ADDR_LOWER };
  r = await payCall(pendingCandidateOrder.order_no, pendingCandidateTx);
  assert(r.json && r.json.ok && r.json.auto === false, 'P4 pending_payment unverified still writes candidate (preserved path): ' + JSON.stringify(r.json));
  const pendAfter = q('SELECT * FROM orders WHERE id=?', pendingCandidateOrder.id);
  assert(pendAfter.status === 'pending_payment' && pendAfter.pending_tx_hash === pendingCandidateTx, 'P4 pending order candidate stored');
}

// ===== A1：匿名摘要不再含 pending_tx_hash；管理端详情保留 =====
{
  r = await call('GET', '/api/orders/' + encodeURIComponent(pendingCandidateOrder.order_no));
  assert(r.json && r.json.ok, 'A1 anon GET ok: ' + JSON.stringify(r.json));
  assert(!('pending_tx_hash' in (r.json.order || {})), 'A1 anon GET summary has no pending_tx_hash');
  assert(!('tx_hash' in (r.json.order || {})) && !('txid' in (r.json.order || {})), 'A1 anon GET summary also strips tx_hash/txid');
  r = await adminCall('GET', '/api/admin/orders?page_size=100', undefined, cookie);
  assert(r.json && r.json.ok, 'A1 admin list ok');
  const listItem = (r.json.orders || []).find((x) => x.order_no === pendingCandidateOrder.order_no);
  assert(listItem && !('pending_tx_hash' in listItem), 'A1 admin list (summary) has no pending_tx_hash');
  r = await adminCall('GET', '/api/admin/orders/' + pendingCandidateOrder.id, undefined, cookie);
  assert(r.json && r.json.ok && r.json.order.pending_tx_hash === pendingCandidateTx, 'A1 admin detail retains pending_tx_hash: ' + JSON.stringify(r.json.order && r.json.order.pending_tx_hash));
  // /query 自建条目同样不含该字段
  const cid = mkCaptcha('AB12');
  r = await call('POST', '/api/orders/query', { keywords: pendingCandidateOrder.order_no, captcha_id: cid, captcha_code: 'AB12' });
  assert(r.json && r.json.ok && (r.json.orders || []).length >= 1, 'A1 query ok');
  assert(!('pending_tx_hash' in (r.json.orders[0] || {})), 'A1 query item has no pending_tx_hash');
  // 管理端告警同样走 summary：给待履约单挂一个候选，告警里也不得出现
  db.prepare('UPDATE orders SET pending_tx_hash=? WHERE id=?').run('f6'.repeat(32), pfOrderP4.id);
  r = await adminCall('GET', '/api/admin/upstream/alerts', undefined, cookie);
  assert(r.json && r.json.ok, 'A1 alerts ok');
  const alertItem = (r.json.alerts || []).find((x) => x.order_no === pfOrderP4.order_no);
  assert(alertItem && !('pending_tx_hash' in alertItem), 'A1 alerts (summary) has no pending_tx_hash');
  db.prepare('UPDATE orders SET pending_tx_hash=? WHERE id=?').run('', pfOrderP4.id);
}

// ===== P6：手动发货已持锁时 cron 重试不得再标记另一张卡 =====
async function mkP6Product(slug, cardCode) {
  const rr = await call('POST', '/api/admin/products', { slug, title: slug, category: 'card', price_usdt: 10, sell_price: 10, source: 'self', delivery_method: 'both', stock_type: 'card', form_fields: [] }, cookie);
  assert(rr.json && rr.json.ok, 'P6 create product ' + slug);
  const prod = q('SELECT * FROM products WHERE slug=?', slug);
  db.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(prod.id, cardCode);
  return prod;
}
let lockOrder;
{
  const prod = await mkP6Product('payops-p6-lock', 'LOCK-KEY-1');
  lockOrder = await makePendingFulfillOrder(prod.id);
  const reserved = q('SELECT * FROM cards WHERE reserved_order_id=?', lockOrder.id);
  assert(reserved && reserved.code === 'LOCK-KEY-1' && reserved.is_used === 0, 'P6 lock setup: card reserved');
  db.prepare('UPDATE orders SET upstream_lock=?, upstream_lock_expires_at=? WHERE id=?').run('manual-held-lock', futureISO(10), lockOrder.id);
  await scheduledSync();
  const after = q('SELECT * FROM orders WHERE id=?', lockOrder.id);
  assert(after.status === 'pending_fulfill', 'P6 lock-held order stays pending_fulfill after cron');
  assert(after.upstream_lock === 'manual-held-lock', 'P6 cron did not steal manual lock');
  const cardAfter = q('SELECT * FROM cards WHERE id=?', reserved.id);
  assert(cardAfter.is_used === 0 && Number(cardAfter.reserved_order_id) === Number(lockOrder.id), 'P6 cron marked no additional card while manual holds lock');
}

// ===== P6：正常重试流程不受影响（无锁时补货后自动完成） =====
{
  const prod = await mkP6Product('payops-p6-normal', 'NORMAL-KEY-1');
  const ord = await makePendingFulfillOrder(prod.id);
  const reserved = q('SELECT * FROM cards WHERE reserved_order_id=?', ord.id);
  assert(reserved && reserved.code === 'NORMAL-KEY-1', 'P6 normal setup: card reserved');
  await scheduledSync();
  const after = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(after.status === 'completed' && after.delivery_content === 'NORMAL-KEY-1', 'P6 normal retry completes with reserved card');
  const cardAfter = q('SELECT * FROM cards WHERE id=?', reserved.id);
  assert(cardAfter.is_used === 1 && Number(cardAfter.order_id) === Number(ord.id), 'P6 normal retry card marked used');
  assert(q('SELECT status FROM orders WHERE id=?', lockOrder.id).status === 'pending_fulfill', 'P6 normal run still skips lock-held order');
}

// ===== P6：补偿路径不漏卡（锁过期后他路完成、重试领卡后完成失败时，未交付的新标记卡须还回池子） =====
{
  const prod = await mkP6Product('payops-p6-comp', 'COMP-KEY-1');
  const ord = await makePendingFulfillOrder(prod.id);
  const reserved = q('SELECT * FROM cards WHERE reserved_order_id=?', ord.id);
  assert(reserved && reserved.code === 'COMP-KEY-1' && reserved.is_used === 0, 'P6 comp setup: card reserved');
  let hookReached = false;
  let releaseHook;
  const hookGate = new Promise((res) => { releaseHook = res; });
  env.__testHooks = { beforeRetryClaimCards: async () => { hookReached = true; await hookGate; } };
  const ctx = { pending: [] };
  ctx.waitUntil = (pr) => { ctx.pending.push(pr); };
  await worker.scheduled({ cron: '*/1 * * * *' }, env, ctx);
  const t0 = Date.now();
  while (!hookReached) { if (Date.now() - t0 > 10000) throw new Error('P6 comp hook not reached'); await new Promise((res) => setTimeout(res, 10)); }
  const held = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(held.upstream_lock && held.upstream_lock !== '' && held.upstream_lock !== 'manual-held-lock', 'P6 comp: retry holds upstream_lock while paused');
  assert(q('SELECT * FROM cards WHERE id=?', reserved.id).is_used === 0, 'P6 comp: no card marked yet while paused');
  // 锁过期后管理员手动发货完成（交付内容为手工 Y，非卡密 X）：此时重试尚未领卡。
  db.prepare("UPDATE orders SET upstream_lock_expires_at='2020-01-01 00:00:00' WHERE id=?").run(ord.id);
  r = await adminCall('POST', '/api/admin/orders/' + ord.id + '/fulfill', { delivery_content: 'MANUAL-DELIVERY-Y' }, cookie);
  assert(r.json && r.json.ok, 'P6 comp manual fulfill ok: ' + JSON.stringify(r.json));
  const manualAfter = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(manualAfter.status === 'completed' && manualAfter.delivery_content === 'MANUAL-DELIVERY-Y', 'P6 comp manual delivery Y kept');
  // 放行重试：它领卡（池子里唯一的该商品卡 X）后完成 UPDATE 因锁令牌不符失败，必须补偿还卡，不得 stranded。
  releaseHook();
  await Promise.all(ctx.pending.map((x) => x.catch(() => {})));
  env.__testHooks = {};
  const finalOrder = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(finalOrder.status === 'completed' && finalOrder.delivery_content === 'MANUAL-DELIVERY-Y', 'P6 comp retry did not overwrite manual delivery');
  const cardFinal = q('SELECT * FROM cards WHERE id=?', reserved.id);
  assert(cardFinal.is_used === 0 && cardFinal.order_id == null && cardFinal.reserved_order_id == null, 'P6 comp undelivered newly-marked card returned to pool (not stranded): ' + JSON.stringify(cardFinal));
}
console.log('BLOCKERS PAYOPS TEST DONE');
