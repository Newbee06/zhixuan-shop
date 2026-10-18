// TXID 竞态确定性回归测试（P1-1/P1-2 根治，2026-10-18）
// 规则：只测新行为；不访问真实上游/链上（全部 mock）；失败即报告代码 bug。
// 与 tests/review-p1-backend-test.mjs 共享 harness 套路，但独立 env/断言，不依赖该文件。
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
    let r = await call('POST', '/api/admin/login', { password: 'admin' });
    const c0 = r.headers.get('set-cookie') || '';
    r = await call('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'admin123' }, c0);
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



// ================= 确定性并发回归测试（P1-1/P1-2 根治） =================
// 规则：不用裸 Promise.all 当作并发证明；用 SQL/钩子 Barrier、Deferred Promise、可控失败注入
// （env.__testHooks.beforeTxidInsert / afterTxidClaimAndLease + DB 包装）制造确定性交错，可重复运行，
// 不依赖调度/时间窗口/随机延迟。所有测试同时检查 DB 最终状态与业务副作用，不只检查 HTTP 返回值。
// 钩子仅在测试 env 上设置，生产 env 无 __testHooks 时 worker 内 testHook 为 no-op。
function Deferred() {
  const d = {};
  d.promise = new Promise((res, rej) => { d.resolve = res; d.reject = rej; });
  return d;
}
function claimRow(t, tx) { return t.q('SELECT * FROM txid_claims WHERE tx_hash=?', tx); }
function ledgerRows(t, tx) { return t.qa("SELECT * FROM payments WHERE tx_hash=? AND status='manual_confirmed'", tx); }
async function manualProduct(t, cookie, title) {
  await t.call('POST', '/api/admin/products', { title, category: 'recharge', stock_type: 'manual', sell_price: 4, source: 'self' }, cookie);
  return t.q('SELECT * FROM products WHERE title=?', title);
}
async function confirm(t, orderId, cookie, reason) {
  return t.call('POST', '/api/admin/orders/' + orderId + '/confirm-payment', { reason: reason || '确定性测试人工确认', manual_confirm: true }, cookie);
}
function expireLease(t, orderId) {
  // 确定性模拟租约超时：把 claimed_at 推到 10 分钟前，使下一请求可按租约规则接管（不依赖真实等待 5 分钟）。
  t.db.prepare("UPDATE orders SET claimed_at=datetime('now','-10 minutes') WHERE id=?").run(orderId);
}

// ---------- A. 同订单认领回滚竞态（手动通道）：A 插认领→B 接管→A 恢复后回滚不得删 B 的认领 ----------
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-A-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const tx = 'aa'.repeat(32);
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, ord.id);

  const entered = Deferred();
  const releaseA = Deferred();
  let hookCalls = 0;
  t.env.__testHooks = {
    afterTxidClaimAndLease: async () => {
      hookCalls++;
      if (hookCalls === 1) { entered.resolve(); await releaseA.promise; }
      // 第 2 次及以后（接管请求 B）直接放行，不暂停，避免死锁。
    },
  };
  const pA = confirm(t, ord.id, cookie, 'A 人工确认（将被暂停）');
  await entered.promise; // 确定性：A 已持有租约 + TXID 认领、副作用尚未开始
  const claimA = claimRow(t, tx);
  check('A: A paused holding lease + claim (token non-empty, source manual)', !!claimA && !!claimA.claim_token && claimA.source === 'manual_confirmed' && claimA.order_id === ord.id, JSON.stringify(claimA));
  const leaseA = t.q('SELECT claim_token FROM orders WHERE id=?', ord.id).claim_token;
  check('A: A holds order lease', !!leaseA && claimA.order_lease_token === leaseA);
  expireLease(t, ord.id); // 确定性租约超时，接管请求可接管
  const rB = await confirm(t, ord.id, cookie, 'B 接管人工确认');
  check('A: B takeover confirm ok', rB.json && rB.json.ok === true, JSON.stringify(rB.json));
  check('A: order pending_fulfill after B', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_fulfill');
  const claimAfterB = claimRow(t, tx);
  check('A: claim adopted by B (same claim_token, lease rebound)', claimAfterB && claimAfterB.claim_token === claimA.claim_token && claimAfterB.order_id === ord.id, JSON.stringify(claimAfterB));
  check('A: exactly one manual ledger row after B', ledgerRows(t, tx).length === 1);
  releaseA.resolve(); // A 恢复：其失败路径（租约已失）不得删除认领
  const rA = await pA;
  check('A: stale A confirm fails (lease lost)', rA.json && !rA.json.ok, JSON.stringify(rA.json));
  check('A: stale A did NOT delete B claim', (() => { const c = claimRow(t, tx); return c && c.order_id === ord.id && c.claim_token === claimA.claim_token; })());
  check('A: order still pending_fulfill after stale A', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_fulfill');
  check('A: still exactly one manual ledger row', ledgerRows(t, tx).length === 1);
  // 第三订单不能用同一 TXID
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord3 = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, ord3.id);
  const r3 = await confirm(t, ord3.id, cookie, '第三订单同 TXID');
  check('A: third order same TXID rejected', r3.json && !r3.json.ok && /已用于其他订单/.test(r3.json.error || ''), JSON.stringify(r3.json));
  check('A: third order still pending + lease released', t.q('SELECT status FROM orders WHERE id=?', ord3.id).status === 'pending_payment' && t.q('SELECT claim_token FROM orders WHERE id=?', ord3.id).claim_token === '');
  check('A: claim still belongs to first order after third attempt', claimRow(t, tx).order_id === ord.id);
  t.env.__testHooks = {};
}

// ---------- B. 租约接管与旧请求回滚（链上通道）：A 经 /pay 暂停 → B 经 /pay 接管 → A 恢复不破坏 ----------
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-B-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const tx = 'bb'.repeat(32);
  M.receipt = t.evmReceiptFor(ord, tx, 9000);
  const entered = Deferred();
  const releaseA = Deferred();
  let hookCalls = 0;
  t.env.__testHooks = {
    afterTxidClaimAndLease: async () => { hookCalls++; if (hookCalls === 1) { entered.resolve(); await releaseA.promise; } },
  };
  const pA = t.payCall(ord.order_no, tx);
  await entered.promise;
  const claimA = claimRow(t, tx);
  check('B: A paused holding lease + chain claim', !!claimA && claimA.source === 'chain_verified' && !!claimA.claim_token, JSON.stringify(claimA));
  expireLease(t, ord.id);
  M.receipt = t.evmReceiptFor(ord, tx, 9000);
  const rB = await t.payCall(ord.order_no, tx);
  check('B: B takeover /pay fulfills', rB.json && rB.json.ok === true && rB.json.auto === true, JSON.stringify(rB.json));
  check('B: order pending_fulfill after B', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_fulfill');
  check('B: claim same token after takeover', claimRow(t, tx).claim_token === claimA.claim_token);
  releaseA.resolve();
  const rA = await pA;
  check('B: stale A /pay does not claim/complete (auto:false, no second fulfill)', rA.json && rA.json.ok === true && rA.json.auto === false, JSON.stringify(rA.json));
  check('B: stale A did NOT delete claim', claimRow(t, tx) && claimRow(t, tx).order_id === ord.id);
  check('B: order still pending_fulfill, exactly one claim', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_fulfill' && t.qa('SELECT * FROM txid_claims WHERE tx_hash=?', tx).length === 1);
  // 他单不能抢占
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ordOther = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  M.receipt = t.evmReceiptFor(ordOther, tx, 9000);
  const rOther = await t.payCall(ordOther.order_no, tx);
  check('B: other order same TXID /pay rejected 409', rOther.status === 409 && rOther.json && !rOther.json.ok, JSON.stringify(rOther.json));
  check('B: claim still first order', claimRow(t, tx).order_id === ord.id);
  t.env.__testHooks = {};
}

// ---------- C. 两管理员同时人工确认：Barrier 汇合后同时 INSERT，仅一单取得全局消费权 ----------
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-C-手动商品');
  const tx = 'cc'.repeat(32);
  const mkOrd = async () => {
    const r = await t.orderCall({ product_id: pM.id, quantity: 1 });
    const o = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
    t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, o.id);
    return o;
  };
  const o1 = await mkOrd();
  const o2 = await mkOrd();
  // Barrier：两个请求都走到 beforeTxidInsert（均已通过 SELECT、无认领行）后才同时放行 INSERT。
  // 这是确定性并发：不用 Promise.all 的调度运气，强制两请求在原子 INSERT 点真正相遇。
  let arrivals = 0;
  const waiters = [];
  t.env.__testHooks = {
    beforeTxidInsert: async () => {
      arrivals++;
      if (arrivals < 2) {
        await new Promise((res) => waiters.push(res));
      } else {
        while (waiters.length) waiters.shift()();
      }
    },
  };
  const [r1, r2] = await Promise.all([confirm(t, o1.id, cookie, '管理员1'), confirm(t, o2.id, cookie, '管理员2')]);
  check('C: barrier saw both requests at INSERT point', arrivals === 2, 'arrivals=' + arrivals);
  const wins = [r1, r2].filter((x) => x.json && x.json.ok === true).length;
  check('C: exactly one manual confirm wins', wins === 1, JSON.stringify([r1.json, r2.json]));
  check('C: exactly one claim row', t.qa('SELECT * FROM txid_claims WHERE tx_hash=?', tx).length === 1);
  check('C: exactly one manual ledger row', ledgerRows(t, tx).length === 1);
  const winnerId = claimRow(t, tx).order_id;
  const loserId = winnerId === o1.id ? o2.id : o1.id;
  check('C: winner pending_fulfill', t.q('SELECT status FROM orders WHERE id=?', winnerId).status === 'pending_fulfill');
  check('C: loser still pending_payment', t.q('SELECT status FROM orders WHERE id=?', loserId).status === 'pending_payment');
  check('C: loser lease released (not stuck)', t.q('SELECT claim_token FROM orders WHERE id=?', loserId).claim_token === '');
  check('C: claim source manual_confirmed + token', claimRow(t, tx).source === 'manual_confirmed' && !!claimRow(t, tx).claim_token);
  check('C: winner audit manual_confirm_payment', !!t.q("SELECT * FROM admin_audit WHERE order_id=? AND action='manual_confirm_payment'", winnerId));
  // 重试已成功单：不再重复副作用
  const rRetry = await confirm(t, winnerId, cookie, '重复确认已成功单');
  check('C: retry winner rejected (state guard)', rRetry.json && !rRetry.json.ok, JSON.stringify(rRetry.json));
  check('C: retry winner adds no ledger/claim', ledgerRows(t, tx).length === 1 && t.qa('SELECT * FROM txid_claims WHERE tx_hash=?', tx).length === 1);
  // 失败单重试同 TXID：仍被拒绝
  const rLoserRetry = await confirm(t, loserId, cookie, '失败单重试同 TXID');
  check('C: loser retry same TXID still rejected', rLoserRetry.json && !rLoserRetry.json.ok && /已用于其他订单/.test(rLoserRetry.json.error || ''), JSON.stringify(rLoserRetry.json));
  t.env.__testHooks = {};
}

// ---------- D. 人工与链上竞态（两种顺序） + 未验证/虚假回执/金额不匹配/确认数不足不能先占用 ----------
// D1：链上先得 → 人工拒绝
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-D-手动商品');
  const tx = 'dd'.repeat(32);
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const oChain = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  M.receipt = t.evmReceiptFor(oChain, tx, 9000);
  r = await t.payCall(oChain.order_no, tx);
  check('D1: chain /pay claims first', r.json && r.json.ok === true && r.json.auto === true, JSON.stringify(r.json));
  check('D1: claim source chain_verified', claimRow(t, tx).source === 'chain_verified');
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const oManual = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, oManual.id);
  const rM = await confirm(t, oManual.id, cookie, '链上先得后人工');
  check('D1: manual after chain rejected', rM.json && !rM.json.ok && /已用于其他订单/.test(rM.json.error || ''), JSON.stringify(rM.json));
  check('D1: manual loser pending + lease released', t.q('SELECT status FROM orders WHERE id=?', oManual.id).status === 'pending_payment' && t.q('SELECT claim_token FROM orders WHERE id=?', oManual.id).claim_token === '');
}
// D2：人工先得 → 链上拒绝（链上验证成功也不能绕过）
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-D2-手动商品');
  const tx = 'ee'.repeat(32);
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const oManual = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, oManual.id);
  const rM = await confirm(t, oManual.id, cookie, '人工先得');
  check('D2: manual claims first', rM.json && rM.json.ok === true, JSON.stringify(rM.json));
  check('D2: claim source manual_confirmed', claimRow(t, tx).source === 'manual_confirmed');
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const oChain = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  M.receipt = t.evmReceiptFor(oChain, tx, 9000);
  const rC = await t.payCall(oChain.order_no, tx);
  check('D2: chain after manual rejected 409 even though chain-verified', rC.status === 409 && rC.json && !rC.json.ok, JSON.stringify(rC.json));
  check('D2: claim still manual order', claimRow(t, tx).order_id === oManual.id && claimRow(t, tx).source === 'manual_confirmed');
}
// D3：未验证/虚假回执/金额不匹配/确认数不足 → 不能先占用为已验证付款；之后人工仍可认领
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-D3-手动商品');
  // 虚假回执（status 0x0）
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const oFake = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const txFake = 'f1'.repeat(32);
  M.receipt = { status: '0x0', blockNumber: '0x2328', transactionHash: txFake, logs: [] };
  r = await t.payCall(oFake.order_no, txFake);
  check('D3: fake receipt -> auto:false, no claim', r.json && r.json.auto === false && !claimRow(t, txFake), JSON.stringify(r.json));
  // 金额不匹配
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const oAmt = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const txAmt = 'f2'.repeat(32);
  const wrongLog = t.evmLogFor(oAmt, txAmt, 9000, '0x0', amountToRaw(Number(oAmt.actual_amount) + 1, 6));
  M.receipt = { status: '0x1', blockNumber: '0x2328', transactionHash: txAmt, logs: [wrongLog] };
  r = await t.payCall(oAmt.order_no, txAmt);
  check('D3: wrong amount -> auto:false, no claim', r.json && r.json.auto === false && !claimRow(t, txAmt), JSON.stringify(r.json));
  // 确认数不足（BEP20 需 15：收据块 9000，最新 9000 → 0 确认）
  r = await t.orderCall({ product_id: pM.id, quantity: 1, pay_method: 'Binance', pay_chain: 'BEP20' });
  const oConf = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const txConf = 'f3'.repeat(32);
  M.latest = 9000;
  M.receipt = t.evmReceiptFor(oConf, txConf, 9000);
  r = await t.payCall(oConf.order_no, txConf);
  check('D3: insufficient confirmations -> auto:false, no claim', r.json && r.json.auto === false && !claimRow(t, txConf), JSON.stringify(r.json));
  M.latest = 10000;
  // 未被占用的 TXID 之后人工确认仍可认领（证明未验证路径没有先占用）
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(txConf, oConf.id);
  const rM = await confirm(t, oConf.id, cookie, '未验证后人工确认');
  check('D3: manual can still claim never-occupied TXID', rM.json && rM.json.ok === true && claimRow(t, txConf).order_id === oConf.id, JSON.stringify(rM.json));
}

// ---------- E. 账本与故障恢复 ----------
// E1：TXID 认领表写入失败（触发器 IGNORE 模拟 D1 临时错误）→ 不谎称已用于他单、不留孤儿、租约释放；障碍移除后重试成功
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-E1-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const tx = 'e1'.repeat(32);
  M.receipt = t.evmReceiptFor(ord, tx, 9000);
  t.db.exec('CREATE TRIGGER trg_ignore_claim_e1 BEFORE INSERT ON txid_claims BEGIN SELECT RAISE(IGNORE); END;');
  r = await t.payCall(ord.order_no, tx);
  check('E1: claim insert failure -> not falsely 已用于其他订单', r.json && !/已用于其他订单/.test(JSON.stringify(r.json)), JSON.stringify(r.json));
  check('E1: no orphan claim after failed claim', !claimRow(t, tx));
  check('E1: order pending + lease released + paid_at cleared', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment' && t.q('SELECT claim_token FROM orders WHERE id=?', ord.id).claim_token === '' && !t.q('SELECT paid_at FROM orders WHERE id=?', ord.id).paid_at);
  t.db.exec('DROP TRIGGER trg_ignore_claim_e1');
  M.receipt = t.evmReceiptFor(ord, tx, 9000);
  r = await t.payCall(ord.order_no, tx);
  check('E1: retry after transient failure claims + fulfills', r.json && r.json.ok === true && r.json.auto === true && claimRow(t, tx).order_id === ord.id, JSON.stringify(r.json));
}
// E2：认领成功后 payments（人工账本）写入失败 → 不推已付款/已交付，认领保留，租约释放；重试幂等成功，不重复建行
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-E2-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const tx = 'e2'.repeat(32);
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, ord.id);
  // 可控失败注入：仅第一次 INSERT INTO payments 抛错（模拟账本写入失败），其余 SQL 正常。
  const origPrepare = t.env.DB.prepare.bind(t.env.DB);
  let failOnce = true;
  t.env.DB.prepare = (sql) => {
    const st = origPrepare(sql);
    if (failOnce && String(sql).indexOf('INSERT INTO payments') !== -1) {
      const origRun = st.run.bind(st);
      st.run = async () => { failOnce = false; throw new Error('injected payments insert failure'); };
      void origRun;
    }
    return st;
  };
  const rFail = await confirm(t, ord.id, cookie, '账本写入失败注入');
  check('E2: ledger failure -> confirm fails, not paid/delivered', rFail.json && !rFail.json.ok && /账本写入失败/.test(rFail.json.error || '') && t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment', JSON.stringify(rFail.json));
  check('E2: claim retained after ledger failure (not opened to others)', !!claimRow(t, tx) && claimRow(t, tx).order_id === ord.id && claimRow(t, tx).source === 'manual_confirmed');
  check('E2: no ledger row after failure', ledgerRows(t, tx).length === 0);
  check('E2: lease released after ledger failure (retry not stuck)', t.q('SELECT claim_token FROM orders WHERE id=?', ord.id).claim_token === '');
  // 他单在失败窗口内不能抢占该 TXID（认领已保留）
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ordOther = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, ordOther.id);
  const rOther = await confirm(t, ordOther.id, cookie, '他单抢占已保留认领');
  check('E2: other order cannot take retained claim', rOther.json && !rOther.json.ok && /已用于其他订单/.test(rOther.json.error || ''), JSON.stringify(rOther.json));
  // 同订单重试：收养同一认领，账本写入成功，不重复建认领/账本
  const rRetry = await confirm(t, ord.id, cookie, '同订单重试');
  check('E2: same-order retry succeeds', rRetry.json && rRetry.json.ok === true, JSON.stringify(rRetry.json));
  check('E2: exactly one claim + one ledger after retry', t.qa('SELECT * FROM txid_claims WHERE tx_hash=?', tx).length === 1 && ledgerRows(t, tx).length === 1);
  check('E2: retry order pending_fulfill', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_fulfill');
  t.env.DB.prepare = origPrepare;
}
// E3：payments 已写但后续履约阶段订单仍 pending_fulfill（可恢复态）→ 手动发货完成一次，不重复副作用；
// 同订单重复提交 / 不同订单重复用同一 TXID / 手动确认接口重复请求均不重复
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-E3-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const tx = 'e3'.repeat(32);
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, ord.id);
  const rM = await confirm(t, ord.id, cookie, 'E3 人工确认到 pending_fulfill');
  check('E3: manual confirm -> pending_fulfill (recoverable state)', rM.json && rM.json.ok === true && t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_fulfill', JSON.stringify(rM.json));
  // Worker 中间失败后再次处理同订单：手动发货完成
  const rF = await t.call('POST', '/api/admin/orders/' + ord.id + '/fulfill', { delivery_content: 'E3-DELIVERY-1' }, cookie);
  check('E3: manual fulfill completes once', rF.json && rF.json.ok === true && t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'completed' && t.q('SELECT delivery_content FROM orders WHERE id=?', ord.id).delivery_content === 'E3-DELIVERY-1', JSON.stringify(rF.json));
  check('E3: still exactly one claim + one ledger after fulfill', t.qa('SELECT * FROM txid_claims WHERE tx_hash=?', tx).length === 1 && ledgerRows(t, tx).length === 1);
  // 手动确认接口重复请求：已完成订单拒绝，不重复副作用
  const rDupConfirm = await confirm(t, ord.id, cookie, '重复人工确认');
  check('E3: duplicate manual confirm on completed rejected', rDupConfirm.json && !rDupConfirm.json.ok, JSON.stringify(rDupConfirm.json));
  check('E3: duplicate confirm adds nothing', t.qa('SELECT * FROM txid_claims WHERE tx_hash=?', tx).length === 1 && ledgerRows(t, tx).length === 1 && t.q('SELECT delivery_content FROM orders WHERE id=?', ord.id).delivery_content === 'E3-DELIVERY-1');
  // 同订单重复提交 TXID：/pay 状态守卫拒绝
  const rDupPay = await t.payCall(ord.order_no, tx);
  check('E3: same-order duplicate /pay rejected', rDupPay.json && !rDupPay.json.ok, JSON.stringify(rDupPay.json));
  // 不同订单重复用同一 TXID：人工 + 链上均拒绝
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord2 = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, ord2.id);
  const rOtherManual = await confirm(t, ord2.id, cookie, '不同订单同 TXID 人工');
  check('E3: different-order manual reuse rejected', rOtherManual.json && !rOtherManual.json.ok && /已用于其他订单/.test(rOtherManual.json.error || ''), JSON.stringify(rOtherManual.json));
  M.receipt = t.evmReceiptFor(ord2, tx, 9000);
  const rOtherPay = await t.payCall(ord2.order_no, tx);
  check('E3: different-order chain reuse rejected', rOtherPay.status === 409 || (rOtherPay.json && !rOtherPay.json.ok), JSON.stringify(rOtherPay.json));
  check('E3: claim still first order', claimRow(t, tx).order_id === ord.id);
}
// E4：租约接管用新 TXID 覆盖旧 tx_hash 时，旧认领仅由当前租约持有者释放（A-03 的确定性等价：旧租约已过期）
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-E4-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1, pay_method: 'Binance', pay_chain: 'BEP20' });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const txOld = 'e4'.repeat(32);
  const txNew = 'e5'.repeat(32);
  // 模拟：订单已认领旧 TXID 但处理崩溃、租约过期（旧认领行有令牌，订单租约已过期）
  t.db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?,?,?,?,?,?)').run(txOld, ord.id, new Date(Date.now() - 600000).toISOString().replace('T', ' ').slice(0, 19), 'OLD-CLAIM-TOKEN', 'chain_verified', 'STALE-LEASE');
  t.db.prepare("UPDATE orders SET tx_hash=?, claim_token='STALE-LEASE', claimed_at=datetime('now','-10 minutes') WHERE id=?").run(txOld, ord.id);
  M.latest = 10000;
  M.receipt = t.evmReceiptFor(ord, txNew, 9000);
  r = await t.payCall(ord.order_no, txNew);
  check('E4: takeover with new TXID ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('E4: order tx_hash updated to new', t.q('SELECT tx_hash FROM orders WHERE id=?', ord.id).tx_hash === txNew);
  check('E4: new TXID claimed', claimRow(t, txNew) && claimRow(t, txNew).order_id === ord.id);
  check('E4: old TXID claim superseded by current lease holder (no orphan)', !claimRow(t, txOld));
}

console.log('\n==== txid-race-deterministic: ' + pass + ' passed, ' + fail + ' failed ====');
if (failures.length) console.log('FAILURES:', failures.join(', '));
process.exitCode = fail ? 1 : 0;
