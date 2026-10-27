// 首页通知弹窗：公开配置字段、管理端写入、version 只在标题/正文变化时 +1、拒绝 EVM 收款地址。
// 虚构文案，不写真实收款地址、密钥或管理员密码。
// 运行：node tests/notice-popup-config-test.mjs
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
const env = { ZHIXUAN_SETUP_TOKEN: 'test-setup-token', DB: { prepare: (sql) => wrapStmt(sql) } };
let code = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
code = code.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(html) + ';');
code = code.replace('export default {', 'globalThis.__W = {');
const worker = new Function(code + '\nreturn globalThis.__W;')();
function makeCtx() { const c = { pending: [] }; c.waitUntil = (pr) => { c.pending.push(pr); }; c.drain = async () => { while (c.pending.length) { const batch = c.pending.splice(0); await Promise.all(batch.map((x) => x.catch(() => {}))); } }; return c; }
async function call(method, p, body, cookie, extraHeaders, omitAdminApi) {
  const ctx = makeCtx();
  const headers = { 'content-type': 'application/json', ...(extraHeaders || {}) };
  if (!omitAdminApi) headers['X-Admin-API'] = '1';
  if (cookie) headers.Cookie = cookie;
  const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: res.status, json: j, text: txt, headers: res.headers };
}
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); } console.log('PASS: ' + msg); }
function setting(key) { const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return row ? row.value : null; }
const ADDR_X = '0x' + 'ab'.repeat(20);
const ADDR_B = '0x' + 'CD'.repeat(20);
const ADDR_UPPER = '0X' + 'ef'.repeat(20);

let r = await call('GET', '/api/config');
assert(r.status === 200 && r.json && r.json.ok, 'public config ok');
const def = r.json.config;
assert(def.notice_popup_enabled === false, 'default enabled is false');
assert(def.notice_popup_title === '' && def.notice_popup_body === '', 'default title and body are empty');
assert(def.notice_popup_version === 0 && typeof def.notice_popup_version === 'number', 'default version is integer 0');
assert(!('email' in def) && !JSON.stringify(def).includes('card_code'), 'public notice fields are not buyer data');

r = await call('POST', '/api/admin/settings', { settings: { notice_popup_enabled: '1', notice_popup_title: '公告', notice_popup_body: '正文' } });
assert(r.status === 401 && r.json && r.json.ok === false, 'unauthenticated settings write is 401');

r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
assert(r.json && r.json.ok, 'admin login');
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await call('POST', '/api/admin/change-password', { old_password: '', new_password: 'test-admin-password-123' }, cookie);
assert(r.json && r.json.ok, 'change-password');
cookie = (r.headers.get('set-cookie') || '').split(';')[0] || cookie;

r = await call('POST', '/api/admin/settings', { settings: { notice_popup_title: '跨站' } }, cookie, {}, true);
assert(r.status === 403, 'settings write without CSRF proof is 403: ' + r.status + ' ' + JSON.stringify(r.json));

r = await call('POST', '/api/admin/settings', { settings: { notice_popup_enabled: '1', notice_popup_title: '维护通知', notice_popup_body: '今晚短暂停服。' } }, cookie);
assert(r.json && r.json.ok === true, 'save notice popup: ' + JSON.stringify(r.json));
assert(setting('notice_popup_version') === '1', 'first content save sets version 1');
r = await call('GET', '/api/config');
const saved = r.json.config;
assert(saved.notice_popup_enabled === true, 'public enabled true');
assert(saved.notice_popup_title === '维护通知' && saved.notice_popup_body === '今晚短暂停服。', 'public title and body');
assert(saved.notice_popup_version === 1, 'public version 1');
r = await call('GET', '/api/admin/settings', null, cookie);
assert(r.json && r.json.settings && r.json.settings.notice_popup_title === '维护通知' && r.json.settings.notice_popup_enabled === '1' && r.json.settings.notice_popup_version === '1', 'admin settings stores the fields');

r = await call('POST', '/api/admin/settings', { settings: { notice_popup_enabled: '0' } }, cookie);
assert(r.json && r.json.ok === true && setting('notice_popup_version') === '1', 'enabled-only change does not bump version');
r = await call('GET', '/api/config');
assert(r.json.config.notice_popup_enabled === false && r.json.config.notice_popup_version === 1 && r.json.config.notice_popup_title === '维护通知', 'toggle off keeps title and version');

r = await call('POST', '/api/admin/settings', { settings: { notice_popup_title: '维护通知', notice_popup_body: '今晚短暂停服。', notice_popup_enabled: '1' } }, cookie);
assert(r.json && r.json.ok === true && setting('notice_popup_version') === '1', 'identical title and body do not bump version');

r = await call('POST', '/api/admin/settings', { key: 'notice_popup_body', value: '恢复后请重新查看订单。' }, cookie);
assert(r.json && r.json.ok === true && setting('notice_popup_version') === '2' && setting('notice_popup_body') === '恢复后请重新查看订单。', 'body change bumps version once');
r = await call('GET', '/api/config');
assert(r.json.config.notice_popup_version === 2 && r.json.config.notice_popup_body === '恢复后请重新查看订单。', 'public config shows bumped version');

const beforeReject = {
  title: setting('notice_popup_title'),
  body: setting('notice_popup_body'),
  enabled: setting('notice_popup_enabled'),
  version: setting('notice_popup_version'),
  site: setting('site_name'),
};
r = await call('POST', '/api/admin/settings', { settings: { site_name: '不该写入', notice_popup_title: '付款到 ' + ADDR_X, notice_popup_body: '正常正文' } }, cookie);
assert(r.status === 400 && r.json && r.json.ok === false && r.json.code === 'notice_contains_address' && r.json.error === '通知正文不能包含收款地址', 'title with X Layer address rejected: ' + JSON.stringify(r.json));
assert(setting('notice_popup_title') === beforeReject.title && setting('site_name') === beforeReject.site && setting('notice_popup_version') === beforeReject.version, 'rejected batch did not write');

r = await call('POST', '/api/admin/settings', { settings: { notice_popup_body: 'BEP20 ' + ADDR_B + ' 请勿转账' } }, cookie);
assert(r.status === 400 && r.json.code === 'notice_contains_address', 'body with BEP20 address rejected');
r = await call('POST', '/api/admin/settings', { settings: { notice_popup_body: '请看 ' + ADDR_UPPER } }, cookie);
assert(r.status === 400 && r.json.code === 'notice_contains_address', '0X mixed-case address rejected');
assert(setting('notice_popup_body') === beforeReject.body && setting('notice_popup_version') === '2', 'address rejects left stored copy and version');

r = await call('POST', '/api/admin/settings', { settings: { notice_popup_body: '短地址 0x1234 不是收款地址，https://example.com/help 保留。' } }, cookie);
assert(r.json && r.json.ok === true && setting('notice_popup_version') === '3', 'short 0x and https stay, version bumps');

r = await call('POST', '/api/admin/settings', { settings: { notice_popup_title: '新标题', notice_popup_version: '99' } }, cookie);
assert(r.status === 400 && r.json && r.json.ok === false && /notice_popup_version/.test(r.json.error || ''), 'client version is rejected: ' + JSON.stringify(r.json));
assert(setting('notice_popup_version') === '3' && setting('notice_popup_title') === beforeReject.title, 'rejected version did not change title or version');

r = await call('POST', '/api/admin/settings', { settings: { notice_popup_enabled: 'yes' } }, cookie);
assert(r.status === 400 && /0 或 1/.test((r.json && r.json.error) || ''), 'enabled must be 0 or 1');

const title100 = '标'.repeat(100);
const title101 = '标'.repeat(101);
const body2000 = '文'.repeat(2000);
const body2001 = '文'.repeat(2001);
r = await call('POST', '/api/admin/settings', { settings: { notice_popup_title: title101 } }, cookie);
assert(r.status === 400 && /100/.test((r.json && r.json.error) || ''), 'title over 100 rejected: ' + JSON.stringify(r.json));
assert(setting('notice_popup_version') === '3', 'overlong title did not bump version');
r = await call('POST', '/api/admin/settings', { settings: { notice_popup_body: body2001 } }, cookie);
assert(r.status === 400 && /2000/.test((r.json && r.json.error) || ''), 'body over 2000 rejected');
r = await call('POST', '/api/admin/settings', { settings: { notice_popup_title: title100, notice_popup_body: body2000 } }, cookie);
assert(r.json && r.json.ok === true && setting('notice_popup_title') === title100 && setting('notice_popup_body') === body2000 && setting('notice_popup_version') === '4', 'title 100 and body 2000 accepted and bump once');
r = await call('GET', '/api/config');
assert(r.json.config.notice_popup_title.length === 100 && r.json.config.notice_popup_body.length === 2000 && r.json.config.notice_popup_version === 4, 'public config returns max-length copy and integer version');

const pub = JSON.stringify(r.json.config);
assert(!pub.includes('@') && !/delivery_content|card code|query_password/i.test(pub), 'public config has no buyer email or card fields from this feature');

console.log('NOTICE POPUP CONFIG TEST DONE');
