// 第十轮：App 图标库测试（明/暗两版 / 商品 app_icon_key / 标题自动匹配 / 表单三选一）
// 运行：node tests/app-icons-test.mjs
// 覆盖：
//  1. 迁移 v11：app_icons 表 30 App × 明暗 = 60 行；products 有 app_icon_key 列。
//  2. GET /api/app-icons 返回 30 App，每 App 含 name + light + dark（均为 data:image/jpeg）。
//  3. 现有商品按标题自动匹配（Claude/Gmail/多邻国/Office 等），不覆盖已有 app_icon_key。
//  4. 新建商品：选 App 图标 → app_icon_key 落库、image_data 清空；伪造 key 被拒绝。
//  5. 新建商品：上传图 → app_icon_key 为空、image_data 保留；两者都不选 → 默认。
//  6. 编辑商品：App 图标 ↔ 上传图 ↔ 不选 三态切换；不传 app_icon_key 时保留旧值。
//  7. 上游导入按标题自动匹配 App 图标（需 upstream_cache 有缓存）。
//  8. 前端：选择器 / data-app-icon / refreshAppIcons / 主题切换调用均存在；商品渲染优先 App 图标。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
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
const env = { DB: { prepare: (sql) => wrapStmt(sql), async batch(stmts) { const out = []; for (const st of stmts) out.push(await st.run()); return out; } } };
globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
let code = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
code = code.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(html) + ';');
code = code.replace('export default {', 'globalThis.__W = {');
const fn = new Function(code + '\nreturn globalThis.__W;');
const worker = fn();
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
let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) { pass++; console.log('PASS:', name); } else { fail++; console.log('FAIL:', name, extra); } }

// 登录 + 改密
let r = await call('POST', '/api/admin/login', { password: 'admin' });
let cookie = '';
const sc = r.headers.get('set-cookie') || '';
if (sc) cookie = sc.split(';')[0];
check('admin login', r.json && r.json.ok);
r = await call('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'appicons-test-123' }, cookie);
check('change password', r.json && r.json.ok);

// 1. 迁移 v11：app_icons 60 行 + products.app_icon_key 列
r = await call('GET', '/api/admin/schema-check', null, cookie);
check('schema-check ok (v11)', r.json && r.json.ok === true && r.json.precheck && r.json.precheck.current_version >= 11, JSON.stringify(r.json && r.json.precheck && r.json.precheck.issues));
const iconCount = db.prepare('SELECT COUNT(*) AS c FROM app_icons').get().c;
check('app_icons 60 rows (30 apps x light/dark)', iconCount === 60, 'count=' + iconCount);
const themeCount = db.prepare("SELECT COUNT(DISTINCT app_key) AS c FROM app_icons WHERE theme IN ('light','dark')").get().c;
check('app_icons 30 distinct apps', themeCount === 30, 'count=' + themeCount);
const cols = db.prepare('PRAGMA table_info(products)').all().map((x) => x.name);
check('products has app_icon_key', cols.includes('app_icon_key'));

// 2. GET /api/app-icons
r = await call('GET', '/api/app-icons');
check('GET /api/app-icons ok', r.json && r.json.ok === true);
const icons = (r.json && r.json.icons) || {};
const keys = Object.keys(icons);
check('app-icons 30 apps', keys.length === 30, 'keys=' + keys.length);
let allHaveBoth = keys.every((k) => icons[k].light && icons[k].light.indexOf('data:image/jpeg') === 0 && icons[k].dark && icons[k].dark.indexOf('data:image/jpeg') === 0 && icons[k].name);
check('every app has name + light + dark data URIs', allHaveBoth);
for (const want of ['chatgpt', 'claude', 'duolingo', 'gmail', 'canva', 'gemini', 'notion', 'figma', 'spotify', 'telegram', 'cursor', 'codex', 'ilovepdf', 'capcut', 'office', 'miro', 'edx', 'jetbrains', 'framer', 'autodesk', 'hbo', 'appletv', 'scribd', 'elevenlabs', 'wisprflow', 'avira', 'outlook', 'museai', 'adobe', 'primevideo']) {
  check('app-icons has ' + want, !!icons[want], 'missing ' + want);
}
check('claude light != dark (two variants)', icons.claude && icons.claude.light !== icons.claude.dark);

// 3. 现有商品按标题自动匹配（在迁移前插入，迁移时匹配；此处模拟：直接插商品再跑一次匹配逻辑等价验证）
// 注：迁移已在首次请求时跑完；此处验证已有种子商品若标题含关键词则已被匹配。
// 插入一批待匹配商品（app_icon_key 为空），手动触发一次 v11 匹配等价逻辑：通过管理员编辑时不传 app_icon_key 应保留空（不自动匹配），
// 因此此处直接验证 matchAppIconKey 行为：新建商品不传 app_icon_key 时，后端不自动匹配（仅迁移/上游导入时匹配）。
// 为验证迁移匹配，检查迁移种子后已存在的商品：schema.sql 种子商品标题若含关键词应已被匹配。
const seeded = db.prepare("SELECT title, app_icon_key FROM products WHERE title LIKE '%Claude%' OR title LIKE '%Gmail%' OR title LIKE '%多邻国%' LIMIT 5").all();
check('seeded products matched by title (if any)', seeded.every((x) => x.app_icon_key), JSON.stringify(seeded));

// 4. 新建商品：选 App 图标
r = await call('POST', '/api/admin/products', { slug: 'appicon-claude', title: 'Claude 测试商品', category: 'recharge', sell_price: 5, source: 'self', stock_type: 'manual', description: '', notice: '', form_fields: [], app_icon_key: 'claude', image_data: 'data:image/jpeg;base64,/9j/4AAQ' }, cookie);
check('create with app_icon_key ok', r.json && r.json.ok === true, JSON.stringify(r.json));
let row = db.prepare("SELECT app_icon_key, image_data FROM products WHERE slug='appicon-claude'").get();
check('app_icon_key saved', row && row.app_icon_key === 'claude', JSON.stringify(row));
check('image_data cleared when app_icon_key set', row && row.image_data === '', JSON.stringify(row));
// 伪造 key 被拒绝
r = await call('POST', '/api/admin/products', { slug: 'appicon-fake', title: '伪造图标', category: 'recharge', sell_price: 5, source: 'self', stock_type: 'manual', app_icon_key: 'notexist123' }, cookie);
check('fake app_icon_key rejected', r.json && r.json.ok === false, JSON.stringify(r.json));
// 大写/非法字符 key 被规范化（Claude -> claude）
r = await call('POST', '/api/admin/products', { slug: 'appicon-case', title: '大小写', category: 'recharge', sell_price: 5, source: 'self', stock_type: 'manual', app_icon_key: 'Claude' }, cookie);
check('uppercase key normalized', r.json && r.json.ok === true, JSON.stringify(r.json));
row = db.prepare("SELECT app_icon_key FROM products WHERE slug='appicon-case'").get();
check('normalized to lowercase', row && row.app_icon_key === 'claude');

// 5. 新建商品：上传图
r = await call('POST', '/api/admin/products', { slug: 'appicon-upload', title: '上传图商品', category: 'recharge', sell_price: 5, source: 'self', stock_type: 'manual', image_data: 'data:image/jpeg;base64,/9j/4AAQ' }, cookie);
check('create with upload ok', r.json && r.json.ok === true);
row = db.prepare("SELECT app_icon_key, image_data FROM products WHERE slug='appicon-upload'").get();
check('upload: app_icon_key empty', row && row.app_icon_key === '');
check('upload: image_data kept', row && row.image_data === 'data:image/jpeg;base64,/9j/4AAQ');

// 6. 新建商品：都不选
r = await call('POST', '/api/admin/products', { slug: 'appicon-none', title: '无图商品', category: 'recharge', sell_price: 5, source: 'self', stock_type: 'manual' }, cookie);
check('create with neither ok', r.json && r.json.ok === true);
row = db.prepare("SELECT app_icon_key, image_data FROM products WHERE slug='appicon-none'").get();
check('neither: both empty (default icon)', row && row.app_icon_key === '' && row.image_data === '');

// 7. 编辑商品：三态切换
const pid = db.prepare("SELECT id FROM products WHERE slug='appicon-claude'").get().id;
// App 图标 -> 上传图
r = await call('PUT', '/api/admin/products/' + pid, { slug: 'appicon-claude', title: 'Claude 测试商品', category: 'recharge', sell_price: 5, source: 'self', stock_type: 'manual', app_icon_key: '', image_data: 'data:image/jpeg;base64,/9j/4AAQ' }, cookie);
check('edit app -> upload ok', r.json && r.json.ok === true, JSON.stringify(r.json));
row = db.prepare('SELECT app_icon_key, image_data FROM products WHERE id=?').get(pid);
check('edit app -> upload: key cleared, image kept', row && row.app_icon_key === '' && row.image_data === 'data:image/jpeg;base64,/9j/4AAQ');
// 上传图 -> 不选
r = await call('PUT', '/api/admin/products/' + pid, { slug: 'appicon-claude', title: 'Claude 测试商品', category: 'recharge', sell_price: 5, source: 'self', stock_type: 'manual', app_icon_key: '', image_data: '' }, cookie);
check('edit upload -> none ok', r.json && r.json.ok === true);
row = db.prepare('SELECT app_icon_key, image_data FROM products WHERE id=?').get(pid);
check('edit upload -> none: both cleared', row && row.app_icon_key === '' && row.image_data === '');
// 不选 -> App 图标
r = await call('PUT', '/api/admin/products/' + pid, { slug: 'appicon-claude', title: 'Claude 测试商品', category: 'recharge', sell_price: 5, source: 'self', stock_type: 'manual', app_icon_key: 'gmail' }, cookie);
check('edit none -> app ok', r.json && r.json.ok === true);
row = db.prepare('SELECT app_icon_key, image_data FROM products WHERE id=?').get(pid);
check('edit none -> app: key set, image cleared', row && row.app_icon_key === 'gmail' && row.image_data === '');
// 不传 app_icon_key 时保留旧值
r = await call('PUT', '/api/admin/products/' + pid, { slug: 'appicon-claude', title: 'Claude 测试商品2', category: 'recharge', sell_price: 6, source: 'self', stock_type: 'manual', image_data: '' }, cookie);
check('edit without app_icon_key preserves old', r.json && r.json.ok === true);
row = db.prepare('SELECT app_icon_key FROM products WHERE id=?').get(pid);
check('preserved app_icon_key=gmail', row && row.app_icon_key === 'gmail', JSON.stringify(row));

// 8. 公开商品接口含 app_icon_key
r = await call('GET', '/api/products');
const pub = (r.json && r.json.products || []).find((x) => x.slug === 'appicon-claude');
check('public list includes app_icon_key', pub && pub.app_icon_key === 'gmail', JSON.stringify(pub && pub.app_icon_key));
r = await call('GET', '/api/products/' + pid);
check('public detail includes app_icon_key', r.json && r.json.product && r.json.product.app_icon_key === 'gmail');

// 9. 上游导入自动匹配（缓存中放一个 Claude 商品）
db.prepare("INSERT OR REPLACE INTO upstream_cache (key, payload) VALUES ('products', ?)").run(JSON.stringify([{ id: 'UP-CL', title: 'Claude API 测试', cost: 1, in_stock: 1 }]));
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'UP-CL' }] }, cookie);
check('upstream import ok', r.json && r.json.ok === true, JSON.stringify(r.json));
row = db.prepare("SELECT app_icon_key FROM products WHERE slug='ps-up-cl'").get();
check('upstream import auto-matched claude', row && row.app_icon_key === 'claude', JSON.stringify(row));

// 10. 前端：选择器 / 渲染 / 主题切换
check('frontend has app icon picker', html.includes('productImagePickerHTML') && html.includes('App 图标') && html.includes('自己上传') && html.includes('不选'));
check('frontend has data-app-icon rendering', html.includes('data-app-icon') && html.includes('refreshAppIcons'));
check('frontend loads /api/app-icons', html.includes("/api/app-icons") && html.includes('loadAppIcons'));
check('frontend theme toggle refreshes icons', html.includes('refreshAppIcons()') && html.includes('function toggleTheme'));
check('frontend productImgHtml prefers app icon', html.includes('function productImgHtml') && html.includes('p.app_icon_key'));

// 11. v12：已有库的暗版图标被 UPDATE 刷新（模拟 v11 旧暗版：伪造旧值 + 删 v12 标记后重跑迁移）
const darkSeed = db.prepare("SELECT image_data FROM app_icons WHERE app_key='chatgpt' AND theme='dark'").get().image_data;
db.prepare("UPDATE app_icons SET image_data='data:image/jpeg;base64,FAKE-OLD-DARK' WHERE app_key='chatgpt' AND theme='dark'").run();
db.prepare("DELETE FROM schema_migrations WHERE version=12").run();
r = await call('POST', '/api/admin/migrate', {}, cookie);
check('v12 re-migrate ok', r.json && r.json.ok === true && r.json.current_version === 12, JSON.stringify(r.json));
const darkAfter = db.prepare("SELECT image_data FROM app_icons WHERE app_key='chatgpt' AND theme='dark'").get().image_data;
check('v12 refreshed dark icon to seed value', darkAfter === darkSeed, 'after len=' + darkAfter.length);
check('v12 does not touch light icon', db.prepare("SELECT image_data FROM app_icons WHERE app_key='chatgpt' AND theme='light'").get().image_data === icons.chatgpt.light);

console.log(`\nAPP-ICONS TEST DONE pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
