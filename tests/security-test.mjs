// 安全 / 订单状态机 / 查单授权 / 库存预留专项测试（全部 mock，不连真实接口）
// 覆盖任务书 P4 要求的：鉴权、登录限流、Session、查单凭证、状态机、库存预留与释放、防超卖。
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
// schema.sql 不含运行时迁移的列（ensureProductColumns / ensureSecurityTables 才加），测试里先补上
for (const col of ['in_stock INTEGER NOT NULL DEFAULT 1', 'sort INTEGER NOT NULL DEFAULT 0', 'prodseller_id TEXT NOT NULL DEFAULT \'\'', 'requires_email_activation INTEGER NOT NULL DEFAULT 0', 'delivery_method TEXT NOT NULL DEFAULT \'both\'', 'source TEXT NOT NULL DEFAULT \'self\'', 'cost_price REAL NOT NULL DEFAULT 0', 'sell_price REAL NOT NULL DEFAULT 0', 'image_data TEXT NOT NULL DEFAULT \'\'']) {
  try { db.exec('ALTER TABLE products ADD COLUMN ' + col); } catch (e) {}
}
for (const col of ['query_token_hash TEXT NOT NULL DEFAULT \'\'']) {
  try { db.exec('ALTER TABLE orders ADD COLUMN ' + col); } catch (e) {}
}
for (const col of ['reserved_order_id INTEGER', 'reserved_at TEXT']) {
  try { db.exec('ALTER TABLE cards ADD COLUMN ' + col); } catch (e) {}
}
try { db.exec("CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, action TEXT NOT NULL DEFAULT '', before_status TEXT NOT NULL DEFAULT '', after_status TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))"); } catch (e) {}
try { db.exec("CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, blocked_until TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')))"); } catch (e) {}
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
const env = { ZHIXUAN_SETUP_TOKEN: 'test-setup-token', DB: { prepare: (sql) => wrapStmt(sql), async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } }, PRODSELLER_API_KEY: 'test-key', PRODSELLER_BASE_URL: 'https://prodseller.com/v1' };
async function mockFetch(url, opts = {}) { throw new Error('Unexpected fetch: ' + url); }
globalThis.fetch = mockFetch;
env.__fetch = mockFetch;
let code = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
code = code.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(html) + ';');
code = code.replace('export default {', 'globalThis.__W = {');
const worker = new Function(code + '\nreturn globalThis.__W;')();
function makeCtx() { const c = { pending: [] }; c.waitUntil = (pr) => { c.pending.push(pr); }; c.drain = async () => { while (c.pending.length) { const batch = c.pending.splice(0); await Promise.all(batch.map((x) => x.catch(() => {}))); } }; return c; }
async function call(method, p, body, cookie, extraHeaders) {
  const ctx = makeCtx();
  // 测试是 API 客户端：默认声明 X-Admin-API: 1（通过 CSRF 的 API 客户端通道）；CSRF 专项用 callRaw 自控请求头。
  const headers = { 'content-type': 'application/json', 'X-Admin-API': '1', ...(extraHeaders || {}) };
  if (cookie) headers.Cookie = cookie;
  const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: res.status, json: j, headers: res.headers, text: txt };
}
// 不自动加任何声明头：供 CSRF 专项精确控制请求头。
async function callRaw(method, p, body, headers) {
  const ctx = makeCtx();
  const req = new Request('http://test' + p, { method, headers: { 'content-type': 'application/json', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: res.status, json: j, headers: res.headers, text: txt };
}
let capSeq = 0;
function mkCaptcha(codeStr) {
  const id = 'cap-sec-' + (++capSeq);
  const h = createHash('sha256').update(codeStr).digest('hex');
  const exp = new Date(Date.now() + 300000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare("INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?,?,0)").run(id, h, exp);
  return id;
}
async function orderCall(body) {
  const cid = mkCaptcha('AB12');
  return call('POST', '/api/orders', { query_password: 'sec-test-pw', ...body, captcha_id: cid, captcha_code: 'AB12' });
}
let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) { pass++; console.log('PASS:', name); } else { fail++; console.log('FAIL:', name, extra); } }
function q(sql, ...a) { return db.prepare(sql).get(...a); }

// ===== 1. 未授权会话无法调用管理接口 =====
let r = await call('GET', '/api/admin/stats');
check('unauth stats 401', r.status === 401 && !r.json.ok);
r = await call('POST', '/api/admin/products', { title: 'x' });
check('unauth create product 401', r.status === 401);
r = await call('POST', '/api/admin/settings', { settings: { site_name: 'x' } });
check('unauth settings 401', r.status === 401);
r = await call('POST', '/api/admin/cards/import', { product_id: 1, codes: 'X' });
check('unauth card import 401', r.status === 401);
r = await call('GET', '/api/admin/audit');
check('unauth audit 401', r.status === 401);
// 伪造 Cookie 也无法通过
r = await call('GET', '/api/admin/stats', null, 'session_token=fake-token-123');
check('fake session cookie 401', r.status === 401);

// ===== 2. 登录 + 改密 + 退出 =====
r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
check('login initial admin ok', r.json && r.json.ok === true);
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
check('login response has no password hash/token in body', !JSON.stringify(r.json).includes('password_hash') && !JSON.stringify(r.json).includes('session_token'));
r = await call('POST', '/api/admin/change-password', { old_password: '', new_password: 'sec-test-pass-123' }, cookie);
check('change-password ok', r.json && r.json.ok === true);
r = await call('GET', '/api/admin/me', null, cookie);
check('me after change-password ok, must_change=false', r.json && r.json.ok === true && r.json.must_change_password === false);
// 退出后立即失效
r = await call('POST', '/api/admin/logout', {}, cookie);
check('logout ok', r.json && r.json.ok === true);
r = await call('GET', '/api/admin/stats', null, cookie);
check('session invalid after logout', r.status === 401);
// 重新登录（新会话）
r = await call('POST', '/api/admin/login', { password: 'sec-test-pass-123' });
check('re-login with new password ok', r.json && r.json.ok === true);
cookie = (r.headers.get('set-cookie') || '').split(';')[0];
// Session 过期：直接插入一个已过期会话，用它调接口应 401
db.prepare("INSERT INTO sessions (token, expires_at) VALUES ('expired-token-xyz', datetime('now','-1 hour'))").run();
r = await call('GET', '/api/admin/stats', null, 'session_token=expired-token-xyz');
check('expired session 401', r.status === 401);

// ===== 3. 登录限流 =====
for (let i = 0; i < 5; i++) {
  r = await call('POST', '/api/admin/login', { password: 'wrong-' + i });
  check('login fail ' + (i + 1) + ' -> 401', r.status === 401);
}
r = await call('POST', '/api/admin/login', { password: 'wrong-6th' });
check('6th login fail -> 429 blocked', r.status === 429, JSON.stringify(r.json));
// 清理限流记录，避免影响后续测试
db.prepare("DELETE FROM login_attempts").run();
r = await call('POST', '/api/admin/login', { password: 'sec-test-pass-123' });
check('login ok after clearing rate limit', r.json && r.json.ok === true);
cookie = (r.headers.get('set-cookie') || '').split(';')[0];

// ===== 4. 种子商品 =====
// 卡密商品（1 张卡）、人工商品（有货）、人工商品（缺货）、上游商品（缺货）
// 支付白名单：下单需有效 OKX|X Layer 收款地址（schema 种子为占位符，会拒单）
db.prepare("UPDATE settings SET value=? WHERE key='usdt_addresses'").run(JSON.stringify({ 'OKX|X Layer': '0x1111111111111111111111111111111111111111' }));
db.prepare("INSERT INTO products (slug,title,category,price_usdt,sell_price,source,stock_type,is_active,in_stock) VALUES ('sec-card','安全测试卡密','card',5,5,'self','card',1,1)").run();
db.prepare("INSERT INTO products (slug,title,category,price_usdt,sell_price,source,stock_type,is_active,in_stock) VALUES ('sec-manual','安全测试代充','recharge',5,5,'self','manual',1,1)").run();
db.prepare("INSERT INTO products (slug,title,category,price_usdt,sell_price,source,stock_type,is_active,in_stock) VALUES ('sec-manual-out','安全测试代充缺货','recharge',5,5,'self','manual',1,0)").run();
db.prepare("INSERT INTO products (slug,title,category,price_usdt,sell_price,source,stock_type,is_active,in_stock,prodseller_id) VALUES ('sec-ps-out','安全测试上游缺货','recharge',5,5,'prodseller','manual',1,0,'PS-OUT')").run();
const pCard = q("SELECT id FROM products WHERE slug='sec-card'").id;
const pManual = q("SELECT id FROM products WHERE slug='sec-manual'").id;
const pManualOut = q("SELECT id FROM products WHERE slug='sec-manual-out'").id;
const pPsOut = q("SELECT id FROM products WHERE slug='sec-ps-out'").id;
db.prepare('INSERT INTO cards (product_id, code) VALUES (?,?)').run(pCard, 'SEC-CARD-ONLY-1');

// ===== 5. 库存：人工缺货 / 上游缺货服务端阻止下单 =====
r = await orderCall({ product_id: pManualOut, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'm1@test.example' } });
check('manual out-of-stock blocked', r.json && !r.json.ok && /缺货/.test(r.json.error || ''), JSON.stringify(r.json));
// 上游商品：门禁关闭时先被门禁拦截（403）；开启门禁后，缺货检查仍拦截。
r = await orderCall({ product_id: pPsOut, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'm2@test.example' } });
check('prodseller gate closed blocks order', r.json && !r.json.ok && r.status === 403 && /暂未开放购买/.test(r.json.error || ''), JSON.stringify(r.json));
db.prepare("UPDATE settings SET value='1' WHERE key='prodseller_enabled'").run();
r = await orderCall({ product_id: pPsOut, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'm2@test.example' } });
check('prodseller out-of-stock blocked (gate open)', r.json && !r.json.ok && /缺货/.test(r.json.error || ''), JSON.stringify(r.json));
db.prepare("UPDATE settings SET value='0' WHERE key='prodseller_enabled'").run();

// ===== 6. 库存预留：两单争 1 张卡，第二单被拒；取消第一单后释放，第二单可下 =====
r = await orderCall({ product_id: pCard, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'c1@test.example', delivery_email: 'c1@test.example' }, query_password: 'sec-pw-1' });
check('first card order ok (reserves the only card)', r.json && r.json.ok === true, JSON.stringify(r.json));
const ordA = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
check('first order has_query_password=1, no system query_token', r.json.order.has_query_password === 1 && !r.json.order.query_token);
check('first order has query_password_hash stored (PBKDF2 base64, not plaintext)', !!ordA.query_password_hash && ordA.query_password_hash.length === 44 && !ordA.query_password_hash.includes('sec-pw-1'));
check('first order has random query_password_salt (16 bytes base64)', !!ordA.query_password_salt && ordA.query_password_salt.length === 24 && !ordA.query_password_salt.includes('sec-pw-1'));
check('first order has no system token hash', !ordA.query_token_hash);
r = await orderCall({ product_id: pCard, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'c2@test.example', delivery_email: 'c2@test.example' } });
check('second card order blocked (no card left)', r.json && !r.json.ok && /库存不足/.test(r.json.error || ''), JSON.stringify(r.json));
check('failed reservation leaves no orphan order', !q("SELECT id FROM orders WHERE contact='c2@test.example'"));
// 取消第一单 -> 预留释放
r = await call('POST', '/api/admin/orders/' + ordA.id + '/cancel', { reason: '测试释放' }, cookie);
check('cancel first order ok', r.json && r.json.ok === true);
check('reservation released after cancel', !q('SELECT id FROM cards WHERE reserved_order_id=?', ordA.id));
r = await orderCall({ product_id: pCard, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'c2@test.example', delivery_email: 'c2@test.example' }, query_password: 'sec-pw-2' });
check('second order ok after release', r.json && r.json.ok === true, JSON.stringify(r.json));
const ordB = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
const pwB = 'sec-pw-2';

// ===== 7. 订单状态机 =====
// 待付款不能直接发货
r = await call('POST', '/api/admin/orders/' + ordB.id + '/fulfill', { delivery_content: 'MANUAL-KEY' }, cookie);
check('pending_payment cannot fulfill directly', r.json && !r.json.ok && /待付款/.test(r.json.error || ''), JSON.stringify(r.json));
// 确认收款 -> 卡密自动发（用预留卡）
r = await call('POST', '/api/admin/orders/' + ordB.id + '/confirm-payment', { reason: '测试确认' , manual_confirm: true }, cookie);
check('confirm-payment ok', r.json && r.json.ok === true, JSON.stringify(r.json));
const ordBAfter = q('SELECT * FROM orders WHERE id=?', ordB.id);
check('confirm-payment -> completed with reserved card', ordBAfter.status === 'completed' && ordBAfter.delivery_content === 'SEC-CARD-ONLY-1', JSON.stringify(ordBAfter));
// 已完成不能重复发货 / 重复确认 / 取消
r = await call('POST', '/api/admin/orders/' + ordB.id + '/fulfill', { delivery_content: 'ANOTHER' }, cookie);
check('completed cannot fulfill again', r.json && !r.json.ok, JSON.stringify(r.json));
r = await call('POST', '/api/admin/orders/' + ordB.id + '/confirm-payment', {}, cookie);
check('completed cannot confirm-payment again', r.json && !r.json.ok, JSON.stringify(r.json));
r = await call('POST', '/api/admin/orders/' + ordB.id + '/cancel', {}, cookie);
check('completed cannot cancel', r.json && !r.json.ok, JSON.stringify(r.json));
check('card used once, order_id = ordB', (() => { const c = q('SELECT * FROM cards WHERE code=?', 'SEC-CARD-ONLY-1'); return c.is_used === 1 && c.order_id === ordB.id; })());
// 已取消不能发货
r = await orderCall({ product_id: pManual, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'm3@test.example' } });
check('manual order created', r.json && r.json.ok === true, JSON.stringify(r.json));
const ordC = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
r = await call('POST', '/api/admin/orders/' + ordC.id + '/cancel', { reason: '测试' }, cookie);
check('cancel manual order ok', r.json && r.json.ok === true);
r = await call('POST', '/api/admin/orders/' + ordC.id + '/fulfill', { delivery_content: 'X' }, cookie);
check('cancelled cannot fulfill', r.json && !r.json.ok, JSON.stringify(r.json));

// ===== 8. 公共查单授权 =====
// GET 单订单：仅返回概要（不含交付内容），绝不经 URL 凭证返回敏感数据
r = await call('GET', '/api/orders/' + ordB.order_no);
check('GET single order -> summary only (no delivery)', r.json && r.json.ok === true && !r.json.order.delivery_content, JSON.stringify(r.json));
// POST lookup：无凭证 -> 401
r = await call('POST', '/api/orders/' + ordB.order_no + '/lookup', { credential: '' });
check('lookup without token -> 401', r.status === 401);
// 错误凭证 -> 401
r = await call('POST', '/api/orders/' + ordB.order_no + '/lookup', { credential: 'wrongtoken123' });
check('lookup with wrong token -> 401', r.status === 401);
// 正确查询密码 -> /secret 返回交付内容，不含任何凭证哈希/查询密码
r = await call('POST', '/api/orders/' + ordB.order_no + '/secret', { password: pwB });
check('secret with correct password -> card', r.json && r.json.ok === true && r.json.delivery_content === 'SEC-CARD-ONLY-1', JSON.stringify(r.json));
check('secret response has no query_password_hash', !JSON.stringify(r.json).includes('query_password_hash'));
check('secret response has no query_token_hash', !JSON.stringify(r.json).includes('query_token_hash'));
check('secret response has no query_password', !JSON.stringify(r.json).includes('query_password'));
// 旧查询密码不能用于新订单（用一个真实的非空六位密码验证，不用空值绕过）
r = await call('POST', '/api/orders/' + ordB.order_no + '/lookup', { credential: '123456' });
check('legacy password rejected for new order', r.status === 401);
// 新订单不再保存可用的明文六位查询密码
check('new order query_password is empty', ordB.query_password === '', JSON.stringify({ qp: ordB.query_password }));
// 旧 GET 邮箱列表仍关闭（第四轮 P0，E-02）：仅凭邮箱即可枚举购买历史属隐私泄露。
// 新流程：邮箱可用，但须走 POST /api/orders/query（带图形验证码），且卡密仍需按单密码。
r = await call('GET', '/api/orders?contact=c2@test.example');
check('email lookup closed -> 410', r.status === 410 && r.json && r.json.ok === false, JSON.stringify(r.json));
// 旧订单兼容：直接插入一个无凭证哈希的旧订单，旧密码只返回概要（无交付内容）
db.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at, delivery_content, fulfilled_at) VALUES ('AISLEGACY001','123456','',?, '{}', 1, 5, 5, 5, '', '2099-01-01 00:00:00', '{}', 'legacy@test.example', 'OKX', 'X Layer', '', 'completed', datetime('now'), 'LEGACY-SECRET-KEY', datetime('now'))").run(pManual);
// B-P1-6: /lookup 需图形验证码（每次新取，一次有效）+ 按单记数。
r = await call('POST', '/api/orders/AISLEGACY001/lookup', { credential: '', captcha_id: mkCaptcha('AB12'), captcha_code: 'AB12' });
check('legacy order without credential -> 401', r.status === 401);
r = await call('POST', '/api/orders/AISLEGACY001/lookup', { credential: 'wrong', captcha_id: mkCaptcha('AB12'), captcha_code: 'AB12' });
check('legacy order wrong password -> 401', r.status === 401);
r = await call('POST', '/api/orders/AISLEGACY001/lookup', { credential: '123456', captcha_id: mkCaptcha('AB12'), captcha_code: 'AB12' });
check('legacy order with password -> summary only (no delivery)', r.json && r.json.ok === true && r.json.legacy === true && !r.json.order.delivery_content && !r.json.order.customer_fields, JSON.stringify(r.json));
// GET 旧订单也不返回交付内容（不经 URL 凭证）
r = await call('GET', '/api/orders/AISLEGACY001');
check('GET legacy order -> summary only (no delivery)', r.json && r.json.ok === true && !r.json.order.delivery_content, JSON.stringify(r.json));

// ===== 8b. CSRF：管理端写操作必须有同源证明 =====
// 无 Origin / 无 Sec-Fetch-Site / 无 X-Admin-API → 403（不再默认放行）
r = await callRaw('POST', '/api/admin/orders/' + ordB.id + '/cancel', { reason: 'csrf-test' }, { Cookie: cookie });
check('csrf: no origin no fetch-site no api header -> 403', r.status === 403, JSON.stringify(r.json));
// 恶意 Origin → 403
r = await callRaw('POST', '/api/admin/orders/' + ordB.id + '/cancel', { reason: 'csrf-test' }, { Cookie: cookie, Origin: 'https://evil.example' });
check('csrf: malicious origin -> 403', r.status === 403, JSON.stringify(r.json));
// 正常同源 Origin → 通过 CSRF（订单已完成，后端状态机拒绝，但不是 403）
r = await callRaw('POST', '/api/admin/orders/' + ordB.id + '/cancel', { reason: 'csrf-test' }, { Cookie: cookie, Origin: 'http://test' });
check('csrf: same-origin origin -> not 403', r.status !== 403, JSON.stringify(r.json));
// Sec-Fetch-Site: same-origin → 通过 CSRF
r = await callRaw('POST', '/api/admin/orders/' + ordB.id + '/cancel', { reason: 'csrf-test' }, { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' });
check('csrf: sec-fetch-site same-origin -> not 403', r.status !== 403, JSON.stringify(r.json));
// Sec-Fetch-Site: cross-site → 403
r = await callRaw('POST', '/api/admin/orders/' + ordB.id + '/cancel', { reason: 'csrf-test' }, { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' });
check('csrf: sec-fetch-site cross-site -> 403', r.status === 403, JSON.stringify(r.json));
// X-Admin-API: 1（API 客户端声明）→ 通过 CSRF
r = await callRaw('POST', '/api/admin/orders/' + ordB.id + '/cancel', { reason: 'csrf-test' }, { Cookie: cookie, 'X-Admin-API': '1' });
check('csrf: X-Admin-API header -> not 403', r.status !== 403, JSON.stringify(r.json));
// 改密接口同样受 CSRF 保护
r = await callRaw('POST', '/api/admin/change-password', { old_password: 'sec-test-pass-123', new_password: 'sec-test-pass-456' }, { Cookie: cookie });
check('csrf: change-password without proof -> 403', r.status === 403, JSON.stringify(r.json));

// ===== 8c. 已付款订单取消保护 + 异常/退款流程 =====
// ordB 已完成：取消拒绝（已覆盖）。再建一笔待发货订单（已付款），验证普通取消拒绝。
r = await orderCall({ product_id: pManual, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'paid1@test.example' } });
check('paid-flow order created', r.json && r.json.ok === true, JSON.stringify(r.json));
const ordP = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
r = await call('POST', '/api/admin/orders/' + ordP.id + '/confirm-payment', { reason: '测试已付款' , manual_confirm: true }, cookie);
check('confirm-payment manual -> pending_fulfill', r.json && r.json.ok === true, JSON.stringify(r.json));
check('order is pending_fulfill after confirm', q('SELECT status FROM orders WHERE id=?', ordP.id).status === 'pending_fulfill');
// 普通取消已付款待发货订单 → 409 拒绝
r = await call('POST', '/api/admin/orders/' + ordP.id + '/cancel', { reason: '试图普通取消已付款订单' }, cookie);
check('paid pending_fulfill cannot be normally cancelled', r.status === 409 || (r.json && !r.json.ok && /已付款|异常/.test(r.json.error || '')), JSON.stringify(r.json));
check('order still pending_fulfill after refused cancel', q('SELECT status FROM orders WHERE id=?', ordP.id).status === 'pending_fulfill');
// 异常处理：标记退款待处理
r = await call('POST', '/api/admin/orders/' + ordP.id + '/exception', { reason: '上游无法交付，需退款', refund_needed: true }, cookie);
check('exception -> refund_pending', r.json && r.json.ok === true, JSON.stringify(r.json));
check('order is refund_pending', q('SELECT status FROM orders WHERE id=?', ordP.id).status === 'refund_pending');
check('refund_status is pending', q('SELECT refund_status FROM orders WHERE id=?', ordP.id).refund_status === 'pending');
// 退款待处理订单也不能普通取消
r = await call('POST', '/api/admin/orders/' + ordP.id + '/cancel', { reason: '试图取消退款待处理' }, cookie);
check('refund_pending cannot be normally cancelled', r.json && !r.json.ok, JSON.stringify(r.json));
// 确认已退款：缺退款凭证 → 拒绝
r = await call('POST', '/api/admin/orders/' + ordP.id + '/refund-confirm', {}, cookie);
check('refund-confirm without ref rejected', r.json && !r.json.ok, JSON.stringify(r.json));
// 确认已退款：带凭证 → 订单转为 cancelled，refund_status=refunded
r = await call('POST', '/api/admin/orders/' + ordP.id + '/refund-confirm', { refund_ref: 'REFUND-TX-TEST-001' }, cookie);
check('refund-confirm ok', r.json && r.json.ok === true, JSON.stringify(r.json));
check('order cancelled after refund-confirm', q('SELECT status FROM orders WHERE id=?', ordP.id).status === 'cancelled');
check('refund_status is refunded', q('SELECT refund_status FROM orders WHERE id=?', ordP.id).refund_status === 'refunded');
check('refund_ref stored', q('SELECT refund_ref FROM orders WHERE id=?', ordP.id).refund_ref === 'REFUND-TX-TEST-001');
// 审计含 order_exception + refund_confirm
r = await call('GET', '/api/admin/audit?order_id=' + ordP.id, null, cookie);
check('audit has order_exception + refund_confirm', (() => { const acts = (r.json.audit || []).map((a) => a.action); return acts.includes('order_exception') && acts.includes('refund_confirm'); })(), JSON.stringify(r.json));
// 已取消订单不能再确认退款
r = await call('POST', '/api/admin/orders/' + ordP.id + '/refund-confirm', { refund_ref: 'X' }, cookie);
check('cancelled cannot refund-confirm again', r.json && !r.json.ok, JSON.stringify(r.json));
// 异常（不退款）仅记录原因，状态不变
r = await orderCall({ product_id: pManual, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'paid2@test.example' } });
const ordP2 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
await call('POST', '/api/admin/orders/' + ordP2.id + '/confirm-payment', { reason: '测试' , manual_confirm: true }, cookie);
r = await call('POST', '/api/admin/orders/' + ordP2.id + '/exception', { reason: '临时异常记录', refund_needed: false }, cookie);
check('exception without refund ok', r.json && r.json.ok === true, JSON.stringify(r.json));
check('order still pending_fulfill after note-only exception', q('SELECT status FROM orders WHERE id=?', ordP2.id).status === 'pending_fulfill');
// 退款待处理订单可手动发货（问题解决时），发货后退款状态清空
r = await call('POST', '/api/admin/orders/' + ordP2.id + '/exception', { reason: '需退款测试', refund_needed: true }, cookie);
check('exception2 -> refund_pending', r.json && r.json.ok === true);
r = await call('POST', '/api/admin/orders/' + ordP2.id + '/fulfill', { delivery_content: 'MANUAL-DELIVERY-AFTER-EXCEPTION' }, cookie);
check('refund_pending cannot be fulfilled directly (P1-12)', r.status === 409 && r.json && !r.json.ok && /退款待处理/.test(r.json.error || ''), JSON.stringify(r.json));
check('refund_status still pending after refused fulfill', q('SELECT refund_status FROM orders WHERE id=?', ordP2.id).refund_status === 'pending');
// 走正常退款确认流程：无上游单号时无需 upstream_voided 旗标。
r = await call('POST', '/api/admin/orders/' + ordP2.id + '/refund-confirm', { refund_ref: 'REFUND-TX-TEST-002' }, cookie);
check('refund-confirm after refused fulfill ok', r.json && r.json.ok === true, JSON.stringify(r.json));
check('order cancelled after refund-confirm', q('SELECT status FROM orders WHERE id=?', ordP2.id).status === 'cancelled');
check('refund_status is refunded', q('SELECT refund_status FROM orders WHERE id=?', ordP2.id).refund_status === 'refunded');
check('refund_ref stored (second flow)', q('SELECT refund_ref FROM orders WHERE id=?', ordP2.id).refund_ref === 'REFUND-TX-TEST-002');

// ===== 8d. 迁移状态端点 =====
r = await call('GET', '/api/admin/migrate', null, cookie);
check('migrate status up_to_date', r.json && r.json.ok === true && r.json.up_to_date === true && r.json.current_version === 20, JSON.stringify(r.json));
r = await call('POST', '/api/admin/migrate', {}, cookie);
check('migrate POST idempotent', r.json && r.json.ok === true && r.json.applied.length === 0, JSON.stringify(r.json));

// ===== 9. 审计日志 =====
r = await call('GET', '/api/admin/audit', null, cookie);
check('audit list ok', r.json && r.json.ok === true && Array.isArray(r.json.audit) && r.json.audit.length > 0, JSON.stringify(r.json));
const actions = (r.json.audit || []).map((a) => a.action);
check('audit has manual_confirm_payment + cancel', actions.includes('manual_confirm_payment') && actions.includes('cancel'), JSON.stringify(actions));
check('audit entries have no card codes/passwords', !JSON.stringify(r.json.audit).includes('SEC-CARD-ONLY-1') && !JSON.stringify(r.json.audit).includes('query_token'));

// ===== 10. 第三轮复审修复回归（A-02 / E-03 / F-02）=====
// A-02：未付款订单 exception + refund_needed → 拒绝，不进 refund_pending（防幽灵退款义务）
r = await orderCall({ product_id: pManual, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'unpaid-ex@test.example' } });
const ordUnpaid = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
r = await call('POST', '/api/admin/orders/' + ordUnpaid.id + '/exception', { reason: '未付款也想退款', refund_needed: true }, cookie);
check('A-02: unpaid order exception+refund rejected', r.json && !r.json.ok && /未付款|无需退款/.test(r.json.error || ''), JSON.stringify(r.json));
check('A-02: unpaid order still pending_payment', q('SELECT status FROM orders WHERE id=?', ordUnpaid.id).status === 'pending_payment');
check('A-02: unpaid order refund_status still empty', q('SELECT refund_status FROM orders WHERE id=?', ordUnpaid.id).refund_status === '');
// E-03：公开概要不泄露 refund_ref / exception_reason / upstream_lock（ordP 已走完退款流程，DB 含这些字段）
r = await call('GET', '/api/orders/' + ordP.order_no, null, null);
check('E-03: public summary has no refund_ref', r.json && r.json.ok === true && !('refund_ref' in (r.json.order || {})), JSON.stringify(r.json).slice(0, 300));
check('E-03: public summary has no exception_reason', r.json && !('exception_reason' in (r.json.order || {})));
check('E-03: public summary has no upstream_lock', r.json && !('upstream_lock' in (r.json.order || {})) && !('upstream_lock_expires_at' in (r.json.order || {})));
check('E-03: public summary still has refund_status', r.json && ('refund_status' in (r.json.order || {})));
// F-02：prodseller_base_url 仅允许官方域名（防 API Key 被发往攻击者地址）
r = await call('POST', '/api/admin/settings', { key: 'prodseller_base_url', value: 'https://evil.example.com/v1' }, cookie);
check('F-02: prodseller_base_url to attacker domain rejected', r.json && !r.json.ok && /官方域名/.test(r.json.error || ''), JSON.stringify(r.json));
r = await call('POST', '/api/admin/settings', { key: 'prodseller_base_url', value: 'https://prodseller.com/v1' }, cookie);
check('F-02: prodseller_base_url to official domain accepted', r.json && r.json.ok === true, JSON.stringify(r.json));

console.log(`\nSECURITY TEST DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
