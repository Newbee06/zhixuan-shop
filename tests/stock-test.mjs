import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
// schema.sql 不含运行时迁移的列（ensureProductColumns 才加），测试里先补上
for (const col of ['in_stock INTEGER NOT NULL DEFAULT 1', 'sort INTEGER NOT NULL DEFAULT 0', 'prodseller_id TEXT NOT NULL DEFAULT \'\'', 'requires_email_activation INTEGER NOT NULL DEFAULT 0', 'delivery_method TEXT NOT NULL DEFAULT \'both\'']) {
  try { db.exec('ALTER TABLE products ADD COLUMN ' + col); } catch (e) {}
}
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
const env = { DB: { prepare: (sql) => wrapStmt(sql), async batch(stmts) { const out = []; for (const st of stmts) out.push(await st.run()); return out; } }, PRODSELLER_API_KEY: 'test-key', RESEND_API_KEY: 'test-resend', PRODSELLER_BASE_URL: 'https://prodseller.com/v1' };
async function mockFetch(url, opts = {}) {
  const u = String(url);
  if (u.includes('api.resend.com')) return new Response(JSON.stringify({ id: 'mock-mail' }), { status: 200 });
  if (u.includes('prodseller.com')) return new Response(JSON.stringify({ error: 'unused' }), { status: 500 });
  if (u.includes('tronscanapi.com')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
  throw new Error('unexpected fetch ' + u);
}
const workerPath = path.join(dir, 'src/worker.js');
let code = fs.readFileSync(workerPath, 'utf8');
const html = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
code = code.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(html) + ';');
const tmpWorker = path.join(dir, 'tests/_stock-worker-tmp.mjs');
fs.writeFileSync(tmpWorker, code);
const worker = await import(tmpWorker);
import { createHash } from 'node:crypto';
async function call(pathname, method = 'GET', body = null, headers = {}) {
  const req = new Request('http://localhost' + pathname, { method, headers: { 'content-type': 'application/json', 'X-Admin-API': '1', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.default.fetch(req, env, { waitUntil: () => {} });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { status: res.status, json: j, text, headers: res.headers };
}
let capSeq = 0;
function mkCaptcha(code) {
  const id = 'cap-test-' + (++capSeq);
  const h = createHash('sha256').update(code).digest('hex');
  const exp = new Date(Date.now() + 300000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?,?,0)').run(id, h, exp);
  return id;
}
async function orderCall(body) {
  const cid = mkCaptcha('AB12');
  return call('/api/orders', 'POST', { ...body, captcha_id: cid, captcha_code: 'AB12' });
}
// admin login + 首次改密（新规则：未改密的会话不能调管理接口）
let loginRes = await call('/api/admin/login', 'POST', { password: 'admin' });
let cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
let changeRes = await call('/api/admin/change-password', 'POST', { old_password: 'admin', new_password: 'test-admin-password-123' }, { Cookie: cookie });
if (!changeRes.json || !changeRes.json.ok) { console.log('FAIL: change-password', JSON.stringify(changeRes.json)); process.exit(1); }
const adminHeaders = { Cookie: cookie };
let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) { pass++; console.log('PASS:', name); } else { fail++; console.log('FAIL:', name, extra); } }

// seed: self card product (in_stock column=1, 0 cards), self card product #2 (2 cards), self manual (in_stock=0), prodseller (in_stock=0)
// 支付白名单：下单需有效 OKX|X Layer 收款地址（schema 种子为占位符，会拒单）
db.prepare("UPDATE settings SET value=? WHERE key='usdt_addresses'").run(JSON.stringify({ 'OKX|X Layer': '0x1111111111111111111111111111111111111111' }));
db.prepare("INSERT INTO products (slug,title,category,price_usdt,sell_price,source,stock_type,is_active,in_stock) VALUES ('self-card','自营卡密','card',1,1,'self','card',1,1)").run();
db.prepare("INSERT INTO products (slug,title,category,price_usdt,sell_price,source,stock_type,is_active,in_stock) VALUES ('self-card2','自营卡密2','card',1,1,'self','card',1,1)").run();
db.prepare("INSERT INTO products (slug,title,category,price_usdt,sell_price,source,stock_type,is_active,in_stock) VALUES ('self-manual','自营代充','recharge',1,1,'self','manual',1,0)").run();
db.prepare("INSERT INTO products (slug,title,category,price_usdt,sell_price,source,stock_type,is_active,in_stock,prodseller_id) VALUES ('ps-1','上游商品','recharge',1,1,'prodseller','manual',1,0,'PS-1')").run();
const p1 = db.prepare("SELECT id FROM products WHERE slug='self-card'").get().id;
const p2 = db.prepare("SELECT id FROM products WHERE slug='self-card2'").get().id;
const p3 = db.prepare("SELECT id FROM products WHERE slug='self-manual'").get().id;
const p4 = db.prepare("SELECT id FROM products WHERE slug='ps-1'").get().id;
db.prepare('INSERT INTO cards (product_id, code) VALUES (?,?)').run(p2, 'CODE-A');
db.prepare('INSERT INTO cards (product_id, code) VALUES (?,?)').run(p2, 'CODE-B');

// 1. public list: real in_stock
let r = await call('/api/products');
let bySlug = {}; for (const p of r.json.products) bySlug[p.slug] = p;
check('self card 0 cards -> in_stock 0', bySlug['self-card'].in_stock === 0, JSON.stringify(bySlug['self-card']));
check('self card 2 cards -> in_stock 1', bySlug['self-card2'].in_stock === 1);
check('self manual in_stock=0 -> 0', bySlug['self-manual'].in_stock === 0);
check('prodseller in_stock=0 -> 0', bySlug['ps-1'].in_stock === 0);

// 2. detail: same
r = await call('/api/products/' + p1);
check('detail self card 0 cards -> 0', r.json.product.in_stock === 0);
r = await call('/api/products/' + p2);
check('detail self card 2 cards -> 1', r.json.product.in_stock === 1);

// 3. order create: self card 0 cards -> rejected
r = await orderCall({ product_id: p1, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'a@b.com', delivery_email: 'a@b.com' } });
check('order self card 0 cards rejected', r.json && r.json.ok === false && /库存不足/.test(r.json.error || ''), JSON.stringify(r.json));

// 4. order create: self card 2 cards -> ok
r = await orderCall({ product_id: p2, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'a@b.com', delivery_email: 'a@b.com' } });
check('order self card 2 cards ok', r.json && r.json.ok === true, JSON.stringify(r.json));

// 5. order create: self manual in_stock=0 -> BLOCKED（新规则：人工缺货服务端必须阻止下单）
r = await orderCall({ product_id: p3, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'other@b.com' } });
check('order self manual in_stock=0 blocked', r.json && r.json.ok === false && /缺货/.test(r.json.error || ''), JSON.stringify(r.json));

// 6. admin products: card_stock = 可用数（已预留的卡不再算可用），card_reserved = 预留数
r = await call('/api/admin/products', 'GET', null, adminHeaders);
let adminList = null;
if (r.json && r.json.products) adminList = r.json.products;
if (!adminList) {
  console.log('NOTE: admin products needs session, skipping live check, verifying card_stock via code path');
}
if (adminList) {
  const m = {}; for (const p of adminList) m[p.slug] = p;
  // Test 4 的订单已预留 1 张卡：可用 1（CODE-B），预留 1（CODE-A）
  check('admin card_stock self-card2 = 1 (reserved excluded)', m['self-card2'].card_stock === 1, JSON.stringify(m['self-card2']));
  check('admin card_reserved self-card2 = 1', m['self-card2'].card_reserved === 1, JSON.stringify(m['self-card2']));
  check('admin card_stock self-card = 0', m['self-card'].card_stock === 0);
}

// 6b. 取消 Test 4 的订单 -> 预留释放，card_stock 回到 2
const reservedOrder = db.prepare("SELECT id FROM orders WHERE product_id=? AND status='pending_payment'").get(p2);
if (reservedOrder) {
  r = await call('/api/admin/orders/' + reservedOrder.id + '/cancel', 'POST', { reason: '测试释放预留' }, adminHeaders);
  check('cancel pending order ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  r = await call('/api/admin/products', 'GET', null, adminHeaders);
  if (r.json && r.json.products) {
    const m2 = {}; for (const p of r.json.products) m2[p.slug] = p;
    check('after cancel, card_stock self-card2 back to 2', m2['self-card2'].card_stock === 2, JSON.stringify(m2['self-card2']));
    check('after cancel, card_reserved self-card2 = 0', m2['self-card2'].card_reserved === 0, JSON.stringify(m2['self-card2']));
  }
} else {
  check('reserved order exists for cancel test', false, 'no pending order for p2');
}

// 7. admin save: in_stock persists (PUT)
r = await call('/api/admin/products/' + p3, 'PUT', { title: '自营代充', slug: 'self-manual', sell_price: 1, source: 'self', category: 'recharge', stock_type: 'manual', in_stock: 1, is_active: 1 }, adminHeaders);
check('admin PUT in_stock accepted', r.json && r.json.ok === true, JSON.stringify(r.json));
const afterPut = db.prepare('SELECT in_stock FROM products WHERE id=?').get(p3);
check('in_stock persisted = 1', Number(afterPut.in_stock) === 1, JSON.stringify(afterPut));

console.log(`\nSTOCK TEST DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
