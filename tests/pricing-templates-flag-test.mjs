// 定价模板功能开关：默认关。关时写接口拒绝，导入忽略 template_id。
// 开时的完整行为复用 tests/admin-gaps-test.mjs 的原断言（该文件会先把开关打开）。
// 本文件覆盖：缺省/空/0 为关、各写接口 403、导入不读旧模板、鉴权 401/CSRF、公开 config 不下发。
// 运行：node tests/pricing-templates-flag-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
db.exec(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));

const sqlLog = [];
function wrapStmt(sql) {
  sqlLog.push(String(sql));
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
async function call(method, p, body, cookie, extraHeaders) {
  const ctx = makeCtx();
  const headers = { 'content-type': 'application/json', ...(extraHeaders || {}) };
  if (extraHeaders && Object.prototype.hasOwnProperty.call(extraHeaders, 'X-Admin-API')) {
    if (!extraHeaders['X-Admin-API']) delete headers['X-Admin-API'];
  } else {
    headers['X-Admin-API'] = '1';
  }
  if (cookie) headers.Cookie = cookie;
  const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  sqlLog.length = 0;
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: res.status, json: j, text: txt, headers: res.headers, sql: sqlLog.slice() };
}
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); } console.log('PASS: ' + msg); }
function q(sql, ...a) { return db.prepare(sql).get(...a); }
function touchedTemplates(sqls) { return sqls.some((s) => /pricing_templates/i.test(s)); }

let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
assert(r.json && r.json.ok, 'admin login');
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await call('POST', '/api/admin/change-password', { old_password: '', new_password: 'test-admin-password-123' }, cookie);
assert(r.json && r.json.ok, 'change-password');
cookie = (r.headers.get('set-cookie') || '').split(';')[0] || cookie;

r = await call('GET', '/api/config');
assert(r.json && r.json.ok && !JSON.stringify(r.json).includes('pricing_templates'), 'public /api/config does not carry the flag');

r = await call('GET', '/api/admin/settings', null, cookie);
assert(r.json && r.json.ok && r.json.pricing_templates_enabled === false, 'admin settings boolean default off: ' + JSON.stringify(r.json && r.json.pricing_templates_enabled));
assert(q("SELECT value FROM settings WHERE key='pricing_templates_enabled'").value === '0', 'schema seeds pricing_templates_enabled=0');

function setFlag(value) {
  if (value == null) db.prepare("DELETE FROM settings WHERE key='pricing_templates_enabled'").run();
  else db.prepare("INSERT INTO settings (key, value) VALUES ('pricing_templates_enabled', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
}

db.prepare("INSERT INTO pricing_templates (name, markup, fixed_add, price_floor, price_ceiling, is_active) VALUES ('旧模板', 9, 3, 1, 2, 1)").run();
const oldTpl = q("SELECT * FROM pricing_templates WHERE name='旧模板'");
assert(oldTpl && Number(oldTpl.markup) === 9, 'old template row exists while flag is off');

r = await call('POST', '/api/admin/products', { slug: 'flag-prod', title: '开关商品', category: 'recharge', sell_price: 8, source: 'self', stock_type: 'manual', form_fields: [] }, cookie);
assert(r.json && r.json.ok, 'create product while flag off');
const prod = q("SELECT * FROM products WHERE slug='flag-prod'");

async function assertWritesRejected(label) {
  const before = q('SELECT COUNT(*) AS c FROM pricing_templates').c;
  const sellBefore = Number(q('SELECT sell_price FROM products WHERE id=?', prod.id).sell_price);
  r = await call('GET', '/api/admin/pricing-templates', null, cookie);
  assert(r.status === 200 && r.json && r.json.ok && Array.isArray(r.json.templates) && r.json.templates.length === 0 && r.json.pricing_templates_enabled === false, label + ' GET returns empty list');
  assert(!r.text.includes('旧模板'), label + ' GET does not leak old template name');
  assert(!touchedTemplates(r.sql), label + ' GET does not read pricing_templates');
  r = await call('POST', '/api/admin/pricing-templates', { name: '不该创建', markup: 2, fixed: 1 }, cookie);
  assert(r.status === 403 && r.json && r.json.ok === false && r.json.code === 'pricing_templates_disabled', label + ' POST create rejected: ' + JSON.stringify(r.json));
  r = await call('PUT', '/api/admin/pricing-templates/' + oldTpl.id, { name: '改名', markup: 4, fixed: 0 }, cookie);
  assert(r.status === 403 && r.json && r.json.code === 'pricing_templates_disabled', label + ' PUT rejected');
  r = await call('POST', '/api/admin/pricing-templates/' + oldTpl.id + '/deactivate', {}, cookie);
  assert(r.status === 403 && r.json && r.json.code === 'pricing_templates_disabled', label + ' deactivate rejected');
  r = await call('POST', '/api/admin/products/' + prod.id + '/apply-pricing-template', { template_id: oldTpl.id }, cookie);
  assert(r.status === 403 && r.json && r.json.code === 'pricing_templates_disabled', label + ' apply rejected');
  assert(q('SELECT COUNT(*) AS c FROM pricing_templates').c === before, label + ' writes did not insert templates');
  assert(q("SELECT name, markup, is_active FROM pricing_templates WHERE id=?", oldTpl.id).name === '旧模板', label + ' old template unchanged');
  assert(Number(q('SELECT sell_price FROM products WHERE id=?', prod.id).sell_price) === sellBefore, label + ' apply did not change sell');
}

await assertWritesRejected('seeded 0');
setFlag(null);
r = await call('GET', '/api/admin/settings', null, cookie);
assert(r.json && r.json.pricing_templates_enabled === false, 'missing key is off');
await assertWritesRejected('missing key');
setFlag('');
await assertWritesRejected('empty string');
setFlag('0');
await assertWritesRejected('explicit 0');
setFlag('  ');
await assertWritesRejected('whitespace');
setFlag('false');
await assertWritesRejected('false string');

r = await call('POST', '/api/admin/settings', { settings: { pricing_templates_enabled: 'yes' } }, cookie);
assert(r.json && r.json.ok === false && /0 或 1/.test(r.json.error || ''), 'invalid flag value rejected: ' + JSON.stringify(r.json));
r = await call('POST', '/api/admin/settings', { settings: { pricing_templates_enabled: '' } }, cookie);
assert(r.json && r.json.ok === false, 'empty flag write rejected');

db.prepare("INSERT INTO upstream_cache (key, payload, fetched_at) VALUES ('products', ?, datetime('now'))").run(JSON.stringify([
  { id: 'PS-FLAG', title: '开关导入', cost: 10, inStock: true },
]));
setFlag('0');
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-FLAG' }], template_id: oldTpl.id }, cookie);
assert(r.json && r.json.ok && r.json.template_id == null && r.json.template_ignored === true && r.json.markup === 1.2 && r.json.fixed === 0, 'import ignores template_id: ' + JSON.stringify(r.json));
assert(!touchedTemplates(r.sql), 'import does not read pricing_templates while off');
const imported = q("SELECT * FROM products WHERE prodseller_id='PS-FLAG'");
assert(imported && Number(imported.sell_price) === 12 && Number(imported.price_usdt) === 12 && Number(imported.cost_price) === 10, 'off import uses global 10*1.2+0, got ' + (imported && imported.sell_price));
db.prepare('UPDATE products SET sell_price=77, price_usdt=77 WHERE id=?').run(imported.id);
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-FLAG' }], template_id: oldTpl.id }, cookie);
assert(r.json && r.json.ok && r.json.sell_price_preserved === 1 && r.json.template_ignored === true, 'off re-import still preserves sell');
assert(Number(q('SELECT sell_price FROM products WHERE id=?', imported.id).sell_price) === 77, 'off re-import did not apply old template');

const writes = [
  ['POST', '/api/admin/pricing-templates', { name: 'x', markup: 2, fixed: 1 }],
  ['PUT', '/api/admin/pricing-templates/' + oldTpl.id, { name: '旧模板', markup: 9, fixed: 3 }],
  ['POST', '/api/admin/pricing-templates/' + oldTpl.id + '/deactivate', {}],
  ['POST', '/api/admin/products/' + prod.id + '/apply-pricing-template', { template_id: oldTpl.id }],
  ['POST', '/api/admin/upstream/import', { items: [{ id: 'PS-FLAG' }], template_id: oldTpl.id }],
  ['POST', '/api/admin/settings', { settings: { pricing_templates_enabled: '1' } }],
];
for (const [method, p, body] of writes) {
  r = await call(method, p, body, '');
  assert(r.status === 401, 'unauth 401 ' + method + ' ' + p + ' -> ' + r.status);
  r = await call(method, p, body, cookie, { 'X-Admin-API': '' });
  assert(r.status === 403 && r.json && r.json.code !== 'pricing_templates_disabled' && /同源|X-Admin-API|Origin/.test(r.json.error || ''), 'csrf 403 ' + method + ' ' + p + ' -> ' + JSON.stringify(r.json));
}

r = await call('POST', '/api/admin/settings', { settings: { pricing_templates_enabled: '1' } }, cookie);
assert(r.json && r.json.ok, 'admin can enable flag');
r = await call('GET', '/api/admin/settings', null, cookie);
assert(r.json && r.json.pricing_templates_enabled === true && r.json.settings.pricing_templates_enabled === '1', 'admin settings reports on');
r = await call('GET', '/api/config');
assert(!JSON.stringify(r.json).includes('pricing_templates'), 'public config still hides the flag when on');

r = await call('GET', '/api/admin/pricing-templates', null, cookie);
assert(r.json && r.json.ok && r.json.templates.some((t) => t.name === '旧模板' && t.markup === 9), 'on: GET returns stored templates');

r = await call('POST', '/api/admin/pricing-templates', { name: '标准加价', markup: 2, fixed: 1, price_floor: '', price_ceiling: '' }, cookie);
assert(r.json && r.json.ok && r.json.template.markup === 2 && r.json.template.fixed === 1 && r.json.template.price_floor == null, 'on: create template: ' + JSON.stringify(r.json));
const tplId = r.json.template.id;
r = await call('POST', '/api/admin/pricing-templates', { name: '标准加价', markup: 2, fixed: 1 }, cookie);
assert(r.json && r.json.ok && r.json.idempotent === true && r.json.template.id === tplId, 'on: identical template create is idempotent');
r = await call('POST', '/api/admin/pricing-templates', { name: '控价', markup: 1, fixed: 0, price_floor: 15, price_ceiling: 18 }, cookie);
assert(r.json && r.json.ok, 'on: create floor/ceiling template');
const floorId = r.json.template.id;
r = await call('POST', '/api/admin/pricing-templates', { name: '坏控价', markup: 1, fixed: 0, price_floor: 20, price_ceiling: 10 }, cookie);
assert(r.json && r.json.ok === false, 'on: floor above ceiling rejected');
db.prepare("UPDATE upstream_cache SET payload=? WHERE key='products'").run(JSON.stringify([
  { id: 'PS-T1', title: '模板新货', cost: 10, inStock: true },
  { id: 'PS-T2', title: '控价新货', cost: 100, inStock: true },
]));
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-T1' }], template_id: tplId }, cookie);
assert(r.json && r.json.ok && r.json.template_id === tplId && r.json.template_ignored === false && r.json.sell_price_preserved === 0, 'on: import with template: ' + JSON.stringify(r.json));
const t1 = q("SELECT * FROM products WHERE prodseller_id='PS-T1'");
assert(Number(t1.sell_price) === 21 && Number(t1.price_usdt) === 21 && Number(t1.cost_price) === 10, 'on: new import sell = 10*2+1 = ' + t1.sell_price);
db.prepare('UPDATE products SET sell_price=99, price_usdt=99 WHERE id=?').run(t1.id);
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-T1' }], template_id: tplId }, cookie);
assert(r.json && r.json.ok && r.json.sell_price_preserved === 1, 'on: re-import reports preserved sell');
const t1b = q('SELECT sell_price, price_usdt, cost_price FROM products WHERE id=?', t1.id);
assert(Number(t1b.sell_price) === 99 && Number(t1b.price_usdt) === 99 && Number(t1b.cost_price) === 10, 'on: re-import keeps admin sell price');
r = await call('POST', '/api/admin/products/' + t1.id + '/apply-pricing-template', { template_id: tplId }, cookie);
assert(r.json && r.json.ok && r.json.sell_price === 21, 'on: explicit apply overwrites sell: ' + JSON.stringify(r.json));
r = await call('POST', '/api/admin/products/' + t1.id + '/apply-pricing-template', { template_id: tplId }, cookie);
assert(r.json && r.json.ok && r.json.sell_price === 21, 'on: apply twice is same price');
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-T2' }], template_id: floorId }, cookie);
const t2 = q("SELECT sell_price FROM products WHERE prodseller_id='PS-T2'");
assert(Number(t2.sell_price) === 18, 'on: ceiling clamps 100 to 18, got ' + (t2 && t2.sell_price));
r = await call('POST', '/api/admin/pricing-templates/' + tplId + '/deactivate', {}, cookie);
assert(r.json && r.json.ok && r.json.template.is_active === 0, 'on: deactivate template');
r = await call('POST', '/api/admin/pricing-templates/' + tplId + '/deactivate', {}, cookie);
assert(r.json && r.json.idempotent === true, 'on: deactivate twice is idempotent');
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-T2' }], template_id: tplId }, cookie);
assert(r.json && r.json.ok === false, 'on: inactive template rejected on import');
assert(Number(q('SELECT sell_price FROM products WHERE id=?', t1.id).sell_price) === 21, 'on: rejected import did not change sell');

const upStart = html.indexOf('async function renderAdminUpstream');
const upEnd = html.indexOf('window._upCatalog');
const upFn = html.slice(upStart, upEnd);
const gate = upFn.indexOf('if (ptOn)');
assert(gate !== -1 && upFn.indexOf('id="upTpl"') > gate && upFn.indexOf('pricingAdvancedHTML') > gate, 'upstream dropdown is built only inside ptOn');
assert(!/display\s*:\s*none/.test(upFn.slice(gate, upFn.indexOf('id="upTpl"') + 20)), 'template dropdown is not CSS-hidden');
assert(!html.includes('data-tab="pricing"') && !html.includes("['pricing'"), 'pricing is not a standalone nav item');
const formStart = html.indexOf('function productFormHTML');
const formEnd = html.indexOf('function productImagePickerHTML');
const formFn = html.slice(formStart, formEnd);
assert(formFn.indexOf('if (window._pricingTemplatesEnabled)') !== -1 && formFn.indexOf("pfx + 'tpl\">'") > formFn.indexOf('if (window._pricingTemplatesEnabled)'), 'product template select is not rendered unless the flag is on');
assert(html.includes('function renderAdminPricing') && html.includes('id="pricingAdvanced"'), 'pricing UI still exists as the upstream advanced panel');
assert(html.includes('/api/admin/settings') && html.includes('pricing_templates_enabled'), 'flag is read from admin settings');
assert(!html.includes("config.pricing_templates") && !/\/api\/config[\s\S]{0,200}pricing_templates/.test(html), 'frontend does not take the flag from public config');

console.log('PRICING TEMPLATES FLAG TEST DONE');
