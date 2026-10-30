// 支付账本核心线拦路 bug 回归测试：P1 / P2 / P3 / P5（2026-10-30，工作树 fix/blockers-payment）
// 只用本地 mock，不访问真实链上 / 上游 / 生产库，不用真实密钥与地址。
// 运行：node tests/blockers-payment-test.mjs
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
function fmtTs(d) { return d.toISOString().replace('T', ' ').slice(0, 19); }
function minsAgo(m) { return fmtTs(new Date(Date.now() - m * 60000)); }
function minsAhead(m) { return fmtTs(new Date(Date.now() + m * 60000)); }
// mock RPC 模式：receiptOk（收据成功）/ receiptNull（节点明确返回 null）/ allFail（全部抛错）
let rpcMode = 'receiptOk';
let evmState = { tx: '', amount: 0, block: 9000, addr: ADDR_LOWER };
async function mockFetch(url, opts = {}) {
  const u = String(url); const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('api.resend.com')) return new Response(JSON.stringify({ id: 'mock-mail' }), { status: 200 });
  if (u.includes('mock-xlayer') || u.includes('mock-bsc')) {
    if (rpcMode === 'allFail') throw new Error('mock RPC down');
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
      if (rpcMode === 'receiptNull') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
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
  if (u.includes('prodseller.com')) return new Response(JSON.stringify({ id: 'PS-MOCK', status: 'delivered', delivered_keys: 'K1' }), { status: 200 });
  return new Response(JSON.stringify({}), { status: 200 });
}
globalThis.fetch = mockFetch;
// P2 竞态注入：canonicalizeClaimRow 的规范形查询准备时，先由“并发请求”插进他单裸形认领行，
// 模拟 legacy SELECT 与 canonicalize 查询之间的竞态窗口。只在 P2 一节内开启。
let injectP2 = null;
const CANON_SQL = 'SELECT order_id, claimed_at, claim_token, source, order_lease_token, tx_hash FROM txid_claims WHERE tx_hash = ?';
function dbPrepare(sql) {
  if (injectP2 && sql === CANON_SQL) {
    try { db.prepare('INSERT OR IGNORE INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?, ?, ?, ?, ?, ?)').run(injectP2.tx, injectP2.otherOrderId, '2026-01-01 00:00:00', 'tok-race-other', 'chain_verified', ''); } catch (e) {}
  }
  return wrapStmt(sql);
}
const env = {
  DB: { prepare: (sql) => dbPrepare(sql), async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } },
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
async function callNoAdminHeader(method, p, body, cookie) {
  const ctx = makeCtx();
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: res.status, json: j, text: txt };
}
async function scheduled() { const ctx = makeCtx(); await worker.scheduled({ cron: '*/1 * * * *' }, env, ctx); await ctx.drain(); }
let failures = 0;
function check(cond, msg) { if (!cond) { failures++; console.error('FAIL: ' + msg); } else console.log('PASS: ' + msg); }
function q(sql, ...a) { return db.prepare(sql).get(...a); }
function qa(sql, ...a) { return db.prepare(sql).all(...a); }
function setSetting(key, value) { db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
let capSeq = 0;
function mkCaptcha(codeStr) {
  const id = 'cap-bp-' + (++capSeq);
  const h = createHash('sha256').update(codeStr).digest('hex');
  const exp = fmtTs(new Date(Date.now() + 300000));
  db.prepare('INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?,?,0)').run(id, h, exp);
  return id;
}
let ipSeq = 0;
async function payCall(orderNo, txid) {
  const cid = mkCaptcha('AB12');
  db.prepare('DELETE FROM pay_rate').run();
  const ip = '10.9.1.' + (++ipSeq);
  return call('POST', '/api/orders/' + encodeURIComponent(orderNo) + '/pay', { txid, captcha_id: cid, captcha_code: 'AB12', query_password: 'test-query-password-123' }, undefined, { 'x-forwarded-for': ip });
}
let orderSeq = 0;
function insertOrder(over) {
  const seq = ++orderSeq;
  // pending_payment 部分唯一索引：(pay_address, actual_amount) 与 (contact, product_id) 均不得重复，
  // 故每单实际金额与联系方式都唯一（金额以 0.01 步进，收据金额须取订单 actual_amount，见各节）。
  const o = Object.assign({ order_no: 'BP-' + seq, product_id: 1, quantity: 1, price_usdt: 10, total_usdt: 10, actual_amount: Number((10 + seq * 0.01).toFixed(2)), pay_address: ADDR_LOWER, wallet_address: ADDR_LOWER, status: 'pending_payment', pay_method: 'OKX', pay_chain: 'X Layer', contact: 'bp' + seq + '@test.example', customer_fields: '{}', product_snapshot: '{"stock_type":"manual"}', created_at: fmtTs(new Date()), expires_at: minsAhead(20), claim_token: '', claimed_at: null, paid_at: null }, over || {});
  const info = db.prepare('INSERT INTO orders (order_no, query_password, product_id, quantity, price_usdt, total_usdt, actual_amount, pay_address, wallet_address, status, pay_method, pay_chain, contact, customer_fields, product_snapshot, created_at, expires_at, claim_token, claimed_at, paid_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(o.order_no, '', o.product_id, o.quantity, o.price_usdt, o.total_usdt, o.actual_amount, o.pay_address, o.wallet_address, o.status, o.pay_method, o.pay_chain, o.contact, o.customer_fields, o.product_snapshot, o.created_at, o.expires_at, o.claim_token, o.claimed_at, o.paid_at);
  return q('SELECT * FROM orders WHERE id=?', info.lastInsertRowid);
}
function insertPayment(orderId, tx, status, over) {
  const p = Object.assign({ chain: 'X Layer', pay_address: ADDR_LOWER, event_key: '', amount: 10, block_number: 9000, reconcile_status: '', reconcile_note: '' }, over || {});
  const info = db.prepare('INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, block_number, status, reconcile_status, reconcile_note) VALUES (?,?,?,?,?,?,?,?,?,?)').run(orderId, p.chain, p.pay_address, tx, p.event_key, p.amount, p.block_number, status, p.reconcile_status, p.reconcile_note);
  return q('SELECT * FROM payments WHERE id=?', info.lastInsertRowid);
}
// ---- 基础设置与管理员登录 ----
setSetting('rpc_urls', JSON.stringify({ 'X Layer': ['https://mock-xlayer'], 'BEP20': ['https://mock-bsc'] }));
setSetting('chain_confirmations', JSON.stringify({ 'X Layer': 1 }));
setSetting('poll_enabled', '1');
setSetting('prodseller_enabled', '1');
db.prepare("INSERT INTO products (slug, title, category, price_usdt, sell_price, source, stock_type, form_fields) VALUES ('bp-manual','BP Manual','recharge',10,10,'self','manual','[]')").run();
let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
if (!r.json || !r.json.ok) { console.error('SETUP FAIL admin login: ' + JSON.stringify(r.json)); process.exit(1); }
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await call('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'test-admin-password-123' }, cookie);
if (!r.json || !r.json.ok) { console.error('SETUP FAIL change-password: ' + JSON.stringify(r.json)); process.exit(1); }
cookie = (r.headers.get('set-cookie') || '').split(';')[0] || cookie;
const prodId = q("SELECT id FROM products WHERE slug='bp-manual'").id;

// ===== P1a. adopt-payment：他单已消耗 TXID 时应 409 且 mismatch 行保持 mismatch =====
{
  const victim = insertOrder({ product_id: prodId });
  const other = insertOrder({ product_id: prodId });
  const TX1 = 'a1'.repeat(32);
  db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?,?,?,?,?,?)').run(TX1, other.id, '2026-01-01 00:00:00', 'tok-other-1', 'chain_verified', '');
  const mis = insertPayment(victim.id, TX1, 'mismatch', { amount: 999, reconcile_status: 'pending', reconcile_note: '金额与订单预期不符，需人工对账' });
  rpcMode = 'receiptOk'; evmState = { tx: '0x' + TX1, amount: Number(victim.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await call('POST', '/api/admin/orders/' + victim.id + '/adopt-payment', { payment_id: mis.id, mode: 'fulfill' }, cookie);
  check(r.json && !r.json.ok, 'P1a adopt consumed TXID rejected: ' + JSON.stringify(r.json));
  check(r.status === 409, 'P1a adopt consumed TXID status 409 (got ' + r.status + ')');
  check(q('SELECT status FROM payments WHERE id=?', mis.id).status === 'mismatch', 'P1a adopt consumed TXID: row stays mismatch (got ' + q('SELECT status FROM payments WHERE id=?', mis.id).status + ')');
  check(q('SELECT status FROM orders WHERE id=?', victim.id).status === 'pending_payment', 'P1a adopt consumed TXID: victim order not fulfilled');
}
// ===== P1a2. reverify：他单已消耗 TXID 时应 409 且行保持 mismatch =====
{
  const victim = insertOrder({ product_id: prodId });
  const other = insertOrder({ product_id: prodId });
  const TXR = 'b2'.repeat(32);
  db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?,?,?,?,?,?)').run(TXR, other.id, '2026-01-01 00:00:00', 'tok-other-r', 'chain_verified', '');
  const mis = insertPayment(victim.id, TXR, 'mismatch', { amount: 999, reconcile_status: 'pending', reconcile_note: '金额不符' });
  rpcMode = 'receiptOk'; evmState = { tx: '0x' + TXR, amount: Number(victim.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await call('POST', '/api/admin/payments/' + mis.id + '/reverify', {}, cookie);
  check(r.json && !r.json.ok, 'P1a2 reverify consumed TXID rejected: ' + JSON.stringify(r.json));
  check(r.status === 409, 'P1a2 reverify consumed TXID status 409 (got ' + r.status + ')');
  check(q('SELECT status FROM payments WHERE id=?', mis.id).status === 'mismatch', 'P1a2 reverify consumed TXID: row stays mismatch (got ' + q('SELECT status FROM payments WHERE id=?', mis.id).status + ')');
}
// ===== P1b. adopt：转换后 processVerifiedPayment 失败（有效租约被占）时行恢复为 mismatch =====
{
  const ord = insertOrder({ product_id: prodId, claim_token: 'ACTIVE-LEASE', claimed_at: minsAgo(0), paid_at: minsAgo(0) });
  const TX2 = 'c3'.repeat(32);
  const mis = insertPayment(ord.id, TX2, 'mismatch', { amount: 999, reconcile_status: 'pending', reconcile_note: '金额不符' });
  rpcMode = 'receiptOk'; evmState = { tx: '0x' + TX2, amount: Number(ord.actual_amount), block: 9000, addr: ADDR_LOWER };
  r = await call('POST', '/api/admin/orders/' + ord.id + '/adopt-payment', { payment_id: mis.id, mode: 'fulfill' }, cookie);
  check(r.json && !r.json.ok, 'P1b adopt with held lease rejected: ' + JSON.stringify(r.json));
  check(q('SELECT status FROM payments WHERE id=?', mis.id).status === 'mismatch', 'P1b adopt failed after conversion: row restored to mismatch (got ' + q('SELECT status FROM payments WHERE id=?', mis.id).status + ')');
}
// ===== P2. claimTxid 遗留收养：canonicalize 返回他单行时 /pay 应拒绝，不双认领 =====
{
  const mine = insertOrder({ product_id: prodId });
  const other = insertOrder({ product_id: prodId });
  const TX3 = 'd4'.repeat(32);
  db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?,?,?,?,?,?)').run('0x' + TX3, mine.id, '2026-01-01 00:00:00', 'tok-legacy-mine', 'chain_verified', '');
  rpcMode = 'receiptOk'; evmState = { tx: '0x' + TX3, amount: Number(mine.actual_amount), block: 9000, addr: ADDR_LOWER };
  injectP2 = { tx: TX3, otherOrderId: other.id };
  r = await payCall(mine.order_no, TX3);
  injectP2 = null;
  check(r.json && !r.json.ok, 'P2 race canonicalize-to-other: /pay rejected: ' + JSON.stringify(r.json));
  check(r.status === 409, 'P2 race canonicalize-to-other: /pay status 409 (got ' + r.status + ')');
  check(q('SELECT status FROM orders WHERE id=?', mine.id).status === 'pending_payment', 'P2 race: mine order stays pending_payment (got ' + q('SELECT status FROM orders WHERE id=?', mine.id).status + ')');
  const raceClaim = q('SELECT * FROM txid_claims WHERE tx_hash=?', TX3);
  check(raceClaim && Number(raceClaim.order_id) === Number(other.id), 'P2 race: bare claim still belongs to other order only');
}
// ===== P3a. 过期清理：paid_at 残留 + claim_token 为空 + claimed_at 为空的订单能被取消 =====
{
  const residual = insertOrder({ product_id: prodId, paid_at: minsAgo(0), claim_token: '', claimed_at: null, expires_at: minsAgo(1), created_at: minsAgo(30) });
  const protectedByClaim = insertOrder({ product_id: prodId, paid_at: minsAgo(0), claim_token: '', claimed_at: null, expires_at: minsAgo(1), created_at: minsAgo(30) });
  db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?,?,?,?,?,?)').run('e5'.repeat(32), protectedByClaim.id, '2026-01-01 00:00:00', 'tok-prot', 'chain_verified', '');
  const freshLease = insertOrder({ product_id: prodId, paid_at: minsAgo(0), claim_token: 'FRESH-P3', claimed_at: minsAgo(0), expires_at: minsAgo(1), created_at: minsAgo(30) });
  rpcMode = 'receiptOk'; evmState = { tx: '', amount: 0, block: 9000, addr: ADDR_LOWER };
  await scheduled();
  check(q('SELECT status FROM orders WHERE id=?', residual.id).status === 'cancelled', 'P3a expire: residual (paid_at + empty token + null claimed_at) cancelled (got ' + q('SELECT status FROM orders WHERE id=?', residual.id).status + ')');
  check(q('SELECT status FROM orders WHERE id=?', protectedByClaim.id).status === 'pending_payment', 'P3a expire: consumed-claim order NOT cancelled');
  check(q('SELECT status FROM orders WHERE id=?', freshLease.id).status === 'pending_payment', 'P3a expire: fresh-lease order NOT cancelled');
}
// ===== P3b. 管理员取消：同残留态能取消；真付款 / 新鲜租约 / token 非空 + claimed_at 为空仍被挡 =====
{
  const residual = insertOrder({ product_id: prodId, paid_at: minsAgo(0), claim_token: '', claimed_at: null });
  r = await call('POST', '/api/admin/orders/' + residual.id + '/cancel', { reason: 'P3b residual cancel' }, cookie);
  check(r.json && r.json.ok, 'P3b admin cancel residual ok: ' + JSON.stringify(r.json));
  check(q('SELECT status FROM orders WHERE id=?', residual.id).status === 'cancelled', 'P3b admin cancel residual: status cancelled');
  const paid = insertOrder({ product_id: prodId, paid_at: minsAgo(0), claim_token: '', claimed_at: null });
  insertPayment(paid.id, 'f6'.repeat(32), 'verified', { amount: 10, reconcile_status: '' });
  r = await call('POST', '/api/admin/orders/' + paid.id + '/cancel', { reason: 'P3b paid cancel' }, cookie);
  check(r.json && !r.json.ok, 'P3b admin cancel verified-ledger order rejected: ' + JSON.stringify(r.json));
  check(q('SELECT status FROM orders WHERE id=?', paid.id).status === 'pending_payment', 'P3b admin cancel verified-ledger order stays pending_payment');
  const freshLease = insertOrder({ product_id: prodId, paid_at: minsAgo(0), claim_token: 'FRESH-P3B', claimed_at: minsAgo(0) });
  r = await call('POST', '/api/admin/orders/' + freshLease.id + '/cancel', { reason: 'P3b fresh cancel' }, cookie);
  check(r.json && !r.json.ok && r.status === 409, 'P3b admin cancel fresh lease rejected 409: ' + JSON.stringify(r.json));
  const nullClaimed = insertOrder({ product_id: prodId, paid_at: minsAgo(0), claim_token: 'NULL-TOKEN-P3B', claimed_at: null });
  r = await call('POST', '/api/admin/orders/' + nullClaimed.id + '/cancel', { reason: 'P3b null claimed cancel' }, cookie);
  check(r.json && !r.json.ok && r.status === 409, 'P3b admin cancel token-present + null claimed_at rejected 409: ' + JSON.stringify(r.json));
}
// ===== P5. recheck：全 RPC 失败不标嫌疑；节点明确返回 null 仍标嫌疑；管理员接口可清除 =====
{
  const ord = insertOrder({ product_id: prodId });
  const TXP = '1a2b'.repeat(16);
  const prow = insertPayment(ord.id, TXP, 'posted', { amount: 10, block_number: 9000, reconcile_status: '' });
  rpcMode = 'allFail';
  await scheduled();
  check(q('SELECT reconcile_status FROM payments WHERE id=?', prow.id).reconcile_status !== 'reorg_suspect', 'P5 all-RPC-fail: not flagged suspect (got ' + q('SELECT reconcile_status FROM payments WHERE id=?', prow.id).reconcile_status + ')');
  check(!q('SELECT * FROM upstream_cache WHERE key=?', 'posted_recheck:' + prow.id), 'P5 all-RPC-fail: no throttle cache written');
  rpcMode = 'receiptNull';
  await scheduled();
  check(q('SELECT reconcile_status FROM payments WHERE id=?', prow.id).reconcile_status === 'reorg_suspect', 'P5 receipt-null evidence: flagged suspect (got ' + q('SELECT reconcile_status FROM payments WHERE id=?', prow.id).reconcile_status + ')');
  const unauth = await callNoAdminHeader('POST', '/api/admin/payments/' + prow.id + '/clear-reorg-suspect', { note: 'no auth' });
  check(unauth.json && !unauth.json.ok, 'P5 clear-reorg-suspect without admin session rejected: ' + JSON.stringify(unauth.json));
  check(q('SELECT reconcile_status FROM payments WHERE id=?', prow.id).reconcile_status === 'reorg_suspect', 'P5 unauth clear does not remove suspect flag');
  r = await call('POST', '/api/admin/payments/' + prow.id + '/clear-reorg-suspect', { note: '人工复核：区块浏览器确认收据正常，清除嫌疑' }, cookie);
  check(r.json && r.json.ok, 'P5 clear-reorg-suspect ok: ' + JSON.stringify(r.json));
  check(q('SELECT reconcile_status FROM payments WHERE id=?', prow.id).reconcile_status !== 'reorg_suspect', 'P5 clear-reorg-suspect: flag removed (got ' + q('SELECT reconcile_status FROM payments WHERE id=?', prow.id).reconcile_status + ')');
  r = await call('POST', '/api/admin/payments/' + prow.id + '/clear-reorg-suspect', { note: 'second clear' }, cookie);
  check(r.json && !r.json.ok, 'P5 clear-reorg-suspect on non-suspect row rejected: ' + JSON.stringify(r.json));
  rpcMode = 'receiptNull';
  await scheduled();
  check(q('SELECT reconcile_status FROM payments WHERE id=?', prow.id).reconcile_status === 'reorg_suspect', 'P5 after clear, fresh evidence re-flags suspect (got ' + q('SELECT reconcile_status FROM payments WHERE id=?', prow.id).reconcile_status + ')');
}
console.log(failures ? ('BLOCKERS PAYMENT TEST DONE: ' + failures + ' FAILURE(S)') : 'BLOCKERS PAYMENT TEST DONE: ALL PASS');
process.exitCode = failures ? 1 : 0;
