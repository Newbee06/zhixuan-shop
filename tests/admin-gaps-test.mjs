// 管理端三项：自定义字段、定价模板、商品分类。付款对账不在本变更内。
// 虚构数据，不写真实卡密 / 密钥 / 管理员密码。
// 运行：node tests/admin-gaps-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
db.exec(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));

function wrapStmt(sql) {
  let params = [];
  const api = {
    bind(...a) { params = a; return api; },
    async first() { const r = db.prepare(sql).get(...params); return r === undefined ? null : r; },
    async all() { return { results: db.prepare(sql).all(...params) }; },
    async run() { const info = db.prepare(sql).run(...params); return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }; },
  };
  return api;
}
const env = {
  ZHIXUAN_SETUP_TOKEN: 'test-setup-token',
  DB: {
    prepare: (sql) => wrapStmt(sql),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  },
};
let code = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
code = code.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(html) + ';');
code = code.replace('export default {', 'globalThis.__W = {');
const worker = new Function(code + '\nreturn globalThis.__W;')();
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
  return { status: res.status, json: j, text: txt, headers: res.headers };
}
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); } console.log('PASS: ' + msg); }
function q(sql, ...a) { return db.prepare(sql).get(...a); }

let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
assert(r.json && r.json.ok, 'admin login');
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await call('POST', '/api/admin/change-password', { old_password: '', new_password: 'test-admin-password-123' }, cookie);
assert(r.json && r.json.ok, 'change-password');
cookie = (r.headers.get('set-cookie') || '').split(';')[0] || cookie;

r = await call('GET', '/api/admin/schema-check', null, cookie);
assert(r.json && r.json.precheck && r.json.precheck.ok === true && r.json.precheck.current_version === 21, 'schema-check ok version 20: ' + JSON.stringify(r.json && r.json.precheck && r.json.precheck.issues));
r = await call('GET', '/api/config');
const cats = (r.json && r.json.config && r.json.config.categories) || [];
assert(cats.some((c) => c.key === 'recharge' && c.name === '代充') && cats.some((c) => c.key === 'card'), 'public config lists builtin categories');

// ----- 自定义字段 -----
r = await call('POST', '/api/admin/products', {
  slug: 'gap-fields', title: '字段商品', category: 'recharge', sell_price: 3, source: 'self', stock_type: 'manual',
  form_fields: [
    { key: 'contact', label: '联系方式（邮箱/TG）', required: true, placeholder: 'old' },
    { key: 'account_note', label: '账号备注', required: true, placeholder: '写备注', type: 'textarea' },
  ],
}, cookie);
assert(r.json && r.json.ok, 'create product with legacy + textarea: ' + JSON.stringify(r.json));
const fp = q("SELECT * FROM products WHERE slug='gap-fields'");
const stored = JSON.parse(fp.form_fields);
assert(stored.some((f) => f.key === 'contact' && f.label === '联系方式（邮箱/TG）') && stored.some((f) => f.key === 'account_note' && f.type === 'textarea'), 'legacy kept and textarea stored');
r = await call('GET', '/api/products/' + fp.id);
assert(r.json && r.json.product.form_fields.some((f) => f.type === 'textarea' && f.key === 'account_note'), 'public product returns textarea field');
r = await call('PUT', '/api/admin/products/' + fp.id, { title: '字段商品改名', sell_price: 3, category: 'recharge', source: 'self', stock_type: 'manual' }, cookie);
assert(r.json && r.json.ok, 'put without form_fields');
const fp2 = q("SELECT form_fields, title FROM products WHERE id=?", fp.id);
assert(fp2.title === '字段商品改名' && /account_note/.test(fp2.form_fields), 'omitted form_fields preserved');
r = await call('PUT', '/api/admin/products/' + fp.id, { title: '字段商品改名', sell_price: 3, category: 'recharge', source: 'self', stock_type: 'manual', form_fields: [{ key: 'select_me', label: '下拉', type: 'select' }] }, cookie);
assert(r.json && r.json.ok === false && /textarea/.test(r.json.error || ''), 'select type rejected');
r = await call('PUT', '/api/admin/products/' + fp.id, { title: '字段商品改名', sell_price: 3, category: 'recharge', source: 'self', stock_type: 'manual', form_fields: [{ key: 'query_password', label: '密码' }] }, cookie);
assert(r.json && r.json.ok === false, 'reserved key rejected');
assert(/account_note/.test(q('SELECT form_fields FROM products WHERE id=?', fp.id).form_fields), 'rejected put did not wipe fields');

// ----- 定价模板（开关默认关；这里打开后复用原断言）-----
r = await call('POST', '/api/admin/settings', { settings: { pricing_templates_enabled: '1' } }, cookie);
assert(r.json && r.json.ok, 'enable pricing templates so existing assertions run');
r = await call('POST', '/api/admin/pricing-templates', { name: '标准加价', markup: 2, fixed: 1, price_floor: '', price_ceiling: '' }, cookie);
assert(r.json && r.json.ok && r.json.template.markup === 2 && r.json.template.fixed === 1 && r.json.template.price_floor == null, 'create template: ' + JSON.stringify(r.json));
const tplId = r.json.template.id;
r = await call('POST', '/api/admin/pricing-templates', { name: '标准加价', markup: 2, fixed: 1 }, cookie);
assert(r.json && r.json.ok && r.json.idempotent === true && r.json.template.id === tplId, 'identical template create is idempotent');
r = await call('POST', '/api/admin/pricing-templates', { name: '控价', markup: 1, fixed: 0, price_floor: 15, price_ceiling: 18 }, cookie);
assert(r.json && r.json.ok, 'create floor/ceiling template');
const floorId = r.json.template.id;
r = await call('POST', '/api/admin/pricing-templates', { name: '坏控价', markup: 1, fixed: 0, price_floor: 20, price_ceiling: 10 }, cookie);
assert(r.json && r.json.ok === false, 'floor above ceiling rejected');
db.prepare("INSERT INTO upstream_cache (key, payload, fetched_at) VALUES ('products', ?, datetime('now'))").run(JSON.stringify([
  { id: 'PS-T1', title: '模板新货', cost: 10, inStock: true },
  { id: 'PS-T2', title: '控价新货', cost: 100, inStock: true },
]));
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-T1' }], template_id: tplId }, cookie);
assert(r.json && r.json.ok && r.json.template_id === tplId && r.json.sell_price_preserved === 0, 'import with template: ' + JSON.stringify(r.json));
const t1 = q("SELECT * FROM products WHERE prodseller_id='PS-T1'");
assert(Number(t1.sell_price) === 21 && Number(t1.price_usdt) === 21 && Number(t1.cost_price) === 10, 'new import sell = 10*2+1 = ' + t1.sell_price);
db.prepare('UPDATE products SET sell_price=99, price_usdt=99 WHERE id=?').run(t1.id);
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-T1' }], template_id: tplId }, cookie);
assert(r.json && r.json.ok && r.json.sell_price_preserved === 1, 're-import reports preserved sell');
const t1b = q("SELECT sell_price, price_usdt, cost_price FROM products WHERE id=?", t1.id);
assert(Number(t1b.sell_price) === 99 && Number(t1b.price_usdt) === 99 && Number(t1b.cost_price) === 10, 're-import keeps admin sell price');
r = await call('POST', '/api/admin/products/' + t1.id + '/apply-pricing-template', { template_id: tplId }, cookie);
assert(r.json && r.json.ok && r.json.sell_price === 21, 'explicit apply overwrites sell: ' + JSON.stringify(r.json));
r = await call('POST', '/api/admin/products/' + t1.id + '/apply-pricing-template', { template_id: tplId }, cookie);
assert(r.json && r.json.ok && r.json.sell_price === 21, 'apply twice is same price');
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-T2' }], template_id: floorId }, cookie);
const t2 = q("SELECT sell_price FROM products WHERE prodseller_id='PS-T2'");
assert(Number(t2.sell_price) === 18, 'ceiling clamps 100 to 18, got ' + (t2 && t2.sell_price));
r = await call('POST', '/api/admin/pricing-templates/' + tplId + '/deactivate', {}, cookie);
assert(r.json && r.json.ok && r.json.template.is_active === 0, 'deactivate template');
r = await call('POST', '/api/admin/pricing-templates/' + tplId + '/deactivate', {}, cookie);
assert(r.json && r.json.idempotent === true, 'deactivate twice is idempotent');
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-T2' }], template_id: tplId }, cookie);
assert(r.json && r.json.ok === false, 'inactive template rejected on import');
assert(Number(q("SELECT sell_price FROM products WHERE id=?", t1.id).sell_price) === 21, 'rejected import did not change sell');

// ----- 分类 -----
r = await call('GET', '/api/admin/categories', null, cookie);
assert(r.json && r.json.ok && r.json.categories.filter((c) => c.builtin === 1).length === 3, 'three builtin categories');
const recharge = r.json.categories.find((c) => c.key === 'recharge');
r = await call('PUT', '/api/admin/categories/' + recharge.id, { name: '代充服务', key: 'topup' }, cookie);
assert(r.json && r.json.ok === false && /内置/.test(r.json.error || ''), 'builtin key rename rejected');
r = await call('PUT', '/api/admin/categories/' + recharge.id, { name: '代充服务' }, cookie);
assert(r.json && r.json.ok && r.json.category.name === '代充服务' && r.json.category.key === 'recharge', 'builtin display name can change');
r = await call('POST', '/api/admin/categories', { name: '礼包', key: 'bundle', sort: 40 }, cookie);
assert(r.json && r.json.ok && r.json.category.key === 'bundle', 'create category');
r = await call('POST', '/api/admin/categories', { name: '礼包', key: 'bundle' }, cookie);
assert(r.json && r.json.idempotent === true, 'same active category create is idempotent');
r = await call('POST', '/api/admin/products', { slug: 'gap-bundle', title: '礼包商品', category: 'bundle', sell_price: 4, source: 'self', stock_type: 'manual', form_fields: [] }, cookie);
assert(r.json && r.json.ok, 'product uses managed category: ' + JSON.stringify(r.json));
const bundle = q("SELECT id FROM categories WHERE cat_key='bundle'");
r = await call('PUT', '/api/admin/categories/' + bundle.id, { name: '礼包', key: 'bundle2' }, cookie);
assert(r.json && r.json.ok && r.json.category.key === 'bundle2', 'rename custom key');
assert(q("SELECT category FROM products WHERE slug='gap-bundle'").category === 'bundle2', 'rename updates products.category');
r = await call('POST', '/api/admin/categories/' + bundle.id + '/deactivate', {}, cookie);
assert(r.json && r.json.ok && r.json.category.is_active === 0, 'deactivate category');
r = await call('POST', '/api/admin/categories/' + bundle.id + '/deactivate', {}, cookie);
assert(r.json && r.json.idempotent === true, 'deactivate category twice');
r = await call('POST', '/api/admin/products', { slug: 'gap-bundle-2', title: '停用分类', category: 'bundle2', sell_price: 4, source: 'self', stock_type: 'manual', form_fields: [] }, cookie);
assert(r.json && r.json.ok === false && /停用/.test(r.json.error || ''), 'inactive category blocked for new product');
const bundleProd = q("SELECT id FROM products WHERE slug='gap-bundle'");
r = await call('PUT', '/api/admin/products/' + bundleProd.id, { title: '礼包商品', sell_price: 4, category: 'bundle2', source: 'self', stock_type: 'manual', form_fields: [] }, cookie);
assert(r.json && r.json.ok, 'keeping same inactive category on edit is allowed: ' + JSON.stringify(r.json));
r = await call('PUT', '/api/admin/products/' + bundleProd.id, { title: '礼包商品', sell_price: 4, category: 'recharge', source: 'self', stock_type: 'manual', form_fields: [] }, cookie);
assert(r.json && r.json.ok, 'switch away from inactive category');
r = await call('PUT', '/api/admin/products/' + bundleProd.id, { title: '礼包商品', sell_price: 4, category: 'bundle2', source: 'self', stock_type: 'manual', form_fields: [] }, cookie);
assert(r.json && r.json.ok === false, 'switching onto inactive category rejected');
r = await call('GET', '/api/config');
assert(!(r.json.config.categories || []).some((c) => c.key === 'bundle2'), 'inactive category hidden from public config');
assert((r.json.config.categories || []).some((c) => c.key === 'recharge' && c.name === '代充服务'), 'renamed builtin name is public');

// ----- 最小后台接线（静态） -----
assert(html.includes('function renderAdminPayments') && html.includes('付款对账'), 'payments page from reconcile tip still present');
assert(html.includes('自定义下单字段') && html.includes('function readFormFieldRows'), 'form field editor wired');
assert(html.includes('function renderAdminPricing') && html.includes('/api/admin/pricing-templates'), 'pricing page wired');
assert(html.includes('function renderAdminCategories') && html.includes('template_id'), 'categories page + import template_id');
assert(html.includes("f.type === 'textarea'"), 'storefront renders textarea fields');

console.log('ADMIN GAPS TEST DONE');
