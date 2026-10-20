// 管理入口路径：/fuyan 返回与首页相同的 HTML；/admin 302 到 /fuyan 并保留 query；/api/admin/* 不重定向。
// 运行：node tests/admin-entry-path-test.mjs
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
    async first() { const st = db.prepare(sql); const r = st.get(...params); return r === undefined ? null : r; },
    async all() { const st = db.prepare(sql); return { results: st.all(...params) }; },
    async run() { const st = db.prepare(sql); const info = st.run(...params); return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }; },
  };
  return api;
}

const env = {
  ZHIXUAN_SETUP_TOKEN: 'test-setup-token',
  DB: {
    prepare: (sql) => wrapStmt(sql),
    async batch(stmts) { const out = []; for (const st of stmts) out.push(await st.run()); return out; },
  },
};

let code = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
code = code.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(html) + ';');
code = code.replace('export default {', 'globalThis.__W = {');
const worker = new Function(code + '\nreturn globalThis.__W;')();

function makeCtx() {
  const c = { pending: [] };
  c.waitUntil = (pr) => { c.pending.push(pr); };
  c.drain = async () => {
    while (c.pending.length) {
      const batch = c.pending.splice(0);
      await Promise.all(batch.map((x) => x.catch(() => {})));
    }
  };
  return c;
}

async function call(method, p, body, cookie) {
  const ctx = makeCtx();
  const headers = { 'content-type': 'application/json', 'X-Admin-API': '1' };
  if (cookie) headers.Cookie = cookie;
  const req = new Request('https://zhixuanpro.com' + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; console.log('FAIL:', name, extra); }
}

const home = await call('GET', '/');
check('GET / is HTML 200', home.status === 200 && (home.headers.get('content-type') || '').indexOf('text/html') === 0, 'status=' + home.status);
check('GET / body is frontend html', home.text === html && home.text.length > 0);

const fuyan = await call('GET', '/fuyan');
check('GET /fuyan is HTML 200', fuyan.status === 200 && (fuyan.headers.get('content-type') || '').indexOf('text/html') === 0, 'status=' + fuyan.status + ' ct=' + fuyan.headers.get('content-type'));
check('GET /fuyan body equals GET /', fuyan.text === home.text && fuyan.text === html);
check('GET /fuyan cache-control no-store', (fuyan.headers.get('cache-control') || '') === 'no-store', fuyan.headers.get('cache-control'));

const fuyanSlash = await call('GET', '/fuyan/');
check('GET /fuyan/ is HTML 200', fuyanSlash.status === 200 && fuyanSlash.text === html, 'status=' + fuyanSlash.status);

const fuyanQuery = await call('GET', '/fuyan?from=bookmark');
check('GET /fuyan?query still HTML 200', fuyanQuery.status === 200 && fuyanQuery.text === html && !fuyanQuery.headers.get('location'), 'status=' + fuyanQuery.status);

const indexHtml = await call('GET', '/index.html');
check('GET /index.html still HTML 200', indexHtml.status === 200 && indexHtml.text === html);

const admin = await call('GET', '/admin');
check('GET /admin is 302', admin.status === 302, 'status=' + admin.status + ' body=' + admin.text.slice(0, 80));
check('GET /admin Location is /fuyan', admin.headers.get('location') === '/fuyan', admin.headers.get('location'));
check('GET /admin redirect is no-store', (admin.headers.get('cache-control') || '') === 'no-store', admin.headers.get('cache-control'));
check('GET /admin body is not the SPA', admin.text !== html);

const adminSlash = await call('GET', '/admin/');
check('GET /admin/ redirects to /fuyan', adminSlash.status === 302 && adminSlash.headers.get('location') === '/fuyan', 'status=' + adminSlash.status + ' loc=' + adminSlash.headers.get('location'));

const adminQuery = await call('GET', '/admin?tab=orders&page=2');
check('GET /admin?query preserves query', adminQuery.status === 302 && adminQuery.headers.get('location') === '/fuyan?tab=orders&page=2', adminQuery.headers.get('location'));

const adminSlashQuery = await call('GET', '/admin/?next=%2Fsecret&x=1');
check('GET /admin/?query preserves encoded query', adminSlashQuery.status === 302 && adminSlashQuery.headers.get('location') === '/fuyan?next=%2Fsecret&x=1', adminSlashQuery.headers.get('location'));

const adminPost = await call('POST', '/admin?x=1', {});
check('POST /admin?x=1 redirects with query', adminPost.status === 302 && adminPost.headers.get('location') === '/fuyan?x=1', 'status=' + adminPost.status + ' loc=' + adminPost.headers.get('location'));

const adminChild = await call('GET', '/admin/orders');
check('GET /admin/orders is 404 not a redirect', adminChild.status === 404 && !adminChild.headers.get('location'), 'status=' + adminChild.status + ' loc=' + adminChild.headers.get('location'));

const fuyanChild = await call('GET', '/fuyan/extra');
check('GET /fuyan/extra is 404', fuyanChild.status === 404 && fuyanChild.text !== html, 'status=' + fuyanChild.status);

let r = await call('GET', '/api/admin/me');
check('GET /api/admin/me unauth is 401 JSON', r.status === 401 && r.json && r.json.ok === false && r.json.error === '未登录', JSON.stringify({ status: r.status, json: r.json }));
check('GET /api/admin/me is not redirected', !r.headers.get('location') && (r.headers.get('content-type') || '').indexOf('application/json') === 0, r.headers.get('location') + ' ' + r.headers.get('content-type'));

r = await call('GET', '/api/admin/orders?status=pending_fulfill&page=1');
check('GET /api/admin/orders?query stays 401', r.status === 401 && r.json && r.json.ok === false && r.headers.get('location') !== '/fuyan?status=pending_fulfill&page=1' && !r.headers.get('location'), JSON.stringify({ status: r.status, loc: r.headers.get('location'), json: r.json }));

r = await call('POST', '/api/admin/payments/1/reconcile', { note: 'should-not-run' });
check('POST /api/admin/payments/:id/reconcile unauth is 401 not redirect', r.status === 401 && r.json && r.json.ok === false && !r.headers.get('location'), JSON.stringify({ status: r.status, loc: r.headers.get('location'), json: r.json }));

r = await call('GET', '/api/admin/schema-check');
check('GET /api/admin/schema-check unauth is 401', r.status === 401 && r.json && r.json.error === '未登录' && !r.headers.get('location'), JSON.stringify(r.json));

r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
check('POST /api/admin/login still JSON 200', r.status === 200 && r.json && r.json.ok === true && !r.headers.get('location'), JSON.stringify({ status: r.status, json: r.json, loc: r.headers.get('location') }));
const cookie = ((r.headers.get('set-cookie') || '').split(';')[0]) || '';
check('POST /api/admin/login sets session cookie', cookie.indexOf('session_token=') === 0, r.headers.get('set-cookie'));

r = await call('GET', '/api/admin/me', null, cookie);
check('GET /api/admin/me with session is 200 JSON', r.status === 200 && r.json && r.json.ok === true && !r.headers.get('location'), JSON.stringify(r.json));

r = await call('GET', '/api/admin/stats', null, cookie);
check('GET /api/admin/stats still gated before password change', r.status === 403 && r.json && r.json.ok === false && r.json.error === '请先修改初始密码' && !r.headers.get('location'), JSON.stringify({ status: r.status, json: r.json }));

console.log('admin-entry-path: pass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
