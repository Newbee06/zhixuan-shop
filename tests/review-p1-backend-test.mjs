// 后端整改回归测试（2026-10-18 审查：P1-1/P1-2/P1-3/P2-1/P2-2/P2-3/P2-7/P2-10/P3-1..P3-7 + 额外边界）
// 规则：只测新行为；不访问真实上游/链上（全部 mock）；失败即报告代码 bug。
// 与 tests/review-fixes-test.mjs 共享 harness 套路，但独立 env/断言，不依赖该文件。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const workerCode = fs.readFileSync(path.join(dir, '..', 'src', 'worker.js'), 'utf8');
const frontendHtml = fs.readFileSync(path.join(dir, '..', 'src', 'frontend.html'), 'utf8');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; failures.push(name); console.log('FAIL', name, extra || ''); }
}

const XLAYER_USDT0 = '0x779ded0c9e1022225f8e0630b35a9b54bE713736';
const BEP20_USDT = '0x55d398326f99059fF775485246999027B3197955';
const TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function padTopic(addr) { return '0x' + '0'.repeat(24) + addr.replace(/^0x/, '').toLowerCase(); }
function toHex(n) { return '0x' + BigInt(n).toString(16); }
function amountToRaw(amount, decimals) {
  let str = String(amount);
  let neg = false;
  if (str.charAt(0) === '-') { neg = true; str = str.slice(1); }
  if (/[eE]/.test(str)) { const n = Number(str); if (!isFinite(n)) return '0x' + '0'.repeat(64); str = n.toFixed(Math.min(decimals, 20)); }
  const parts = str.split('.');
  const intPart = ((parts[0] || '0').replace(/[^0-9]/g, '')) || '0';
  let fracPart = (parts[1] || '').replace(/[^0-9]/g, '');
  if (fracPart.length > decimals) fracPart = fracPart.slice(0, decimals);
  while (fracPart.length < decimals) fracPart += '0';
  let raw = BigInt(intPart) * (10n ** BigInt(decimals)) + BigInt(fracPart || '0');
  if (neg) raw = -raw;
  return '0x' + raw.toString(16).padStart(64, '0');
}
function psResp(data, status = 200) {
  const t = JSON.stringify(data);
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => t };
}

// ---------- mock 外部服务 ----------
const M = { creates: 0, gets: 0, rpcCalls: 0, createFn: null, getFn: null, receipt: null, logs: [], latest: 10000, turnstileSuccess: true, rpcFail: false };
function resetMock() { M.creates = 0; M.gets = 0; M.rpcCalls = 0; M.createFn = null; M.getFn = null; M.receipt = null; M.logs = []; M.latest = 10000; M.turnstileSuccess = true; M.rpcFail = false; }
async function mockFetch(url, opts = {}) {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('challenges.cloudflare.com')) {
    return { ok: true, status: 200, json: async () => ({ success: M.turnstileSuccess }), text: async () => JSON.stringify({ success: M.turnstileSuccess }) };
  }
  if (u.includes('prodseller.com/v1/orders')) {
    if (method === 'POST') {
      M.creates++;
      let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch {}
      if (M.createFn) return M.createFn(body);
      return psResp({ id: 'PS-DEFAULT-1', status: 'paid' });
    }
    M.gets++;
    const id = decodeURIComponent(u.split('/v1/orders/')[1] || '');
    if (M.getFn) return M.getFn(id);
    return psResp({ id, status: 'delivered', deliveredKey: 'PS-KEY-DEFAULT' });
  }
  if (u.includes('mock-xlayer') || u.includes('mock-bsc')) {
    M.rpcCalls++;
    if (M.rpcFail) throw new Error('mock RPC failure');
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch {}
    const rpc = body.params || [];
    if (body.method === 'eth_chainId') {
      const id = u.includes('mock-bsc') ? '0x38' : '0xc4';
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: id }), text: async () => '' };
    }
    if (body.method === 'eth_call') {
      const data = String(rpc[0]?.data || '');
      const dec = data.startsWith('0x313ce567') ? (u.includes('mock-xlayer') ? 6 : 18) : 18;
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x' + dec.toString(16).padStart(64, '0') }), text: async () => '' };
    }
    if (body.method === 'eth_blockNumber') return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: toHex(M.latest) }), text: async () => '' };
    if (body.method === 'eth_getLogs') return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: M.logs }), text: async () => '' };
    if (body.method === 'eth_getTransactionReceipt') return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: M.receipt }), text: async () => '' };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: null }), text: async () => '' };
  }
  throw new Error('Unexpected fetch in review-p1-backend test: ' + u);
}
globalThis.fetch = mockFetch;

// ---------- env 工厂 ----------
let contactSeq = 0;
function freshContact() { contactSeq++; return 'p1b-' + contactSeq + '-' + Date.now() + '@test.example'; }
function nowStr() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.exec(fs.readFileSync(path.join(dir, '..', 'schema.sql'), 'utf8'));
  const wrapStmt = (sql) => {
    let params = [];
    const api = {
      bind(...a) { params = a; return api; },
      async first() { try { const st = db.prepare(sql); const r = st.get(...params); return r === undefined ? null : r; } catch (e) { throw e; } },
      async all() { const st = db.prepare(sql); return { results: st.all(...params) }; },
      async run() { const st = db.prepare(sql); const info = st.run(...params); return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }; },
    };
    return api;
  };
  const env = {
    ZHIXUAN_SETUP_TOKEN: 'test-setup-token',
    DB: { prepare: (sql) => wrapStmt(sql), async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } },
    PRODSELLER_API_KEY: 'test-key',
    PRODSELLER_BASE_URL: 'https://prodseller.com/v1',
    __fetch: mockFetch,
  };
  let code = workerCode.replace(/import\s+FRONTEND_HTML\s+from\s+['"][^'"]+['"];?/, 'const FRONTEND_HTML = ' + JSON.stringify(frontendHtml) + ';');
  code = code.replace(/export\s+default\s*\{/, 'globalThis.__W = {');
  const worker = new Function(code + '\nreturn globalThis.__W;')();
  const q = (sql, ...p) => db.prepare(sql).get(...p);
  const qa = (sql, ...p) => db.prepare(sql).all(...p);
  let ipSeq = 0;
  function makeCtx() { const jobs = []; return { waitUntil(p) { jobs.push(p); }, async drain() { while (jobs.length) { const batch = jobs.splice(0); await Promise.allSettled(batch); } }, passThroughOnException() {} }; }
  async function call(method, p, body, cookie, extra) {
    const ctx = makeCtx();
    const headers = { 'content-type': 'application/json', 'X-Admin-API': '1' };
    if (cookie) headers['Cookie'] = cookie;
    if (!extra || !extra['CF-Connecting-IP']) { ipSeq++; headers['CF-Connecting-IP'] = '10.99.' + Math.floor(ipSeq / 250) + '.' + (ipSeq % 250 + 1); }
    Object.assign(headers, extra || {});
    const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const res = await worker.fetch(req, env, ctx);
    await ctx.drain();
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    return { status: res.status, json: j, txt, headers: res.headers };
  }
  function mkCaptcha(code = 'AB12') {
    const id = 'CAP' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    db.prepare("INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?, ?, datetime('now','+5 minutes'), 0)").run(id, sha256(code));
    return id;
  }
  function setSetting(key, value) { db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value); }
  function setGate(v) { setSetting('prodseller_enabled', String(v)); }
  async function adminLogin() {
    let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
    const c0 = r.headers.get('set-cookie') || '';
    r = await call('POST', '/api/admin/change-password', { old_password: '', new_password: 'admin123' }, c0);
    if (!r.json || !r.json.ok) throw new Error('admin setup failed: ' + JSON.stringify(r.json));
    return c0;
  }
  async function orderCall(body) {
    const payload = { query_password: 'TestPass123', pay_method: 'OKX', pay_chain: 'X Layer', quantity: 1, ...body };
    if (payload.turnstile_token === undefined && payload._skipCaptcha !== true && payload.captcha_id === undefined) {
      const cid = mkCaptcha('AB12'); payload.captcha_id = cid; payload.captcha_code = 'AB12';
    }
    delete payload._skipCaptcha;
    if (!payload.customer_fields) payload.customer_fields = {};
    if (!payload.customer_fields.contact_email) payload.customer_fields.contact_email = freshContact();
    if (!payload.contact) payload.contact = payload.customer_fields.contact_email;
    return call('POST', '/api/orders', payload);
  }
  async function orderCallWithCaptcha(body, capId, capCode) {
    const payload = { query_password: 'TestPass123', pay_method: 'OKX', pay_chain: 'X Layer', quantity: 1, ...body, captcha_id: capId, captcha_code: capCode };
    if (!payload.customer_fields) payload.customer_fields = {};
    if (!payload.customer_fields.contact_email) payload.customer_fields.contact_email = freshContact();
    if (!payload.contact) payload.contact = payload.customer_fields.contact_email;
    return call('POST', '/api/orders', payload);
  }
  async function payCall(orderNo, txid) {
    const cid = mkCaptcha('AB12');
    return call('POST', '/api/orders/' + orderNo + '/pay', { txid, captcha_id: cid, captcha_code: 'AB12' });
  }
  async function payCallWithCaptcha(orderNo, txid, capId, capCode) {
    return call('POST', '/api/orders/' + orderNo + '/pay', { txid, captcha_id: capId, captcha_code: capCode });
  }
  async function scheduled() {
    const ctx = makeCtx();
    await worker.scheduled({ cron: '*/1 * * * *' }, env, ctx);
    await ctx.drain();
  }
  let insertSeq = 0;
  function insertOrder(fields) {
    insertSeq++;
    function evalSqlTime(v) {
      if (typeof v === 'string' && v.startsWith("datetime('now'")) {
        const m = v.match(/datetime\('now'(?:,\s*'([^']+)')?\)/);
        const d = new Date();
        if (m && m[1]) {
          const dm = m[1].match(/([+-]?\d+)\s+(minutes?|hours?|days?)/);
          if (dm) { const n = parseInt(dm[1], 10); if (/minute/.test(dm[2])) d.setMinutes(d.getMinutes() + n); else if (/hour/.test(dm[2])) d.setHours(d.getHours() + n); else d.setDate(d.getDate() + n); }
        }
        return d.toISOString().replace('T', ' ').slice(0, 19);
      }
      return v;
    }
    const cols = ['order_no', 'query_password', 'query_token_hash', 'query_password_hash', 'query_password_salt', 'product_id', 'product_snapshot', 'quantity', 'price_usdt', 'total_usdt', 'actual_amount', 'pay_address', 'expires_at', 'customer_fields', 'contact', 'pay_method', 'pay_chain', 'wallet_address', 'status', 'claim_token', 'claimed_at', 'paid_at', 'delivery_content', 'exception_reason', 'admin_note', 'tx_hash', 'upstream_lock', 'upstream_lock_expires_at', 'data_expired', 'fulfilled_at', 'refund_ref', 'refund_status', 'txid', 'last_checked_at', 'created_at'];
    const base = { order_no: 'AISP1B' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(), query_password: '', query_token_hash: '', query_password_hash: '', query_password_salt: '', product_id: 1, product_snapshot: '{}', quantity: 1, price_usdt: 10, total_usdt: 10, actual_amount: 10, pay_address: '0x' + String(insertSeq).padStart(40, '0'), expires_at: "datetime('now','+30 minutes')", customer_fields: '{}', contact: freshContact(), pay_method: 'Binance', pay_chain: 'BEP20', wallet_address: '', status: 'pending_payment', claim_token: '', claimed_at: null, paid_at: null, delivery_content: '', exception_reason: '', admin_note: '', tx_hash: '', upstream_lock: '', upstream_lock_expires_at: null, data_expired: 0, fulfilled_at: null, refund_ref: '', refund_status: '', txid: '', last_checked_at: null, created_at: nowStr() };
    const merged = { ...base, ...fields };
    for (const k of ['expires_at', 'claimed_at', 'paid_at', 'fulfilled_at', 'upstream_lock_expires_at', 'created_at']) merged[k] = evalSqlTime(merged[k]);
    const placeholders = cols.map(() => '?').join(',');
    const vals = cols.map((c) => merged[c]);
    const info = db.prepare('INSERT INTO orders (' + cols.join(',') + ') VALUES (' + placeholders + ')').run(...vals);
    return db.prepare('SELECT * FROM orders WHERE id=?').get(Number(info.lastInsertRowid));
  }
  function initBase() {
    setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': '0x1111111111111111111111111111111111111111', 'Binance|BEP20': '0x2222222222222222222222222222222222222222' }));
    setSetting('rpc_urls', JSON.stringify({ 'X Layer': ['https://mock-xlayer'], 'BEP20': ['https://mock-bsc'] }));
    setSetting('prodseller_enabled', '0');
  }
  function evmLogFor(order, txHash, blockNumber, logIndex = '0x0', amountOverride, toOverride) {
    const decimals = order.pay_chain === 'X Layer' ? 6 : 18;
    return { address: order.pay_chain === 'X Layer' ? XLAYER_USDT0 : BEP20_USDT, topics: [TOPIC0, padTopic('0x' + '2'.repeat(40)), padTopic(toOverride || order.pay_address)], data: amountOverride !== undefined ? amountOverride : amountToRaw(order.actual_amount, decimals), blockNumber: toHex(blockNumber), transactionHash: txHash, logIndex };
  }
  function evmReceiptFor(order, txHash, blockNumber, logOverrides) {
    const logs = logOverrides || [evmLogFor(order, txHash, blockNumber)];
    return { blockHash: '0x' + '1'.repeat(64), blockNumber: toHex(blockNumber), from: '0x' + '2'.repeat(40), to: order.pay_address, transactionHash: txHash, status: '0x1', logs };
  }
  return { db, env, worker, q, qa, call, mkCaptcha, setSetting, setGate, adminLogin, orderCall, orderCallWithCaptcha, payCall, payCallWithCaptcha, scheduled, insertOrder, initBase, evmLogFor, evmReceiptFor };
}

// ================= P1-1：TXID 认领回滚（created 区分 + 仅删本次新建） =================
{
resetMock();
const t = setup(); t.initBase();
const cookie = await t.adminLogin();
let r = await t.call('POST', '/api/admin/products', { title: '手动商品-P1-1', category: 'recharge', stock_type: 'manual', sell_price: 4, source: 'self'}, cookie);
const pM = t.q("SELECT * FROM products WHERE title='手动商品-P1-1'");
// 两订单竞同一 TXID：仅一成功
const txH = 'a1'.repeat(32);
r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordA = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordB = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
M.receipt = t.evmReceiptFor(ordA, txH, 9000, [t.evmLogFor(ordA, txH, 9000), t.evmLogFor(ordB, txH, 9000)]);
r = await t.payCall(ordA.order_no, txH);
check('P1-1: first order claims TXID via /pay', r.json && r.json.ok === true && r.json.auto === true, JSON.stringify(r.json));
check('P1-1: txid_claims belongs to first order', (() => { const row = t.q('SELECT * FROM txid_claims WHERE tx_hash=?', txH); return row && row.order_id === ordA.id;})());
r = await t.payCall(ordB.order_no, txH);
check('P1-1: second order same TXID rejected 409', r.status === 409 && r.json &&!r.json.ok && /已用于其他订单/.test(r.json.error || ''), JSON.stringify(r.json));
check('P1-1: second order still pending_payment', t.q('SELECT status FROM orders WHERE id=?', ordB.id).status === 'pending_payment');
check('P1-1: claim still belongs to first order after rejection', t.q('SELECT order_id FROM txid_claims WHERE tx_hash=?', txH).order_id === ordA.id);
// 同订单旧认领 + 订单认领失败 → 回滚不删旧认领
const txH2 = 'b2'.repeat(32);
r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordC = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
t.db.prepare('UPDATE orders SET claim_token=?, claimed_at=? WHERE id=?').run('ACTIVE-LEASE', nowStr(), ordC.id);
t.db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at) VALUES (?,?,?)').run(txH2, ordC.id, nowStr());
M.receipt = t.evmReceiptFor(ordC, txH2, 9000);
r = await t.payCall(ordC.order_no, txH2);
check('P1-1: same-order old claim survives failed rollback', (() => { const row = t.q('SELECT * FROM txid_claims WHERE tx_hash=?', txH2); return row && row.order_id === ordC.id;})(), JSON.stringify(r.json));
check('P1-1: order with failed claim still pending_payment', t.q('SELECT status FROM orders WHERE id=?', ordC.id).status === 'pending_payment');
// 本次新建认领 + 订单认领失败 → 回滚删除本次新建，不留孤儿认领
const txH3 = 'c3'.repeat(32);
r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordD = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
t.db.prepare('UPDATE orders SET claim_token=?, claimed_at=? WHERE id=?').run('ACTIVE-LEASE', nowStr(), ordD.id);
M.receipt = t.evmReceiptFor(ordD, txH3, 9000);
r = await t.payCall(ordD.order_no, txH3);
check('P1-1: failed fulfill leaves no orphan claim',!t.q('SELECT * FROM txid_claims WHERE tx_hash=?', txH3), JSON.stringify(r.json));
// 同订单两并发 /pay 同一 TXID：仅一履约，认领不被误删
const txH4 = 'd4'.repeat(32);
r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordE = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
M.receipt = t.evmReceiptFor(ordE, txH4, 9000);
const cap1 = t.mkCaptcha('AB12'), cap2 = t.mkCaptcha('AB12');
const [p1, p2] = await Promise.all([
t.payCallWithCaptcha(ordE.order_no, txH4, cap1, 'AB12'),
t.payCallWithCaptcha(ordE.order_no, txH4, cap2, 'AB12'),
]);
const wins = [p1, p2].filter((x) => x.json && x.json.ok && x.json.auto === true).length;
check('P1-1: concurrent same-order /pay exactly one fulfills', wins === 1, JSON.stringify([p1.json, p2.json]));
check('P1-1: claim still exists after concurrent same-order /pay', (() => { const row = t.q('SELECT * FROM txid_claims WHERE tx_hash=?', txH4); return row && row.order_id === ordE.id;})());
check('P1-1: same TXID delivered once (order not pending)', t.q('SELECT status FROM orders WHERE id=?', ordE.id).status!== 'pending_payment');
}

// ================= P1-2：管理员确认收款（链上核验门控 + 人工确认通道） =================
{
resetMock();
const t = setup(); t.initBase();
const cookie = await t.adminLogin();
await t.call('POST', '/api/admin/products', { title: '手动商品-P1-2', category: 'recharge', stock_type: 'manual', sell_price: 4, source: 'self'}, cookie);
const pM = t.q("SELECT * FROM products WHERE title='手动商品-P1-2'");
// 无证据确认：缺原因拒绝；有原因 → 人工确认态，写 txid_claims 全局认领（source=manual_confirmed，与链上共享同一全局原子认领；
// v17 语义变更：旧断言“人工确认绝不写 txid_claims”已被 P1-2 根治要求取代——人工与链上必须共享同一全局原子消费机制，
// 否则先 SELECT 后 INSERT 的人工路径与链上路径之间仍有 TOCTOU 窗口）
const forged = 'd'.repeat(64);
let r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordE = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(forged, ordE.id);
r = await t.call('POST', '/api/admin/orders/' + ordE.id + '/confirm-payment', {}, cookie);
check('P1-2: confirm without reason rejected', r.json &&!r.json.ok && /原因/.test(r.json.error || ''), JSON.stringify(r.json));
check('P1-2: no-reason confirm leaves order pending', t.q('SELECT status FROM orders WHERE id=?', ordE.id).status === 'pending_payment');
r = await t.call('POST', '/api/admin/orders/' + ordE.id + '/confirm-payment', { reason: '已在收款地址核对到账', manual_confirm: false }, cookie);
check('P1-2: explicit manual_confirm=false rejected', r.json &&!r.json.ok, JSON.stringify(r.json));
r = await t.call('POST', '/api/admin/orders/' + ordE.id + '/confirm-payment', { reason: '已在收款地址核对到账', manual_confirm: true }, cookie);
check('P1-2: manual confirm with reason ok + marked manual', r.json && r.json.ok === true && /人工确认/.test(r.json.message || ''), JSON.stringify(r.json));
check('P1-2: manual confirm writes shared txid_claims (source=manual_confirmed)', (() => { const row = t.q('SELECT * FROM txid_claims WHERE tx_hash=?', forged); return row && row.order_id === ordE.id && row.source === 'manual_confirmed' && !!row.claim_token; })());
check('P1-2: manual confirm writes manual_confirmed ledger row', (() => { const row = t.q("SELECT * FROM payments WHERE tx_hash=? AND status='manual_confirmed'", forged); return row && row.order_id === ordE.id;})());
check('P1-2: manual confirm marks order admin_note', (t.q('SELECT admin_note FROM orders WHERE id=?', ordE.id).admin_note || '').includes('人工确认收款'));
check('P1-2: manual confirm audit action distinct',!!t.q("SELECT * FROM admin_audit WHERE order_id=? AND action='manual_confirm_payment'", ordE.id));
// 同一 TXID 第二单人工确认 → 拒绝（人工消耗同样防复用）
r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordF = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(forged, ordF.id);
r = await t.call('POST', '/api/admin/orders/' + ordF.id + '/confirm-payment', { reason: '第二单确认', manual_confirm: true }, cookie);
check('P1-2: second manual confirm same TXID rejected', r.json &&!r.json.ok && /已用于其他订单/.test(r.json.error || ''), JSON.stringify(r.json));
check('P1-2: second manual order still pending', t.q('SELECT status FROM orders WHERE id=?', ordF.id).status === 'pending_payment');
// 链上通道：人工消耗过的 TXID 即使链上真实存在，也不得被他单链上认领
r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordG = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
M.receipt = t.evmReceiptFor(ordG, forged, 9000);
r = await t.payCall(ordG.order_no, forged);
check('P1-2: chain claim of manually-consumed TXID rejected', r.json &&!r.json.ok && /已用于其他订单/.test(r.json.error || ''), JSON.stringify(r.json));
// 匹配交易正常完成（链上核验通过 → 认领 → posted）
const goodTx = 'e5'.repeat(32);
r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordH = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
M.receipt = t.evmReceiptFor(ordH, goodTx, 9000);
r = await t.payCall(ordH.order_no, goodTx);
check('P1-2: matching chain tx fulfills normally', r.json && r.json.ok === true && r.json.auto === true, JSON.stringify(r.json));
check('P1-2: matching chain tx claimed + posted', (() => { const c = t.q('SELECT * FROM txid_claims WHERE tx_hash=?', goodTx); const p = t.q("SELECT * FROM payments WHERE tx_hash=? AND status='posted'", goodTx); return c && c.order_id === ordH.id &&!!p;})());
// RPC 失败 / 金额错 / 地址错 → 不发货、不认领
r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordI = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
M.receipt = null;
r = await t.payCall(ordI.order_no, 'f6'.repeat(32));
check('P1-2: RPC failure -> no fulfill, no claim', r.json && r.json.ok === true && r.json.auto === false &&!t.q('SELECT * FROM txid_claims WHERE order_id=?', ordI.id) && t.q('SELECT status FROM orders WHERE id=?', ordI.id).status === 'pending_payment', JSON.stringify(r.json));
r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordJ = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
const wrongAmtLog = t.evmLogFor(ordJ, 'a7'.repeat(32), 9000, '0x0', amountToRaw(Number(ordJ.actual_amount) + 1, 6));
M.receipt = { status: '0x1', blockNumber: toHex(9000), transactionHash: 'a7'.repeat(32), logs: [wrongAmtLog]};
r = await t.payCall(ordJ.order_no, 'a7'.repeat(32));
check('P1-2: wrong amount -> no fulfill, no claim', r.json && r.json.auto === false &&!t.q('SELECT * FROM txid_claims WHERE order_id=?', ordJ.id), JSON.stringify(r.json));
r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordK = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
const wrongAddrLog = t.evmLogFor(ordK, 'b8'.repeat(32), 9000, '0x0', undefined, '0x' + '9'.repeat(40));
M.receipt = { status: '0x1', blockNumber: toHex(9000), transactionHash: 'b8'.repeat(32), logs: [wrongAddrLog]};
r = await t.payCall(ordK.order_no, 'b8'.repeat(32));
check('P1-2: wrong address -> no fulfill, no claim', r.json && r.json.auto === false &&!t.q('SELECT * FROM txid_claims WHERE order_id=?', ordK.id), JSON.stringify(r.json));
// 粉尘金额（BigInt 精确比较）：BEP20 18 位精度下 5005700 最小单位 ≠ 5.0057 USDT
r = await t.orderCall({ product_id: pM.id, quantity: 1, pay_method: 'Binance', pay_chain: 'BEP20'});
const ordL = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
const dustLog = t.evmLogFor(ordL, 'c9'.repeat(32), 9000, '0x0', '0x' + (5005700n).toString(16).padStart(64, '0'));
M.receipt = { status: '0x1', blockNumber: toHex(9000), transactionHash: 'c9'.repeat(32), logs: [dustLog]};
r = await t.payCall(ordL.order_no, 'c9'.repeat(32));
check('P1-2: dust amount (BigInt) not mistaken for full payment', r.json && r.json.auto === false &&!t.q('SELECT * FROM txid_claims WHERE order_id=?', ordL.id), JSON.stringify(r.json));
// 两订单并发同一 TXID：仅一成功
const txC = 'd0'.repeat(32);
r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordM = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
r = await t.orderCall({ product_id: pM.id, quantity: 1});
const ordN = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
M.receipt = t.evmReceiptFor(ordM, txC, 9000, [t.evmLogFor(ordM, txC, 9000), t.evmLogFor(ordN, txC, 9000)]);
const [cm, cn] = await Promise.all([t.payCall(ordM.order_no, txC), t.payCall(ordN.order_no, txC)]);
const chainWins = [cm, cn].filter((x) => x.json && x.json.ok && x.json.auto === true).length;
check('P1-2: concurrent same TXID exactly one chain-claims', chainWins === 1, JSON.stringify([cm.json, cn.json]));
check('P1-2: concurrent same TXID exactly one claim row', t.qa('SELECT * FROM txid_claims WHERE tx_hash=?', txC).length === 1);
}

// ================= P1-3：Turnstile 失败关闭 =================
{
resetMock();
const t = setup(); t.initBase();
const cookie = await t.adminLogin();
await t.call('POST', '/api/admin/products', { title: '商品-P1-3', category: 'recharge', stock_type: 'manual', sell_price: 4, source: 'self'}, cookie);
const pM = t.q("SELECT * FROM products WHERE title='商品-P1-3'");
t.setSetting('turnstile_enabled', '1');
t.setSetting('turnstile_site_key', 'test-site-key');
t.env.TURNSTILE_SECRET_KEY = 'test-secret';
M.turnstileSuccess = true;
let r = await t.orderCall({ product_id: pM.id, quantity: 1, turnstile_token: 'valid-token'});
check('P1-3: enabled + valid token -> order ok', r.json && r.json.ok === true, JSON.stringify(r.json));
M.turnstileSuccess = false;
r = await t.orderCall({ product_id: pM.id, quantity: 1, turnstile_token: 'bad-token'});
check('P1-3: enabled + bad token rejected', r.json &&!r.json.ok && /反机器人验证失败/.test(r.json.error || ''), JSON.stringify(r.json));
r = await t.orderCall({ product_id: pM.id, quantity: 1, _skipCaptcha: true});
check('P1-3: enabled + missing token rejected', r.json &&!r.json.ok && /反机器人验证/.test(r.json.error || ''), JSON.stringify(r.json));
t.setSetting('turnstile_site_key', '');
M.turnstileSuccess = true;
r = await t.orderCall({ product_id: pM.id, quantity: 1, turnstile_token: 'valid-token'});
check('P1-3: enabled + site key missing -> fail-closed', r.json &&!r.json.ok && /Site Key/.test(r.json.error || ''), JSON.stringify(r.json));
t.setSetting('turnstile_site_key', 'test-site-key');
delete t.env.TURNSTILE_SECRET_KEY;
r = await t.orderCall({ product_id: pM.id, quantity: 1, turnstile_token: 'valid-token'});
check('P1-3: enabled + secret missing -> fail-closed', r.json &&!r.json.ok && /密钥缺失/.test(r.json.error || ''), JSON.stringify(r.json));
t.env.TURNSTILE_SECRET_KEY = 'test-secret';
// 后台设置校验：开启时 sitekey/secret 缺失拒绝保存启用
t.setSetting('turnstile_enabled', '0');
t.setSetting('turnstile_site_key', '');
r = await t.call('POST', '/api/admin/settings', { settings: { turnstile_enabled: '1'}}, cookie);
check('P1-3: settings save enable without sitekey rejected', r.json &&!r.json.ok && /Site Key/.test(r.json.error || ''), JSON.stringify(r.json));
delete t.env.TURNSTILE_SECRET_KEY;
r = await t.call('POST', '/api/admin/settings', { settings: { turnstile_enabled: '1', turnstile_site_key: 'k1'}}, cookie);
check('P1-3: settings save enable without secret rejected', r.json &&!r.json.ok && /Secret/.test(r.json.error || ''), JSON.stringify(r.json));
t.env.TURNSTILE_SECRET_KEY = 'test-secret';
// 关闭时 SVG 路径不受影响
t.setSetting('turnstile_enabled', '0');
r = await t.orderCall({ product_id: pM.id, quantity: 1});
check('P1-3: disabled + valid SVG captcha -> order ok', r.json && r.json.ok === true, JSON.stringify(r.json));
const badCap = t.mkCaptcha('AB12');
r = await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1}, badCap, 'ZZZZ');
check('P1-3: disabled + wrong SVG captcha rejected', r.json &&!r.json.ok && /验证码/.test(r.json.error || ''), JSON.stringify(r.json));
}
{
// 独立 env：无 Secret 时保存启用必须拒绝；有 Secret 时可保存
resetMock();
const t = setup(); t.initBase();
const cookie = await t.adminLogin();
t.setSetting('turnstile_enabled', '0');
t.setSetting('turnstile_site_key', '');
delete t.env.TURNSTILE_SECRET_KEY;
let r = await t.call('POST', '/api/admin/settings', { settings: { turnstile_enabled: '1', turnstile_site_key: 'k1'}}, cookie);
check('P1-3: settings enable without secret rejected (isolated env)', r.json &&!r.json.ok && /Secret/.test(r.json.error || ''), JSON.stringify(r.json));
t.env.TURNSTILE_SECRET_KEY = 'test-secret';
r = await t.call('POST', '/api/admin/settings', { settings: { turnstile_enabled: '1', turnstile_site_key: 'k1'}}, cookie);
check('P1-3: settings enable with sitekey+secret ok', r.json && r.json.ok === true, JSON.stringify(r.json));
check('P1-3: settings enable persisted', t.q("SELECT value FROM settings WHERE key='turnstile_enabled'").value === '1');
}

// ================= P2-1：账本回填保护 posted =================
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  await t.call('POST', '/api/admin/products', { title: '手动商品-P2-1', category: 'recharge', stock_type: 'manual', sell_price: 4, source: 'self' }, cookie);
  const pM = t.q("SELECT * FROM products WHERE title='手动商品-P2-1'");
  const addr = '0x' + 'ab'.repeat(20);
  // posted 行 + 扫描回填：状态不得降级，event_key 只补元数据，不重触发履约
  const o1 = t.insertOrder({ product_id: pM.id, pay_method: 'OKX', pay_chain: 'X Layer', pay_address: addr, actual_amount: 5.0057, status: 'pending_payment', contact: freshContact(), customer_fields: JSON.stringify({ contact_email: freshContact() }) });
  const txP = 'e1'.repeat(32);
  t.db.prepare("INSERT INTO payments (order_id, chain, asset, pay_address, tx_hash, event_key, amount, amount_unit, block_number, confirmations, first_seen_at, status, reconcile_status, reconcile_note, created_at, updated_at) VALUES (?, ?, 'USDT', ?, ?, '', ?, 'USDT', 9000, 100, ?, 'posted', '', '', ?, ?)").run(o1.id, 'X Layer', addr, txP, 5.0057, nowStr(), nowStr(), nowStr());
  const postedId = t.q('SELECT id FROM payments WHERE tx_hash=?', txP).id;
  t.db.prepare('INSERT INTO scan_cursors (chain, last_block, updated_at) VALUES (?, ?, ?)').run('X Layer|' + addr, 8900, nowStr());
  M.logs = [t.evmLogFor(o1, txP, 9000, '0x3')];
  await t.scheduled();
  const afterPosted = t.q('SELECT * FROM payments WHERE id=?', postedId);
  check('P2-1: posted not downgraded by scan backfill', afterPosted.status === 'posted', JSON.stringify(afterPosted));
  check('P2-1: posted row event_key backfilled as metadata', afterPosted.event_key === '0x3', JSON.stringify(afterPosted));
  check('P2-1: posted row does not re-trigger fulfill', t.q('SELECT status FROM orders WHERE id=?', o1.id).status === 'pending_payment');
  // 空 event_key 回填（submitted → discovered → confirmed → posted，同一事件只一行）
  const o2 = t.insertOrder({ product_id: pM.id, pay_method: 'OKX', pay_chain: 'X Layer', pay_address: addr, actual_amount: 6.0066, status: 'pending_payment', contact: freshContact(), customer_fields: JSON.stringify({ contact_email: freshContact() }) });
  const txS = 'e2'.repeat(32);
  t.db.prepare("INSERT INTO payments (order_id, chain, asset, pay_address, tx_hash, event_key, amount, amount_unit, block_number, confirmations, first_seen_at, status, reconcile_status, reconcile_note, created_at, updated_at) VALUES (?, ?, 'USDT', ?, ?, '', ?, 'USDT', NULL, 0, ?, 'submitted', '', '', ?, ?)").run(o2.id, 'X Layer', addr, txS, 6.0066, nowStr(), nowStr(), nowStr());
  // 审计修复后逐单回溯 2000 区块：日志块 7500 在逐单窗口 [8000, ...] 之外、仅扫描命中（游标 7000），避免逐单抢先建第二行
  t.db.prepare('INSERT INTO scan_cursors (chain, last_block, updated_at) VALUES (?, ?, ?) ON CONFLICT(chain) DO UPDATE SET last_block=excluded.last_block').run('X Layer|' + addr, 7000, nowStr());
  M.logs = [t.evmLogFor(o2, txS, 7500, '0x3')];
  await t.scheduled();
  const rowsS = t.qa('SELECT * FROM payments WHERE tx_hash=?', txS);
  check('P2-1: empty event_key backfill keeps single row', rowsS.length === 1, JSON.stringify(rowsS));
  check('P2-1: backfilled row reaches posted', rowsS[0] && rowsS[0].status === 'posted' && rowsS[0].event_key === '0x3', JSON.stringify(rowsS[0]));
  check('P2-1: backfilled order fulfilled once', t.q('SELECT status FROM orders WHERE id=?', o2.id).status === 'pending_fulfill');
}

// ================= P2-2：轮询公平 =================
{
  resetMock();
  const t = setup(); t.initBase();
const cookieP22 = await t.adminLogin();
await t.call('POST', '/api/admin/products', { title: '手动商品-P2-2', category: 'recharge', stock_type: 'manual', sell_price: 4, source: 'self' }, cookieP22);
  const pM = t.q("SELECT * FROM products WHERE title='手动商品-P2-2'");
  const recentIds = [];
  for (let i = 0; i < 100; i++) {
    const o = t.insertOrder({ product_id: pM.id, last_checked_at: '2020-01-01 00:00:00', expires_at: "datetime('now','+30 minutes')" });
    recentIds.push(o.id);
  }
  const staleIds = [];
  for (let i = 0; i < 5; i++) {
    const o = t.insertOrder({ product_id: pM.id, last_checked_at: null, expires_at: "datetime('now','+30 minutes')" });
    staleIds.push(o.id);
  }
  const expiredO = t.insertOrder({ product_id: pM.id, last_checked_at: null, expires_at: "datetime('now','-1 minutes')" });
  M.logs = [];
  await t.scheduled();
  check('P2-2: never-checked orders get checked first', staleIds.every((id) => { const row = t.q('SELECT last_checked_at FROM orders WHERE id=?', id); return row && row.last_checked_at && row.last_checked_at !== null; }), JSON.stringify(staleIds.map((id) => t.q('SELECT last_checked_at FROM orders WHERE id=?', id))));
  const tailRecent = recentIds.slice(-5);
  check('P2-2: fair rotation leaves tail of previously-checked batch for next round', tailRecent.every((id) => t.q('SELECT last_checked_at FROM orders WHERE id=?', id).last_checked_at === '2020-01-01 00:00:00'), JSON.stringify(tailRecent.map((id) => t.q('SELECT last_checked_at FROM orders WHERE id=?', id))));
  check('P2-2: expired order still cancelled promptly despite queue', t.q('SELECT status FROM orders WHERE id=?', expiredO.id).status === 'cancelled');
}
{
  // 无有效订单时不做无意义 RPC
  resetMock();
  const t = setup(); t.initBase();
  M.rpcCalls = 0;
  await t.scheduled();
  check('P2-2: no pending orders -> zero RPC', M.rpcCalls === 0, 'rpcCalls=' + M.rpcCalls);
}
{
  // P2-2（集成回归）：RPC 出错不推进 last_checked_at，失败订单下轮仍排前面，尽快重试。
  resetMock();
  const t = setup(); t.initBase();
  const cookieP22b = await t.adminLogin();
  await t.call('POST', '/api/admin/products', { title: '手动商品-P2-2-RPC', category: 'recharge', stock_type: 'manual', sell_price: 4, source: 'self' }, cookieP22b);
  const pM = t.q("SELECT * FROM products WHERE title='手动商品-P2-2-RPC'");
  const o = t.insertOrder({ product_id: pM.id, last_checked_at: null, expires_at: "datetime('now','+30 minutes')" });
  M.rpcFail = true;
  const before = t.q('SELECT last_checked_at, status FROM orders WHERE id=?', o.id);
  await t.scheduled();
  const after = t.q('SELECT last_checked_at, status FROM orders WHERE id=?', o.id);
  check('P2-2: RPC error does not advance last_checked_at', after.last_checked_at === before.last_checked_at, 'before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
  check('P2-2: RPC error keeps order pending (not cancelled/fulfilled)', after.status === 'pending_payment', 'status=' + after.status);
  M.rpcFail = false;
}

// ================= P2-3：上游 delivered 但 keys 为空/不足 =================
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  t.setGate(1);
  await t.call('POST', '/api/admin/products', { title: '上游商品-P2-3', category: 'recharge', stock_type: 'manual', sell_price: 10, source: 'prodseller', prodseller_id: 'PS-T23' }, cookie);
  const pU = t.q("SELECT * FROM products WHERE title='上游商品-P2-3'");
  // 创建路径：keys 为空
  M.createFn = () => psResp({ id: 'PS-E1', status: 'delivered', deliveredKeys: [] });
  let r = await t.orderCall({ product_id: pU.id, quantity: 1 });
  const o1 = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  r = await t.call('POST', '/api/admin/orders/' + o1.id + '/confirm-payment', { reason: 'P2-3 空 keys' , manual_confirm: true }, cookie);
  check('P2-3: delivered + empty keys -> pending_activation, not completed', t.q('SELECT status FROM orders WHERE id=?', o1.id).status === 'pending_activation', JSON.stringify(r.json));
  check('P2-3: empty keys note has missing count + suggestion', /缺 1 个/.test(t.q('SELECT admin_note FROM orders WHERE id=?', o1.id).admin_note || '') && /建议/.test(t.q('SELECT admin_note FROM orders WHERE id=?', o1.id).admin_note || ''));
  // 创建路径：keys 不足
  M.createFn = () => psResp({ id: 'PS-E2', status: 'delivered', deliveredKeys: ['K1'] });
  r = await t.orderCall({ product_id: pU.id, quantity: 2 });
  const o2 = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  r = await t.call('POST', '/api/admin/orders/' + o2.id + '/confirm-payment', { reason: 'P2-3 keys 不足' , manual_confirm: true }, cookie);
  check('P2-3: delivered + insufficient keys -> pending_activation', t.q('SELECT status FROM orders WHERE id=?', o2.id).status === 'pending_activation');
  check('P2-3: insufficient keys note has missing count', /缺 1 个/.test(t.q('SELECT admin_note FROM orders WHERE id=?', o2.id).admin_note || ''));
  // 创建路径：keys 完整
  M.createFn = () => psResp({ id: 'PS-E3', status: 'delivered', deliveredKeys: ['K1', 'K2'] });
  r = await t.orderCall({ product_id: pU.id, quantity: 2 });
  const o3 = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  r = await t.call('POST', '/api/admin/orders/' + o3.id + '/confirm-payment', { reason: 'P2-3 keys 完整' , manual_confirm: true }, cookie);
  check('P2-3: delivered + full keys -> completed', t.q('SELECT status FROM orders WHERE id=?', o3.id).status === 'completed' && t.q('SELECT delivery_content FROM orders WHERE id=?', o3.id).delivery_content === 'K1\nK2');
  // 轮询 GET 路径：先空后完整
  const o4 = t.insertOrder({ product_id: pU.id, quantity: 1, status: 'pending_activation', paid_at: "datetime('now')", contact: freshContact() });
  t.db.prepare('INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, ?, ?, ?, ?)').run(o4.id, 'PS-E4', 'paid', 10, '');
  M.getFn = () => psResp({ id: 'PS-E4', status: 'delivered', deliveredKeys: [] });
  await t.scheduled();
  check('P2-3: poll delivered + empty keys -> pending_activation', t.q('SELECT status FROM orders WHERE id=?', o4.id).status === 'pending_activation');
  check('P2-3: poll empty keys note has missing count', /缺 1 个/.test(t.q('SELECT admin_note FROM orders WHERE id=?', o4.id).admin_note || ''));
  M.getFn = () => psResp({ id: 'PS-E4', status: 'delivered', deliveredKeys: ['A1'] });
  await t.scheduled();
  check('P2-3: poll delivered + full keys -> completed', t.q('SELECT status FROM orders WHERE id=?', o4.id).status === 'completed' && t.q('SELECT delivery_content FROM orders WHERE id=?', o4.id).delivery_content === 'A1');
}

// ================= P3-1：上游轮询完成 UPDATE 带租约 =================
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  t.setGate(1);
  await t.call('POST', '/api/admin/products', { title: '上游商品-P3-1', category: 'recharge', stock_type: 'manual', sell_price: 10, source: 'prodseller', prodseller_id: 'PS-T31' }, cookie);
  const pU = t.q("SELECT * FROM products WHERE title='上游商品-P3-1'");
  // 租约被他人持有（未过期）→ 轮询不得完成、不调上游
  const o1 = t.insertOrder({ product_id: pU.id, quantity: 1, status: 'pending_activation', paid_at: "datetime('now')", contact: freshContact(), upstream_lock: 'OTHER-HOLDER', upstream_lock_expires_at: "datetime('now','+30 minutes')" });
  t.db.prepare('INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, ?, ?, ?, ?)').run(o1.id, 'PS-L1', 'paid', 10, '');
  M.getFn = () => psResp({ id: 'PS-L1', status: 'delivered', deliveredKeys: ['LK1'] });
  M.gets = 0;
  await t.scheduled();
  check('P3-1: lease held by other -> poll does not complete, no upstream GET', t.q('SELECT status FROM orders WHERE id=?', o1.id).status === 'pending_activation' && M.gets === 0, 'gets=' + M.gets);
  // 旧租约（已过期）→ 轮询可接管并完成
  t.db.prepare('UPDATE orders SET upstream_lock=?, upstream_lock_expires_at=? WHERE id=?').run('OLD-LEASE', "datetime('now','-1 minutes')".replace("datetime('now','-1 minutes')", (() => { const d = new Date(Date.now() - 60000); return d.toISOString().replace('T', ' ').slice(0, 19); })()), o1.id);
  await t.scheduled();
  check('P3-1: expired lease -> poll takes over and completes', t.q('SELECT status FROM orders WHERE id=?', o1.id).status === 'completed' && t.q('SELECT delivery_content FROM orders WHERE id=?', o1.id).delivery_content === 'LK1');
  // 正常完成（无租约）
  const o2 = t.insertOrder({ product_id: pU.id, quantity: 1, status: 'pending_activation', paid_at: "datetime('now')", contact: freshContact() });
  t.db.prepare('INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, ?, ?, ?, ?)').run(o2.id, 'PS-L2', 'paid', 10, '');
  M.getFn = () => psResp({ id: 'PS-L2', status: 'delivered', deliveredKeys: ['LK2'] });
  await t.scheduled();
  check('P3-1: normal poll completion', t.q('SELECT status FROM orders WHERE id=?', o2.id).status === 'completed' && t.q('SELECT delivery_content FROM orders WHERE id=?', o2.id).delivery_content === 'LK2');
}

// ================= P3-2：管理端上游重试互斥 + 过期处理者不覆盖 =================
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  t.setGate(1);
  await t.call('POST', '/api/admin/products', { title: '上游商品-P3-2', category: 'recharge', stock_type: 'manual', sell_price: 10, source: 'prodseller', prodseller_id: 'PS-T32' }, cookie);
  const pU = t.q("SELECT * FROM products WHERE title='上游商品-P3-2'");
  const o1 = t.insertOrder({ product_id: pU.id, quantity: 1, status: 'pending_activation', paid_at: "datetime('now')", contact: freshContact() });
  t.db.prepare('INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, ?, ?, ?, ?)').run(o1.id, 'PS-R1', 'paid', 10, '');
  M.getFn = () => psResp({ id: 'PS-R1', status: 'delivered', deliveredKeys: ['RK1'] });
  M.gets = 0;
  const [r1, r2] = await Promise.all([
    t.call('POST', '/api/admin/upstream/orders/' + o1.id + '/retry', { reason: '重试1' }, cookie),
    t.call('POST', '/api/admin/upstream/orders/' + o1.id + '/retry', { reason: '重试2' }, cookie),
  ]);
  check('P3-2: concurrent admin retries -> single upstream GET', M.gets === 1, 'gets=' + M.gets + ' ' + JSON.stringify([r1.json, r2.json]));
  check('P3-2: concurrent admin retries -> completed once', t.q('SELECT status FROM orders WHERE id=?', o1.id).status === 'completed' && t.q('SELECT delivery_content FROM orders WHERE id=?', o1.id).delivery_content === 'RK1');
  // 过期处理者不覆盖新处理者：持有效租约的超期订单不被升级改写
  const past3h = (() => { const d = new Date(Date.now() - 3 * 3600 * 1000); return d.toISOString().replace('T', ' ').slice(0, 19); })();
  const future = (() => { const d = new Date(Date.now() + 30 * 60000); return d.toISOString().replace('T', ' ').slice(0, 19); })();
  const oLeased = t.insertOrder({ product_id: pU.id, quantity: 1, status: 'pending_activation', paid_at: past3h, created_at: past3h, contact: freshContact(), admin_note: 'ORIGINAL-NOTE', upstream_lock: 'LIVE-HOLDER', upstream_lock_expires_at: future });
  t.db.prepare('INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, ?, ?, ?, ?)').run(oLeased.id, 'PS-R2', 'paid', 10, '');
  const oFree = t.insertOrder({ product_id: pU.id, quantity: 1, status: 'pending_activation', paid_at: past3h, created_at: past3h, contact: freshContact(), admin_note: '' });
  t.db.prepare('INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, ?, ?, ?, ?)').run(oFree.id, 'PS-R3', 'paid', 10, '');
  M.getFn = () => psResp({ id: 'PS-R3', status: 'delivered', deliveredKeys: ['RK3'] });
  await t.scheduled();
  check('P3-2: escalation does not overwrite leased order note', t.q('SELECT admin_note FROM orders WHERE id=?', oLeased.id).admin_note === 'ORIGINAL-NOTE' && t.q('SELECT status FROM orders WHERE id=?', oLeased.id).status === 'pending_activation');
  check('P3-2: unleased stale order gets escalation note', /已升级告警/.test(t.q('SELECT admin_note FROM orders WHERE id=?', oFree.id).admin_note || ''));
}

// ================= P3-3：账本对账只接受合法转换 =================
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  function mkPay(status, tx) {
    const info = t.db.prepare("INSERT INTO payments (order_id, chain, asset, pay_address, tx_hash, event_key, amount, amount_unit, block_number, confirmations, first_seen_at, status, reconcile_status, reconcile_note, created_at, updated_at) VALUES (NULL, 'BEP20', 'USDT', '0x2222222222222222222222222222222222222222', ?, '0x0', 1, 'USDT', NULL, 0, ?, ?, '', '', ?, ?)").run(tx, nowStr(), status, nowStr(), nowStr());
    return Number(info.lastInsertRowid);
  }
  const idMis = mkPay('mismatch', 'f1'.repeat(32));
  const idUnm = mkPay('unmatched', 'f2'.repeat(32));
  const idDup = mkPay('duplicate', 'f3'.repeat(32));
  const idSub = mkPay('submitted', 'f4'.repeat(32));
  const idVer = mkPay('verified', 'f5'.repeat(32));
  const idPost = mkPay('posted', 'f6'.repeat(32));
  let r = await t.call('POST', '/api/admin/payments/' + idMis + '/reconcile', { note: '人工核对：金额差为手续费' }, cookie);
  check('P3-3: mismatch -> reconciled ok', r.json && r.json.ok === true && t.q('SELECT status FROM payments WHERE id=?', idMis).status === 'reconciled', JSON.stringify(r.json));
  r = await t.call('POST', '/api/admin/payments/' + idUnm + '/reconcile', { note: '人工核对：无法匹配，已联系客户' }, cookie);
  check('P3-3: unmatched -> reconciled ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  r = await t.call('POST', '/api/admin/payments/' + idDup + '/reconcile', { note: '人工核对：重复事件' }, cookie);
  check('P3-3: duplicate -> reconciled ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  r = await t.call('POST', '/api/admin/payments/' + idSub + '/reconcile', { note: '处理中不应直接对账' }, cookie);
  check('P3-3: submitted cannot reconcile', r.json && !r.json.ok && r.status === 409 && t.q('SELECT status FROM payments WHERE id=?', idSub).status === 'submitted', JSON.stringify(r.json));
  r = await t.call('POST', '/api/admin/payments/' + idVer + '/reconcile', { note: '处理中不应直接对账' }, cookie);
  check('P3-3: verified cannot reconcile', r.json && !r.json.ok && r.status === 409 && t.q('SELECT status FROM payments WHERE id=?', idVer).status === 'verified', JSON.stringify(r.json));
  r = await t.call('POST', '/api/admin/payments/' + idPost + '/reconcile', { note: '已入账' }, cookie);
  check('P3-3: posted cannot reconcile', r.json && !r.json.ok && t.q('SELECT status FROM payments WHERE id=?', idPost).status === 'posted', JSON.stringify(r.json));
  r = await t.call('POST', '/api/admin/payments/' + idMis + '/reconcile', { note: '重复对账' }, cookie);
  check('P3-3: reconciled cannot reconcile again', r.json && !r.json.ok && r.status === 409, JSON.stringify(r.json));
  // 两并发对账同一 mismatch 行：仅一成功
  const idCon = mkPay('mismatch', 'f7'.repeat(32));
  const [cr1, cr2] = await Promise.all([
    t.call('POST', '/api/admin/payments/' + idCon + '/reconcile', { note: '并发对账1' }, cookie),
    t.call('POST', '/api/admin/payments/' + idCon + '/reconcile', { note: '并发对账2' }, cookie),
  ]);
  const conWins = [cr1, cr2].filter((x) => x.json && x.json.ok === true).length;
  check('P3-3: concurrent reconcile exactly one wins', conWins === 1, JSON.stringify([cr1.json, cr2.json]));
  check('P3-3: reconcile writes audit with reason', !!t.q("SELECT * FROM admin_audit WHERE action='payment_reconcile' AND note LIKE '%人工核对：金额差为手续费%'"));
}

// ================= P3-4：邮箱字段口径一致（查单双查） =================
{
  resetMock();
  const t = setup(); t.initBase();
  await t.adminLogin();
  const o1 = t.insertOrder({ contact: 'Buyer@Example.com', customer_fields: JSON.stringify({ contact_email: 'Buyer@Example.com', activation_email: 'Other@Example.com' }) });
  const o2 = t.insertOrder({ contact: 'other@example.com', customer_fields: JSON.stringify({ contact_email: 'other@example.com', activation_email: 'buyer@example.com' }) });
  const o3 = t.insertOrder({ contact: 'hist@example.com', customer_fields: 'not-json' });
  async function queryQ(kw) {
    const cid = t.mkCaptcha('AB12');
    return t.call('POST', '/api/orders/query', { keywords: kw, captcha_id: cid, captcha_code: 'AB12' });
  }
  let r = await queryQ('buyer@example.com');
  const nos1 = (r.json.orders || []).map((x) => x.order_no);
  check('P3-4: email query exact case-insensitive matches contact/contact_email', nos1.includes(o1.order_no) && !nos1.includes(o2.order_no), JSON.stringify(nos1));
  r = await queryQ('BUYER@EXAMPLE.COM');
  check('P3-4: email query uppercase matches', (r.json.orders || []).some((x) => x.order_no === o1.order_no), JSON.stringify(r.json));
  r = await queryQ('buyer@exam');
  check('P3-4: partial email does not match', (r.json.orders || []).length === 0, JSON.stringify(r.json));
  r = await queryQ(o1.order_no);
  check('P3-4: order_no query still works', (r.json.orders || []).some((x) => x.order_no === o1.order_no), JSON.stringify(r.json));
  r = await queryQ('hist@example.com');
  check('P3-4: invalid JSON customer_fields does not crash query', (r.json.orders || []).some((x) => x.order_no === o3.order_no), JSON.stringify(r.json));
  r = await queryQ('other@example.com');
  check('P3-4: activation_email is NOT a query key', !(r.json.orders || []).some((x) => x.order_no === o1.order_no) && (r.json.orders || []).some((x) => x.order_no === o2.order_no), JSON.stringify(r.json));
}

// ================= P3-5：验证码不在限流/去重拒绝前消费 =================
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  await t.call('POST', '/api/admin/products', { title: '手动商品-P3-5', category: 'recharge', stock_type: 'manual', sell_price: 4, source: 'self' }, cookie);
  const pM = t.q("SELECT * FROM products WHERE title='手动商品-P3-5'");
  // /pay：限流命中不消费验证码（被限流拒绝的验证码仍可用）
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ordR1 = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  M.receipt = null;
  for (let i = 0; i < 5; i++) {
    const cid = t.mkCaptcha('AB12');
    const rr = await t.payCallWithCaptcha(ordR1.order_no, 'a1'.repeat(32), cid, 'ZZZZ');
    check('P3-5: /pay wrong captcha #' + (i + 1) + ' -> captcha error (rate slot consumed)', rr.json && !rr.json.ok && /验证码/.test(rr.json.error || ''), JSON.stringify(rr.json));
  }
  const capKeep = t.mkCaptcha('AB12');
  r = await t.payCallWithCaptcha(ordR1.order_no, 'a1'.repeat(32), capKeep, 'AB12');
  check('P3-5: /pay rate-limited before captcha consumed', r.status === 429 && r.json && !r.json.ok, JSON.stringify(r.json));
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ordR2 = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  r = await t.payCallWithCaptcha(ordR2.order_no, 'b2'.repeat(32), capKeep, 'AB12');
  check('P3-5: captcha not consumed by rate-limited /pay still usable', r.json && r.json.ok === true && r.json.auto === false && /TXID 已提交/.test(r.json.message || ''), JSON.stringify(r.json));
  // /pay：两并发共用同一验证码，仅一通过
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ordR3 = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ordR4 = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  M.receipt = t.evmReceiptFor(ordR3, 'c3'.repeat(32), 9000, [t.evmLogFor(ordR3, 'c3'.repeat(32), 9000), t.evmLogFor(ordR4, 'c3'.repeat(32), 9000)]);
  const capShared = t.mkCaptcha('AB12');
  const [q1, q2] = await Promise.all([
    t.payCallWithCaptcha(ordR3.order_no, 'c3'.repeat(32), capShared, 'AB12'),
    t.payCallWithCaptcha(ordR4.order_no, 'c3'.repeat(32), capShared, 'AB12'),
  ]);
  const capWins = [q1, q2].filter((x) => x.json && x.json.ok === true).length;
  const capErrs = [q1, q2].filter((x) => x.json && !x.json.ok && /验证码/.test(x.json.error || '')).length;
  check('P3-5: two concurrent /pay sharing one captcha -> exactly one passes', capWins === 1 && capErrs === 1, JSON.stringify([q1.json, q2.json]));
  // 下单：去重拒绝不消费验证码（被去重拒绝的验证码仍可用）
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const dupContact = 'dup-p35@test.example';
  r = await t.orderCall({ product_id: pM.id, quantity: 1, customer_fields: { contact_email: dupContact }, contact: dupContact });
  check('P3-5: setup dup order', r.json && r.json.ok === true, JSON.stringify(r.json));
  const capDup = t.mkCaptcha('AB12');
  r = await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1, customer_fields: { contact_email: dupContact }, contact: dupContact }, capDup, 'AB12');
  check('P3-5: duplicate order rejected without consuming captcha', r.json && !r.json.ok && /待付款订单/.test(r.json.error || ''), JSON.stringify(r.json));
  r = await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1, customer_fields: { contact_email: 'fresh-p35@test.example' }, contact: 'fresh-p35@test.example' }, capDup, 'AB12');
  check('P3-5: captcha not consumed by dup rejection still usable', r.json && r.json.ok === true, JSON.stringify(r.json));
  // 下单：两并发共用同一验证码，仅一成功
  const capCon = t.mkCaptcha('AB12');
  const [d1, d2] = await Promise.all([
    t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1, customer_fields: { contact_email: 'conc1-p35@test.example' }, contact: 'conc1-p35@test.example' }, capCon, 'AB12'),
    t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1, customer_fields: { contact_email: 'conc2-p35@test.example' }, contact: 'conc2-p35@test.example' }, capCon, 'AB12'),
  ]);
  const dWins = [d1, d2].filter((x) => x.json && x.json.ok === true).length;
  check('P3-5: two concurrent orders sharing one captcha -> exactly one wins', dWins === 1, JSON.stringify([d1.json, d2.json]));
}

// ================= P3-6：expires_at 为 NULL 的待付款订单超时 =================
{
  resetMock();
  const t = setup(); t.initBase();
  await t.adminLogin();
  const past30 = (() => { const d = new Date(Date.now() - 30 * 60000); return d.toISOString().replace('T', ' ').slice(0, 19); })();
  const oNull = t.insertOrder({ expires_at: null, created_at: past30 });
  const oEmpty = t.insertOrder({ expires_at: '', created_at: past30 });
  const oBad = t.insertOrder({ expires_at: 'not-a-date', created_at: past30 });
  const oFuture = t.insertOrder({ expires_at: "datetime('now','+30 minutes')" });
  const oPaid = t.insertOrder({ expires_at: null, created_at: past30, paid_at: past30 });
  const oLease = t.insertOrder({ expires_at: null, created_at: past30, claim_token: 'ACTIVE', claimed_at: nowStr() });
  const oDone = t.insertOrder({ expires_at: "datetime('now','-30 minutes')", status: 'completed', delivery_content: 'DONE' });
  M.logs = [];
  await t.scheduled();
  for (const [name, o] of [['NULL', oNull], ['empty', oEmpty], ['invalid', oBad]]) {
    check('P3-6: expires_at ' + name + ' -> timeout-cancelled via history fallback', t.q('SELECT status FROM orders WHERE id=?', o.id).status === 'cancelled');
    const note = t.q("SELECT note FROM admin_audit WHERE order_id=? AND action='auto_cancel_timeout' ORDER BY id DESC LIMIT 1", o.id);
    check('P3-6: expires_at ' + name + ' audit notes history fallback', !!note && /历史回退/.test(note.note || ''));
  }
  check('P3-6: valid future expires_at stays pending', t.q('SELECT status FROM orders WHERE id=?', oFuture.id).status === 'pending_payment');
  check('P3-6: paid order not cancelled by timeout', t.q('SELECT status FROM orders WHERE id=?', oPaid.id).status === 'pending_payment');
  check('P3-6: valid lease not cancelled by timeout', t.q('SELECT status FROM orders WHERE id=?', oLease.id).status === 'pending_payment');
  check('P3-6: completed order never timeout-cancelled', t.q('SELECT status FROM orders WHERE id=?', oDone.id).status === 'completed');
}

// ================= P3-7：验证码恒定时间比较 =================
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  await t.call('POST', '/api/admin/products', { title: '手动商品-P3-7', category: 'recharge', stock_type: 'manual', sell_price: 4, source: 'self' }, cookie);
  const pM = t.q("SELECT * FROM products WHERE title='手动商品-P3-7'");
  const capShort = t.mkCaptcha('AB12');
  let r = await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1 }, capShort, 'AB1');
  check('P3-7: captcha length mismatch -> error, no crash', r.json && !r.json.ok && /验证码/.test(r.json.error || '') && r.status < 500, JSON.stringify(r.json));
  const capMiss = t.mkCaptcha('AB12');
  r = await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1 }, capMiss, '');
  check('P3-7: captcha missing code -> error', r.json && !r.json.ok && /验证码/.test(r.json.error || ''), JSON.stringify(r.json));
  r = await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1 }, 'no-such-id', 'AB12');
  check('P3-7: captcha missing id -> error', r.json && !r.json.ok && /验证码/.test(r.json.error || ''), JSON.stringify(r.json));
  const capLong = t.mkCaptcha('AB12');
  r = await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1 }, capLong, 'A'.repeat(1000));
  check('P3-7: captcha malformed long input -> error, no crash', r.json && !r.json.ok && r.status < 500, JSON.stringify(r.json));
  const capOk = t.mkCaptcha('AB12');
  r = await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1 }, capOk, 'AB12');
  check('P3-7: captcha correct -> ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  // /secret：错误长度密码 → 401 通用错误
  await t.call('POST', '/api/admin/products', { title: '卡密商品-P3-7', category: 'account', stock_type: 'card', sell_price: 4, source: 'self' }, cookie);
  const pCard = t.q("SELECT * FROM products WHERE title='卡密商品-P3-7'");
  await t.call('POST', '/api/admin/cards/import', { product_id: pCard.id, codes: 'P37-CARD-1' }, cookie);
  r = await t.orderCall({ product_id: pCard.id, quantity: 1 });
  const ordC = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  r = await t.call('POST', '/api/admin/orders/' + ordC.id + '/confirm-payment', { reason: 'P3-7 发卡' , manual_confirm: true }, cookie);
  check('P3-7: setup card order completed', t.q('SELECT status FROM orders WHERE id=?', ordC.id).status === 'completed');
  r = await t.call('POST', '/api/orders/' + ordC.order_no + '/secret', { password: 'abc' });
  check('P3-7: /secret wrong-length password -> 401 generic', r.status === 401 && r.json && !r.json.ok, JSON.stringify(r.json));
  r = await t.call('POST', '/api/orders/' + ordC.order_no + '/secret', { password: 'TestPass123' });
  check('P3-7: /secret correct password -> ok', r.json && r.json.ok === true && r.json.delivery_content === 'P37-CARD-1', JSON.stringify(r.json));
  r = await t.call('GET', '/api/orders/' + ordC.order_no);
  check('Q-low: anonymous GET summary has no internal id / delivery', r.status === 200 && r.json.order && !('id' in r.json.order) && !r.json.order.delivery_content && r.json.order.order_no === ordC.order_no, JSON.stringify(r.json));
}

// ================= P2-7：管理端卡密列表掩码 + reveal =================
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  await t.call('POST', '/api/admin/products', { title: '卡密商品-P2-7', category: 'account', stock_type: 'card', sell_price: 4, source: 'self' }, cookie);
  const pCard = t.q("SELECT * FROM products WHERE title='卡密商品-P2-7'");
  await t.call('POST', '/api/admin/cards/import', { product_id: pCard.id, codes: 'SECRETCODE-001\nSHORT' }, cookie);
  const cardRow = t.q("SELECT * FROM cards WHERE code='SECRETCODE-001'");
  let r = await t.call('GET', '/api/admin/cards?product_id=' + pCard.id, null, cookie);
  const items = (r.json && r.json.cards) || [];
  check('P2-7: cards list has no full code', items.length === 2 && items.every((c) => !('code' in c)), JSON.stringify(items));
  const masked = items.find((c) => c.id === cardRow.id);
  check('P2-7: cards list code_masked = first4 + ****', masked && masked.code_masked === 'SECR****', JSON.stringify(masked));
  r = await t.call('GET', '/api/admin/cards/' + cardRow.id + '/reveal', null, null);
  check('P2-7: reveal without login -> 401', r.status === 401, JSON.stringify(r.json));
  r = await t.call('GET', '/api/admin/cards/' + cardRow.id + '/reveal', null, cookie);
  check('P2-7: reveal returns full code', r.json && r.json.ok === true && r.json.code === 'SECRETCODE-001', JSON.stringify(r.json));
  check('P2-7: reveal response no-cache', /no-store/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'));
  const audit = t.q("SELECT * FROM admin_audit WHERE action='card_reveal' ORDER BY id DESC LIMIT 1");
  check('P2-7: reveal audit exists without code text', !!audit && !/SECRETCODE-001/.test(audit.note || ''), JSON.stringify(audit));
  r = await t.call('GET', '/api/admin/cards/999999/reveal', null, cookie);
  check('P2-7: reveal missing card -> 404', r.status === 404, JSON.stringify(r.json));
}

// ================= P2-10：下单后端独立校验 =================
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  await t.call('POST', '/api/admin/products', { title: '手动商品-P2-10', category: 'recharge', stock_type: 'manual', sell_price: 4, source: 'self' }, cookie);
  const pM = t.q("SELECT * FROM products WHERE title='手动商品-P2-10'");
  for (const bad of [0, -1, 2.5, 100, 'abc', true, 1.5]) {
    const r = await t.call('POST', '/api/orders', { product_id: pM.id, quantity: bad, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'q@test.example' }, contact: 'q@test.example', query_password: 'TestPass123' });
    check('P2-10: quantity ' + JSON.stringify(bad) + ' rejected', r.json && !r.json.ok && /数量/.test(r.json.error || ''), JSON.stringify(r.json));
  }
  let r = await t.call('POST', '/api/orders', { product_id: pM.id, quantity: '', pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'q@test.example' }, contact: 'q@test.example', query_password: 'TestPass123' });
check('P2-10: quantity empty string defaults to 1 (not a quantity error)', r.json && !r.json.ok && /验证码/.test(r.json.error || '') && !/数量/.test(r.json.error || ''), JSON.stringify(r.json));
r = await t.orderCall({ product_id: pM.id, quantity: 99 });
  check('P2-10: quantity 99 ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  r = await t.orderCall({ product_id: pM.id });
  check('P2-10: quantity missing defaults to 1', r.json && r.json.ok === true, JSON.stringify(r.json));
  // 激活类商品
  await t.call('POST', '/api/admin/products', { title: '激活商品-P2-10', category: 'recharge', stock_type: 'manual', sell_price: 4, source: 'self', requires_email_activation: 1 }, cookie);
  const pAct = t.q("SELECT * FROM products WHERE title='激活商品-P2-10'");
  const actBase = { product_id: pAct.id, quantity: 1, customer_fields: { contact_email: 'act-base@test.example', activation_email: 'act@test.example', activation_email_confirm: 'act@test.example', activation_confirm: true }, contact: 'act-base@test.example' };
  r = await t.orderCall({ ...actBase, customer_fields: { ...actBase.customer_fields, activation_email: 'bad-email' } });
  check('P2-10: activation email bad format rejected', r.json && !r.json.ok && /激活邮箱/.test(r.json.error || ''), JSON.stringify(r.json));
  r = await t.orderCall({ ...actBase, customer_fields: { contact_email: 'act-base@test.example', activation_email: 'act@test.example' } });
  check('P2-10: activation confirm missing rejected', r.json && !r.json.ok && /确认/.test(r.json.error || ''), JSON.stringify(r.json));
  r = await t.orderCall({ ...actBase, customer_fields: { ...actBase.customer_fields, activation_email_confirm: 'other@test.example' } });
  check('P2-10: activation emails mismatch rejected', r.json && !r.json.ok && /不一致/.test(r.json.error || ''), JSON.stringify(r.json));
  r = await t.orderCall({ ...actBase, customer_fields: { ...actBase.customer_fields, activation_confirm: false } });
  check('P2-10: activation checkbox unchecked rejected', r.json && !r.json.ok && /勾选/.test(r.json.error || ''), JSON.stringify(r.json));
  r = await t.orderCall({ ...actBase, customer_fields: { contact_email: 'act-ok@test.example', activation_email: 'act@test.example', activation_email_confirm: 'act@test.example', activation_confirm: true }, contact: 'act-ok@test.example' });
  check('P2-10: activation email + confirm + checkbox ok', r.json && r.json.ok === true, JSON.stringify(r.json));
}

// ================= 额外边界 =================
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  // refund_pending 不经普通发货清除退款义务
  const oRp = t.insertOrder({ status: 'refund_pending', refund_status: 'pending' });
  let r = await t.call('POST', '/api/admin/orders/' + oRp.id + '/fulfill', { delivery_content: 'KEY' }, cookie);
  check('边界: refund_pending cannot fulfill directly', r.json && !r.json.ok && r.status === 409 && t.q('SELECT refund_status FROM orders WHERE id=?', oRp.id).refund_status === 'pending', JSON.stringify(r.json));
  // 仅白名单组合自动认账：TRC20 /pay 拒绝
  const oTrc = t.insertOrder({ pay_method: 'Binance', pay_chain: 'TRC20' });
  r = await t.payCall(oTrc.order_no, 'a1'.repeat(32));
  check('边界: TRC20 /pay rejected (whitelist only X Layer + BEP20)', r.json && !r.json.ok, JSON.stringify(r.json));
  // 上游门禁关闭时任何路径不得调真实 ProdSeller 建单
  t.setGate(0);
  await t.call('POST', '/api/admin/products', { title: '上游商品-边界', category: 'recharge', stock_type: 'manual', sell_price: 10, source: 'prodseller', prodseller_id: 'PS-B1' }, cookie);
  const pU = t.q("SELECT * FROM products WHERE title='上游商品-边界'");
  M.creates = 0;
  const oUp = t.insertOrder({ product_id: pU.id, quantity: 1, status: 'pending_payment' });
  r = await t.call('POST', '/api/admin/orders/' + oUp.id + '/confirm-payment', { reason: '门禁关闭确认' , manual_confirm: true }, cookie);
  check('边界: gate closed -> pending_upstream, zero upstream creates', t.q('SELECT status FROM orders WHERE id=?', oUp.id).status === 'pending_upstream' && M.creates === 0, JSON.stringify(r.json) + ' creates=' + M.creates);
}

console.log('\n==== review-p1-backend: ' + pass + ' passed, ' + fail + ' failed ====');
if (failures.length) console.log('FAILURES:', failures.join(', '));
process.exitCode = fail ? 1 : 0;
