// 上游同步 / 导入：简介、使用说明、规格文案里的 data: 图片换成「[图片已移除]」。
// 自营商品、https、同源路径不改。不连真实上游。
// 运行：node tests/upstream-data-image-test.mjs
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
  PRODSELLER_API_KEY: 'test-key',
  PRODSELLER_BASE_URL: 'https://prodseller.com/v1',
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

const PH = '[图片已移除]';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPEG = 'DATA:image/jpeg;base64,/9j/4AAQ';
const GIF = 'data:image/gif;base64,R0lGOD';
function hasDataImage(s) { return /data:\s*image\//i.test(String(s || '')); }

let upstreamPayload = [];
env.__fetch = async function (url) {
  const u = String(url);
  if (u.indexOf('prodseller.com/v1/products') !== -1) return new Response(JSON.stringify(upstreamPayload), { status: 200 });
  return new Response('{}', { status: 404 });
};

let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
assert(r.json && r.json.ok, 'admin login');
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await call('POST', '/api/admin/change-password', { old_password: '', new_password: 'test-admin-password-123' }, cookie);
assert(r.json && r.json.ok, 'change-password');
cookie = (r.headers.get('set-cookie') || '').split(';')[0] || cookie;

const selfDesc = '自营说明 ![码](' + PNG + ')\n   ' + JPEG + '\n<img src="' + GIF + '">\nhttps://cdn.example/pay.png\n/icons/pay.png';
const selfNotice = '自营使用说明 <img src="  ' + PNG + '">';
const selfImage = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
r = await call('POST', '/api/admin/products', {
  slug: 'self-keep-data', title: '自营保留', category: 'recharge', sell_price: 3, source: 'self', stock_type: 'manual',
  description: selfDesc, notice: selfNotice, image_data: selfImage, form_fields: [],
}, cookie);
assert(r.json && r.json.ok, 'create self product: ' + JSON.stringify(r.json));
const selfRow = q("SELECT description, notice, image_data, source FROM products WHERE slug='self-keep-data'");
assert(selfRow && selfRow.description === selfDesc && selfRow.notice === selfNotice && selfRow.image_data === selfImage, 'self-operated copy and image_data unchanged');
r = await call('GET', '/api/products/' + q("SELECT id FROM products WHERE slug='self-keep-data'").id);
assert(r.json && r.json.product.description === selfDesc && r.json.product.notice === selfNotice, 'public self product still returns original data: text');

const desc = [
  '说明开头',
  '![收款码](' + PNG + ')',
  '   ' + JPEG,
  '<img src="  ' + GIF + ' " alt="qr">',
  '<IMG SRC="DATA:image/png;base64,abc">',
  '见 ' + PNG + ' 和 ' + JPEG,
  'https://cdn.example/pay.png',
  '/icons/pay.png',
  '<img src="https://cdn.example/pay.png">',
  '<img src="/icons/pay.png">',
  '普通 data:text/plain,hello 不是图片',
].join('\n');
db.prepare("INSERT INTO upstream_cache (key, payload, fetched_at) VALUES ('products', ?, datetime('now'))").run(JSON.stringify([
  { id: 'PS-DESC', title: '简介变体', cost: 10, description: desc },
  { id: 'PS-USE', title: '使用说明', cost: 4, description: '简介保留 https://cdn.example/help.png', usage: '  ![步骤](  ' + PNG + ')' },
  { id: 'PS-NOTE', title: 'notice 别名', cost: 4, description: '只有简介', notice: '请看 <img src="' + GIF + '"> 后打开 /icons/help.png' },
  { id: 'PS-SPEC', title: '规格', cost: 6, description: '简介 https://cdn.example/a.png', specs: ['   ' + JPEG, '同站 /icons/spec.png'] },
  { id: 'PS-SPEC2', title: '规格字符串', cost: 6, description: '', spec: '<img src="data:image/webp;base64,UklG"> 以及 https://cdn.example/spec.png' },
]));
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-DESC' }, { id: 'PS-USE' }, { id: 'PS-NOTE' }, { id: 'PS-SPEC' }, { id: 'PS-SPEC2' }] }, cookie);
assert(r.json && r.json.ok && r.json.imported === 5, 'import five upstream products: ' + JSON.stringify(r.json));

const d = q("SELECT description, notice FROM products WHERE prodseller_id='PS-DESC'");
assert(d && !hasDataImage(d.description) && !hasDataImage(d.notice), 'description import has no data:image: ' + JSON.stringify(d));
assert(d.description.includes('说明开头') && d.description.includes(PH), 'description keeps text and placeholder');
assert((d.description.match(/\[图片已移除\]/g) || []).length >= 5, 'markdown, raw, img, uppercase img, second raw all replaced: ' + d.description);
assert(d.description.includes('https://cdn.example/pay.png'), 'https ref kept in description');
assert(d.description.includes('/icons/pay.png'), 'same-site ref kept in description');
assert(d.description.includes('<img src="https://cdn.example/pay.png">'), 'https img tag kept');
assert(d.description.includes('<img src="/icons/pay.png">'), 'same-site img tag kept');
assert(d.description.includes('data:text/plain,hello'), 'non-image data: URI kept');
assert(d.description.startsWith('说明开头'), 'leading prose kept');
assert(d.description.includes('\n   ' + PH), 'leading whitespace before raw data:image kept, URI replaced');
assert(!d.description.includes('![收款码]'), 'markdown image syntax removed');
assert(d.notice === '', 'no usage field leaves notice empty');

const use = q("SELECT description, notice FROM products WHERE prodseller_id='PS-USE'");
assert(use.description === '简介保留 https://cdn.example/help.png', 'usage product description unchanged aside from no data image: ' + use.description);
assert(use.notice === '  ' + PH, 'markdown data image in usage notes replaced, leading space kept: ' + JSON.stringify(use.notice));
assert(!hasDataImage(use.notice), 'usage notes have no data:image');

const note = q("SELECT description, notice FROM products WHERE prodseller_id='PS-NOTE'");
assert(note.notice === '请看 ' + PH + ' 后打开 /icons/help.png', 'notice alias img replaced, same-site kept: ' + note.notice);
assert(!hasDataImage(note.notice) && note.description === '只有简介', 'notice product description untouched');

const spec = q("SELECT description, notice FROM products WHERE prodseller_id='PS-SPEC'");
assert(spec.description === '简介 https://cdn.example/a.png\n   ' + PH + '\n同站 /icons/spec.png', 'spec array appended after strip: ' + JSON.stringify(spec.description));
assert(!hasDataImage(spec.description) && spec.notice === '', 'spec product has no data:image and no notice');

const spec2 = q("SELECT description FROM products WHERE prodseller_id='PS-SPEC2'");
assert(spec2.description === PH + ' 以及 https://cdn.example/spec.png', 'spec string becomes description when description empty: ' + JSON.stringify(spec2.description));
assert(!hasDataImage(spec2.description), 'spec string has no data:image');

const pub = await call('GET', '/api/products/' + q("SELECT id FROM products WHERE prodseller_id='PS-DESC'").id);
assert(pub.json && pub.json.product.description === d.description && !hasDataImage(pub.json.product.description), 'public product returns sanitized description');

db.prepare("UPDATE products SET description=?, notice=?, sell_price=99, price_usdt=99 WHERE prodseller_id='PS-DESC'").run('管理员保留 ' + PNG, '手改说明 ' + GIF);
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-DESC' }] }, cookie);
assert(r.json && r.json.ok && r.json.sell_price_preserved === 1, 'reimport reports preserved sell');
const kept = q("SELECT description, notice, sell_price FROM products WHERE prodseller_id='PS-DESC'");
assert(kept.description === '管理员保留 ' + PNG && kept.notice === '手改说明 ' + GIF && Number(kept.sell_price) === 99, 'reimport keeps admin description, notice, and sell price');

upstreamPayload = [
  {
    id: 'PS-SYNC',
    title: '同步商品',
    cost: 8,
    description: '同步简介 ![码](' + PNG + ')\nhttps://cdn.example/sync.png\n/icons/sync.png',
    instructions: '同步说明\n   ' + JPEG,
    spec: '<img src="' + GIF + '">',
  },
  {
    id: 'PS-SYNC2',
    title: '包装列表',
    cost: 1,
    description: 'plain',
  },
];
r = await call('POST', '/api/admin/upstream/sync', {}, cookie);
assert(r.json && r.json.ok && r.json.count === 2, 'sync count: ' + JSON.stringify(r.json));
const cached = JSON.parse(q("SELECT payload FROM upstream_cache WHERE key='products'").payload);
const syncRow = cached.find((x) => x.id === 'PS-SYNC');
assert(syncRow && !hasDataImage(syncRow.description) && syncRow.description.includes(PH) && syncRow.description.includes('https://cdn.example/sync.png') && syncRow.description.includes('/icons/sync.png'), 'sync cache description sanitized: ' + syncRow.description);
assert(!syncRow.description.includes('![码]'), 'sync cache drops markdown data image');
assert(syncRow.instructions === '同步说明\n   ' + PH, 'sync cache usage notes sanitized: ' + JSON.stringify(syncRow.instructions));
assert(syncRow.spec === PH, 'sync cache spec text sanitized: ' + JSON.stringify(syncRow.spec));
assert(!hasDataImage(JSON.stringify(syncRow)), 'sync product has no data:image left in copy fields');

r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-SYNC' }] }, cookie);
assert(r.json && r.json.ok && r.json.imported === 1, 'import after sync');
const synced = q("SELECT description, notice FROM products WHERE prodseller_id='PS-SYNC'");
assert(synced.notice === '同步说明\n   ' + PH, 'imported notice comes from sanitized instructions: ' + JSON.stringify(synced.notice));
assert(synced.description === '同步简介 ' + PH + '\nhttps://cdn.example/sync.png\n/icons/sync.png\n' + PH, 'imported description appends sanitized spec: ' + JSON.stringify(synced.description));
assert(!hasDataImage(synced.description) && !hasDataImage(synced.notice), 'imported sync product has no data:image');

upstreamPayload = { products: [{ id: 'PS-WRAP', title: '包装', cost: 2, description: '<img src="' + PNG + '">', usage_notes: '用法 ' + JPEG, specification: '规格 /icons/wrap.png' }] };
r = await call('POST', '/api/admin/upstream/sync', {}, cookie);
assert(r.json && r.json.ok && r.json.count === 1, 'sync wrapped products array: ' + JSON.stringify(r.json));
const wrapped = JSON.parse(q("SELECT payload FROM upstream_cache WHERE key='products'").payload);
assert(wrapped && wrapped.products && wrapped.products[0].description === PH, 'wrapped description sanitized: ' + JSON.stringify(wrapped.products[0]));
assert(wrapped.products[0].usage_notes === '用法 ' + PH, 'wrapped usage_notes sanitized');
assert(wrapped.products[0].specification === '规格 /icons/wrap.png', 'wrapped specification keeps same-site text');
assert(!hasDataImage(JSON.stringify(wrapped.products[0])), 'wrapped product copy has no data:image');

console.log('UPSTREAM DATA IMAGE TEST DONE');
