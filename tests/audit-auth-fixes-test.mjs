// 鉴权安全线审计修复回归测试（2026-10-30，分支 audit-auth，全部 dummy/mock，不连真实接口）
// 覆盖任务书 11 项中的代码改动（建站令牌轮换、GET 摘要验证码口径为报告项，不在本文件断言）：
//  1. /pay 未核验候选写入前必须校验查询密码（PBKDF2，与 /secret 同口径），缺/错 → 401 且不写 pending_tx_hash。
//  2. 审计补齐：成功登录、改密、卡密禁用/删除、商品编辑（PUT）、7 天清理、迁移执行均有审计行，且不含密码/完整卡密。
//  3. 会话令牌只存 SHA-256 摘要：登录存摘要、鉴权按摘要比对、退出按摘要删除、改密按摘要作废其他会话；老会话失效是预期行为。
//  4. 遗留凭证：管理员重置接口可为 v14 无 salt 哈希 / 明文遗留订单重设查询密码（写 salted 哈希并清空明文与旧凭证哈希），重置后 /secret 可用新密码通过认证。
//  7. 按单限流改为按单+IP 双维：/secret、/lookup、/pay 均是“同单同 IP 5 次 + 同单跨 IP 总量 20 次”，单 IP 再也刷不满整单配额；成功路径清零按单计数（/secret、/lookup 已有，/pay 新增）。
//  8. HSTS 含 includeSubDomains；CSP unsafe-inline 为接受的取舍（仅断言响应头现状，不改渲染）。
//  9. 登录错误文案统一为“登录凭证错误”，不区分是否已设密码 / 令牌错误。
//  10. 管理端与公开接口响应均不得出现 Access-Control-Allow-Origin。
//  11. 设置写入口白名单：未知键（含 __proto__）一律拒绝入库。
// 运行：node tests/audit-auth-fixes-test.mjs
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
async function mockFetch(url, opts = {}) {
  const u = String(url); const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('prodseller.com')) return new Response(JSON.stringify({}), { status: 200 });
  if (u.includes('api.resend.com')) return new Response(JSON.stringify({ id: 'mock-mail' }), { status: 200 });
  if (u.includes('mock-xlayer') || u.includes('mock-bsc')) {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (body && body.method === 'eth_chainId') {
      const id = u.includes('mock-bsc') ? '0x38' : '0xc4';
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: id }), { status: 200 });
    }
    if (body && body.method === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10000' }), { status: 200 });
    if (body && body.method === 'eth_call') {
      const to = String((body.params && body.params[0] && body.params[0].to) || '').toLowerCase();
      const dec = to === USDT0_XLAYER.toLowerCase() ? 6 : 18;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + dec.toString(16).padStart(64, '0') }), { status: 200 });
    }
    if (body && body.method === 'eth_getTransactionReceipt') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
    if (body && body.method === 'eth_getLogs') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
  }
  return new Response(JSON.stringify({}), { status: 200 });
}
globalThis.fetch = mockFetch;
const env = {
  DB: { prepare: (sql) => wrapStmt(sql), async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } },
  ZHIXUAN_SETUP_TOKEN: 'dummy-setup-token-for-test-only',
  PRODSELLER_API_KEY: 'dummy-key-for-test-only',
  PRODSELLER_BASE_URL: 'https://prodseller.com/v1',
  __fetch: mockFetch,
};
let code = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
code = code.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(html) + ';');
code = code.replace('export default {', 'globalThis.__W = {');
const worker = new Function(code + '\nreturn globalThis.__W;')();
function makeCtx() { const c = { pending: [] }; c.waitUntil = (pr) => { c.pending.push(pr); }; c.drain = async () => { while (c.pending.length) { const batch = c.pending.splice(0); await Promise.all(batch.map((x) => x.catch(() => {}))); } }; return c; }
async function callRaw(method, p, rawBody, cookie, extraHeaders) {
  const ctx = makeCtx();
  const headers = { 'content-type': 'application/json', 'X-Admin-API': '1', ...(extraHeaders || {}) };
  if (cookie) headers.Cookie = cookie;
  const req = new Request('http://test' + p, { method, headers, body: rawBody });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: res.status, json: j, text: txt, headers: res.headers };
}
async function call(method, p, body, cookie, extraHeaders) {
  return callRaw(method, p, body ? JSON.stringify(body) : undefined, cookie, extraHeaders);
}
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); } console.log('PASS: ' + msg); }
function q(sql, ...a) { return db.prepare(sql).get(...a); }
function qa(sql, ...a) { return db.prepare(sql).all(...a); }
function setSetting(key, value) { db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
let capSeq = 0;
function mkCaptcha(codeStr) {
  const id = 'cap-audit-' + (++capSeq);
  const h = createHash('sha256').update(codeStr).digest('hex');
  const exp = new Date(Date.now() + 300000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?,?,0)').run(id, h, exp);
  return id;
}
let contactSeq = 0;
function freshContact() { return 'audit' + (++contactSeq) + '@test.example'; }
async function orderCall(productId, pw) {
  const cid = mkCaptcha('AB12');
  db.prepare('DELETE FROM order_rate').run();
  const c = freshContact();
  return call('POST', '/api/orders', { product_id: productId, quantity: 1, contact: c, query_password: pw || 'audit-test-pw', pay_method: 'OKX', pay_chain: 'X Layer', captcha_id: cid, captcha_code: 'AB12' });
}
async function payCall(orderNo, txid, extraBody, extraHeaders) {
  const cid = mkCaptcha('AB12');
  return call('POST', '/api/orders/' + encodeURIComponent(orderNo) + '/pay', { txid, captcha_id: cid, captcha_code: 'AB12', ...(extraBody || {}) }, null, extraHeaders);
}
function cookieOf(res) { return (res.headers.get('set-cookie') || '').split(';')[0]; }
function tokenOf(cookie) { return String(cookie || '').split(';')[0].split('=')[1] || ''; }

// ---- 基础设置（dummy 地址与 mock RPC）----
setSetting('usdt_addresses', JSON.stringify({ 'OKX|X Layer': ADDR_OKX, 'Binance|BEP20': ADDR_BIN }));
setSetting('rpc_urls', JSON.stringify({ 'X Layer': ['https://mock-xlayer'], 'BEP20': ['https://mock-bsc'] }));
setSetting('chain_confirmations', JSON.stringify({ 'X Layer': 1, 'BEP20': 15 }));
setSetting('poll_enabled', '1');
setSetting('prodseller_enabled', '0');

// ===== 9. 登录错误文案统一：建站令牌错误不得与密码错误区分 =====
let r = await call('POST', '/api/admin/login', { setup_token: 'dummy-wrong-token' });
assert(r.status === 401 && r.json && r.json.error === '登录凭证错误', 'login: wrong setup token -> unified 登录凭证错误: ' + JSON.stringify(r.json));

// ===== 3+2. 建站令牌登录成功：会话只存摘要 + 登录审计 =====
r = await call('POST', '/api/admin/login', { setup_token: 'dummy-setup-token-for-test-only' });
assert(r.json && r.json.ok && r.json.must_change_password === true, 'login: setup token login ok + must_change: ' + JSON.stringify(r.json));
let cookieA = cookieOf(r);
assert(cookieA && tokenOf(cookieA), 'login: set-cookie issued');
{
  const rawTok = tokenOf(cookieA);
  const digest = createHash('sha256').update(rawTok).digest('hex');
  const sess = q('SELECT * FROM sessions WHERE token=?', digest);
  assert(!!sess, 'session: DB row exists under SHA-256 digest of token');
  assert(!q('SELECT * FROM sessions WHERE token=?', rawTok), 'session: raw token is NOT stored in DB');
  const me = await call('GET', '/api/admin/me', null, cookieA);
  assert(me.json && me.json.ok, 'session: digest lookup authenticates cookie: ' + JSON.stringify(me.json));
  assert(qa("SELECT * FROM admin_audit WHERE action='admin_login'").length >= 1, 'audit: admin_login row exists after successful login');
  const note = q("SELECT note FROM admin_audit WHERE action='admin_login' ORDER BY id DESC").note || '';
  assert(!note.includes(rawTok) && !note.includes('dummy-setup-token'), 'audit: admin_login note contains no token');
}

// ===== 2. 改密审计 + 3. 改密按摘要作废其他会话 =====
r = await call('POST', '/api/admin/change-password', { old_password: '', new_password: 'admin-pw-one' }, cookieA);
assert(r.json && r.json.ok, 'change-password: first change ok: ' + JSON.stringify(r.json));
assert(qa("SELECT * FROM admin_audit WHERE action='admin_change_password'").length >= 1, 'audit: admin_change_password row exists');
{
  const note = q("SELECT note FROM admin_audit WHERE action='admin_change_password' ORDER BY id DESC").note || '';
  assert(!note.includes('admin-pw-one'), 'audit: change-password note contains no password');
}
r = await call('POST', '/api/admin/login', { password: 'wrong-pw-123' });
assert(r.status === 401 && r.json && r.json.error === '登录凭证错误', 'login: wrong password -> unified 登录凭证错误: ' + JSON.stringify(r.json));
r = await call('POST', '/api/admin/login', { password: '' });
assert(r.status === 401 && r.json && r.json.error === '登录凭证错误', 'login: empty password (hash set) -> unified 登录凭证错误: ' + JSON.stringify(r.json));
r = await call('POST', '/api/admin/login', { password: 'admin-pw-one' });
assert(r.json && r.json.ok, 'login: correct password ok');
let cookieB = cookieOf(r);
r = await call('POST', '/api/admin/change-password', { old_password: 'admin-pw-one', new_password: 'admin-pw-two' }, cookieA);
assert(r.json && r.json.ok, 'change-password: second change ok (via cookieA)');
{
  const meB = await call('GET', '/api/admin/me', null, cookieB);
  assert(meB.status === 401, 'session: other session revoked by change-password (digest delete): ' + JSON.stringify(meB.json));
  const meA = await call('GET', '/api/admin/me', null, cookieA);
  assert(meA.json && meA.json.ok, 'session: current session survives change-password');
}
// ===== 3. 退出按摘要删除 =====
r = await call('POST', '/api/admin/logout', {}, cookieA);
assert(r.json && r.json.ok, 'logout ok');
{
  const digestA = createHash('sha256').update(tokenOf(cookieA)).digest('hex');
  assert(!q('SELECT * FROM sessions WHERE token=?', digestA), 'session: logout deleted row by digest');
  const meA2 = await call('GET', '/api/admin/me', null, cookieA);
  assert(meA2.status === 401, 'session: logged-out cookie no longer authenticates');
}
r = await call('POST', '/api/admin/login', { password: 'admin-pw-two' });
assert(r.json && r.json.ok, 'login: re-login with new password ok');
let cookie = cookieOf(r);

// ===== 商品 + 卡密准备 =====
r = await call('POST', '/api/admin/products', { slug: 'audit-card', title: 'Audit Card', category: 'card', price_usdt: 10, sell_price: 10, source: 'self', delivery_method: 'both', stock_type: 'card', form_fields: [] }, cookie);
assert(r.json && r.json.ok, 'create card product: ' + JSON.stringify(r.json));
const cardProd = q('SELECT * FROM products WHERE slug=?', 'audit-card');
for (let i = 1; i <= 30; i++) db.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(cardProd.id, 'AUDIT-KEY-' + String(i).padStart(3, '0'));

// ===== 2. 商品编辑（PUT）审计 =====
r = await call('PUT', '/api/admin/products/' + cardProd.id, { slug: 'audit-card', title: 'Audit Card Edited', category: 'card', price_usdt: 10, sell_price: 10, source: 'self', delivery_method: 'both', stock_type: 'card', form_fields: [] }, cookie);
assert(r.json && r.json.ok, 'product PUT ok: ' + JSON.stringify(r.json));
assert(qa("SELECT * FROM admin_audit WHERE action='product_update'").length >= 1, 'audit: product_update row exists after PUT');

// ===== 2. 卡密禁用/删除审计（不记卡密正文）=====
db.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').run(cardProd.id, 'AUDIT-SECRET-CODE-XYZ');
const auditCard = q("SELECT * FROM cards WHERE code='AUDIT-SECRET-CODE-XYZ'");
r = await call('POST', '/api/admin/cards/' + auditCard.id + '/disable', { disabled: 1 }, cookie);
assert(r.json && r.json.ok, 'card disable ok: ' + JSON.stringify(r.json));
{
  const row = q("SELECT * FROM admin_audit WHERE action='card_disable' ORDER BY id DESC");
  assert(!!row && !String(row.note || '').includes('AUDIT-SECRET-CODE-XYZ'), 'audit: card_disable row exists and note has no card code');
}
r = await call('DELETE', '/api/admin/cards/' + auditCard.id, null, cookie);
assert(r.json && r.json.ok, 'card delete ok: ' + JSON.stringify(r.json));
{
  const row = q("SELECT * FROM admin_audit WHERE action='card_delete' ORDER BY id DESC");
  assert(!!row && !String(row.note || '').includes('AUDIT-SECRET-CODE-XYZ'), 'audit: card_delete row exists and note has no card code');
}

// ===== 1. /pay 未核验候选写入必须先校验查询密码 =====
r = await orderCall(cardProd.id);
assert(r.json && r.json.ok, 'pay-gate: order created: ' + JSON.stringify(r.json));
const payOrderNo = r.json.order.order_no;
const TX_P = 'd'.repeat(64);
r = await payCall(payOrderNo, TX_P);
assert(r.status === 401 && r.json && r.json.error === '查询密码错误', 'pay-gate: no query_password -> 401: ' + JSON.stringify(r.json));
assert(q('SELECT pending_tx_hash FROM orders WHERE order_no=?', payOrderNo).pending_tx_hash === '', 'pay-gate: no candidate written without password');
r = await payCall(payOrderNo, TX_P, { query_password: 'wrong-pw-123' });
assert(r.status === 401 && r.json && r.json.error === '查询密码错误', 'pay-gate: wrong query_password -> 401: ' + JSON.stringify(r.json));
assert(q('SELECT pending_tx_hash FROM orders WHERE order_no=?', payOrderNo).pending_tx_hash === '', 'pay-gate: no candidate written with wrong password');
r = await payCall(payOrderNo, TX_P, { query_password: 'audit-test-pw' });
assert(r.json && r.json.ok === true && r.json.auto === false, 'pay-gate: correct query_password -> unverified ok auto:false: ' + JSON.stringify(r.json));
assert(q('SELECT pending_tx_hash FROM orders WHERE order_no=?', payOrderNo).pending_tx_hash === TX_P, 'pay-gate: candidate written with correct password');
r = await payCall(payOrderNo, 'e'.repeat(64), { query_password: 'wrong-pw-123' });
assert(r.status === 401, 'pay-gate: wrong password does not overwrite existing candidate');
assert(q('SELECT pending_tx_hash FROM orders WHERE order_no=?', payOrderNo).pending_tx_hash === TX_P, 'pay-gate: existing candidate preserved after wrong-password attempt');

// ===== 7. /secret 双维：同单同 IP 5 次满后 429，同单换 IP 不受牵连 =====
r = await orderCall(cardProd.id);
assert(r.json && r.json.ok, 'secret-dual: order created');
const secNo = r.json.order.order_no;
{
  let last = null;
  for (let i = 0; i < 5; i++) last = await call('POST', '/api/orders/' + secNo + '/secret', { password: 'wrong-pw-123' }, null, { 'CF-Connecting-IP': '10.1.1.1' });
  assert(last.status === 401, 'secret-dual: 5 wrong attempts from IP-A are 401, not 429');
  last = await call('POST', '/api/orders/' + secNo + '/secret', { password: 'wrong-pw-123' }, null, { 'CF-Connecting-IP': '10.1.1.1' });
  assert(last.status === 429, 'secret-dual: 6th attempt from same IP -> 429: ' + JSON.stringify(last.json));
  last = await call('POST', '/api/orders/' + secNo + '/secret', { password: 'wrong-pw-123' }, null, { 'CF-Connecting-IP': '10.2.2.2' });
  assert(last.status === 401, 'secret-dual: first attempt from IP-B is 401, not blocked by IP-A quota: ' + JSON.stringify(last.json));
}

// ===== 7. /lookup 双维：同理 =====
r = await orderCall(cardProd.id);
assert(r.json && r.json.ok, 'lookup-dual: order created');
const lookNo = r.json.order.order_no;
{
  let last = null;
  for (let i = 0; i < 5; i++) { const cid = mkCaptcha('AB12'); last = await call('POST', '/api/orders/' + lookNo + '/lookup', { credential: 'wrong-pw-123', captcha_id: cid, captcha_code: 'AB12' }, null, { 'CF-Connecting-IP': '10.3.3.3' }); }
  assert(last.status === 401, 'lookup-dual: 5 wrong attempts from IP-A are 401');
  const cid6 = mkCaptcha('AB12');
  last = await call('POST', '/api/orders/' + lookNo + '/lookup', { credential: 'wrong-pw-123', captcha_id: cid6, captcha_code: 'AB12' }, null, { 'CF-Connecting-IP': '10.3.3.3' });
  assert(last.status === 429, 'lookup-dual: 6th attempt from same IP -> 429: ' + JSON.stringify(last.json));
  const cidB = mkCaptcha('AB12');
  last = await call('POST', '/api/orders/' + lookNo + '/lookup', { credential: 'wrong-pw-123', captcha_id: cidB, captcha_code: 'AB12' }, null, { 'CF-Connecting-IP': '10.4.4.4' });
  assert(last.status === 401, 'lookup-dual: first attempt from IP-B is 401, not blocked by IP-A quota');
}

// ===== 7. /pay 双维：同单同 IP 5 次满后 429，同单换 IP 不受牵连 =====
r = await orderCall(cardProd.id);
assert(r.json && r.json.ok, 'pay-dual: order created');
const payDualNo = r.json.order.order_no;
{
  let last = null;
  for (let i = 0; i < 5; i++) last = await payCall(payDualNo, 'f'.repeat(60) + String(i).padStart(4, '0'), { query_password: 'audit-test-pw' }, { 'CF-Connecting-IP': '10.5.5.5' });
  assert(last.json && last.json.ok === true && last.json.auto === false, 'pay-dual: 5 unverified submissions from IP-A ok auto:false');
  last = await payCall(payDualNo, 'f'.repeat(64), { query_password: 'audit-test-pw' }, { 'CF-Connecting-IP': '10.5.5.5' });
  assert(last.status === 429, 'pay-dual: 6th submission from same IP -> 429: ' + JSON.stringify(last.json));
  last = await payCall(payDualNo, 'f'.repeat(64), { query_password: 'audit-test-pw' }, { 'CF-Connecting-IP': '10.6.6.6' });
  assert(last.json && last.json.ok === true && last.json.auto === false, 'pay-dual: first submission from IP-B ok, not blocked by IP-A quota: ' + JSON.stringify(last.json));
}

// ===== 11. 设置白名单：__proto__ 与未知键拒绝入库 =====
r = await callRaw('POST', '/api/admin/settings', '{"settings":{"__proto__":"polluted"}}', cookie);
assert(!r.json.ok && /未知设置键/.test(r.json.error || ''), 'settings-whitelist: __proto__ in settings object rejected: ' + JSON.stringify(r.json));
assert(!q("SELECT * FROM settings WHERE key='__proto__'"), 'settings-whitelist: no __proto__ row in DB');
r = await call('POST', '/api/admin/settings', { key: '__proto__', value: 'polluted' }, cookie);
assert(!r.json.ok && /未知设置键/.test(r.json.error || ''), 'settings-whitelist: __proto__ single-key form rejected: ' + JSON.stringify(r.json));
r = await call('POST', '/api/admin/settings', { settings: { unknown_key_xyz: '1' } }, cookie);
assert(!r.json.ok && /未知设置键/.test(r.json.error || ''), 'settings-whitelist: unknown key rejected: ' + JSON.stringify(r.json));
r = await call('POST', '/api/admin/settings', { settings: { constructor: 'polluted' } }, cookie);
assert(!r.json.ok && /未知设置键/.test(r.json.error || ''), 'settings-whitelist: constructor (prototype-chain lookup trap) rejected: ' + JSON.stringify(r.json));
assert(!q("SELECT * FROM settings WHERE key='constructor'"), 'settings-whitelist: no constructor row in DB');
r = await call('POST', '/api/admin/settings', { settings: { site_name: 'Audit Shop' } }, cookie);
assert(r.json && r.json.ok && q("SELECT value FROM settings WHERE key='site_name'").value === 'Audit Shop', 'settings-whitelist: known key still saves');

// ===== 2. 7 天清理审计（不记交付内容）=====
db.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, query_password_hash, query_password_salt, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at, delivery_content, fulfilled_at, data_expired) VALUES (?, '', '', '', '', ?, '{}', 1, 10, 10, 10, ?, datetime('now','+30 minutes'), '{}', 'clean@test.example', 'OKX', 'X Layer', ?, 'completed', datetime('now','-20 days'), 'CLEAN-SECRET-CONTENT', datetime('now','-10 days'), 0)").run('AUDITCLEAN001', cardProd.id, ADDR_OKX, ADDR_OKX);
r = await call('POST', '/api/admin/cleanup', {}, cookie);
assert(r.json && r.json.ok, 'cleanup: admin cleanup ok: ' + JSON.stringify(r.json));
{
  const co = q("SELECT * FROM orders WHERE order_no='AUDITCLEAN001'");
  assert(co.data_expired === 1 && co.delivery_content === '', 'cleanup: expired order delivery cleared + flagged');
  const row = q("SELECT * FROM admin_audit WHERE action='cleanup_expired_data' ORDER BY id DESC");
  assert(!!row && !String(row.note || '').includes('CLEAN-SECRET-CONTENT'), 'audit: cleanup_expired_data row exists and note has no delivery content');
}

// ===== 4. 遗留凭证：管理员重置 v14 无 salt 哈希订单 =====
{
  const unsalted = createHash('sha256').update('old-unsalted-pw').digest('hex');
  const tokHash = createHash('sha256').update('tok-legacy').digest('hex');
  db.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, query_password_hash, query_password_salt, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES (?, '', ?, ?, '', ?, '{}', 1, 10, 10, 10.0055, ?, datetime('now','+30 minutes'), '{}', 'legacy@test.example', 'OKX', 'X Layer', ?, 'pending_payment', datetime('now'))").run('AUDITLEGACY001', tokHash, unsalted, cardProd.id, ADDR_OKX, ADDR_OKX);
  const leg = q("SELECT * FROM orders WHERE order_no='AUDITLEGACY001'");
  r = await call('POST', '/api/admin/orders/' + leg.id + '/reset-query-password', { new_password: 'reset-new-pw' }, cookie);
  assert(r.json && r.json.ok, 'legacy-reset: admin reset ok: ' + JSON.stringify(r.json));
  const after = q("SELECT * FROM orders WHERE order_no='AUDITLEGACY001'");
  assert(after.query_password_salt && after.query_password_hash && after.query_password_hash !== unsalted, 'legacy-reset: salted hash written (not the old unsalted hash)');
  assert(after.query_password === '' && after.query_token_hash === '', 'legacy-reset: plaintext and old token hash cleared');
  assert(qa("SELECT * FROM admin_audit WHERE action='reset_query_password' AND order_id=?", leg.id).length >= 1, 'audit: reset_query_password row exists');
  const sec = await call('POST', '/api/orders/AUDITLEGACY001/secret', { password: 'reset-new-pw' });
  assert(sec.json && !sec.json.ok && sec.json.error === '订单尚未付款或暂无交付内容', 'legacy-reset: /secret with new password passes auth (fails only on unpaid status): ' + JSON.stringify(sec.json));
  const secBad = await call('POST', '/api/orders/AUDITLEGACY001/secret', { password: 'old-unsalted-pw' });
  assert(secBad.status === 401 && secBad.json && secBad.json.error === '查询密码错误', 'legacy-reset: old unsalted password no longer works');
}

// ===== 2. 迁移执行审计：删掉最高版本行后走一次迁移，须有审计行 =====
{
  const maxV = q('SELECT MAX(version) AS v FROM schema_migrations').v;
  db.prepare('DELETE FROM schema_migrations WHERE version=?').run(maxV);
  r = await call('POST', '/api/admin/migrate', {}, cookie);
  assert(r.json && r.json.ok, 'migrate: re-run ok: ' + JSON.stringify(r.json));
  assert(q('SELECT version FROM schema_migrations WHERE version=?', maxV), 'migrate: version row restored');
  assert(qa("SELECT * FROM admin_audit WHERE action='migrate'").length >= 1, 'audit: migrate row exists after migration execution');
}

// ===== 8+10. 安全头：HSTS 含 includeSubDomains，无 CORS 头 =====
{
  const home = await call('GET', '/');
  const hsts = home.headers.get('strict-transport-security') || '';
  assert(hsts.includes('includeSubDomains'), 'headers: HSTS includes includeSubDomains: ' + hsts);
  assert(!home.headers.get('access-control-allow-origin'), 'headers: HTML response has no Access-Control-Allow-Origin');
  const cfg = await call('GET', '/api/config');
  assert(!cfg.headers.get('access-control-allow-origin'), 'headers: API response has no Access-Control-Allow-Origin');
  const csp = home.headers.get('content-security-policy') || '';
  assert(csp.includes("script-src 'self' 'unsafe-inline'"), 'headers: CSP unsafe-inline present (documented accepted tradeoff, rendering still via escH)');
}
console.log('AUDIT AUTH FIXES TEST DONE');
