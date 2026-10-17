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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const db = new DatabaseSync(':memory:');
// schema.sql 自 v15 起不再建 schema_migrations 表（仅 INSERT 预置版本），与 Worker runMigrations 一致：先建表再执行 schema.sql。
// 注意：schema.sql 缺 CREATE TABLE schema_migrations 是代码侧缺陷（已在最终汇报中精确报告），测试侧按运行时行为先建表，不改 schema.sql。
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))" );
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
check('telegram dark is flood-filled (not white-bg original)', icons.telegram && icons.telegram.dark !== icons.telegram.light && icons.telegram.dark.length > icons.telegram.light.length);

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
// P2-17：ac82de2 回归（未付款订单也显示密码输入框）：doQueryList 内密码输入分支不在
// pending_payment 的 else if 链内（密码输入分支是独立 if，与 pending_payment 提示块解耦）。
{
  const dqStart = html.indexOf('async function doQueryList');
  const dqEnd = html.indexOf('async function doQuerySecret', dqStart);
  const dqSrc = dqStart !== -1 && dqEnd !== -1 ? html.slice(dqStart, dqEnd) : '';
  const pwIdx = dqSrc.indexOf("if (o.credential_type === 'password')");
  const ppIdx = dqSrc.indexOf("if (o.status === 'pending_payment')");
  check('P2-17: doQueryList found', !!dqSrc);
  check('P2-17: password input branch is a standalone if (not else if)', pwIdx !== -1 && !dqSrc.includes("else if (o.credential_type === 'password')"));
  const between = (ppIdx !== -1 && pwIdx !== -1 && pwIdx > ppIdx) ? dqSrc.slice(ppIdx, pwIdx) : '';
  check('P2-17: password branch NOT inside pending_payment else-if chain (pending_payment block closed before it, no else if between)', ppIdx !== -1 && pwIdx > ppIdx && !between.includes('else if') && between.includes('}'));
  check('P2-17: password branch renders qpw-<order_no> input', dqSrc.includes("qpw-' + escH(o.order_no)") || dqSrc.includes('qpw-'));
}
check('dark mode: image containers not white (pcard-img/prod-img/detail-img-photo)', html.includes('html[data-theme="dark"] .pcard-img{background:#1c1c1e}') && html.includes('html[data-theme="dark"] .prod-img{background:#1c1c1e}') && html.includes('html[data-theme="dark"] .detail-img-photo{background:#1c1c1e}'));
check('mobile product form full-bleed alignment (modal edges = input edges)', html.includes('modal-fullbleed') && html.includes("fullBleed: true") && html.includes('.modal-backdrop.modal-fullbleed .modal{padding-left:0;padding-right:0}'));
check('modal cannot scroll horizontally (overflow-x:hidden; icon grid min-width:0)', html.includes('overflow-x:hidden') && html.includes('border-radius:12px;min-width:0;'));
check('product sub-nav: upstream/self under products (admin-nav-sub)', html.includes('admin-nav-sub') && html.includes("data-tab=\"products-upstream\"") && html.includes('对接商品') && html.includes("data-tab=\"products-self\"") && html.includes('自营商品'));
check('product sub-nav: view locks source filter + new product defaults to view source', html.includes('prodViewSource()') && html.includes('prodViewTitle()') && html.includes("window._prodView = 'upstream'") && html.includes("window._prodView = 'self'") && html.includes('adminProductForm(null') && html.includes('defaultSource'));

// 11. v12/v13：已有库的暗版图标被 UPDATE 刷新（模拟 v11 旧暗版：伪造旧值 + 删迁移标记后重跑迁移）
const darkSeed = db.prepare("SELECT image_data FROM app_icons WHERE app_key='chatgpt' AND theme='dark'").get().image_data;
db.prepare("UPDATE app_icons SET image_data='data:image/jpeg;base64,FAKE-OLD-DARK' WHERE app_key='chatgpt' AND theme='dark'").run();
db.prepare("DELETE FROM schema_migrations WHERE version=12").run();
r = await call('POST', '/api/admin/migrate', {}, cookie);
check('v12 re-migrate ok', r.json && r.json.ok === true && r.json.current_version === 15, JSON.stringify(r.json));
const darkAfter = db.prepare("SELECT image_data FROM app_icons WHERE app_key='chatgpt' AND theme='dark'").get().image_data;
check('v12 refreshed dark icon to seed value', darkAfter === darkSeed, 'after len=' + darkAfter.length);
check('v12 does not touch light icon', db.prepare("SELECT image_data FROM app_icons WHERE app_key='chatgpt' AND theme='light'").get().image_data === icons.chatgpt.light);
// v13：Telegram 暗版伪造旧值（白底版）+ 删 v13 标记，重跑后应刷为泛洪填充版（与种子值一致，且不同于旧白底版）
const tgSeed = db.prepare("SELECT image_data FROM app_icons WHERE app_key='telegram' AND theme='dark'").get().image_data;
db.prepare("UPDATE app_icons SET image_data='data:image/jpeg;base64,FAKE-OLD-TELEGRAM-WHITE' WHERE app_key='telegram' AND theme='dark'").run();
db.prepare("DELETE FROM schema_migrations WHERE version=13").run();
r = await call('POST', '/api/admin/migrate', {}, cookie);
check('v13 re-migrate ok', r.json && r.json.ok === true && r.json.current_version === 15, JSON.stringify(r.json));
const tgAfter = db.prepare("SELECT image_data FROM app_icons WHERE app_key='telegram' AND theme='dark'").get().image_data;
check('v13 refreshed telegram dark to seed value', tgAfter === tgSeed, 'after len=' + tgAfter.length);


// 12. 查单 v15：查询密码必填 + 随机 salt PBKDF2 + 邮箱不是查询凭证 + 旧订单转管理员流程
function sha256hex(s){ return createHash('sha256').update(s).digest('hex'); }
function seedCaptcha(id, code){ db.prepare('INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)').run(id, sha256hex(code), '2099-01-01 00:00:00'); }
r = await call('POST', '/api/admin/settings', { settings: { usdt_addresses: JSON.stringify({ 'OKX|X Layer': '0x' + '1'.repeat(40), 'Binance|BEP20': '0x' + '2'.repeat(40) }) } }, cookie);
check('query-flow: set wallet addresses', r.json && r.json.ok);
r = await call('POST', '/api/admin/products', { slug: 'qf-test', title: 'QF 测试商品', sell_price: 1, cost_price: 0, source: 'self', category: 'recharge', stock_type: 'manual', in_stock: 1, is_active: 1, description: '', notice: '' }, cookie);
check('query-flow: create product', r.json && r.json.ok, JSON.stringify(r.json));
const qfPidRow = db.prepare('SELECT id FROM products WHERE slug = ?').get('qf-test');
const qfPid = qfPidRow ? qfPidRow.id : 0;
seedCaptcha('qf-cap-1', 'TEST');
r = await call('POST', '/api/orders', { product_id: qfPid, quantity: 1, customer_fields: {}, contact: 'buyer@example.com', pay_method: 'OKX', pay_chain: 'X Layer', captcha_id: 'qf-cap-1', captcha_code: 'TEST', query_password: 'mypw123' });
check('query-flow: order with query_password returns no query_token', r.json && r.json.ok && !r.json.order.query_token && r.json.order.has_query_password === 1, JSON.stringify(r.json));
const qfNo1 = r.json && r.json.order ? r.json.order.order_no : '';
const qfRow1 = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(qfNo1);
check('query-flow: query_password stored as salted PBKDF2 hash (44-char base64, not plaintext, not raw sha256)', qfRow1 && qfRow1.query_password_hash && qfRow1.query_password_hash.length === 44 && qfRow1.query_password_hash !== sha256hex('mypw123') && !String(qfRow1.query_password_hash).includes('mypw123'));
check('query-flow: query_password_salt is random 16 bytes base64 (24 chars)', qfRow1 && qfRow1.query_password_salt && qfRow1.query_password_salt.length === 24 && !String(qfRow1.query_password_salt).includes('mypw123'));
check('query-flow: new order has no system token', qfRow1 && !qfRow1.query_token_hash);
seedCaptcha('qf-cap-2', 'TEST');
r = await call('POST', '/api/orders', { product_id: qfPid, quantity: 1, customer_fields: {}, contact: 'nopw@example.com', pay_method: 'OKX', pay_chain: 'X Layer', captcha_id: 'qf-cap-2', captcha_code: 'TEST' });
check('query-flow: order without query_password rejected (password required)', r.json && !r.json.ok && /查询密码/.test(r.json.error || ''), JSON.stringify(r.json));
seedCaptcha('qf-cap-2b', 'TEST');
r = await call('POST', '/api/orders', { product_id: qfPid, quantity: 1, customer_fields: {}, contact: 'shortpw@example.com', pay_method: 'OKX', pay_chain: 'X Layer', captcha_id: 'qf-cap-2b', captcha_code: 'TEST', query_password: 'abc' });
check('query-flow: order with short query_password rejected', r.json && !r.json.ok && /至少 6 位/.test(r.json.error || ''), JSON.stringify(r.json));
seedCaptcha('qf-cap-2c', 'TEST');
r = await call('POST', '/api/orders', { product_id: qfPid, quantity: 1, customer_fields: {}, contact: 'second@example.com', pay_method: 'OKX', pay_chain: 'X Layer', captcha_id: 'qf-cap-2c', captcha_code: 'TEST', query_password: 'secondpw' });
check('query-flow: second order with password ok', r.json && r.json.ok, JSON.stringify(r.json));
const qfNo2 = r.json && r.json.order ? r.json.order.order_no : '';
db.prepare("UPDATE orders SET status='completed', paid_at='2026-10-17 12:00:00', fulfilled_at='2026-10-17 12:01:00', delivery_content='TEST-CARD-123' WHERE order_no = ?").run(qfNo1);
db.prepare("UPDATE orders SET status='completed', paid_at='2026-10-17 12:00:00', fulfilled_at='2026-10-17 12:01:00', delivery_content='TEST-CARD-789' WHERE order_no = ?").run(qfNo2);
r = await call('POST', '/api/orders/query', { keywords: 'buyer@example.com' });
check('query-flow: query list without captcha rejected', r.status === 401, JSON.stringify(r.json));
seedCaptcha('qf-cap-3', 'TEST');
r = await call('POST', '/api/orders/query', { keywords: 'buyer@example.com', captcha_id: 'qf-cap-3', captcha_code: 'TEST' });
check('query-flow: query by email returns generic empty (email is not a credential)', r.json && r.json.ok && r.json.orders.length === 0, JSON.stringify(r.json));
seedCaptcha('qf-cap-4', 'TEST');
r = await call('POST', '/api/orders/query', { keywords: qfNo1, captcha_id: 'qf-cap-4', captcha_code: 'TEST' });
check('query-flow: query by order_no lists order (no delivery, no has_delivery)', r.json && r.json.ok && r.json.orders.length === 1 && r.json.orders[0].order_no === qfNo1 && r.json.orders[0].credential_type === 'password' && !('delivery_content' in r.json.orders[0]) && !('has_delivery' in r.json.orders[0]), JSON.stringify(r.json));
seedCaptcha('qf-cap-5', 'TEST');
r = await call('POST', '/api/orders/query', { keywords: 'nobody@example.com', captcha_id: 'qf-cap-5', captcha_code: 'TEST' });
check('query-flow: query unknown returns empty list', r.json && r.json.ok && r.json.orders.length === 0, JSON.stringify(r.json));
r = await call('POST', '/api/orders/' + qfNo1 + '/secret', { password: 'wrongpw' });
check('query-flow: secret wrong password 401', r.status === 401, JSON.stringify(r.json));
r = await call('POST', '/api/orders/' + qfNo1 + '/secret', { password: '' });
check('query-flow: secret empty password 401', r.status === 401, JSON.stringify(r.json));
r = await call('POST', '/api/orders/' + qfNo1 + '/secret', { password: 'mypw123' });
check('query-flow: secret correct password returns card', r.json && r.json.ok && r.json.delivery_content === 'TEST-CARD-123', JSON.stringify(r.json));
for (let i = 0; i < 3; i++) await call('POST', '/api/orders/' + qfNo1 + '/secret', { password: 'wrongpw' });
r = await call('POST', '/api/orders/' + qfNo1 + '/secret', { password: 'wrongpw' });
check('query-flow: secret rate limited after 5 attempts (429)', r.status === 429, JSON.stringify(r.json));
// legacy 订单（v14 遗留无 salt 哈希）：/secret 403 转客服，/lookup 只返回 summary（无卡密）
const qfLegacyNo = 'AISQFLEGACY1';
db.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, query_password_hash, query_password_salt, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, delivery_content, created_at) VALUES (?, '', '', ?, '', ?, '{}', 1, 1, 1, 1, '', '2099-01-01 00:00:00', ?, 'legacy@example.com', 'OKX', 'X Layer', '', 'completed', 'LEGACY-CARD-1', datetime('now'))").run(qfLegacyNo, sha256hex('legacypw'), qfPid, JSON.stringify({ contact_email: 'legacy@example.com' }));
r = await call('POST', '/api/orders/' + qfLegacyNo + '/secret', { password: 'legacypw' });
check('query-flow: legacy order secret 403 (admin flow only)', r.status === 403, JSON.stringify(r.json));
r = await call('POST', '/api/orders/' + qfLegacyNo + '/lookup', { password: 'legacypw' });
check('query-flow: legacy order lookup 401 (no usable self-service credential, admin flow only)', r.status === 401, JSON.stringify(r.json));
seedCaptcha('qf-cap-6', 'TEST');
r = await call('POST', '/api/orders/query', { keywords: qfLegacyNo, captcha_id: 'qf-cap-6', captcha_code: 'TEST' });
check('query-flow: legacy order lists as credential_type=legacy', r.json && r.json.ok && r.json.orders.length === 1 && r.json.orders[0].credential_type === 'legacy' && !('delivery_content' in r.json.orders[0]), JSON.stringify(r.json));
// 管理员重置查询密码（第二单，避免撞第一单的限流计数）
const qfRow2 = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(qfNo2);
const qfId2 = qfRow2 ? qfRow2.id : 0;
r = await call('POST', '/api/admin/orders/' + qfId2 + '/reset-query-password', { new_password: 'newpw456' }, cookie);
check('query-flow: admin reset query password', r.json && r.json.ok && !JSON.stringify(r.json).includes('newpw456'), JSON.stringify(r.json));
r = await call('POST', '/api/orders/' + qfNo2 + '/secret', { password: 'secondpw' });
check('query-flow: secret old password 401 after reset', r.status === 401, JSON.stringify(r.json));
r = await call('POST', '/api/orders/' + qfNo2 + '/secret', { password: 'newpw456' });
check('query-flow: secret new password returns card after reset', r.json && r.json.ok && r.json.delivery_content === 'TEST-CARD-789', JSON.stringify(r.json));
// P3-40：/secret 门限顺序：5 次尝试后用正确密码调 /secret，仍应 429（门限先于密码校验）。
// 第二单此前已用 2 次（旧密码 401 + 新密码成功各记 1 次），再补 3 次错误凑满 5 次，第 6 次正确密码 → 429。
for (let i = 0; i < 3; i++) await call('POST', '/api/orders/' + qfNo2 + '/secret', { password: 'wrongpw' });
r = await call('POST', '/api/orders/' + qfNo2 + '/secret', { password: 'newpw456' });
check('P3-40: /secret correct password after 5 attempts -> 429 (gate before password check)', r.status === 429, JSON.stringify(r.json));
check('query-flow: frontend checkout has query_password field', html.includes('id="query_password"') && html.includes('设置查询订单的密码'));
check('query-flow: frontend query page is keyword+list flow', html.includes('id="qkeywords"') && html.includes('doQueryList()') && html.includes('doQuerySecret(') && html.includes('doQueryLegacy('));
check('query-flow: frontend query page says email is not a credential', html.includes('邮箱不能作为查询凭证'));
check('query-flow: frontend success page no longer shows system token', !html.includes('_lastQueryToken') && html.includes('请牢记您设置的查询密码'));

console.log(`\nAPP-ICONS TEST DONE pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
