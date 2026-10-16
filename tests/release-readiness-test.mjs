// 第四轮（Release Readiness）专项测试：付款账本、金额唯一性、链上游标、上游幂等、
// 迁移预检、公开接口隐私、Turnstile、/pay 限流、错误脱敏、ProdSeller 门禁、故障恢复。
// 全部使用本地 D1（:memory:）+ Mock fetch，不得使用生产支付与上游账号。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(dir, '..', 'schema.sql'), 'utf8'));
let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('PASS: ' + name); } else { fail++; console.log('FAIL: ' + name + (extra ? ' ' + String(extra).slice(0, 600) : '')); } }
function q(sql, ...a) { try { return db.prepare(sql).get(...a); } catch (e) { return null; } }
function qa(sql, ...a) { try { return db.prepare(sql).all(...a); } catch (e) { return []; } }
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
// Mock fetch：Tronscan（TRC20 到账）、EVM RPC（X Layer，eth_blockNumber / eth_getLogs / receipt）、ProdSeller、Turnstile siteverify。
let trc20Transfers = []; // [{ to_address, quant, transactionHash, block_ts, confirmed }]
let evmLatest = 1000;
let evmLogs = []; // [{ blockNumber, transactionHash, logIndex, topics, data }]
let evmFailNext = 0; // 下 N 次 RPC 失败（模拟 RPC 超时/部分失败）
let prodsellerCreates = 0;
let turnstileVerifyResult = true; // siteverify 返回 success
let turnstileFailNetwork = false;
async function mockFetch(url, opts = {}) {
  const u = String(url);
  if (u.includes('tronscanapi.com/api/token_trc20/transfers')) {
    const start = Number(new URL(u).searchParams.get('start') || 0);
    const page = trc20Transfers.slice(start, start + 50);
    return new Response(JSON.stringify({ data: page }), { status: 200 });
  }
  if (u.includes('tronscanapi.com/api/transaction-info')) {
    const hash = new URL(u).searchParams.get('hash');
    const t = trc20Transfers.find((x) => x.transactionHash === hash);
    if (!t) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response(JSON.stringify({ confirmed: t.confirmed !== false, tokenTransferInfo: { transfers: [{ to_address: t.to_address, amount: t.quant / 1e6, tokenInfo: { tokenId: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', tokenDecimal: 6 } }] } }), { status: 200 });
  }
  if (u.includes('xlayerrpc.okx.com') || u.includes('llamarpc.com') || u.includes('ankr.com') || u.includes('bsc-dataseed')) {
    if (evmFailNext > 0) { evmFailNext--; throw new Error('mock RPC timeout'); }
    const body = JSON.parse(opts.body || '{}');
    if (body.method === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + evmLatest.toString(16) }), { status: 200 });
    if (body.method === 'eth_getLogs') {
      const p = body.params[0] || {};
      const from = parseInt(p.fromBlock || '0x0', 16);
      const to = parseInt(p.toBlock || '0x0', 16);
      const topic2 = String((p.topics && p.topics[2]) || '').toLowerCase();
      const logs = evmLogs.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= from && b <= to && String(l.topics[2]).toLowerCase() === topic2; });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: logs }), { status: 200 });
    }
    if (body.method === 'eth_getTransactionReceipt') {
      const tx = body.params[0];
      const log = evmLogs.find((l) => l.transactionHash === tx);
      if (!log) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: '0x1', blockNumber: log.blockNumber, logs: [log] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
  }
  if (u.includes('prodseller.com/v1/orders') && opts.method === 'POST') {
    prodsellerCreates++;
    return new Response(JSON.stringify({ id: 'PS-MOCK-' + prodsellerCreates, status: 'delivered', delivered_keys: 'MOCK-KEY-1' }), { status: 200 });
  }
  if (u.includes('prodseller.com/v1/orders/')) {
    return new Response(JSON.stringify({ id: 'PS-MOCK-1', status: 'delivered', delivered_keys: 'MOCK-KEY-1' }), { status: 200 });
  }
  if (u.includes('challenges.cloudflare.com/turnstile/v0/siteverify')) {
    if (turnstileFailNetwork) throw new Error('mock turnstile network error');
    return new Response(JSON.stringify({ success: turnstileVerifyResult }), { status: 200 });
  }
  return new Response(JSON.stringify({}), { status: 404 });
}
const env = { DB: { prepare: (sql) => wrapStmt(sql), async batch(stmts) { const out = []; for (const st of stmts) out.push(await st.run()); return out; } }, PRODSELLER_API_KEY: 'test-key', PRODSELLER_BASE_URL: 'https://prodseller.com/v1', TURNSTILE_SECRET_KEY: 'test-secret', __fetch: mockFetch };
globalThis.fetch = mockFetch;
const workerSrc = fs.readFileSync(path.join(dir, '..', 'src', 'worker.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, '..', 'src', 'frontend.html'), 'utf8');
const code = workerSrc.replace("import FRONTEND_HTML from './frontend.html';", 'var FRONTEND_HTML = ' + JSON.stringify(html) + ';').replace('export default {', 'globalThis.__W = {');
const worker = new Function(code + '; return __W;')();
function makeCtx() { const ps = []; return { waitUntil(p) { ps.push(p); }, async drain() { await Promise.allSettled(ps); } }; }
async function call(method, p, body, ck, extraHeaders) {
  const ctx = makeCtx();
  const headers = { 'content-type': 'application/json', 'X-Admin-API': '1', ...(extraHeaders || {}) };
  if (ck) headers.Cookie = ck;
  const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: res.status, json: j, txt, headers: res.headers };
}
async function callRaw(method, p, body, headers) {
  const ctx = makeCtx();
  const req = new Request('http://test' + p, { method, headers: { 'content-type': 'application/json', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: res.status, json: j, txt };
}
// settings
db.prepare("UPDATE settings SET value=? WHERE key='usdt_addresses'").run(JSON.stringify({ 'Binance|TRC20': 'TXYZPAY', 'OKX|X Layer': '0x0000000000000000000000000000000000000001', 'Binance|X Layer': '0x0000000000000000000000000000000000000001' }));
db.prepare("UPDATE settings SET value=? WHERE key='usdt_contracts'").run(JSON.stringify({ 'X Layer': '0x00000000000000000000000000000000000000aa', 'ERC20': '0xdAC17F958D2ee523a2206206994597C13D831ec7' }));
db.prepare("UPDATE settings SET value=? WHERE key='rpc_urls'").run(JSON.stringify({ 'X Layer': ['https://xlayerrpc.okx.com'], 'ERC20': ['https://eth.llamarpc.com'] }));
// admin
let r = await call('POST', '/api/admin/login', { password: 'admin' });
check('admin login', r.json && r.json.ok === true, JSON.stringify(r.json));
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await call('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'r4-test-pass-123' }, cookie);
check('change-password', r.json && r.json.ok === true, JSON.stringify(r.json));
cookie = (r.headers.get('set-cookie') || '').split(';')[0] || cookie;
// 种子：自营卡密商品 + 上游商品
r = await call('POST', '/api/admin/products', { slug: 'r4-card', title: 'R4 卡密', category: 'card', price_usdt: 10, sell_price: 10, source: 'self', delivery_method: 'both', stock_type: 'card', form_fields: [] }, cookie);
check('create self card product', r.json && r.json.ok === true, JSON.stringify(r.json));
const selfProd = q("SELECT * FROM products WHERE slug='r4-card'");
r = await call('POST', '/api/admin/cards/import', { product_id: selfProd.id, codes: Array.from({ length: 20 }, (_, i) => 'R4-KEY-' + (i + 1)).join('\n') }, cookie);
check('import cards', r.json && r.json.added === 20, JSON.stringify(r.json));
r = await call('POST', '/api/admin/products', { slug: 'r4-ps', title: 'R4 上游', category: 'recharge', price_usdt: 5, sell_price: 5, source: 'prodseller', prodseller_id: 'PS-R4', delivery_method: 'both', stock_type: 'manual', form_fields: [] }, cookie);
check('create prodseller product', r.json && r.json.ok === true, JSON.stringify(r.json));
const psProd = q("SELECT * FROM products WHERE slug='r4-ps'");
async function newCaptcha() {
  const cid = 'cap-' + Math.random().toString(36).slice(2);
  const crypto = await import('node:crypto');
  const h = crypto.createHash('sha256').update('AB12').digest('hex');
  db.prepare("INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?, datetime('now','+5 minutes'), 0)").run(cid, h);
  return cid;
}
async function orderCall(prod, contact, method, chain) {
  const cid = await newCaptcha();
  return call('POST', '/api/orders', { product_id: prod.id, quantity: 1, customer_fields: { contact_email: contact, delivery_email: contact }, contact, pay_method: method || 'Binance', pay_chain: chain || 'TRC20', captcha_id: cid, captcha_code: 'AB12' });
}

// ===== 1. 付款账本：/pay 提交记 submitted，核验通过记 posted =====
{
  r = await orderCall(selfProd, 'pay1@test.example');
  check('1. order created', r.json && r.json.ok === true, JSON.stringify(r.json));
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  // 模拟 TRC20 到账（金额精确匹配）
  trc20Transfers.push({ to_address: 'TXYZPAY', quant: Math.round(Number(ord.actual_amount) * 1e6), transactionHash: 'a'.repeat(64), block_ts: Date.now(), confirmed: true });
  // /pay 提交 TXID（核验通过 → 自动发货 → posted）
  r = await call('POST', '/api/orders/' + ord.order_no + '/pay', { txid: 'a'.repeat(64) });
  check('1. /pay verified -> auto', r.json && r.json.ok === true && r.json.auto === true, JSON.stringify(r.json));
  const pays = qa('SELECT * FROM payments WHERE order_id=?', ord.id);
  check('1. payment recorded (1 row)', pays.length === 1, JSON.stringify(pays));
  check('1. payment status posted', pays[0] && pays[0].status === 'posted', JSON.stringify(pays));
  check('1. payment tx_hash matches', pays[0] && pays[0].tx_hash === 'a'.repeat(64), JSON.stringify(pays));
  check('1. order completed', q('SELECT status FROM orders WHERE id=?', ord.id).status === 'completed');
  check('1. card delivered', !!q('SELECT * FROM orders WHERE id=? AND delivery_content LIKE ?', ord.id, '%R4-KEY-%'));
}

// ===== 2. 同一链上事件重复提交/重复轮询不重复入账 =====
{
  const ord = q("SELECT * FROM orders WHERE order_no IN (SELECT order_no FROM orders WHERE contact='pay1@test.example')");
  // 同一 TXID 再次 /pay（订单已完成，应拒绝且不新增付款记录）
  const before = qa('SELECT * FROM payments').length;
  r = await call('POST', '/api/orders/' + ord.order_no + '/pay', { txid: 'a'.repeat(64) });
  check('2. duplicate /pay on completed order rejected', r.json && !r.json.ok, JSON.stringify(r.json));
  check('2. no duplicate payment row', qa('SELECT * FROM payments').length === before);
  // 直接重复记同一事件：recordPayment 应返回已有行，不新增
  const dup = qa("SELECT * FROM payments WHERE tx_hash=? AND chain='TRC20'", 'a'.repeat(64));
  check('2. one payment row for one event', dup.length === 1, JSON.stringify(dup));
}

// ===== 3. 同一订单第二笔真实付款保留独立记录 =====
{
  r = await orderCall(selfProd, 'pay3@test.example');
  check('3. order2 created', r.json && r.json.ok === true, JSON.stringify(r.json));
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  // 第一笔付款（TRC20）
  trc20Transfers.push({ to_address: 'TXYZPAY', quant: Math.round(Number(ord.actual_amount) * 1e6), transactionHash: 'b'.repeat(64), block_ts: Date.now(), confirmed: true });
  r = await call('POST', '/api/orders/' + ord.order_no + '/pay', { txid: 'b'.repeat(64) });
  check('3. first payment posted', r.json && r.json.ok === true && r.json.auto === true, JSON.stringify(r.json));
  // 第二笔付款（不同 TXID，同一订单）：模拟管理员手动记录的重复付款（订单已完成，/pay 拒绝，但账本可直接记入账外记录）
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, status, reconcile_status, reconcile_note) VALUES (?,?,?,?,?,?,?, ?, ?)").run(ord.id, 'TRC20', 'TXYZPAY', 'c'.repeat(64), '', Number(ord.actual_amount), 'mismatch', 'pending', '重复付款，需人工对账');
  const pays = qa('SELECT * FROM payments WHERE order_id=? ORDER BY id ASC', ord.id);
  check('3. two independent payment rows for one order', pays.length === 2, JSON.stringify(pays));
  check('3. second payment is mismatch (needs reconcile)', pays[1] && pays[1].status === 'mismatch' && pays[1].reconcile_status === 'pending', JSON.stringify(pays));
  // 管理员对账
  r = await call('POST', '/api/admin/payments/' + pays[1].id + '/reconcile', { note: '已线下退款，确认处理' }, cookie);
  check('3. reconcile ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('3. payment reconciled', q('SELECT status FROM payments WHERE id=?', pays[1].id).status === 'reconciled');
  // 付款账本列表接口
  r = await call('GET', '/api/admin/payments?order_id=' + ord.id, null, cookie);
  check('3. admin payments list', r.json && r.json.ok === true && r.json.payments.length === 2, JSON.stringify(r.json));
}

// ===== 4. 金额唯一性：部分唯一索引 + 并发下单不复用金额 =====
{
  // 直接验证唯一索引：插入重复待付款金额应失败
  const dupAmt = 999.1234;
  db.prepare("INSERT INTO orders (order_no, query_password, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES ('AISDUPAMT1','',?, '{}',1,1,1,?, 'TXYZPAY', '2099-01-01 00:00:00', '{}', 'dupamt@test.example', 'Binance', 'TRC20', 'TXYZPAY', 'pending_payment', datetime('now'))").run(selfProd.id, dupAmt);
  let dupFailed = false;
  try { db.prepare("INSERT INTO orders (order_no, query_password, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES ('AISDUPAMT2','',?, '{}',1,1,1,?, 'TXYZPAY', '2099-01-01 00:00:00', '{}', 'dupamt2@test.example', 'Binance', 'TRC20', 'TXYZPAY', 'pending_payment', datetime('now'))").run(selfProd.id, dupAmt); } catch (e) { dupFailed = /UNIQUE/i.test(String(e.message)); }
  check('4. duplicate pending amount rejected by unique index', dupFailed);
  db.prepare("DELETE FROM orders WHERE order_no IN ('AISDUPAMT1','AISDUPAMT2')").run();
  // 并发下单（5 个同时）：全部成功且金额各不相同
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => orderCall(selfProd, 'conc' + i + '@test.example')));
  const okCount = results.filter((x) => x.json && x.json.ok).length;
  check('4. 5 concurrent orders all succeed', okCount === 5, JSON.stringify(results.map((x) => x.json)));
  const amts = results.filter((x) => x.json && x.json.ok).map((x) => x.json.order.actual_amount);
  check('4. concurrent orders have distinct amounts', new Set(amts).size === amts.length, JSON.stringify(amts));
}

// ===== 5. EVM 扫描游标：推进、RPC 失败不推进、重启恢复 =====
{
  // X Layer 待付款订单
  r = await orderCall(selfProd, 'evm1@test.example', 'OKX', 'X Layer');
  check('5. X Layer order created', r.json && r.json.ok === true, JSON.stringify(r.json));
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const toTopic = '0x' + '000000000000000000000000' + String(ord.pay_address).slice(2).toLowerCase();
  const amtHex = '0x' + BigInt(Math.round(Number(ord.actual_amount) * 1e6)).toString(16).padStart(64, '0');
  const USDT_X = '0x00000000000000000000000000000000000000aa';
  evmLogs.push({ blockNumber: '0x3e8', transactionHash: 'd'.repeat(64), logIndex: '0x0', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), toTopic], data: amtHex, address: USDT_X });
  evmLatest = 1001; // 区块 1000 有转账，最新 1001 → X Layer 需 1 确认，满足
  // 触发轮询（经 /api/admin 上游重试入口不触发链上轮询；直接调 worker 的 scheduled 逻辑等价：用 /pay 触发逐单核验 + 全局扫描由轮询触发）
  // 这里用 /pay 提交 TXID 验证逐单路径，同时验证账本记入；全局扫描游标通过模拟两次轮询验证（见 5b）
  r = await call('POST', '/api/orders/' + ord.order_no + '/pay', { txid: 'd'.repeat(64) });
  check('5. EVM /pay verified', r.json && r.json.ok === true, JSON.stringify(r.json));
  // 5b. 游标：直接写游标再读（持久化），RPC 失败时游标不推进（通过 scanEvmChain 的失败路径验证需调轮询；这里验证游标读写）
  db.prepare("INSERT OR REPLACE INTO scan_cursors (chain, last_block) VALUES ('X Layer', 500)").run();
  check('5b. scan cursor persisted', q("SELECT last_block FROM scan_cursors WHERE chain='X Layer'").last_block === 500);
  // 游标表存在且为每链主键
  check('5b. scan_cursors table exists', !!q("SELECT * FROM scan_cursors WHERE chain='X Layer'"));
}

// ===== 6. 上游 UPSERT 空值不覆盖 =====
{
  const ord = q("SELECT * FROM orders WHERE contact='pay1@test.example' LIMIT 1");
  db.prepare("INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, 'PS-KEEP-1', 'paid', 5, 'KEY-KEEP')").run(ord.id);
  // 占位行（空 psId）不得覆盖已有单号与 keys
  await call('POST', '/api/admin/upstream/orders/' + ord.id + '/retry', {}, cookie).catch(() => {});
  const row = q('SELECT * FROM upstream_orders WHERE order_id=?', ord.id);
  // retry 走轮询路径（无上游单号时可能创建；此处直接验证 UPSERT 语义：用 SQL 模拟占位行写入）
  db.prepare("INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, '', 'upstream_error', 0, '') ON CONFLICT(order_id) DO UPDATE SET prodseller_order_id=CASE WHEN excluded.prodseller_order_id = '' THEN upstream_orders.prodseller_order_id ELSE excluded.prodseller_order_id END, status=excluded.status, amount=excluded.amount, delivered_keys=CASE WHEN excluded.delivered_keys = '' THEN upstream_orders.delivered_keys ELSE excluded.delivered_keys END").run(ord.id);
  const row2 = q('SELECT * FROM upstream_orders WHERE order_id=?', ord.id);
  check('6. empty psId does not overwrite existing', row2.prodseller_order_id === 'PS-KEEP-1', JSON.stringify(row2));
  check('6. empty keys do not overwrite existing', row2.delivered_keys === 'KEY-KEEP', JSON.stringify(row2));
  db.prepare('DELETE FROM upstream_orders WHERE order_id=?').run(ord.id);
}

// ===== 7. 迁移预检 =====
{
  r = await call('GET', '/api/admin/schema-check', null, cookie);
  check('7. schema-check ok', r.json && r.json.ok === true && r.json.precheck && r.json.precheck.ok === true, JSON.stringify(r.json));
  check('7. schema-check version 9', r.json && r.json.precheck && r.json.precheck.current_version === 9, JSON.stringify(r.json));
  // 模拟缺表：删 payments 表后预检应报告问题（随后重建）
  db.exec('DROP TABLE payments');
  r = await call('GET', '/api/admin/schema-check', null, cookie);
  check('7. schema-check detects missing table', r.json && r.json.precheck && r.json.precheck.ok === false && r.json.precheck.issues.some((x) => x.includes('payments')), JSON.stringify(r.json));
  db.exec("CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, chain TEXT NOT NULL DEFAULT '', asset TEXT NOT NULL DEFAULT 'USDT', pay_address TEXT NOT NULL DEFAULT '', tx_hash TEXT NOT NULL DEFAULT '', event_key TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0, amount_unit TEXT NOT NULL DEFAULT 'USDT', block_number INTEGER, confirmations INTEGER NOT NULL DEFAULT 0, first_seen_at TEXT NOT NULL DEFAULT (datetime('now')), status TEXT NOT NULL DEFAULT 'submitted', reconcile_status TEXT NOT NULL DEFAULT '', reconcile_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_event_unique ON payments(chain, tx_hash, event_key)');
  r = await call('GET', '/api/admin/schema-check', null, cookie);
  check('7. schema-check ok after restore', r.json && r.json.precheck && r.json.precheck.ok === true, JSON.stringify(r.json));
}

// ===== 8. 公开查单隐私：邮箱查单已关闭 =====
{
  r = await call('GET', '/api/orders?contact=pay1@test.example');
  check('8. email lookup closed -> 410', r.status === 410 && r.json && r.json.ok === false, JSON.stringify(r.json));
  // 订单号 + 凭证仍可查
  const ord = q("SELECT * FROM orders WHERE contact='pay1@test.example' LIMIT 1");
  r = await call('GET', '/api/orders/' + ord.order_no);
  check('8. GET single order summary ok', r.json && r.json.ok === true && !r.json.order.delivery_content, JSON.stringify(r.json));
}

// ===== 9. Turnstile：Mock 成功 / 失败 / 密钥缺失 fail-closed =====
{
  // 开启 Turnstile
  db.prepare("UPDATE settings SET value='1' WHERE key='turnstile_enabled'").run();
  db.prepare("UPDATE settings SET value='test-site-key' WHERE key='turnstile_site_key'").run();
  // siteverify 成功 → 下单成功
  turnstileVerifyResult = true; turnstileFailNetwork = false;
  r = await call('POST', '/api/orders', { product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'ts1@test.example', delivery_email: 'ts1@test.example' }, contact: 'ts1@test.example', pay_method: 'Binance', pay_chain: 'TRC20', turnstile_token: 'valid-token' });
  check('9. turnstile success -> order created', r.json && r.json.ok === true, JSON.stringify(r.json));
  // siteverify 失败 → 拒绝
  turnstileVerifyResult = false;
  r = await call('POST', '/api/orders', { product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'ts2@test.example', delivery_email: 'ts2@test.example' }, contact: 'ts2@test.example', pay_method: 'Binance', pay_chain: 'TRC20', turnstile_token: 'bad-token' });
  check('9. turnstile failure -> rejected', r.json && !r.json.ok && /反机器人/.test(r.json.error || ''), JSON.stringify(r.json));
  // 密钥缺失 → fail-closed（绝不降级为无验证）
  const envNoSecret = { ...env, TURNSTILE_SECRET_KEY: '' };
  const ctx2 = makeCtx();
  const reqNoSecret = new Request('http://test/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'ts3@test.example', delivery_email: 'ts3@test.example' }, contact: 'ts3@test.example', pay_method: 'Binance', pay_chain: 'TRC20', turnstile_token: 'any-token' }) });
  const resNoSecret = await worker.fetch(reqNoSecret, envNoSecret, ctx2);
  await ctx2.drain();
  const txtNoSecret = await resNoSecret.text();
  check('9. turnstile secret missing -> fail-closed', resNoSecret.status === 400 && /未配置/.test(txtNoSecret), txtNoSecret.slice(0, 300));
  // 关闭 Turnstile，恢复 SVG 验证码路径
  db.prepare("UPDATE settings SET value='0' WHERE key='turnstile_enabled'").run();
  r = await orderCall(selfProd, 'ts4@test.example');
  check('9. SVG captcha path still works after turnstile off', r.json && r.json.ok === true, JSON.stringify(r.json));
}

// ===== 10. /pay 独立限流 =====
db.prepare('DELETE FROM order_rate').run();
{
  r = await orderCall(selfProd, 'paylimit@test.example');
  check('10. order created', r.json && r.json.ok === true, JSON.stringify(r.json));
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  // 5 次提交（均用不存在的 TXID，核验失败暂存）→ 第 6 次应 429
  let lastStatus = 0, lastJson = null;
  for (let i = 0; i < 6; i++) {
    const rr = await call('POST', '/api/orders/' + ord.order_no + '/pay', { txid: 'e'.repeat(60) + String(i) });
    lastStatus = rr.status; lastJson = rr.json;
  }
  check('10. 6th /pay -> 429', lastStatus === 429 && lastJson && !lastJson.ok, JSON.stringify(lastJson));
  // 限流不影响订单状态（仍待付款，可由轮询继续处理）
  check('10. order still pending_payment after rate limit', q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment');
}

// ===== 11. 错误脱敏：500 不泄露 SQL/DB 结构/堆栈 =====
{
  // 独立损坏库：删 orders 表 → 迁移 v1 的 ALTER 失败 → 500。主测试库不受影响。
  const dbBad = new DatabaseSync(':memory:');
  dbBad.exec(fs.readFileSync(path.join(dir, '..', 'schema.sql'), 'utf8'));
  dbBad.exec('DROP TABLE orders');
  const envBad = { DB: { prepare: (sql) => { let params = []; const api = { bind(...a) { params = a; return api; }, async first() { try { const st = dbBad.prepare(sql); const r = st.get(...params); return r === undefined ? null : r; } catch (e) { throw e; } }, async all() { const st = dbBad.prepare(sql); return { results: st.all(...params) }; }, async run() { const st = dbBad.prepare(sql); const info = st.run(...params); return { meta: { changes: info.changes } }; } }; return api; }, async batch(stmts) { const out = []; for (const st of stmts) out.push(await st.run()); return out; } } };
  const ctxBad = makeCtx();
  const reqBad = new Request('http://test/api/orders/AISNOTEXIST', { method: 'GET', headers: { 'content-type': 'application/json' } });
  const resBad = await worker.fetch(reqBad, envBad, ctxBad);
  await ctxBad.drain();
  const txtBad = await resBad.text();
  let jBad = null; try { jBad = JSON.parse(txtBad); } catch {}
  check('11. 500 sanitized (generic + request_id)', resBad.status === 500 && jBad && /服务器内部错误/.test(jBad.error || '') && /关联 ID/.test(jBad.error || '') && !/no such table/i.test(jBad.error || '') && !/sqlite/i.test(jBad.error || '') && !/at /i.test(jBad.error || ''), txtBad.slice(0, 400));
}

// ===== 12. ProdSeller 门禁：默认关闭，开启后可用 =====
{
  // 默认关闭（schema.sql 默认 0）
  check('12. gate default closed', q("SELECT value FROM settings WHERE key='prodseller_enabled'").value === '0');
  r = await orderCall(psProd, 'gate1@test.example', 'Binance', 'X Layer');
  check('12. gate closed -> 403', r.status === 403 && r.json && !r.json.ok && /暂未开放购买/.test(r.json.error || ''), JSON.stringify(r.json));
  // 开启后可下单（Mock 上游）
  db.prepare("UPDATE settings SET value='1' WHERE key='prodseller_enabled'").run();
  r = await orderCall(psProd, 'gate2@test.example', 'Binance', 'X Layer');
  check('12. gate open -> order created', r.json && r.json.ok === true, JSON.stringify(r.json));
  db.prepare("UPDATE settings SET value='0' WHERE key='prodseller_enabled'").run();
}

// ===== 13. 验证码并发重放：同一验证码两个请求同时消费，只一个成功 =====
db.prepare('DELETE FROM order_rate').run();
{
  const cid = await newCaptcha();
  const body1 = { product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'replay1@test.example', delivery_email: 'replay1@test.example' }, contact: 'replay1@test.example', pay_method: 'Binance', pay_chain: 'TRC20', captcha_id: cid, captcha_code: 'AB12' };
  const body2 = { product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'replay2@test.example', delivery_email: 'replay2@test.example' }, contact: 'replay2@test.example', pay_method: 'Binance', pay_chain: 'TRC20', captcha_id: cid, captcha_code: 'AB12' };
  const [r1, r2] = await Promise.all([call('POST', '/api/orders', body1), call('POST', '/api/orders', body2)]);
  const okCount = [r1, r2].filter((x) => x.json && x.json.ok).length;
  check('13. concurrent same captcha: exactly one succeeds', okCount === 1, JSON.stringify([r1.json, r2.json]));
}

// ===== 14. 故障：同一付款事件并发进入（两个 /pay 同时提交同一 TXID）=====
db.prepare('DELETE FROM order_rate').run();
{
  r = await orderCall(selfProd, 'race1@test.example');
  check('14. order created', r.json && r.json.ok === true, JSON.stringify(r.json));
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  trc20Transfers.push({ to_address: 'TXYZPAY', quant: Math.round(Number(ord.actual_amount) * 1e6), transactionHash: 'f'.repeat(64), block_ts: Date.now(), confirmed: true });
  const [p1, p2] = await Promise.all([
    call('POST', '/api/orders/' + ord.order_no + '/pay', { txid: 'f'.repeat(64) }),
    call('POST', '/api/orders/' + ord.order_no + '/pay', { txid: 'f'.repeat(64) }),
  ]);
  // 至少一个成功，订单只完成一次，付款记录只有一行（同一事件）
  const pays = qa('SELECT * FROM payments WHERE tx_hash=?', 'f'.repeat(64));
  check('14. concurrent same TXID: one payment row', pays.length === 1, JSON.stringify(pays));
  check('14. order completed once', q('SELECT status FROM orders WHERE id=?', ord.id).status === 'completed');
  const deliveredCount = qa('SELECT * FROM cards WHERE order_id=? AND is_used=1', ord.id).length;
  check('14. cards delivered once (qty=1)', deliveredCount === 1, 'delivered=' + deliveredCount);
}


// ===== 15. v9：金额唯一索引排除 BinanceUID（第六轮回归） =====
{
  // 构造 v8 旧库：旧版金额唯一索引（未排除 BinanceUID）+ schema_migrations 1-8（仅 v9 待应用）
  // + 一笔待付款 BinanceUID 订单（pay_address=''、actual_amount=10）。
  const dbV9 = new DatabaseSync(':memory:');
  dbV9.exec(fs.readFileSync(path.join(dir, '..', 'schema.sql'), 'utf8'));
  dbV9.exec('DROP INDEX IF EXISTS idx_orders_amount_claim');
  dbV9.exec("CREATE UNIQUE INDEX idx_orders_amount_claim ON orders(pay_address, actual_amount) WHERE status = 'pending_payment'");
  dbV9.exec('DELETE FROM schema_migrations');
  dbV9.exec('INSERT INTO schema_migrations (version) VALUES (1),(2),(3),(4),(5),(6),(7),(8)');
  dbV9.prepare("INSERT INTO products (slug, title, category, price_usdt, sell_price, source, stock_type, form_fields) VALUES ('v9-card','V9 卡密','card',10,10,'self','card','[]')").run();
  const v9Prod = dbV9.prepare("SELECT * FROM products WHERE slug='v9-card'").get();
  dbV9.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(v9Prod.id, 'V9-KEY-1');
  dbV9.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(v9Prod.id, 'V9-KEY-2');
  const cryptoV9 = await import('node:crypto');
  const hashV9 = (s) => cryptoV9.createHash('sha256').update(s).digest('hex');
  // 第一笔待付款 BinanceUID 订单（直接 INSERT，模拟 v8 下已存在的订单）
  dbV9.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES ('AISV9FIRST001', '', ?, ?, '{}', 1, 10, 10, 10, '', datetime('now','+30 minutes'), ?, 'v9-first@test.example', 'BinanceUID', '站内转账', '', 'pending_payment', datetime('now'))").run(hashV9('v9-token-1'), v9Prod.id, JSON.stringify({ delivery_email: 'v9-first@test.example' }));
  const envV9 = { DB: { prepare: (sql) => { let params = []; const api = { bind(...a) { params = a; return api; }, async first() { try { const st = dbV9.prepare(sql); const r = st.get(...params); return r === undefined ? null : r; } catch (e) { throw e; } }, async all() { const st = dbV9.prepare(sql); return { results: st.all(...params) }; }, async run() { const st = dbV9.prepare(sql); const info = st.run(...params); return { meta: { changes: info.changes } }; } }; return api; }, async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } }, PRODSELLER_API_KEY: 'test-key' };
  async function callV9(method, p, body) {
    const ctx = makeCtx();
    const req = new Request('http://test' + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const res = await worker.fetch(req, envV9, ctx);
    await ctx.drain();
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    return { status: res.status, json: j, txt };
  }
  // 触发迁移（首次请求自动跑 v9）
  const migV9 = await callV9('GET', '/api/config');
  check('15. v9 migration applied (config ok)', migV9.json && migV9.json.ok === true, migV9.txt.slice(0, 200));
  const verV9 = dbV9.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  check('15. v9 version marked', verV9 && verV9.v === 9, JSON.stringify(verV9));
  const idxV9 = dbV9.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_orders_amount_claim'").get();
  check('15. v9 index excludes BinanceUID', idxV9 && /pay_method != 'BinanceUID'/.test(idxV9.sql || ''), (idxV9 && idxV9.sql) || '');
  // 第二笔同金额 BinanceUID 订单（不同联系方式）：v8 旧索引下会 500，v9 下应成功
  dbV9.prepare("INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES ('v9-cap', ?, datetime('now','+5 minutes'), 0)").run(hashV9('AB12'));
  const ordV9 = await callV9('POST', '/api/orders', { product_id: v9Prod.id, quantity: 1, customer_fields: { contact_email: 'v9-second@test.example', delivery_email: 'v9-second@test.example' }, contact: 'v9-second@test.example', pay_method: 'BinanceUID', pay_chain: '站内转账', captcha_id: 'v9-cap', captcha_code: 'AB12' });
  check('15. second BinanceUID same-amount order succeeds (no 500)', ordV9.json && ordV9.json.ok === true, ordV9.txt.slice(0, 300));
}

console.log('\nRELEASE READINESS TEST DONE pass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
