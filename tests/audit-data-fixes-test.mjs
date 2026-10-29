// 数据与部署线审计修复回归测试（2026-10-30，分支 fix/p1-payment-20261029 上的数据线工作）
// 全部 Mock / in-memory D1，不访问真实上游、链上、生产 D1；不用真实密钥（dummy 值仅用于测试）。
// 运行：node tests/audit-data-fixes-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const workerCodeRaw = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
const frontendHtml = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
const schemaSql = fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8');

function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); } console.log('PASS: ' + msg); }
function makeCtx() { const c = { pending: [] }; c.waitUntil = (pr) => { c.pending.push(pr); }; c.drain = async () => { while (c.pending.length) { const batch = c.pending.splice(0); await Promise.all(batch.map((x) => x.catch(() => {}))); } }; return c; }

// mock fetch：计数 RPC / 上游 GET / 上游 POST；上游已交付单号固定返回 delivered。
const counters = { rpc: 0, psGet: 0, psPost: 0 };
function resetCounters() { counters.rpc = 0; counters.psGet = 0; counters.psPost = 0; }
async function mockFetch(url, opts = {}) {
  const u = String(url); const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('mock-xlayer') || u.includes('mock-bsc')) {
    counters.rpc++;
    const body = opts.body ? JSON.parse(opts.body) : null;
    const m = body && body.method;
    if (m === 'eth_chainId') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: u.includes('mock-bsc') ? '0x38' : '0xc4' }), { status: 200 });
    if (m === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10000' }), { status: 200 });
    if (m === 'eth_call') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (6).toString(16).padStart(64, '0') }), { status: 200 });
    if (m === 'eth_getTransactionReceipt') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
    if (m === 'eth_getLogs') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
  }
  if (u.includes('prodseller.com/v1/orders/') && method === 'GET') {
    counters.psGet++;
    const psId = u.split('/orders/')[1];
    return new Response(JSON.stringify({ id: psId, status: 'delivered', delivered_keys: 'UP-KEY-A\nUP-KEY-B' }), { status: 200 });
  }
  if (u.includes('prodseller.com/v1/orders') && method === 'POST') { counters.psPost++; return new Response(JSON.stringify({ id: 'PS-NEW', status: 'paid', delivered_keys: '' }), { status: 200 }); }
  if (u.includes('prodseller.com/v1/balance')) return new Response(JSON.stringify({ balance: 1 }), { status: 200 });
  return new Response(JSON.stringify({}), { status: 200 });
}
globalThis.fetch = mockFetch;

function loadWorker(env) {
  let code = workerCodeRaw.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(frontendHtml) + ';');
  code = code.replace('export default {', 'globalThis.__W = {');
  return new Function(code + '\nreturn globalThis.__W;')();
}

// fault 注入：仅测试用。fault.throwOnPollingQuery 为真时，runPolling 的待付款查询抛一次错，
// 用于验证 scheduled 分支隔离（轮询分支失败后上游分支仍能跑），其余查询不受影响。
function makeDb() {
  const db = new DatabaseSync(':memory:');
  const fault = { throwOnPollingQuery: false };
  function wrapStmt(sql) {
    let params = [];
    const api = {
      bind(...a) { params = a; return api; },
      async first() {
        if (fault.throwOnPollingQuery && sql.includes('pending_payment') && sql.includes('last_checked_at')) { fault.throwOnPollingQuery = false; throw new Error('injected polling failure'); }
        const r = db.prepare(sql).get(...params); return r === undefined ? null : r;
      },
      async all() {
        if (fault.throwOnPollingQuery && sql.includes('pending_payment') && sql.includes('last_checked_at')) { fault.throwOnPollingQuery = false; throw new Error('injected polling failure'); }
        return { results: db.prepare(sql).all(...params) };
      },
      async run() { const info = db.prepare(sql).run(...params); return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }; },
    };
    return api;
  }
  const env = {
    DB: { prepare: (sql) => wrapStmt(sql), async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } },
    ZHIXUAN_SETUP_TOKEN: 'audit-data-setup-2026',
    PRODSELLER_BASE_URL: 'https://prodseller.com/v1',
    __fetch: mockFetch,
  };
  return { db, env, fault };
}
function q(db, sql, ...a) { return db.prepare(sql).get(...a); }
function setSetting(db, key, value) { db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
function delSetting(db, key) { db.prepare('DELETE FROM settings WHERE key=?').run(key); }
function captureConsoleError() {
  const lines = []; const orig = console.error;
  console.error = (...a) => { lines.push(a.join(' ')); };
  return { lines, restore() { console.error = orig; } };
}
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
async function adminLogin(call) {
  let r = await call('POST', '/api/admin/login', { setup_token: 'audit-data-setup-2026' });
  assert(r.json && r.json.ok, 'admin login: ' + JSON.stringify(r.json));
  let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  r = await call('POST', '/api/admin/change-password', { old_password: '', new_password: 'AdminPass123!' }, cookie);
  assert(r.json && r.json.ok, 'change-password: ' + JSON.stringify(r.json));
  cookie = (r.headers.get('set-cookie') || '').split(';')[0] || cookie;
  return cookie;
}
function futureTs(min) { return new Date(Date.now() + min * 60000).toISOString().replace('T', ' ').slice(0, 19); }
function pastTs(days) { return new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19); }
function nowTs() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// ================= 主库：schema.sql 建库 =================
const M = makeDb();
M.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
M.db.exec(schemaSql);
const worker = loadWorker(M.env);
const call = makeCaller(worker, M.env);
const cookie = await adminLogin(call);

// ---- 2. 干跑在迁移之前 + v21 版本 + v14 计数为 0 + 外键探针 ----
let r = await call('GET', '/api/admin/schema-check', null, cookie);
assert(r.status === 200 && r.json && r.json.dry_run === true && r.json.migrated === false, 'schema-check 是干跑（dry_run=true, migrated=false）: ' + JSON.stringify(r.json && { dry_run: r.json.dry_run, migrated: r.json.migrated }));
assert(r.json.precheck && r.json.precheck.current_version === 21 && r.json.precheck.latest_version === 21 && r.json.precheck.ok === true, 'schema-check 版本 21 且 ok: ' + JSON.stringify(r.json.precheck && { current_version: r.json.precheck.current_version, issues: r.json.precheck.issues }));
assert(r.json.precheck.v14_legacy_no_salt_orders === 0, 'v14 无 salt 计数为 0（字段存在）');
assert(typeof r.json.precheck.checks.foreign_keys === 'number', '外键探针返回数值: ' + JSON.stringify(r.json.precheck.checks.foreign_keys));
r = await call('GET', '/api/admin/schema-check', null, null);
assert(r.status === 401, '干跑未登录仍 401（鉴权在迁移之前、与网关同口径）');

// ---- 6. 自愈：版本号已是 21 但 categories 表 + 索引被删，下一请求自动补齐 ----
M.db.exec('DROP TABLE IF EXISTS categories');
M.db.exec('DROP INDEX IF EXISTS idx_orders_no');
r = await call('GET', '/api/admin/categories', null, cookie);
assert(r.json && r.json.ok && Array.isArray(r.json.categories) && r.json.categories.filter((c) => ['recharge', 'account', 'card'].includes(c.key)).length === 3, '自愈后 categories 恢复 3 个内置分类: ' + JSON.stringify(r.json && r.json.categories));
assert(q(M.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name='idx_orders_no'").c === 1, '自愈后 idx_orders_no 索引恢复');
assert(q(M.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name='idx_txid_claims_order'").c === 1, 'v21 索引 idx_txid_claims_order 存在');

// ---- 3. 自定义分类商品可编辑；新商品仍走目录门禁 ----
M.db.prepare("INSERT INTO products (slug, title, category, price_usdt, sell_price, stock_type, description, notice, form_fields, image_emoji, sort, is_active) VALUES ('legacy-vip', '遗留自定义分类商品', 'vipclub', 10, 10, 'manual', '', '', '[]', 'box', 10, 1)").run();
const legacyProd = q(M.db, "SELECT * FROM products WHERE slug='legacy-vip'");
r = await call('PUT', '/api/admin/products/' + legacyProd.id, { slug: 'legacy-vip', title: '遗留自定义分类商品（改名）', category: 'vipclub', price_usdt: 11, sell_price: 11, source: 'self', stock_type: 'manual', form_fields: [] }, cookie);
assert(r.json && r.json.ok, '原分类为自定义分类（目录外）的商品编辑放行: ' + JSON.stringify(r.json));
assert(q(M.db, "SELECT title FROM products WHERE id=?", legacyProd.id).title === '遗留自定义分类商品（改名）', '自定义分类商品编辑确实写库');
r = await call('PUT', '/api/admin/products/' + legacyProd.id, { slug: 'legacy-vip', title: 'x', category: 'nosuchcat', price_usdt: 11, sell_price: 11, source: 'self', stock_type: 'manual', form_fields: [] }, cookie);
assert(!(r.json && r.json.ok) && /分类不存在/.test(r.json.error || ''), '编辑改到不存在的分类仍拒绝: ' + JSON.stringify(r.json));
r = await call('POST', '/api/admin/products', { slug: 'new-nosuch', title: '新商品不存在分类', category: 'nosuchcat', price_usdt: 5, sell_price: 5, source: 'self', stock_type: 'manual', form_fields: [] }, cookie);
assert(!(r.json && r.json.ok) && /分类不存在/.test(r.json.error || ''), '新商品用未创建分类仍拒绝: ' + JSON.stringify(r.json));
r = await call('POST', '/api/admin/categories', { key: 'vipclub', name: 'VIP 会员', sort: 50 }, cookie);
assert(r.json && r.json.ok, '创建自定义分类 vipclub: ' + JSON.stringify(r.json));
r = await call('POST', '/api/admin/products', { slug: 'new-vip', title: '新 VIP 商品', category: 'vipclub', price_usdt: 5, sell_price: 5, source: 'self', stock_type: 'manual', form_fields: [] }, cookie);
assert(r.json && r.json.ok, '新商品用已创建的自定义分类放行（目录门禁口径）: ' + JSON.stringify(r.json));

// ---- 4. v14 哈希订单：自助取卡永久 401；干跑计数发现它 ----
M.db.prepare("INSERT INTO orders (order_no, query_password, query_password_hash, query_password_salt, product_id, quantity, price_usdt, total_usdt, status, created_at) VALUES ('V14-001', '', 'deadbeef-v14-hash', '', 1, 1, 10, 10, 'completed', ?)").run(nowTs());
r = await call('POST', '/api/orders/V14-001/secret', { password: 'any-password-123' });
assert(r.status === 401, 'v14 无 salt 订单 /secret 永久 401: ' + r.status + ' ' + JSON.stringify(r.json));
r = await call('GET', '/api/admin/schema-check', null, cookie);
assert(r.json.precheck.v14_legacy_no_salt_orders >= 1, '干跑报告含 v14 无 salt 计数 >=1: ' + JSON.stringify(r.json.precheck.v14_legacy_no_salt_orders));

// ---- 9. Turnstile 配置标志（只返回布尔值，绝不返回 secret） ----
setSetting(M.db, 'turnstile_enabled', '1');
setSetting(M.db, 'turnstile_site_key', 'dummy-site-key-for-test');
delete M.env.TURNSTILE_SECRET_KEY;
r = await call('GET', '/api/config');
assert(r.json && r.json.config && r.json.config.turnstile_configured === false, '未配 secret 时 /api/config turnstile_configured=false: ' + JSON.stringify(r.json.config && r.json.config.turnstile_configured));
r = await call('GET', '/api/admin/settings', null, cookie);
assert(r.json && r.json.turnstile_configured === false, '未配 secret 时管理端 turnstile_configured=false');
assert(!JSON.stringify(r.json).includes('dummy-secret'), '管理端响应不含 secret');
M.env.TURNSTILE_SECRET_KEY = 'dummy-secret-for-test-only';
r = await call('GET', '/api/config');
assert(r.json.config.turnstile_configured === true, '配齐 site_key + secret 后 turnstile_configured=true');
r = await call('GET', '/api/admin/settings', null, cookie);
assert(r.json.turnstile_configured === true && !JSON.stringify(r.json).includes('dummy-secret-for-test-only'), '管理端 turnstile_configured=true 且不泄露 secret');
delete M.env.TURNSTILE_SECRET_KEY;

// ---- 6. 7 天交付清空与 session 清理（0 2 cron 分支） ----
const prodCard = q(M.db, "SELECT * FROM products WHERE slug='gemini-card'");
M.db.prepare("INSERT INTO orders (order_no, query_password, product_id, quantity, price_usdt, total_usdt, status, delivery_content, data_expired, created_at, fulfilled_at) VALUES ('OLD-7D-001', '', ?, 1, 10, 10, 'completed', 'SECRET-DELIVERY-CONTENT', 0, ?, ?)").run(prodCard.id, pastTs(10), pastTs(8));
M.db.prepare("INSERT INTO sessions (token, created_at, expires_at) VALUES ('expired-session-test', ?, ?)").run(pastTs(2), pastTs(1));
M.db.prepare("INSERT INTO sessions (token, created_at, expires_at) VALUES ('valid-session-test', ?, ?)").run(nowTs(), futureTs(60));
{
  const ctx = makeCtx();
  await worker.scheduled({ cron: '0 2 * * *' }, M.env, ctx); await ctx.drain();
}
assert(q(M.db, "SELECT delivery_content, data_expired FROM orders WHERE order_no='OLD-7D-001'").delivery_content === '' && q(M.db, "SELECT data_expired FROM orders WHERE order_no='OLD-7D-001'").data_expired === 1, '7 天已完成订单交付内容清空 + data_expired=1');
assert(!q(M.db, "SELECT * FROM sessions WHERE token='expired-session-test'"), '过期 session 被清理');
assert(!!q(M.db, "SELECT * FROM sessions WHERE token='valid-session-test'"), '未过期 session 保留');

// ---- 5. 上游轮询语义：开关只控新建 + 链上扫描，不控已有单号履约 ----
setSetting(M.db, 'poll_enabled', '0');
setSetting(M.db, 'prodseller_enabled', '0');
M.db.prepare("INSERT INTO products (slug, title, category, price_usdt, sell_price, source, prodseller_id, stock_type, description, notice, form_fields, image_emoji, sort, is_active) VALUES ('ps-prod', '上游商品', 'recharge', 20, 20, 'prodseller', 'PS-PROD', 'manual', '', '', '[]', 'box', 10, 1)").run();
const psProd = q(M.db, "SELECT * FROM products WHERE slug='ps-prod'");
M.db.prepare("INSERT INTO orders (order_no, query_password, product_id, quantity, price_usdt, total_usdt, status, created_at) VALUES ('PS-EXIST-001', '', ?, 1, 20, 20, 'pending_activation', ?)").run(psProd.id, nowTs());
const psOrder = q(M.db, "SELECT * FROM orders WHERE order_no='PS-EXIST-001'");
M.db.prepare("INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, 'PS-1', 'paid', 20, '')").run(psOrder.id);
M.db.prepare("INSERT INTO orders (order_no, query_password, product_id, quantity, price_usdt, total_usdt, status, created_at) VALUES ('PS-NEW-001', '', ?, 1, 20, 20, 'pending_upstream', ?)").run(psProd.id, nowTs());
resetCounters();
{
  const ctx = makeCtx();
  await worker.scheduled({ cron: '*/1 * * * *' }, M.env, ctx); await ctx.drain();
}
assert(q(M.db, "SELECT status, delivery_content FROM orders WHERE order_no='PS-EXIST-001'").status === 'completed', '关闸下已有上游单号订单仍完成履约');
assert(q(M.db, "SELECT delivery_content FROM orders WHERE order_no='PS-EXIST-001'").delivery_content.includes('UP-KEY-A'), '已有单号履约交付内容写入');
assert(q(M.db, "SELECT status FROM orders WHERE order_no='PS-NEW-001'").status === 'pending_upstream', '关闸下无上游单号订单不新建（仍 pending_upstream）');
assert(counters.psPost === 0, '关闸下无上游新建 POST 调用: psPost=' + counters.psPost);
assert(counters.rpc === 0, 'poll_enabled=0 时链上扫描零 RPC: rpc=' + counters.rpc);

// ---- 6. scheduled 无 event.cron 回退分支 ----
M.db.prepare("INSERT INTO orders (order_no, query_password, product_id, quantity, price_usdt, total_usdt, status, created_at) VALUES ('PS-EXIST-002', '', ?, 1, 20, 20, 'pending_activation', ?)").run(psProd.id, nowTs());
const psOrder2 = q(M.db, "SELECT * FROM orders WHERE order_no='PS-EXIST-002'");
M.db.prepare("INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, 'PS-2', 'paid', 20, '')").run(psOrder2.id);
{
  const ctx = makeCtx();
  await worker.scheduled({}, M.env, ctx); await ctx.drain();
}
assert(q(M.db, "SELECT status FROM orders WHERE order_no='PS-EXIST-002'").status === 'completed', '无 event.cron 回退分支仍跑上游轮询并完成已有单');

// ---- 1. scheduled 分支隔离：轮询分支注入失败，上游分支仍跑 ----
M.db.prepare("INSERT INTO orders (order_no, query_password, product_id, quantity, price_usdt, total_usdt, status, created_at) VALUES ('PS-EXIST-003', '', ?, 1, 20, 20, 'pending_activation', ?)").run(psProd.id, nowTs());
const psOrder3 = q(M.db, "SELECT * FROM orders WHERE order_no='PS-EXIST-003'");
M.db.prepare("INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, 'PS-3', 'paid', 20, '')").run(psOrder3.id);
setSetting(M.db, 'poll_enabled', '1'); // 隔离测试须让 runPolling 真正走到待付款查询（poll_enabled=0 时会提前返回、注不进去）
M.fault.throwOnPollingQuery = true;
{
  const cap = captureConsoleError();
  const ctx = makeCtx();
  await worker.scheduled({ cron: '*/1 * * * *' }, M.env, ctx); await ctx.drain();
  cap.restore();
  assert(q(M.db, "SELECT status FROM orders WHERE order_no='PS-EXIST-003'").status === 'completed', '轮询分支失败后上游分支仍完成已有单');
  assert(cap.lines.some((l) => l.includes('scheduled branch failed: runPolling')), '轮询分支失败记日志: ' + JSON.stringify(cap.lines));
}

// ---- 10. 邮件死配置口径（文件级断言：种子与注释已改成已废弃） ----
assert(schemaSql.includes('已废弃') && schemaSql.includes('email_from'), 'schema.sql 邮件种子已标已废弃');
const wranglerToml = fs.readFileSync(path.join(dir, 'wrangler.toml'), 'utf8');
assert(wranglerToml.includes('已废弃') && wranglerToml.includes('RESEND_API_KEY'), 'wrangler.toml RESEND 注释已改成已废弃口径');
assert(!/printf '%s' "\$VAL" \| npx wrangler secret put RESEND_API_KEY/.test(wranglerToml), 'wrangler.toml 不再 instruct 配置 RESEND_API_KEY');

// ================= 旧库 v10 -> v21 升级 =================
{
  const O = makeDb();
  O.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  O.db.exec(schemaSql);
  // 退回到 v10 形态：删 v11+ 表/列/索引、版本只留 1..10
  O.db.exec('DROP TABLE IF EXISTS app_icons');
  O.db.exec('DROP TABLE IF EXISTS secret_attempts');
  O.db.exec('DROP TABLE IF EXISTS lookup_attempts');
  O.db.exec('DROP TABLE IF EXISTS pricing_templates');
  O.db.exec('DROP TABLE IF EXISTS categories');
  for (const ix of ['idx_orders_no', 'idx_orders_status', 'idx_orders_created', 'idx_cards_product', 'idx_cards_used', 'idx_sessions_expires', 'idx_categories_key', 'idx_pricing_templates_active', 'idx_lookup_attempts_order', 'idx_secret_attempts_order', 'idx_txid_claims_order']) O.db.exec('DROP INDEX IF EXISTS ' + ix);
  for (const col of ['query_password_hash', 'query_password_salt', 'pending_tx_hash', 'payment_state']) O.db.exec('ALTER TABLE orders DROP COLUMN ' + col);
  for (const col of ['claim_token', 'source', 'order_lease_token']) O.db.exec('ALTER TABLE txid_claims DROP COLUMN ' + col);
  O.db.exec('DELETE FROM schema_migrations WHERE version > 10');
  O.db.prepare("INSERT INTO orders (order_no, query_password, product_id, quantity, price_usdt, total_usdt, status, created_at) VALUES ('OLD-V10-001', 'oldpw', 1, 1, 10, 10, 'completed', ?)").run(nowTs());
  const w2 = loadWorker(O.env);
  const call2 = makeCaller(w2, O.env);
  const r2 = await call2('GET', '/api/config');
  assert(r2.json && r2.json.ok, 'v10 库首次请求触发迁移: ' + JSON.stringify(r2.json));
  assert(q(O.db, 'SELECT MAX(version) AS v FROM schema_migrations').v === 21, 'v10 库升级到 v21');
  assert(q(O.db, "SELECT COUNT(*) AS c FROM categories WHERE cat_key IN ('recharge','account','card')").c === 3, 'v10 升级后内置分类 3 个');
  assert(q(O.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='pricing_templates'").c === 1, 'v10 升级后 pricing_templates 存在');
  assert(q(O.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='lookup_attempts'").c === 1, 'v10 升级后 lookup_attempts 存在');
  assert(q(O.db, "SELECT COUNT(*) AS c FROM pragma_table_info('txid_claims') WHERE name='claim_token'").c === 1, 'v10 升级后 txid_claims 有 claim_token 列');
  assert(q(O.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name='idx_txid_claims_order'").c === 1, 'v10 升级后 v21 索引存在');
  assert(!!q(O.db, "SELECT * FROM orders WHERE order_no='OLD-V10-001'"), 'v10 旧订单升级后保留');
  assert(q(O.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name='idx_orders_no'").c === 1, 'v10 升级后 v16 索引补齐');
}

// ================= 迁移失败：API 503 可区分 + 干跑不升库 + cron 不拖垮 =================
{
  const F = makeDb();
  F.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  F.db.exec(schemaSql);
  const w3 = loadWorker(F.env);
  const call3 = makeCaller(w3, F.env);
  const cookie3 = await adminLogin(call3);
  // 制造 v8 失败条件：删金额唯一索引 + 联系方式唯一索引，再插两笔重复待付款（同地址同金额同联系方式同商品）
  F.db.exec('DROP INDEX IF EXISTS idx_orders_amount_claim');
  F.db.exec('DROP INDEX IF EXISTS idx_orders_contact_pending');
  const p1 = q(F.db, "SELECT * FROM products WHERE slug='gemini-card'");
  const expF = futureTs(30);
  for (let i = 0; i < 2; i++) {
    F.db.prepare("INSERT INTO orders (order_no, query_password, product_id, quantity, price_usdt, total_usdt, actual_amount, pay_address, contact, pay_method, pay_chain, status, expires_at, created_at) VALUES (?, '', ?, 1, 10, 10, 10.0057, '0x1111111111111111111111111111111111111111', 'dup@test.example', 'OKX', 'X Layer', 'pending_payment', ?, ?)").run('DUP-00' + i, p1.id, expF, nowTs());
  }
  // API：迁移失败返回 503 + migration_failed，不得是通用 500
  const capA = captureConsoleError();
  const rF = await call3('GET', '/api/config');
  capA.restore();
  assert(rF.status === 503 && rF.json && rF.json.code === 'migration_failed', '迁移失败 API 返回 503 + migration_failed（非通用 500）: ' + rF.status + ' ' + JSON.stringify(rF.json));
  assert(capA.lines.some((l) => l.includes('migration failed')), '迁移失败记日志');
  // 干跑：已登录管理员仍可用干跑定位，且干跑不修复/不升库
  const rDry = await call3('GET', '/api/admin/schema-check', null, cookie3);
  assert(rDry.status === 200 && rDry.json && rDry.json.dry_run === true, '迁移失败时干跑仍可用: ' + rDry.status);
  assert((rDry.json.precheck.issues || []).some((x) => x.includes('重复待付款金额')), '干跑报告含重复待付款金额: ' + JSON.stringify(rDry.json.precheck.issues));
  assert((rDry.json.precheck.issues || []).some((x) => x.includes('重复待付款联系方式')), '干跑报告含重复待付款联系方式: ' + JSON.stringify(rDry.json.precheck.issues));
  assert(q(F.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name='idx_orders_amount_claim'").c === 0, '干跑不应用迁移（缺失索引仍缺失）');
  // cron：迁移失败时 scheduled 不抛错、不跑分支，记日志可定位
  const capS = captureConsoleError();
  {
    const ctx = makeCtx();
    await w3.scheduled({ cron: '*/1 * * * *' }, F.env, ctx); await ctx.drain();
  }
  capS.restore();
  assert(capS.lines.some((l) => l.includes('scheduled migration failed')), 'cron 迁移失败记日志: ' + JSON.stringify(capS.lines));
  assert(q(F.db, "SELECT status FROM orders WHERE order_no='DUP-000'").status === 'pending_payment', 'cron 迁移失败时分支未跑（订单状态不变）');
}

// ================= BASE_TABLES + 迁移建库、settings 为空时 poll 默认关 =================
{
  const E = makeDb();
  const w4 = loadWorker(E.env);
  const call4 = makeCaller(w4, E.env);
  // 真正空库首次请求：建基表 + 迁移到 21，settings 仍为空（无 poll_enabled 行）
  const rE = await call4('GET', '/api/config');
  assert(rE.json && rE.json.ok, '空库首次请求建库成功');
  assert(q(E.db, 'SELECT MAX(version) AS v FROM schema_migrations').v === 21, '空库建库后版本 21');
  assert(!q(E.db, "SELECT * FROM settings WHERE key='poll_enabled'"), 'BASE_TABLES 建库后 settings 无 poll_enabled 行');
  // 链上配置齐全（除 poll_enabled 外），一笔未过期待付款订单
  setSetting(E.db, 'usdt_addresses', JSON.stringify({ 'OKX|X Layer': '0x1111111111111111111111111111111111111111', 'Binance|BEP20': '0x2222222222222222222222222222222222222222' }));
  setSetting(E.db, 'rpc_urls', JSON.stringify({ 'X Layer': ['https://mock-xlayer'], 'BEP20': ['https://mock-bsc'] }));
  setSetting(E.db, 'chain_confirmations', JSON.stringify({ 'X Layer': 1, 'BEP20': 15 }));
  setSetting(E.db, 'usdt_contracts', JSON.stringify({ 'X Layer': '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', 'BEP20': '0x55d398326f99059fF775485246999027B3197955' }));
  E.db.prepare("INSERT INTO products (slug, title, category, price_usdt, sell_price, stock_type, description, notice, form_fields, image_emoji, sort, is_active) VALUES ('empty-poll-prod', '空库商品', 'card', 10, 10, 'card', '', '', '[]', 'box', 10, 1)").run();
  const ep = q(E.db, "SELECT * FROM products WHERE slug='empty-poll-prod'");
  E.db.prepare("INSERT INTO orders (order_no, query_password, product_id, quantity, price_usdt, total_usdt, actual_amount, pay_address, pay_method, pay_chain, status, expires_at, created_at) VALUES ('EMPTY-POLL-001', '', ?, 1, 10, 10, 10.0057, '0x1111111111111111111111111111111111111111', 'OKX', 'X Layer', 'pending_payment', ?, ?)").run(ep.id, futureTs(30), nowTs());
  resetCounters();
  {
    const ctx = makeCtx();
    await w4.scheduled({ cron: '*/1 * * * *' }, E.env, ctx); await ctx.drain();
  }
  assert(counters.rpc === 0, 'settings 为空时 poll 默认关、cron 零 RPC: rpc=' + counters.rpc);
  assert(q(E.db, "SELECT status FROM orders WHERE order_no='EMPTY-POLL-001'").status === 'pending_payment', '默认关时待付款订单不被链上扫描处理');
  // 显式置 1 后同一 cron 应发起 RPC（已有行不受默认值影响）
  setSetting(E.db, 'poll_enabled', '1');
  resetCounters();
  {
    const ctx = makeCtx();
    await w4.scheduled({ cron: '*/1 * * * *' }, E.env, ctx); await ctx.drain();
  }
  assert(counters.rpc > 0, '显式 poll_enabled=1 后 cron 发起 RPC: rpc=' + counters.rpc);
}

console.log('AUDIT DATA FIXES TEST DONE');
