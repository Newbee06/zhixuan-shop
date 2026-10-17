// 审查修复补齐测试（CODE_REVIEW_2026-10-17 第五轮补齐：P0/P1/P2/P3 各修复至少一个对应测试）
// 规则：只测新行为；不访问真实上游/链上（全部 mock）；失败即报告代码 bug，不改 src/ 迁就。
// 注：本文件暂未接入 CI（ci.yml 按任务要求不碰），协调员接入前请把本文件加入 ci.yml 回归任务。
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

// ---------- 共享 mock 状态 ----------
const ps = { creates: 0, gets: 0, createFn: null, getFn: null };
const evm = { latest: 10000, logs: [], receipt: null, truncate: false };
const XLAYER_USDT0 = '0x779ded0c9e1022225f8e0630b35a9b54bE713736';
const BEP20_USDT = '0x55d398326f99059fF775485246999027B3197955'; // 与 worker DEFAULT_USDT_CONTRACTS 一致（Binance-Peg USDT）
const TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function padTopic(addr) { return '0x' + '0'.repeat(24) + addr.replace(/^0x/, '').toLowerCase(); }
function amountToRaw(amount, decimals) { // 与 worker.amountToRaw 一致：字符串精确换算（float 会丢精度，导致日志金额对不上）
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
function toHex(n) { return '0x' + BigInt(n).toString(16); }

async function mockFetch(url, opts = {}) {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('prodseller.com/v1/orders')) {
    if (method === 'POST') {
      ps.creates++;
      let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch {}
      if (ps.createFn) return ps.createFn(body);
      return { ok: true, status: 200, json: async () => ({ id: 'PS-DEFAULT-1', status: 'paid' }), text: async () => JSON.stringify({ id: 'PS-DEFAULT-1', status: 'paid' }) };
    }
    ps.gets++;
    const id = decodeURIComponent(u.split('/v1/orders/')[1] || '');
    if (ps.getFn) return ps.getFn(id);
    return { ok: true, status: 200, json: async () => ({ id, status: 'delivered', deliveredKey: 'PS-KEY-DEFAULT' }), text: async () => JSON.stringify({ id, status: 'delivered', deliveredKey: 'PS-KEY-DEFAULT' }) };
  }
  if (u.includes('mock-xlayer') || u.includes('mock-bsc')) {
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch {}
    const rpc = body.params || [];
    if (body.method === 'eth_call') {
      const data = String(rpc[0]?.data || '');
      const dec = data.startsWith('0x313ce567') ? (u.includes('mock-xlayer') ? 6 : 18) : 18;
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x' + dec.toString(16).padStart(64, '0') }), text: async () => '' };
    }
    if (body.method === 'eth_blockNumber') return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: toHex(evm.latest) }), text: async () => '' };
    if (body.method === 'eth_getLogs') {
      if (evm.truncate) {
        const dummies = Array.from({ length: 10000 }, (_, i) => ({ address: '0x0000000000000000000000000000000000000000', blockNumber: toHex(9900), transactionHash: '0x' + '0'.repeat(64), logIndex: toHex(i), topics: [TOPIC0], data: '0x0' }));
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: dummies }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: evm.logs }), text: async () => '' };
    }
    if (body.method === 'eth_getTransactionReceipt') {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: evm.receipt }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: null }), text: async () => '' };
  }
  if (u.includes('resend')) return { ok: true, status: 200, json: async () => ({ id: 'mock-email' }), text: async () => '{"id":"mock-email"}' };
  throw new Error('Unexpected fetch in review-fixes test: ' + u);
}
globalThis.fetch = mockFetch;

// ---------- 构造一个可测试 env（可复用：P3-20/P3-30/P2-7 用独立库） ----------
function makeEnv() {
  const db = new DatabaseSync(':memory:');
  // schema.sql 自 v15 起不再建 schema_migrations 表（仅 INSERT 预置版本），与 Worker runMigrations 一致：先建表再执行 schema.sql。
  // 注意：schema.sql 缺 CREATE TABLE schema_migrations 是代码侧缺陷（已在最终汇报中精确报告），测试侧按运行时行为先建表，不改 schema.sql。
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))" );
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
    PRODSELLER_API_KEY: 'test-key', RESEND_API_KEY: 'test-resend',
    __fetch: mockFetch,
  };
  let html = frontendHtml;
  let code = workerCode.replace(/import\s+FRONTEND_HTML\s+from\s+['"][^'"]+['"];?/, 'const FRONTEND_HTML = ' + JSON.stringify(html) + ';');
  code = code.replace(/export\s+default\s*\{/, 'globalThis.__W = {');
  const fn = new Function(code + '\nreturn globalThis.__W;');
  const worker = fn();
  return { db, env, worker };
}

const { db, env, worker } = makeEnv();
const q = (sql, ...p) => db.prepare(sql).get(...p);
const qa = (sql, ...p) => db.prepare(sql).all(...p);

let ipSeq = 0;
function nextIp() { ipSeq++; return '10.77.' + Math.floor(ipSeq / 250) + '.' + (ipSeq % 250 + 1); }
function makeCtx() { const jobs = []; return { waitUntil(p) { jobs.push(p); }, async drain() { await Promise.allSettled(jobs); }, passThroughOnException() {} }; }
async function call(method, p, body, cookie, extra) {
  const ctx = makeCtx();
  const headers = { 'content-type': 'application/json', 'X-Admin-API': '1' };
  if (cookie) headers['Cookie'] = cookie;
  if (!extra || !extra['CF-Connecting-IP']) headers['CF-Connecting-IP'] = nextIp();
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
async function adminLogin() {
  const r = await call('POST', '/api/admin/login', { password: 'admin123' });
  if (r.json && r.json.ok) return r.headers.get('set-cookie') || '';
  return '';
}
async function orderCall(body, ip) {
  const cid = mkCaptcha('AB12');
  const contact0 = (body && body.contact) || freshContact();
  const cf = { contact_email: contact0, delivery_email: contact0, account_email: contact0, ...((body && body.customer_fields) || {}) };
  return call('POST', '/api/orders', { query_password: 'rf-test-pw', captcha_id: cid, captcha_code: 'AB12', ...body, customer_fields: cf, contact: contact0 }, null, ip ? { 'CF-Connecting-IP': ip } : undefined);
}
async function payCall(orderNo, txid, ip) {
  const cid = mkCaptcha('AB12');
  return call('POST', '/api/orders/' + orderNo + '/pay', { txid, captcha_id: cid, captcha_code: 'AB12' }, null, ip ? { 'CF-Connecting-IP': ip } : undefined);
}
function setSetting(key, value) { db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value); }
function setGate(v) { setSetting('prodseller_enabled', String(v)); }
let contactSeq = 0;
function freshContact() { contactSeq++; return 'rf-' + contactSeq + '-' + Date.now() + '@test.example'; }
let insertSeq = 0;
function insertOrder(fields) {
  insertSeq++;
  // SQL 表达式（如 datetime('now','-10 minutes')）不能当参数值存：此处在 JS 里算成 UTC 时间字符串再入库。
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
  const cols = ['order_no', 'query_password', 'query_token_hash', 'query_password_hash', 'query_password_salt', 'product_id', 'product_snapshot', 'quantity', 'price_usdt', 'total_usdt', 'actual_amount', 'pay_address', 'expires_at', 'customer_fields', 'contact', 'pay_method', 'pay_chain', 'wallet_address', 'status', 'claim_token', 'claimed_at', 'paid_at', 'delivery_content', 'exception_reason', 'admin_note', 'tx_hash', 'upstream_lock', 'upstream_lock_expires_at', 'data_expired', 'fulfilled_at', 'refund_ref', 'refund_status', 'txid'];
  const base = { order_no: 'AISRF' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(), query_password: '', query_token_hash: '', query_password_hash: '', query_password_salt: '', product_id: 1, product_snapshot: '{}', quantity: 1, price_usdt: 10, total_usdt: 10, actual_amount: 10, pay_address: '0x' + String(insertSeq).padStart(40, '0'), expires_at: "datetime('now','+30 minutes')", customer_fields: '{}', contact: freshContact(), pay_method: 'Binance', pay_chain: 'BEP20', wallet_address: '', status: 'pending_payment', claim_token: '', claimed_at: null, paid_at: null, delivery_content: '', exception_reason: '', admin_note: '', tx_hash: '', upstream_lock: '', upstream_lock_expires_at: null, data_expired: 0, fulfilled_at: null, refund_ref: '', refund_status: '', txid: '' };
  const merged = { ...base, ...fields };
  for (const k of ['expires_at', 'claimed_at', 'paid_at', 'fulfilled_at', 'upstream_lock_expires_at']) merged[k] = evalSqlTime(merged[k]);
  const placeholders = cols.map(() => '?').join(',');
  const vals = cols.map((c) => merged[c]);
  const info = db.prepare('INSERT INTO orders (' + cols.join(',') + ') VALUES (' + placeholders + ')').run(...vals);
  return db.prepare('SELECT * FROM orders WHERE id=?').get(Number(info.lastInsertRowid));
}
function evmReceiptFor(order, txHash, blockNumber) {
  const decimals = order.pay_chain === 'X Layer' ? 6 : 18;
  return { blockHash: '0x' + '1'.repeat(64), blockNumber: toHex(blockNumber), from: '0x' + '2'.repeat(40), to: order.pay_address, transactionHash: txHash, status: '0x1', logs: [{ address: order.pay_chain === 'X Layer' ? XLAYER_USDT0 : BEP20_USDT, topics: [TOPIC0, padTopic('0x' + '2'.repeat(40)), padTopic(order.pay_address)], data: amountToRaw(order.actual_amount, decimals), blockNumber: toHex(blockNumber), transactionHash: txHash, logIndex: '0x0' }] };
}
function evmLogFor(order, txHash, blockNumber, logIndex = '0x0') {
  const decimals = order.pay_chain === 'X Layer' ? 6 : 18;
  return { address: order.pay_chain === 'X Layer' ? XLAYER_USDT0 : BEP20_USDT, topics: [TOPIC0, padTopic('0x' + '2'.repeat(40)), padTopic(order.pay_address)], data: amountToRaw(order.actual_amount, decimals), blockNumber: toHex(blockNumber), transactionHash: txHash, logIndex };
}

// ---------- 初始化：管理员 + 基础配置 ----------
setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': '0x1111111111111111111111111111111111111111', 'Binance|BEP20': '0x2222222222222222222222222222222222222222' }));
setSetting('rpc_urls', JSON.stringify({ 'X Layer': ['https://mock-xlayer'], 'BEP20': ['https://mock-bsc'] }));
setSetting('prodseller_enabled', '0');
let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
check('init: default admin login', r.json && r.json.ok === true, JSON.stringify(r.json));
let cookie = r.headers.get('set-cookie') || '';
r = await call('POST', '/api/admin/change-password', { old_password: '', new_password: 'admin123' }, cookie);
check('init: change password', r.json && r.json.ok === true, JSON.stringify(r.json));

// ================= P1 =================
// P1-1：门禁关闭时不发起真实采购（订单确认 + 轮询 + 管理员重试三路均经 prodsellerCreateOrder 入口）。
{
  setGate(1);
  r = await call('POST', '/api/admin/products', { title: '上游商品-P1-1', category: 'recharge', stock_type: 'manual', sell_price: 10, source: 'prodseller', prodseller_id: 'PS-GATE-1' }, cookie);
  const pUp = q("SELECT * FROM products WHERE title='上游商品-P1-1'");
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  check('P1-1: upstream order created with gate open', r.json && r.json.ok === true, JSON.stringify(r.json));
  const o1 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  setGate(0); // 确认前关闭门禁
  ps.creates = 0;
  r = await call('POST', '/api/admin/orders/' + o1.id + '/confirm-payment', { reason: '门禁关闭时确认' , manual_confirm: true }, cookie);
  check('P1-1: confirm with gate closed -> pending_upstream, no upstream call', r.json && r.json.ok === true && q('SELECT status FROM orders WHERE id=?', o1.id).status === 'pending_upstream' && ps.creates === 0, JSON.stringify(r.json) + ' creates=' + ps.creates);
  // 轮询时门禁仍关闭 → 不创建
  const ctx = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx); await ctx.drain();
  check('P1-1: poll with gate closed does not create', ps.creates === 0, 'creates=' + ps.creates);
  // 管理员重试时门禁仍关闭 → 不创建
  r = await call('POST', '/api/admin/upstream/orders/' + o1.id + '/retry', {}, cookie);
  check('P1-1: admin retry with gate closed does not create', r.json && r.json.ok === true && ps.creates === 0, JSON.stringify(r.json) + ' creates=' + ps.creates);
  setGate(1);
}

// P1-2（v17 语义变更）：人工确认通道写 txid_claims 全局认领（source=manual_confirmed，与链上共享同一全局原子认领）+ payments manual_confirmed 行 + 审计 manual_confirm_payment + admin_note【人工确认收款】前缀。
// 旧断言“人工确认绝不写 txid_claims”已被 P1-2 根治要求取代（人工与链上必须共享同一全局原子消费机制，否则两路径间仍有 TOCTOU 窗口）；
// manual_confirmed 仅表示人工确认，不构成链上证据，不伪造回执/区块高度/确认数。
{
  const tx = 'a'.repeat(64);
  r = await call('POST', '/api/admin/products', { title: '手动商品-P1-2', category: 'recharge', stock_type: 'manual', sell_price: 4, source: 'self' }, cookie);
  const pM = q("SELECT * FROM products WHERE title='手动商品-P1-2'");
  r = await orderCall({ product_id: pM.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, o.id);
  r = await call('POST', '/api/admin/orders/' + o.id + '/confirm-payment', { reason: 'P1-2' , manual_confirm: true }, cookie);
  check('P1-2: admin manual confirm succeeds (manual channel)', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('P1-2: manual confirm writes shared txid_claims (source=manual_confirmed)', (() => { const row = q('SELECT * FROM txid_claims WHERE tx_hash=?', tx); return row && Number(row.order_id) === Number(o.id) && row.source === 'manual_confirmed' && !!row.claim_token; })());
  check('P1-2: manual confirm writes manual_confirmed ledger row', (() => { const p = q("SELECT * FROM payments WHERE tx_hash=? AND status='manual_confirmed'", tx); return p && Number(p.order_id) === Number(o.id); })());
  check('P1-2: manual confirm audit action = manual_confirm_payment', !!q("SELECT * FROM admin_audit WHERE order_id=? AND action='manual_confirm_payment'", o.id));
  check('P1-2: manual confirm admin_note has 【人工确认收款】 prefix', (q('SELECT admin_note FROM orders WHERE id=?', o.id).admin_note || '').includes('【人工确认收款】'));
  // 同一 TXID 第二单确认 → 认领冲突，拒绝
  r = await orderCall({ product_id: pM.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o2 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(tx, o2.id);
  r = await call('POST', '/api/admin/orders/' + o2.id + '/confirm-payment', { reason: 'P1-2 第二单' , manual_confirm: true }, cookie);
  check('P1-2: second confirm with same txid rejected', r.json && !r.json.ok && /已用于其他订单/.test(r.json.error || ''), JSON.stringify(r.json));
}

// P1-3：陈旧认领（claimed_at > 5 分钟）可取消；未过期认领 / NULL claimed_at 仍不可取消。
{
  // 管理员取消：陈旧认领 OK
  const oStale = insertOrder({ paid_at: "datetime('now')", claim_token: 'STALE-1', claimed_at: "datetime('now','-10 minutes')", status: 'pending_payment' });
  r = await call('POST', '/api/admin/orders/' + oStale.id + '/cancel', { reason: 'P1-3 陈旧认领取消' }, cookie);
  check('P1-3: admin cancel stale claim (10 min) OK', r.json && r.json.ok === true && q('SELECT status FROM orders WHERE id=?', oStale.id).status === 'cancelled', JSON.stringify(r.json));
  // 管理员取消：新鲜认领 409
  const oFresh = insertOrder({ paid_at: "datetime('now')", claim_token: 'FRESH-1', claimed_at: "datetime('now')", status: 'pending_payment' });
  r = await call('POST', '/api/admin/orders/' + oFresh.id + '/cancel', { reason: 'P1-3 新鲜认领不应取消' }, cookie);
  check('P1-3: admin cancel fresh claim -> 409', r.status === 409 && r.json && !r.json.ok, JSON.stringify(r.json));
  // 管理员取消：claimed_at NULL 按原逻辑（有 paid_at + claim_token → 409）
  const oNull = insertOrder({ paid_at: "datetime('now')", claim_token: 'NULL-1', claimed_at: null, status: 'pending_payment' });
  r = await call('POST', '/api/admin/orders/' + oNull.id + '/cancel', { reason: 'P1-3 NULL claimed_at' }, cookie);
  check('P1-3: admin cancel NULL claimed_at -> 409 (original logic)', r.status === 409 && r.json && !r.json.ok, JSON.stringify(r.json));
  // 超时自动取消：陈旧认领 + 已过期 → 轮询取消；新鲜认领 + 已过期 → 轮询不取消
  const oAutoStale = insertOrder({ paid_at: "datetime('now')", claim_token: 'STALE-AUTO', claimed_at: "datetime('now','-10 minutes')", status: 'pending_payment', expires_at: "datetime('now','-1 minutes')" });
  const oAutoFresh = insertOrder({ paid_at: "datetime('now')", claim_token: 'FRESH-AUTO', claimed_at: "datetime('now')", status: 'pending_payment', expires_at: "datetime('now','-1 minutes')" });
  const ctx = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx); await ctx.drain();
  check('P1-3: timeout auto-cancel stale claim', q('SELECT status FROM orders WHERE id=?', oAutoStale.id).status === 'cancelled');
  check('P1-3: timeout does NOT cancel fresh claim', q('SELECT status FROM orders WHERE id=?', oAutoFresh.id).status === 'pending_payment');
}

// P1-4：上游终态失败 → refund_pending + 记上游单号与状态 + 审计（cancelled / failed 两态）。
for (const termStatus of ['cancelled', 'failed']) {
  const pUp = q("SELECT * FROM products WHERE title='上游商品-P1-1'");
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  ps.createFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-TERM-' + termStatus, status: 'paid' }), text: async () => JSON.stringify({ id: 'PS-TERM-' + termStatus, status: 'paid' }) });
  r = await call('POST', '/api/admin/orders/' + o.id + '/confirm-payment', { reason: 'P1-4 setup' , manual_confirm: true }, cookie);
  check('P1-4(' + termStatus + '): setup pending_activation', r.json && r.json.ok === true && q('SELECT status FROM orders WHERE id=?', o.id).status === 'pending_activation', JSON.stringify(r.json));
  ps.getFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-TERM-' + termStatus, status: termStatus }), text: async () => JSON.stringify({ id: 'PS-TERM-' + termStatus, status: termStatus }) });
  const ctx = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx); await ctx.drain();
  const after = q('SELECT * FROM orders WHERE id=?', o.id);
  check('P1-4(' + termStatus + '): terminal -> refund_pending', after.status === 'refund_pending', 'status=' + after.status);
  check('P1-4(' + termStatus + '): admin_note + exception record psId & status', (after.admin_note + after.exception_reason).includes('PS-TERM-' + termStatus) && (after.admin_note + after.exception_reason).includes(termStatus), 'note=' + after.admin_note + ' exc=' + after.exception_reason);
  check('P1-4(' + termStatus + '): audit upstream_terminal_failure', !!q("SELECT * FROM admin_audit WHERE order_id=? AND action='upstream_terminal_failure'", o.id));
  ps.createFn = null; ps.getFn = null;
}

// P1-5：upstream_voided 旗标（有上游单号时发货/退款确认须传 true，否则 409；异常记录上游单号）。
{
  const pUp = q("SELECT * FROM products WHERE title='上游商品-P1-1'");
  // 发货旗标：pending_activation + 有 psId
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const oF = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  ps.createFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-VOID-FULFILL', status: 'paid' }), text: async () => JSON.stringify({ id: 'PS-VOID-FULFILL', status: 'paid' }) });
  await call('POST', '/api/admin/orders/' + oF.id + '/confirm-payment', { reason: 'P1-5 setup' , manual_confirm: true }, cookie);
  ps.createFn = null;
  r = await call('POST', '/api/admin/orders/' + oF.id + '/fulfill', { delivery_content: 'VOID-TEST' }, cookie);
  check('P1-5: fulfill with psId, no flag -> 409', r.status === 409 && /作废/.test(r.json && r.json.error || ''), JSON.stringify(r.json));
  r = await call('POST', '/api/admin/orders/' + oF.id + '/fulfill', { delivery_content: 'VOID-TEST', upstream_voided: true }, cookie);
  check('P1-5: fulfill with psId + flag -> completed', r.json && r.json.ok === true && q('SELECT status FROM orders WHERE id=?', oF.id).status === 'completed', JSON.stringify(r.json));
  // 退款确认旗标：pending_activation → 异常 → refund_pending，再退款确认
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const oR = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  ps.createFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-VOID-REFUND', status: 'paid' }), text: async () => JSON.stringify({ id: 'PS-VOID-REFUND', status: 'paid' }) });
  await call('POST', '/api/admin/orders/' + oR.id + '/confirm-payment', { reason: 'P1-5 refund setup' , manual_confirm: true }, cookie);
  ps.createFn = null;
  r = await call('POST', '/api/admin/orders/' + oR.id + '/exception', { reason: '客户要求退款', refund_needed: true }, cookie);
  check('P1-5: exception refund_needed -> refund_pending', r.json && r.json.ok === true && q('SELECT status FROM orders WHERE id=?', oR.id).status === 'refund_pending', JSON.stringify(r.json));
  check('P1-5: exception records psId in admin_note', (q('SELECT admin_note FROM orders WHERE id=?', oR.id).admin_note || '').includes('PS-VOID-REFUND'), q('SELECT admin_note FROM orders WHERE id=?', oR.id).admin_note);
  r = await call('POST', '/api/admin/orders/' + oR.id + '/refund-confirm', { refund_ref: 'REF-VOID-1' }, cookie);
  check('P1-5: refund-confirm with psId, no flag -> 409', r.status === 409 && /作废/.test(r.json && r.json.error || ''), JSON.stringify(r.json));
  r = await call('POST', '/api/admin/orders/' + oR.id + '/refund-confirm', { refund_ref: 'REF-VOID-1', upstream_voided: true }, cookie);
  check('P1-5: refund-confirm with psId + flag -> cancelled', r.json && r.json.ok === true && q('SELECT status FROM orders WHERE id=?', oR.id).status === 'cancelled', JSON.stringify(r.json));
  // 无上游单号：发货不要求旗标（security-test 覆盖退款路径，此处覆盖发货路径）
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const oN = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  ps.createFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-VOID-NONE', status: 'delivered', deliveredKey: 'PS-KEY-NONE' }), text: async () => JSON.stringify({ id: 'PS-VOID-NONE', status: 'delivered', deliveredKey: 'PS-KEY-NONE' }) });
  await call('POST', '/api/admin/orders/' + oN.id + '/confirm-payment', { reason: 'P1-5 no-psid setup' , manual_confirm: true }, cookie);
  ps.createFn = null;
  check('P1-5: delivered upstream order completed (no flag needed)', q('SELECT status FROM orders WHERE id=?', oN.id).status === 'completed');
}

// P1-6：补偿只还确切 id；手动发货 delivery 非空时处理 is_used=1 残留卡。
{
  r = await call('POST', '/api/admin/products', { title: '手动商品-P1-6', category: 'recharge', stock_type: 'manual', sell_price: 5, source: 'self' }, cookie);
  const pM = q("SELECT * FROM products WHERE title='手动商品-P1-6'");
  r = await orderCall({ product_id: pM.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  await call('POST', '/api/admin/orders/' + o.id + '/confirm-payment', { reason: 'P1-6 setup' , manual_confirm: true }, cookie);
  db.prepare('INSERT INTO cards (product_id, code, is_used, order_id) VALUES (?, ?, 1, ?)').run(pM.id, 'P16-RESIDUAL-1', o.id);
  db.prepare('INSERT INTO cards (product_id, code, is_used, order_id) VALUES (?, ?, 1, ?)').run(pM.id, 'P16-DELIVERED-1', o.id);
  r = await call('POST', '/api/admin/orders/' + o.id + '/fulfill', { delivery_content: 'P16-DELIVERED-1' }, cookie);
  check('P1-6: manual fulfill ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('P1-6: residual marked card released (is_used=0, order_id NULL)', (() => { const c = q("SELECT * FROM cards WHERE code='P16-RESIDUAL-1'"); return c.is_used === 0 && c.order_id == null; })());
  check('P1-6: delivered card stays used', (() => { const c = q("SELECT * FROM cards WHERE code='P16-DELIVERED-1'"); return c.is_used === 1 && c.order_id === o.id; })());
  check('P1-6: audit note counts released residual', (() => { const a = q("SELECT * FROM admin_audit WHERE order_id=? AND action='fulfill' ORDER BY id DESC", o.id); return a && /释放残留已标记卡 1 张/.test(a.note || ''); })());
}

// P1-7：并发手动发货仅一个成功；已完成订单不再还卡。
{
  r = await call('POST', '/api/admin/products', { title: '手动商品-P1-7', category: 'recharge', stock_type: 'manual', sell_price: 5, source: 'self' }, cookie);
  const pM = q("SELECT * FROM products WHERE title='手动商品-P1-7'");
  r = await orderCall({ product_id: pM.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  await call('POST', '/api/admin/orders/' + o.id + '/confirm-payment', { reason: 'P1-7 setup' , manual_confirm: true }, cookie);
  const [f1, f2] = await Promise.all([
    call('POST', '/api/admin/orders/' + o.id + '/fulfill', { delivery_content: 'P17-A' }, cookie),
    call('POST', '/api/admin/orders/' + o.id + '/fulfill', { delivery_content: 'P17-B' }, cookie),
  ]);
  const wins = [f1, f2].filter((x) => x.json && x.json.ok).length;
  check('P1-7: concurrent manual fulfills exactly one wins', wins === 1, 'f1=' + JSON.stringify(f1.json) + ' f2=' + JSON.stringify(f2.json));
  check('P1-7: order completed once', q('SELECT status FROM orders WHERE id=?', o.id).status === 'completed');
  r = await call('POST', '/api/admin/orders/' + o.id + '/fulfill', { delivery_content: 'P17-AGAIN' }, cookie);
  check('P1-7: fulfill on completed rejected', r.json && !r.json.ok, JSON.stringify(r.json));
  check('P1-7: delivery unchanged after rejected fulfill', q('SELECT delivery_content FROM orders WHERE id=?', o.id).delivery_content === (f1.json && f1.json.ok ? 'P17-A' : 'P17-B'));
  // unmarkCards 保护：卡密订单自动发货完成（卡 C1 已用）后，再次发货被拒，已发卡不被还回。
  r = await call('POST', '/api/admin/products', { title: '卡密商品-P1-7', category: 'card', stock_type: 'card', sell_price: 6, source: 'self' }, cookie);
  const pC = q("SELECT * FROM products WHERE title='卡密商品-P1-7'");
  db.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(pC.id, 'P17-C1');
  r = await orderCall({ product_id: pC.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const oC = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  r = await call('POST', '/api/admin/orders/' + oC.id + '/confirm-payment', { reason: 'P1-7 card setup' , manual_confirm: true }, cookie);
  check('P1-7: card order auto-completes with C1', r.json && r.json.ok === true && q('SELECT delivery_content FROM orders WHERE id=?', oC.id).delivery_content === 'P17-C1', JSON.stringify(r.json));
  r = await call('POST', '/api/admin/orders/' + oC.id + '/fulfill', { delivery_content: 'P17-AGAIN' }, cookie);
  check('P1-7: fulfill on completed card order rejected', r.json && !r.json.ok, JSON.stringify(r.json));
  check('P1-7: delivered card C1 still used after rejected fulfill (unmarkCards does not return cards of completed order)', (() => { const c = q("SELECT * FROM cards WHERE code='P17-C1'"); return c.is_used === 1 && c.order_id === oC.id; })());
}

// P1-8：自动发货成功后释放剩余预留（预留的 R1 释放，崩溃标记的 M1 被复用）。
{
  r = await call('POST', '/api/admin/products', { title: '卡密商品-P1-8', category: 'card', stock_type: 'card', sell_price: 6, source: 'self' }, cookie);
  const pC = q("SELECT * FROM products WHERE title='卡密商品-P1-8'");
  db.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?), (?, ?)').run(pC.id, 'P18-R1', pC.id, 'P18-M1');
  r = await orderCall({ product_id: pC.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const r1 = q("SELECT * FROM cards WHERE code='P18-R1'");
  check('P1-8: order reserves earliest card R1', r1.reserved_order_id === o.id, JSON.stringify(r1));
  // 模拟发货前崩溃：M1 被标记为该订单已用（未完成）
  db.prepare("UPDATE cards SET is_used=1, order_id=? WHERE code='P18-M1'").run(o.id);
  r = await call('POST', '/api/admin/orders/' + o.id + '/confirm-payment', { reason: 'P1-8' , manual_confirm: true }, cookie);
  check('P1-8: confirm completes with crash-marked M1', r.json && r.json.ok === true && q('SELECT delivery_content FROM orders WHERE id=?', o.id).delivery_content === 'P18-M1', JSON.stringify(r.json));
  check('P1-8: reserved R1 released after fulfill', (() => { const c = q("SELECT * FROM cards WHERE code='P18-R1'"); return c.reserved_order_id == null && c.is_used === 0; })());
}

// P1-9：/secret 过期返回 410（fulfilled_at > 7 天；data_expired=1）。
{
  const oOld = insertOrder({ status: 'completed', delivery_content: 'P19-CARD', fulfilled_at: "datetime('now','-8 days')", query_password_hash: sha256('oldpw-123'), query_password_salt: Buffer.from('salt-123456789012345678901234567890').toString('base64') });
  // 注：上行 hash 为 sha256 占位；真正 PBKDF2 哈希由下式覆盖
  const { pbkdf2Sync } = await import('node:crypto');
  const saltB64 = Buffer.from('salt-123456789012345678901234567890').toString('base64');
  const h = pbkdf2Sync('oldpw-123', Buffer.from(saltB64, 'base64'), 100000, 32, 'sha256').toString('base64'); // hashPassword 返回 base64
  db.prepare('UPDATE orders SET query_password_hash=?, query_password_salt=? WHERE id=?').run(h, saltB64, oOld.id);
  r = await call('POST', '/api/orders/' + oOld.order_no + '/secret', { password: 'oldpw-123' });
  check('P1-9: /secret expired (fulfilled > 7d) -> 410', r.status === 410, JSON.stringify(r.json));
  const oExp = insertOrder({ status: 'completed', delivery_content: 'P19-CARD2', data_expired: 1, query_password_hash: h, query_password_salt: saltB64 });
  r = await call('POST', '/api/orders/' + oExp.order_no + '/secret', { password: 'oldpw-123' });
  check('P1-9: /secret data_expired=1 -> 410', r.status === 410, JSON.stringify(r.json));
}

// P1-10：delivered keys 数量 >= quantity 才完成；不足 → pending_activation + admin_note 数量不足。
{
  const pUp = q("SELECT * FROM products WHERE title='上游商品-P1-1'");
  r = await orderCall({ product_id: pUp.id, quantity: 2, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const oShort = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  ps.createFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-SHORT-1', status: 'delivered', delivered_keys: ['ONLY-ONE'] }), text: async () => JSON.stringify({ id: 'PS-SHORT-1', status: 'delivered', delivered_keys: ['ONLY-ONE'] }) });
  r = await call('POST', '/api/admin/orders/' + oShort.id + '/confirm-payment', { reason: 'P1-10 数量不足' , manual_confirm: true }, cookie);
  const afterShort = q('SELECT * FROM orders WHERE id=?', oShort.id);
  check('P1-10: delivered keys < qty -> pending_activation', afterShort.status === 'pending_activation', 'status=' + afterShort.status);
  check('P1-10: admin_note mentions insufficient quantity', /数量不足/.test(afterShort.admin_note || ''), afterShort.admin_note);
  r = await orderCall({ product_id: pUp.id, quantity: 2, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const oFull = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  ps.createFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-FULL-1', status: 'delivered', delivered_keys: ['K-A', 'K-B'] }), text: async () => JSON.stringify({ id: 'PS-FULL-1', status: 'delivered', delivered_keys: ['K-A', 'K-B'] }) });
  r = await call('POST', '/api/admin/orders/' + oFull.id + '/confirm-payment', { reason: 'P1-10 数量足够' , manual_confirm: true }, cookie);
  check('P1-10: delivered keys >= qty -> completed with both keys', r.json && r.json.ok === true && q('SELECT status FROM orders WHERE id=?', oFull.id).status === 'completed' && q('SELECT delivery_content FROM orders WHERE id=?', oFull.id).delivery_content === 'K-A\nK-B', JSON.stringify(r.json));
  ps.createFn = null;
}

// P1-11：创建成功无单号 → pending_upstream + upstream_orders.status='no_psid_awaiting_manual'，轮询不再重建。
{
  const pUp = q("SELECT * FROM products WHERE title='上游商品-P1-1'");
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  ps.creates = 0;
  ps.createFn = () => ({ ok: true, status: 200, json: async () => ({ status: 'delivered', deliveredKey: 'NO-PSID-KEY' }), text: async () => JSON.stringify({ status: 'delivered', deliveredKey: 'NO-PSID-KEY' }) });
  r = await call('POST', '/api/admin/orders/' + o.id + '/confirm-payment', { reason: 'P1-11 no psid' , manual_confirm: true }, cookie);
  const after = q('SELECT * FROM orders WHERE id=?', o.id);
  const upRow = q('SELECT * FROM upstream_orders WHERE order_id=?', o.id);
  check('P1-11: create success without id -> pending_upstream', after.status === 'pending_upstream', 'status=' + after.status);
  check("P1-11: upstream_orders.status='no_psid_awaiting_manual'", upRow && upRow.status === 'no_psid_awaiting_manual', JSON.stringify(upRow));
  const createsAfterConfirm = ps.creates;
  const ctx = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx); await ctx.drain();
  check('P1-11: poll does not re-create (creates stays 1)', ps.creates === createsAfterConfirm && createsAfterConfirm === 1, 'creates=' + ps.creates);
  r = await call('POST', '/api/admin/upstream/orders/' + o.id + '/retry', {}, cookie);
  check('P1-11: explicit retry does not re-create either', ps.creates === 1, 'creates=' + ps.creates);
  ps.createFn = null;
}

// P1-12：refund_pending 拒绝手动发货（security-test 已覆盖；此处补充无上游单号场景）。
{
  const o = insertOrder({ status: 'refund_pending', refund_status: 'pending', paid_at: "datetime('now')", admin_note: 'P1-12' });
  r = await call('POST', '/api/admin/orders/' + o.id + '/fulfill', { delivery_content: 'SHOULD-NOT-DELIVER' }, cookie);
  check('P1-12: refund_pending fulfill -> 409', r.status === 409 && r.json && !r.json.ok, JSON.stringify(r.json));
  check('P1-12: order still refund_pending after refused fulfill', q('SELECT status FROM orders WHERE id=?', o.id).status === 'refund_pending');
}

// P1-13：/query 对 pending_payment 订单附带 pay_address；前端有恢复支付信息表单。
{
  const o = insertOrder({ status: 'pending_payment', pay_address: '0x9999999999999999999999999999999999999999', pay_method: 'OKX', pay_chain: 'X Layer' });
  const cid = mkCaptcha('AB12');
  r = await call('POST', '/api/orders/query', { keywords: o.order_no, captcha_id: cid, captcha_code: 'AB12' });
  check('P1-13: /query pending_payment includes pay_address', r.json && r.json.ok === true && Array.isArray(r.json.orders) && r.json.orders[0] && r.json.orders[0].pay_address === '0x9999999999999999999999999999999999999999', JSON.stringify(r.json));
  check('P1-13: frontend has recover payment form', frontendHtml.includes('恢复支付信息') && frontendHtml.includes('recoverOrderNo') && frontendHtml.includes('doRecoverPayment') && frontendHtml.includes('loadRecoverCaptcha'));
  check('P1-13: frontend query list renders pay address', frontendHtml.includes('payBlockHTML(o, o.order_no)') && frontendHtml.includes('复制地址'));
}

// ================= P2 =================
// P2-1：token 订单 /lookup full 分支删 admin_note；管理端详情走 level='admin' 保留 exception_reason/refund_ref。
{
  const o = insertOrder({ status: 'completed', delivery_content: 'P21-CARD', query_token_hash: sha256('token-123'), admin_note: 'SECRET-NOTE', exception_reason: 'EXC-REASON', refund_ref: 'REF-1' });
  r = await call('POST', '/api/orders/' + o.order_no + '/lookup', { credential: 'token-123', captcha_id: mkCaptcha('AB12'), captcha_code: 'AB12' });
  const fullOrder = r.json && r.json.order;
  check('P2-1: token /lookup full returns delivery', r.json && r.json.ok === true && fullOrder && fullOrder.delivery_content === 'P21-CARD', JSON.stringify(r.json));
  check('P2-1: full branch deletes admin_note', fullOrder && !('admin_note' in fullOrder), JSON.stringify(r.json));
  check('P2-1: full branch deletes refund_ref + exception_reason', fullOrder && !('refund_ref' in fullOrder) && !('exception_reason' in fullOrder), JSON.stringify(r.json));
  r = await call('GET', '/api/admin/orders/' + o.id + '?level=admin', null, cookie);
  check('P2-1: admin detail keeps admin_note', r.json && r.json.ok === true && r.json.order && r.json.order.admin_note === 'SECRET-NOTE', JSON.stringify(r.json));
  check('P2-1: admin detail keeps exception_reason + refund_ref', r.json && r.json.order && r.json.order.exception_reason === 'EXC-REASON' && r.json.order.refund_ref === 'REF-1', JSON.stringify(r.json));
}

// P2-2：legacy 订单首次 /lookup 明文成功即转为 salted 哈希（明文清空），之后 /lookup 返回统一错误，须走 /secret。
{
  const o = insertOrder({ status: 'completed', delivery_content: 'LEGACY-CARD-1', query_password: 'legacy-pw-999' });
  r = await call('POST', '/api/orders/' + o.order_no + '/lookup', { credential: 'legacy-pw-999', captcha_id: mkCaptcha('AB12'), captcha_code: 'AB12' });
  check('P2-2: legacy /lookup first success returns legacy:true summary', r.json && r.json.ok === true && r.json.legacy === true && !('delivery_content' in r.json), JSON.stringify(r.json));
  const after = q('SELECT * FROM orders WHERE id=?', o.id);
  check('P2-2: plaintext cleared after migration', after.query_password === '');
  check('P2-2: salt + hash set after migration', !!after.query_password_salt && !!after.query_password_hash);
  r = await call('POST', '/api/orders/' + o.order_no + '/lookup', { credential: 'legacy-pw-999', captcha_id: mkCaptcha('AB12'), captcha_code: 'AB12' });
  check('P2-2: second /lookup same password -> 401 unified error', r.status === 401 && r.json && r.json.error === '查单凭证错误', JSON.stringify(r.json));
  r = await call('POST', '/api/orders/' + o.order_no + '/secret', { password: 'legacy-pw-999' });
  check('P2-2: /secret with same password returns card', r.json && r.json.ok === true && r.json.delivery_content === 'LEGACY-CARD-1', JSON.stringify(r.json));
}

// P2-3 / P3-19：重复联系人报错无订单号（精确查询仍能检出重复）。
{
  const o = insertOrder({ status: 'pending_payment', product_id: 2, contact: 'dup-contact@test.example' });
  r = await call('POST', '/api/orders', { product_id: 2, quantity: 1, customer_fields: { contact_email: 'dup-contact@test.example' }, contact: 'dup-contact@test.example', pay_method: 'Binance', pay_chain: 'BEP20', query_password: 'dup-pw-123', captcha_id: mkCaptcha('AB12'), captcha_code: 'AB12' });
  check('P2-3/P3-19: duplicate contact rejected', r.json && !r.json.ok, JSON.stringify(r.json));
  check('P2-3: duplicate-contact error has no order_no', r.json && !String(r.json.error || '').includes(o.order_no), JSON.stringify(r.json));
  check('P2-3: duplicate-contact message text', r.json && /已有一笔待付款订单/.test(r.json.error || ''), JSON.stringify(r.json));
}

// P2-4：订单号随机后缀 16 位 hex；GET 单订单加查单限流（同 IP 第 31 次 429）。
{
  r = await orderCall({ product_id: 1, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  check('P2-4: order_no suffix is 16 hex chars', r.json && r.json.ok === true && /[0-9A-F]{16}$/.test(r.json.order.order_no), JSON.stringify(r.json));
  const no = r.json.order.order_no;
  const ip = '10.99.4.4';
  let lastStatus = 0;
  for (let i = 0; i < 31; i++) { const rr = await call('GET', '/api/orders/' + no, null, null, { 'CF-Connecting-IP': ip }); lastStatus = rr.status; }
  check('P2-4: 31st GET single order from same IP -> 429', lastStatus === 429, 'lastStatus=' + lastStatus);
}

// P2-6：rpc_urls 校验要求 https://。
{
  r = await call('POST', '/api/admin/settings', { key: 'rpc_urls', value: JSON.stringify({ 'BEP20': ['http://insecure.example'] }) }, cookie);
  check('P2-6: rpc_urls with http:// rejected, error mentions https', r.json && !r.json.ok && /https/.test(r.json.error || ''), JSON.stringify(r.json));
  r = await call('POST', '/api/admin/settings', { key: 'rpc_urls', value: JSON.stringify({ 'BEP20': ['https://mock-bsc'] }) }, cookie);
  check('P2-6: rpc_urls with https:// accepted', r.json && r.json.ok === true, JSON.stringify(r.json));
  // 恢复 mock RPC（避免后续链上测试受影响）
  setSetting('rpc_urls', JSON.stringify({ 'X Layer': ['https://mock-xlayer'], 'BEP20': ['https://mock-bsc'] }));
}

// P2-8：查询列表按 credential_type 分支（legacy 显示联系客服），不读 o.has_delivery。
{
  const dqStart = frontendHtml.indexOf('async function doQueryList');
  const dqEnd = frontendHtml.indexOf('async function doQuerySecret', dqStart);
  const dqSrc = dqStart !== -1 && dqEnd !== -1 ? frontendHtml.slice(dqStart, dqEnd) : '';
  // P2-8 更新（B-P2-5）：/query 不再返回 credential_type（凭证方案是未认证调用方可利用的 oracle），
  // 前端 doQueryList 不再按 credential_type 分支，统一渲染查询密码输入 + 旧订单凭证入口（doQueryLegacyStart）。
  check('P2-8: doQueryList has no credential_type branches', !dqSrc.includes('credential_type'));
  check('P2-8: doQueryList has generic password input + legacy entry', dqSrc.includes('doQuerySecret') && dqSrc.includes('doQueryLegacyStart'));
  check('P2-8: legacy branch shows contact-support hint', dqSrc.includes('联系客服'));
  check('P2-8: doQueryList does not read o.has_delivery', !dqSrc.includes('o.has_delivery'));
}

// P2-9：管理端详情显示 exception_reason（note-only 异常后）；列表 summary 不泄露 exception_reason。
{
  const pM = q("SELECT * FROM products WHERE title='手动商品-P1-6'");
  r = await orderCall({ product_id: pM.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  await call('POST', '/api/admin/orders/' + o.id + '/confirm-payment', { reason: 'P2-9 setup' , manual_confirm: true }, cookie);
  r = await call('POST', '/api/admin/orders/' + o.id + '/exception', { reason: '仅记录异常，不退款', refund_needed: false }, cookie);
  check('P2-9: exception note-only ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  r = await call('GET', '/api/admin/orders/' + o.id + '?level=admin', null, cookie);
  check('P2-9: admin detail shows exception_reason after note-only exception', r.json && r.json.ok === true && r.json.order && r.json.order.exception_reason === '仅记录异常，不退款', JSON.stringify(r.json));
  r = await call('GET', '/api/admin/orders?search=' + encodeURIComponent(o.order_no), null, cookie);
  check('P2-9: admin list summary does not leak exception_reason', r.json && r.json.ok === true && Array.isArray(r.json.orders) && !r.json.orders.some((x) => 'exception_reason' in x), JSON.stringify(r.json));
}

// P2-10：轮询失败退避（失败状态存 upstream_cache）；显式单笔重试绕过退避。
{
  const pUp = q("SELECT * FROM products WHERE title='上游商品-P1-1'");
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  ps.createFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-BACKOFF-1', status: 'paid' }), text: async () => JSON.stringify({ id: 'PS-BACKOFF-1', status: 'paid' }) });
  await call('POST', '/api/admin/orders/' + o.id + '/confirm-payment', { reason: 'P2-10 setup' , manual_confirm: true }, cookie);
  ps.createFn = null;
  ps.gets = 0;
  ps.getFn = () => ({ ok: false, status: 500, json: async () => null, text: async () => 'err' });
  const ctx1 = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx1); await ctx1.drain();
  check('P2-10: GET failure recorded in upstream_cache with count', (() => { const row = q("SELECT * FROM upstream_cache WHERE key='upstream_fail:' || ?", String(o.id)); if (!row) return false; const p = JSON.parse(row.payload || '{}'); return p.count >= 1 && p.nextRetryAt > Date.now(); })());
  check('P2-10: GET failure noted in admin_note', /上游轮询 GET 失败/.test(q('SELECT admin_note FROM orders WHERE id=?', o.id).admin_note || ''));
  const getsAfterFirst = ps.gets;
  const ctx2 = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx2); await ctx2.drain();
  check('P2-10: backoff skips order in cron poll (no new GET)', ps.gets === getsAfterFirst, 'gets=' + ps.gets + ' before=' + getsAfterFirst);
  // 显式单笔重试绕过退避：GET 恢复为 delivered → 完成
  ps.getFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-BACKOFF-1', status: 'delivered', deliveredKey: 'PS-BACKOFF-KEY' }), text: async () => JSON.stringify({ id: 'PS-BACKOFF-1', status: 'delivered', deliveredKey: 'PS-BACKOFF-KEY' }) });
  r = await call('POST', '/api/admin/upstream/orders/' + o.id + '/retry', {}, cookie);
  check('P2-10: explicit retry bypasses backoff and completes', r.json && r.json.ok === true && q('SELECT status FROM orders WHERE id=?', o.id).status === 'completed', JSON.stringify(r.json));
  ps.getFn = null;
}

// P2-11：游标：非终态履约失败不越过该事件；终态拒绝（已用于其他订单）不阻塞。
{
  // 阻塞事件：订单有新鲜 claim_token，/pay 链上核验命中后履约失败（订单已被认领），扫描不得越过该事件块。
  const oBlock = insertOrder({ status: 'pending_payment', pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x6666666666666666666666666666666666666666', actual_amount: 5.0037, claim_token: 'FRESH-BLOCK', claimed_at: "datetime('now')", contact: freshContact() });
  evm.logs = [evmLogFor(oBlock, 'a1'.repeat(32), 9980)]; // TXID 须全新：P1-2 已人工确认消耗 a*64（payments manual_confirmed），复用会变成终态拒绝而非阻塞
  evm.latest = 10000;
  const ctxB = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctxB); await ctxB.drain();
  const curB = q("SELECT * FROM scan_cursors WHERE chain=?", 'BEP20|0x6666666666666666666666666666666666666666');
  check('P2-11: non-terminal fulfill failure does NOT pass the event (cursor stays at event block)', curB && Number(curB.last_block) === 9980, JSON.stringify(curB));
  check('P2-11: blocked order still pending_payment', q('SELECT status FROM orders WHERE id=?', oBlock.id).status === 'pending_payment');
  // 终态拒绝：TXID 已被另一订单认领 → 扫描不阻塞，游标继续推进。
  const oOther = insertOrder({ status: 'completed', contact: freshContact() });
  db.prepare('INSERT INTO txid_claims (tx_hash, order_id) VALUES (?, ?)').run('b'.repeat(64), oOther.id);
  const oTerm = insertOrder({ status: 'pending_payment', pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x7777777777777777777777777777777777777777', actual_amount: 6.0011, contact: freshContact() });
  evm.logs = [evmLogFor(oTerm, 'b'.repeat(64), 9980)];
  const ctxT = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctxT); await ctxT.drain();
  const curT = q("SELECT * FROM scan_cursors WHERE chain=?", 'BEP20|0x7777777777777777777777777777777777777777');
  check('P2-11: terminal rejection does NOT block cursor (cursor advances past event)', curT && Number(curT.last_block) > 9980, JSON.stringify(curT));
  check('P2-11: terminal-rejected order still pending_payment (not wrongly completed)', q('SELECT status FROM orders WHERE id=?', oTerm.id).status === 'pending_payment');
  evm.logs = [];
}

// P2-12：BinanceUID 订单只做超时取消（不做链上核验/轮询发货）。
{
  const oExp = insertOrder({ status: 'pending_payment', pay_method: 'BinanceUID', pay_chain: '站内转账', pay_address: '', expires_at: "datetime('now','-1 minutes')", contact: freshContact() });
  const oLive = insertOrder({ status: 'pending_payment', pay_method: 'BinanceUID', pay_chain: '站内转账', pay_address: '', expires_at: "datetime('now','+30 minutes')", contact: freshContact() });
  const ctx = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx); await ctx.drain();
  check('P2-12: expired BinanceUID order timeout-cancelled', q('SELECT status FROM orders WHERE id=?', oExp.id).status === 'cancelled');
  check('P2-12: unexpired BinanceUID order stays pending_payment', q('SELECT status FROM orders WHERE id=?', oLive.id).status === 'pending_payment');
  check('P2-12: BinanceUID order has no ledger rows', qa('SELECT * FROM payments WHERE order_id=?', oLive.id).length === 0);
}

// P2-13 / P3-16：upsertUpstreamOrder 租约条件写入 — 轮询抢不到租约时不覆盖 admin_note。
{
  const pUp = q("SELECT * FROM products WHERE title='上游商品-P1-1'");
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  ps.createFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-LEASE-1', status: 'paid' }), text: async () => JSON.stringify({ id: 'PS-LEASE-1', status: 'paid' }) });
  await call('POST', '/api/admin/orders/' + o.id + '/confirm-payment', { reason: 'P2-13 setup' , manual_confirm: true }, cookie);
  ps.createFn = null;
  db.prepare("UPDATE orders SET upstream_lock='HELD-BY-OTHER', upstream_lock_expires_at=datetime('now','+10 minutes'), admin_note='ORIGINAL-NOTE' WHERE id=?").run(o.id);
  ps.gets = 0;
  const ctx = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx); await ctx.drain();
  check('P2-13: poll skips order whose upstream_lock is freshly held (no upstream GET)', ps.gets === 0, 'gets=' + ps.gets);
  check('P3-16: admin_note NOT overwritten without holding lock', q('SELECT admin_note FROM orders WHERE id=?', o.id).admin_note === 'ORIGINAL-NOTE');
  check('P2-13: upstream row untouched while lock held', q('SELECT * FROM upstream_orders WHERE order_id=?', o.id).prodseller_order_id === 'PS-LEASE-1');
  db.prepare("UPDATE orders SET upstream_lock='', upstream_lock_expires_at=NULL WHERE id=?").run(o.id);
}

// P2-14：告警覆盖 pending_activation > 30 分钟；新鲜 pending_activation 不告警。
{
  const oStale = insertOrder({ status: 'pending_activation', paid_at: "datetime('now','-40 minutes')", contact: freshContact() });
  const oFresh = insertOrder({ status: 'pending_activation', paid_at: "datetime('now')", contact: freshContact() });
  const oUp = insertOrder({ status: 'pending_upstream', paid_at: "datetime('now')", contact: freshContact() });
  r = await call('GET', '/api/admin/upstream/alerts', null, cookie);
  const alerts = (r.json && r.json.alerts) || [];
  check('P2-14: stale pending_activation in alerts', alerts.some((a) => a.id === oStale.id));
  check('P2-14: stale pending_activation alert has alert_reason', alerts.some((a) => a.id === oStale.id && /30 ?分钟/.test(a.alert_reason || '')));
  check('P2-14: fresh pending_activation NOT in alerts', !alerts.some((a) => a.id === oFresh.id));
  check('P2-14: pending_upstream in alerts', alerts.some((a) => a.id === oUp.id));
  // P3-8：告警走 sanitize summary（不含 hash/salt/claim_token/delivery_content/contact）
  const bad = alerts.find((a) => a && (a.query_password_salt || a.query_password_hash || a.claim_token || a.delivery_content || a.contact));
  check('P3-8: alerts contain no sensitive fields (summary sanitize)', !bad, JSON.stringify(bad || ''));
}

// P2-15：超期升级只记告警（exception_reason + admin_note + 审计，仅一次），不改状态。
{
  const o = insertOrder({ status: 'pending_activation', paid_at: "datetime('now','-3 hours')", contact: freshContact() });
  ps.getFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-ESCALATE-1', status: 'paid' }), text: async () => JSON.stringify({ id: 'PS-ESCALATE-1', status: 'paid' }) });
  const ctx1 = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx1); await ctx1.drain();
  const after1 = q('SELECT * FROM orders WHERE id=?', o.id);
  check('P2-15: escalation writes exception_reason', /已升级告警/.test(after1.exception_reason || ''), after1.exception_reason);
  check('P2-15: escalation writes admin_note', /已升级告警/.test(after1.admin_note || ''), after1.admin_note);
  check('P2-15: escalation does NOT change status', after1.status === 'pending_activation');
  check('P2-15: escalation audit once', qa("SELECT * FROM admin_audit WHERE order_id=? AND action='upstream_escalation'", o.id).length === 1);
  const ctx2 = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx2); await ctx2.drain();
  check('P2-15: second poll adds no duplicate escalation', qa("SELECT * FROM admin_audit WHERE order_id=? AND action='upstream_escalation'", o.id).length === 1);
  // pending_upstream + 失败计数 >= 10 → 同样升级
  const oUp = insertOrder({ status: 'pending_upstream', paid_at: "datetime('now','-3 hours')", contact: freshContact() });
  db.prepare("INSERT INTO upstream_cache (key, payload, fetched_at) VALUES ('upstream_fail:' || ?, ?, datetime('now'))").run(String(oUp.id), JSON.stringify({ count: 10, nextRetryAt: Date.now() + 600000, reason: 'test' }));
  const ctx3 = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx3); await ctx3.drain();
  check('P2-15: pending_upstream with fail count >= 10 escalated', /已升级告警/.test(q('SELECT admin_note FROM orders WHERE id=?', oUp.id).admin_note || ''));
  ps.getFn = null;
}

// P2-16：同 IP 查单 30 次后第 31 次 429；同 IP /pay 20 次后第 21 次 429。
{
  const ipQ = '10.99.16.1';
  let lastQ = 0;
  for (let i = 0; i < 31; i++) { const cid = mkCaptcha('AB12'); const rr = await call('POST', '/api/orders/query', { keywords: 'AISRF-NONE', captcha_id: cid, captcha_code: 'AB12' }, null, { 'CF-Connecting-IP': ipQ }); lastQ = rr.status; }
  check('P2-16: 31st /query from same IP -> 429', lastQ === 429, 'lastStatus=' + lastQ);
  const ipP = '10.99.16.2';
  const payOrders = [];
  for (let k = 0; k < 5; k++) {
    r = await orderCall({ product_id: 1, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
    payOrders.push(q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no));
  }
  let lastP = 0, okCount = 0;
  for (let i = 0; i < 21; i++) {
    const o = payOrders[Math.floor(i / 5)];
    const rr = await payCall(o.order_no, '9'.repeat(60) + String(i), ipP);
    lastP = rr.status; if (rr.status === 200) okCount++;
  }
  check('P2-16: 21st /pay from same IP -> 429 (20 OK)', lastP === 429 && okCount === 20, 'lastStatus=' + lastP + ' okCount=' + okCount);
}

// P2-18：回滚测试 — v15 库 + 模拟旧版下单路径（无 INSERT 重试）：同金额并发下单应可复现 500。
// 已知行为（文档化于此）：旧版 Worker 下单对金额唯一索引冲突无重试，两个并发同金额订单中
// 第二个 INSERT 直接抛 UNIQUE → 500；新版下单会重试新金额（release-readiness §4 覆盖新路径）。
{
  const addr = '0x4242424242424242424242424242424242424242';
  const amt = 777.0011;
  insertOrder({ status: 'pending_payment', pay_address: addr, actual_amount: amt, contact: freshContact() });
  let threw = null;
  try { insertOrder({ status: 'pending_payment', pay_address: addr, actual_amount: amt, contact: freshContact() }); } catch (e) { threw = e; }
  check('P2-18: old-path duplicate amount INSERT throws UNIQUE (would be 500 in old worker)', !!threw && /UNIQUE/i.test(threw.message || ''), threw && threw.message);
  const okDiffAddr = insertOrder({ status: 'pending_payment', pay_address: '0x4343434343434343434343434343434343434343', actual_amount: amt, contact: freshContact() });
  check('P2-18: same amount different address INSERT ok (index is per-address)', !!okDiffAddr);
}

// ================= P3 =================
// P3-1：sanitize 删 salt — 单订单 / 管理列表都不泄露 query_password_salt（及 hash/token）。
{
  const o = insertOrder({ status: 'completed', delivery_content: 'P31-CARD', query_password_hash: 'hash-xyz', query_password_salt: 'salt-xyz' });
  r = await call('GET', '/api/orders/' + o.order_no);
  check('P3-1: GET single order hides query_password_salt', r.json && r.json.ok === true && !('query_password_salt' in (r.json.order || {})) && !('query_password_hash' in (r.json.order || {})) && !('query_token_hash' in (r.json.order || {})), JSON.stringify(r.json));
  r = await call('GET', '/api/admin/orders?search=' + encodeURIComponent(o.order_no), null, cookie);
  check('P3-1: admin list hides query_password_salt', r.json && r.json.ok === true && Array.isArray(r.json.orders) && !r.json.orders.some((x) => 'query_password_salt' in x), JSON.stringify(r.json));
}

// P3-2：sanitize 默认 summary — 单订单默认不含交付/联系方式/管理备注/异常/退款引用。
{
  const o = insertOrder({ status: 'completed', delivery_content: 'P32-CARD', contact: 'p32@test.example', admin_note: 'P32-NOTE', exception_reason: 'P32-EXC', refund_ref: 'P32-REF', customer_fields: JSON.stringify({ contact_email: 'p32@test.example' }) });
  r = await call('GET', '/api/orders/' + o.order_no);
  const ordr = r.json && r.json.order;
  check('P3-2: GET single order (default) hides delivery/contact/admin fields', ordr && !('delivery_content' in ordr) && !('contact' in ordr) && !('customer_fields' in ordr) && !('admin_note' in ordr) && !('exception_reason' in ordr) && !('refund_ref' in ordr), JSON.stringify(r.json));
  check('P3-2: GET single order still has has_query_password', ordr && 'has_query_password' in ordr, JSON.stringify(r.json));
}

// P3-3：/pay 核验失败不建账本行（但订单 txid 仍暂存）。
{
  const o = insertOrder({ status: 'pending_payment', pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x2222222222222222222222222222222222222222', actual_amount: 9.0011 });
  evm.receipt = null;
  r = await payCall(o.order_no, 'c'.repeat(64));
  check('P3-3: /pay unverified returns ok + auto:false', r.json && r.json.ok === true && r.json.auto === false, JSON.stringify(r.json));
  check('P3-3: /pay unverified creates NO ledger row', qa('SELECT * FROM payments WHERE order_id=?', o.id).length === 0);
  check('P3-3: /pay unverified still stores txid on order (txid column)', q('SELECT txid FROM orders WHERE id=?', o.id).txid === 'c'.repeat(64));
}

// P3-4：/pay 必须带验证码；前端两处 /pay UI 均有验证码输入。
{
  const o = insertOrder({ status: 'pending_payment', pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x2222222222222222222222222222222222222222', actual_amount: 9.0022 });
  r = await call('POST', '/api/orders/' + o.order_no + '/pay', { txid: 'd'.repeat(64) });
  check('P3-4: /pay without captcha rejected, error mentions 验证码', r.json && !r.json.ok && /验证码/.test(r.json.error || ''), JSON.stringify(r.json));
  r = await payCall(o.order_no, 'd'.repeat(64));
  check('P3-4: /pay with captcha accepted', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('P3-4: frontend success page has pay captcha input', frontendHtml.includes('payCaptchaCode') && frontendHtml.includes('loadPayCaptcha'));
  check('P3-4: frontend query detail has per-order pay captcha input', frontendHtml.includes('payCaptchaCode-'));
}

// P3-5：原子记数 — 40 并发 /query 同 IP 恰好 30 OK + 10 429；10 并发 /pay 同单恰好 5 OK + 5 429。
{
  const ip = '10.99.5.5';
  const caps = Array.from({ length: 40 }, () => mkCaptcha('AB12'));
  const results = await Promise.all(caps.map((cid) => call('POST', '/api/orders/query', { keywords: 'AISRF-NONE', captcha_id: cid, captcha_code: 'AB12' }, null, { 'CF-Connecting-IP': ip })));
  const okQ = results.filter((x) => x.status !== 429).length;
  const badQ = results.filter((x) => x.status === 429).length;
  check('P3-5: 40 concurrent /query same IP -> exactly 30 OK + 10 429', okQ === 30 && badQ === 10, 'ok=' + okQ + ' 429=' + badQ);
  const o = insertOrder({ status: 'pending_payment', pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x2222222222222222222222222222222222222222', actual_amount: 9.0033 });
  const payCaps = Array.from({ length: 10 }, () => mkCaptcha('AB12'));
  const payResults = await Promise.all(payCaps.map((cid, i) => call('POST', '/api/orders/' + o.order_no + '/pay', { txid: 'e'.repeat(60) + String(i), captcha_id: cid, captcha_code: 'AB12' })));
  const okP = payResults.filter((x) => x.status === 200).length;
  const badP = payResults.filter((x) => x.status === 429).length;
  check('P3-5: 10 concurrent /pay same order -> exactly 5 OK + 5 429', okP === 5 && badP === 5, 'ok=' + okP + ' 429=' + badP);
}

// P3-6：reset-query-password 清空明文并记审计；新密码可经 /secret 查单。
{
  const o = insertOrder({ status: 'completed', delivery_content: 'P36-CARD', query_password: 'plain-old-123' });
  r = await call('POST', '/api/admin/orders/' + o.id + '/reset-query-password', { new_password: 'new-pw-456789' }, cookie);
  check('P3-6: reset-query-password ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('P3-6: plaintext cleared after reset', q('SELECT query_password FROM orders WHERE id=?', o.id).query_password === '');
  check('P3-6: reset audit row exists', !!q("SELECT * FROM admin_audit WHERE order_id=? AND action='reset_query_password'", o.id));
  r = await call('POST', '/api/orders/' + o.order_no + '/secret', { password: 'new-pw-456789' });
  check('P3-6: /secret with new password returns card', r.json && r.json.ok === true && r.json.delivery_content === 'P36-CARD', JSON.stringify(r.json));
}

// P3-7：exception 不退款 UPDATE 加状态守卫 — 已完成订单的 exception 被拒绝。
{
  const o = insertOrder({ status: 'completed', delivery_content: 'P37-CARD' });
  r = await call('POST', '/api/admin/orders/' + o.id + '/exception', { reason: '已完成订单不应再异常', refund_needed: false }, cookie);
  check('P3-7: exception on completed order rejected', r.json && !r.json.ok, JSON.stringify(r.json));
  check('P3-7: exception_reason unchanged on completed order', q('SELECT exception_reason FROM orders WHERE id=?', o.id).exception_reason === '');
}

// P3-9：搜索改 instr() — '%' / '_' 按字面匹配，不当通配符。
{
  r = await call('GET', '/api/admin/orders?q=' + encodeURIComponent('%'), null, cookie);
  check("P3-9: admin orders search q='%' returns 0 (literal, not LIKE wildcard)", r.json && r.json.ok === true && r.json.total === 0, JSON.stringify(r.json));
  r = await call('GET', '/api/admin/cards?q=' + encodeURIComponent('%'), null, cookie);
  check("P3-9: admin cards search q='%' returns 0", r.json && r.json.ok === true && r.json.total === 0, JSON.stringify(r.json));
  r = await call('GET', '/api/admin/products?q=' + encodeURIComponent('%'), null, cookie);
  check("P3-9: admin products search q='%' returns 0 items", r.json && r.json.ok === true && Array.isArray(r.json.products) && r.json.products.length === 0, JSON.stringify(r.json));
}

// P3-10：卡密列表 / 导入记审计；导入审计备注只有计数，无卡密明文。
{
  const pC = q("SELECT * FROM products WHERE title='卡密商品-P1-8'");
  const beforeList = qa("SELECT * FROM admin_audit WHERE action='cards_list'").length;
  r = await call('GET', '/api/admin/cards?product_id=' + pC.id, null, cookie);
  check('P3-10: cards list ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('P3-10: cards list audit row', qa("SELECT * FROM admin_audit WHERE action='cards_list'").length > beforeList);
  r = await call('POST', '/api/admin/cards/import', { product_id: pC.id, codes: 'P310-NEW-1\nP310-NEW-2' }, cookie);
  check('P3-10: cards import ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  const imp = q("SELECT * FROM admin_audit WHERE action='cards_import' ORDER BY id DESC");
  check('P3-10: cards import audit row', !!imp);
  check('P3-10: import audit note has counts, no codes', imp && !String(imp.note || '').includes('P310-NEW-1') && /2/.test(imp.note || ''), JSON.stringify(imp));
}

// P3-11：logout 加 CSRF — 无 CSRF 头 403；带 X-Admin-API 正常登出。
{
  const ctx = makeCtx();
  const reqRaw = new Request('http://test/api/admin/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'Cookie': cookie }, body: '{}' });
  const resRaw = await worker.fetch(reqRaw, env, ctx); await ctx.drain();
  const txtRaw = await resRaw.text();
  let jRaw = null; try { jRaw = JSON.parse(txtRaw); } catch {}
  check('P3-11: logout without CSRF headers -> 403', resRaw.status === 403 && jRaw && !jRaw.ok, 'status=' + resRaw.status + ' ' + txtRaw);
  r = await call('POST', '/api/admin/logout', {}, cookie);
  check('P3-11: logout with X-Admin-API ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  // 登出后旧 cookie 失效；重新登录，后续测试继续用新 cookie
  r = await call('POST', '/api/admin/login', { password: 'admin123' });
  check('P3-11: re-login after logout ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  cookie = r.headers.get('set-cookie') || '';
}

// P3-12：改密新密码 ≠ 旧密码。
{
  r = await call('POST', '/api/admin/change-password', { old_password: 'admin123', new_password: 'admin123' }, cookie);
  check('P3-12: change-password new == old rejected', r.json && !r.json.ok && /不能与旧密码相同/.test(r.json.error || ''), JSON.stringify(r.json));
}

// P3-13：恒定时间比较 — login / /lookup / /secret 的哈希比较都用 timingSafeEqual。
{
  check('P3-13: worker uses timingSafeEqual in login', workerCode.includes('timingSafeEqual(h, storedHash)'));
  check('P3-13: worker uses timingSafeEqual in /lookup token compare', workerCode.includes('timingSafeEqual(await sha256Hex(cred), ordL.query_token_hash)'));
  check('P3-13: worker uses timingSafeEqual in /secret hash compare', workerCode.includes('timingSafeEqual(calcHash, ordS.query_password_hash)'));
  check('P3-13: worker uses timingSafeEqual in legacy plaintext compare', workerCode.includes('timingSafeEqual(cred, ordL.query_password)'));
}

// P3-14：GET /api/captcha 加 IP 限流 30 次/10 分钟（同 IP 第 31 次 429）。
{
  const ip = '10.99.14.14';
  let lastStatus = 0;
  for (let i = 0; i < 31; i++) { const rr = await call('GET', '/api/captcha', null, null, { 'CF-Connecting-IP': ip }); lastStatus = rr.status; }
  check('P3-14: 31st GET /api/captcha from same IP -> 429', lastStatus === 429, 'lastStatus=' + lastStatus);
}

// P3-15：大额分级确认数（X Layer）+ BEP20 保持 15 + 设置校验。
{
  // 小额 X Layer：amount 5，默认 1 确认 → latest 100 暂存，101 接受
  const oSmall = insertOrder({ status: 'pending_payment', pay_method: 'OKX', pay_chain: 'X Layer', pay_address: '0x1111111111111111111111111111111111111111', actual_amount: 5 });
  evm.receipt = evmReceiptFor(oSmall, 'f0'.repeat(32), 100);
  evm.latest = 100;
  r = await payCall(oSmall.order_no, 'f0'.repeat(32));
  check('P3-15: X Layer small order 0 confirmations deferred (auto:false)', r.json && r.json.ok === true && r.json.auto === false, JSON.stringify(r.json));
  evm.latest = 101;
  r = await payCall(oSmall.order_no, 'f0'.repeat(32));
  check('P3-15: X Layer small order 1 confirmation accepted', r.json && r.json.ok === true && (r.json.auto === true || q('SELECT status FROM orders WHERE id=?', oSmall.id).status === 'completed'), JSON.stringify(r.json));
  // 大额 X Layer：amount 150 >= 100 → 默认 12 确认 → latest 111 暂存，112 接受
  const oLarge = insertOrder({ status: 'pending_payment', pay_method: 'OKX', pay_chain: 'X Layer', pay_address: '0x1111111111111111111111111111111111111111', actual_amount: 150 });
  evm.receipt = evmReceiptFor(oLarge, 'a2'.repeat(32), 100);
  evm.latest = 111;
  r = await payCall(oLarge.order_no, 'a2'.repeat(32));
  check('P3-15: X Layer large order 11 confirmations deferred (needs 12)', r.json && r.json.ok === true && r.json.auto === false, JSON.stringify(r.json));
  evm.latest = 112;
  r = await payCall(oLarge.order_no, 'a2'.repeat(32));
  check('P3-15: X Layer large order 12 confirmations accepted', r.json && r.json.ok === true && r.json.auto === true && q('SELECT status FROM orders WHERE id=?', oLarge.id).status === 'pending_fulfill', JSON.stringify(r.json));
  // 自定义设置：large_order_usdt=50, large_order_confirmations=5 → amount 60 需 5 确认
  setSetting('large_order_usdt', '50');
  setSetting('large_order_confirmations', '5');
  const oCustom = insertOrder({ status: 'pending_payment', pay_method: 'OKX', pay_chain: 'X Layer', pay_address: '0x1111111111111111111111111111111111111111', actual_amount: 60 });
  evm.receipt = evmReceiptFor(oCustom, 'b2'.repeat(32), 100);
  evm.latest = 104;
  r = await payCall(oCustom.order_no, 'b2'.repeat(32));
  check('P3-15: custom large order 4 confirmations deferred (needs 5)', r.json && r.json.ok === true && r.json.auto === false, JSON.stringify(r.json));
  evm.latest = 105;
  r = await payCall(oCustom.order_no, 'b2'.repeat(32));
  check('P3-15: custom large order 5 confirmations accepted', r.json && r.json.ok === true && r.json.auto === true && q('SELECT status FROM orders WHERE id=?', oCustom.id).status === 'pending_fulfill', JSON.stringify(r.json));
  // BEP20 大额仍需 15 确认：latest 112 暂存，115 接受
  const oBep = insertOrder({ status: 'pending_payment', pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x2222222222222222222222222222222222222222', actual_amount: 150 });
  evm.receipt = evmReceiptFor(oBep, 'c2'.repeat(32), 100);
  evm.latest = 112;
  r = await payCall(oBep.order_no, 'c2'.repeat(32));
  check('P3-15: BEP20 large order 12 confirmations deferred (still needs 15)', r.json && r.json.ok === true && r.json.auto === false, JSON.stringify(r.json));
  evm.latest = 115;
  r = await payCall(oBep.order_no, 'c2'.repeat(32));
  check('P3-15: BEP20 large order 15 confirmations accepted', r.json && r.json.ok === true && r.json.auto === true && q('SELECT status FROM orders WHERE id=?', oBep.id).status === 'pending_fulfill', JSON.stringify(r.json));
  // 设置校验
  r = await call('POST', '/api/admin/settings', { key: 'large_order_usdt', value: '0' }, cookie);
  check('P3-15: large_order_usdt=0 rejected', r.json && !r.json.ok, JSON.stringify(r.json));
  r = await call('POST', '/api/admin/settings', { key: 'large_order_confirmations', value: '101' }, cookie);
  check('P3-15: large_order_confirmations=101 rejected', r.json && !r.json.ok, JSON.stringify(r.json));
  setSetting('large_order_usdt', '100');
  setSetting('large_order_confirmations', '12');
  evm.receipt = null; evm.latest = 10000; evm.logs = [];
}

// P3-17（2026-10-18 整改）：GET /api/orders?contact= 返回 410，文案为“旧接口停用，请用订单号或下单邮箱+验证码走当前查单流程”（P1-6，不再称“邮箱查单已关闭”）。
{
  r = await call('GET', '/api/orders?contact=x@test.example');
  check('P3-17: GET /api/orders?contact= -> 410', r.status === 410, JSON.stringify(r.json));
  check('P3-17: 410 text says 旧接口停用 + 订单号或下单邮箱+验证码', r.json && /旧接口停用/.test(r.json.error || '') && /订单号或下单邮箱/.test(r.json.error || '') && /验证码/.test(r.json.error || '') && !/查单凭证/.test(r.json.error || ''), JSON.stringify(r.json));
}

// P3-18：/lookup 错密码统一返回“查单凭证错误”（salted 订单与 legacy 订单相同）。
{
  const oSalted = insertOrder({ status: 'completed', delivery_content: 'P318-CARD', query_password_hash: 'a'.repeat(64), query_password_salt: Buffer.from('s'.repeat(16)).toString('base64') });
  r = await call('POST', '/api/orders/' + oSalted.order_no + '/lookup', { credential: 'wrong-pw', captcha_id: mkCaptcha('AB12'), captcha_code: 'AB12' });
  check('P3-18: /lookup wrong pw on salted order -> exactly 查单凭证错误', r.status === 401 && r.json && r.json.error === '查单凭证错误', JSON.stringify(r.json));
  const oLegacy = insertOrder({ status: 'completed', delivery_content: 'P318-LEGACY', query_password: 'legacy-true-pw' });
  r = await call('POST', '/api/orders/' + oLegacy.order_no + '/lookup', { credential: 'wrong-pw-legacy', captcha_id: mkCaptcha('AB12'), captcha_code: 'AB12' });
  check('P3-18: /lookup wrong pw on legacy order -> exactly 查单凭证错误', r.status === 401 && r.json && r.json.error === '查单凭证错误', JSON.stringify(r.json));
}

// P3-21：/pay txid UPDATE 加状态守卫 — 订单已有 txid 时，第二次 /pay 不覆盖原 txid。
{
  const o = insertOrder({ status: 'pending_payment', pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x2222222222222222222222222222222222222222', actual_amount: 9.0044, txid: '0'.repeat(64) });
  evm.receipt = null;
  r = await payCall(o.order_no, '1'.repeat(64));
  check('P3-21: /pay with existing txid returns ok + auto:false', r.json && r.json.ok === true && r.json.auto === false, JSON.stringify(r.json));
  check('P3-21: order txid NOT overwritten by second /pay', q('SELECT txid FROM orders WHERE id=?', o.id).txid === '0'.repeat(64));
}

// P3-22：上游重试对非 pending_activation/pending_upstream 返回 409。
{
  const oPay = insertOrder({ status: 'pending_payment' });
  r = await call('POST', '/api/admin/upstream/orders/' + oPay.id + '/retry', {}, cookie);
  check('P3-22: retry on pending_payment -> 409', r.status === 409, JSON.stringify(r.json));
  const oDone = insertOrder({ status: 'completed', delivery_content: 'P322' });
  r = await call('POST', '/api/admin/upstream/orders/' + oDone.id + '/retry', {}, cookie);
  check('P3-22: retry on completed -> 409', r.status === 409, JSON.stringify(r.json));
  const pUp = q("SELECT * FROM products WHERE title='上游商品-P1-1'");
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const oUp = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.prepare("UPDATE orders SET status='pending_upstream' WHERE id=?").run(oUp.id);
  ps.createFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-322-1', status: 'paid' }), text: async () => JSON.stringify({ id: 'PS-322-1', status: 'paid' }) });
  r = await call('POST', '/api/admin/upstream/orders/' + oUp.id + '/retry', {}, cookie);
  check('P3-22: retry on pending_upstream -> ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  ps.createFn = null;
}

// P3-23：轮询完成清空 claim_token。
{
  const pUp = q("SELECT * FROM products WHERE title='上游商品-P1-1'");
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  ps.createFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-323-1', status: 'paid' }), text: async () => JSON.stringify({ id: 'PS-323-1', status: 'paid' }) });
  await call('POST', '/api/admin/orders/' + o.id + '/confirm-payment', { reason: 'P3-23 setup' , manual_confirm: true }, cookie);
  ps.createFn = null;
  db.prepare("UPDATE orders SET claim_token='STALE-323' WHERE id=?").run(o.id);
  ps.getFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-323-1', status: 'delivered', deliveredKey: 'PS-323-KEY' }), text: async () => JSON.stringify({ id: 'PS-323-1', status: 'delivered', deliveredKey: 'PS-323-KEY' }) });
  const ctx = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx); await ctx.drain();
  const after = q('SELECT * FROM orders WHERE id=?', o.id);
  check('P3-23: poll completion clears claim_token', after.status === 'completed' && after.claim_token === '', 'status=' + after.status + ' claim_token=' + after.claim_token);
  ps.getFn = null;
}

// P3-24：completeOrder 清空 exception_reason（手动发货完成）。
{
  const pM = q("SELECT * FROM products WHERE title='手动商品-P1-6'");
  r = await orderCall({ product_id: pM.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  await call('POST', '/api/admin/orders/' + o.id + '/confirm-payment', { reason: 'P3-24 setup' , manual_confirm: true }, cookie);
  db.prepare("UPDATE orders SET exception_reason='OLD-EXCEPTION' WHERE id=?").run(o.id);
  r = await call('POST', '/api/admin/orders/' + o.id + '/fulfill', { delivery_content: 'P324-DELIVERY' }, cookie);
  check('P3-24: manual fulfill clears exception_reason', r.json && r.json.ok === true && q('SELECT exception_reason FROM orders WHERE id=?', o.id).exception_reason === '', JSON.stringify(r.json));
}

// P3-25：轮询 GET 失败记 admin_note（500 记失败；404 单独处理）。
{
  const pUp = q("SELECT * FROM products WHERE title='上游商品-P1-1'");
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o500 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  ps.createFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-500-1', status: 'paid' }), text: async () => JSON.stringify({ id: 'PS-500-1', status: 'paid' }) });
  await call('POST', '/api/admin/orders/' + o500.id + '/confirm-payment', { reason: 'P3-25 setup' , manual_confirm: true }, cookie);
  ps.createFn = null;
  ps.getFn = (id) => id === 'PS-500-1'
    ? { ok: false, status: 500, json: async () => null, text: async () => 'err' }
    : { ok: false, status: 404, json: async () => null, text: async () => 'not found' };
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  const o404 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  ps.createFn = () => ({ ok: true, status: 200, json: async () => ({ id: 'PS-404-1', status: 'paid' }), text: async () => JSON.stringify({ id: 'PS-404-1', status: 'paid' }) });
  await call('POST', '/api/admin/orders/' + o404.id + '/confirm-payment', { reason: 'P3-25 setup 404' , manual_confirm: true }, cookie);
  ps.createFn = null;
  const ctx = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx); await ctx.drain();
  check('P3-25: GET 500 -> admin_note contains 上游轮询 GET 失败 + fail count', /上游轮询 GET 失败/.test(q('SELECT admin_note FROM orders WHERE id=?', o500.id).admin_note || ''), q('SELECT admin_note FROM orders WHERE id=?', o500.id).admin_note);
  check('P3-25: GET 404 -> admin_note contains 404 + 上游订单不存在', /404/.test(q('SELECT admin_note FROM orders WHERE id=?', o404.id).admin_note || '') && /上游订单不存在/.test(q('SELECT admin_note FROM orders WHERE id=?', o404.id).admin_note || ''), q('SELECT admin_note FROM orders WHERE id=?', o404.id).admin_note);
  ps.getFn = null;
}

// P3-26：先认领 TXID、后认领订单 — 订单认领失败时，刚写入的 TXID 认领行被回滚删除。
{
  const o = insertOrder({ status: 'pending_payment', pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x2222222222222222222222222222222222222222', actual_amount: 9.0055, claim_token: 'FRESH-326', claimed_at: "datetime('now')" });
  evm.receipt = evmReceiptFor(o, '2'.repeat(64), 100);
  evm.latest = 115; // BEP20 需 15 确认：latest 100 时 0 确认，/pay 不会走到履约
  r = await payCall(o.order_no, '2'.repeat(64));
  check('P3-26: /pay with fresh claim -> not completed', q('SELECT status FROM orders WHERE id=?', o.id).status === 'pending_payment');
  check('P3-26: failed order claim rolls back the txid claim row (no orphan txid_claims)', !q('SELECT * FROM txid_claims WHERE tx_hash=?', '2'.repeat(64)));
  evm.receipt = null; evm.latest = 10000;
}

// P3-27：扫描回填 event_key（任务二顺序更新）。
// 旧断言“/pay 阶段即写 event_key='' 账本行”已不再成立：任务二要求认领成功后才写账本，
// 故被活租约挡住的 /pay 不写任何账本行（fail-closed）。回填本身仍覆盖：种子一行“账本已写、
// 履约前崩溃”的 event_key='' verified 行，扫描命中同一 TXID 后回填为日志 logIndex，且只留一行。
{
  // 卡密商品订单（扫描履约后真正 completed，便于断言）
  const pC27 = q("SELECT * FROM products WHERE title='卡密商品-P1-8'");
  const o = insertOrder({ status: 'pending_payment', product_id: pC27.id, pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x2222222222222222222222222222222222222222', actual_amount: 9.0066, claim_token: 'FRESH-327', claimed_at: "datetime('now')" });
  db.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(pC27.id, 'P327-CARD');
  evm.receipt = evmReceiptFor(o, '3'.repeat(64), 100);
  evm.latest = 115; // BEP20 需 15 确认
  r = await payCall(o.order_no, '3'.repeat(64));
  check('P3-27: /pay blocked by live lease writes no ledger (claim-before-ledger)', r.json && !r.json.ok && qa('SELECT * FROM payments WHERE tx_hash=?', '3'.repeat(64)).length === 0, JSON.stringify(r.json));
  // 解除认领 + 种子“账本已写、履约前崩溃”的 event_key='' 行；预置扫描游标到 9700（早于逐单路径的 latest-200=9800），日志块 9750 仅扫描命中
  db.prepare("UPDATE orders SET claim_token='', claimed_at=NULL WHERE id=?").run(o.id);
  db.prepare("INSERT INTO payments (order_id, chain, pay_address, tx_hash, event_key, amount, status) VALUES (?, 'BEP20', '0x2222222222222222222222222222222222222222', ?, '', 9.0066, 'verified')").run(o.id, '3'.repeat(64));
  db.prepare("INSERT OR REPLACE INTO scan_cursors (chain, last_block) VALUES (?, ?)").run('BEP20|0x2222222222222222222222222222222222222222', 9700);
  const log = evmLogFor(o, '3'.repeat(64), 9750, '0x7');
  evm.logs = [log];
  evm.receipt = null; // 清空收据：逐单路径不再命中，迫使扫描路径回填 event_key
  evm.latest = 10000;
  const ctx = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx); await ctx.drain();
  const pays = qa('SELECT * FROM payments WHERE tx_hash=?', '3'.repeat(64));
  check('P3-27: scan backfills event_key, exactly one payment row', pays.length === 1 && pays[0].event_key === '0x7', JSON.stringify(pays));
  check('P3-27: order completed after scan backfill', q('SELECT status FROM orders WHERE id=?', o.id).status === 'completed');
  evm.logs = []; evm.receipt = null;
}

// P3-28：ALTER 列已存在则忽略 — 重复迁移幂等，第二次 applied 为空。
{
  r = await call('POST', '/api/admin/migrate', {}, cookie);
  check('P3-28: migrate ok (first)', r.json && r.json.ok === true, JSON.stringify(r.json));
  r = await call('POST', '/api/admin/migrate', {}, cookie);
  check('P3-28: second migrate ok, applied empty', r.json && r.json.ok === true && Array.isArray(r.json.applied) && r.json.applied.length === 0, JSON.stringify(r.json));
  r = await call('GET', '/api/admin/schema-check', null, cookie);
  check('P3-28: schema-check ok', r.json && r.json.ok === true, JSON.stringify(r.json));
}

// P3-29：eth_getLogs 截断时缩小页宽重扫或不推进游标（不挂死、不越过）。
{
  const o = insertOrder({ status: 'pending_payment', pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x8888888888888888888888888888888888888888', actual_amount: 9.0077, contact: freshContact() });
  const curBefore = q("SELECT * FROM scan_cursors WHERE chain=?", 'BEP20|0x8888888888888888888888888888888888888888');
  evm.truncate = true;
  evm.latest = 10000;
  const t0 = Date.now();
  const ctx = makeCtx(); await worker.scheduled({ type: 'cron', cron: '*/1 * * * *' }, env, ctx); await ctx.drain();
  const elapsed = Date.now() - t0;
  evm.truncate = false;
  const curAfter = q("SELECT * FROM scan_cursors WHERE chain=?", 'BEP20|0x8888888888888888888888888888888888888888');
  check('P3-29: truncated scan does not advance cursor', (curBefore ? Number(curBefore.last_block) : 0) === (curAfter ? Number(curAfter.last_block) : 0), 'before=' + JSON.stringify(curBefore) + ' after=' + JSON.stringify(curAfter));
  check('P3-29: truncated scan finishes promptly (no hang)', elapsed < 30000, 'elapsed=' + elapsed + 'ms');
  check('P3-29: order still pending_payment after truncated scan', q('SELECT status FROM orders WHERE id=?', o.id).status === 'pending_payment');
}

// P3-31：卡密导入唯一冲突计入跳过（并发两批同码导入，最终总数 = 码数，双方 OK）。
{
  const pC = q("SELECT * FROM products WHERE title='卡密商品-P1-8'");
  const codes = 'P331-A\nP331-B\nP331-C';
  const beforeCount = q('SELECT COUNT(*) AS c FROM cards WHERE product_id=?', pC.id).c;
  const [i1, i2] = await Promise.all([
    call('POST', '/api/admin/cards/import', { product_id: pC.id, codes }, cookie),
    call('POST', '/api/admin/cards/import', { product_id: pC.id, codes }, cookie),
  ]);
  check('P3-31: concurrent duplicate imports both OK', i1.json && i1.json.ok === true && i2.json && i2.json.ok === true, JSON.stringify(i1.json) + ' ' + JSON.stringify(i2.json));
  const afterCount = q('SELECT COUNT(*) AS c FROM cards WHERE product_id=?', pC.id).c;
  check('P3-31: final card count == before + 3 (duplicates counted as skipped)', afterCount === beforeCount + 3, 'before=' + beforeCount + ' after=' + afterCount);
  const totalAdded = (i1.json.added || 0) + (i2.json.added || 0);
  const totalDuplicate = (i1.json.duplicate || 0) + (i2.json.duplicate || 0);
  check('P3-31: total added == 3, total duplicate == 3', totalAdded === 3 && totalDuplicate === 3, 'added=' + totalAdded + ' duplicate=' + totalDuplicate);
}

// ================= 独立库测试 =================
// P3-20：审计失败不再返回 500 — 全部审计点返回成功 + audit_failed: true + warning，副作用照常提交。
{
  const { db: dbA, env: envA, worker: workerA } = makeEnv();
  const qA = (sql, ...p) => dbA.prepare(sql).get(...p);
  dbA.exec('DROP TABLE admin_audit');
  async function callA(method, p, body, cookieA, extra) {
    const ctx = makeCtx();
    const headers = { 'content-type': 'application/json', 'X-Admin-API': '1', 'CF-Connecting-IP': nextIp() };
    if (cookieA) headers['Cookie'] = cookieA;
    Object.assign(headers, extra || {});
    const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const res = await workerA.fetch(req, envA, ctx);
    await ctx.drain();
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    return { status: res.status, json: j, txt, headers: res.headers };
  }
  function mkCaptchaA(code = 'AB12') {
    const id = 'CAPA' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    dbA.prepare("INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?, ?, datetime('now','+5 minutes'), 0)").run(id, sha256(code));
    return id;
  }
  // 初始化管理员
  let rr = await callA('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
  const ckA = rr.headers.get('set-cookie') || '';
  rr = await callA('POST', '/api/admin/change-password', { old_password: '', new_password: 'admin123' }, ckA);
  // 1) 取消
  dbA.prepare("INSERT INTO orders (order_no, query_password, product_id, status, contact, pay_address, actual_amount) VALUES ('AISAUDIT1', '', 1, 'pending_payment', 'audit1@test.example', '0x5100000000000000000000000000000000000001', 51.0001)").run();
  const oCancel = qA("SELECT * FROM orders WHERE order_no='AISAUDIT1'");
  rr = await callA('POST', '/api/admin/orders/' + oCancel.id + '/cancel', { reason: 'P3-20 cancel' }, ckA);
  check('P3-20: audit failure cancel -> ok + audit_failed + warning', rr.json && rr.json.ok === true && rr.json.audit_failed === true && /审计/.test(rr.json.warning || ''), JSON.stringify(rr.json));
  check('P3-20: audit failure cancel side effect applied', qA('SELECT status FROM orders WHERE id=?', oCancel.id).status === 'cancelled');
  // 2) 确认收款
  dbA.prepare("INSERT INTO orders (order_no, query_password, product_id, status, contact, pay_address, actual_amount, pay_method, pay_chain) VALUES ('AISAUDIT2', '', 1, 'pending_payment', 'audit2@test.example', '0x5100000000000000000000000000000000000002', 51.0002, 'Binance', 'BEP20')").run();
  const oConfirm = qA("SELECT * FROM orders WHERE order_no='AISAUDIT2'");
  rr = await callA('POST', '/api/admin/orders/' + oConfirm.id + '/confirm-payment', { reason: 'P3-20 confirm' , manual_confirm: true }, ckA);
  check('P3-20: audit failure confirm-payment -> ok + audit_failed', rr.json && rr.json.ok === true && rr.json.audit_failed === true && /审计/.test(rr.json.warning || ''), JSON.stringify(rr.json));
  // 3) 发货
  dbA.prepare("INSERT INTO orders (order_no, query_password, product_id, status, contact, pay_address, actual_amount) VALUES ('AISAUDIT3', '', 1, 'pending_fulfill', 'audit3@test.example', '0x5100000000000000000000000000000000000003', 51.0003)").run();
  const oFulfill = qA("SELECT * FROM orders WHERE order_no='AISAUDIT3'");
  rr = await callA('POST', '/api/admin/orders/' + oFulfill.id + '/fulfill', { delivery_content: 'AUDIT-KEY' }, ckA);
  check('P3-20: audit failure fulfill -> ok + audit_failed', rr.json && rr.json.ok === true && rr.json.audit_failed === true && /审计/.test(rr.json.warning || ''), JSON.stringify(rr.json));
  check('P3-20: audit failure fulfill side effect applied', qA('SELECT status FROM orders WHERE id=?', oFulfill.id).status === 'completed');
  // 4) 异常（refund_needed）
  dbA.prepare("INSERT INTO orders (order_no, query_password, product_id, status, contact, pay_address, actual_amount, paid_at) VALUES ('AISAUDIT4', '', 1, 'pending_fulfill', 'audit4@test.example', '0x5100000000000000000000000000000000000004', 51.0004, datetime('now'))").run();
  const oExc = qA("SELECT * FROM orders WHERE order_no='AISAUDIT4'");
  rr = await callA('POST', '/api/admin/orders/' + oExc.id + '/exception', { reason: '审计失败异常测试', refund_needed: true }, ckA);
  check('P3-20: audit failure exception -> ok + audit_failed', rr.json && rr.json.ok === true && rr.json.audit_failed === true && /审计/.test(rr.json.warning || ''), JSON.stringify(rr.json));
  check('P3-20: audit failure exception side effect applied', qA('SELECT status FROM orders WHERE id=?', oExc.id).status === 'refund_pending');
  // 5) 退款确认
  rr = await callA('POST', '/api/admin/orders/' + oExc.id + '/refund-confirm', { refund_ref: 'AUDIT-REF-1' }, ckA);
  check('P3-20: audit failure refund-confirm -> ok + audit_failed', rr.json && rr.json.ok === true && rr.json.audit_failed === true && /审计/.test(rr.json.warning || ''), JSON.stringify(rr.json));
  check('P3-20: audit failure refund-confirm side effect applied', qA('SELECT status FROM orders WHERE id=?', oExc.id).status === 'cancelled');
  // 6) reset-query-password
  dbA.prepare("INSERT INTO orders (order_no, query_password, product_id, status, contact, pay_address, actual_amount) VALUES ('AISAUDIT6', '', 1, 'completed', 'audit6@test.example', '0x5100000000000000000000000000000000000005', 51.0005)").run();
  const oReset = qA("SELECT * FROM orders WHERE order_no='AISAUDIT6'");
  rr = await callA('POST', '/api/admin/orders/' + oReset.id + '/reset-query-password', { new_password: 'audit-new-pw' }, ckA);
  check('P3-20: audit failure reset-query-password -> ok + audit_failed', rr.json && rr.json.ok === true && rr.json.audit_failed === true && /审计/.test(rr.json.warning || ''), JSON.stringify(rr.json));
  check('P3-20: audit failure reset side effect applied (hash set)', !!qA('SELECT query_password_hash FROM orders WHERE id=?', oReset.id).query_password_hash);
}

// P3-30（2026-10-18 整改重定向）：claimTxid INSERT 失败（模拟 D1 临时错误）时不得谎称“已用于其他订单”、不得留孤儿行；
// 失败是临时的，移除障碍后轮询重试应能成功认领（轮询是恢复路径）。
// 人工确认通道现共享 txid_claims（v17），P3-30 仍改走链上 /pay + 轮询路径（claimTxid INSERT 失败语义与人工路径无关）。
// /pay 设计：核验通过但履约失败时走 deferred（auto:false，轮询重试），不把临时失败谎报为“已用于其他订单”。
{
  const { db: dbS, env: envS, worker: workerS } = makeEnv();
  const qS = (sql, ...p) => dbS.prepare(sql).get(...p);
  dbS.exec('CREATE TRIGGER trg_ignore_claim BEFORE INSERT ON txid_claims BEGIN SELECT RAISE(IGNORE); END;');
  async function callS(method, p, body, cookieS) {
    const ctx = makeCtx();
    const headers = { 'content-type': 'application/json', 'X-Admin-API': '1', 'CF-Connecting-IP': nextIp() };
    if (cookieS) headers['Cookie'] = cookieS;
    const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const res = await workerS.fetch(req, envS, ctx);
    await ctx.drain();
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    return { status: res.status, json: j, txt, headers: res.headers };
  }
  function mkCaptchaS(code = 'AB12') {
    const id = 'CAPS' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    dbS.prepare("INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?, ?, datetime('now','+5 minutes'), 0)").run(id, sha256(code));
    return id;
  }
  // /pay 走链上核验，需给隔离库配 mock RPC（否则默认真实 RPC 在 mock 下抛错，/pay 会走 deferred 而非认领分支）。
  dbS.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('rpc_urls', ?)").run(JSON.stringify({ 'X Layer': ['https://mock-xlayer'], 'BEP20': ['https://mock-bsc'] }));
  dbS.prepare("INSERT INTO orders (order_no, query_password, product_id, status, contact, tx_hash, pay_method, pay_chain, pay_address, actual_amount) VALUES ('AISCLAIM30', '', 1, 'pending_payment', 'claim30@test.example', '', 'Binance', 'BEP20', '0x2222222222222222222222222222222222222222', 9.0055)").run();
  const o = qS("SELECT * FROM orders WHERE order_no='AISCLAIM30'");
  const tx30 = 'e'.repeat(64);
  evm.receipt = evmReceiptFor(o, tx30, 100);
  evm.latest = 115; // BEP20 需 15 确认
  const cidS = mkCaptchaS('AB12');
  const rr = await callS('POST', '/api/orders/' + o.order_no + '/pay', { txid: tx30, captcha_id: cidS, captcha_code: 'AB12' });
  check('P3-30: claim failure does NOT falsely report 已用于其他订单', rr.json && !/已用于其他订单/.test(JSON.stringify(rr.json)), JSON.stringify(rr.json));
  check('P3-30: no orphan txid_claims row after failed claim', !qS('SELECT * FROM txid_claims WHERE tx_hash=?', tx30));
  check('P3-30: failed claim leaves order pending (retry possible)', qS('SELECT status FROM orders WHERE id=?', o.id).status === 'pending_payment');
  // 移除障碍 → 轮询重试应成功认领（认领行归属本单），证明临时失败未污染状态。
  dbS.exec('DROP TRIGGER trg_ignore_claim');
  evm.receipt = null;
  evm.logs = [evmLogFor(o, tx30, 100)];
  evm.latest = 115;
  const ctxS = makeCtx();
  await workerS.scheduled({ type: 'cron', cron: '*/1 * * * *' }, envS, ctxS);
  await ctxS.drain();
  check('P3-30: retry after transient failure claims txid for this order', (() => { const t = qS('SELECT * FROM txid_claims WHERE tx_hash=?', tx30); return t && Number(t.order_id) === Number(o.id); })());
  evm.receipt = null; evm.latest = 10000; evm.logs = [];
}

// P2-7：全局锁触发时计数清零（30 次失败来自 6 个 IP，各 5 次；第 7 个 IP 正确密码也被 429 挡）。
{
  const { db: dbG, env: envG, worker: workerG } = makeEnv();
  const qG = (sql, ...p) => dbG.prepare(sql).get(...p);
  async function callG(method, p, body, ip) {
    const ctx = makeCtx();
    const headers = { 'content-type': 'application/json', 'X-Admin-API': '1', 'CF-Connecting-IP': ip };
    const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const res = await workerG.fetch(req, envG, ctx);
    await ctx.drain();
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    return { status: res.status, json: j, txt };
  }
  for (let ip = 1; ip <= 6; ip++) {
    for (let k = 0; k < 5; k++) await callG('POST', '/api/admin/login', { password: 'wrong-pw' }, '10.99.7.' + ip);
  }
  const r7 = await callG('POST', '/api/admin/login', { setup_token: 'test-setup-token' }, '10.99.7.7');
  check('P2-7: 7th IP correct password blocked by global lock -> 429', r7.status === 429 && r7.json && !r7.json.ok, JSON.stringify(r7.json));
  check('P2-7: global fail count reset to 0 at lock', qG("SELECT value FROM admin_meta WHERE key='login_global_fail_count'")?.value === '0', JSON.stringify(qG("SELECT * FROM admin_meta WHERE key='login_global_fail_count'")));
  check('P2-7: blocked_until set in future (ISO datetime string)', (() => { const row = qG("SELECT value FROM admin_meta WHERE key='login_global_blocked_until'"); return row && new Date(String(row.value).replace(' ', 'T') + 'Z').getTime() > Date.now(); })());
}

// ================= 静态断言（文档 / 配置 / 前端细节） =================
const schemaSql = fs.readFileSync(path.join(dir, '..', 'schema.sql'), 'utf8');
const wranglerToml = fs.readFileSync(path.join(dir, '..', 'wrangler.toml'), 'utf8');
const ciYml = fs.readFileSync(path.join(dir, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const prodChecklist = fs.readFileSync(path.join(dir, '..', 'docs', 'PRODUCTION_CHECKLIST.md'), 'utf8');
const runbook = fs.readFileSync(path.join(dir, '..', 'docs', 'RUNBOOK.md'), 'utf8');
const releaseReadiness = fs.readFileSync(path.join(dir, '..', 'docs', 'RELEASE_READINESS.md'), 'utf8');
const prReview = fs.readFileSync(path.join(dir, '..', 'docs', 'PR_REVIEW.md'), 'utf8');
const readme = fs.readFileSync(path.join(dir, '..', 'README.md'), 'utf8');
const securityDoc = fs.readFileSync(path.join(dir, '..', 'docs', 'SECURITY.md'), 'utf8');
const d1LocalSh = fs.readFileSync(path.join(dir, 'd1-local-test.sh'), 'utf8');
const mig0008 = fs.readFileSync(path.join(dir, '..', 'migrations', '0008_payments_scan_cursor_pay_rate.sql'), 'utf8');

// P0-1 / P1-19：wrangler.toml 顶层 [triggers] 含双 cron；ci.yml 断言触发器。
check('P0-1/P1-19: wrangler.toml has top-level [triggers] with both crons before [env.staging]', wranglerToml.includes('[triggers]') && wranglerToml.includes('"0 2 * * *"') && wranglerToml.includes('"*/1 * * * *"') && wranglerToml.indexOf('[triggers]') < wranglerToml.indexOf('[env.staging]'));
check('P0-1/P1-19: ci.yml asserts triggers', ciYml.includes('triggers'));

// P1-14/15/16：schema 口径（结构含 v11–v15，预置版本保持 10；种子仅两链；无 binance_uid 种子）。
check('P1-14: schema.sql has app_icons table', schemaSql.includes('CREATE TABLE IF NOT EXISTS app_icons'));
check('P1-14: schema.sql has query_password_salt + secret_attempts', schemaSql.includes('query_password_salt') && schemaSql.includes('CREATE TABLE IF NOT EXISTS secret_attempts'));
{
  const migLine = schemaSql.split('\n').find((l) => l.includes('INSERT OR IGNORE INTO schema_migrations'));
  check('P1-14: preset versions are exactly (1)-(10), NOT 15', !!migLine && migLine.includes('(1), (2), (3), (4), (5), (6), (7), (8), (9), (10)') && !migLine.includes('(11)'));
}
{
  const seedLine = schemaSql.split('\n').find((l) => l.includes("'usdt_addresses'"));
  check('P1-15: seed usdt_addresses only OKX|X Layer + Binance|BEP20', !!seedLine && seedLine.includes('OKX|X Layer') && seedLine.includes('Binance|BEP20') && !seedLine.includes('TRC20') && !seedLine.includes('ERC20'));
  const noticeLine = schemaSql.split('\n').find((l) => l.includes("'order_notice'"));
  check('P1-15: seed order_notice says 查询密码, not 查单凭证', !!noticeLine && noticeLine.includes('查询密码') && !noticeLine.includes('查单凭证'));
  check('P1-15: no binance_uid seed', !schemaSql.includes("'binance_uid'"));
}
check('P1-16: migrations 0009-0015 exist', ['0009', '0010', '0011', '0012', '0013', '0014', '0015'].every((n) => fs.readdirSync(path.join(dir, '..', 'migrations')).some((f) => f.startsWith(n))));
check('P1-16: migrations README mentions v15', fs.readFileSync(path.join(dir, '..', 'migrations', 'README.md'), 'utf8').includes('v15'));

// P1-17/18：文档口径。
check('P1-17: PRODUCTION_CHECKLIST §C says production deploy needs separate user authorization', prodChecklist.includes('生产部署须用户明确授权') || prodChecklist.includes('生产部署须经用户明确授权'));
check('P1-17: PRODUCTION_CHECKLIST §C does not misdirect to staging script', !prodChecklist.includes('staging 部署脚本'));
check('P1-18: RUNBOOK rollback mentions v8 unique-index caveat + new-table list', runbook.includes('v8') && runbook.includes('唯一索引') && runbook.includes('secret_attempts'));

// P2-19：RELEASE_READINESS 顶部历史快照横幅。
check('P2-19: RELEASE_READINESS starts with history-snapshot banner', releaseReadiness.includes('§一–§八为第四轮历史快照'));

// P2-20：d1-local-test.sh 口径（v18、真实下单 + /secret、精确 COUNT、查询密码术语）。
check('P2-20: d1-local-test.sh comments say v18', d1LocalSh.includes('版本=18') && d1LocalSh.includes('迁移到 v18'));
check('P2-20: d1-local-test.sh has real fresh-DB order + /secret assertions', d1LocalSh.includes('/api/orders/$FRESH_NO/secret') && d1LocalSh.includes('FRESH-DB SECRET OK'));
check('P2-20: d1-local-test.sh dedup uses precise COUNT parse, no grep -o \'1\'', !d1LocalSh.includes("grep -o '1'") && d1LocalSh.includes('DEDUP_COUNT'));
check('P2-20: d1-local-test.sh uses 查询密码 terminology, no 查单凭证', d1LocalSh.includes('查询密码') && !d1LocalSh.includes('查单凭证'));

// P3-32–36：前端静态细节。
check('P3-32: statusLabel unknown status falls back to escH(s)', frontendHtml.includes('return escH(s)'));
check('P3-33: success page uses Number(actual)||0', frontendHtml.includes('Number(o.actual_amount') || frontendHtml.includes('Number(actual'));
check('P3-34: copy buttons use data-copy-target, no onclick copyText-with-id', frontendHtml.includes('data-copy-target') && !frontendHtml.includes('onclick="copyText(document.getElementById'));
check('P3-35: comment says empty password is rejected by backend 401', frontendHtml.includes('空密码由后端 401 拒绝'));
check('P3-36: tutorial link has rel=noopener noreferrer and renders only when tut non-empty', frontendHtml.includes('rel="noopener noreferrer"') && frontendHtml.includes('if (tut)'));

// P3-37：SECURITY.md 记录 qrserver 现状接受。
check('P3-37: SECURITY.md documents qrserver acceptance', securityDoc.includes('qrserver'));

// P3-42：PR_REVIEW 顶部历史记录横幅。
check('P3-42: PR_REVIEW starts with history banner (superseded by v15)', prReview.includes('已被 v15 取代'));

// P3-43：README 表 + 0008 版本记录行。
check('P3-43: README table lists payments / scan_cursors / pay_rate / app_icons / secret_attempts', ['payments', 'scan_cursors', 'pay_rate', 'app_icons', 'secret_attempts'].every((t) => readme.includes(t)));
check('P3-43: migrations/0008 has version-record line', mig0008.includes('INSERT OR IGNORE INTO schema_migrations (version) VALUES (8)'));

// P1-5 前端：手动发货 / 退款确认弹窗有“已在上游后台作废该上游订单”复选框。
check('P1-5 frontend: fulfill modal has upstream-voided checkbox', frontendHtml.includes('fulfillVoided') && frontendHtml.includes('已在上游后台作废该上游订单'));
check('P1-5 frontend: refund modal has upstream-voided checkbox', frontendHtml.includes('refundVoided') && frontendHtml.includes('已在上游后台作废该上游订单'));

// P2-5：genCaptchaSVG 未改动（仍为 <text> 渲染；Turnstile fail-closed 已由 security-test 覆盖）。
check('P2-5: genCaptchaSVG still renders <text>', workerCode.includes('genCaptchaSVG') && workerCode.includes('<text'));

// ================= 浏览器复验回归（2026-10-17 staging）：/query 返回 actual_amount + 商城每次进入重拉商品 =================
// 缺陷：/query 手写字段映射漏了 actual_amount，查询页回退到 total_usdt，与成功页精确应付不一致；买家按查询页金额付款会导致链上匹配失败。
{
  r = await call('POST', '/api/admin/products', { title: '手动商品-复验金额', category: 'recharge', stock_type: 'manual', sell_price: 5, source: 'self' }, cookie);
  const pAmt = q("SELECT * FROM products WHERE title='手动商品-复验金额'");
  r = await orderCall({ product_id: pAmt.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: freshContact() }, contact: freshContact() });
  check('reverify: order created', r.json && r.json.ok === true, JSON.stringify(r.json));
  const created = r.json && r.json.order ? r.json.order : {};
  const actualAmt = Number(created.actual_amount);
  check('reverify: create returns actual_amount > total_usdt (random tail)', Number.isFinite(actualAmt) && actualAmt > Number(created.total_usdt), JSON.stringify(created));
  const cidQ = mkCaptcha('AB12');
  r = await call('POST', '/api/orders/query', { keywords: created.order_no, captcha_id: cidQ, captcha_code: 'AB12' });
  const listed = r.json && r.json.orders && r.json.orders[0];
  check('reverify: /query returns actual_amount equal to create response', !!listed && Number(listed.actual_amount) === actualAmt, JSON.stringify(r.json));
  check('reverify: /query pending_payment carries pay_address', !!listed && typeof listed.pay_address === 'string' && listed.pay_address.length > 0, JSON.stringify(listed));
  check('reverify: /query returns expires_at equal to create response', !!listed && listed.expires_at === created.expires_at, JSON.stringify(r.json));
}
// 付款界面优化（BEpusdt 式）：成功页 + 查询页共用 payBlockHTML；倒计时时分秒 + 过期态；QR 带 USDT 标（ecc=H）。
{
  check('payui: payBlockHTML shared by success + query pages', frontendHtml.includes('function payBlockHTML') && frontendHtml.includes("payBlockHTML(o, 'success')") && frontendHtml.includes('payBlockHTML(o, o.order_no)'));
  check('payui: amount header + exact-pay pill', frontendHtml.includes('pay-amount-usdt') && frontendHtml.includes('请严格按照数额进行付款'));
  check('payui: absolute expiry + merchant order + copy', frontendHtml.includes('fmtExpiryAbsolute') && frontendHtml.includes('到期时间') && frontendHtml.includes('商户订单'));
  check('payui: QR with USDT mark + ecc=H', frontendHtml.includes('pay-qr-logo') && frontendHtml.includes('ecc=H'));
  check('payui: address head/tail highlight', frontendHtml.includes('payAddrHighlighted') && frontendHtml.includes('pay-addr-hl'));
  check('payui: countdown clock format + expired state', frontendHtml.includes("mm + ':' + ss") && frontendHtml.includes('已过期，请重新下单'));
  // fmtCountdown 功能测试：从前端源码提取函数真跑（时钟格式 MM:SS / H:MM:SS，过期态）。
  // P3-19（harness 修复）：fmtCountdown 依赖同文件 parseExpiry，须一并提取并注入，否则 eval 报 parseExpiry is not defined。
  {
    const feStartP = frontendHtml.indexOf('function parseExpiry(');
    let feIP = frontendHtml.indexOf('{', feStartP), feDepthP = 0, feJP = feIP;
    for (; feJP < frontendHtml.length; feJP++) { if (frontendHtml[feJP] === '{') feDepthP++; else if (frontendHtml[feJP] === '}') { feDepthP--; if (feDepthP === 0) break; } }
    const parseExpiryFn = new Function('return (' + frontendHtml.slice(feStartP, feJP + 1) + ')')();
    const feStart = frontendHtml.indexOf('function fmtCountdown(');
    let feI = frontendHtml.indexOf('{', feStart), feDepth = 0, feJ = feI;
    for (; feJ < frontendHtml.length; feJ++) { if (frontendHtml[feJ] === '{') feDepth++; else if (frontendHtml[feJ] === '}') { feDepth--; if (feDepth === 0) break; } }
    const fmtCountdownFn = new Function('parseExpiry', 'return (' + frontendHtml.slice(feStart, feJ + 1) + ')')(parseExpiryFn);
    const isoPlus = (ms) => new Date(Date.now() + ms).toISOString().replace('T', ' ').slice(0, 19);
    check('payui: fmtCountdown 20min -> MM:SS', /^\d{2}:\d{2}$/.test(fmtCountdownFn(isoPlus(20 * 60 * 1000))), fmtCountdownFn(isoPlus(20 * 60 * 1000)));
    check('payui: fmtCountdown 70min -> H:MM:SS', /^\d+:\d{2}:\d{2}$/.test(fmtCountdownFn(isoPlus(70 * 60 * 1000))), fmtCountdownFn(isoPlus(70 * 60 * 1000)));
    check('payui: fmtCountdown expired -> 已过期', fmtCountdownFn(isoPlus(-60 * 1000)) === '已过期，请重新下单');
    check('payui: fmtCountdown Z-suffixed ISO -> MM:SS', /^\d{2}:\d{2}$/.test(fmtCountdownFn(new Date(Date.now() + 20 * 60 * 1000).toISOString())));
    check('payui: fmtCountdown +08:00 ISO -> MM:SS (P3-19 no double Z)', /^\d{2}:\d{2}$/.test(fmtCountdownFn(new Date(Date.now() + 20 * 60 * 1000 + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00'))));
    check('payui: fmtCountdown invalid -> 时间格式错误', fmtCountdownFn('not-a-date') === '时间格式错误');
    // fmtCountdownLine：正常带“剩余”前缀，过期不带（避免“剩余已过期”）。
    const feStart2 = frontendHtml.indexOf('function fmtCountdownLine(');
    let feI2 = frontendHtml.indexOf('{', feStart2), feDepth2 = 0, feJ2 = feI2;
    for (; feJ2 < frontendHtml.length; feJ2++) { if (frontendHtml[feJ2] === '{') feDepth2++; else if (frontendHtml[feJ2] === '}') { feDepth2--; if (feDepth2 === 0) break; } }
    const fmtLineFn = new Function('fmtCountdown', 'return (' + frontendHtml.slice(feStart2, feJ2 + 1) + ')')(fmtCountdownFn);
    check('payui: fmtCountdownLine 20min -> 剩余 MM:SS', /^剩余 \d{2}:\d{2}$/.test(fmtLineFn(isoPlus(20 * 60 * 1000))), fmtLineFn(isoPlus(20 * 60 * 1000)));
    check('payui: fmtCountdownLine expired -> 仅过期态', fmtLineFn(isoPlus(-60 * 1000)) === '已过期，请重新下单');
  }
  check('payui: BEpusdt layout classes', ['pay-shell', 'pay-toprow', 'pay-deadline', 'pay-deadline-abs', 'pay-deadline-left', 'pay-deadline-expired', 'pay-div', 'pay-row', 'pay-qr-box', 'pay-addrbox', 'pay-copy'].every((c) => frontendHtml.includes(c)));
  // QR 中间标按链换品牌：X Layer → OKX 方块标，BEP20 → 币安菱形标。
  check('payui: QR logo wired by chain', frontendHtml.includes('payQrLogoHTML(o.pay_chain'));
  {
    const qStart = frontendHtml.indexOf('function payQrLogoHTML(');
    let qI = frontendHtml.indexOf('{', qStart), qDepth = 0, qJ = qI;
    for (; qJ < frontendHtml.length; qJ++) { if (frontendHtml[qJ] === '{') qDepth++; else if (frontendHtml[qJ] === '}') { qDepth--; if (qDepth === 0) break; } }
    const qrLogoFn = new Function('return (' + frontendHtml.slice(qStart, qJ + 1) + ')')();
    check('payui: QR logo X Layer -> OKX', qrLogoFn('X Layer').includes('data-logo="okx"') && qrLogoFn('X Layer').includes('#111111'));
    check('payui: QR logo BEP20 -> Binance', qrLogoFn('BEP20').includes('data-logo="binance"') && qrLogoFn('BEP20').includes('#F0B90B'));
    check('payui: QR logo other -> USDT fallback', qrLogoFn('').includes('data-logo="usdt"'));
  }
  // 防类名碰撞回归：商品页支付方式卡早已占用 .pay-card（含 margin:6px 0），成功页窄卡必须用独立类名 .pay-shell，否则居中会被后定义的 .pay-card 覆盖。
  check('payui: success card uses pay-shell not pay-card', frontendHtml.includes('glass pay-shell') && !frontendHtml.includes('glass pay-card'));
  // 首页 Hero + 合集标题（prodseller 版式，本站品牌与文案；不出现对方品牌）。
  check('home: hero present with key copy', frontendHtml.includes('function homeHeroHTML(') && ['无限可能', '更实惠的价格', '探索 <span>↗</span>', '智选 ↗', '创造', '放松', '发现'].every((s) => frontendHtml.includes(s)) && !frontendHtml.includes('探索系列'));
  // 探索按钮滑到付款提示行/搜索栏（截图位置），而非直接跳商品网格；scroll-margin 避开吸顶导航遮挡。
  check('home: explore scrolls to browse anchor', frontendHtml.includes('id="shopBrowse"') && frontendHtml.includes("getElementById(\\x27shopBrowse\\x27)") && frontendHtml.includes('#shopBrowse{scroll-margin-top:72px}'));
  check('home: hero rendered on shop page', frontendHtml.includes('homeHeroHTML()') && frontendHtml.includes('homeSectionHeadHTML()'));
  check('home: section head copy + back-to-top', frontendHtml.includes('日常生活，升级版') && frontendHtml.includes('返回顶部 ↑') && !frontendHtml.includes('返回收藏夹'));
  // 合集标题在最底：商品网格下方、紧贴底部声明上方（声明在 #app 之外的页脚，标题是 #app 内最后一个块）。
  check('home: section head below grid (above footer)', frontendHtml.includes('id="list" class="grid shop-grid"></div>\' + homeSectionHeadHTML()'));
  // 新增配色与线条图标同色（.ic 蓝 #5b7bff 同色系），不留 #7c3aed 系紫色。
  check('home: accent matches line-icon blue', frontendHtml.includes('.home-h1-accent{color:#5b7bff}') && frontendHtml.includes('.home-cta{border:0;background:#5b7bff') && !/#7c3aed|#a78bfa|#6d28d9|#5b21b6/.test(frontendHtml));
  // 芯片符号用实心（▲/▶）：空心 △/▷ 在小字号 + 低对比下肉眼几乎看不见，用户反馈“不显示”。
  check('home: chips use solid glyphs', frontendHtml.includes('▲ <span>创造</span>') && frontendHtml.includes('▶ <span>放松</span>'));
  // TXID 可选：空着提交不该报长度错误——前端拦截提示 + 后端友好报错（纵深防御）。
  check('pay: empty TXID guarded client + server', frontendHtml.includes('请先填写 TXID（不填可直接等待自动发货）') && workerCode.includes('请填写 TXID（不填可直接等待自动发货）'));
  // 移动端商品卡（用户要求）：名称 10px（同卡片智选渲染尺寸），介绍 8px（同“更多选择，尽在一处。”），卡片适当缩小（内边距/图区边距/底部间距/网格间距）；同类推荐复用 productCard，同款处理；其余（价格/按钮/库存状态）不变。
  check('shop: mobile card title/desc sizes + shrink', frontendHtml.includes('.pcard-title{font-size:10px') && frontendHtml.includes('.pcard-desc{font-size:8px') && frontendHtml.includes('.pcard{padding:10px}') && frontendHtml.includes('.shop-grid{gap:10px}') && frontendHtml.includes('relHtml += productCard(rel[ri])'));
  check('home: mobile hero is row layout', frontendHtml.includes('.home-hero{flex-direction:row;gap:12px;padding:16px;align-items:flex-start}') && frontendHtml.includes('.home-visual{flex:0 0 156px;height:119px;min-width:0}') && frontendHtml.includes('.home-visual-scale{width:420px;height:320px;transform:scale(0.37)') && frontendHtml.includes('<div class="home-visual"><div class="home-visual-scale">') && frontendHtml.includes('.home-h1{font-size:10px}') && frontendHtml.includes('.home-cta{font-size:10px;padding:6px 12px}') && frontendHtml.includes('.home-sub{font-size:8px') && frontendHtml.includes('.home-eyebrow{font-size:8px') && frontendHtml.includes('.home-note{font-size:8px') && !frontendHtml.includes('.home-visual-ring{display:none}') && !frontendHtml.includes('.home-pcard{width:calc(100% - 8px)') && !frontendHtml.includes('.home-visual-cap{display:none}'));
  // 查单：订单号或下单邮箱双查（用户 2026-10-17 明确要求，取代 v15“邮箱查询禁用”）；卡密仍走 /secret + 查询密码。
  check('query: order no or email', workerCode.includes('LOWER(contact) = ?') && frontendHtml.includes('订单号或下单邮箱') && frontendHtml.includes('输入订单号或下单邮箱查询订单'));
  check('home: mobile section title fits one line', frontendHtml.includes('.home-section-title{font-size:20px}') && frontendHtml.includes('.home-section-star{font-size:22px}'));
  check('home: desktop hero/title fonts unchanged', frontendHtml.includes('.home-hero{display:flex;gap:24px;align-items:center;justify-content:space-between;background:var(--card2);border:1px solid var(--line);border-radius:28px;padding:36px 36px 28px') && frontendHtml.includes('.home-section-title{font-size:26px'));
  {
    const heroStart = frontendHtml.indexOf('function homeHeroHTML(');
    const headEnd = frontendHtml.indexOf('function filterStock(', heroStart);
    check('home: no prodseller brand in homepage blocks', !/prodseller/i.test(frontendHtml.slice(heroStart, headEnd)));
  }
  // CI 浏览器验收测试断言与实现一致（防 4 个过期断言复发；均为测试侧修法，产品行为不动）：
  // ① 地址复制按钮 title 是“复制地址”（标签“收款地址”另起），测试不得断言连写“复制收款地址”；
  // ② 持久化字段走详情接口（列表 summary 级删 contact/customer_fields）；
  // ③ console 过滤预期 400（/secret 密码正确但未付款 → “尚未付款”）。
  {
    const ciTest = fs.readFileSync(path.join(dir, 'browser-acceptance-ci.mjs'), 'utf8');
    check('ci: pay-address check uses real copy title', ciTest.includes('data-copy-target="addrBox-') && !ciTest.includes('复制收款地址'));
    check('ci: persisted check uses admin detail endpoint', ciTest.includes("'/api/admin/orders/' + first.id"));
    check('ci: console filter excludes expected 400', ciTest.includes("if (text.includes('400')) return;"));
  }
  // 防重复 ID：查单详情（renderQueryOrderDetail）渲染在查询列表卡片内的 qsec 盒子里；
  // 旧订单待付款时列表卡与详情会各出一份付款块，UID 必须不同，否则 countdown/addrBox 等 ID 重复。
  {
    const detStart = frontendHtml.indexOf('function renderQueryOrderDetail(');
    const detSrc = frontendHtml.slice(detStart, frontendHtml.indexOf('function ', detStart + 10) >= 0 ? frontendHtml.indexOf('function ', detStart + 10) : frontendHtml.length);
    check('payui: query detail uses distinct -detail uid', detSrc.includes("payBlockHTML(o, o.order_no + '-detail')"));
  }
  // payTokenLabel 已含链名（'USDT0 · X Layer'），小字行不得再追加一次 pay_chain（payQrLogoHTML 另有一处 o.pay_chain 调用是正常的，不计入）。
  const payBlockSrc = frontendHtml.slice(frontendHtml.indexOf('function payBlockHTML'), frontendHtml.indexOf('function payBlockHTML') + 2500);
  const subLine = (payBlockSrc.match(/pay-amount-sub.*/) || [''])[0];
  check('payui: amount sub-line has no duplicated chain', (subLine.match(/o\.pay_chain/g) || []).length === 1);
}
// 前端：renderShop 每次进入重拉 /api/products（PRODUCTS 只在 load() 取一次，下单后 SPA 内导航回商城会显示过期库存计数）。
{
  const shopIdx = frontendHtml.indexOf('function renderShop()');
  const shopSlice = shopIdx >= 0 ? frontendHtml.slice(shopIdx, shopIdx + 3000) : '';
  check('reverify: renderShop refetches /api/products on every entry', shopSlice.includes("api('/api/products')"));
  check('reverify: renderShop refetch falls back to stale data on failure', shopSlice.includes('.catch'));
}

// ================= 汇总 =================
console.log('\nreview-fixes: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) { console.log('Failures:'); for (const f of failures) console.log(' - ' + f); process.exit(1); }
