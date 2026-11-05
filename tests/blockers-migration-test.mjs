// 拦路 bug 迁移/自愈线回归测试（M1/M2/M3，2026-10-30，分支 fix/blockers-migration）
// 全部 Mock / in-memory D1，不访问真实上游、链上、生产 D1；不用真实密钥（dummy 值仅用于测试）。
// 运行：node tests/blockers-migration-test.mjs
// 断言为软断言（记 FAIL 但继续跑），最后汇总：任一 FAIL 即退出码 1，便于一次看到 M1/M2/M3 各自的修前失败。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const workerCodeRaw = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
const frontendHtml = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
const schemaSql = fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8');

let failures = 0; let passes = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('FAIL: ' + msg); }
  else { passes++; console.log('PASS: ' + msg); }
}
function makeCtx() { const c = { pending: [] }; c.waitUntil = (pr) => { c.pending.push(pr); }; c.drain = async () => { while (c.pending.length) { const batch = c.pending.splice(0); await Promise.all(batch.map((x) => x.catch(() => {}))); } }; return c; }
async function mockFetch() { return new Response(JSON.stringify({}), { status: 200 }); }
globalThis.fetch = mockFetch;

function loadWorker(env) {
  let code = workerCodeRaw.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(frontendHtml) + ';');
  code = code.replace('export default {', 'globalThis.__W = {');
  return new Function(code + '\nreturn globalThis.__W;')();
}
function makeDb() {
  const db = new DatabaseSync(':memory:');
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
    DB: { prepare: (sql) => wrapStmt(sql), async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } },
    ZHIXUAN_SETUP_TOKEN: 'test-setup-token',
    PRODSELLER_BASE_URL: 'https://prodseller.com/v1',
    __fetch: mockFetch,
  };
  return { db, env };
}
function q(db, sql, ...a) { return db.prepare(sql).get(...a); }
function makeCaller(worker, env) {
  return async function call(method, p, body, cookie, extraHeaders) {
    const ctx = makeCtx();
    const headers = { 'content-type': 'application/json', 'X-Admin-API': '1', ...(extraHeaders || {}) };
    if (cookie) headers.Cookie = cookie;
    const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const res = await worker.fetch(req, env, ctx);
    await ctx.drain();
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    return { status: res.status, json: j, text: txt, headers: res.headers };
  };
}
async function adminSetup(call) {
  let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
  check(r.json && r.json.ok, 'setup: 建站令牌登录 ok: ' + JSON.stringify(r.json));
  let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  r = await call('POST', '/api/admin/change-password', { old_password: '', new_password: 'AdminPass123' }, cookie);
  check(r.json && r.json.ok, 'setup: 改密 ok: ' + JSON.stringify(r.json));
  return cookie;
}
function fresh(callSetup = true) {
  const M = makeDb();
  M.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  M.db.exec(schemaSql);
  const worker = loadWorker(M.env);
  const call = makeCaller(worker, M.env);
  return { M, worker, call };
}
function idxExists(db, name) { return q(db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name=?", name).c === 1; }
function insertOrder(db, orderNo, opts) {
  const o = opts || {};
  db.prepare("INSERT INTO orders (order_no, query_password, product_id, quantity, price_usdt, total_usdt, status, pay_address, actual_amount, pay_method, pay_chain, contact) VALUES (?, '', 1, 1, ?, ?, 'pending_payment', ?, ?, ?, ?, ?)")
    .run(orderNo, o.price || 10, o.total || 10, o.pay_address || '', o.amount != null ? o.amount : 10, o.pay_method || '', o.pay_chain || '', o.contact || '');
  return q(db, 'SELECT * FROM orders WHERE order_no=?', orderNo);
}

// ================= M1：自愈跳过 v8 旧金额索引，由 v9 终态定义兜底 =================
{
  const { M, call } = fresh();
  const cookie = await adminSetup(call);
  check(q(M.db, 'SELECT MAX(version) AS v FROM schema_migrations').v === 21, 'M1 前置：版本已到 21');
  // 删掉金额索引 + 2 笔 BinanceUID 同金额待付款单（v8 旧定义会误判冲突，v9 终态定义排除 BinanceUID）
  M.db.exec('DROP INDEX IF EXISTS idx_orders_amount_claim');
  check(!idxExists(M.db, 'idx_orders_amount_claim'), 'M1 前置：idx_orders_amount_claim 已删除');
  insertOrder(M.db, 'M1-A', { amount: 10, pay_method: 'BinanceUID', pay_address: '' });
  insertOrder(M.db, 'M1-B', { amount: 10, pay_method: 'BinanceUID', pay_address: '' });
  const r = await call('GET', '/api/admin/stats', null, cookie);
  check(r.status === 200 && r.json && r.json.ok, 'M1：BinanceUID 同金额重复单下自愈不再 503（stats 200）: status=' + r.status + ' ' + JSON.stringify(r.json && { ok: r.json.ok, code: r.json.code }));
  check(idxExists(M.db, 'idx_orders_amount_claim'), 'M1：自愈后 idx_orders_amount_claim 以终态定义恢复');
  const idxDef = q(M.db, "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_orders_amount_claim'");
  check(idxDef && String(idxDef.sql || '').indexOf("pay_method != 'BinanceUID'") !== -1, 'M1：恢复的索引含 BinanceUID 排除条件: ' + (idxDef && idxDef.sql));
  check(q(M.db, "SELECT COUNT(*) AS c FROM orders WHERE order_no IN ('M1-A','M1-B') AND status='pending_payment'").c === 2, 'M1：两笔 BinanceUID 订单仍为待付款（自愈未删单/改单）');
}

// ================= M2：自愈只做 DDL，跳过数据修复 UPDATE =================
{
  const { M, call } = fresh();
  const cookie = await adminSetup(call);
  // 管理员有意改过的值：account/自营商品 stock_type=manual（非 card）、sell_price=0、标题含 ChatGPT 但 app_icon_key 刻意留空
  M.db.prepare("INSERT INTO products (slug, title, category, price_usdt, sell_price, stock_type, source, description, notice, form_fields, image_emoji, app_icon_key, sort, is_active) VALUES ('m2-test', 'ChatGPT Plus Test', 'account', 10, 0, 'manual', 'self', '', '', '[]', 'box', '', 10, 1)").run();
  const prod = q(M.db, "SELECT * FROM products WHERE slug='m2-test'");
  check(!!prod && prod.stock_type === 'manual' && Number(prod.sell_price) === 0 && prod.app_icon_key === '', 'M2 前置：管理员改后值已写入（manual/0/空图标）');
  // v10 占位符：管理员库里仍有该值时，自愈也不应静默改写（首次迁移才做占位符替换）
  M.db.prepare("INSERT INTO settings (key, value) VALUES ('usdt_contracts', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run('{"X Layer":"0xYOUR_XLAYER_USDT_CONTRACT"}');
  // 触发自愈：删一个无关自愈索引（不制造金额冲突），下一请求走 forceRepair
  M.db.exec('DROP INDEX IF EXISTS idx_orders_no');
  const r = await call('GET', '/api/admin/stats', null, cookie);
  check(r.status === 200 && r.json && r.json.ok, 'M2：触发自愈的请求成功: status=' + r.status);
  check(idxExists(M.db, 'idx_orders_no'), 'M2：自愈补齐了确实缺失的 idx_orders_no（DDL 仍做）');
  const after = q(M.db, "SELECT * FROM products WHERE slug='m2-test'");
  check(after && after.stock_type === 'manual', 'M2：自愈后 stock_type 保持 manual（v4 不再改回 card）: ' + (after && after.stock_type));
  check(after && Number(after.sell_price) === 0, 'M2：自愈后 sell_price 保持 0（v2 不再回填 price_usdt）: ' + (after && after.sell_price));
  check(after && after.app_icon_key === '', 'M2：自愈后 app_icon_key 保持空（v11 不再自动匹配标题）: ' + JSON.stringify(after && after.app_icon_key));
  check(String(q(M.db, "SELECT value AS v FROM settings WHERE key='usdt_contracts'").v || '').indexOf('0xYOUR_XLAYER_USDT_CONTRACT') !== -1, 'M2：自愈后 settings 占位符未被静默改写（v10 只在首次迁移跑）');
}

// ================= M3：迁移失败时登录 + 最小修复接口豁免迁移门，但仍须完整管理员鉴权 =================
{
  const { M, call } = fresh();
  const cookie = await adminSetup(call);
  // 真重复单（链上口径，非 BinanceUID）：同地址同金额 2 笔，终态索引也建不出来，自愈理应 fail-closed
  M.db.exec('DROP INDEX IF EXISTS idx_orders_amount_claim');
  const a1 = insertOrder(M.db, 'M3-A1', { amount: 20.5, pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x1111111111111111111111111111111111111111' });
  const a2 = insertOrder(M.db, 'M3-A2', { amount: 20.5, pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x1111111111111111111111111111111111111111' });
  let r = await call('GET', '/api/admin/stats', null, null);
  check(r.status === 503 && r.json && r.json.code === 'migration_failed', 'M3：无会话普通管理接口仍被迁移门挡住（503 migration_failed）: status=' + r.status);
  r = await call('GET', '/api/admin/stats', null, cookie);
  check(r.status === 503 && r.json && r.json.code === 'migration_failed', 'M3：有会话普通管理接口仍被迁移门挡住（503）: status=' + r.status);
  // 登录豁免：无会话时用正确密码登录必须可达
  r = await call('POST', '/api/admin/login', { password: 'AdminPass123' });
  check(r.status === 200 && r.json && r.json.ok, 'M3：迁移失败时无会话登录可达（200）: status=' + r.status + ' ' + JSON.stringify(r.json));
  const newCookie = (r.headers.get('set-cookie') || '').split(';')[0];
  check(!!newCookie, 'M3：登录返回了 session cookie');
  // 登录豁免 ≠ 鉴权豁免：错密码仍 401
  r = await call('POST', '/api/admin/login', { password: 'WrongPass999' });
  check(r.status === 401, 'M3：迁移失败时错密码登录仍 401（未放行鉴权）: status=' + r.status);
  // 修复接口豁免 ≠ 鉴权豁免：无会话调修复仍 401
  r = await call('POST', '/api/admin/repair-duplicate-pending', { order_id: a2.id, action: 'cancel', reason: 'm3-test-no-session' }, null);
  check(r.status === 401, 'M3：无会话调修复接口仍 401: status=' + r.status);
  // 有会话修复：取消一笔真重复单
  r = await call('POST', '/api/admin/repair-duplicate-pending', { order_id: a2.id, action: 'cancel', reason: 'm3-test-duplicate' }, newCookie);
  check(r.status === 200 && r.json && r.json.ok, 'M3：有会话修复接口取消重复单成功: status=' + r.status + ' ' + JSON.stringify(r.json));
  check(q(M.db, 'SELECT status FROM orders WHERE id=?', a2.id).status === 'cancelled', 'M3：被取消的重复单状态为 cancelled');
  check(q(M.db, 'SELECT status FROM orders WHERE id=?', a1.id).status === 'pending_payment', 'M3：另一笔重复单仍为待付款（未误伤）');
  check(q(M.db, "SELECT COUNT(*) AS c FROM admin_audit WHERE order_id=? AND action LIKE 'repair_duplicate%'", a2.id).c >= 1, 'M3：修复取消记了审计');
  // 修复后迁移可恢复
  r = await call('GET', '/api/admin/stats', null, newCookie);
  check(r.status === 200 && r.json && r.json.ok, 'M3：修复后下一请求恢复（stats 200）: status=' + r.status);
  check(idxExists(M.db, 'idx_orders_amount_claim'), 'M3：修复后金额索引恢复');
  // 改金额路径：再造一对真重复单，改金额后恢复
  M.db.exec('DROP INDEX IF EXISTS idx_orders_amount_claim');
  const b1 = insertOrder(M.db, 'M3-B1', { amount: 30.5, pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x2222222222222222222222222222222222222222' });
  const b2 = insertOrder(M.db, 'M3-B2', { amount: 30.5, pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x2222222222222222222222222222222222222222' });
  r = await call('GET', '/api/admin/stats', null, newCookie);
  check(r.status === 503, 'M3 改金额前置：第二对重复单下再次 503: status=' + r.status);
  // 改成仍冲突的金额应被拒绝
  r = await call('POST', '/api/admin/repair-duplicate-pending', { order_id: b2.id, action: 'change_amount', new_actual_amount: 30.5 }, newCookie);
  check(!(r.json && r.json.ok) && /冲突|重复/.test(String((r.json && r.json.error) || '')), 'M3：改金额改成仍冲突的值被拒绝（冲突文案）: ' + JSON.stringify(r.json));
  // 改成唯一金额应成功，且不改其他字段口径（pay_address 不变）
  r = await call('POST', '/api/admin/repair-duplicate-pending', { order_id: b2.id, action: 'change_amount', new_actual_amount: 30.9 }, newCookie);
  check(r.status === 200 && r.json && r.json.ok, 'M3：改金额为唯一值成功: status=' + r.status + ' ' + JSON.stringify(r.json));
  check(Number(q(M.db, 'SELECT actual_amount FROM orders WHERE id=?', b2.id).actual_amount) === 30.9, 'M3：改金额后 actual_amount=30.9');
  check(q(M.db, 'SELECT pay_address FROM orders WHERE id=?', b2.id).pay_address === '0x2222222222222222222222222222222222222222', 'M3：改金额未改动 pay_address');
  r = await call('GET', '/api/admin/stats', null, newCookie);
  check(r.status === 200 && r.json && r.json.ok, 'M3：改金额后下一请求恢复（stats 200）');
  // 安全守卫：已有已消费认领的待付款单不得经修复取消；非待付款单不得修复
  const c1 = insertOrder(M.db, 'M3-C1', { amount: 40, pay_method: 'Binance', pay_chain: 'BEP20', pay_address: '0x3333333333333333333333333333333333333333' });
  M.db.prepare('INSERT INTO txid_claims (tx_hash, order_id) VALUES (?, ?)').run('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', c1.id);
  r = await call('POST', '/api/admin/repair-duplicate-pending', { order_id: c1.id, action: 'cancel', reason: 'm3-consumed-guard' }, newCookie);
  check(!(r.json && r.json.ok) && /已消费/.test(String((r.json && r.json.error) || '')), 'M3：已有已消费认领的待付款单修复取消被拒绝（已消费文案）: ' + JSON.stringify(r.json));
  check(q(M.db, 'SELECT status FROM orders WHERE id=?', c1.id).status === 'pending_payment', 'M3：被拒绝取消的已消费单仍为待付款');
  r = await call('POST', '/api/admin/repair-duplicate-pending', { order_id: a2.id, action: 'cancel', reason: 'm3-not-pending' }, newCookie);
  check(!(r.json && r.json.ok) && /待付款/.test(String((r.json && r.json.error) || '')), 'M3：非待付款单修复被拒绝（待付款文案）: ' + JSON.stringify(r.json));
}

console.log('--- blockers-migration: passes=' + passes + ' failures=' + failures + ' ---');
if (failures) process.exitCode = 1;
