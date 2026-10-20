// 付款对账列表一期：GET /api/admin/payments 筛选 + 订单只读 join + 派生 contract。
// 不测真实链上/上游；不改 reconcile 语义；不提供删除 txid_claims。
// 运行：node tests/payments-admin-list-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
db.exec(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));

function wrapStmt(sql) {
  let params = [];
  const api = {
    bind(...a) { params = a; return api; },
    async first() { const r = db.prepare(sql).get(...params); return r === undefined ? null : r; },
    async all() { return { results: db.prepare(sql).all(...params) }; },
    async run() { const info = db.prepare(sql).run(...params); return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }; },
  };
  return api;
}
const env = { ZHIXUAN_SETUP_TOKEN: 'test-setup-token', DB: { prepare: (sql) => wrapStmt(sql) } };
let code = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
code = code.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(html) + ';');
code = code.replace('export default {', 'globalThis.__W = {');
const worker = new Function(code + '\nreturn globalThis.__W;')();

const XLAYER = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
const BEP20 = '0x55d398326f99059fF775485246999027B3197955';
const OVERRIDE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TX_A = 'a'.repeat(64);
const TX_B = 'b'.repeat(64);
const TX_C = 'c'.repeat(64);

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); }
  console.log('PASS: ' + msg);
}
function makeCtx() {
  const c = { pending: [] };
  c.waitUntil = (pr) => { c.pending.push(pr); };
  c.drain = async () => { while (c.pending.length) { const batch = c.pending.splice(0); await Promise.all(batch.map((x) => x.catch(() => {}))); } };
  return c;
}
async function call(method, p, body, cookie) {
  const ctx = makeCtx();
  const headers = { 'content-type': 'application/json', 'X-Admin-API': '1' };
  if (cookie) headers.Cookie = cookie;
  const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: res.status, json: j, text: txt };
}
function setSetting(key, value) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
function delSetting(key) { db.prepare('DELETE FROM settings WHERE key=?').run(key); }
function idsOf(r) { return ((r.json && r.json.payments) || []).map((p) => p.id); }
function byTx(r, tx) { return ((r.json && r.json.payments) || []).find((p) => p.tx_hash === tx) || null; }

db.prepare("INSERT INTO products (slug, title, category, price_usdt, sell_price, source, stock_type) VALUES ('pay-admin', '对账测试商品', 'card', 10, 10, 'self', 'card')").run();
const prod = db.prepare("SELECT id FROM products WHERE slug='pay-admin'").get();

function insertOrder(row) {
  const info = db.prepare(`INSERT INTO orders (order_no, query_password, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, contact, pay_method, pay_chain, status, tx_hash, pending_tx_hash, payment_state, created_at)
    VALUES (?, '', ?, '{}', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.order_no, prod.id, row.total, row.total, row.actual_amount, row.pay_address, row.contact, row.pay_method, row.pay_chain, row.status, row.tx_hash, row.pending_tx_hash, row.payment_state, row.created_at
  );
  return db.prepare('SELECT * FROM orders WHERE id=?').get(info.lastInsertRowid);
}
function insertPay(row) {
  const info = db.prepare(`INSERT INTO payments (order_id, chain, asset, pay_address, tx_hash, event_key, amount, amount_unit, block_number, confirmations, first_seen_at, status, reconcile_status, reconcile_note, created_at, updated_at)
    VALUES (?, ?, 'USDT', ?, ?, ?, ?, 'USDT', ?, 1, ?, ?, ?, ?, ?, ?)`).run(
    row.order_id, row.chain, row.pay_address, row.tx_hash, row.event_key, row.amount, row.block_number, row.created_at, row.status, row.reconcile_status, row.reconcile_note, row.created_at, row.created_at
  );
  return db.prepare('SELECT * FROM payments WHERE id=?').get(info.lastInsertRowid);
}

const orderA = insertOrder({ order_no: 'AIS-RECON-A', total: 10, actual_amount: 10.0001, pay_address: '0x1111111111111111111111111111111111111111', contact: 'a@test.example', pay_method: 'OKX', pay_chain: 'X Layer', status: 'pending_payment', tx_hash: '', pending_tx_hash: 'pend-a', payment_state: '', created_at: '2026-10-18 09:00:00' });
const orderB = insertOrder({ order_no: 'AIS-RECON-B', total: 20, actual_amount: 20.0002, pay_address: '0x2222222222222222222222222222222222222222', contact: 'b@test.example', pay_method: 'Binance', pay_chain: 'BEP20', status: 'completed', tx_hash: TX_B, pending_tx_hash: '', payment_state: 'overpaid_pending', created_at: '2026-10-19 09:00:00' });
const payA = insertPay({ order_id: orderA.id, chain: 'X Layer', pay_address: orderA.pay_address, tx_hash: TX_A, event_key: '1', amount: 9.5, block_number: 100, created_at: '2026-10-18 10:00:00', status: 'mismatch', reconcile_status: 'pending', reconcile_note: '金额不符' });
const payB = insertPay({ order_id: orderB.id, chain: 'BEP20', pay_address: orderB.pay_address, tx_hash: TX_B, event_key: '2', amount: 20.0002, block_number: 200, created_at: '2026-10-19 15:30:00', status: 'verified', reconcile_status: 'overpaid_pending', reconcile_note: '第二笔' });
const payC = insertPay({ order_id: null, chain: 'BEP20', pay_address: '0x2222222222222222222222222222222222222222', tx_hash: TX_C, event_key: '3', amount: 1, block_number: 300, created_at: '2026-10-20 01:00:00', status: 'unmatched', reconcile_status: 'pending', reconcile_note: '无法归属' });
db.prepare("INSERT INTO txid_claims (tx_hash, order_id, claimed_at, source) VALUES (?, ?, ?, 'chain_verified')").run(TX_B, orderB.id, '2026-10-19 15:30:00');

let r = await call('GET', '/api/admin/payments');
assert(r.status === 401 && r.json && r.json.ok === false, 'unauthenticated list is 401');

r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
assert(r.json && r.json.ok, 'admin login');
let cookie = '';
{
  const ctx = makeCtx();
  const req = new Request('http://test/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-API': '1' }, body: JSON.stringify({ setup_token: 'test-setup-token' }) });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
}
assert(cookie.indexOf('session_token=') === 0, 'session cookie set');
r = await call('GET', '/api/admin/payments', null, cookie);
assert(r.status === 403, 'must-change-password blocks payments list before password change');
r = await call('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'test-admin-password-123' }, cookie);
assert(r.json && r.json.ok, 'change-password');

delSetting('usdt_contracts');
r = await call('GET', '/api/admin/payments?page_size=20', null, cookie);
assert(r.json && r.json.ok === true && r.json.total === 3 && r.json.payments.length === 3, 'list returns 3 rows when contract setting missing: ' + JSON.stringify(r.json && { total: r.json.total, n: (r.json.payments || []).length }));
const rowA = byTx(r, TX_A);
const rowB = byTx(r, TX_B);
const rowC = byTx(r, TX_C);
assert(rowA && rowA.order_no === 'AIS-RECON-A' && rowA.actual_amount === 10.0001 && rowA.pay_method === 'OKX' && rowA.pay_chain === 'X Layer' && rowA.order_status === 'pending_payment' && rowA.payment_state === '' && rowA.order_tx_hash === '' && rowA.pending_tx_hash === 'pend-a', 'order join fields on matched X Layer row: ' + JSON.stringify(rowA));
assert(rowB && rowB.order_no === 'AIS-RECON-B' && rowB.actual_amount === 20.0002 && rowB.pay_method === 'Binance' && rowB.pay_chain === 'BEP20' && rowB.order_status === 'completed' && rowB.payment_state === 'overpaid_pending' && rowB.order_tx_hash === TX_B && rowB.pending_tx_hash === '', 'order join fields on matched BEP20 row: ' + JSON.stringify(rowB));
assert(rowC && rowC.order_no == null && rowC.actual_amount == null && rowC.pay_method == null && rowC.pay_chain == null && rowC.order_status == null && rowC.payment_state == null && rowC.order_tx_hash == null && rowC.pending_tx_hash == null, 'unmatched row order fields are null: ' + JSON.stringify(rowC));
assert(rowA.contract === XLAYER && rowB.contract === BEP20 && rowC.contract === BEP20, 'missing settings fall back to DEFAULT_USDT_CONTRACTS: ' + JSON.stringify([rowA.contract, rowB.contract, rowC.contract]));
assert(rowA.status === 'mismatch' && rowA.tx_hash === TX_A && rowA.chain === 'X Layer', 'existing payment columns kept');

const cols = db.prepare('PRAGMA table_info(payments)').all().map((c) => c.name);
assert(!cols.includes('contract') && !cols.includes('expected_contract'), 'payments table has no contract column: ' + cols.join(','));
assert(!Object.prototype.hasOwnProperty.call(db.prepare('SELECT * FROM payments WHERE id=?').get(payA.id), 'contract'), 'raw payments row has no contract column');

setSetting('usdt_contracts', JSON.stringify({ 'X Layer': OVERRIDE, 'BEP20': '   ' }));
r = await call('GET', '/api/admin/payments?chain=' + encodeURIComponent('X Layer'), null, cookie);
assert(r.json && r.json.payments.length === 1 && r.json.payments[0].id === payA.id && r.json.payments[0].contract === OVERRIDE, 'settings.usdt_contracts[X Layer] overrides default');
r = await call('GET', '/api/admin/payments?chain=BEP20', null, cookie);
assert(r.json && r.json.total === 2 && r.json.payments.every((p) => p.contract === BEP20), 'blank BEP20 setting falls back to default; chain filter returns both BEP20 rows');
setSetting('usdt_contracts', 'not-json');
r = await call('GET', '/api/admin/payments?tx_hash=' + TX_A, null, cookie);
assert(r.json && r.json.payments.length === 1 && r.json.payments[0].contract === XLAYER, 'invalid usdt_contracts JSON falls back to default');
setSetting('usdt_contracts', JSON.stringify({ 'X Layer': XLAYER, 'BEP20': BEP20 }));

r = await call('GET', '/api/admin/payments?order_no=AIS-RECON-A', null, cookie);
assert(idsOf(r).join(',') === String(payA.id) && r.json.total === 1, 'filter order_no exact');
r = await call('GET', '/api/admin/payments?order_no=AIS-RECON', null, cookie);
assert(r.json && r.json.total === 0 && r.json.payments.length === 0, 'order_no is exact, not prefix');
r = await call('GET', '/api/admin/payments?order_id=' + orderB.id, null, cookie);
assert(idsOf(r).join(',') === String(payB.id), 'existing order_id filter kept');
r = await call('GET', '/api/admin/payments?status=mismatch', null, cookie);
assert(idsOf(r).join(',') === String(payA.id), 'existing status filter kept');
r = await call('GET', '/api/admin/payments?tx_hash=' + TX_C, null, cookie);
assert(idsOf(r).join(',') === String(payC.id), 'filter tx_hash exact');
r = await call('GET', '/api/admin/payments?tx_hash=' + TX_C.slice(0, 16), null, cookie);
assert(r.json && r.json.total === 0, 'tx_hash prefix does not match');
r = await call('GET', '/api/admin/payments?tx_hash=' + TX_A.toUpperCase(), null, cookie);
assert(r.json && r.json.total === 0, 'tx_hash match is case-sensitive');
r = await call('GET', '/api/admin/payments?reconcile_status=overpaid_pending', null, cookie);
assert(idsOf(r).join(',') === String(payB.id) && r.json.payments[0].payment_state === 'overpaid_pending', 'filter reconcile_status');
r = await call('GET', '/api/admin/payments?from=2026-10-19&to=2026-10-19', null, cookie);
assert(idsOf(r).join(',') === String(payB.id), 'from/to date-only includes that calendar day');
r = await call('GET', '/api/admin/payments?from=2026-10-18&to=2026-10-19', null, cookie);
const span = idsOf(r).slice().sort((a, b) => a - b);
assert(span.join(',') === [payA.id, payB.id].join(',') && r.json.total === 2, 'from/to inclusive range: ' + span.join(','));
r = await call('GET', '/api/admin/payments?from=2026-10-19T16:00:00&to=2026-10-20', null, cookie);
assert(idsOf(r).join(',') === String(payC.id), 'datetime from is exclusive of earlier same-day rows; T normalized');
r = await call('GET', '/api/admin/payments?order_no=AIS-RECON-B&chain=BEP20&status=verified&reconcile_status=overpaid_pending&from=2026-10-19&to=2026-10-19', null, cookie);
assert(idsOf(r).join(',') === String(payB.id), 'filters combine with AND');
r = await call('GET', '/api/admin/payments?order_no=AIS-RECON-B&chain=' + encodeURIComponent('X Layer'), null, cookie);
assert(r.json && r.json.total === 0, 'AND mismatch returns empty');
r = await call('GET', '/api/admin/payments?contract=' + OVERRIDE, null, cookie);
assert(r.json && r.json.total === 3, 'contract query param is not a filter');
r = await call('GET', '/api/admin/payments?page=1&page_size=1', null, cookie);
assert(r.json && r.json.payments.length === 1 && r.json.payments[0].id === payC.id && r.json.total === 3 && r.json.page === 1 && r.json.page_size === 1 && r.json.total_pages === 3, 'pagination unchanged, newest id first');
r = await call('GET', '/api/admin/payments?page=2&page_size=1', null, cookie);
assert(r.json && r.json.payments.length === 1 && r.json.payments[0].id === payB.id && r.json.payments[0].contract === BEP20, 'page 2 still has derived contract');

r = await call('POST', '/api/admin/payments/' + payA.id + '/reconcile', { note: '已线下核对差额' }, cookie);
assert(r.json && r.json.ok === true, 'reconcile mismatch still succeeds: ' + JSON.stringify(r.json));
const afterA = db.prepare('SELECT status, reconcile_status, reconcile_note FROM payments WHERE id=?').get(payA.id);
assert(afterA.status === 'reconciled' && afterA.reconcile_status === 'resolved' && afterA.reconcile_note === '已线下核对差额', 'reconcile writes reconciled/resolved/note');
r = await call('POST', '/api/admin/payments/' + payC.id + '/reconcile', {}, cookie);
assert(r.status === 400 && r.json && !r.json.ok, 'reconcile still requires note');
const submitted = insertPay({ order_id: orderA.id, chain: 'X Layer', pay_address: orderA.pay_address, tx_hash: 'd'.repeat(64), event_key: '9', amount: 10.0001, block_number: 101, created_at: '2026-10-18 11:00:00', status: 'submitted', reconcile_status: '', reconcile_note: '' });
r = await call('POST', '/api/admin/payments/' + submitted.id + '/reconcile', { note: '不应直接对账' }, cookie);
assert(r.status === 409 && db.prepare('SELECT status FROM payments WHERE id=?').get(submitted.id).status === 'submitted', 'submitted still cannot be reconciled to posted/reconciled');
assert(db.prepare('SELECT tx_hash, order_id, source FROM txid_claims WHERE tx_hash=?').get(TX_B).order_id === orderB.id, 'reconcile does not delete txid_claims');
r = await call('DELETE', '/api/admin/txid-claims/' + TX_B, null, cookie);
assert(r.status === 404, 'no delete txid_claims admin route');
r = await call('DELETE', '/api/admin/payments/' + payB.id, null, cookie);
assert(r.status === 404, 'no delete payment route');
assert(!!db.prepare('SELECT tx_hash FROM txid_claims WHERE tx_hash=?').get(TX_B), 'claim row still present');

assert(html.includes("['payments',ic('clipboard')+' 付款对账']") && html.includes("t === 'payments'"), 'admin shell has payments tab');
assert(html.includes('派生合约 contract') && html.includes('adminPayReconcile'), 'admin tab shows derived contract and existing reconcile action');
assert(!/adminDeleteTxid|delete-txid|删除认领按钮/.test(html), 'admin UI does not offer a txid claim delete action');

console.log('PAYMENTS ADMIN LIST TEST DONE');
if (process.exitCode) process.exit(process.exitCode);
