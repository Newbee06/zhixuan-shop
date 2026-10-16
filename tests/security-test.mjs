// 安全 / 订单状态机 / 查单授权 / 库存预留专项测试（全部 mock，不连真实接口）
// 覆盖任务书 P4 要求的：鉴权、登录限流、Session、查单凭证、状态机、库存预留与释放、防超卖。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const db = new DatabaseSync(':memory:');
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
    async run() { const st = db.prepare(sql); const info = st.run(...params); return { meta: { changes: info.changes } }; },
  };
  return api;
}
const env = { DB: { prepare: (sql) => wrapStmt(sql) }, PRODSELLER_API_KEY: 'test-key', PRODSELLER_BASE_URL: 'https://prodseller.com/v1' };
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
  const headers = { 'content-type': 'application/json', ...(extraHeaders || {}) };
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
  const id = 'cap-sec-' + (++capSeq);
  const h = createHash('sha256').update(codeStr).digest('hex');
  const exp = new Date(Date.now() + 300000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare("INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?,?,0)").run(id, h, exp);
  return id;
}
async function orderCall(body) {
  const cid = mkCaptcha('AB12');
  return call('POST', '/api/orders', { ...body, captcha_id: cid, captcha_code: 'AB12' });
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
r = await call('POST', '/api/admin/login', { password: 'admin' });
check('login initial admin ok', r.json && r.json.ok === true);
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
check('login response has no password hash/token in body', !JSON.stringify(r.json).includes('password_hash') && !JSON.stringify(r.json).includes('session_token'));
r = await call('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'sec-test-pass-123' }, cookie);
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
r = await orderCall({ product_id: pPsOut, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'm2@test.example' } });
check('prodseller out-of-stock blocked', r.json && !r.json.ok && /缺货/.test(r.json.error || ''), JSON.stringify(r.json));

// ===== 6. 库存预留：两单争 1 张卡，第二单被拒；取消第一单后释放，第二单可下 =====
r = await orderCall({ product_id: pCard, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'c1@test.example', delivery_email: 'c1@test.example' } });
check('first card order ok (reserves the only card)', r.json && r.json.ok === true, JSON.stringify(r.json));
const ordA = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
check('first order has query_token', !!r.json.order.query_token);
check('first order has query_token_hash stored (not plaintext)', !!ordA.query_token_hash && ordA.query_token_hash.length === 64);
r = await orderCall({ product_id: pCard, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'c2@test.example', delivery_email: 'c2@test.example' } });
check('second card order blocked (no card left)', r.json && !r.json.ok && /库存不足/.test(r.json.error || ''), JSON.stringify(r.json));
check('failed reservation leaves no orphan order', !q("SELECT id FROM orders WHERE contact='c2@test.example'"));
// 取消第一单 -> 预留释放
r = await call('POST', '/api/admin/orders/' + ordA.id + '/cancel', { reason: '测试释放' }, cookie);
check('cancel first order ok', r.json && r.json.ok === true);
check('reservation released after cancel', !q('SELECT id FROM cards WHERE reserved_order_id=?', ordA.id));
r = await orderCall({ product_id: pCard, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'c2@test.example', delivery_email: 'c2@test.example' } });
check('second order ok after release', r.json && r.json.ok === true, JSON.stringify(r.json));
const ordB = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
const tokenB = r.json.order.query_token;

// ===== 7. 订单状态机 =====
// 待付款不能直接发货
r = await call('POST', '/api/admin/orders/' + ordB.id + '/fulfill', { delivery_content: 'MANUAL-KEY' }, cookie);
check('pending_payment cannot fulfill directly', r.json && !r.json.ok && /待付款/.test(r.json.error || ''), JSON.stringify(r.json));
// 确认收款 -> 卡密自动发（用预留卡）
r = await call('POST', '/api/admin/orders/' + ordB.id + '/confirm-payment', { reason: '测试确认' }, cookie);
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
// 无凭证 -> 401
r = await call('GET', '/api/orders/' + ordB.order_no);
check('lookup without token -> 401', r.status === 401);
// 错误凭证 -> 401
r = await call('GET', '/api/orders/' + ordB.order_no + '?token=wrongtoken123');
check('lookup with wrong token -> 401', r.status === 401);
// 正确凭证 -> 完整详情，含交付内容，不含凭证哈希/查询密码
r = await call('GET', '/api/orders/' + ordB.order_no + '?token=' + tokenB);
check('lookup with correct token -> full detail', r.json && r.json.ok === true && r.json.order.delivery_content === 'SEC-CARD-ONLY-1', JSON.stringify(r.json));
check('lookup response has no query_token_hash', !JSON.stringify(r.json).includes('query_token_hash'));
check('lookup response has no query_password', !JSON.stringify(r.json).includes('query_password'));
// 旧查询密码不能用于新订单
r = await call('GET', '/api/orders/' + ordB.order_no + '?password=' + ordB.query_password);
check('legacy password rejected for new order', r.status === 401);
// 按邮箱查 -> 只返回概要，无交付内容、无客户隐私字段
r = await call('GET', '/api/orders?contact=c2@test.example');
check('email lookup returns summaries only', r.json && r.json.ok === true && r.json.orders.length === 1 && !r.json.orders[0].delivery_content && !r.json.orders[0].customer_fields && !r.json.orders[0].contact, JSON.stringify(r.json));
// 旧订单兼容：直接插入一个无凭证哈希的旧订单，旧密码只返回概要（无交付内容）
db.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at, delivery_content, fulfilled_at) VALUES ('AISLEGACY001','123456','',?, '{}', 1, 5, 5, 5, '', '2099-01-01 00:00:00', '{}', 'legacy@test.example', 'OKX', 'X Layer', '', 'completed', datetime('now'), 'LEGACY-SECRET-KEY', datetime('now'))").run(pManual);
r = await call('GET', '/api/orders/AISLEGACY001');
check('legacy order without credential -> 401', r.status === 401);
r = await call('GET', '/api/orders/AISLEGACY001?password=wrong');
check('legacy order wrong password -> 401', r.status === 401);
r = await call('GET', '/api/orders/AISLEGACY001?password=123456');
check('legacy order with password -> summary only (no delivery)', r.json && r.json.ok === true && r.json.legacy === true && !r.json.order.delivery_content && !r.json.order.customer_fields, JSON.stringify(r.json));

// ===== 9. 审计日志 =====
r = await call('GET', '/api/admin/audit', null, cookie);
check('audit list ok', r.json && r.json.ok === true && Array.isArray(r.json.audit) && r.json.audit.length > 0, JSON.stringify(r.json));
const actions = (r.json.audit || []).map((a) => a.action);
check('audit has confirm_payment + cancel', actions.includes('confirm_payment') && actions.includes('cancel'), JSON.stringify(actions));
check('audit entries have no card codes/passwords', !JSON.stringify(r.json.audit).includes('SEC-CARD-ONLY-1') && !JSON.stringify(r.json.audit).includes('query_token'));

console.log(`\nSECURITY TEST DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
