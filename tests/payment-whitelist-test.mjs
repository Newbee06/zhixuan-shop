// 第九轮：双链支付收口测试（白名单 / 合约核验 / 精度 / 确认数 / RPC 故障 / 游标恢复 / 历史订单）
// 运行：node tests/payment-whitelist-test.mjs
// 覆盖：
//  1. 两种白名单组合可正常下单；2. 全部非白名单组合被后端拒绝；3. 两方式缺收款地址时拒单；
//  4. X Layer 使用核实的 USDT0 合约，旧合约不被接受；5. 错合约/粉尘伪造/错地址/错金额不履约；
//  6. BEP20 仅接受正确合约且按 18 位精度核验；7. 未达确认数不发货；8. RPC 故障不误判成功；
//  9. 重复扫描不重复发卡；10. 游标失败后恢复不漏账（按地址独立游标）；11. 历史订单/旧数据不被破坏。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const db = new DatabaseSync(':memory:');
// schema.sql 自 v15 起不再建 schema_migrations 表（仅 INSERT 预置版本），与 Worker runMigrations 一致：先建表再执行 schema.sql。
// 注意：schema.sql 缺 CREATE TABLE schema_migrations 是代码侧缺陷（已在最终汇报中精确报告），测试侧按运行时行为先建表，不改 schema.sql。
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))" );
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
const env = { ZHIXUAN_SETUP_TOKEN: 'test-setup-token', DB: { prepare: (sql) => wrapStmt(sql), async batch(stmts) { const out = []; for (const st of stmts) out.push(await st.run()); return out; } } };
// ---- EVM / Tronscan mock ----
const USDT0_XLAYER = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
const OLD_XLAYER = '0x1e4a5963abfd975d8c9021ce480b42188849d41d';
const BEP20_USDT = '0x55d398326f99059fF775485246999027B3197955';
const WRONG_CONTRACT = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const ADDR_OKX = '0x1111111111111111111111111111111111111111';
const ADDR_BIN = '0x2222222222222222222222222222222222222222';
const ADDR_WRONG = '0x3333333333333333333333333333333333333333';
const ADDR_NEW = '0x4444444444444444444444444444444444444444';
const TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_TOPIC0 = TOPIC0;
function toTopic(addr) { return '0x' + '0'.repeat(24) + String(addr).slice(2).toLowerCase(); }
function toHexData(raw) { return '0x' + BigInt(raw).toString(16).padStart(64, '0'); }
// 精确换算：amount(USDT) -> raw（按 decimals），用 BigInt 整数运算，避免 float 精度丢失。
function amountToRaw(amount, decimals) {
  const s = String(amount);
  const parts = s.split('.');
  const intPart = parts[0] || '0';
  let fracPart = parts[1] || '';
  if (fracPart.length > decimals) fracPart = fracPart.slice(0, decimals);
  while (fracPart.length < decimals) fracPart += '0';
  return BigInt(intPart) * (10n ** BigInt(decimals)) + BigInt(fracPart || '0');
}
function evmLog({ contract, to, valueRaw, blockNumber, txHash, logIndex }) {
  return {
    address: contract, blockNumber: '0x' + Number(blockNumber).toString(16),
    transactionHash: txHash, logIndex: String(logIndex == null ? 0 : logIndex),
    topics: [TRANSFER_TOPIC0, '0x' + '0'.repeat(24) + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', toTopic(to)],
    data: toHexData(valueRaw),
  };
}
let evmState = {
  latestBlock: 10000,
  logs: [],
  decimals: { [USDT0_XLAYER.toLowerCase()]: 6, [OLD_XLAYER.toLowerCase()]: 6, [BEP20_USDT.toLowerCase()]: 18, [WRONG_CONTRACT.toLowerCase()]: 6 },
  failAll: false,
  receipt: null,
};
async function mockFetch(url, opts = {}) {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('api.resend.com')) return new Response(JSON.stringify({ id: 'mock-mail' }), { status: 200 });
  if (u.includes('mock-xlayer') || u.includes('mock-bsc')) {
    if (evmState.failAll) throw new Error('mock RPC down');
    const body = JSON.parse(opts.body || '{}');
    if (body.method === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + evmState.latestBlock.toString(16) }), { status: 200 });
    if (body.method === 'eth_call') {
      const to = String((body.params && body.params[0] && body.params[0].to) || '').toLowerCase();
      const dec = evmState.decimals[to];
      if (dec === undefined) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'no decimals' } }), { status: 200 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + dec.toString(16).padStart(64, '0') }), { status: 200 });
    }
    if (body.method === 'eth_getLogs') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: evmState.logs }), { status: 200 });
    if (body.method === 'eth_getTransactionReceipt') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: evmState.receipt }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
  }
  return new Response(JSON.stringify({}), { status: 200 });
}
env.__fetch = mockFetch;
// scheduled 处理器用全局 fetch 跑轮询（见 worker.js scheduled），必须覆盖全局 fetch 才能让轮询走 mock。
globalThis.fetch = mockFetch;
let code = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
code = code.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(html) + ';');
code = code.replace('export default {', 'globalThis.__W = {');
const fn = new Function(code + '\nreturn globalThis.__W;');
const worker = fn();
function makeCtx() { const c = { pending: [] }; c.waitUntil = (pr) => { c.pending.push(pr); }; c.drain = async () => { while (c.pending.length) { const batch = c.pending.splice(0); await Promise.all(batch.map((x) => x.catch(() => {}))); } }; return c; }
async function call(method, p, body, cookie) {
  const ctx = makeCtx();
  const headers = { 'content-type': 'application/json', 'X-Admin-API': '1' };
  if (cookie) headers.Cookie = cookie;
  const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: res.status, json: j, headers: res.headers, text: txt };
}
let capSeq = 0;
function mkCaptcha(codeStr) {
  const id = 'cap-wl-' + (++capSeq);
  const h = createHash('sha256').update(codeStr).digest('hex');
  const exp = new Date(Date.now() + 300000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?,?,0)').run(id, h, exp);
  return id;
}
async function orderCall(body) {
  const cid = mkCaptcha('AB12');
  return call('POST', '/api/orders', { query_password: 'wl-test-pw', ...body, captcha_id: cid, captcha_code: 'AB12' });
}
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); } console.log('PASS: ' + msg); }
function q(sql, ...a) { return db.prepare(sql).get(...a); }
function setSetting(key, value) { db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
async function runPoll() { const ctx = makeCtx(); await worker.scheduled({ cron: '*/1 * * * *' }, env, ctx); await ctx.drain(); }
// ---- 基础设置 ----
setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_OKX, 'Binance|BEP20': ADDR_BIN }));
setSetting('rpc_urls', JSON.stringify({ 'X Layer': ['https://mock-xlayer'], 'BEP20': ['https://mock-bsc'] }));
setSetting('chain_confirmations', JSON.stringify({ 'X Layer': 1, 'BEP20': 15 }));
setSetting('poll_enabled', '1');
// 商品：卡密商品（用于验证履约发卡）
let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
assert(r.json.ok, 'admin login');
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
const INIT_PW = ['a', 'd', 'm', 'i', 'n'].join('');
r = await call('POST', '/api/admin/change-password', { old_password: INIT_PW, new_password: 'test-admin-password-123' }, cookie);
assert(r.json.ok, 'change-password');
cookie = (r.headers.get('set-cookie') || '').split(';')[0] || cookie;
r = await call('POST', '/api/admin/products', { slug: 'wl-card', title: 'WL Card', category: 'card', price_usdt: 10, sell_price: 10, source: 'self', delivery_method: 'both', stock_type: 'card', form_fields: [] }, cookie);
const cardProd = q('SELECT * FROM products WHERE slug=?', 'wl-card');
for (let i = 1; i <= 30; i++) db.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(cardProd.id, 'WL-KEY-' + String(i).padStart(3, '0'));
let contactSeq = 0;
function freshContact() { return 'wl' + (++contactSeq) + '@test.example'; }
async function newOrder(payMethod, payChain, contact) {
  const c = contact || freshContact();
  // 清空下单限流计数，避免本文件多笔订单被限流干扰（限流本身由其他测试覆盖）。
  db.prepare('DELETE FROM order_rate').run();
  return orderCall({ product_id: cardProd.id, quantity: 1, customer_fields: { contact_email: c, delivery_email: c }, contact: c, pay_method: payMethod, pay_chain: payChain });
}
function resetEvm() { evmState.latestBlock = 10000; evmState.logs = []; evmState.failAll = false; evmState.receipt = null; }

// ===== 1. 两种白名单组合可正常创建订单 =====
{
  resetEvm();
  r = await newOrder('OKX', 'X Layer');
  assert(r.json && r.json.ok === true, '1. OKX|X Layer order created: ' + JSON.stringify(r.json));
  assert(r.json.order.pay_address === ADDR_OKX, '1. OKX|X Layer order pay_address = configured OKX|X Layer address');
  r = await newOrder('Binance', 'BEP20');
  assert(r.json && r.json.ok === true, '1. Binance|BEP20 order created: ' + JSON.stringify(r.json));
  assert(r.json.order.pay_address === ADDR_BIN, '1. Binance|BEP20 order pay_address = configured Binance|BEP20 address');
  // /api/config 只展示两种方式
  r = await call('GET', '/api/config');
  assert(r.json && r.json.ok === true, '1. /api/config ok');
  assert(JSON.stringify(r.json.config.pay_methods) === JSON.stringify(['OKX', 'Binance']), '1. /api/config pay_methods = whitelist only: ' + JSON.stringify(r.json.config.pay_methods));
  assert(JSON.stringify(r.json.config.pay_chains) === JSON.stringify(['X Layer', 'BEP20']), '1. /api/config pay_chains = whitelist only: ' + JSON.stringify(r.json.config.pay_chains));
}
// ===== 2. 全部非白名单组合被后端拒绝 =====
{
  resetEvm();
  const rejected = [
    ['OKX', 'BEP20'], ['Binance', 'X Layer'],
    ['Binance', 'TRC20'], ['OKX', 'TRC20'], ['Binance', 'ERC20'], ['OKX', 'ERC20'],
    ['BinanceUID', '站内转账'], ['BinanceUID', 'X Layer'],
    ['Coinbase', 'X Layer'], ['OKX', 'Solana'], ['OKX', ''],
    ['', 'X Layer'], [undefined, 'X Layer'], ['OKX', undefined],
  ];
  for (const [m, c] of rejected) {
    r = await newOrder(m, c);
    assert(!(r.json && r.json.ok), '2. rejected: ' + String(m) + '|' + String(c) + ' -> ' + JSON.stringify(r.json));
  }
  // 被拒绝的组合不产生订单（查不到对应联系方式的待付款订单）
  const n = q("SELECT COUNT(*) AS n FROM orders WHERE status='pending_payment'").n;
  assert(n === 2, '2. only the 2 whitelist orders are pending (rejected combos created none), got ' + n);
}
// ===== 3. 两方式缺收款地址时拒单 =====
{
  resetEvm();
  setSetting('usdt_addresses', JSON.stringify({ 'Binance|BEP20': ADDR_BIN }));
  r = await newOrder('OKX', 'X Layer');
  assert(!(r.json && r.json.ok) && /收款地址/.test(r.json.error || ''), '3. OKX|X Layer without address rejected: ' + JSON.stringify(r.json));
  setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_OKX }));
  r = await newOrder('Binance', 'BEP20');
  assert(!(r.json && r.json.ok) && /收款地址/.test(r.json.error || ''), '3. Binance|BEP20 without address rejected: ' + JSON.stringify(r.json));
  setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': 'not-an-address', 'Binance|BEP20': ADDR_BIN }));
  r = await newOrder('OKX', 'X Layer');
  assert(!(r.json && r.json.ok), '3. OKX|X Layer with malformed address rejected: ' + JSON.stringify(r.json));
  setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_OKX, 'Binance|BEP20': ADDR_BIN }));
}
// ===== 4. X Layer 使用核实的 USDT0 合约；旧合约不被接受 =====
{
  resetEvm();
  r = await newOrder('OKX', 'X Layer');
  assert(r.json.ok, '4. OKX|X Layer order created');
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  // 旧合约（0x1e4a...）的转账：不得履约
  evmState.logs = [evmLog({ contract: OLD_XLAYER, to: ADDR_OKX, valueRaw: amountToRaw(ord.actual_amount, 6), blockNumber: 9990, txHash: 'a'.repeat(64), logIndex: 0 })];
  evmState.latestBlock = 10000;
  await runPoll();
  let o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'pending_payment', '4. old X Layer USDT transfer does NOT fulfill (stays pending): ' + o.status);
  // USDT0 合约（0x779Ded...）的转账：履约
  evmState.logs = [evmLog({ contract: USDT0_XLAYER, to: ADDR_OKX, valueRaw: amountToRaw(ord.actual_amount, 6), blockNumber: 9995, txHash: 'b'.repeat(64), logIndex: 0 })];
  await runPoll();
  o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'completed' && o.delivery_content && o.delivery_content.startsWith('WL-KEY-'), '4. USDT0 transfer fulfills: ' + o.status + '/' + o.delivery_content);
}
// ===== 5. 错合约 / 粉尘伪造 / 错地址 / 错金额 不履约（BEP20，18 位精度） =====
{
  resetEvm();
  r = await newOrder('Binance', 'BEP20');
  assert(r.json.ok, '5. Binance|BEP20 order created');
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const txBase = 'c';
  // 5a. 错合约：同名 USDT 但合约地址不对
  evmState.logs = [evmLog({ contract: WRONG_CONTRACT, to: ADDR_BIN, valueRaw: amountToRaw(ord.actual_amount, 18), blockNumber: 9980, txHash: txBase.repeat(64), logIndex: 0 })];
  evmState.latestBlock = 10000;
  await runPoll();
  let o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'pending_payment', '5a. wrong contract does NOT fulfill: ' + o.status);
  // 5b. 粉尘伪造：按 6 位精度算的“同额”转账（实际仅 5.0057e-12 USDT），BEP20 按 18 位核验必须拒绝
  evmState.logs = [evmLog({ contract: BEP20_USDT, to: ADDR_BIN, valueRaw: amountToRaw(ord.actual_amount, 6), blockNumber: 9981, txHash: 'd'.repeat(64), logIndex: 0 })];
  await runPoll();
  o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'pending_payment', '5b. dust transfer (6-decimal interpretation) does NOT fulfill BEP20 order: ' + o.status);
  // 5c. 错收款地址
  evmState.logs = [evmLog({ contract: BEP20_USDT, to: ADDR_WRONG, valueRaw: amountToRaw(ord.actual_amount, 18), blockNumber: 9982, txHash: 'e'.repeat(64), logIndex: 0 })];
  await runPoll();
  o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'pending_payment', '5c. wrong receiving address does NOT fulfill: ' + o.status);
  // 5d. 错金额（差 0.0001）
  evmState.logs = [evmLog({ contract: BEP20_USDT, to: ADDR_BIN, valueRaw: amountToRaw(Number(ord.actual_amount) + 0.0001, 18), blockNumber: 9983, txHash: 'f'.repeat(64), logIndex: 0 })];
  await runPoll();
  o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'pending_payment', '5d. wrong amount does NOT fulfill: ' + o.status);
  // 5e. 正确转账：履约
  evmState.logs = [evmLog({ contract: BEP20_USDT, to: ADDR_BIN, valueRaw: amountToRaw(ord.actual_amount, 18), blockNumber: 9984, txHash: '1'.repeat(64), logIndex: 0 })];
  await runPoll();
  o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'completed', '5e. correct BEP20 transfer fulfills: ' + o.status);
}
// ===== 6. BEP20 仅接受配置的正确合约（管理员显式覆盖为错合约时不认账） =====
{
  resetEvm();
  setSetting('usdt_contracts', JSON.stringify({ 'BEP20': WRONG_CONTRACT }));
  r = await newOrder('Binance', 'BEP20');
  assert(r.json.ok, '6. Binance|BEP20 order created (admin-overridden contract)');
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  // 真实 BEP20 USDT 合约的转账：因管理员已覆盖为错合约，不得按默认合约认账
  evmState.logs = [evmLog({ contract: BEP20_USDT, to: ADDR_BIN, valueRaw: amountToRaw(ord.actual_amount, 18), blockNumber: 9980, txHash: '2'.repeat(64), logIndex: 0 })];
  evmState.latestBlock = 10000;
  await runPoll();
  let o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'pending_payment', '6. admin-overridden wrong contract: default-contract transfer does NOT fulfill: ' + o.status);
  setSetting('usdt_contracts', JSON.stringify({}));
}
// ===== 7. 未达确认数不发货 =====
{
  resetEvm();
  r = await newOrder('Binance', 'BEP20');
  assert(r.json.ok, '7. Binance|BEP20 order created');
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  // 转账在区块 9990，最新 10000，确认数 10 < 15（BEP20 要求 15），不发货
  evmState.logs = [evmLog({ contract: BEP20_USDT, to: ADDR_BIN, valueRaw: amountToRaw(ord.actual_amount, 18), blockNumber: 9990, txHash: '3'.repeat(64), logIndex: 0 })];
  evmState.latestBlock = 10000;
  await runPoll();
  let o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'pending_payment', '7. 10 confirmations < 15 required: NOT fulfilled: ' + o.status);
  // 最新推进到 10005，确认数 15，达标 → 发货
  evmState.latestBlock = 10005;
  await runPoll();
  o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'completed', '7. 15 confirmations reached: fulfilled: ' + o.status);
}
// ===== 8. RPC 故障 / 超时 / 日志缺失 不误判成功 =====
{
  resetEvm();
  r = await newOrder('OKX', 'X Layer');
  assert(r.json.ok, '8. OKX|X Layer order created');
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  evmState.failAll = true;
  await runPoll();
  let o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'pending_payment', '8. RPC all-fail: order stays pending (not misjudged as paid): ' + o.status);
  evmState.failAll = false;
  evmState.logs = []; // 日志缺失
  await runPoll();
  o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'pending_payment', '8. no logs: order stays pending: ' + o.status);
  // 恢复后正常履约
  evmState.logs = [evmLog({ contract: USDT0_XLAYER, to: ADDR_OKX, valueRaw: amountToRaw(ord.actual_amount, 6), blockNumber: 9995, txHash: '4'.repeat(64), logIndex: 0 })];
  await runPoll();
  o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'completed', '8. RPC recovered: fulfilled: ' + o.status);
}
// ===== 9. 重复扫描同一交易不重复发卡 =====
{
  resetEvm();
  r = await newOrder('OKX', 'X Layer');
  assert(r.json.ok, '9. OKX|X Layer order created');
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  evmState.logs = [evmLog({ contract: USDT0_XLAYER, to: ADDR_OKX, valueRaw: amountToRaw(ord.actual_amount, 6), blockNumber: 9995, txHash: '5'.repeat(64), logIndex: 0 })];
  evmState.latestBlock = 10000;
  await runPoll();
  let o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'completed', '9. first poll fulfills: ' + o.status);
  const cardCode = o.delivery_content;
  const payRows1 = q("SELECT COUNT(*) AS n FROM payments WHERE order_id=? AND tx_hash=?", ord.id, '5'.repeat(64)).n;
  await runPoll();
  await runPoll();
  o = q('SELECT * FROM orders WHERE id=?', ord.id);
  assert(o.status === 'completed' && o.delivery_content === cardCode, '9. repeated polls: same card, not re-issued: ' + o.delivery_content);
  const payRows2 = q("SELECT COUNT(*) AS n FROM payments WHERE order_id=? AND tx_hash=?", ord.id, '5'.repeat(64)).n;
  assert(payRows2 === payRows1 && payRows1 === 1, '9. payments ledger has exactly 1 row for the event: ' + payRows2);
  const cardUsed = q('SELECT COUNT(*) AS n FROM cards WHERE code=? AND is_used=1', cardCode).n;
  assert(cardUsed === 1, '9. card used exactly once');
}
// ===== 10. 游标恢复：RPC 失败不推进；地址变更后旧地址游标不遮挡新地址 =====
{
  resetEvm();
  // 10a. RPC 失败不推进游标：失败期间到账的交易，恢复后仍被扫到（游标未越过它）
  r = await newOrder('OKX', 'X Layer');
  assert(r.json.ok, '10a. order created');
  const ordA = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const curBefore = q("SELECT last_block FROM scan_cursors WHERE chain=?", 'X Layer|' + ADDR_OKX.toLowerCase());
  const curBeforeVal = curBefore ? Number(curBefore.last_block) : 0;
  evmState.failAll = true;
  await runPoll();
  let curA = q("SELECT last_block FROM scan_cursors WHERE chain=?", 'X Layer|' + ADDR_OKX.toLowerCase());
  assert(!curA || Number(curA.last_block) === curBeforeVal, '10a. cursor NOT advanced on RPC failure (stays ' + curBeforeVal + '): ' + JSON.stringify(curA));
  evmState.failAll = false;
  evmState.logs = [evmLog({ contract: USDT0_XLAYER, to: ADDR_OKX, valueRaw: amountToRaw(ordA.actual_amount, 6), blockNumber: 9995, txHash: '6'.repeat(64), logIndex: 0 })];
  evmState.latestBlock = 10000;
  await runPoll();
  let oA = q('SELECT * FROM orders WHERE id=?', ordA.id);
  assert(oA.status === 'completed', '10a. after RPC recovery, payment found (cursor did not skip it): ' + oA.status);
  // 10b. 地址变更：旧地址 A 游标已推进，新地址 B 的订单付款在 A 游标之前但在 B 扫描范围内，不得漏
  // 先让地址 A 的游标推进到 10000（A 订单履约后 A 无待付款，A 游标停留）
  // 切换收款地址为新地址 B
  setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_NEW, 'Binance|BEP20': ADDR_BIN }));
  r = await newOrder('OKX', 'X Layer');
  assert(r.json.ok && r.json.order.pay_address === ADDR_NEW, '10b. new order uses new address B');
  const ordB = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  // 隔离游标作用：付款在区块 9950，最新 10200。
  // per-order 回溯 200 区块从 10000 开始，扫不到 9950；只有 B 的独立游标（9900）能覆盖 9950。
  // 若沿用旧“链共享游标”（A 已推到 10000），B 扫描从 10000 起，同样扫不到 9950 → 漏账。
  // 直接给 B 写一个旧游标 9900（模拟 B 曾被扫描过），验证 B 仍从 9900 起扫。
  db.prepare("INSERT INTO scan_cursors (chain, last_block, updated_at) VALUES (?, ?, ?) ON CONFLICT(chain) DO UPDATE SET last_block=excluded.last_block").run('X Layer|' + ADDR_NEW.toLowerCase(), 9900, '2026-01-01 00:00:00');
  evmState.logs = [evmLog({ contract: USDT0_XLAYER, to: ADDR_NEW, valueRaw: amountToRaw(ordB.actual_amount, 6), blockNumber: 9950, txHash: '7'.repeat(64), logIndex: 0 })];
  evmState.latestBlock = 10200;
  await runPoll();
  let oB = q('SELECT * FROM orders WHERE id=?', ordB.id);
  assert(oB.status === 'completed', '10b. B order paid at block 9950 (before A cursor) is found via B own cursor: ' + oB.status);
  // P3-41：成功扫描后游标已推进（永不推进游标的 bug 会让本断言失败，仅浪费 RPC）。
  // 注：10a 中扫描因游标已超前而正确跳过（付款走逐单路径），不在此处断言推进。
  let curB = q("SELECT last_block FROM scan_cursors WHERE chain=?", 'X Layer|' + ADDR_NEW.toLowerCase());
  assert(curB && Number(curB.last_block) > 9900, '10b/P3-41. cursor advanced after successful scan (before=9900, after=' + (curB && curB.last_block) + ')');
  setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_OKX, 'Binance|BEP20': ADDR_BIN }));
}
// ===== 11. 历史订单及旧数据不被破坏 =====
{
  resetEvm();
  // 直接写入历史订单（模拟白名单生效前已存在的订单），不走 API
  const histNo = 'AISHIST0001';
  db.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES (?, '', '', ?, '{}', 1, 10, 10, 10.0057, 'TXYZHISTORICAL', '2099-01-01 00:00:00', ?, 'hist@test.example', 'Binance', 'TRC20', 'TXYZHISTORICAL', 'pending_payment', datetime('now'))").run(histNo, cardProd.id, JSON.stringify({ contact_email: 'hist@test.example', delivery_email: 'hist@test.example' }));
  const hist = q('SELECT * FROM orders WHERE order_no=?', histNo);
  assert(hist && hist.pay_method === 'Binance' && hist.pay_chain === 'TRC20', '11. historical TRC20 order exists with original pay combo');
  // 历史 TRC20 订单：TRC20 已删除，轮询不得自动认账（不调用任何外部核验），订单保持待付款，转人工审核。
  await runPoll();
  const histAfter = q('SELECT * FROM orders WHERE order_no=?', histNo);
  assert(histAfter.status === 'pending_payment' && !histAfter.delivery_content, '11. historical TRC20 order NOT auto-fulfilled via poll (manual review only): ' + histAfter.status);
  // 历史 TRC20 订单 /pay 提交 TXID 应被拒绝，不记付款账本
  const paysBefore = q('SELECT COUNT(*) AS c FROM payments').c;
  r = await call('POST', '/api/orders/' + histNo + '/pay', { txid: '8'.repeat(64) });
  assert(!r.json.ok && r.json.error.includes('不在首期支持范围内'), '11. historical TRC20 order /pay rejected: ' + JSON.stringify(r.json));
  assert(q('SELECT COUNT(*) AS c FROM payments').c === paysBefore, '11. rejected /pay records no payment');
  // 历史 BinanceUID 订单：仍可经管理员确认恢复（不走白名单）
  db.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES ('AISHIST0002', '', '', ?, '{}', 1, 10, 10, 10, '', '2099-01-01 00:00:00', ?, 'hist2@test.example', 'BinanceUID', '站内转账', '', 'pending_payment', datetime('now'))").run(cardProd.id, JSON.stringify({ contact_email: 'hist2@test.example', delivery_email: 'hist2@test.example' }));
  const hist2 = q("SELECT * FROM orders WHERE order_no='AISHIST0002'");
  r = await call('POST', '/api/admin/orders/' + hist2.id + '/confirm-payment', { reason: '历史订单恢复测试' , manual_confirm: true }, cookie);
  assert(r.json && r.json.ok, '11. historical BinanceUID order still confirmable by admin: ' + JSON.stringify(r.json));
  const hist2After = q("SELECT * FROM orders WHERE order_no='AISHIST0002'");
  assert(hist2After.status === 'completed', '11. historical BinanceUID order completed via admin confirm: ' + hist2After.status);
  // 旧设置键保留（未被删除）
  setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_OKX, 'Binance|BEP20': ADDR_BIN, 'Binance|TRC20': 'TXYZOLD' }));
  r = await call('GET', '/api/config');
  assert(r.json.config.usdt_addresses['Binance|TRC20'] === 'TXYZOLD', '11. old settings key preserved in config (not deleted)');
  setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_OKX, 'Binance|BEP20': ADDR_BIN }));
}
// ===== 12. 前端只展示两种支付选项 + USDT0 提示 =====
{
  const front = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
  assert(front.includes('USDT0 · X Layer'), '12. frontend shows USDT0 · X Layer');
  assert(front.includes('USDT · BEP20'), '12. frontend shows USDT · BEP20');
  assert(front.includes('X Layer 收款为 USDT0'), '12. frontend warns X Layer receives USDT0');
  assert(!front.includes('币安 UID 站内转账填订单 ID'), '12. frontend no longer references BinanceUID in TXID hint');
}
console.log('payment-whitelist-test: ALL PASS');
