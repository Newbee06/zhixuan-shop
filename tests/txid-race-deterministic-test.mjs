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
    DB: { prepare: (sql) => wrapStmt(sql), async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } },
    ZHIXUAN_SETUP_TOKEN: 'test-setup-token',
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
    // B-P0: new DB first login uses setup token (env.ZHIXUAN_SETUP_TOKEN); no public default password.
    let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
    const c0 = r.headers.get('set-cookie') || '';
    r = await call('POST', '/api/admin/change-password', { old_password: '', new_password: 'txid-test-pass-123' }, c0);
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
    // 2026-10-30 新口径：/pay 未核验候选写入须带查询密码（与订单下单密码一致）。
    return call('POST', '/api/orders/' + orderNo + '/pay', { txid, captcha_id: cid, captcha_code: 'AB12', query_password: 'TestPass123' });
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
  // E3 语义更新（任务二）：已处理 TXID 重提为幂等成功（ok, auto:false），不再以“已非 pending_payment”拒绝；
  // 关键安全属性（无新认领/账本/副作用）由下方断言覆盖。
  check('E3: same-order duplicate /pay idempotent ok', rDupPay.json && rDupPay.json.ok === true && rDupPay.json.auto === false, JSON.stringify(rDupPay.json));
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

// ---------- E4（已修正）：已消费认领永不因换 TXID / 租约接管 / 失败恢复而被删除 ----------
// 旧 E4 曾断言“租约接管用新 TXID 覆盖旧 tx_hash 时删除旧认领”——该语义已被本轮认定为资金安全缺陷并修复：
// 旧认领一旦取得全局消费权，任何普通流程不得删除；新 TXID 只有通过完整链上核验并取得自身认领后，才成为新的付款事件。
// 以下 E4a–E4e 逐项证明：未验证新 TXID 不释放旧认领；已验证新 TXID 与旧认领共存为两笔付款事件；
// orders.tx_hash 保留第一笔已消费 TXID；他单重放旧 TXID 被拒绝；租约过期 + 已有认领时取消被拒绝；恢复中再次崩溃不破坏认领。
// E4a：旧认领来源 chain_verified；新 TXID 未验证 → 不释放旧认领；新 TXID 已验证 → 两认领共存
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-E4a-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const txOld = 'e4'.repeat(32);
  const txNewBad = 'e5'.repeat(32);
  const txNew = 'e6'.repeat(32);
  // 模拟：订单已认领旧 TXID（链上来源）后处理崩溃、租约过期；paid_at 已写（认领时写入），订单仍 pending_payment。
  t.db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?,?,?,?,?,?)').run(txOld, ord.id, new Date(Date.now() - 600000).toISOString().replace('T', ' ').slice(0, 19), 'OLD-CLAIM-TOKEN', 'chain_verified', 'STALE-LEASE');
  t.db.prepare("UPDATE orders SET tx_hash=?, claim_token='STALE-LEASE', claimed_at=datetime('now','-10 minutes'), paid_at=datetime('now','-10 minutes') WHERE id=?").run(txOld, ord.id);
  // ① 新 TXID 未通过链上核验（金额不匹配）→ auto:false，旧认领保留，tx_hash 不被候选覆盖
  const wrongLog = t.evmLogFor(ord, txNewBad, 9000, '0x0', amountToRaw(Number(ord.actual_amount) + 1, 6));
  M.receipt = { status: '0x1', blockNumber: '0x2328', transactionHash: txNewBad, logs: [wrongLog] };
  r = await t.payCall(ord.order_no, txNewBad);
  check('E4a: unverified new TXID -> auto:false, no new claim', r.json && r.json.auto === false && !claimRow(t, txNewBad), JSON.stringify(r.json));
  check('E4a: old chain claim retained after unverified new TXID', (() => { const c = claimRow(t, txOld); return c && c.order_id === ord.id && c.claim_token === 'OLD-CLAIM-TOKEN' && c.source === 'chain_verified'; })());
  check('E4a: orders.tx_hash still old consumed TXID (candidate did not overwrite)', t.q('SELECT tx_hash FROM orders WHERE id=?', ord.id).tx_hash === txOld);
  check('E4a: order still pending after unverified new TXID', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment');
  // ② 新 TXID 通过完整链上核验 → 履约成功；旧认领与新认领共存（两笔付款事件），tx_hash 仍为第一笔已消费 TXID
  M.receipt = t.evmReceiptFor(ord, txNew, 9000);
  r = await t.payCall(ord.order_no, txNew);
  check('E4a: verified new TXID fulfills', r.json && r.json.ok === true && r.json.auto === true, JSON.stringify(r.json));
  check('E4a: old claim STILL retained after verified new TXID (no auto-release)', (() => { const c = claimRow(t, txOld); return c && c.order_id === ord.id && c.claim_token === 'OLD-CLAIM-TOKEN'; })());
  check('E4a: new claim created for same order (second payment event)', (() => { const c = claimRow(t, txNew); return c && c.order_id === ord.id && c.source === 'chain_verified'; })());
  check('E4a: tx_hash still first consumed TXID after second payment', t.q('SELECT tx_hash FROM orders WHERE id=?', ord.id).tx_hash === txOld);
  check('E4a: order pending_fulfill after second payment', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_fulfill');
  check('E4a: two claims coexist for one order', t.qa('SELECT * FROM txid_claims WHERE order_id=?', ord.id).length === 2);
  // ③ 他单重放旧 TXID（链上 + 人工）均被拒绝，旧认领归属不变
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ordOther = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  M.receipt = t.evmReceiptFor(ordOther, txOld, 9000);
  const rOtherPay = await t.payCall(ordOther.order_no, txOld);
  check('E4a: other order replay old TXID via /pay rejected 409', rOtherPay.status === 409 && rOtherPay.json && !rOtherPay.json.ok, JSON.stringify(rOtherPay.json));
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(txOld, ordOther.id);
  const rOtherManual = await confirm(t, ordOther.id, cookie, '他单重放旧 TXID 人工');
  check('E4a: other order replay old TXID via manual rejected', rOtherManual.json && !rOtherManual.json.ok && /已用于其他订单/.test(rOtherManual.json.error || ''), JSON.stringify(rOtherManual.json));
  check('E4a: old claim still first order after replays', claimRow(t, txOld).order_id === ord.id);
  // ④ 同订单重复提交新 TXID：已非 pending_payment，拒绝，不产生重复副作用
  const rDup = await t.payCall(ord.order_no, txNew);
  // E4a 语义更新（同 E3）：已入账 TXID 重提为幂等成功，不产生重复副作用。
  check('E4a: same-order duplicate /pay after fulfill idempotent ok', rDup.json && rDup.json.ok === true && rDup.json.auto === false, JSON.stringify(rDup.json));
  check('E4a: still exactly two claims after duplicate', t.qa('SELECT * FROM txid_claims WHERE order_id=?', ord.id).length === 2);
}
// E4b：旧认领来源 manual_confirmed（账本写入失败后仅认领保留、订单仍 pending）；新 TXID 未验证/已验证分别处理
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-E4b-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const txOld = 'e7'.repeat(32);
  const txNewBad = 'e8'.repeat(32);
  const txNew = 'e9'.repeat(32);
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(txOld, ord.id);
  const origPrepare = t.env.DB.prepare.bind(t.env.DB);
  let failOnce = true;
  t.env.DB.prepare = (sql) => {
    const st = origPrepare(sql);
    if (failOnce && String(sql).indexOf('INSERT INTO payments') !== -1) {
      st.run = async () => { failOnce = false; throw new Error('injected payments insert failure (E4b)'); };
    }
    return st;
  };
  const rFail = await confirm(t, ord.id, cookie, 'E4b 账本失败留认领');
  t.env.DB.prepare = origPrepare;
  check('E4b: manual claim retained after ledger failure (source manual_confirmed)', (() => { const c = claimRow(t, txOld); return c && c.order_id === ord.id && c.source === 'manual_confirmed'; })());
  check('E4b: order pending + lease released after ledger failure', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment' && t.q('SELECT claim_token FROM orders WHERE id=?', ord.id).claim_token === '');
  // 未验证新 TXID 不释放旧人工认领
  const wrongLog = t.evmLogFor(ord, txNewBad, 9000, '0x0', amountToRaw(Number(ord.actual_amount) + 1, 6));
  M.receipt = { status: '0x1', blockNumber: '0x2328', transactionHash: txNewBad, logs: [wrongLog] };
  r = await t.payCall(ord.order_no, txNewBad);
  check('E4b: unverified new TXID keeps manual claim', r.json && r.json.auto === false && !!claimRow(t, txOld) && !claimRow(t, txNewBad), JSON.stringify(r.json));
  // 已验证新 TXID：两认领共存，tx_hash 仍为旧人工 TXID
  M.receipt = t.evmReceiptFor(ord, txNew, 9000);
  r = await t.payCall(ord.order_no, txNew);
  check('E4b: verified new TXID fulfills with manual claim retained', r.json && r.json.ok === true && r.json.auto === true, JSON.stringify(r.json));
  check('E4b: manual claim + chain claim coexist', (() => { const a = claimRow(t, txOld); const b = claimRow(t, txNew); return a && a.source === 'manual_confirmed' && a.order_id === ord.id && b && b.source === 'chain_verified' && b.order_id === ord.id; })());
  check('E4b: tx_hash still old manual TXID', t.q('SELECT tx_hash FROM orders WHERE id=?', ord.id).tx_hash === txOld);
  // 他单重放旧人工 TXID 被拒绝
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ordOther = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(txOld, ordOther.id);
  const rOther = await confirm(t, ordOther.id, cookie, '他单重放旧人工 TXID');
  check('E4b: other order replay manual TXID rejected', rOther.json && !rOther.json.ok && /已用于其他订单/.test(rOther.json.error || ''), JSON.stringify(rOther.json));
  check('E4b: manual claim still first order', claimRow(t, txOld).order_id === ord.id);
}
// E4c：多次切换候选 TXID（均未消费）：只有最终验证通过的 TXID 被认领；候选覆盖不产生认领行
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-E4c-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const txA = 'ea'.repeat(32);
  const txB = 'eb'.repeat(32);
  const txC = 'ec'.repeat(32);
  for (const txBad of [txA, txB]) {
    const wrongLog = t.evmLogFor(ord, txBad, 9000, '0x0', amountToRaw(Number(ord.actual_amount) + 1, 6));
    M.receipt = { status: '0x1', blockNumber: '0x2328', transactionHash: txBad, logs: [wrongLog] };
    r = await t.payCall(ord.order_no, txBad);
    check('E4c: candidate ' + txBad.slice(0, 2) + ' unverified -> auto:false, no claim', r.json && r.json.auto === false && !claimRow(t, txBad), JSON.stringify(r.json));
  }
  M.receipt = t.evmReceiptFor(ord, txC, 9000);
  r = await t.payCall(ord.order_no, txC);
  check('E4c: final verified candidate claims + fulfills', r.json && r.json.ok === true && r.json.auto === true, JSON.stringify(r.json));
  check('E4c: only final TXID claimed', !!claimRow(t, txC) && !claimRow(t, txA) && !claimRow(t, txB));
  check('E4c: tx_hash = verified TXID (no prior consumed TXID to preserve)', t.q('SELECT tx_hash FROM orders WHERE id=?', ord.id).tx_hash === txC);
  check('E4c: no posted payments for unverified candidates', t.qa("SELECT * FROM payments WHERE tx_hash IN (?,?) AND status='posted'", txA, txB).length === 0);
}
// E4d：恢复过程中 Worker 再次崩溃（接管请求在认领后暂停 → 租约过期 → 第三请求接管完成 → 旧请求恢复不破坏）
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-E4d-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const txOld = 'ed'.repeat(32);
  const txNew = 'ef'.repeat(32);
  t.db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?,?,?,?,?,?)').run(txOld, ord.id, new Date(Date.now() - 600000).toISOString().replace('T', ' ').slice(0, 19), 'OLD-CLAIM-TOKEN-D', 'chain_verified', 'STALE-LEASE-D');
  t.db.prepare("UPDATE orders SET tx_hash=?, claim_token='STALE-LEASE-D', claimed_at=datetime('now','-10 minutes'), paid_at=datetime('now','-10 minutes') WHERE id=?").run(txOld, ord.id);
  const entered = Deferred();
  const releaseFirst = Deferred();
  let hookCalls = 0;
  t.env.__testHooks = {
    afterTxidClaimAndLease: async () => { hookCalls++; if (hookCalls === 1) { entered.resolve(); await releaseFirst.promise; } },
  };
  M.receipt = t.evmReceiptFor(ord, txNew, 9000);
  const pFirst = t.payCall(ord.order_no, txNew);
  await entered.promise; // 第一个接管请求已持有新租约 + 新认领、副作用尚未开始
  check('E4d: first takeover holds new claim', (() => { const c = claimRow(t, txNew); return c && c.order_id === ord.id; })());
  expireLease(t, ord.id); // 模拟 Worker 再次崩溃：第一个接管请求的租约过期
  M.receipt = t.evmReceiptFor(ord, txNew, 9000);
  const rThird = await t.payCall(ord.order_no, txNew);
  check('E4d: third request takes over + completes', rThird.json && rThird.json.ok === true && rThird.json.auto === true, JSON.stringify(rThird.json));
  check('E4d: order pending_fulfill after third', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_fulfill');
  releaseFirst.resolve(); // 第一个接管请求恢复：租约已失，不得破坏第三请求的结果
  const rFirst = await pFirst;
  check('E4d: stale first takeover does not re-complete (auto:false)', rFirst.json && rFirst.json.ok === true && rFirst.json.auto === false, JSON.stringify(rFirst.json));
  check('E4d: old claim retained after double-crash recovery', !!claimRow(t, txOld) && claimRow(t, txOld).order_id === ord.id);
  check('E4d: new claim retained exactly once after double-crash recovery', t.qa('SELECT * FROM txid_claims WHERE tx_hash=?', txNew).length === 1 && claimRow(t, txNew).order_id === ord.id);
  check('E4d: exactly one posted payments row for new TXID (no duplicate side effect)', t.qa("SELECT * FROM payments WHERE tx_hash=? AND status='posted'", txNew).length === 1);
  check('E4d: tx_hash still first consumed TXID', t.q('SELECT tx_hash FROM orders WHERE id=?', ord.id).tx_hash === txOld);
  t.env.__testHooks = {};
}
// E4e：租约过期 + 已有 TXID 认领 → 超时清理与管理员普通取消均不得取消订单、不得释放认领；之后正常恢复仍可履约
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-E4e-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const txOld = 'f4'.repeat(32);
  const txNew = 'f5'.repeat(32);
  t.db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?,?,?,?,?,?)').run(txOld, ord.id, new Date(Date.now() - 600000).toISOString().replace('T', ' ').slice(0, 19), 'OLD-CLAIM-TOKEN-E', 'chain_verified', 'STALE-LEASE-E');
  t.db.prepare("UPDATE orders SET tx_hash=?, claim_token='STALE-LEASE-E', claimed_at=datetime('now','-10 minutes'), paid_at=datetime('now','-10 minutes'), expires_at=datetime('now','-1 minutes') WHERE id=?").run(txOld, ord.id);
  const rCancel = await t.call('POST', '/api/admin/orders/' + ord.id + '/cancel', { reason: 'E4e 已有认领不应取消' }, cookie);
  check('E4e: admin cancel with consumed claim rejected', rCancel.json && !rCancel.json.ok, JSON.stringify(rCancel.json));
  check('E4e: order still pending after rejected cancel', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment');
  M.logs = [];
  await t.scheduled(); // 超时清理：已有认领 → 不取消
  check('E4e: timeout cleanup does NOT cancel order with consumed claim', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment');
  check('E4e: claim retained after cleanup attempt', (() => { const c = claimRow(t, txOld); return c && c.order_id === ord.id && c.claim_token === 'OLD-CLAIM-TOKEN-E'; })());
  check('E4e: no auto_cancel_timeout audit for protected order', t.qa("SELECT * FROM admin_audit WHERE order_id=? AND action='auto_cancel_timeout'", ord.id).length === 0);
  // 正常恢复：提交已验证的新 TXID 仍可履约，旧认领保留
  M.receipt = t.evmReceiptFor(ord, txNew, 9000);
  r = await t.payCall(ord.order_no, txNew);
  check('E4e: recovery with new verified TXID still fulfills', r.json && r.json.ok === true && r.json.auto === true, JSON.stringify(r.json));
  check('E4e: old claim retained after recovery', !!claimRow(t, txOld) && claimRow(t, txOld).order_id === ord.id);
}

// ---------- F. 真正同时执行的人工 / 链上竞争（Barrier 控制在 beforeTxidInsert 原子点） ----------
// F1：人工确认 vs 链上核验同时争抢同一 TXID：两条路径均暂停在获得全局消费权之前，Barrier 汇合后同时放行 INSERT
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-F1-手动商品');
  const tx = 'f1'.repeat(32);
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const oManual = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, oManual.id);
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const oChain = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  M.receipt = t.evmReceiptFor(oChain, tx, 9000);
  let arrivals = 0;
  const waiters = [];
  t.env.__testHooks = {
    beforeTxidInsert: async () => {
      arrivals++;
      if (arrivals < 2) { await new Promise((res) => waiters.push(res)); }
      else { while (waiters.length) waiters.shift()(); }
    },
  };
  const [rM, rC] = await Promise.all([confirm(t, oManual.id, cookie, 'F1 人工确认'), t.payCall(oChain.order_no, tx)]);
  check('F1: barrier saw both manual + chain at INSERT point', arrivals === 2, 'arrivals=' + arrivals);
  const wins = [rM, rC].filter((x) => x.json && x.json.ok === true && (x.json.auto === true || x.json.message));
  // 人工胜：confirm ok；链上胜：/pay ok + auto:true。失败方：人工 confirm !ok；链上 /pay 409。
  const okCount = [rM, rC].filter((x) => x.json && x.json.ok === true).length;
  check('F1: exactly one of manual/chain wins', okCount === 1, JSON.stringify([rM.json, rC.json]));
  check('F1: exactly one claim row', t.qa('SELECT * FROM txid_claims WHERE tx_hash=?', tx).length === 1);
  const winnerId = claimRow(t, tx).order_id;
  const loserId = winnerId === oManual.id ? oChain.id : oManual.id;
  const winnerIsManual = winnerId === oManual.id;
  check('F1: claim source matches winner path', claimRow(t, tx).source === (winnerIsManual ? 'manual_confirmed' : 'chain_verified'), JSON.stringify(claimRow(t, tx)));
  check('F1: winner pending_fulfill', t.q('SELECT status FROM orders WHERE id=?', winnerId).status === 'pending_fulfill');
  check('F1: loser still pending_payment + lease released', t.q('SELECT status FROM orders WHERE id=?', loserId).status === 'pending_payment' && t.q('SELECT claim_token FROM orders WHERE id=?', loserId).claim_token === '');
  check('F1: loser has no posted payments', t.qa("SELECT * FROM payments WHERE order_id=? AND status='posted'", loserId).length === 0);
  if (winnerIsManual) {
    check('F1: manual winner has manual ledger row', ledgerRows(t, tx).length === 1 && ledgerRows(t, tx)[0].order_id === oManual.id);
    check('F1: chain loser got 409', rC.status === 409 && rC.json && !rC.json.ok, JSON.stringify(rC.json));
  } else {
    check('F1: chain winner has no manual ledger row (manual did not forge)', ledgerRows(t, tx).length === 0);
    check('F1: manual loser rejected', rM.json && !rM.json.ok, JSON.stringify(rM.json));
  }
  check('F1: no upstream orders created by loser race', t.qa('SELECT * FROM upstream_orders WHERE order_id IN (?,?) AND prodseller_order_id != ?', oManual.id, oChain.id, '').length === 0);
  // 获胜后重复请求不能重复产生副作用
  const rRetry = winnerIsManual ? await confirm(t, winnerId, cookie, 'F1 重复确认') : await t.payCall(t.q('SELECT order_no FROM orders WHERE id=?', winnerId).order_no, tx);
  // F1 语义更新（同 E3）：胜者重提已处理 TXID 为幂等成功，不新增认领/账本。
  check('F1: winner retry idempotent ok', rRetry.json && rRetry.json.ok === true && rRetry.json.auto === false, JSON.stringify(rRetry.json));
  check('F1: retry adds no claim', t.qa('SELECT * FROM txid_claims WHERE tx_hash=?', tx).length === 1);
  t.env.__testHooks = {};
}
// F2：两条链上核验请求同时争抢同一 TXID（Barrier 在 beforeTxidInsert）
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-F2-手动商品');
  const tx = 'f2'.repeat(32);
  const mkOrd = async () => {
    const r = await t.orderCall({ product_id: pM.id, quantity: 1 });
    return t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  };
  const o1 = await mkOrd();
  const o2 = await mkOrd();
  // 两单 actual_amount 必须相同、pay_address 必须不同：mock 收据是共享可变全局（M.receipt），两条并发链上路径读同一份收据；
  // 收据带两条日志（各匹配一单的地址+金额），两路验证均可通过；(pay_address, actual_amount) 唯一索引要求两单的地址/金额二元组不同。
  // 生产中每单独立查链上收据，不存在此共享问题。
  t.db.prepare('UPDATE orders SET pay_address=? WHERE id=?').run('0x3333333333333333333333333333333333333333', o2.id);
  t.db.prepare('UPDATE orders SET actual_amount=? WHERE id IN (?,?)').run(5.0057, o1.id, o2.id);
  const o1f = t.q('SELECT * FROM orders WHERE id=?', o1.id);
  const o2f = t.q('SELECT * FROM orders WHERE id=?', o2.id);
  M.receipt = { status: '0x1', blockNumber: '0x2328', transactionHash: tx, logs: [t.evmLogFor(o1f, tx, 9000, '0x0'), t.evmLogFor(o2f, tx, 9000, '0x1')] };
  let arrivals = 0;
  const waiters = [];
  t.env.__testHooks = {
    beforeTxidInsert: async () => {
      arrivals++;
      if (arrivals < 2) { await new Promise((res) => waiters.push(res)); }
      else { while (waiters.length) waiters.shift()(); }
    },
  };
  // 两条链上路径的收据分别对应各自订单（同 TXID、同金额、同收款地址口径），验证均会通过，胜负只由原子 INSERT 决定。
  const [r1, r2] = await Promise.all([
    (async () => { const rr = await t.payCall(o1.order_no, tx); return rr; })(),
    (async () => { const rr = await t.payCall(o2.order_no, tx); return rr; })(),
  ]);
  check('F2: barrier saw both chain requests at INSERT point', arrivals === 2, 'arrivals=' + arrivals);
  const wins = [r1, r2].filter((x) => x.json && x.json.ok === true && x.json.auto === true).length;
  check('F2: exactly one chain /pay wins', wins === 1, JSON.stringify([r1.json, r2.json]));
  check('F2: exactly one claim, source chain_verified', t.qa('SELECT * FROM txid_claims WHERE tx_hash=?', tx).length === 1 && claimRow(t, tx).source === 'chain_verified');
  const winnerId = claimRow(t, tx).order_id;
  const loserId = winnerId === o1.id ? o2.id : o1.id;
  check('F2: winner pending_fulfill, loser pending + lease released', t.q('SELECT status FROM orders WHERE id=?', winnerId).status === 'pending_fulfill' && t.q('SELECT status FROM orders WHERE id=?', loserId).status === 'pending_payment' && t.q('SELECT claim_token FROM orders WHERE id=?', loserId).claim_token === '');
  check('F2: loser /pay got 409', (winnerId === o1.id ? r2 : r1).status === 409, JSON.stringify([r1.json, r2.json]));
  check('F2: loser has no posted payments', t.qa("SELECT * FROM payments WHERE order_id=? AND status='posted'", loserId).length === 0);
  t.env.__testHooks = {};
}
// F3：一个请求的认领数据库操作失败 → 另一个请求随后竞争同一 TXID 并获胜；失败方重试仍被拒绝
{
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-F3-手动商品');
  const tx = 'f3'.repeat(32);
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const oA = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, oA.id);
  r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const oB = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  t.db.exec('CREATE TRIGGER trg_ignore_claim_f3 BEFORE INSERT ON txid_claims BEGIN SELECT RAISE(IGNORE); END;');
  const rA = await confirm(t, oA.id, cookie, 'F3 A 人工确认（认领写入失败）');
  check('F3: A claim DB failure -> confirm fails, not falsely 已用于其他订单', rA.json && !rA.json.ok && !/已用于其他订单/.test(JSON.stringify(rA.json)), JSON.stringify(rA.json));
  check('F3: no orphan claim after A failure', !claimRow(t, tx));
  check('F3: A pending + lease released after failure', t.q('SELECT status FROM orders WHERE id=?', oA.id).status === 'pending_payment' && t.q('SELECT claim_token FROM orders WHERE id=?', oA.id).claim_token === '');
  t.db.exec('DROP TRIGGER trg_ignore_claim_f3');
  M.receipt = t.evmReceiptFor(oB, tx, 9000);
  const rB = await t.payCall(oB.order_no, tx);
  check('F3: B competes after A failure and wins', rB.json && rB.json.ok === true && rB.json.auto === true && claimRow(t, tx).order_id === oB.id, JSON.stringify(rB.json));
  const rARetry = await confirm(t, oA.id, cookie, 'F3 A 重试同 TXID');
  check('F3: A retry after B win rejected (other-order claim)', rARetry.json && !rARetry.json.ok && /已用于其他订单/.test(rARetry.json.error || ''), JSON.stringify(rARetry.json));
  check('F3: claim still B after A retry', claimRow(t, tx).order_id === oB.id);
}

// ---------- G. poll_enabled 解耦：过期清理独立于链上扫描 ----------
{
  // G1：poll_enabled=0 时过期未付款订单仍被安全清理，预留释放 + 审计；G2：零 RPC
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-G-手动商品');
  t.setSetting('poll_enabled', '0');
  M.rpcCalls = 0;
  const oExp = t.insertOrder({ product_id: pM.id, status: 'pending_payment', expires_at: "datetime('now','-1 minutes')" });
  const oLive = t.insertOrder({ product_id: pM.id, status: 'pending_payment', expires_at: "datetime('now','+30 minutes')" });
  await t.scheduled();
  check('G1: poll_enabled=0 expired unpaid order cleaned', t.q('SELECT status FROM orders WHERE id=?', oExp.id).status === 'cancelled');
  check('G1: poll_enabled=0 cleanup writes audit', !!t.q("SELECT * FROM admin_audit WHERE order_id=? AND action='auto_cancel_timeout'", oExp.id));
  check('G1: poll_enabled=0 live order untouched', t.q('SELECT status FROM orders WHERE id=?', oLive.id).status === 'pending_payment');
  check('G2: poll_enabled=0 zero RPC during scheduled', M.rpcCalls === 0, 'rpcCalls=' + M.rpcCalls);
  // G8：清理重复运行幂等（不重复写审计/副作用）
  await t.scheduled();
  check('G8: cleanup rerun idempotent (single audit)', t.qa("SELECT * FROM admin_audit WHERE order_id=? AND action='auto_cancel_timeout'", oExp.id).length === 1);
  check('G8: cleanup rerun keeps cancelled', t.q('SELECT status FROM orders WHERE id=?', oExp.id).status === 'cancelled');
}
{
  // G3：poll_enabled=1 时原有扫描 + 超时清理正常；G9：RPC 失败时过期清理仍独立完成，扫描游标不推进
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-G3-手动商品');
  t.setSetting('poll_enabled', '1');
  const addr = '0x' + 'ab'.repeat(20);
  const oScan = t.insertOrder({ product_id: pM.id, pay_method: 'OKX', pay_chain: 'X Layer', pay_address: addr, actual_amount: 5.0057, status: 'pending_payment', expires_at: "datetime('now','+30 minutes')" });
  const txS = '67'.repeat(32);
  t.db.prepare('INSERT INTO scan_cursors (chain, last_block, updated_at) VALUES (?, ?, ?)').run('X Layer|' + addr, 8900, nowStr());
  M.logs = [t.evmLogFor(oScan, txS, 9000, '0x3')];
  await t.scheduled();
  check('G3: poll_enabled=1 scan fulfills verified order', t.q('SELECT status FROM orders WHERE id=?', oScan.id).status === 'pending_fulfill' && !!claimRow(t, txS), JSON.stringify(t.q('SELECT status FROM orders WHERE id=?', oScan.id)));
  // RPC 失败场景
  resetMock();
  const t2 = setup(); t2.initBase();
  const cookie2 = await t2.adminLogin();
  const pM2 = await manualProduct(t2, cookie2, '确定性-G9-手动商品');
  t2.setSetting('poll_enabled', '1');
  const oExp2 = t2.insertOrder({ product_id: pM2.id, status: 'pending_payment', expires_at: "datetime('now','-1 minutes')" });
  const oLive2 = t2.insertOrder({ product_id: pM2.id, status: 'pending_payment', expires_at: "datetime('now','+30 minutes')" });
  t2.db.prepare('INSERT INTO scan_cursors (chain, last_block, updated_at) VALUES (?, ?, ?)').run('X Layer|0x' + 'cd'.repeat(20), 8900, nowStr());
  M.rpcFail = true;
  await t2.scheduled();
  M.rpcFail = false;
  check('G9: RPC failure does not block expiry cleanup', t2.q('SELECT status FROM orders WHERE id=?', oExp2.id).status === 'cancelled');
  check('G9: RPC failure keeps live order pending', t2.q('SELECT status FROM orders WHERE id=?', oLive2.id).status === 'pending_payment');
  check('G9: RPC failure does not advance last_checked_at', !t2.q('SELECT last_checked_at FROM orders WHERE id=?', oLive2.id).last_checked_at);
  check('G9: scan cursor not advanced on RPC failure', t2.q('SELECT last_block FROM scan_cursors WHERE chain=?', 'X Layer|0x' + 'cd'.repeat(20)).last_block === 8900);
}
{
  // G4：poll_enabled=0 + 订单刚被真实链上核验并取得有效租约（认领 + 未过期租约）→ 清理不得取消
  // G5：已存在的有效付款事实（posted 账本）不能被超时清理覆盖
  // G6：租约过期后已有 TXID 全局认领 → 取消不得释放其消费权（与 E4e 同守卫，覆盖 poll_enabled=0 路径）
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-G456-手动商品');
  t.setSetting('poll_enabled', '0');
  const txLive = '6a'.repeat(32);
  const oLiveLease = t.insertOrder({ product_id: pM.id, status: 'pending_payment', claim_token: 'LIVE-LEASE', claimed_at: nowStr(), paid_at: nowStr(), tx_hash: txLive, expires_at: "datetime('now','-1 minutes')" });
  t.db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?,?,?,?,?,?)').run(txLive, oLiveLease.id, nowStr(), 'LIVE-CLAIM', 'chain_verified', 'LIVE-LEASE');
  const txPosted = '6b'.repeat(32);
  const oPosted = t.insertOrder({ product_id: pM.id, status: 'pending_payment', paid_at: nowStr(), expires_at: "datetime('now','-1 minutes')" });
  t.db.prepare("INSERT INTO payments (order_id, chain, asset, pay_address, tx_hash, event_key, amount, amount_unit, block_number, confirmations, first_seen_at, status, reconcile_status, reconcile_note, created_at, updated_at) VALUES (?, 'X Layer', 'USDT', '0x1111111111111111111111111111111111111111', ?, '', 5, 'USDT', 9000, 100, ?, 'posted', '', '', ?, ?)").run(oPosted.id, txPosted, nowStr(), nowStr(), nowStr());
  const txStale = '6c'.repeat(32);
  const oStaleClaim = t.insertOrder({ product_id: pM.id, status: 'pending_payment', claim_token: 'STALE-LEASE-G', claimed_at: "datetime('now','-10 minutes')", paid_at: "datetime('now','-10 minutes')", tx_hash: txStale, expires_at: "datetime('now','-1 minutes')" });
  t.db.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?,?,?,?,?,?)').run(txStale, oStaleClaim.id, new Date(Date.now() - 600000).toISOString().replace('T', ' ').slice(0, 19), 'STALE-CLAIM-G', 'chain_verified', 'STALE-LEASE-G');
  M.logs = [];
  await t.scheduled();
  check('G4: valid lease + claim + expired -> NOT cancelled under poll_enabled=0', t.q('SELECT status FROM orders WHERE id=?', oLiveLease.id).status === 'pending_payment');
  check('G4: live claim retained', !!claimRow(t, txLive) && claimRow(t, txLive).order_id === oLiveLease.id);
  check('G5: posted ledger order NOT cancelled by cleanup', t.q('SELECT status FROM orders WHERE id=?', oPosted.id).status === 'pending_payment');
  check('G6: stale lease + claim -> NOT cancelled, claim retained', t.q('SELECT status FROM orders WHERE id=?', oStaleClaim.id).status === 'pending_payment' && !!claimRow(t, txStale) && claimRow(t, txStale).order_id === oStaleClaim.id);
}
{
  // G7：取消后预留库存按实际记录恢复（poll_enabled=0 清理路径）
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  await t.call('POST', '/api/admin/products', { title: '确定性-G7-卡密商品', category: 'account', stock_type: 'card', sell_price: 4, source: 'self' }, cookie);
  const pC = t.q("SELECT * FROM products WHERE title='确定性-G7-卡密商品'");
  t.db.prepare('INSERT INTO cards (product_id, code, is_used, is_disabled, order_id, reserved_order_id, reserved_at, created_at) VALUES (?, ?, 0, 0, NULL, NULL, NULL, ?)').run(pC.id, 'G7-CARD-1', nowStr());
  const cardId = t.q('SELECT id FROM cards WHERE code=?', 'G7-CARD-1').id;
  const oExp = t.insertOrder({ product_id: pC.id, status: 'pending_payment', expires_at: "datetime('now','-1 minutes')" });
  t.db.prepare('UPDATE cards SET reserved_order_id=?, reserved_at=? WHERE id=?').run(oExp.id, nowStr(), cardId);
  t.setSetting('poll_enabled', '0');
  M.logs = [];
  await t.scheduled();
  check('G7: expired order cancelled under poll_enabled=0', t.q('SELECT status FROM orders WHERE id=?', oExp.id).status === 'cancelled');
  check('G7: reserved card released by cleanup', t.q('SELECT reserved_order_id FROM cards WHERE id=?', cardId).reserved_order_id === null && t.q('SELECT is_used FROM cards WHERE id=?', cardId).is_used === 0);
}
{
  // G10：符合租约保护要求的正常恢复流程继续有效（认领保留 + 租约过期后同 TXID 可收养履约）
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-G10-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const tx = '6d'.repeat(32);
  t.db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, ord.id);
  const origPrepare = t.env.DB.prepare.bind(t.env.DB);
  let failOnce = true;
  t.env.DB.prepare = (sql) => {
    const st = origPrepare(sql);
    if (failOnce && String(sql).indexOf('INSERT INTO payments') !== -1) {
      st.run = async () => { failOnce = false; throw new Error('injected payments insert failure (G10)'); };
    }
    return st;
  };
  const rFail = await confirm(t, ord.id, cookie, 'G10 账本失败留认领');
  t.env.DB.prepare = origPrepare;
  check('G10: claim retained after ledger failure, order pending', rFail.json && !rFail.json.ok && !!claimRow(t, tx) && t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment', JSON.stringify(rFail.json));
  M.receipt = t.evmReceiptFor(ord, tx, 9000);
  r = await t.payCall(ord.order_no, tx);
  check('G10: same-TXID recovery adopts retained claim + fulfills', r.json && r.json.ok === true && r.json.auto === true, JSON.stringify(r.json));
  check('G10: exactly one claim after recovery', t.qa('SELECT * FROM txid_claims WHERE tx_hash=?', tx).length === 1);
  check('G10: order pending_fulfill after recovery', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_fulfill');
}


// ================= 新增：任务一 A1.1 / A1.3、任务三 E4f/E4g、任务四 G11、任务五 B 项 =================
{
  // A1.1：旧认领查询抛 DB 异常 → fail-closed：订单 TXID、历史认领、账本、副作用全保持安全；DB 恢复后可安全重试。
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-A11-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const txOld = 'a1'.repeat(32);
  const txNew = 'a2'.repeat(32);
  // 崩溃态：旧认领已写 + tx_hash 已填（fill 已完成），账本未写、未履约。
  t.db.prepare("INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?, ?, datetime('now'), 'tok-old', 'chain_verified', '')").run(txOld, ord.id);
  t.db.prepare('UPDATE orders SET tx_hash=?, pending_tx_hash=? WHERE id=?').run(txOld, txNew, ord.id);
  const origPrepare = t.env.DB.prepare.bind(t.env.DB);
  t.env.DB.prepare = (sql) => {
    const st = origPrepare(sql);
    // 审计修复后旧认领查询改为双形态（遗留行收养）：注入串同步到新查询，fail-closed 语义不变
    if (String(sql) === 'SELECT 1 AS x FROM txid_claims WHERE LOWER(tx_hash) IN (?, ?) AND order_id = ? LIMIT 1') {
      st.first = async () => { throw new Error('injected old-claim query failure (A1.1)'); };
    }
    return st;
  };
  const rFail = await confirm(t, ord.id, cookie, 'A1.1 旧认领查询故障');
  t.env.DB.prepare = origPrepare;
  check('A1.1: old-claim query failure -> fail-closed !ok', rFail.json && !rFail.json.ok, JSON.stringify(rFail.json));
  check('A1.1: tx_hash unchanged, old claim retained, no new claim/ledger', t.q('SELECT tx_hash FROM orders WHERE id=?', ord.id).tx_hash === txOld && !!claimRow(t, txOld) && !claimRow(t, txNew) && t.qa('SELECT * FROM payments WHERE tx_hash=?', txNew).length === 0);
  check('A1.1: order still pending, no side effects', t.q('SELECT status, delivery_content FROM orders WHERE id=?', ord.id).status === 'pending_payment' && t.q('SELECT delivery_content FROM orders WHERE id=?', ord.id).delivery_content === '');
  // DB 恢复后同订单安全重试：旧认领账本恢复（chain_verified → verified pending）+ 新 TXID 人工认领履约。
  const rRetry = await confirm(t, ord.id, cookie, 'A1.1 DB 恢复后重试');
  check('A1.1: retry after DB recovery succeeds', rRetry.json && rRetry.json.ok === true, JSON.stringify(rRetry.json));
  check('A1.1: both claims retained after retry', !!claimRow(t, txOld) && !!claimRow(t, txNew));
  check('A1.1: old claim ledger restored (verified)', t.qa("SELECT * FROM payments WHERE tx_hash=? AND status='verified'", txOld).length === 1);
  check('A1.1: new claim ledger manual_confirmed', t.qa("SELECT * FROM payments WHERE tx_hash=? AND status='manual_confirmed'", txNew).length === 1);
  check('A1.1: first consumed tx_hash preserved (txOld)', t.q('SELECT tx_hash FROM orders WHERE id=?', ord.id).tx_hash === txOld);
}
{
  // A1.3：模拟缺失 v17 列（INSERT INTO txid_claims 抛 no such column）→ 链上与人工路径均 fail-closed 报迁移错误，无降级写入，不发货。
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-A13-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const txChain = 'b1'.repeat(32);
  const txManual = 'b2'.repeat(32);
  const origPrepare = t.env.DB.prepare.bind(t.env.DB);
  t.env.DB.prepare = (sql) => {
    const st = origPrepare(sql);
    if (String(sql).indexOf('INSERT INTO txid_claims') !== -1) {
      st.run = async () => { throw new Error('no such column: claim_token'); };
    }
    return st;
  };
  M.receipt = t.evmReceiptFor(ord, txChain, 9000);
  const rChain = await t.payCall(ord.order_no, txChain);
  check('A1.3: chain path schema fault -> fail-closed migration error', rChain.json && !rChain.json.ok && /迁移/.test(String(rChain.json.error || '')), JSON.stringify(rChain.json));
  t.db.prepare('UPDATE orders SET pending_tx_hash=? WHERE id=?').run(txManual, ord.id);
  const rManual = await confirm(t, ord.id, cookie, 'A1.3 人工路径 Schema 故障');
  check('A1.3: manual path schema fault -> fail-closed migration error', rManual.json && !rManual.json.ok && /迁移/.test(String(rManual.json.error || '')), JSON.stringify(rManual.json));
  t.env.DB.prepare = origPrepare;
  check('A1.3: no downgrade claim rows written', t.qa('SELECT * FROM txid_claims WHERE tx_hash IN (?, ?)', txChain, txManual).length === 0);
  check('A1.3: no ledger, order still pending, no fulfill', t.qa('SELECT * FROM payments WHERE tx_hash IN (?, ?)', txChain, txManual).length === 0 && t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_payment');
}
{
  // E4f：已完成订单收到第二笔真实 TXID → overpaid_pending（认领 + 独立账本 + 超额态），不重复发货；管理员对账后清态。
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  await t.call('POST', '/api/admin/products', { title: '确定性-E4f-卡密商品', category: 'account', stock_type: 'card', sell_price: 4, source: 'self' }, cookie);
  const pC = t.q("SELECT * FROM products WHERE title='确定性-E4f-卡密商品'");
  t.db.prepare('INSERT INTO cards (product_id, code, is_used, is_disabled, order_id, reserved_order_id, reserved_at, created_at) VALUES (?, ?, 0, 0, NULL, NULL, NULL, ?)').run(pC.id, 'E4F-CARD-1', nowStr());
  let r = await t.orderCall({ product_id: pC.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const tx1 = 'c1'.repeat(32);
  const tx2 = 'c2'.repeat(32);
  M.receipt = t.evmReceiptFor(ord, tx1, 9000);
  r = await t.payCall(ord.order_no, tx1);
  check('E4f: first payment completes order', r.json && r.json.ok === true && r.json.auto === true && t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'completed', JSON.stringify(r.json));
  const deliveryBefore = t.q('SELECT delivery_content FROM orders WHERE id=?', ord.id).delivery_content;
  M.receipt = t.evmReceiptFor(ord, tx2, 9001);
  r = await t.payCall(ord.order_no, tx2);
  check('E4f: second real TXID -> overpaid (ok, overpaid, no re-fulfill)', r.json && r.json.ok === true && r.json.overpaid === true && r.json.auto === false, JSON.stringify(r.json));
  check('E4f: order still completed, delivery unchanged', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'completed' && t.q('SELECT delivery_content FROM orders WHERE id=?', ord.id).delivery_content === deliveryBefore);
  check('E4f: second claim retained (chain_verified)', !!claimRow(t, tx2) && claimRow(t, tx2).source === 'chain_verified' && claimRow(t, tx2).order_id === ord.id);
  check('E4f: second ledger verified + overpaid_pending', (() => { const rows = t.qa("SELECT * FROM payments WHERE tx_hash=? AND status='verified'", tx2); return rows.length === 1 && rows[0].reconcile_status === 'overpaid_pending'; })());
  check('E4f: payment_state overpaid_pending', t.q('SELECT payment_state FROM orders WHERE id=?', ord.id).payment_state === 'overpaid_pending');
  check('E4f: both claims retained', !!claimRow(t, tx1) && !!claimRow(t, tx2));
  // 管理员对账超额付款 → reconciled + payment_state 清空。
  const payRow2 = t.q("SELECT * FROM payments WHERE tx_hash=? AND status='verified'", tx2);
  r = await t.call('POST', '/api/admin/payments/' + payRow2.id + '/reconcile', { note: 'E4f 超额付款已退回客户' }, cookie);
  check('E4f: reconcile overpaid row ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('E4f: payment_state cleared after reconcile', t.q('SELECT payment_state FROM orders WHERE id=?', ord.id).payment_state === '');
  check('E4f: overpaid row reconciled', t.q('SELECT status FROM payments WHERE id=?', payRow2.id).status === 'reconciled');
}
{
  // E4g：已入账（posted）订单 + 新核验 TXID → overpaid，不重复履约；他单重放新/旧 TXID 均被拒绝。
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-E4g-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const tx1 = 'd1'.repeat(32);
  const tx2 = 'd2'.repeat(32);
  M.receipt = t.evmReceiptFor(ord, tx1, 9000);
  r = await t.payCall(ord.order_no, tx1);
  check('E4g: first payment -> pending_fulfill posted', r.json && r.json.ok === true && t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_fulfill' && t.qa("SELECT * FROM payments WHERE tx_hash=? AND status='posted'", tx1).length === 1, JSON.stringify(r.json));
  M.receipt = t.evmReceiptFor(ord, tx2, 9001);
  r = await t.payCall(ord.order_no, tx2);
  check('E4g: new verified TXID on posted order -> overpaid', r.json && r.json.ok === true && r.json.overpaid === true, JSON.stringify(r.json));
  check('E4g: no re-fulfill, both claims retained', t.q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_fulfill' && !!claimRow(t, tx1) && !!claimRow(t, tx2));
  // 他单重放旧/新 TXID → 409 拒绝。
  let r2 = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ordOther = t.q('SELECT * FROM orders WHERE order_no=?', r2.json.order.order_no);
  M.receipt = t.evmReceiptFor(ordOther, tx1, 9000);
  r2 = await t.payCall(ordOther.order_no, tx1);
  check('E4g: other-order replay of old TXID rejected 409', r2.status === 409 && r2.json && !r2.json.ok, JSON.stringify(r2.json));
  M.receipt = t.evmReceiptFor(ordOther, tx2, 9001);
  r2 = await t.payCall(ordOther.order_no, tx2);
  check('E4g: other-order replay of new TXID rejected 409', r2.status === 409 && r2.json && !r2.json.ok, JSON.stringify(r2.json));
  check('E4g: replay left no ledger for other order', t.qa('SELECT * FROM payments WHERE order_id=? AND status IN (?, ?, ?)', ordOther.id, 'verified', 'confirmed', 'posted').length === 0);
}
{
  // G11：501 笔未付款订单，前 500 笔未到期，第 501 笔已过期且预留一张卡密；poll_enabled=0 一次定时任务 →
  // 第 501 笔取消、卡密释放、审计仅一次、零 RPC、未到期订单不变、有认领/已验证付款/有效租约的订单不受影响。
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  await t.call('POST', '/api/admin/products', { title: '确定性-G11-卡密商品', category: 'account', stock_type: 'card', sell_price: 4, source: 'self' }, cookie);
  const pC = t.q("SELECT * FROM products WHERE title='确定性-G11-卡密商品'");
  t.db.prepare('INSERT INTO cards (product_id, code, is_used, is_disabled, order_id, reserved_order_id, reserved_at, created_at) VALUES (?, ?, 0, 0, NULL, NULL, NULL, ?)').run(pC.id, 'G11-CARD-1', nowStr());
  const cardId = t.q('SELECT id FROM cards WHERE code=?', 'G11-CARD-1').id;
  const ids = [];
  for (let i = 0; i < 500; i++) ids.push(t.insertOrder({ product_id: pC.id, expires_at: "datetime('now','+30 minutes')" }).id);
  const o501 = t.insertOrder({ product_id: pC.id, expires_at: "datetime('now','-1 minutes')" });
  t.db.prepare('UPDATE cards SET reserved_order_id=?, reserved_at=? WHERE id=?').run(o501.id, nowStr(), cardId);
  // 受保护的过期订单：有认领 / 有 verified 付款 / 有效租约。
  const txClaim = 'e1'.repeat(32);
  const oClaimed = t.insertOrder({ product_id: pC.id, expires_at: "datetime('now','-1 minutes')" });
  t.db.prepare("INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?, ?, datetime('now'), 'tok-g11', 'chain_verified', '')").run(txClaim, oClaimed.id);
  const oPaid = t.insertOrder({ product_id: pC.id, expires_at: "datetime('now','-1 minutes')" });
  t.db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, status) VALUES (?, 'BEP20', '', ?, '', 10, 'verified')").run(oPaid.id, 'e2'.repeat(32));
  const oLeased = t.insertOrder({ product_id: pC.id, expires_at: "datetime('now','-1 minutes')", claim_token: 'lease-g11', claimed_at: "datetime('now')" });
  t.setSetting('poll_enabled', '0');
  M.logs = [];
  await t.scheduled();
  check('G11: 501st expired order cancelled', t.q('SELECT status FROM orders WHERE id=?', o501.id).status === 'cancelled');
  check('G11: reserved card released', t.q('SELECT reserved_order_id FROM cards WHERE id=?', cardId).reserved_order_id === null && t.q('SELECT is_used FROM cards WHERE id=?', cardId).is_used === 0);
  check('G11: exactly one expiry audit', t.qa("SELECT * FROM admin_audit WHERE action='auto_cancel_timeout' AND order_id=?", o501.id).length === 1);
  check('G11: zero RPC under poll_enabled=0', M.rpcCalls === 0);
  check('G11: first 500 unexpired untouched', t.qa("SELECT * FROM orders WHERE id IN (SELECT id FROM orders WHERE status='pending_payment') AND id != ? AND id != ? AND id != ? AND id != ?", oClaimed.id, oPaid.id, oLeased.id, o501.id).length === 500);
  check('G11: claimed order unaffected', t.q('SELECT status FROM orders WHERE id=?', oClaimed.id).status === 'pending_payment' && !!claimRow(t, txClaim));
  check('G11: verified-payment order unaffected', t.q('SELECT status FROM orders WHERE id=?', oPaid.id).status === 'pending_payment');
  check('G11: valid-lease order unaffected', t.q('SELECT status FROM orders WHERE id=?', oLeased.id).status === 'pending_payment');
}
{
  // B-P1-4：验证码 SVG 无 <text> 节点（正则提取失败），且正常验证码仍可校验通过。
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-B14-手动商品');
  const cap = await t.call('GET', '/api/captcha');
  check('B-P1-4: captcha svg has no <text> node', cap.json && typeof cap.json.svg === 'string' && !/<text[\s>]/.test(cap.json.svg), JSON.stringify((cap.json || {}).svg || '').slice(0, 200));
  check('B-P1-4: captcha svg has <rect> pixel blocks', cap.json && /<rect/.test(cap.json.svg || ''));
  const capId = t.mkCaptcha('AB12');
  const r = await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1 }, capId, 'AB12');
  check('B-P1-4: normal captcha still verifies', r.json && r.json.ok === true, JSON.stringify(r.json));
}
{
  // B-P1-6：/lookup 需验证码 + 按单原子记数（5 次/10 分钟），成功后清零。
  resetMock();
  const t = setup(); t.initBase();
  const o1 = t.insertOrder({ query_password: 'legacy-pw-999' });
  // 无验证码 → 401。
  let r = await t.call('POST', '/api/orders/' + o1.order_no + '/lookup', { credential: 'legacy-pw-999' });
  check('B-P1-6: /lookup without captcha -> 401', r.status === 401, JSON.stringify(r.json));
  // 5 次错凭证（每次新验证码）→ 第 6 次正确凭证 → 429。
  // 2026-10-30 新口径（双维限流）：触顶须同单同 IP——本 harness 默认每调用轮换 IP，
  // 故此处固定同一 IP；分布式（每 IP 1 次）不再锁单，见紧随其后的新断言。
  for (let i = 0; i < 5; i++) {
    const cid = t.mkCaptcha('AB12');
    const rr = await t.call('POST', '/api/orders/' + o1.order_no + '/lookup', { credential: 'wrong', captcha_id: cid, captcha_code: 'AB12' }, undefined, { 'CF-Connecting-IP': '10.88.6.6' });
    if (i === 0) check('B-P1-6: wrong cred still 401 (counted)', rr.status === 401, JSON.stringify(rr.json));
  }
  const cid6 = t.mkCaptcha('AB12');
  r = await t.call('POST', '/api/orders/' + o1.order_no + '/lookup', { credential: 'legacy-pw-999', captcha_id: cid6, captcha_code: 'AB12' }, undefined, { 'CF-Connecting-IP': '10.88.6.6' });
  check('B-P1-6: 6th attempt after 5 failures -> 429', r.status === 429, JSON.stringify(r.json));
  // 双维新语义：同单被单 IP 刷满后，换一个新 IP 的正确凭证不受牵连（总量 5 < 20）。
  const cidNewIp = t.mkCaptcha('AB12');
  r = await t.call('POST', '/api/orders/' + o1.order_no + '/lookup', { credential: 'legacy-pw-999', captcha_id: cidNewIp, captcha_code: 'AB12' }, undefined, { 'CF-Connecting-IP': '10.88.9.9' });
  check('B-P1-6: new IP not locked by single-IP bucket', r.json && r.json.ok === true, JSON.stringify(r.json));
  // 成功清零：新订单 2 错 → 成功 → 4 错 → 正确仍成功。
  const o2 = t.insertOrder({ query_password: 'legacy-pw-999' });
  for (let i = 0; i < 2; i++) { const cid = t.mkCaptcha('AB12'); await t.call('POST', '/api/orders/' + o2.order_no + '/lookup', { credential: 'wrong', captcha_id: cid, captcha_code: 'AB12' }); }
  const cidOk = t.mkCaptcha('AB12');
  r = await t.call('POST', '/api/orders/' + o2.order_no + '/lookup', { credential: 'legacy-pw-999', captcha_id: cidOk, captcha_code: 'AB12' });
  check('B-P1-6: success after 2 failures ok + clears bucket', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('B-P1-6: lookup_attempts cleared on success', t.qa('SELECT * FROM lookup_attempts WHERE order_no=?', o2.order_no).length === 0);
  // 注：首次成功后 legacy 订单已按 P2-2 迁移为 salted（/lookup 不再接受旧密码），故用记数证明清零：
  // 若成功未清零，2 次旧失败 + 4 次新失败 = 6 次，第 5 次错凭证应 429；清零后第 5 次仍为 401。
  for (let i = 0; i < 4; i++) { const cid = t.mkCaptcha('AB12'); await t.call('POST', '/api/orders/' + o2.order_no + '/lookup', { credential: 'wrong', captcha_id: cid, captcha_code: 'AB12' }); }
  const cid5 = t.mkCaptcha('AB12');
  r = await t.call('POST', '/api/orders/' + o2.order_no + '/lookup', { credential: 'wrong', captcha_id: cid5, captcha_code: 'AB12' });
  check('B-P1-6: 5th failure after a success still 401 (bucket was cleared)', r.status === 401, JSON.stringify(r.json));
}
{
  // B-P2-5：/secret 认证前失败统一 401 + “查询密码错误”；B-P2-6：成功后清零按单记数。
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-B25-手动商品');
  // 空密码 → 401 通用文案。
  const oSalted = t.insertOrder({ product_id: pM.id, query_password_hash: 'x', query_password_salt: 'y' });
  let r = await t.call('POST', '/api/orders/' + oSalted.order_no + '/secret', { password: '' });
  check('B-P2-5: /secret empty password -> 401 generic', r.status === 401 && r.json && r.json.error === '查询密码错误', JSON.stringify(r.json));
  // 旧系统凭证订单 → 401 通用文案（不再 410 泄露）。
  const oToken = t.insertOrder({ product_id: pM.id, query_token_hash: 'abc' });
  r = await t.call('POST', '/api/orders/' + oToken.order_no + '/secret', { password: 'anything' });
  check('B-P2-5: /secret token order -> 401 generic', r.status === 401 && r.json && r.json.error === '查询密码错误', JSON.stringify(r.json));
  // legacy 无 salted 密码订单 → 401 通用文案（不再 403 泄露）。
  const oLegacy = t.insertOrder({ product_id: pM.id });
  r = await t.call('POST', '/api/orders/' + oLegacy.order_no + '/secret', { password: 'anything' });
  check('B-P2-5: /secret legacy order -> 401 generic', r.status === 401 && r.json && r.json.error === '查询密码错误', JSON.stringify(r.json));
  // /query 不返回 credential_type。
  const q = await t.call('POST', '/api/orders/query', { keywords: oSalted.order_no, captcha_id: t.mkCaptcha('AB12'), captcha_code: 'AB12' });
  check('B-P2-5: /query items carry no credential_type', q.json && Array.isArray(q.json.orders) && q.json.orders.every((o) => !('credential_type' in o)), JSON.stringify(q.json));
  // B-P2-6：真实 salted 订单（经下单接口建）5 错 → 第 6 次正确 → 429；成功清零后 4 错 + 正确仍不 429。
  let rr = await t.orderCall({ product_id: pM.id, quantity: 1, query_password: 'mypw1234' });
  const oReal = t.q('SELECT * FROM orders WHERE order_no=?', rr.json.order.order_no);
  // 2026-10-30 新口径（双维限流）：触顶须同单同 IP，故固定同一 IP（harness 默认轮换 IP）。
  for (let i = 0; i < 5; i++) await t.call('POST', '/api/orders/' + oReal.order_no + '/secret', { password: 'wrongpw' }, undefined, { 'CF-Connecting-IP': '10.88.6.7' });
  r = await t.call('POST', '/api/orders/' + oReal.order_no + '/secret', { password: 'mypw1234' }, undefined, { 'CF-Connecting-IP': '10.88.6.7' });
  check('B-P2-6: 6th attempt after 5 failures -> 429', r.status === 429, JSON.stringify(r.json));
  rr = await t.orderCall({ product_id: pM.id, quantity: 1, query_password: 'mypw1234' });
  const oReal2 = t.q('SELECT * FROM orders WHERE order_no=?', rr.json.order.order_no);
  for (let i = 0; i < 2; i++) await t.call('POST', '/api/orders/' + oReal2.order_no + '/secret', { password: 'wrongpw' });
  r = await t.call('POST', '/api/orders/' + oReal2.order_no + '/secret', { password: 'mypw1234' });
  check('B-P2-6: success after 2 failures clears bucket (not 429)', r.status !== 429, JSON.stringify(r.json));
  check('B-P2-6: secret_attempts cleared on success', t.qa('SELECT * FROM secret_attempts WHERE order_no=?', oReal2.order_no).length === 0);
  for (let i = 0; i < 4; i++) await t.call('POST', '/api/orders/' + oReal2.order_no + '/secret', { password: 'wrongpw' });
  r = await t.call('POST', '/api/orders/' + oReal2.order_no + '/secret', { password: 'mypw1234' });
  check('B-P2-6: 4 failures after a success do not lock out', r.status !== 429, JSON.stringify(r.json));
}
{
  // B-P2-7：stats.card_stock 排除已预留卡密（与 cardStockMap 同口径）。
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  await t.call('POST', '/api/admin/products', { title: '确定性-B27-卡密商品', category: 'account', stock_type: 'card', sell_price: 4, source: 'self' }, cookie);
  const pC = t.q("SELECT * FROM products WHERE title='确定性-B27-卡密商品'");
  t.db.prepare('INSERT INTO cards (product_id, code, is_used, is_disabled, order_id, reserved_order_id, reserved_at, created_at) VALUES (?, ?, 0, 0, NULL, NULL, NULL, ?), (?, ?, 0, 0, NULL, NULL, NULL, ?)').run(pC.id, 'B27-CARD-1', nowStr(), pC.id, 'B27-CARD-2', nowStr());
  const oRes = t.insertOrder({ product_id: pC.id });
  t.db.prepare('UPDATE cards SET reserved_order_id=? WHERE code=?').run(oRes.id, 'B27-CARD-1');
  const st = await t.call('GET', '/api/admin/stats', undefined, cookie);
  const expectedStock = t.q('SELECT COUNT(*) AS c FROM cards WHERE is_used=0 AND is_disabled=0 AND reserved_order_id IS NULL').c;
  const withReserved = t.q('SELECT COUNT(*) AS c FROM cards WHERE is_used=0 AND is_disabled=0').c;
  check('B-P2-7: stats card_stock excludes reserved', st.json && st.json.stats && st.json.stats.card_stock === expectedStock && withReserved === expectedStock + 1, JSON.stringify(st.json));
}
{
  // B-P2-8：人工确认必须显式 manual_confirm === true；B-P2-10：商品/卡密条件写；B-P3-6：取消释放预留卡。
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-B28-手动商品');
  let r = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  t.db.prepare('UPDATE orders SET pending_tx_hash=? WHERE id=?').run('f1'.repeat(32), ord.id);
  r = await t.call('POST', '/api/admin/orders/' + ord.id + '/confirm-payment', { reason: 'B28 无 manual_confirm' }, cookie);
  check('B-P2-8: confirm without manual_confirm -> 400', r.status === 400, JSON.stringify(r.json));
  r = await t.call('POST', '/api/admin/orders/' + ord.id + '/confirm-payment', { reason: 'B28 显式 false', manual_confirm: false }, cookie);
  check('B-P2-8: confirm with manual_confirm false -> 400', r.status === 400, JSON.stringify(r.json));
  r = await t.call('POST', '/api/admin/orders/' + ord.id + '/confirm-payment', { reason: 'B28 显式 true', manual_confirm: true }, cookie);
  check('B-P2-8: confirm with manual_confirm true -> ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  // B-P2-10：有订单的商品删不掉；已预留卡删不掉/禁不掉；禁用幂等。
  r = await t.call('DELETE', '/api/admin/products/' + pM.id, undefined, cookie);
  check('B-P2-10: product with orders cannot be deleted (409)', r.status === 409, JSON.stringify(r.json));
  await t.call('POST', '/api/admin/products', { title: '确定性-B210-卡密商品', category: 'account', stock_type: 'card', sell_price: 4, source: 'self' }, cookie);
  const pC = t.q("SELECT * FROM products WHERE title='确定性-B210-卡密商品'");
  t.db.prepare('INSERT INTO cards (product_id, code, is_used, is_disabled, order_id, reserved_order_id, reserved_at, created_at) VALUES (?, ?, 0, 0, NULL, NULL, NULL, ?), (?, ?, 0, 0, NULL, NULL, NULL, ?)').run(pC.id, 'B210-CARD-1', nowStr(), pC.id, 'B210-CARD-2', nowStr());
  const cardRes = t.q('SELECT * FROM cards WHERE code=?', 'B210-CARD-1');
  const cardFree = t.q('SELECT * FROM cards WHERE code=?', 'B210-CARD-2');
  const oRes2 = t.insertOrder({ product_id: pC.id });
  t.db.prepare('UPDATE cards SET reserved_order_id=? WHERE id=?').run(oRes2.id, cardRes.id);
  r = await t.call('DELETE', '/api/admin/cards/' + cardRes.id, undefined, cookie);
  check('B-P2-10: reserved card cannot be deleted', r.json && !r.json.ok && (r.status === 400 || r.status === 409), JSON.stringify(r.json));
  r = await t.call('POST', '/api/admin/cards/' + cardRes.id + '/disable', { disabled: true }, cookie);
  check('B-P2-10: reserved card cannot be disabled', r.json && !r.json.ok, JSON.stringify(r.json));
  r = await t.call('POST', '/api/admin/cards/' + cardFree.id + '/disable', { disabled: true }, cookie);
  check('B-P2-10: disable free card ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  r = await t.call('POST', '/api/admin/cards/' + cardFree.id + '/disable', { disabled: true }, cookie);
  check('B-P2-10: disable already-disabled card idempotent ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  r = await t.call('DELETE', '/api/admin/cards/' + cardFree.id, undefined, cookie);
  check('B-P2-10: disabled-but-free card can be deleted', r.json && r.json.ok === true, JSON.stringify(r.json));
  // B-P3-6：管理员取消订单 → 预留卡直接释放（不再恢复为 reserved）。
  r = await t.call('POST', '/api/admin/orders/' + oRes2.id + '/cancel', { reason: 'B36 取消释放' }, cookie);
  check('B-P3-6: admin cancel ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('B-P3-6: cancelled order releases reserved card', t.q('SELECT reserved_order_id FROM cards WHERE id=?', cardRes.id).reserved_order_id === null);
}
{
  // B-P3-3：验证码 attempts 条件递增（3 次上限：2 错后正确仍过，3 错后正确亦被拒）；B-P2-9：限流 DB 故障 fail-closed。
  resetMock();
  const t = setup(); t.initBase();
  const cookie = await t.adminLogin();
  const pM = await manualProduct(t, cookie, '确定性-B33-手动商品');
  const capId = t.mkCaptcha('AB12');
  let r = await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1 }, capId, 'XXXX');
  check('B-P3-3: captcha wrong attempt 1 rejected', r.json && !r.json.ok, JSON.stringify(r.json));
  r = await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1 }, capId, 'YYYY');
  check('B-P3-3: captcha wrong attempt 2 rejected', r.json && !r.json.ok, JSON.stringify(r.json));
  r = await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1 }, capId, 'AB12');
  check('B-P3-3: correct captcha after 2 failures still verifies', r.json && r.json.ok === true, JSON.stringify(r.json));
  const capId2 = t.mkCaptcha('CD34');
  for (let i = 0; i < 3; i++) await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1 }, capId2, 'XXXX');
  r = await t.orderCallWithCaptcha({ product_id: pM.id, quantity: 1 }, capId2, 'CD34');
  check('B-P3-3: correct captcha after 3 failures rejected (max attempts)', r.json && !r.json.ok, JSON.stringify(r.json));
  // B-P2-9：pay_rate 查询抛错 → /pay 429 fail-closed（不放行）。
  let rr = await t.orderCall({ product_id: pM.id, quantity: 1 });
  const ord = t.q('SELECT * FROM orders WHERE order_no=?', rr.json.order.order_no);
  const origPrepare = t.env.DB.prepare.bind(t.env.DB);
  t.env.DB.prepare = (sql) => {
    const st = origPrepare(sql);
    if (String(sql).indexOf('pay_rate') !== -1) {
      st.first = async () => { throw new Error('injected pay_rate failure (B-P2-9)'); };
      st.all = async () => { throw new Error('injected pay_rate failure (B-P2-9)'); };
      st.run = async () => { throw new Error('injected pay_rate failure (B-P2-9)'); };
    }
    return st;
  };
  const capId3 = t.mkCaptcha('AB12');
  r = await t.call('POST', '/api/orders/' + ord.order_no + '/pay', { txid: 'ff'.repeat(32), captcha_id: capId3, captcha_code: 'AB12' });
  t.env.DB.prepare = origPrepare;
  check('B-P2-9: /pay rate-limit DB failure -> 429 fail-closed', r.status === 429, JSON.stringify(r.json));
}
{
  // B-P0：建站令牌 gating——未配置 503、错令牌 401、正确令牌登录 + 强制改密、已有密码后密码登录不变；B-P3-5：登录成功清零全局窗口计数。
  resetMock();
  const t = setup(); t.initBase();
  // 未配置令牌 → 503。
  const savedToken = t.env.ZHIXUAN_SETUP_TOKEN;
  delete t.env.ZHIXUAN_SETUP_TOKEN;
  let r = await t.call('POST', '/api/admin/login', { setup_token: 'anything' });
  check('B-P0: no setup token configured -> 503 fail-closed', r.status === 503, JSON.stringify(r.json));
  t.env.ZHIXUAN_SETUP_TOKEN = savedToken;
  r = await t.call('POST', '/api/admin/login', { setup_token: 'wrong-token' });
  check('B-P0: wrong setup token -> 401', r.status === 401, JSON.stringify(r.json));
  r = await t.call('POST', '/api/admin/login', { password: 'admin' });
  check('B-P0: public default password no longer accepted', r.status === 401, JSON.stringify(r.json));
  // 全局窗口计数预置 5，成功登录后清零。
  t.db.prepare("INSERT OR REPLACE INTO admin_meta (key, value) VALUES ('login_global_fail_count', '5'), ('login_global_fail_window', ?)").run(String(Date.now()));
  r = await t.call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
  const c0 = r.headers.get('set-cookie') || '';
  check('B-P0: correct setup token -> login + must change', r.json && r.json.ok === true && r.json.must_change_password === true, JSON.stringify(r.json));
  check('B-P3-5: login success clears global window count', t.q("SELECT value FROM admin_meta WHERE key='login_global_fail_count'").value === '0');
  // 建站令牌会话下改密：旧密码留空即可。
  r = await t.call('POST', '/api/admin/change-password', { old_password: '', new_password: 'bpo-new-pass-123' }, c0);
  check('B-P0: change-password with setup-token session (empty old pw) ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  // 已有密码后：密码登录成功；建站令牌不再是登录凭证。
  r = await t.call('POST', '/api/admin/login', { password: 'bpo-new-pass-123' });
  check('B-P0: password login after hash set ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  r = await t.call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
  check('B-P0: setup token ignored once password hash exists', r.json && !r.json.ok, JSON.stringify(r.json));
}

console.log('\n==== txid-race-deterministic: ' + pass + ' passed, ' + fail + ' failed ====');
if (failures.length) console.log('FAILURES:', failures.join(', '));
process.exitCode = fail ? 1 : 0;
