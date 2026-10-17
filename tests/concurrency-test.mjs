// 并发 / 故障恢复 / 迁移专项测试（第二轮 P0/P1，全部 mock，不连真实接口）
// 要求：不得只用顺序调用模拟并发。关键竞争场景用 Promise.all 真并行 + 可控制的测试屏障（延迟 mock）制造竞态，
// 并检查最终数据库状态、卡密状态、订单交付内容与上游 Mock 调用次数，不只检查 HTTP 响应码。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const dir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
// ProdSeller 门禁：测试环境用 Mock 上游，显式开启门禁（模拟“已提供上游验证证据”的环境；生产默认关闭）。
db.prepare("UPDATE settings SET value='1' WHERE key='prodseller_enabled'").run();
// 支付白名单：新订单只允许 OKX|X Layer、Binance|BEP20；下单需有效收款地址。
// 并发测试的 OKX|X Layer 订单走 API 创建，故此处配置有效 EVM 收款地址。
// TRC20 场景（§3 cron 抢跑、§5b TXID 认领）测的是抢跑/认领逻辑而非下单，
// 故用直接插库的方式创建历史 TRC20 订单（不走 API），保留原逻辑断言。
db.prepare("UPDATE settings SET value=? WHERE key='usdt_addresses'").run(JSON.stringify({ 'OKX|X Layer': '0x1111111111111111111111111111111111111111', 'Binance|BEP20': '0x2222222222222222222222222222222222222222' }));
// 计数器：统计 PRAGMA / ALTER（验证常规请求不跑完整迁移）与上游调用
let pragmaCount = 0, alterCount = 0, upstreamCalls = 0, upstreamCreates = 0;
let upstreamDelayMs = 0; // 测试屏障：上游创建延迟，放大竞态窗口
let upstreamFailFirst = false; // 第一次上游创建抛错（模拟超时），第二次成功
function wrapStmt(sql) {
  if (/^\s*PRAGMA/i.test(sql)) pragmaCount++;
  if (/^\s*ALTER/i.test(sql)) alterCount++;
  let params = [];
  const api = {
    bind(...a) { params = a; return api; },
    async first() { try { const st = db.prepare(sql); const r = st.get(...params); return r === undefined ? null : r; } catch (e) { throw e; } },
    async all() { const st = db.prepare(sql); const rows = st.all(...params); return { results: rows }; },
    async run() { const st = db.prepare(sql); const info = st.run(...params); return { meta: { changes: info.changes } }; },
  };
  return api;
}
const env = { DB: { prepare: (sql) => wrapStmt(sql), async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } }, PRODSELLER_API_KEY: 'test-key', PRODSELLER_BASE_URL: 'https://prodseller.com/v1' };
// Mock fetch：ProdSeller（计数 + 延迟屏障 + 首次失败）与 Tronscan（链上到账）
let tronscanTransfer = null; // 由测试设置：{ to, amount, hash }
async function mockFetch(url, opts = {}) {
  const u = String(url);
  if (u.includes('prodseller.com/v1/orders') && (opts.method === 'POST' || (opts && opts.method === 'POST'))) {
    upstreamCalls++; upstreamCreates++;
    if (upstreamFailFirst) { upstreamFailFirst = false; throw new Error('upstream timeout (simulated)'); }
    if (upstreamDelayMs) await new Promise((res) => setTimeout(res, upstreamDelayMs));
    return new Response(JSON.stringify({ id: 'PS-ORDER-1', status: 'delivered', deliveredKey: 'PS-DELIVERED-KEY-1', amount: 10, discount: 0 }), { status: 200 });
  }
  if (u.includes('prodseller.com/v1/orders/')) {
    upstreamCalls++;
    return new Response(JSON.stringify({ id: 'PS-ORDER-1', status: 'delivered', deliveredKey: 'PS-DELIVERED-KEY-1' }), { status: 200 });
  }
  if (u.includes('tronscanapi.com')) {
    if (!tronscanTransfer) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response(JSON.stringify({ data: [{ to_address: tronscanTransfer.to, tokenInfo: { tokenId: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', tokenDecimal: 6 }, quant: Math.round(tronscanTransfer.amount * 1e6), block_ts: Date.now(), confirmed: true, transactionHash: tronscanTransfer.hash }] }), { status: 200 });
  }
  throw new Error('Unexpected fetch: ' + u);
}
globalThis.fetch = mockFetch;
env.__fetch = mockFetch;
let code = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'src/frontend.html'), 'utf8');
code = code.replace("import FRONTEND_HTML from './frontend.html';", 'const FRONTEND_HTML = ' + JSON.stringify(html) + ';');
code = code.replace('export default {', 'globalThis.__W = {');
const worker = new Function(code + '\nreturn globalThis.__W;')();
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
function mkCaptcha(codeStr) {
  const id = 'cap-conc-' + (++capSeq);
  const h = createHash('sha256').update(codeStr).digest('hex');
  const exp = new Date(Date.now() + 300000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare("INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?,?,0)").run(id, h, exp);
  return id;
}
async function orderCall(body) {
  const cid = mkCaptcha('AB12');
  // 每个下单用不同 IP，避免测试本身触到同 IP 下单限流（限流由 mock-test 专项覆盖）
  const ip = '10.9.9.' + ((++capSeq) % 200 + 1);
  return call('POST', '/api/orders', { ...body, captcha_id: cid, captcha_code: 'AB12' }, null, { 'CF-Connecting-IP': ip });
}
let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) { pass++; console.log('PASS:', name); } else { fail++; console.log('FAIL:', name, extra); } }
function q(sql, ...a) { return db.prepare(sql).get(...a); }
function qall(sql, ...a) { return db.prepare(sql).all(...a); }

// ===== 登录 =====
let r = await call('POST', '/api/admin/login', { password: 'admin' });
let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await call('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'conc-test-pass-123' }, cookie);
check('login + change-password', r.json && r.json.ok === true, JSON.stringify(r.json));

// ===== 建商品：卡密商品（1 张卡）与上游商品 =====
r = await call('POST', '/api/admin/products', { title: '并发卡密商品', category: 'card', stock_type: 'card', sell_price: 5, source: 'self' }, cookie);
check('create card product', r.json && r.json.ok === true, JSON.stringify(r.json));
const pCard = q("SELECT * FROM products WHERE title='并发卡密商品'");
r = await call('POST', '/api/admin/cards/import', { product_id: pCard.id, codes: 'CONC-CARD-ONLY-1' }, cookie);
check('import 1 card', r.json && r.json.added === 1, JSON.stringify(r.json));
r = await call('POST', '/api/admin/products', { title: '并发上游商品', category: 'recharge', stock_type: 'manual', sell_price: 10, source: 'prodseller', prodseller_id: 'ps-conc-1' }, cookie);
check('create upstream product', r.json && r.json.ok === true, JSON.stringify(r.json));
const pUp = q("SELECT * FROM products WHERE title='并发上游商品'");

// ===== 1. 两个下单请求同时争抢唯一可用卡密（真并行）=====
// 两个不同联系方式同时下单，1 张卡：只能一个成功，另一个删单报错；最终只有 1 笔订单，卡被胜者预留。
{
  const [ra, rb] = await Promise.all([
    orderCall({ product_id: pCard.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'conc-a@test.example', delivery_email: 'conc-a@test.example' } }),
    orderCall({ product_id: pCard.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'conc-b@test.example', delivery_email: 'conc-b@test.example' } }),
  ]);
  const okCount = [ra, rb].filter((x) => x.json && x.json.ok).length;
  const failCount = [ra, rb].filter((x) => x.json && !x.json.ok).length;
  check('concurrent orders: exactly one succeeds', okCount === 1 && failCount === 1, JSON.stringify([ra.json, rb.json]));
  const winnerNo = (ra.json && ra.json.ok ? ra : rb).json.order.order_no;
  const orders = qall('SELECT * FROM orders WHERE product_id=?', pCard.id);
  check('concurrent orders: only 1 order in DB', orders.length === 1, JSON.stringify(orders.map((o) => o.order_no)));
  const card = q('SELECT * FROM cards WHERE code=?', 'CONC-CARD-ONLY-1');
  check('concurrent orders: card reserved by winner only', card.reserved_order_id === orders[0].id, JSON.stringify(card));
  // 取消胜者，释放卡，供后续测试使用
  const cancelRes = await call('POST', '/api/admin/orders/' + orders[0].id + '/cancel', { reason: '并发测试清理' }, cookie);
  check('cancel winner to release card', cancelRes.json && cancelRes.json.ok === true, JSON.stringify(cancelRes.json));
  check('card released after cancel', q('SELECT reserved_order_id FROM cards WHERE code=?', 'CONC-CARD-ONLY-1').reserved_order_id === null);
  void winnerNo;
}

// ===== 2. 两个付款确认请求同时处理同一订单（真并行 + 上游延迟屏障）=====
// 上游商品订单：两个 confirm-payment 并行，上游创建延迟 50ms 放大竞态窗口。只应创建 1 次上游订单，订单只完成 1 次。
{
  upstreamDelayMs = 50;
  const beforeCreates = upstreamCreates;
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'conc-up@test.example' } });
  check('upstream order created', r.json && r.json.ok === true, JSON.stringify(r.json));
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const [c1, c2] = await Promise.all([
    call('POST', '/api/admin/orders/' + ord.id + '/confirm-payment', { reason: '并发确认1' }, cookie),
    call('POST', '/api/admin/orders/' + ord.id + '/confirm-payment', { reason: '并发确认2' }, cookie),
  ]);
  const okC = [c1, c2].filter((x) => x.json && x.json.ok).length;
  check('concurrent confirm-payment: exactly one succeeds', okC === 1, JSON.stringify([c1.json, c2.json]));
  check('concurrent confirm-payment: upstream created exactly once', upstreamCreates - beforeCreates === 1, 'creates=' + (upstreamCreates - beforeCreates));
  const finalOrd = q('SELECT * FROM orders WHERE id=?', ord.id);
  check('concurrent confirm-payment: order completed once', finalOrd.status === 'completed' && finalOrd.delivery_content === 'PS-DELIVERED-KEY-1', JSON.stringify(finalOrd));
  check('concurrent confirm-payment: one upstream_orders row', qall('SELECT * FROM upstream_orders WHERE order_id=?', ord.id).length === 1);
  upstreamDelayMs = 0;
}

// ===== 3. Cron 与管理员确认付款同时处理同一订单（真并行）=====
// TRC20 卡密订单 + Tronscan 返回匹配到账：cron（scheduled）与管理员 confirm 并行，只能一个认领成功，订单只完成一次，卡只用一次。
{
  // 补一张卡供本测试
  await call('POST', '/api/admin/cards/import', { product_id: pCard.id, codes: 'CONC-CARD-CRON-1' }, cookie);
  // 历史 TRC20 订单（白名单生效前已存在）：直接插库，不走 API（新订单已禁止 TRC20）。
  // 抢跑逻辑（cron 与管理员 confirm 争抢同一订单）与支付方式无关，故保留原断言。
  const cronOrderNo = 'AISCONCCRON1';
  const cronActual = 5.0037;
  db.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES (?, '', '', ?, '{}', 1, 5, 5, ?, 'TXYZCRONPAY', datetime('now','+30 minutes'), ?, 'conc-cron@test.example', 'Binance', 'TRC20', 'TXYZCRONPAY', 'pending_payment', datetime('now'))").run(cronOrderNo, pCard.id, cronActual, JSON.stringify({ contact_email: 'conc-cron@test.example', delivery_email: 'conc-cron@test.example' }));
  const ord = q('SELECT * FROM orders WHERE order_no=?', cronOrderNo);
  // 下单时预留卡：手动将该卡预留给本历史订单（等价于下单时的 reserveCards）
  db.prepare("UPDATE cards SET reserved_order_id=? WHERE code='CONC-CARD-CRON-1'").run(ord.id);
  check('cron-test order created', !!ord, JSON.stringify(ord));
  // 该订单实际预留的卡（预留按 id 取最早可用卡，不写死卡号）
  const reservedCard = q('SELECT * FROM cards WHERE reserved_order_id=?', ord.id);
  check('cron-test: card reserved for this order', !!reservedCard, JSON.stringify(reservedCard));
  const txHash = 'a'.repeat(64); // 64 位十六进制链上哈希
  tronscanTransfer = { to: ord.pay_address, amount: ord.actual_amount, hash: txHash };
  const ctx = makeCtx();
  const [cronRes, adminRes] = await Promise.all([
    (async () => { try { await worker.scheduled({ cron: '*/1 * * * *' }, env, ctx); await ctx.drain(); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; } })(),
    call('POST', '/api/admin/orders/' + ord.id + '/confirm-payment', { reason: '管理员并发确认' }, cookie),
  ]);
  void cronRes; void adminRes;
  const finalOrd = q('SELECT * FROM orders WHERE id=?', ord.id);
  check('cron vs admin: order completed exactly once', finalOrd.status === 'completed', JSON.stringify(finalOrd));
  check('cron vs admin: delivery is the reserved card', finalOrd.delivery_content === reservedCard.code, JSON.stringify(finalOrd));
  check('cron vs admin: card used once', (() => { const c = q('SELECT * FROM cards WHERE code=?', reservedCard.code); return c.is_used === 1 && c.order_id === ord.id; })());
  check('cron vs admin: txid claimed once for this order', (() => { const t = q('SELECT * FROM txid_claims WHERE tx_hash=?', txHash); return t && t.order_id === ord.id; })());
  tronscanTransfer = null;
}

// ===== 4. 两个发货请求同时处理同一订单（真并行）=====
{
  await call('POST', '/api/admin/cards/import', { product_id: pCard.id, codes: 'CONC-CARD-FULFILL-1' }, cookie);
  r = await orderCall({ product_id: pCard.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'conc-ful@test.example', delivery_email: 'conc-ful@test.example' } });
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  await call('POST', '/api/admin/orders/' + ord.id + '/confirm-payment', { reason: '先确认到 pending_fulfill？卡密商品 confirm 直接完成，改用人工商品测试' }, cookie);
  // 卡密商品 confirm-payment 直接完成，无法进入 pending_fulfill；改用“手动发货释放”场景的待发货订单（见第 7 节）。
  // 本节改测：两个 confirm-payment 并行处理同一卡密订单（与第 2 节同机制，不同商品路径）
  check('fulfill-test setup: card order completed by confirm', q('SELECT status FROM orders WHERE id=?', ord.id).status === 'completed');
  // 真正的双发货并行：用人工商品（pending_fulfill），两个 fulfill 并行，只能一个成功
  r = await call('POST', '/api/admin/products', { title: '并发人工商品', category: 'recharge', stock_type: 'manual', sell_price: 3, source: 'self' }, cookie);
  const pManual = q("SELECT * FROM products WHERE title='并发人工商品'");
  r = await orderCall({ product_id: pManual.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'conc-ful2@test.example' } });
  const ordM = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  await call('POST', '/api/admin/orders/' + ordM.id + '/confirm-payment', { reason: '确认到待发货' }, cookie);
  check('manual order pending_fulfill', q('SELECT status FROM orders WHERE id=?', ordM.id).status === 'pending_fulfill');
  const [f1, f2] = await Promise.all([
    call('POST', '/api/admin/orders/' + ordM.id + '/fulfill', { delivery_content: 'DELIVERY-A' }, cookie),
    call('POST', '/api/admin/orders/' + ordM.id + '/fulfill', { delivery_content: 'DELIVERY-B' }, cookie),
  ]);
  const okF = [f1, f2].filter((x) => x.json && x.json.ok).length;
  check('concurrent fulfill: exactly one succeeds', okF === 1, JSON.stringify([f1.json, f2.json]));
  const finalM = q('SELECT * FROM orders WHERE id=?', ordM.id);
  check('concurrent fulfill: order completed with one delivery', finalM.status === 'completed' && (finalM.delivery_content === 'DELIVERY-A' || finalM.delivery_content === 'DELIVERY-B'), JSON.stringify(finalM));
}

// ===== 5. 管理员确认不认领未核验 TXID（A-01 修复：仅链上核验路径认领）=====
// 订单 A：人工商品，手动设置 tx_hash 后管理员确认（无链上证明）→ 订单完成，但 TXID 不进入 txid_claims（不污染）。
// 订单 B：同一 tx，管理员确认 → 同样完成（管理员为人工确认的权威；未认领的 TXID 不阻塞人工确认）。
// TXID 的全局认领仅由链上核验路径（/pay、轮询）执行，见 §5b。
{
  const txHash2 = 'b'.repeat(64);
  r = await call('POST', '/api/admin/products', { title: 'TXID测试商品', category: 'recharge', stock_type: 'manual', sell_price: 4, source: 'self' }, cookie);
  const pTx = q("SELECT * FROM products WHERE title='TXID测试商品'");
  r = await orderCall({ product_id: pTx.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'tx-a@test.example' } });
  const ordA = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  // 直接设置 tx_hash（模拟客户已提交 TXID），再管理员确认 → 完成但不认领 tx
  db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(txHash2, ordA.id);
  r = await call('POST', '/api/admin/orders/' + ordA.id + '/confirm-payment', { reason: 'A 确认' }, cookie);
  check('admin confirm fulfills order A', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('admin confirm does NOT claim unverified txid', !q('SELECT * FROM txid_claims WHERE tx_hash=?', txHash2));
  // 订单 B：同一 tx，管理员确认 → 同样完成（不因未认领的 TXID 阻塞）
  r = await orderCall({ product_id: pTx.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'tx-b@test.example' } });
  const ordB = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  db.prepare('UPDATE orders SET tx_hash=? WHERE id=?').run(txHash2, ordB.id);
  r = await call('POST', '/api/admin/orders/' + ordB.id + '/confirm-payment', { reason: 'B 确认（不因未认领 TXID 阻塞）' }, cookie);
  check('admin confirm fulfills order B with same txid', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('txid still not claimed after admin confirms', !q('SELECT * FROM txid_claims WHERE tx_hash=?', txHash2));
}

// ===== 5b. TXID 不接管：链上核验路径（/pay）认领后，其他订单经 /pay 提交同一 tx 必须 409 =====
// 订单 C1 经 /pay 提交 tx 且链上核验通过 → 认领 tx；订单 C2 经 /pay 提交同一 tx → 409 明确错误，不静默接受。
{
  const pTx = q("SELECT * FROM products WHERE title='TXID测试商品'");
  const txHash3 = 'c'.repeat(64);
  // 订单 C1：历史 TRC20 订单（直接插库，新订单已禁止 TRC20），经 /pay 提交（Tronscan 返回匹配到账）→ 认领
  const c1No = 'AISCONCTXID1';
  db.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES (?, '', '', ?, '{}', 1, 4, 4, 4.0021, 'TXYZTXIDPAY1', datetime('now','+30 minutes'), ?, 'tx-c1@test.example', 'Binance', 'TRC20', 'TXYZTXIDPAY1', 'pending_payment', datetime('now'))").run(c1No, pTx.id, JSON.stringify({ contact_email: 'tx-c1@test.example' }));
  const ordC1 = q('SELECT * FROM orders WHERE order_no=?', c1No);
  tronscanTransfer = { to: ordC1.pay_address, amount: ordC1.actual_amount, hash: txHash3 };
  r = await call('POST', '/api/orders/' + ordC1.order_no + '/pay', { txid: txHash3 });
  check('order C1 claims txid via /pay', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('txid claimed by order C1', q('SELECT order_id FROM txid_claims WHERE tx_hash=?', txHash3).order_id === ordC1.id);
  // 订单 C2：历史 TRC20 订单（直接插库），Tronscan 返回匹配到账（同一 tx 哈希）
  const c2No = 'AISCONCTXID2';
  db.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES (?, '', '', ?, '{}', 1, 4, 4, 4.0029, 'TXYZTXIDPAY2', datetime('now','+30 minutes'), ?, 'tx-c2@test.example', 'Binance', 'TRC20', 'TXYZTXIDPAY2', 'pending_payment', datetime('now'))").run(c2No, pTx.id, JSON.stringify({ contact_email: 'tx-c2@test.example' }));
  const ordC2 = q('SELECT * FROM orders WHERE order_no=?', c2No);
  tronscanTransfer = { to: ordC2.pay_address, amount: ordC2.actual_amount, hash: txHash3 };
  r = await call('POST', '/api/orders/' + ordC2.order_no + '/pay', { txid: txHash3 });
  check('pay with stolen txid -> 409, not silently accepted', r.status === 409 && r.json && /已用于其他订单/.test(r.json.error || ''), 'status=' + r.status + ' body=' + JSON.stringify(r.json));
  check('order C2 still pending_payment after stolen-tx pay', q('SELECT status FROM orders WHERE id=?', ordC2.id).status === 'pending_payment');
  check('txid still belongs to C1 after steal attempt', q('SELECT order_id FROM txid_claims WHERE tx_hash=?', txHash3).order_id === ordC1.id);
  tronscanTransfer = null;
}

// ===== 6. 上游订单创建超时后重试：不重复采购 =====
{
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'conc-retry@test.example' } });
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  upstreamFailFirst = true; // 第一次创建抛错（模拟超时）
  const beforeCreates = upstreamCreates;
  r = await call('POST', '/api/admin/orders/' + ord.id + '/confirm-payment', { reason: '首次确认（上游超时）' }, cookie);
  check('first confirm -> pending_upstream on timeout', r.json && r.json.ok === true && /pending_upstream|上游/.test(r.json.message || ''), JSON.stringify(r.json));
  check('order pending_upstream after timeout', q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_upstream');
  check('timeout create counted', upstreamCreates - beforeCreates === 1);
  // 重试：上游轮询（无单号时用同一 Idempotency-Key 重试下单）
  upstreamFailFirst = false;
  r = await call('POST', '/api/admin/upstream/orders/' + ord.id + '/retry', { reason: '重试' }, cookie);
  check('retry ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('retry created upstream once more', upstreamCreates - beforeCreates === 2, 'creates=' + (upstreamCreates - beforeCreates));
  const finalOrd = q('SELECT * FROM orders WHERE id=?', ord.id);
  check('retry completes order', finalOrd.status === 'completed' && finalOrd.delivery_content === 'PS-DELIVERED-KEY-1', JSON.stringify(finalOrd));
  check('retry: one upstream_orders row', qall('SELECT * FROM upstream_orders WHERE order_id=?', ord.id).length === 1);
}

// ===== 6b. 上游轮询租约：Cron 与管理员重试同时轮询同一 pending_upstream 订单（真并行）=====
// 两个 pollUpstreamActivations 并行（Cron scheduled + 管理员重试端点），只能一个持有租约并创建上游订单；另一个跳过，不重复采购。
{
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'conc-lease@test.example' } });
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  upstreamFailFirst = true; // 首次确认上游超时 → pending_upstream，无上游单号
  r = await call('POST', '/api/admin/orders/' + ord.id + '/confirm-payment', { reason: '租约测试：先超时' }, cookie);
  check('lease setup: order pending_upstream', q('SELECT status FROM orders WHERE id=?', ord.id).status === 'pending_upstream');
  upstreamFailFirst = false;
  const beforeCreates = upstreamCreates;
  const ctx2 = makeCtx();
  const [retryRes, cronRes2] = await Promise.all([
    call('POST', '/api/admin/upstream/orders/' + ord.id + '/retry', { reason: '管理员重试' }, cookie),
    (async () => { try { await worker.scheduled({ cron: '*/1 * * * *' }, env, ctx2); await ctx2.drain(); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; } })(),
  ]);
  void retryRes; void cronRes2;
  check('concurrent poll: upstream created exactly once', upstreamCreates - beforeCreates === 1, 'creates=' + (upstreamCreates - beforeCreates));
  check('concurrent poll: one upstream_orders row', qall('SELECT * FROM upstream_orders WHERE order_id=?', ord.id).length === 1);
  check('concurrent poll: order completed once', q('SELECT status FROM orders WHERE id=?', ord.id).status === 'completed');
  check('concurrent poll: lease released after processing', q('SELECT upstream_lock FROM orders WHERE id=?', ord.id).upstream_lock === '');
}

// ===== 7. 卡密已领取、订单尚未完成时模拟 Worker 中断，验证恢复 =====
// 手动构造崩溃状态：卡已标记已用（归属本订单），订单仍 pending_payment，认领已过期（claimed_at 很久以前）。
// 恢复：管理员确认（重新认领，租约已过期）→ 应复用已标记的卡，不重复领取，订单完成。
{
  await call('POST', '/api/admin/cards/import', { product_id: pCard.id, codes: 'CONC-CARD-CRASH-1' }, cookie);
  r = await orderCall({ product_id: pCard.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'conc-crash@test.example', delivery_email: 'conc-crash@test.example' } });
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const card = q('SELECT * FROM cards WHERE reserved_order_id=?', ord.id);
  check('crash setup: card reserved', !!card);
  // 模拟崩溃：卡已标记已用，但订单未完成；认领已过期
  db.prepare('UPDATE cards SET is_used=1, order_id=?, reserved_order_id=NULL, reserved_at=NULL WHERE id=?').run(ord.id, card.id);
  db.prepare("UPDATE orders SET claim_token='stale-claim-token', claimed_at='2000-01-01 00:00:00', paid_at='2026-01-01 00:00:00' WHERE id=?").run(ord.id);
  r = await call('POST', '/api/admin/orders/' + ord.id + '/confirm-payment', { reason: '崩溃后恢复' }, cookie);
  check('crash recovery: confirm succeeds', r.json && r.json.ok === true, JSON.stringify(r.json));
  const finalOrd = q('SELECT * FROM orders WHERE id=?', ord.id);
  check('crash recovery: order completed with the crashed card', finalOrd.status === 'completed' && finalOrd.delivery_content === card.code, JSON.stringify(finalOrd));
  check('crash recovery: no extra card consumed', qall('SELECT * FROM cards WHERE is_used=1 AND order_id=?', ord.id).length === 1);
}

// ===== 8. 订单取消与付款认领同时发生（真并行）=====
// pending_payment 未付款订单：cancel 与 confirm-payment 并行，只能一个成功；最终状态一致（要么已取消，要么已付款处理）。
{
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'conc-cancel@test.example' } });
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const [cancelRes, confirmRes] = await Promise.all([
    call('POST', '/api/admin/orders/' + ord.id + '/cancel', { reason: '并发取消' }, cookie),
    call('POST', '/api/admin/orders/' + ord.id + '/confirm-payment', { reason: '并发确认' }, cookie),
  ]);
  const okN = [cancelRes, confirmRes].filter((x) => x.json && x.json.ok).length;
  check('cancel vs confirm: exactly one succeeds', okN === 1, JSON.stringify([cancelRes.json, confirmRes.json]));
  const finalOrd = q('SELECT * FROM orders WHERE id=?', ord.id);
  check('cancel vs confirm: final state consistent', finalOrd.status === 'cancelled' || finalOrd.status === 'completed' || finalOrd.status === 'pending_activation' || finalOrd.status === 'pending_upstream', JSON.stringify(finalOrd));
  if (finalOrd.status === 'cancelled') {
    check('cancel won: no upstream order created for cancelled order', qall('SELECT * FROM upstream_orders WHERE order_id=? AND prodseller_order_id != ?', ord.id, '').length === 0);
  }
}

// ===== 9. 手动发货释放预留（P1）=====
// 卡密订单：下单预留 → 管理员填手动交付内容完成 → 未使用的预留卡恢复可用；自动发卡后已用卡不释放。
{
  await call('POST', '/api/admin/cards/import', { product_id: pCard.id, codes: 'CONC-CARD-MANUAL-1' }, cookie);
  r = await orderCall({ product_id: pCard.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'conc-manual@test.example', delivery_email: 'conc-manual@test.example' } });
  const ord = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  check('manual-fulfill setup: card reserved', !!q('SELECT * FROM cards WHERE reserved_order_id=?', ord.id));
  // 先确认付款到 pending_fulfill？卡密商品 confirm 直接自动发卡。为测手动释放，用人工商品 + 卡密商品两种路径：
  // 路径 A：人工商品无预留，手动发货后无预留残留（基线）
  // 路径 B：卡密订单走“确认付款 → 自动发卡”会直接完成；要测手动释放，需让订单处于 pending_fulfill 且持有预留。
  // 构造：把卡密订单的 confirm 改为手动发货流程——直接调用 fulfill（pending_payment 不能直接发货，需先让订单进入 pending_fulfill 且不触发自动发卡）。
  // 实际路径：卡密订单 confirm-payment 会自动发卡并完成。为验证手动释放，改用“上游失败转 pending_fulfill 再手动发货”的等价路径：
  // 更直接的验证：创建一个卡密订单，手动将状态置为 pending_fulfill（模拟已付款待发货），预留仍在，然后手动发货。
  db.prepare("UPDATE orders SET status='pending_fulfill', paid_at=? WHERE id=?").run(new Date().toISOString().replace('T', ' ').slice(0, 19), ord.id);
  r = await call('POST', '/api/admin/orders/' + ord.id + '/fulfill', { delivery_content: 'MANUAL-DELIVERY-CONTENT' }, cookie);
  check('manual fulfill ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('manual fulfill: order completed with manual content', q('SELECT delivery_content FROM orders WHERE id=?', ord.id).delivery_content === 'MANUAL-DELIVERY-CONTENT');
  check('manual fulfill: reserved card released (available again)', (() => { const c = q('SELECT * FROM cards WHERE code=?', 'CONC-CARD-MANUAL-1'); return c.is_used === 0 && c.reserved_order_id === null; })());
  // 自动发卡后已用卡不释放：再建一笔卡密订单，confirm-payment 自动发卡，卡保持已用
  r = await orderCall({ product_id: pCard.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'conc-auto@test.example', delivery_email: 'conc-auto@test.example' } });
  const ordA2 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  r = await call('POST', '/api/admin/orders/' + ordA2.id + '/confirm-payment', { reason: '自动发卡' }, cookie);
  check('auto fulfill ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('auto fulfill: delivered card stays used', (() => { const c = q('SELECT * FROM cards WHERE order_id=? AND is_used=1', ordA2.id); return !!c; })());
}

// ===== 9b. 不抢他人预留卡：订单 A 无预留需补领时，不得取走订单 B 已预留的卡 =====
{
  await call('POST', '/api/admin/cards/import', { product_id: pCard.id, codes: 'CONC-CARD-NOSTEAL-A,CONC-CARD-NOSTEAL-B' }, cookie);
  // 订单 B 先下单，预留最早可用卡（NOSTEAL-A）
  r = await orderCall({ product_id: pCard.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'conc-nosteal-b@test.example', delivery_email: 'conc-nosteal-b@test.example' } });
  const ordB = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const cardB = q('SELECT * FROM cards WHERE reserved_order_id=?', ordB.id);
  check('nosteal setup: B reserved a card', !!cardB, JSON.stringify(cardB));
  // 订单 A 下单，预留另一张卡，然后手动清除 A 的预留（模拟预留丢失 / 兜底路径），再让 A 进入 pending_fulfill 后手动发货（自动补领）
  r = await orderCall({ product_id: pCard.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'conc-nosteal-a@test.example', delivery_email: 'conc-nosteal-a@test.example' } });
  const ordA = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  const cardA = q('SELECT * FROM cards WHERE reserved_order_id=?', ordA.id);
  check('nosteal setup: A reserved a card', !!cardA, JSON.stringify(cardA));
  db.prepare('UPDATE cards SET reserved_order_id=NULL, reserved_at=NULL WHERE id=?').run(cardA.id); // 清除 A 的预留
  db.prepare("UPDATE orders SET status='pending_fulfill', paid_at=? WHERE id=?").run(new Date().toISOString().replace('T', ' ').slice(0, 19), ordA.id);
  r = await call('POST', '/api/admin/orders/' + ordA.id + '/fulfill', {}, cookie);
  check('nosteal: A fulfills via fallback', r.json && r.json.ok === true, JSON.stringify(r.json));
  const finalA = q('SELECT * FROM orders WHERE id=?', ordA.id);
  check('nosteal: A did NOT take B reserved card', finalA.delivery_content !== cardB.code, 'A delivery=' + finalA.delivery_content + ' B card=' + cardB.code);
  check('nosteal: B reservation intact', q('SELECT reserved_order_id FROM cards WHERE id=?', cardB.id).reserved_order_id === ordB.id);
}

// ===== 10. 迁移：常规请求不跑完整迁移；旧库升级；迁移失败不伪装成功 =====
{
  // 常规请求：重置计数器，调 /api/config，验证无 PRAGMA / ALTER
  pragmaCount = 0; alterCount = 0;
  r = await call('GET', '/api/config');
  check('config ok', r.json && r.json.ok === true);
  check('normal request runs no PRAGMA/ALTER migration', pragmaCount === 0 && alterCount === 0, 'pragma=' + pragmaCount + ' alter=' + alterCount);
  pragmaCount = 0; alterCount = 0;
  r = await call('GET', '/api/products');
  check('products ok', r.json && r.json.ok === true);
  check('products request runs no PRAGMA/ALTER migration', pragmaCount === 0 && alterCount === 0, 'pragma=' + pragmaCount + ' alter=' + alterCount);
  // 登录请求也不跑完整迁移
  pragmaCount = 0; alterCount = 0;
  r = await call('POST', '/api/admin/login', { password: 'conc-test-pass-123' });
  check('login ok', r.json && r.json.ok === true);
  check('login request runs no PRAGMA/ALTER migration', pragmaCount === 0 && alterCount === 0, 'pragma=' + pragmaCount + ' alter=' + alterCount);
}
// 旧库升级：用一个独立的旧 schema 数据库（无 v6 字段、无 schema_migrations），跑迁移后数据保留、版本正确、重复执行幂等。
{
  const dbOld = new DatabaseSync(':memory:');
  // 构造旧库：schema.sql 去掉 v6 新增列/表与版本插入（模拟第一轮后的旧库：有 query_token_hash / 预留列，但无 claim/txid/异常字段）
  let oldSchema = fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8');
  oldSchema = oldSchema
    .replace(/  claim_token TEXT NOT NULL DEFAULT '',\n/, '')
    .replace(/  claimed_at TEXT,\n/, '')
    .replace(/  exception_reason TEXT NOT NULL DEFAULT '',\n/, '')
    .replace(/  refund_status TEXT NOT NULL DEFAULT '',\n/, '')
    .replace(/  refund_ref TEXT NOT NULL DEFAULT '',\n/, '')
    .replace(/-- TXID 原子认领[\s\S]*?CREATE INDEX IF NOT EXISTS idx_lookup_rate_ip ON lookup_rate\(ip, created_at\);\n/, '')
    .replace(/-- 上游轮询租约[^\n]*\n  upstream_lock TEXT NOT NULL DEFAULT '',\n  upstream_lock_expires_at TEXT,\n/, '')
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_orders_order_unique ON upstream_orders\(order_id\);\n/, '')
    .replace(/-- 数据库迁移版本[\s\S]*?INSERT OR IGNORE INTO schema_migrations \(version\) VALUES \(1\), \(2\), \(3\), \(4\), \(5\), \(6\), \(7\), \(8\), \(9\), \(10\)(, \(11\))?;\n/, '')
    // 剥离 v8（第四轮）：payments / scan_cursors / pay_rate / 金额与联系人部分唯一索引，模拟 v7 旧库
    .replace(/-- 第四轮（Release Readiness）[\s\S]*$/, '');
  dbOld.exec(oldSchema);
  // 旧数据：1 个商品 + 1 笔旧订单 + 1 张卡
  dbOld.prepare("INSERT INTO products (slug, title, category, price_usdt, stock_type) VALUES ('old-prod', '旧商品', 'card', 5, 'card')").run();
  const oldPid = dbOld.prepare("SELECT id FROM products WHERE slug='old-prod'").get().id;
  dbOld.prepare("INSERT INTO cards (product_id, code) VALUES (?, 'OLD-CARD-1')").run(oldPid);
  dbOld.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, status, created_at) VALUES ('AISOLD001', '123456', '', ?, '{}', 1, 5, 5, 'completed', datetime('now'))").run(oldPid);
  // 旧库脏数据：upstream_orders 有两行同 order_id（并发 SELECT→INSERT 的历史产物），迁移 v7 应去重只留最新行
  const oldOid = dbOld.prepare("SELECT id FROM orders WHERE order_no='AISOLD001'").get().id;
  dbOld.prepare("INSERT INTO upstream_orders (order_id, prodseller_order_id, status) VALUES (?, 'PS-OLD-1', 'paid')").run(oldOid);
  dbOld.prepare("INSERT INTO upstream_orders (order_id, prodseller_order_id, status) VALUES (?, 'PS-OLD-2', 'delivered')").run(oldOid);
  // 用旧库跑 Worker（复用同一 worker 代码，换 env）
  const envOld = { DB: { prepare: (sql) => { let params = []; const api = { bind(...a) { params = a; return api; }, async first() { try { const st = dbOld.prepare(sql); const rr = st.get(...params); return rr === undefined ? null : rr; } catch (e) { throw e; } }, async all() { const st = dbOld.prepare(sql); return { results: st.all(...params) }; }, async run() { const st = dbOld.prepare(sql); const info = st.run(...params); return { meta: { changes: info.changes } }; } }; return api; }, async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } }, PRODSELLER_API_KEY: 'test-key', PRODSELLER_BASE_URL: 'https://prodseller.com/v1' };
  async function callOld(method, p, body, ck) {
    const ctx = makeCtx();
    const headers = { 'content-type': 'application/json', 'X-Admin-API': '1' };
    if (ck) headers.Cookie = ck;
    const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const res = await worker.fetch(req, envOld, ctx);
    await ctx.drain();
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    return { status: res.status, json: j, headers: res.headers };
  }
  const lr = await callOld('POST', '/api/admin/login', { password: 'admin' });
  check('old-db login ok', lr.json && lr.json.ok === true, JSON.stringify(lr.json));
  const ocookie = (lr.headers.get('set-cookie') || '').split(';')[0];
  // 旧库无密码哈希，首次登录强制改密后才能调管理接口
  const cp = await callOld('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'old-db-pass-123' }, ocookie);
  check('old-db change-password ok', cp.json && cp.json.ok === true, JSON.stringify(cp.json));
  const mg = await callOld('GET', '/api/admin/migrate', null, ocookie);
  check('old-db migrated to v13', mg.json && mg.json.ok === true && mg.json.current_version === 13, JSON.stringify(mg.json));
  check('old-db: old order preserved', !!dbOld.prepare("SELECT * FROM orders WHERE order_no='AISOLD001'").get());
  check('old-db: old card preserved', !!dbOld.prepare("SELECT * FROM cards WHERE code='OLD-CARD-1'").get());
  check('old-db: old product preserved', !!dbOld.prepare("SELECT * FROM products WHERE slug='old-prod'").get());
  check('old-db: claim_token column added', (() => { const cols = dbOld.prepare('PRAGMA table_info(orders)').all().map((c) => c.name); return cols.includes('claim_token') && cols.includes('refund_status'); })());
  check('old-db: txid_claims table exists', (() => { try { dbOld.prepare('SELECT 1 FROM txid_claims LIMIT 1').get(); return true; } catch { return false; } })());
  check('old-db: upstream_orders deduped to latest row', (() => { const rows = dbOld.prepare('SELECT * FROM upstream_orders WHERE order_id=?').all(oldOid); return rows.length === 1 && rows[0].prodseller_order_id === 'PS-OLD-2'; })());
  check('old-db: upstream_lock columns added', (() => { const cols = dbOld.prepare('PRAGMA table_info(orders)').all().map((c) => c.name); return cols.includes('upstream_lock') && cols.includes('upstream_lock_expires_at'); })());
  check('old-db: payments table exists (v8)', (() => { try { dbOld.prepare('SELECT 1 FROM payments LIMIT 1').get(); return true; } catch { return false; } })());
  check('old-db: scan_cursors table exists (v8)', (() => { try { dbOld.prepare('SELECT 1 FROM scan_cursors LIMIT 1').get(); return true; } catch { return false; } })());
  check('old-db: pay_rate table exists (v8)', (() => { try { dbOld.prepare('SELECT 1 FROM pay_rate LIMIT 1').get(); return true; } catch { return false; } })());
  check('old-db: payments event unique index exists (v8)', (() => { const idx = dbOld.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='payments'").all().map((r) => r.name); return idx.includes('idx_payments_event_unique'); })());
  check('old-db: amount claim index exists (v8)', (() => { const idx = dbOld.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='orders'").all().map((r) => r.name); return idx.includes('idx_orders_amount_claim'); })());
  check('old-db: upstream_orders unique index exists', (() => { const idx = dbOld.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='upstream_orders'").all().map((r) => r.name); return idx.includes('idx_upstream_orders_order_unique'); })());
  // 重复执行迁移：幂等，数据不丢
  const mg2 = await callOld('POST', '/api/admin/migrate', {}, ocookie);
  check('old-db: re-migrate idempotent', mg2.json && mg2.json.ok === true && mg2.json.applied.length === 0, JSON.stringify(mg2.json));
  check('old-db: data still preserved after re-migrate', !!dbOld.prepare("SELECT * FROM orders WHERE order_no='AISOLD001'").get());
}
// 迁移失败不伪装成功：删除 orders 表，迁移 v1 应失败并明确报告版本，版本不标记。
{
  const dbBad = new DatabaseSync(':memory:');
  dbBad.exec(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
  dbBad.exec('DROP TABLE orders');
  dbBad.exec('DELETE FROM schema_migrations');
  const envBad = { DB: { prepare: (sql) => { let params = []; const api = { bind(...a) { params = a; return api; }, async first() { try { const st = dbBad.prepare(sql); const rr = st.get(...params); return rr === undefined ? null : rr; } catch (e) { throw e; } }, async all() { const st = dbBad.prepare(sql); return { results: st.all(...params) }; }, async run() { const st = dbBad.prepare(sql); const info = st.run(...params); return { meta: { changes: info.changes } }; } }; return api; }, async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } }, PRODSELLER_API_KEY: 'test-key' };
  const ctx = makeCtx();
  const req = new Request('http://test/api/config', { method: 'GET', headers: { 'content-type': 'application/json' } });
  const res = await worker.fetch(req, envBad, ctx);
  await ctx.drain();
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  check('migration failure -> 500 sanitized (generic + request_id, no DB leak)', res.status === 500 && /服务器内部错误/.test((j && j.error) || txt) && /关联 ID/.test((j && j.error) || txt) && !/数据库迁移失败/.test((j && j.error) || txt) && !/no such table/.test((j && j.error) || txt), 'status=' + res.status + ' body=' + txt.slice(0, 300));
  check('migration failure: version not marked', dbBad.prepare('SELECT COUNT(*) AS c FROM schema_migrations WHERE version=1').get().c === 0);
}

// ===== 11. 审计写入失败不静默成功 =====
// 删除 admin_audit 表 → 关键操作（取消）应返回明确的审计失败错误，而非宣称成功。
{
  const dbNoAudit = new DatabaseSync(':memory:');
  dbNoAudit.exec(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
  dbNoAudit.exec('DROP TABLE admin_audit');
  // 审计测试的订单走 OKX|X Layer，需有效收款地址（schema 种子为占位符，会拒单）
  dbNoAudit.prepare("UPDATE settings SET value=? WHERE key='usdt_addresses'").run(JSON.stringify({ 'OKX|X Layer': '0x1111111111111111111111111111111111111111' }));
  const envNoAudit = { DB: { prepare: (sql) => { let params = []; const api = { bind(...a) { params = a; return api; }, async first() { try { const st = dbNoAudit.prepare(sql); const rr = st.get(...params); return rr === undefined ? null : rr; } catch (e) { throw e; } }, async all() { const st = dbNoAudit.prepare(sql); return { results: st.all(...params) }; }, async run() { const st = dbNoAudit.prepare(sql); const info = st.run(...params); return { meta: { changes: info.changes } }; } }; return api; }, async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } }, PRODSELLER_API_KEY: 'test-key', PRODSELLER_BASE_URL: 'https://prodseller.com/v1' };
  async function callNoAudit(method, p, body, ck) {
    const ctx = makeCtx();
    const headers = { 'content-type': 'application/json', 'X-Admin-API': '1' };
    if (ck) headers.Cookie = ck;
    const req = new Request('http://test' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const res = await worker.fetch(req, envNoAudit, ctx);
    await ctx.drain();
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    return { status: res.status, json: j, headers: res.headers };
  }
  const lr2 = await callNoAudit('POST', '/api/admin/login', { password: 'admin' });
  const ck2 = (lr2.headers.get('set-cookie') || '').split(';')[0];
  await callNoAudit('POST', '/api/admin/change-password', { old_password: 'admin', new_password: 'audit-fail-pass-1' }, ck2);
  // 建商品 + 下单 + 取消：取消时审计写入失败（表不存在），应返回明确错误，而非 ok
  const pr = await callNoAudit('POST', '/api/admin/products', { title: '审计失败商品', category: 'recharge', stock_type: 'manual', sell_price: 2, source: 'self' }, ck2);
  const pA = dbNoAudit.prepare("SELECT id FROM products WHERE title='审计失败商品'").get().id;
  void pr;
  const cid = (() => { const id = 'cap-audit-' + Date.now(); const h = createHash('sha256').update('AB12').digest('hex'); const exp = new Date(Date.now() + 300000).toISOString().replace('T', ' ').slice(0, 19); dbNoAudit.prepare("INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?,?,?,0)").run(id, h, exp); return id; })();
  const oc = await callNoAudit('POST', '/api/orders', { product_id: pA, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'audit-fail@test.example' }, captcha_id: cid, captcha_code: 'AB12' });
  check('audit-fail setup: order created', oc.json && oc.json.ok === true, JSON.stringify(oc.json));
  const ordAF = dbNoAudit.prepare('SELECT * FROM orders WHERE order_no=?').get(oc.json.order.order_no);
  const cancelAF = await callNoAudit('POST', '/api/admin/orders/' + ordAF.id + '/cancel', { reason: '审计失败测试' }, ck2);
  check('audit failure: cancel reports audit error, not success', cancelAF.json && !cancelAF.json.ok && /审计/.test(cancelAF.json.error || ''), JSON.stringify(cancelAF.json));
  check('audit failure: order was cancelled (primary effect stands)', dbNoAudit.prepare('SELECT status FROM orders WHERE id=?').get(ordAF.id).status === 'cancelled');
}

// ===== 12. 第三轮复审修复回归：B-01 / C-01 / A-03 =====
// B-01：已付款待履约订单的预留卡不被日清理释放
{
  r = await call('POST', '/api/admin/products', { title: 'B01卡密商品', category: 'card', stock_type: 'card', sell_price: 3, source: 'self' }, cookie);
  const pB01 = q("SELECT * FROM products WHERE title='B01卡密商品'");
  r = await call('POST', '/api/admin/cards/import', { product_id: pB01.id, codes: 'B01-CARD-1' }, cookie);
  check('B-01 setup: card imported', r.json && r.json.ok === true, JSON.stringify(r.json));
  r = await orderCall({ product_id: pB01.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'b01@test.example', delivery_email: 'b01@test.example' } });
  const ordB01 = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  check('B-01 setup: card reserved', q('SELECT reserved_order_id FROM cards WHERE code=?', 'B01-CARD-1').reserved_order_id === ordB01.id);
  // 模拟：已付款但领取失败进入 pending_fulfill，预留仍持有（is_used=0, reserved_order_id=本订单）
  db.prepare("UPDATE orders SET status='pending_fulfill', paid_at=datetime('now') WHERE id=?").run(ordB01.id);
  r = await call('POST', '/api/admin/cleanup', {}, cookie);
  check('B-01 cleanup ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('B-01: paid pending_fulfill reservation NOT released', q('SELECT reserved_order_id FROM cards WHERE code=?', 'B01-CARD-1').reserved_order_id === ordB01.id);
}

// C-01：管理员重试单笔上游订单只处理该订单，不处理其他待处理订单
{
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'c01-a@test.example' } });
  const ordC01A = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  r = await orderCall({ product_id: pUp.id, quantity: 1, pay_method: 'OKX', pay_chain: 'X Layer', customer_fields: { contact_email: 'c01-b@test.example' } });
  const ordC01B = q('SELECT * FROM orders WHERE order_no=?', r.json.order.order_no);
  upstreamFailFirst = true;
  await call('POST', '/api/admin/orders/' + ordC01A.id + '/confirm-payment', { reason: 'C01-A 超时' }, cookie);
  upstreamFailFirst = true;
  await call('POST', '/api/admin/orders/' + ordC01B.id + '/confirm-payment', { reason: 'C01-B 超时' }, cookie);
  check('C-01 setup: both pending_upstream', q('SELECT status FROM orders WHERE id=?', ordC01A.id).status === 'pending_upstream' && q('SELECT status FROM orders WHERE id=?', ordC01B.id).status === 'pending_upstream');
  upstreamFailFirst = false;
  r = await call('POST', '/api/admin/upstream/orders/' + ordC01A.id + '/retry', { reason: '只重试 A' }, cookie);
  check('C-01 retry A ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('C-01: A completed', q('SELECT status FROM orders WHERE id=?', ordC01A.id).status === 'completed');
  check('C-01: B untouched (still pending_upstream)', q('SELECT status FROM orders WHERE id=?', ordC01B.id).status === 'pending_upstream');
  check('C-01: B upstream row untouched (still empty psId + upstream_error)', (() => { const ub = q('SELECT * FROM upstream_orders WHERE order_id=?', ordC01B.id); return ub && ub.prodseller_order_id === '' && ub.status === 'upstream_error'; })(), JSON.stringify(q('SELECT * FROM upstream_orders WHERE order_id=?', ordC01B.id)));
}

// A-03：租约接管用新 TXID 覆盖旧 tx_hash 时，旧 TXID 认领被释放（不留孤儿）
{
  const pTx3 = q("SELECT * FROM products WHERE title='TXID测试商品'");
  const txOld = 'd'.repeat(64);
  const txNew = 'e'.repeat(64);
  // 历史 TRC20 订单（直接插库，新订单已禁止 TRC20）；测的是租约接管/旧 TXID 释放逻辑
  const a03No = 'AISCONCA03';
  db.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES (?, '', '', ?, '{}', 1, 4, 4, 4.0033, 'TXYZTXIDPAY3', datetime('now','+30 minutes'), ?, 'a03@test.example', 'Binance', 'TRC20', 'TXYZTXIDPAY3', 'pending_payment', datetime('now'))").run(a03No, pTx3.id, JSON.stringify({ contact_email: 'a03@test.example' }));
  const ordA03 = q('SELECT * FROM orders WHERE order_no=?', a03No);
  // 模拟：订单已认领旧 TXID（链上核验路径），但处理崩溃，租约过期
  db.prepare('INSERT INTO txid_claims (tx_hash, order_id) VALUES (?, ?)').run(txOld, ordA03.id);
  db.prepare("UPDATE orders SET tx_hash=?, claim_token='STALE-TOKEN', claimed_at=datetime('now','-10 minutes') WHERE id=?").run(txOld, ordA03.id);
  // 新请求以新 TXID 经 /pay 接管（Tronscan 返回新 TXID 匹配到账）
  tronscanTransfer = { to: ordA03.pay_address, amount: ordA03.actual_amount, hash: txNew };
  r = await call('POST', '/api/orders/' + ordA03.order_no + '/pay', { txid: txNew });
  check('A-03 takeover via /pay ok', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('A-03: order tx_hash updated to new', q('SELECT tx_hash FROM orders WHERE id=?', ordA03.id).tx_hash === txNew);
  check('A-03: new txid claimed', q('SELECT order_id FROM txid_claims WHERE tx_hash=?', txNew).order_id === ordA03.id);
  check('A-03: old txid claim released (no orphan)', !q('SELECT * FROM txid_claims WHERE tx_hash=?', txOld));
  tronscanTransfer = null;
}

// C-02：Tronscan 分页——匹配到账在第 2 页（第 1 页 50 笔均不匹配），轮询仍能找到
{
  const pTxC02 = q("SELECT * FROM products WHERE title='TXID测试商品'");
  // 历史 TRC20 订单（直接插库，新订单已禁止 TRC20）；测的是 Tronscan 分页逻辑
  const c02No = 'AISCONCC02';
  db.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES (?, '', '', ?, '{}', 1, 4, 4, 4.0041, 'TXYZTXIDPAY4', datetime('now','+30 minutes'), ?, 'c02@test.example', 'Binance', 'TRC20', 'TXYZTXIDPAY4', 'pending_payment', datetime('now'))").run(c02No, pTxC02.id, JSON.stringify({ contact_email: 'c02@test.example' }));
  const ordC02 = q('SELECT * FROM orders WHERE order_no=?', c02No);
  const txC02 = 'f'.repeat(64);
  // 临时替换 fetch：Tronscan transfers 按 start 分页；其他请求走原 mock
  const origFetch = env.__fetch;
  const pageFetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('tronscanapi.com/api/token_trc20/transfers')) {
      const start = Number(new URL(u).searchParams.get('start') || 0);
      if (start === 0) {
        // 第 1 页：50 笔，金额均不匹配，时间戳为当前（不触发提前停页）
        const rows = [];
        for (let i = 0; i < 50; i++) rows.push({ to_address: ordC02.pay_address, tokenInfo: { tokenId: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', tokenDecimal: 6 }, quant: Math.round((ordC02.actual_amount + 1 + i) * 1e6), block_ts: Date.now(), confirmed: true, transactionHash: 'NONMATCH-' + i });
        return new Response(JSON.stringify({ data: rows }), { status: 200 });
      }
      // 第 2 页：匹配到账
      return new Response(JSON.stringify({ data: [{ to_address: ordC02.pay_address, tokenInfo: { tokenId: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', tokenDecimal: 6 }, quant: Math.round(ordC02.actual_amount * 1e6), block_ts: Date.now(), confirmed: true, transactionHash: txC02 }] }), { status: 200 });
    }
    return origFetch(url, opts);
  };
  env.__fetch = pageFetch;
  globalThis.fetch = pageFetch;
  const ctxC02 = makeCtx();
  try { await worker.scheduled({ cron: '*/1 * * * *' }, env, ctxC02); await ctxC02.drain(); } catch (e) { check('C-02 scheduled no throw', false, String(e)); }
  env.__fetch = origFetch;
  globalThis.fetch = origFetch;
  check('C-02: match on page 2 found, order paid (pending_fulfill, manual product)', q('SELECT status FROM orders WHERE id=?', ordC02.id).status === 'pending_fulfill');
  check('C-02: txid claimed from page 2', q('SELECT tx_hash FROM orders WHERE id=?', ordC02.id).tx_hash === txC02);
}

// A-04（第四轮更新）：EVM /pay 按各链确认策略（ERC20 需 12 确认，不再全链 1 确认）。
// 收据区块 100：最新 100 → 0 确认，拒绝；最新 111 → 11 确认，仍拒绝；最新 112 → 12 确认，接受。
{
  const pTxA04 = q("SELECT * FROM products WHERE title='TXID测试商品'");
  const txA04 = '1'.repeat(64); // 唯一 TXID（§4 用 'a'*64、§5 用 'b'*64、A-03 用 'd'/'e'、C-02 用 'f'，不得撞）
  const ERC20_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const TRANSFER0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  // 历史 ERC20 订单（直接插库，新订单已禁止 ERC20）；测的是 /pay 按各链确认策略（ERC20 需 12 确认）
  const a04No = 'AISCONCA04';
  db.prepare("INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES (?, '', '', ?, '{}', 1, 4, 4, 4.0055, '0x3333333333333333333333333333333333333333', datetime('now','+30 minutes'), ?, 'a04@test.example', 'OKX', 'ERC20', '0x3333333333333333333333333333333333333333', 'pending_payment', datetime('now'))").run(a04No, pTxA04.id, JSON.stringify({ contact_email: 'a04@test.example' }));
  const ordA04 = q('SELECT * FROM orders WHERE order_no=?', a04No);
  const toTopic = '0x' + '000000000000000000000000' + String(ordA04.pay_address).slice(2).toLowerCase();
  const amtHex = '0x' + BigInt(Math.round(Number(ordA04.actual_amount) * 1e6)).toString(16).padStart(64, '0');
  let evmLatest = 100; // 最新区块（可推进，模拟确认数增长）
  const origFetch2 = env.__fetch;
  const evmFetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('llamarpc.com') || u.includes('ankr.com')) {
      const body = JSON.parse(opts.body || '{}');
      // ERC20 USDT 为 6 位精度（新 Worker 需 eth_call 读 decimals 才能核验）
      if (body.method === 'eth_call') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (6).toString(16).padStart(64, '0') }), { status: 200 });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
          status: '0x1', blockNumber: '0x64', // 收据区块 100
          logs: [{ address: ERC20_USDT, topics: [TRANSFER0, '0x' + '0'.repeat(64), toTopic], data: amtHex }],
        } }), { status: 200 });
      }
      if (body.method === 'eth_blockNumber') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + evmLatest.toString(16) }), { status: 200 });
      }
    }
    return origFetch2(url, opts);
  };
  env.__fetch = evmFetch;
  globalThis.fetch = evmFetch;
  // 0 确认：/pay 暂存 TXID 交轮询核验（auto:false），不立即完成、不认领 TXID（A-04 修复：0 确认不得直接发货）
  r = await call('POST', '/api/orders/' + ordA04.order_no + '/pay', { txid: txA04 });
  check('A-04: EVM /pay 0-confirmation deferred (auto:false)', r.json && r.json.ok === true && r.json.auto === false, JSON.stringify(r.json));
  check('A-04: order still pending_payment after 0-conf', q('SELECT status FROM orders WHERE id=?', ordA04.id).status === 'pending_payment');
  check('A-04: 0-conf TXID NOT claimed', !q('SELECT * FROM txid_claims WHERE tx_hash=?', txA04));
  // 11 确认（ERC20 需 12）：仍延迟，不接受
  evmLatest = 111;
  r = await call('POST', '/api/orders/' + ordA04.order_no + '/pay', { txid: txA04 });
  check('A-04: EVM /pay 11-confirmation still deferred (ERC20 needs 12)', r.json && r.json.ok === true && r.json.auto === false, JSON.stringify(r.json));
  check('A-04: order still pending_payment after 11-conf', q('SELECT status FROM orders WHERE id=?', ordA04.id).status === 'pending_payment');
  // 12 确认：最新区块推进到 112，收据区块 100 <= 100 → 接受
  evmLatest = 112;
  r = await call('POST', '/api/orders/' + ordA04.order_no + '/pay', { txid: txA04 });
  check('A-04: EVM /pay 12-confirmation accepted', r.json && r.json.ok === true, JSON.stringify(r.json));
  check('A-04: order paid after 12-conf', q('SELECT status FROM orders WHERE id=?', ordA04.id).status === 'pending_fulfill');
  env.__fetch = origFetch2;
  globalThis.fetch = origFetch2;
}

console.log('\nCONCURRENCY TEST DONE pass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
