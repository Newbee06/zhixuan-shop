import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const db = new DatabaseSync(':memory:');
// schema.sql 自 v15 起不再建 schema_migrations 表（仅 INSERT 预置版本），与 Worker runMigrations 一致：先建表再执行 schema.sql。
// 注意：schema.sql 缺 CREATE TABLE schema_migrations 是代码侧缺陷（已在最终汇报中精确报告），测试侧按运行时行为先建表，不改 schema.sql。
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))" );
db.exec(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
// Mock D1 over node:sqlite
function wrapStmt(sql) {
  let params = [];
  const api = {
    bind(...a) { params = a; return api; },
    async first() { try { const st = db.prepare(sql); const r = st.get(...params); return r === undefined ? null : r; } catch (e) { throw e; } },
    async all() { const st = db.prepare(sql); const rows = st.all(...params); return { results: rows }; },
    async run() { const st = db.prepare(sql); const info = st.run(...params); return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }; },
  };
  return api;
}
const env = { ZHIXUAN_SETUP_TOKEN: 'test-setup-token', DB: { prepare: (sql) => wrapStmt(sql), async batch(stmts) { const out = []; for (const st of stmts) out.push(await st.run()); return out; } }, PRODSELLER_API_KEY: 'test-key', RESEND_API_KEY: 'test-resend', PRODSELLER_BASE_URL: 'https://prodseller.com/v1' };
const sentEmails = [];
const upstreamCalls = [];
let getCountPSORD1 = 0;
// EVM mock 用：按合约 decimals 精确转 raw 金额（BigInt，避免 float 精度丢失）
function amountToRawMock(amount, decimals) {
  const s = String(amount);
  const parts = s.split('.');
  const intPart = parts[0] || '0';
  let fracPart = parts[1] || '';
  if (fracPart.length > decimals) fracPart = fracPart.slice(0, decimals);
  while (fracPart.length < decimals) fracPart += '0';
  return BigInt(intPart) * (10n ** BigInt(decimals)) + BigInt(fracPart || '0');
}
async function mockFetch(url, opts = {}) {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (u.includes('api.resend.com')) { sentEmails.push({ to: body.to, subject: body.subject, html: body.html }); return new Response(JSON.stringify({ id: 'mock-mail' }), { status: 200 }); }
  if (u.includes('prodseller.com/v1/products') && method === 'GET') {
    return new Response(JSON.stringify([{ id: 'PS-100', title: 'Upstream Key', cost: 10, requiresEmailActivation: false, description: 'mock' }, { id: 'PS-200', title: 'Upstream Activation', cost: 20, requiresEmailActivation: true, description: 'mock' }]), { status: 200 });
  }
  if (u.includes('prodseller.com/v1/balance')) return new Response(JSON.stringify({ balance: 123.45 }), { status: 200 });
  if (u.includes('prodseller.com/v1/orders/') && method === 'GET') {
    const id = decodeURIComponent(u.split('/v1/orders/')[1]);
    if (id === 'PSORD-1') { getCountPSORD1++; if (getCountPSORD1 >= 2) return new Response(JSON.stringify({ id: 'PSORD-1', status: 'delivered', deliveredKey: 'UP-ACT-KEY', amount: 24 }), { status: 200 }); return new Response(JSON.stringify({ id: 'PSORD-1', status: 'paid', amount: 24 }), { status: 200 }); }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  if (u.includes('prodseller.com/v1/orders') && method === 'POST') {
    upstreamCalls.push({ productId: body.productId, idem: (opts.headers || {})['Idempotency-Key'], body });
    if (body.productId === 'PS-100') return new Response(JSON.stringify({ id: 'PSORD-100', status: 'delivered', deliveredKey: 'UP-KEY-ABC', amount: 12, discount: 0 }), { status: 200 });
    if (body.productId === 'PS-200') return new Response(JSON.stringify({ id: 'PSORD-1', status: 'paid', amount: 24 }), { status: 200 });
    if (body.productId === 'PS-402') return new Response(JSON.stringify({ error: 'insufficient balance' }), { status: 402 });
    if (body.productId === 'PS-409') return new Response(JSON.stringify({ error: 'out of stock' }), { status: 409 });
    return new Response(JSON.stringify({ error: 'unknown' }), { status: 500 });
  }
  // EVM RPC mock（第九轮白名单路径：X Layer USDT0 6 位、BEP20 USDT 18 位）：
  // eth_call 返回合约 decimals；eth_blockNumber 返回固定最新块；eth_getLogs 按收款地址返回待付款订单的匹配转账。
  // 日志区块 9980（最新 10000，20 确认），满足 BEP20 默认 15 确认与 X Layer 1 确认。
  if (u.includes('mock-xlayer') || u.includes('mock-bsc')) {
    const evmBody = opts.body ? JSON.parse(opts.body) : null;
    const EVM_DEC = { '0x779ded0c9e1022225f8e0630b35a9b54be713736': 6, '0x55d398326f99059ff775485246999027b3197955': 18 };
    if (evmBody && evmBody.method === 'eth_call') {
      const to = String((evmBody.params && evmBody.params[0] && evmBody.params[0].to) || '').toLowerCase();
      const dec = EVM_DEC[to];
      if (dec === undefined) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (0).toString(16).padStart(64, '0') }), { status: 200 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + dec.toString(16).padStart(64, '0') }), { status: 200 });
    }
    if (evmBody && evmBody.method === 'eth_blockNumber') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (10000).toString(16) }), { status: 200 });
    }
    if (evmBody && evmBody.method === 'eth_getLogs') {
      const f = (evmBody.params && evmBody.params[0]) || {};
      const contract = String(f.address || '').toLowerCase();
      const dec = EVM_DEC[contract];
      if (dec === undefined) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
      const toTopic = String((f.topics && f.topics[2]) || '');
      const toAddr = '0x' + toTopic.slice(-40).toLowerCase();
      const rows = db.prepare("SELECT * FROM orders WHERE LOWER(pay_address)=? AND status='pending_payment'").all(toAddr);
      const logs = rows.map((o, i) => {
        const raw = amountToRawMock(Number(o.actual_amount), dec);
        // 交易哈希必须每笔唯一（Worker 按 (chain, tx_hash, event_key) 去重；全用同一哈希会被当成重复付款）
        const txHash = '0x' + createHash('sha256').update('evm-' + o.order_no).digest('hex');
        return { address: contract, blockNumber: '0x' + (9980).toString(16), transactionHash: txHash, logIndex: '0x' + i.toString(16), topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), toTopic], data: '0x' + raw.toString(16).padStart(64, '0') };
      });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: logs }), { status: 200 });
    }
    if (evmBody && evmBody.method === 'eth_getTransactionReceipt') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
    }
  }
  throw new Error('Unexpected fetch: ' + u);
}
globalThis.fetch = mockFetch;
env.__fetch = mockFetch;
// Load worker: strip import/export
let code = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
code = code.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(html) + ';');
code = code.replace('export default {', 'globalThis.__W = {');
const fn = new Function(code + '\nreturn globalThis.__W;');
const worker = fn();
function makeCtx() { const c = { pending: [] }; c.waitUntil = (pr) => { c.pending.push(pr); }; c.drain = async () => { while (c.pending.length) { const batch = c.pending.splice(0); await Promise.all(batch.map((x) => x.catch(() => {}))); } }; return c; }
async function call(method, p, body, cookie, extraHeaders) {
  const ctx = makeCtx();
  const headers = { 'content-type': 'application/json', 'X-Admin-API': '1', ...(extraHeaders || {}) };
  if (cookie) headers.Cookie = cookie;
  const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: res.status, json: j, headers: res.headers, text: txt };
}
let capSeq = 0;
function mkCaptcha(code){
  const id = 'cap-test-' + (++capSeq);
  const h = createHash('sha256').update(code).digest('hex');
  const exp = new Date(Date.now() + 300000).toISOString().replace('T',' ').slice(0,19);
  db.prepare("INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?,?,0)").run(id, h, exp);
  return id;
}
let orderIpSeq = 0;
async function orderCall(body, cookie, ip){
  const cid = mkCaptcha('AB12');
  // P3-5：限流在验证码消费之前且计入全部尝试；每个独立下单用例用独立 IP，避免用例间限流互相干扰。
  orderIpSeq++;
  return call('POST', '/api/orders', { query_password: 'mock-test-pw', ...body, captcha_id: cid, captcha_code: 'AB12' }, cookie, { 'CF-Connecting-IP': ip || ('203.0.113.' + orderIpSeq) });
}
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); } console.log('PASS: ' + msg); }
function q(sql, ...a) { return db.prepare(sql).get(...a); }
function qa(sql, ...a) { return db.prepare(sql).all(...a); }
// settings
db.prepare("UPDATE settings SET value='1' WHERE key='email_enabled'").run();
db.prepare("UPDATE settings SET value='noreply@test.example' WHERE key='email_from'").run();
db.prepare("UPDATE settings SET value=? WHERE key='usdt_addresses'").run(JSON.stringify({ 'OKX|X Layer': '0x1111111111111111111111111111111111111111', 'Binance|BEP20': '0x2222222222222222222222222222222222222222' }));
db.prepare("UPDATE settings SET value=? WHERE key='rpc_urls'").run(JSON.stringify({ 'X Layer': ['https://mock-xlayer'], 'BEP20': ['https://mock-bsc'] }));
// ProdSeller 门禁：测试环境用 Mock 上游，显式开启门禁（模拟“已提供上游验证证据”的环境；生产默认关闭）。
db.prepare("UPDATE settings SET value='1' WHERE key='prodseller_enabled'").run();
// admin login + 首次改密（新规则：未改密的会话不能调其他管理接口）
let r = await call('POST', '/api/admin/login', { setup_token: 'test-setup-token' });
assert(r.json.ok, 'admin login');
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await call('POST', '/api/admin/change-password', { old_password: '', new_password: 'test-admin-password-123' }, cookie);
assert(r.json.ok, 'change-password from initial admin');
cookie = (r.headers.get('set-cookie') || '').split(';')[0] || cookie;
// 未改密会话应被拦截（用一个全新登录但不改密的会话验证）
let rNoChange = await call('POST', '/api/admin/login', { password: 'test-admin-password-123' });
assert(rNoChange.json.ok, 're-login with new password');
const cookieNoChange = (rNoChange.headers.get('set-cookie') || '').split(';')[0];
// 把 must_change_password 临时置 1，验证未改密会话调管理接口被 403（随后恢复）
db.prepare("UPDATE admin_meta SET value='1' WHERE key='must_change_password'").run();
let rBlocked = await call('GET', '/api/admin/stats', null, cookieNoChange);
assert(!rBlocked.json.ok && rBlocked.status === 403, 'un-changed-password session blocked from admin APIs');
db.prepare("UPDATE admin_meta SET value='0' WHERE key='must_change_password'").run();
// self card product
r = await call('POST', '/api/admin/products', { slug: 'self-card', title: 'Self Card', category: 'card', price_usdt: 10, sell_price: 10, source: 'self', delivery_method: 'both', stock_type: 'card', form_fields: [] }, cookie);
assert(r.json.ok, 'create self product');
const selfProd = q('SELECT * FROM products WHERE slug=?', 'self-card');
r = await call('POST', '/api/admin/cards/import', { product_id: selfProd.id, codes: 'DEMO-KEY-1\nDEMO-KEY-2\nDEMO-KEY-3\nDEMO-KEY-4\nDEMO-KEY-5\nDEMO-KEY-6' }, cookie);
assert(r.json.added === 6 && r.json.duplicate === 0, 'import cards 6 (added/duplicate split)');
// 重复导入：应正确识别重复，不把循环次数当成功数
r = await call('POST', '/api/admin/cards/import', { product_id: selfProd.id, codes: 'DEMO-KEY-1\nDEMO-KEY-7' }, cookie);
assert(r.json.added === 1 && r.json.duplicate === 1, 'import duplicate detected: added=1 duplicate=1');
// upstream sync + import
r = await call('POST', '/api/admin/upstream/sync', {}, cookie);
assert(r.json.ok && r.json.count === 2, 'upstream sync count=2');
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-100' }, { id: 'PS-200' }] }, cookie);
assert(r.json.ok && r.json.imported === 2, 'upstream import 2');
const up100 = q('SELECT * FROM products WHERE prodseller_id=?', 'PS-100');
const up200 = q('SELECT * FROM products WHERE prodseller_id=?', 'PS-200');
assert(up100.sell_price === 12, 'PS-100 sell = 10*1.2 = ' + up100.sell_price);
assert(up200.sell_price === 24, 'PS-200 sell = 20*1.2 = ' + up200.sell_price);
assert(up200.requires_email_activation === 1, 'PS-200 requires activation');
// Bot2 FAIL①：重新 import 不得覆盖管理员自定义售价
db.prepare("UPDATE products SET sell_price=99, price_usdt=99 WHERE prodseller_id=?").run('PS-100');
r = await call('POST', '/api/admin/upstream/import', { items: [{ id: 'PS-100' }] }, cookie);
assert(r.json.ok, 're-import PS-100 ok');
const up100re = q('SELECT * FROM products WHERE prodseller_id=?', 'PS-100');
assert(Number(up100re.sell_price) === 99 && Number(up100re.price_usdt) === 99, 're-import preserves admin sell_price, got ' + up100re.sell_price + '/' + up100re.price_usdt);
assert(Number(up100re.cost_price) === 10, 're-import still refreshes cost_price');
// 402 / 409 products
await call('POST', '/api/admin/products', { slug: 'ps-402', title: 'P402', category: 'recharge', price_usdt: 5, sell_price: 5, source: 'prodseller', prodseller_id: 'PS-402', delivery_method: 'both', stock_type: 'manual', form_fields: [] }, cookie);
await call('POST', '/api/admin/products', { slug: 'ps-409', title: 'P409', category: 'recharge', price_usdt: 5, sell_price: 5, source: 'prodseller', prodseller_id: 'PS-409', delivery_method: 'both', stock_type: 'manual', form_fields: [] }, cookie);
const p402 = q('SELECT * FROM products WHERE slug=?', 'ps-402');
const p409 = q('SELECT * FROM products WHERE slug=?', 'ps-409');
// Test A: self card via polling
r = await orderCall({ product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'buyer1@test.example', delivery_email: 'buyer@test.example' }, contact: 'buyer1@test.example', pay_method: 'Binance', pay_chain: 'BEP20' });
assert(r.json.ok, 'self order created');
const ctxA = makeCtx();
await worker.scheduled({ cron: '*/1 * * * *' }, env, ctxA); await ctxA.drain();
let oA = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
assert(oA.status === 'completed' && oA.delivery_content === 'DEMO-KEY-1', 'A self polling -> completed + card, got ' + oA.status + '/' + oA.delivery_content);
assert(sentEmails.length === 0, 'A email removed: no email sent, delivery via onsite only');
// duplicate polling: no duplicate
const emailsBefore = sentEmails.length;
const ctxA2 = makeCtx(); await worker.scheduled({ cron: '*/1 * * * *' }, env, ctxA2); await ctxA2.drain();
oA = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
assert(oA.status === 'completed', 'A duplicate polling stays completed');
assert(sentEmails.length === emailsBefore, 'A duplicate polling sends no email');
// Test B: upstream normal via polling
r = await orderCall({ product_id: up100.id, quantity: 1, customer_fields: { contact_email: 'buyer2@test.example', delivery_email: 'buyer@test.example' }, contact: 'buyer2@test.example', pay_method: 'Binance', pay_chain: 'BEP20' });
assert(r.json.ok, 'upstream order created');
const ctxB = makeCtx(); await worker.scheduled({ cron: '*/1 * * * *' }, env, ctxB); await ctxB.drain();
let oB = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
assert(oB.status === 'completed' && oB.delivery_content === 'UP-KEY-ABC', 'B upstream polling -> delivered, got ' + oB.status + '/' + oB.delivery_content);
assert(sentEmails.length === 0, 'B email removed: no email sent');
// Test G: admin confirm-payment on upstream (fresh order, no polling)
r = await orderCall({ product_id: up100.id, quantity: 1, customer_fields: { contact_email: 'buyer3@test.example' }, contact: 'buyer3@test.example', pay_method: 'Binance', pay_chain: 'BEP20' });
assert(r.json.ok, 'G upstream BEP20 order created');
let oG = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
r = await call('POST', '/api/admin/orders/' + oG.id + '/confirm-payment', {}, cookie);
assert(!r.json.ok && /原因/.test(r.json.error || ''), 'G confirm-payment without reason rejected: ' + JSON.stringify(r.json));
r = await call('POST', '/api/admin/orders/' + oG.id + '/confirm-payment', { reason: 'G admin manual confirm (mock upstream)' , manual_confirm: true }, cookie);
assert(r.json.ok, 'G admin confirm-payment ok: ' + JSON.stringify(r.json));
oG = q('SELECT * FROM orders WHERE id=?', oG.id);
assert(oG.status === 'completed' && oG.delivery_content === 'UP-KEY-ABC', 'G admin confirm -> ProdSeller delivered, got ' + oG.status);
// Test C: activation paid -> poll -> delivered
r = await orderCall({ product_id: up200.id, quantity: 1, customer_fields: { contact_email: 'buyer4@test.example', activation_email: 'act@test.example', activation_email_confirm: 'act@test.example' }, contact: 'buyer4@test.example', pay_method: 'Binance', pay_chain: 'BEP20', activation_confirm: true });
assert(r.json.ok, 'C activation order created: ' + JSON.stringify(r.json));
const ctxC1 = makeCtx(); await worker.scheduled({ cron: '*/1 * * * *' }, env, ctxC1); await ctxC1.drain();
let oC = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
assert(oC.status === 'pending_activation', 'C after payment -> pending_activation, got ' + oC.status);
assert(sentEmails.length === 0, 'C email removed: no activation email, onsite only');
assert(oC.delivery_content === '', 'C no delivery before deliveredKey');
const orderNoC = r.json.order.order_no;
// Bot2 FAIL②：激活类 quantity>1 必须 activation_emails 长度=quantity；履约 body.emails 同步
r = await orderCall({ product_id: up200.id, quantity: 2, customer_fields: { contact_email: 'buyer4b@test.example', activation_email: 'only-one@test.example', activation_email_confirm: 'only-one@test.example' }, contact: 'buyer4b@test.example', pay_method: 'Binance', pay_chain: 'BEP20', activation_confirm: true });
assert(!r.json.ok && /activation_emails|quantity/i.test(r.json.error || ''), 'C2 qty=2 without activation_emails rejected: ' + JSON.stringify(r.json));
r = await orderCall({ product_id: up200.id, quantity: 2, customer_fields: { contact_email: 'buyer4c@test.example', activation_emails: ['act1@test.example', 'act2@test.example'] }, contact: 'buyer4c@test.example', pay_method: 'Binance', pay_chain: 'BEP20', activation_confirm: true });
assert(r.json.ok, 'C2 qty=2 with activation_emails accepted: ' + JSON.stringify(r.json));
const ctxC2a = makeCtx(); await worker.scheduled({ cron: '*/1 * * * *' }, env, ctxC2a); await ctxC2a.drain();
const lastActPost = [...upstreamCalls].reverse().find((c) => c.body && c.body.productId === 'PS-200' && Number(c.body.quantity) === 2);
assert(lastActPost && Array.isArray(lastActPost.body.emails) && lastActPost.body.emails.length === 2 && lastActPost.body.emails[0] === 'act1@test.example' && lastActPost.body.emails[1] === 'act2@test.example', 'C2 upstream POST emails length=2: ' + JSON.stringify(lastActPost && lastActPost.body));
// 继续完成原 Test C 的第二次轮询（delivered）
const ctxC2 = makeCtx(); await worker.scheduled({ cron: '*/1 * * * *' }, env, ctxC2); await ctxC2.drain();
oC = q('SELECT * FROM orders WHERE order_no=?', orderNoC);
assert(oC.status === 'completed' && oC.delivery_content === 'UP-ACT-KEY', 'C poll -> delivered, got ' + oC.status + '/' + oC.delivery_content);
// Test D: 402
r = await orderCall({ product_id: p402.id, quantity: 1, customer_fields: { contact_email: 'buyer5@test.example' }, contact: 'buyer5@test.example', pay_method: 'Binance', pay_chain: 'BEP20' });
assert(r.json.ok, 'D 402 order created');
const ctxD = makeCtx(); await worker.scheduled({ cron: '*/1 * * * *' }, env, ctxD); await ctxD.drain();
let oD = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
assert(oD.status === 'pending_upstream' && oD.delivery_content === '', 'D 402 -> pending_upstream no delivery, got ' + oD.status);
r = await call('GET', '/api/admin/upstream/alerts', null, cookie);
assert(r.json.alerts.some((a) => a.order_no === oD.order_no), 'D alert listed in upstream/alerts');
// Test 409
r = await orderCall({ product_id: p409.id, quantity: 1, customer_fields: { contact_email: 'buyer6@test.example' }, contact: 'buyer6@test.example', pay_method: 'Binance', pay_chain: 'BEP20' });
assert(r.json.ok, '409 order created');
const ctxE = makeCtx(); await worker.scheduled({ cron: '*/1 * * * *' }, env, ctxE); await ctxE.drain();
let oE = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
assert(oE.status === 'pending_upstream', '409 -> pending_upstream, got ' + oE.status);
// Test E: timeout cancel
r = await orderCall({ product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'buyer7@test.example', delivery_email: 'buyer@test.example' }, contact: 'buyer7@test.example', pay_method: 'Binance', pay_chain: 'BEP20' });
assert(r.json.ok, 'timeout order created');
// expire it (mock only returns pending_payment rows; expiry check runs before chain check, so it cancels)
db.prepare("UPDATE orders SET expires_at=datetime('now','-1 minute') WHERE order_no=?").run(r.json.order.order_no);
const ctxT = makeCtx(); await worker.scheduled({ cron: '*/1 * * * *' }, env, ctxT); await ctxT.drain();
let oT = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
assert(oT.status === 'cancelled', 'timeout -> cancelled, got ' + oT.status);
// Idempotency-Key check: all upstream POSTs used order_no
assert(upstreamCalls.every((c) => c.idem && c.idem.startsWith('AIS')), 'Idempotency-Key = order_no on all upstream POSTs');
// Captcha tests
r = await call('GET', '/api/captcha');
assert(r.json.ok && r.json.captcha_id && r.json.svg.includes('<svg'), 'captcha GET returns svg');
assert(q('SELECT * FROM captcha_codes WHERE id=?', r.json.captcha_id), 'captcha row stored (hash only, no plaintext)');
r = await call('POST', '/api/orders', { product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'buyer@test.example', delivery_email: 'buyer@test.example' }, contact: 'buyer@test.example', pay_method: 'Binance', pay_chain: 'BEP20', query_password: 'mock-test-pw' });
assert(!r.json.ok && r.json.error.includes('验证码'), 'order without captcha rejected: ' + JSON.stringify(r.json));
const badCap = mkCaptcha('ZZ99');
r = await call('POST', '/api/orders', { product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'buyer@test.example', delivery_email: 'buyer@test.example' }, contact: 'buyer@test.example', pay_method: 'Binance', pay_chain: 'BEP20', query_password: 'mock-test-pw', captcha_id: badCap, captcha_code: 'WRONG' });
assert(!r.json.ok && r.json.error.includes('验证码错误'), 'wrong captcha rejected: ' + JSON.stringify(r.json));
assert(q('SELECT attempts FROM captcha_codes WHERE id=?', badCap).attempts === 1, 'wrong attempt counted');
const goodCap = mkCaptcha('AB12');
r = await call('POST', '/api/orders', { product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'buyer@test.example', delivery_email: 'buyer@test.example' }, contact: 'buyer@test.example', pay_method: 'Binance', pay_chain: 'BEP20', query_password: 'mock-test-pw', captcha_id: goodCap, captcha_code: 'AB12' });
assert(r.json.ok, 'order with correct captcha created: ' + JSON.stringify(r.json));
r = await call('POST', '/api/orders', { product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'buyer2@test.example', delivery_email: 'buyer2@test.example' }, contact: 'buyer2@test.example', pay_method: 'Binance', pay_chain: 'BEP20', query_password: 'mock-test-pw', captcha_id: goodCap, captcha_code: 'AB12' }, null, { 'CF-Connecting-IP': '203.0.113.99' });
assert(!r.json.ok && r.json.error.includes('验证码'), 'used captcha cannot be replayed: ' + JSON.stringify(r.json));
// Duplicate pending order: same contact, one pending only
r = await orderCall({ product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'dup@test.example', delivery_email: 'dup@test.example' }, contact: 'dup@test.example', pay_method: 'Binance', pay_chain: 'BEP20' });
assert(r.json.ok, 'dup first order created: ' + JSON.stringify(r.json));
const dupNo = r.json.order.order_no;
r = await orderCall({ product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'dup@test.example', delivery_email: 'dup@test.example' }, contact: 'dup@test.example', pay_method: 'Binance', pay_chain: 'BEP20' });
assert(!r.json.ok && r.json.error.includes('待付款'), 'dup second order blocked: ' + JSON.stringify(r.json));
const dupOrder = q('SELECT * FROM orders WHERE order_no=?', dupNo);
r = await call('POST', '/api/admin/orders/' + dupOrder.id + '/cancel', {}, cookie);
assert(r.json.ok, 'dup order cancelled: ' + JSON.stringify(r.json));
r = await orderCall({ product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'dup@test.example', delivery_email: 'dup@test.example' }, contact: 'dup@test.example', pay_method: 'Binance', pay_chain: 'BEP20' });
assert(r.json.ok, 'dup contact can order again after cancel: ' + JSON.stringify(r.json));
for (let i = 0; i < 10; i++) db.prepare("INSERT INTO order_rate (ip, created_at) VALUES ('unknown', datetime('now'))").run();
r = await orderCall({ product_id: selfProd.id, quantity: 1, customer_fields: { contact_email: 'buyer-rate@test.example', delivery_email: 'buyer-rate@test.example' }, contact: 'buyer-rate@test.example', pay_method: 'Binance', pay_chain: 'BEP20' }, undefined, 'unknown');
assert(!r.json.ok && r.json.error.includes('频繁'), 'rate limit blocks 11th order: ' + JSON.stringify(r.json));
// image_data validation (admin PUT)
r = await call('GET', '/api/admin/products', null, cookie);
const prodRow = r.json.products.find((x) => x.id === selfProd.id);
assert(prodRow, 'admin products list has selfProd');
const putBody = { ...prodRow };
try { putBody.form_fields = JSON.parse(prodRow.form_fields || '[]'); } catch { putBody.form_fields = []; }
putBody.image_data = 'not-an-image';
r = await call('PUT', '/api/admin/products/' + selfProd.id, putBody, cookie);
assert(!r.json.ok && r.json.error.includes('图片'), 'bad image_data rejected: ' + JSON.stringify(r.json));
putBody.image_data = 'data:image/jpeg;base64,' + 'A'.repeat(100);
r = await call('PUT', '/api/admin/products/' + selfProd.id, putBody, cookie);
assert(r.json.ok, 'good image_data accepted: ' + JSON.stringify(r.json));
assert(q('SELECT image_data FROM products WHERE id=?', selfProd.id).image_data.startsWith('data:image/jpeg'), 'image_data stored');
putBody.image_data = '';
r = await call('PUT', '/api/admin/products/' + selfProd.id, putBody, cookie);
assert(r.json.ok && q('SELECT image_data FROM products WHERE id=?', selfProd.id).image_data === '', 'image_data can be cleared');
console.log('ALL MOCK TESTS DONE, emails=' + sentEmails.length + ' upstreamCalls=' + upstreamCalls.length);
