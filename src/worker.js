// aisou-lite — Cloudflare Worker + D1 轻量版虚拟商品售卖站
// 单文件、无构建步骤、vanilla JS + CSS。免费版：单 Worker + 单 D1 + 2 个 cron。
// 安全：PBKDF2 迭代 100000（Workers 生产上限），参数化查询，httpOnly session cookie。
// 支付：CF 轮询自动发货（链上按精确金额匹配，1-3 分钟）+ 币安 UID 手动兜底。
// 轮询原理：下单生成 actual_amount = 基础价 + 随机尾数 0.0001-0.0099，锁定 20 分钟；
// cron 每 1 分钟查 D1 有无 pending_payment，无则零 RPC；有则查 Tronscan / 公开 RPC 匹配 to+金额。

var PBKDF2_ITERATIONS = 100000;
var SESSION_MAX_AGE = 7 * 24 * 3600;
var PAY_METHODS = ['Binance', 'OKX', 'BinanceUID'];
var PAY_CHAINS = ['X Layer', 'TRC20', 'ERC20', 'BEP20', '站内转账'];
var ORDER_STATUSES = ['pending_payment', 'pending_fulfill', 'pending_activation', 'pending_upstream', 'completed', 'cancelled'];
var PRODSELLER_DEFAULT_BASE = 'https://prodseller.com/v1';
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validEmail(s){ return EMAIL_RE.test(String(s||'').trim()); }
function getFetch(env){ return (env && env.__fetch) ? env.__fetch : fetch; }
function getProdSellerBase(env, settings){ return (env && env.PRODSELLER_BASE_URL) || (settings && settings.prodseller_base_url) || PRODSELLER_DEFAULT_BASE; }
function getEffectivePrice(prod){ var sp = Number(prod && prod.sell_price); if (isFinite(sp) && sp > 0) return sp; return Number(prod ? prod.price_usdt : 0) || 0; }
async function cardStockMap(env){
  var m = {};
  try {
    var r = await env.DB.prepare('SELECT product_id, COUNT(*) as c FROM cards WHERE is_used = 0 AND is_disabled = 0 GROUP BY product_id').all();
    for (var i = 0; i < (r.results || []).length; i++){ m[String(r.results[i].product_id)] = Number(r.results[i].c) || 0; }
  } catch (e) {}
  return m;
}
function realInStock(p, cardMap){
  // 前后台统一口径：对接商品用上游同步的 in_stock；自营卡密/成品号用真实卡密数推导；自营人工商品用管理员设置的 in_stock
  if (p && p.source === 'prodseller') return Number(p.in_stock == null ? 1 : p.in_stock);
  if (p && (p.stock_type === 'card' || p.category === 'account')) return ((cardMap && cardMap[String(p.id)]) || 0) > 0 ? 1 : 0;
  return Number(p && p.in_stock == null ? 1 : p.in_stock);
}
function validImageData(s){
  if (typeof s !== 'string') return false;
  if (s.length === 0) return true;
  if (s.length > 700000) return false;
  return s.indexOf('data:image/jpeg;base64,') === 0 || s.indexOf('data:image/png;base64,') === 0 || s.indexOf('data:image/webp;base64,') === 0;
}
var POLL_LOCK_MINUTES = 20;
var TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
var USDT_TRC20_ID = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
var DEFAULT_RPC_URLS = { 'X Layer': ['https://xlayerrpc.okx.com'], 'ERC20': ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth'], 'BEP20': ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io'] };
var DEFAULT_USDT_CONTRACTS = { 'X Layer': '', 'ERC20': '0xdAC17F958D2ee523a2206206994597C13D831ec7', 'BEP20': '0x55d398326f99059fF775485246999027B3197955', 'TRC20': 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' };

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
function err(msg, status) { return json({ ok: false, error: msg }, status || 400); }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function nowISO() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function getCookie(req, name) {
  var h = req.headers.get('Cookie') || '';
  var parts = h.split(';');
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].trim().split('=');
    if (kv[0] === name) return decodeURIComponent(kv[1] || '');
  }
  return '';
}
function randomHex(n) {
  var b = new Uint8Array(n);
  crypto.getRandomValues(b);
  var s = '';
  for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
  return s;
}
function genOrderNo() {
  var t = Date.now().toString(36).toUpperCase();
  var r = randomHex(3).toUpperCase();
  return 'AIS' + t + r;
}
function genQueryPassword() {
  var n = 100000 + Math.floor(Math.random() * 900000);
  return String(n);
}

// ---- 图形验证码：服务端生成、哈希入库、一次性、5 分钟过期、最多试 3 次 ----
var CAPTCHA_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
var CAPTCHA_TTL_MS = 5 * 60 * 1000;
var CAPTCHA_MAX_ATTEMPTS = 3;
var ORDER_RATE_LIMIT = 10; // 同一 IP 10 分钟内最多成功下单 10 笔，防批量刷单
var ORDER_RATE_WINDOW_MS = 10 * 60 * 1000;
async function sha256Hex(s){
  var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  var bytes = new Uint8Array(buf); var out = '';
  for (var i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
  return out;
}
function randBelow(n){ var b = new Uint8Array(1); crypto.getRandomValues(b); return b[0] % n; }
async function ensureCaptchaTables(env){
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS captcha_codes (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS order_rate (ip TEXT NOT NULL, created_at TEXT NOT NULL)').run();
}
function genCaptchaSVG(code){
  var colors = ['#1c1c1e','#0a84ff','#d70015','#5e5ce6','#ff9f0a','#30b0c7','#64d2ff'];
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="44" viewBox="0 0 120 44"><rect width="120" height="44" fill="#f2f2f7"/>';
  for (var i = 0; i < 8; i++){
    svg += '<line x1="' + randBelow(120) + '" y1="' + randBelow(44) + '" x2="' + randBelow(120) + '" y2="' + randBelow(44) + '" stroke="' + colors[randBelow(colors.length)] + '" stroke-width="1" opacity="0.35"/>';
  }
  for (var j = 0; j < 40; j++){
    svg += '<circle cx="' + randBelow(120) + '" cy="' + randBelow(44) + '" r="1" fill="' + colors[randBelow(colors.length)] + '" opacity="0.4"/>';
  }
  for (var k = 0; k < code.length; k++){
    var x = 12 + k * 27 + randBelow(5);
    var y = 30 + randBelow(5) - 2;
    var rot = randBelow(36) - 18;
    var fs = 24 + randBelow(6);
    svg += '<text x="' + x + '" y="' + y + '" font-family="monospace" font-size="' + fs + '" font-weight="bold" fill="' + colors[randBelow(colors.length)] + '" transform="rotate(' + rot + ' ' + x + ' ' + y + ')">' + code[k] + '</text>';
  }
  return svg + '</svg>';
}
function bufToB64(buf) {
  var bytes = new Uint8Array(buf);
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBuf(b64) {
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
async function hashPassword(password, saltB64) {
  var salt = b64ToBuf(saltB64);
  var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  var bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return bufToB64(bits);
}
async function getSetting(env, key) {
  var r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return r ? r.value : '';
}
async function getAllSettings(env) {
  var r = await env.DB.prepare('SELECT key, value FROM settings').all();
  var out = {};
  var rows = r.results || [];
  for (var i = 0; i < rows.length; i++) out[rows[i].key] = rows[i].value;
  return out;
}
async function getAdminMeta(env, key) {
  var r = await env.DB.prepare('SELECT value FROM admin_meta WHERE key = ?').bind(key).first();
  return r ? r.value : null;
}
async function setAdminMeta(env, key, value) {
  await env.DB.prepare('INSERT INTO admin_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}
async function getSession(env, req) {
  var token = getCookie(req, 'session_token');
  if (!token) return null;
  var s = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
  if (!s) return null;
  if (new Date(s.expires_at.replace(' ', 'T') + 'Z') < new Date()) return null;
  return s;
}
async function requireAdmin(env, req) {
  var s = await getSession(env, req);
  if (!s) return null;
  return s;
}
function isExpired7d(fulfilledAt) {
  if (!fulfilledAt) return false;
  var t = new Date(fulfilledAt.replace(' ', 'T') + 'Z').getTime();
  return (Date.now() - t) > 7 * 24 * 3600 * 1000;
}
// ---- CF 轮询自动发货：迁移 / 金额 / 链上核验 ----
async function ensureOrderColumns(env) {
  try {
    var info = await env.DB.prepare('PRAGMA table_info(orders)').all();
    var cols = {};
    (info.results || []).forEach(function (r) { cols[r.name] = 1; });
    var adds = [];
    if (!cols.actual_amount) adds.push("ALTER TABLE orders ADD COLUMN actual_amount REAL NOT NULL DEFAULT 0");
    if (!cols.pay_address) adds.push("ALTER TABLE orders ADD COLUMN pay_address TEXT NOT NULL DEFAULT ''");
    if (!cols.expires_at) adds.push("ALTER TABLE orders ADD COLUMN expires_at TEXT");
    if (!cols.last_checked_at) adds.push("ALTER TABLE orders ADD COLUMN last_checked_at TEXT");
    if (!cols.tx_hash) adds.push("ALTER TABLE orders ADD COLUMN tx_hash TEXT NOT NULL DEFAULT ''");
    for (var i = 0; i < adds.length; i++) { try { await env.DB.prepare(adds[i]).run(); } catch (e) {} }
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_orders_actual ON orders(pay_address, actual_amount, status)').run(); } catch (e) {}
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_orders_txhash ON orders(tx_hash)').run(); } catch (e) {}
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_orders_expires ON orders(status, expires_at)').run(); } catch (e) {}
  } catch (e) {}
}

async function ensureProductColumns(env) {
  try {
    var info = await env.DB.prepare('PRAGMA table_info(products)').all();
    var cols = {}; (info.results || []).forEach(function (r) { cols[r.name] = 1; });
    var adds = [];
    if (!cols.source) adds.push("ALTER TABLE products ADD COLUMN source TEXT NOT NULL DEFAULT 'self'");
    if (!cols.prodseller_id) adds.push("ALTER TABLE products ADD COLUMN prodseller_id TEXT NOT NULL DEFAULT ''");
    if (!cols.cost_price) adds.push("ALTER TABLE products ADD COLUMN cost_price REAL NOT NULL DEFAULT 0");
    if (!cols.sell_price) adds.push("ALTER TABLE products ADD COLUMN sell_price REAL NOT NULL DEFAULT 0");
    if (!cols.requires_email_activation) adds.push("ALTER TABLE products ADD COLUMN requires_email_activation INTEGER NOT NULL DEFAULT 0");
    if (!cols.delivery_method) adds.push("ALTER TABLE products ADD COLUMN delivery_method TEXT NOT NULL DEFAULT 'both'");
    if (!cols.image_data) adds.push("ALTER TABLE products ADD COLUMN image_data TEXT NOT NULL DEFAULT ''");
    if (!cols.in_stock) adds.push("ALTER TABLE products ADD COLUMN in_stock INTEGER NOT NULL DEFAULT 1");
    for (var i = 0; i < adds.length; i++) { try { await env.DB.prepare(adds[i]).run(); } catch (e) {} }
    // 新库 sell_price=price_usdt：把仍为 0 的 sell_price 回填为 price_usdt（兼容旧库）
    try { await env.DB.prepare('UPDATE products SET sell_price = price_usdt WHERE sell_price IS NULL OR sell_price = 0').run(); } catch (e) {}
  } catch (e) {}
}
async function ensureUpstreamTables(env) {
  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS upstream_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, prodseller_order_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0, delivered_keys TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY(order_id) REFERENCES orders(id))").run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_upstream_orders_order ON upstream_orders(order_id)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_upstream_orders_psid ON upstream_orders(prodseller_order_id)').run();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS upstream_cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '', fetched_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  } catch (e) {}
  await ensureProductColumns(env);
}
async function checkUpstreamRateLimit(env) {
  // 限速 300/15min：用 admin_meta 存窗口计数（Workers 无进程内共享状态，必须落库）
  try {
    var now = Date.now();
    var win = await getAdminMeta(env, 'upstream_rate_window');
    var cnt = parseInt(await getAdminMeta(env, 'upstream_rate_count') || '0', 10) || 0;
    var winStart = parseInt(win || '0', 10) || 0;
    if (!winStart || now - winStart > 15 * 60 * 1000) { await setAdminMeta(env, 'upstream_rate_window', String(now)); await setAdminMeta(env, 'upstream_rate_count', '1'); return true; }
    if (cnt >= 300) return false;
    await setAdminMeta(env, 'upstream_rate_count', String(cnt + 1));
    return true;
  } catch (e) { return true; }
}
async function prodsellerFetch(env, settings, path, opts) {
  opts = opts || {};
  var base = getProdSellerBase(env, settings);
  var url = String(base).replace(/\/$/, '') + path;
  var headers = { 'content-type': 'application/json', 'X-API-Key': (env && env.PRODSELLER_API_KEY) || '' };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  var res = await getFetch(env)(url, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  var text = '';
  try { text = await res.text(); } catch (e) { text = ''; }
  var data = null; try { data = JSON.parse(text); } catch (e) { data = null; }
  return { status: res.status, ok: res.ok, data: data, text: text };
}
async function prodsellerCreateOrder(env, settings, order, product, customerFields) {
  var body = { productId: product.prodseller_id || product.slug, quantity: order.quantity, email: String(customerFields.contact_email || customerFields.delivery_email || order.contact || '').trim() };
  if (Number(product.requires_email_activation) === 1) {
    body.email = String(customerFields.activation_email || '').trim();
    body.emails = [String(customerFields.activation_email || '').trim()];
  }
  var r = await prodsellerFetch(env, settings, '/orders', { method: 'POST', idempotencyKey: order.order_no, body: body });
  return r;
}
async function prodsellerGetOrder(env, settings, psId) {
  return await prodsellerFetch(env, settings, '/orders/' + encodeURIComponent(psId), { method: 'GET' });
}
function upstreamStatusOf(data) {
  if (!data) return '';
  return String(data.status || data.state || '');
}
function upstreamKeysOf(data) {
  if (!data) return '';
  var k = data.deliveredKey || data.delivered_key || data.key || data.code || '';
  var ks = data.deliveredKeys || data.delivered_keys || data.keys || data.codes || [];
  if (Array.isArray(ks) && ks.length) return ks.join('\n');
  if (k) return String(k);
  return '';
}
function upstreamAmountOf(data) { if (!data) return 0; return Number(data.amount || data.total || data.price || 0) || 0; }
function upstreamDiscountOf(data) { if (!data) return 0; return Number(data.discount || 0) || 0; }
async function upsertUpstreamOrder(env, orderId, psId, status, amount, keys) {
  await ensureUpstreamTables(env);
  var ex = await env.DB.prepare('SELECT id FROM upstream_orders WHERE order_id = ?').bind(orderId).first();
  if (ex) await env.DB.prepare('UPDATE upstream_orders SET prodseller_order_id=?, status=?, amount=?, delivered_keys=? WHERE id=?').bind(psId || '', status || '', Number(amount) || 0, keys || '', ex.id).run();
  else await env.DB.prepare('INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, ?, ?, ?, ?)').bind(orderId, psId || '', status || '', Number(amount) || 0, keys || '').run();
}
// ---- Resend 邮件（Workers 用 fetch，不用 SMTP）----
async function sendEmail(env, to, subject, html) {
  // 邮箱发货已移除：不再发邮件，交付只看站内查单页。
  return { ok: false, skipped: 'email_removed' };
}
function emailHtml(title, lines) {
  var h = '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;padding:20px"><h2>' + esc(title) + '</h2>';
  for (var i = 0; i < lines.length; i++) h += '<p style="line-height:1.7">' + esc(lines[i]) + '</p>';
  h += '<p style="color:#888;font-size:12px">交付内容仅保留 7 天，请及时保存。交付内容仅保留 7 天，请及时保存。</p></div>';
  return h;
}
function orderMailTo(order, customerFields, kind) {
  customerFields = customerFields || {};
  if (kind === 'activation') return String(customerFields.activation_email || customerFields.contact_email || order.contact || '').trim();
  if (kind === 'delivery') return String(customerFields.delivery_email || customerFields.contact_email || order.contact || '').trim();
  return String(customerFields.contact_email || order.contact || '').trim();
}
async function sendOrderEmail(env, order, product, kind, deliveryContent) {
  try {
    var settings = await getAllSettings(env);
    var cf = {}; try { cf = JSON.parse(order.customer_fields || '{}'); } catch (e) { cf = {}; }
    var title = product ? product.title : (JSON.parse(order.product_snapshot || '{}').title || '商品');
    var to = orderMailTo(order, cf, kind);
    if (!to || !validEmail(to)) return { ok: false, skipped: 'no_recipient' };
    var base = '订单号：' + order.order_no + '；查询密码：' + order.query_password + '；商品：' + title + '；金额：' + order.total_usdt + ' USDT';
    if (kind === 'confirm') return await sendEmail(env, to, '【订单确认】' + order.order_no, emailHtml('订单已创建', [base, '请按页面展示的精确金额与收款地址付款，付完不用做任何事，等 1-3 分钟自动发货。']));
    if (kind === 'paid') return await sendEmail(env, to, '【已收款】' + order.order_no, emailHtml('已收到付款', [base, '付款已确认，正在处理发货/代充，请留意站内查单。']));
    if (kind === 'activation') return await sendEmail(env, to, '【激活待处理】' + order.order_no, emailHtml('激活待处理', [base, '该商品需要激活，正在等待激活返回交付内容，ETA ASAP，请不要重复下单。激活完成后站内查单可查看。']));
    if (kind === 'delivered') {
      if (String(settings.delivery_mode || 'both') === 'onsite_only') return { ok: false, skipped: 'onsite_only' };
      var lines = [base, '已发货。交付内容见站内查单页（订单号 + 查询密码），交付数据仅保留 7 天，请及时保存。'];
      if (deliveryContent) lines.push('交付内容：' + deliveryContent);
      return await sendEmail(env, to, '【已发货】' + order.order_no, emailHtml('已发货', lines));
    }
    return { ok: false, skipped: 'unknown_kind' };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
}
function deliverWithCtx(ctx, promise) {
  if (ctx && typeof ctx.waitUntil === 'function') { try { ctx.waitUntil(promise.catch(function () {})); } catch (e) {} return; }
  // 无 ctx（测试/手动路径）时等待完成，保证邮件失败可记录且不阻塞发货主流程（调用方已 catch）
  return promise.catch(function () {});
}
async function pollUpstreamActivations(env, ctx) {
  await ensureUpstreamTables(env);
  var settings = await getAllSettings(env);
  var out = { checked: 0, delivered: 0, retried: 0, still_pending: 0 };
  var rows = await env.DB.prepare("SELECT * FROM orders WHERE status IN ('pending_activation','pending_upstream') ORDER BY id ASC LIMIT 100").all();
  var list = rows.results || [];
  for (var i = 0; i < list.length; i++) {
    var o = list[i];
    try {
      var prod = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(o.product_id).first();
      if (!prod || prod.source !== 'prodseller') continue;
      out.checked++;
      var up = await env.DB.prepare('SELECT * FROM upstream_orders WHERE order_id = ? ORDER BY id DESC LIMIT 1').bind(o.id).first();
      var psId = up ? up.prodseller_order_id : '';
      // pending_upstream 且尚无上游单号（402/429/500 后）：重试下单（Idempotency-Key=order_no 防重复扣费）
      if (!psId) {
        var cf0 = {}; try { cf0 = JSON.parse(o.customer_fields || '{}'); } catch (e) { cf0 = {}; }
        var cr = await prodsellerCreateOrder(env, settings, o, prod, cf0);
        if (cr.status === 402) { await env.DB.prepare('UPDATE orders SET admin_note=? WHERE id=?').bind('上游余额不足（402），待充值后重试，不发货', o.id).run(); out.still_pending++; continue; }
        if (cr.status === 409) { await env.DB.prepare('UPDATE orders SET admin_note=? WHERE id=?').bind('上游缺货（409），已转人工', o.id).run(); out.still_pending++; continue; }
        if (cr.status === 429 || cr.status >= 500 || !cr.ok) { await env.DB.prepare('UPDATE orders SET admin_note=? WHERE id=?').bind('上游重试失败 HTTP ' + cr.status + '，下次轮询继续重试', o.id).run(); out.still_pending++; continue; }
        var st0 = upstreamStatusOf(cr.data);
        var psId0 = (cr.data && (cr.data.id || cr.data.orderId || cr.data.order_id)) || '';
        var keys0 = upstreamKeysOf(cr.data);
        await upsertUpstreamOrder(env, o.id, String(psId0 || ''), st0, upstreamAmountOf(cr.data), keys0);
        if (st0 === 'delivered' && keys0) { var done0 = await env.DB.prepare("UPDATE orders SET status='completed', delivery_content=?, fulfilled_at=? WHERE id=? AND status IN ('pending_activation','pending_upstream')").bind(keys0, nowISO(), o.id).run(); if (done0.meta && done0.meta.changes > 0) { out.delivered++; var fresh0 = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first(); await deliverWithCtx(ctx, sendOrderEmail(env, fresh0, prod, 'delivered', keys0)); } continue; }
        if (st0 === 'paid') { await env.DB.prepare("UPDATE orders SET status='pending_activation' WHERE id=?").bind(o.id).run(); out.still_pending++; continue; }
        out.still_pending++; continue;
      }
      // 已有上游单号：轮询 GET /v1/orders/:id 直到 delivered，deliveredKey 出现前不发
      var g = await prodsellerGetOrder(env, settings, psId);
      if (!g.ok) { out.still_pending++; continue; }
      var st = upstreamStatusOf(g.data);
      var keys = upstreamKeysOf(g.data);
      await upsertUpstreamOrder(env, o.id, psId, st, upstreamAmountOf(g.data), keys);
      if (st === 'delivered' && keys) {
        var done = await env.DB.prepare("UPDATE orders SET status='completed', delivery_content=?, fulfilled_at=? WHERE id=? AND status IN ('pending_activation','pending_upstream')").bind(keys, nowISO(), o.id).run();
        if (done.meta && done.meta.changes > 0) { out.delivered++; var fresh = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first(); await deliverWithCtx(ctx, sendOrderEmail(env, fresh, prod, 'delivered', keys)); }
      } else { out.still_pending++; }
    } catch (e) { out.still_pending++; continue; }
  }
  return { ok: true, poll: out };
}

function parseJsonSafe(s, fallback) { try { return JSON.parse(s || ''); } catch (e) { return fallback; } }
function fmtTsPlusMinutes(min) { return new Date(Date.now() + min * 60000).toISOString().replace('T', ' ').slice(0, 19); }
function amountsEqual(a, b) { return Math.abs(Number(a) - Number(b)) < 0.000001; }
async function genActualAmount(env, baseTotal, payAddress) {
  for (var attempt = 0; attempt < 20; attempt++) {
    var tail = (1 + Math.floor(Math.random() * 99)) / 10000;
    var actual = Math.round((Number(baseTotal) + tail) * 10000) / 10000;
    var clash = await env.DB.prepare("SELECT id FROM orders WHERE pay_address = ? AND ABS(actual_amount - ?) < 0.000001 AND status = 'pending_payment' AND expires_at > datetime('now') LIMIT 1").bind(payAddress, actual).first().catch(function () { return null; });
    if (!clash) return actual;
  }
  // 极小概率 20 次都冲突：用毫秒尾数兜底
  return Math.round((Number(baseTotal) + (Date.now() % 100) / 10000) * 10000) / 10000;
}
function padAddressTopic(addr) { return '0x' + '000000000000000000000000' + String(addr).slice(2).toLowerCase(); }
function toHex(n) { return '0x' + Number(n).toString(16); }
async function rpcCall(fetchFn, rpcUrl, method, params) {
  var res = await fetchFn(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }) });
  if (!res.ok) throw new Error('RPC HTTP ' + res.status);
  var j = await res.json();
  if (j.error) throw new Error('RPC ' + (j.error.message || JSON.stringify(j.error)));
  return j.result;
}
// TRC20：Tronscan token_trc20/transfers，匹配 to + 金额 + token + 时间
async function checkTrc20Payment(fetchFn, payAddress, actualAmount, createdAtISO) {
  var url = 'https://apilist.tronscanapi.com/api/token_trc20/transfers?limit=50&toAddress=' + encodeURIComponent(payAddress);
  var res = await fetchFn(url);
  if (!res.ok) throw new Error('Tronscan HTTP ' + res.status);
  var j = await res.json();
  var list = (j && (j.data || j.token_transfers)) || [];
  if (!Array.isArray(list)) list = [];
  var createdMs = Date.parse(String(createdAtISO).replace(' ', 'T') + 'Z') || 0;
  for (var i = 0; i < list.length; i++) {
    var t = list[i] || {};
    var to = t.to_address || t.toAddress || (t.to && t.to.address) || '';
    if (String(to).toLowerCase() !== String(payAddress).toLowerCase()) continue;
    var info = t.tokenInfo || t.token_info || {};
    var tokenId = info.tokenId || info.token_id || t.tokenId || '';
    var abbr = info.tokenAbbr || info.token_abbr || t.tokenAbbr || '';
    if (tokenId && tokenId !== USDT_TRC20_ID) continue;
    if (abbr && String(abbr).toUpperCase() !== 'USDT') continue;
    var decimals = Number(info.tokenDecimal != null ? info.tokenDecimal : (info.token_decimal != null ? info.token_decimal : 6));
    var quant = Number(t.quant != null ? t.quant : t.value);
    if (!isFinite(quant)) continue;
    var amt = quant / Math.pow(10, decimals);
    if (!amountsEqual(amt, actualAmount)) continue;
    var ts = Number(t.block_ts || t.timestamp || 0);
    if (ts && ts < createdMs - 60000) continue;
    if (t.confirmed === false) continue;
    var hash = t.transactionHash || t.transaction_hash || t.hash || '';
    if (hash) return { txHash: String(hash), amount: amt };
  }
  return null;
}
// EVM/X Layer：eth_getLogs 查 USDT Transfer，至少 1 确认
async function checkEvmPayment(fetchFn, rpcUrls, contract, payAddress, actualAmount) {
  if (!contract || !contract.startsWith('0x')) return null;
  var expected = BigInt(Math.round(Number(actualAmount) * 1000000));
  var toTopic = padAddressTopic(payAddress);
  for (var ri = 0; ri < rpcUrls.length; ri++) {
    try {
      var rpc = rpcUrls[ri];
      var latestHex = await rpcCall(fetchFn, rpc, 'eth_blockNumber', []);
      var latest = parseInt(latestHex, 16);
      if (!isFinite(latest) || latest <= 0) continue;
      var fromBlock = Math.max(0, latest - 200);
      var logs = await rpcCall(fetchFn, rpc, 'eth_getLogs', [{ address: contract, fromBlock: toHex(fromBlock), toBlock: toHex(latest), topics: [TRANSFER_TOPIC0, null, toTopic] }]);
      if (!Array.isArray(logs)) continue;
      for (var i = 0; i < logs.length; i++) {
        var lg = logs[i];
        var topics = lg.topics || [];
        if (topics.length < 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC0) continue;
        if (String(topics[2]).toLowerCase() !== toTopic) continue;
        var blk = parseInt(lg.blockNumber, 16);
        if (isFinite(blk) && blk > latest - 1) continue; // 至少 1 确认
        var val = 0n;
        try { val = BigInt(lg.data || '0x0'); } catch (e) { continue; }
        if (val !== expected) continue;
        if (lg.transactionHash) return { txHash: String(lg.transactionHash), amount: Number(actualAmount) };
      }
    } catch (e) { continue; }
  }
  return null;
}
async function checkChainPayment(env, fetchFn, order) {
  var settings = await getAllSettings(env);
  if (order.pay_chain === 'TRC20') return await checkTrc20Payment(fetchFn, order.pay_address || order.wallet_address, order.actual_amount || order.total_usdt, order.created_at);
  var contracts = parseJsonSafe(settings.usdt_contracts, {});
  var contract = contracts[order.pay_chain] || DEFAULT_USDT_CONTRACTS[order.pay_chain] || '';
  var rpcMap = parseJsonSafe(settings.rpc_urls, {});
  var rpcs = rpcMap[order.pay_chain] || DEFAULT_RPC_URLS[order.pay_chain] || [];
  if (!rpcs.length) return null;
  return await checkEvmPayment(fetchFn, rpcs, contract, order.pay_address || order.wallet_address, order.actual_amount || order.total_usdt);
}
async function checkTxidPayment(env, fetchFn, order, txid) {
  // 按需核验：用户主动提交 TXID 时复用同一链上核验（TRC20 查单笔，EVM 查 receipt 日志）
  var settings = await getAllSettings(env);
  try {
    if (order.pay_chain === 'TRC20') {
      var r = await fetchFn('https://apilist.tronscanapi.com/api/transaction-info?hash=' + encodeURIComponent(txid));
      if (!r.ok) return null;
      var j = await r.json();
      var list = j.tokenTransferInfo ? j.tokenTransferInfo.transfers || [] : (j.data || []);
      var arr = Array.isArray(list) ? list : [j];
      for (var i = 0; i < arr.length; i++) {
        var t = arr[i] || {};
        var to = t.to_address || t.toAddress || '';
        if (String(to).toLowerCase() !== String(order.pay_address || order.wallet_address).toLowerCase()) continue;
        var info = t.tokenInfo || {};
        if (info.tokenId && info.tokenId !== USDT_TRC20_ID) continue;
        var dec = Number(info.tokenDecimal != null ? info.tokenDecimal : 6);
        var amt = Number(t.amount != null ? t.amount : (t.quant != null ? t.quant / Math.pow(10, dec) : NaN));
        if (!isFinite(amt) || !amountsEqual(amt, order.actual_amount || order.total_usdt)) continue;
        if (j.confirmed === false) continue;
        return { txHash: txid, amount: amt };
      }
      return null;
    }
    var contracts = parseJsonSafe(settings.usdt_contracts, {});
    var contract = contracts[order.pay_chain] || DEFAULT_USDT_CONTRACTS[order.pay_chain] || '';
    var rpcMap = parseJsonSafe(settings.rpc_urls, {});
    var rpcs = rpcMap[order.pay_chain] || DEFAULT_RPC_URLS[order.pay_chain] || [];
    var expected = BigInt(Math.round(Number(order.actual_amount || order.total_usdt) * 1000000));
    var toTopic = padAddressTopic(order.pay_address || order.wallet_address);
    for (var ri = 0; ri < rpcs.length; ri++) {
      try {
        var receipt = await rpcCall(fetchFn, rpcs[ri], 'eth_getTransactionReceipt', [txid]);
        if (!receipt || receipt.status !== '0x1') continue;
        var logs = receipt.logs || [];
        for (var li = 0; li < logs.length; li++) {
          var lg = logs[li];
          if (String(lg.address).toLowerCase() !== String(contract).toLowerCase()) continue;
          var topics = lg.topics || [];
          if (topics.length < 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC0) continue;
          if (String(topics[2]).toLowerCase() !== toTopic) continue;
          var val = 0n; try { val = BigInt(lg.data || '0x0'); } catch (e) { continue; }
          if (val === expected) return { txHash: txid, amount: Number(order.actual_amount || order.total_usdt) };
        }
      } catch (e) { continue; }
    }
  } catch (e) { return null; }
  return null;
}
async function fulfillAfterPayment(env, order, txHash, ctx) {
  // 统一发货入口：轮询 / 手动 TXID / 管理员确认收款三条路径复用，禁止三份重复发货逻辑。
  // 幂等：仅 pending_payment 可进入；已 completed/cancelled 直接返回；pending_activation/pending_upstream 走上游轮询。
  await ensureOrderColumns(env);
  await ensureUpstreamTables(env);
  var fresh = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(order.id).first();
  if (!fresh) return { ok: false, reason: '订单不存在' };
  if (fresh.status === 'completed' || fresh.status === 'cancelled') return { ok: false, reason: '订单已被处理' };
  if (fresh.status === 'pending_activation' || fresh.status === 'pending_upstream') return { ok: true, mode: fresh.status };
  if (fresh.status !== 'pending_payment') return { ok: false, reason: '当前状态不可发货' };
  var o = fresh;
  var prod = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(o.product_id).first();
  if (txHash) {
    var dup = await env.DB.prepare('SELECT id FROM orders WHERE tx_hash = ? AND id != ? AND status = ? LIMIT 1').bind(txHash, o.id, 'completed').first();
    if (dup) return { ok: false, reason: 'tx_hash 已用于其他订单' };
  }
  // 先记 paid_at/tx_hash（条件更新抢单，防重复发货）
  await env.DB.prepare('UPDATE orders SET paid_at=?, tx_hash=? WHERE id=? AND status=?').bind(nowISO(), txHash || '', o.id, 'pending_payment').run();
  // ---- 上游商品：调 ProdSeller 拿货 ----
  if (prod && prod.source === 'prodseller') {
    var settings = await getAllSettings(env);
    var cf = {}; try { cf = JSON.parse(o.customer_fields || '{}'); } catch (e) { cf = {}; }
    var cr = await prodsellerCreateOrder(env, settings, o, prod, cf);
    if (cr.status === 402) {
      await env.DB.prepare("UPDATE orders SET status='pending_upstream', admin_note=? WHERE id=?").bind('上游余额不足（402），后台置顶告警，不发货', o.id).run();
      await upsertUpstreamOrder(env, o.id, '', 'insufficient_balance', 0, '');
      return { ok: true, mode: 'pending_upstream', reason: 'insufficient_balance' };
    }
    if (cr.status === 409) {
      await env.DB.prepare("UPDATE orders SET status='pending_upstream', admin_note=? WHERE id=?").bind('上游缺货（409），已标记缺货转人工', o.id).run();
      await upsertUpstreamOrder(env, o.id, '', 'out_of_stock', 0, '');
      return { ok: true, mode: 'pending_upstream', reason: 'out_of_stock' };
    }
    if (cr.status === 429 || cr.status >= 500 || !cr.ok) {
      await env.DB.prepare("UPDATE orders SET status='pending_upstream', admin_note=? WHERE id=?").bind('上游调用失败 HTTP ' + cr.status + '，退避重试，下次轮询继续', o.id).run();
      await upsertUpstreamOrder(env, o.id, '', 'upstream_error', 0, '');
      return { ok: true, mode: 'pending_upstream', reason: 'upstream_error' };
    }
    var st = upstreamStatusOf(cr.data);
    var psId = (cr.data && (cr.data.id || cr.data.orderId || cr.data.order_id)) || '';
    var keys = upstreamKeysOf(cr.data);
    await upsertUpstreamOrder(env, o.id, String(psId || ''), st, upstreamAmountOf(cr.data), keys);
    // discount 仅记日志字段：写入 admin_note（不暴露前端）
    if (cr.data && cr.data.discount != null) { await env.DB.prepare('UPDATE orders SET admin_note=? WHERE id=?').bind('上游订单 ' + String(psId || '') + ' 金额 ' + upstreamAmountOf(cr.data) + ' 折扣 ' + upstreamDiscountOf(cr.data), o.id).run(); }
    if (st === 'delivered' && keys) {
      var up = await env.DB.prepare("UPDATE orders SET status='completed', delivery_content=?, fulfilled_at=? WHERE id=? AND status='pending_payment'").bind(keys, nowISO(), o.id).run();
      if (!up.meta || up.meta.changes === 0) return { ok: false, reason: '订单已被处理' };
      var fresh2 = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first();
      await deliverWithCtx(ctx, sendOrderEmail(env, fresh2, prod, 'delivered', keys));
      return { ok: true, mode: 'completed' };
    }
    if (st === 'paid') {
      await env.DB.prepare("UPDATE orders SET status='pending_activation', admin_note=? WHERE id=?").bind('上游已付款待激活，轮询等待 delivered', o.id).run();
      var fresh3 = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first();
      await deliverWithCtx(ctx, sendOrderEmail(env, fresh3, prod, 'activation', ''));
      return { ok: true, mode: 'pending_activation' };
    }
    // 未知状态：不发货，等轮询
    await env.DB.prepare("UPDATE orders SET status='pending_activation', admin_note=? WHERE id=?").bind('上游返回未知状态 ' + st + '，等待轮询', o.id).run();
    return { ok: true, mode: 'pending_activation' };
  }
  // ---- 自营商品 ----
  var stockType = prod ? prod.stock_type : 'manual';
  var category = prod ? prod.category : 'recharge';
  if (stockType === 'card' || category === 'account') {
    var codes = await assignCards(env, o.id, o.product_id, o.quantity);
    if (!codes) {
      await env.DB.prepare("UPDATE orders SET status='pending_fulfill', admin_note=? WHERE id=? AND status='pending_payment'").bind('out_of_stock: 库存不足待补货', o.id).run();
      return { ok: true, mode: 'out_of_stock' };
    }
    var up2 = await env.DB.prepare("UPDATE orders SET status='completed', delivery_content=?, fulfilled_at=? WHERE id=? AND status='pending_payment'").bind(codes, nowISO(), o.id).run();
    if (!up2.meta || up2.meta.changes === 0) return { ok: false, reason: '订单已被处理' };
    var fresh4 = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first();
    await deliverWithCtx(ctx, sendOrderEmail(env, fresh4, prod, 'delivered', codes));
    return { ok: true, mode: 'completed' };
  }
  var up3 = await env.DB.prepare("UPDATE orders SET status='pending_fulfill', admin_note=? WHERE id=? AND status='pending_payment'").bind('轮询自动核验通过，等待人工代充', o.id).run();
  if (!up3.meta || up3.meta.changes === 0) return { ok: false, reason: '订单已被处理' };
  var fresh5 = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first();
  await deliverWithCtx(ctx, sendOrderEmail(env, fresh5, prod, 'paid', ''));
  return { ok: true, mode: 'pending_fulfill' };
}
async function fulfillOrderByPayment(env, order, txHash, ctx) {
  // 兼容旧名：直接复用 fulfillAfterPayment，不保留第二份发货逻辑
  return await fulfillAfterPayment(env, order, txHash, ctx);
}
async function runPolling(env, fetchFn, ctx) {
  fetchFn = fetchFn || fetch;
  await ensureOrderColumns(env);
  var settings = await getAllSettings(env);
  if (String(settings.poll_enabled || '1') === '0') return { ok: true, skipped: 'poll_disabled', checked: 0, fulfilled: 0, expired: 0 };
  var pending = await env.DB.prepare("SELECT * FROM orders WHERE status='pending_payment' AND pay_method != 'BinanceUID' ORDER BY id ASC LIMIT 100").all();
  var list = pending.results || [];
  if (!list.length) return { ok: true, checked: 0, fulfilled: 0, expired: 0, note: 'no pending, zero RPC' };
  var fulfilled = 0, expired = 0, checked = 0;
  for (var i = 0; i < list.length; i++) {
    var o = list[i];
    try {
      // 超时：释放金额占用
      if (o.expires_at && new Date(String(o.expires_at).replace(' ', 'T') + 'Z') < new Date()) {
        var ex = await env.DB.prepare("UPDATE orders SET status='cancelled', admin_note=? WHERE id=? AND status='pending_payment'").bind('支付超时自动取消（20分钟未到账）', o.id).run();
        if (ex.meta && ex.meta.changes > 0) expired++;
        continue;
      }
      checked++;
      await env.DB.prepare('UPDATE orders SET last_checked_at=? WHERE id=?').bind(nowISO(), o.id).run();
      var hit = null;
      try { hit = await checkChainPayment(env, fetchFn, o); } catch (e) { hit = null; }
      if (hit && hit.txHash) {
        var r = await fulfillOrderByPayment(env, o, hit.txHash, ctx);
        if (r.ok && r.mode === 'completed') fulfilled++;
      }
    } catch (e) { continue; }
  }
  return { ok: true, checked: checked, fulfilled: fulfilled, expired: expired };
}
function sanitizeOrderForPublic(o) {
  if (!o) return null;
  var out = Object.assign({}, o);
  delete out.query_password;
  try { out.product_snapshot = JSON.parse(o.product_snapshot || '{}'); } catch (e) { out.product_snapshot = {}; }
  try { out.customer_fields = JSON.parse(o.customer_fields || '{}'); } catch (e) { out.customer_fields = {}; }
  if (o.data_expired === 1 || isExpired7d(o.fulfilled_at)) {
    out.delivery_content = '';
    out.data_expired = 1;
  }
  return out;
}
// 验证码校验（一次性、5 分钟过期、最多试 3 次）：通过返回 null，不通过返回错误文案
async function verifyCaptcha(env, capId, capCode) {
  await ensureCaptchaTables(env);
  capId = String(capId || '').trim();
  capCode = String(capCode || '').trim().toUpperCase();
  if (!capId || !capCode) return '请填写图形验证码';
  var capRow = await env.DB.prepare('SELECT * FROM captcha_codes WHERE id = ?').bind(capId).first();
  if (!capRow || String(capRow.expires_at) < nowISO()) { if (capRow) { try { await env.DB.prepare('DELETE FROM captcha_codes WHERE id = ?').bind(capId).run(); } catch (e) {} } return '验证码已过期，请刷新后重试'; }
  if (Number(capRow.attempts) >= CAPTCHA_MAX_ATTEMPTS) { try { await env.DB.prepare('DELETE FROM captcha_codes WHERE id = ?').bind(capId).run(); } catch (e) {} return '验证码尝试次数过多，请刷新后重试'; }
  if ((await sha256Hex(capCode)) !== String(capRow.code_hash)) {
    var att = Number(capRow.attempts) + 1;
    if (att >= CAPTCHA_MAX_ATTEMPTS) { try { await env.DB.prepare('DELETE FROM captcha_codes WHERE id = ?').bind(capId).run(); } catch (e) {} return '验证码错误次数过多，请刷新后重试'; }
    try { await env.DB.prepare('UPDATE captcha_codes SET attempts = ? WHERE id = ?').bind(att, capId).run(); } catch (e) {}
    return '验证码错误，请重新输入';
  }
  try { await env.DB.prepare('DELETE FROM captcha_codes WHERE id = ?').bind(capId).run(); } catch (e) {}
  return null;
}
async function cleanupExpired(env) {
  // fulfilled_at 超过 7 天的已完成订单：清空交付数据并标记 data_expired
  await env.DB.prepare("UPDATE orders SET delivery_content = '', data_expired = 1 WHERE status = 'completed' AND data_expired = 0 AND fulfilled_at IS NOT NULL AND fulfilled_at < datetime('now', '-7 days')").run();
  // 清理过期 session
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  return true;
}
async function assignCards(env, orderId, productId, qty) {
  var rows = await env.DB.prepare('SELECT id, code FROM cards WHERE product_id = ? AND is_used = 0 AND is_disabled = 0 ORDER BY id ASC LIMIT ?').bind(productId, qty).all();
  var list = rows.results || [];
  if (list.length < qty) return null;
  var codes = [];
  var claimed = [];
  for (var i = 0; i < list.length; i++) {
    // 原子领取：只有 is_used=0 才能抢到，防并发重复发同一张卡
    var upd = await env.DB.prepare('UPDATE cards SET is_used = 1, order_id = ? WHERE id = ? AND is_used = 0').bind(orderId, list[i].id).run();
    if (upd.meta && upd.meta.changes === 1) { codes.push(list[i].code); claimed.push(list[i].id); }
  }
  if (codes.length < qty) {
    // 部分被抢走：回滚已领取的，不留半截占用
    for (var j = 0; j < claimed.length; j++) {
      await env.DB.prepare('UPDATE cards SET is_used = 0, order_id = NULL WHERE id = ?').bind(claimed[j]).run();
    }
    return null;
  }
  return codes.join('\n');
}
function parseJsonBody(req) {
  return req.json().catch(function () { return {}; });
}
function validPayMethod(m) { return PAY_METHODS.indexOf(m) !== -1; }
function validPayChain(c) { return PAY_CHAINS.indexOf(c) !== -1; }
function validPayCombo(method, chain) {
  if (method === 'BinanceUID') return chain === '站内转账';
  return chain !== '站内转账';
}

async function handleApi(req, env, url, ctx) {
  var path = url.pathname;
  var method = req.method;

  // ---- 公开：配置 ----
  if (path === '/api/config' && method === 'GET') {
    var s = await getAllSettings(env);
    var addresses = {};
    try { addresses = JSON.parse(s.usdt_addresses || '{}'); } catch (e) { addresses = {}; }
    var tutorials = {};
    try { tutorials = JSON.parse(s.pay_tutorials || '{}'); } catch (e) { tutorials = {}; }
    return json({ ok: true, config: {
      site_name: s.site_name || '智选',
      announcement: s.announcement || '',
      order_notice: s.order_notice || '',
      tg_link: s.tg_link || '',
      usdt_addresses: addresses,
      pay_tutorials: tutorials,
      pay_methods: PAY_METHODS,
      pay_chains: PAY_CHAINS,
      cny_rate: Number(s.cny_rate || 7.2) || 7.2
    }});
  }

  // ---- 公开：商品 ----
  if (path === '/api/products' && method === 'GET') {
    var pr = await env.DB.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY sort ASC, id ASC').all();
    await ensureProductColumns(env);
    var cm = await cardStockMap(env);
    var products = (pr.results || []).map(function (p) {
      var f = []; try { f = JSON.parse(p.form_fields || '[]'); } catch (e) { f = []; }
      var eff = getEffectivePrice(p);
      return { id: p.id, slug: p.slug, title: p.title, category: p.category, price_usdt: eff, sell_price: eff, stock_type: p.stock_type, description: p.description, notice: p.notice, form_fields: f, image_emoji: p.image_emoji, image_data: p.image_data || '', sort: p.sort, source: p.source || 'self', prodseller_id: p.prodseller_id || '', requires_email_activation: Number(p.requires_email_activation || 0), delivery_method: p.delivery_method || 'both', in_stock: realInStock(p, cm) };
    });
    return json({ ok: true, products: products });
  }
  var mProd = path.match(/^\/api\/products\/(\d+)$/);
  if (mProd && method === 'GET') {
    var one = await env.DB.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').bind(Number(mProd[1])).first();
    if (!one) return err('商品不存在', 404);
    var ff = []; try { ff = JSON.parse(one.form_fields || '[]'); } catch (e) { ff = []; }
    await ensureProductColumns(env);
    var soldCount = 0;
    try { var soldRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM orders WHERE product_id = ? AND status = 'completed'").bind(Number(mProd[1])).first(); soldCount = Number((soldRow && soldRow.c) || 0); } catch (e) { soldCount = 0; }
    var cm1 = await cardStockMap(env);
    return json({ ok: true, product: { id: one.id, slug: one.slug, title: one.title, category: one.category, price_usdt: getEffectivePrice(one), sell_price: getEffectivePrice(one), stock_type: one.stock_type, description: one.description, notice: one.notice, form_fields: ff, image_emoji: one.image_emoji, image_data: one.image_data || '', source: one.source || 'self', prodseller_id: one.prodseller_id || '', requires_email_activation: Number(one.requires_email_activation || 0), delivery_method: one.delivery_method || 'both', in_stock: realInStock(one, cm1), sold_count: soldCount } });
  }

  // ---- 公开：图形验证码 ----
  if (path === '/api/captcha' && method === 'GET') {
    await ensureCaptchaTables(env);
    try { await env.DB.prepare('DELETE FROM captcha_codes WHERE expires_at < ?').bind(nowISO()).run(); } catch (e) {}
    var code = '';
    for (var i = 0; i < 4; i++) code += CAPTCHA_CHARS[randBelow(CAPTCHA_CHARS.length)];
    var cid = randomHex(16);
    var exp = new Date(Date.now() + CAPTCHA_TTL_MS).toISOString().replace('T', ' ').slice(0, 19);
    await env.DB.prepare('INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)').bind(cid, await sha256Hex(code), exp).run();
    return json({ ok: true, captcha_id: cid, svg: genCaptchaSVG(code) });
  }

  // ---- 公开：下单 ----
  if (path === '/api/orders' && method === 'POST') {
    var body = await parseJsonBody(req);
    var productId = Number(body.product_id || 0);
    var qty = Number(body.quantity || 1);
    if (!productId || qty < 1 || qty > 99 || !Number.isInteger(qty)) return err('商品或数量无效');
    if (!validPayMethod(body.pay_method) || !validPayChain(body.pay_chain) || !validPayCombo(body.pay_method, body.pay_chain)) return err('支付方式或链无效（币安 UID 只能配站内转账）');
    // 人机验证：验证码一次性、5 分钟过期、最多试 3 次
    var capErrOrder = await verifyCaptcha(env, body.captcha_id, body.captcha_code);
    if (capErrOrder) return err(capErrOrder);
    // 同一联系方式只能有一笔待付款订单（只算未过期的；过期订单由 cron 取消，不再占位）
    // 放限流前面：被重复下单挡住的尝试不占限流名额，用户重试始终看到明确的重复提示
    var custEarly = body.customer_fields || {};
    if (typeof custEarly !== 'object') return err('客户字段无效');
    var contactIdentity = String(custEarly.contact_email || body.contact || custEarly.activation_email || '').trim().toLowerCase();
    if (contactIdentity) {
      var pend = await env.DB.prepare("SELECT order_no, contact, customer_fields FROM orders WHERE status = 'pending_payment' AND expires_at > ?").bind(nowISO()).all();
      for (var di = 0; di < (pend.results || []).length; di++) {
        var po = pend.results[di]; var pcf = {}; try { pcf = JSON.parse(po.customer_fields || '{}'); } catch (e) { pcf = {}; }
        var pIdent = String(pcf.contact_email || po.contact || '').trim().toLowerCase();
        if (pIdent && pIdent === contactIdentity) return err('该联系方式已有一笔待付款订单（' + po.order_no + '），请先完成付款或等它超时取消后再下单');
      }
    }
    // 同 IP 限流：10 分钟内最多下单 10 笔，防批量刷单
    var clientIp = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';
    var winStart = new Date(Date.now() - ORDER_RATE_WINDOW_MS).toISOString().replace('T', ' ').slice(0, 19);
    try { await env.DB.prepare('DELETE FROM order_rate WHERE created_at < ?').bind(winStart).run(); } catch (e) {}
    var rc = await env.DB.prepare('SELECT COUNT(*) as c FROM order_rate WHERE ip = ?').bind(clientIp).first();
    if (rc && Number(rc.c) >= ORDER_RATE_LIMIT) return err('下单过于频繁，请 10 分钟后再试');
    try { await env.DB.prepare('INSERT INTO order_rate (ip, created_at) VALUES (?, ?)').bind(clientIp, nowISO()).run(); } catch (e) {}

    await ensureProductColumns(env);
    var prod = await env.DB.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').bind(productId).first();
    if (!prod) return err('商品不存在', 404);
    var fields = []; try { fields = JSON.parse(prod.form_fields || '[]'); } catch (e) { fields = []; }
    var cust = body.customer_fields || {};
    if (typeof cust !== 'object') return err('客户字段无效');
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].required && !String(cust[fields[i].key] || '').trim()) return err('请填写：' + fields[i].label);
    }
    // 三种邮箱校验：contact_email（所有订单）/ delivery_email（邮件发货类）/ activation_email（激活类）
    var contactEmail = String(cust.contact_email || body.contact || '').trim();
    var deliveryEmail = String(cust.delivery_email || '').trim();
    var activationEmail = String(cust.activation_email || '').trim();
    var activationConfirm = String(cust.activation_email_confirm || '').trim();
    if (Number(prod.requires_email_activation) === 1) {
      if (!activationEmail || !validEmail(activationEmail)) return err('请填写正确的激活邮箱 activation_email（这是要开通的邮箱，填错无法开通）');
      if (activationConfirm && activationConfirm !== activationEmail) return err('两次激活邮箱不一致，请重新确认');
      if (!contactEmail) cust.contact_email = activationEmail;
    }
    var dm = prod.delivery_method || 'both';
    if ((dm === 'email' || dm === 'both') && prod.source === 'self' && (prod.stock_type === 'card' || prod.category === 'account')) {
      if (!deliveryEmail || !validEmail(deliveryEmail)) return err('请填写正确的交付邮箱 delivery_email（用于接收卡密/账号）');
    }
    if (!contactEmail || (!validEmail(contactEmail) && contactEmail.indexOf('@') === -1 && !contactEmail)) return err('请填写联系邮箱 contact_email');
    if (contactEmail && contactEmail.indexOf('@') !== -1 && !validEmail(contactEmail)) return err('联系邮箱格式无效');
    if (deliveryEmail && !validEmail(deliveryEmail)) return err('交付邮箱格式无效');
    // 自营卡密/成品号：下单时按真实卡密数拦截，卡不够不让下单，避免付款后卡单
    if (prod.source === 'self' && (prod.stock_type === 'card' || prod.category === 'account')) {
      var avail = await env.DB.prepare('SELECT COUNT(*) as c FROM cards WHERE product_id = ? AND is_used = 0 AND is_disabled = 0').bind(productId).first();
      if (Number((avail && avail.c) || 0) < qty) return err('卡密库存不足，补货中');
    }

    var contact = String(body.contact || cust.contact || '').trim();
    var settings = await getAllSettings(env);
    var addrMap = {}; try { addrMap = JSON.parse(settings.usdt_addresses || '{}'); } catch (e) { addrMap = {}; }
    var wallet = '';
    if (body.pay_method === 'BinanceUID') {
      wallet = String(settings.binance_uid || '').trim();
    } else {
      wallet = addrMap[body.pay_method + '|' + body.pay_chain] || '';
    }
    var orderNo = genOrderNo();
    var qpwd = genQueryPassword();
    var effPrice = getEffectivePrice(prod);
    var total = Math.round(effPrice * qty * 100) / 100;
    await ensureOrderColumns(env);
    var actualAmount = total;
    var expiresAt = fmtTsPlusMinutes(POLL_LOCK_MINUTES);
    if (body.pay_method !== 'BinanceUID') {
      actualAmount = await genActualAmount(env, total, wallet);
    }
    var snapshot = JSON.stringify({ id: prod.id, slug: prod.slug, title: prod.title, category: prod.category, price_usdt: effPrice, source: prod.source || 'self', requires_email_activation: Number(prod.requires_email_activation || 0), delivery_method: prod.delivery_method || 'both' });
    await env.DB.prepare('INSERT INTO orders (order_no, query_password, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(orderNo, qpwd, productId, snapshot, qty, effPrice, total, actualAmount, wallet, expiresAt, JSON.stringify(cust), contact, body.pay_method, body.pay_chain, wallet, 'pending_payment', nowISO()).run();
    // 订单确认邮件（waitUntil，不阻塞下单响应）
    try { var createdOrder = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first(); if (createdOrder) deliverWithCtx(ctx, sendOrderEmail(env, createdOrder, prod, 'confirm', '')); } catch (e) {}
    return json({ ok: true, order: { order_no: orderNo, total_usdt: total, actual_amount: actualAmount, pay_address: wallet, expires_at: expiresAt, wallet_address: wallet, pay_method: body.pay_method, pay_chain: body.pay_chain } });
  }

  // ---- 公开：查单 ----
  // 按邮箱查订单列表
  if (path === '/api/orders' && method === 'GET') {
    var contactQ = String(url.searchParams.get('contact') || '').trim();
    if (!contactQ) return err('请填写邮箱地址');
    var rows = await env.DB.prepare("SELECT * FROM orders WHERE LOWER(contact) = LOWER(?) OR LOWER(json_extract(customer_fields, '$.contact_email')) = LOWER(?) ORDER BY created_at DESC LIMIT 50").bind(contactQ, contactQ).all();
    var list = (rows.results || []).map(function (r) { return sanitizeOrderForPublic(r); });
    return json({ ok: true, orders: list });
  }
  var mOrderNo = path.match(/^\/api\/orders\/([^\/]+)$/);
  if (mOrderNo && method === 'GET') {
    var no = decodeURIComponent(mOrderNo[1]);
    var ord = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(no).first();
    if (!ord) return err('订单不存在', 404);
    return json({ ok: true, order: sanitizeOrderForPublic(ord) });
  }
  var mPay = path.match(/^\/api\/orders\/([^\/]+)\/pay$/);
  if (mPay && method === 'POST') {
    var b = await parseJsonBody(req);
    var txid = String(b.txid || '').trim();
    if (txid.length < 6 || txid.length > 200) return err('TXID / 订单 ID 长度无效（6-200字符）');
    if (!/^[A-Za-z0-9_\-]+$/.test(txid)) return err('仅支持字母数字 _ -');
    var no2 = decodeURIComponent(mPay[1]);
    var o2 = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(no2).first();
    if (!o2) return err('订单不存在', 404);
    if (o2.status !== 'pending_payment') return err('当前状态不可提交 TXID');
    // 币安 UID 站内转账：无链上 TXID，只存内部订单 ID，走手动核对
    if (o2.pay_method === 'BinanceUID') {
      await env.DB.prepare('UPDATE orders SET txid = ?, tx_hash = ? WHERE order_no = ?').bind(txid, txid, no2).run();
      return json({ ok: true, message: '已提交币安订单 ID，请等待管理员核对', auto: false });
    }
    // 链上：可选兜底，按需核验同一 TXID，成功即自动发货
    await ensureOrderColumns(env);
    var hit = null;
    try { hit = await checkTxidPayment(env, fetch, o2, txid); } catch (e) { hit = null; }
    if (hit && hit.txHash) {
      var fr = await fulfillOrderByPayment(env, o2, hit.txHash, ctx);
      if (fr.ok && fr.mode === 'completed') return json({ ok: true, message: '核验通过，已自动发货', auto: true });
      if (fr.ok && fr.mode === 'pending_fulfill') return json({ ok: true, message: '核验通过，已自动派单，等待人工代充', auto: true });
      if (fr.ok && fr.mode === 'out_of_stock') return json({ ok: true, message: '核验通过但库存不足，已转人工处理', auto: true });
    }
    await env.DB.prepare('UPDATE orders SET txid = ? WHERE order_no = ?').bind(txid, no2).run();
    return json({ ok: true, message: 'TXID 已提交，轮询会在 1-3 分钟内自动核验；若链上还未确认请稍后再查', auto: false });
  }

  // ---- 管理员：登录 / 退出 / 改密 ----
  if (path === '/api/admin/login' && method === 'POST') {
    var lb = await parseJsonBody(req);
    var pw = String(lb.password || '');
    if (!pw) return err('请输入密码');
    var storedHash = await getAdminMeta(env, 'password_hash');
    var storedSalt = await getAdminMeta(env, 'password_salt');
    var mustChange = (await getAdminMeta(env, 'must_change_password')) === '1';
    if (!storedHash) {
      if (pw !== 'admin') return err('密码错误', 401);
      mustChange = true;
    } else {
      var h = await hashPassword(pw, storedSalt || '');
      if (h !== storedHash) return err('密码错误', 401);
    }
    var token = randomHex(32);
    var exp = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString().replace('T', ' ').slice(0, 19);
    await env.DB.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').bind(token, exp).run();
    var resp = json({ ok: true, must_change_password: mustChange });
    resp.headers.set('Set-Cookie', 'session_token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_MAX_AGE);
    return resp;
  }
  if (path === '/api/admin/logout' && method === 'POST') {
    var tok = getCookie(req, 'session_token');
    if (tok) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(tok).run();
    var r2 = json({ ok: true });
    r2.headers.set('Set-Cookie', 'session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return r2;
  }
  if (path === '/api/admin/me' && method === 'GET') {
    var sess = await requireAdmin(env, req);
    if (!sess) return err('未登录', 401);
    var mc = (await getAdminMeta(env, 'must_change_password')) === '1';
    var hasHash = !!(await getAdminMeta(env, 'password_hash'));
    return json({ ok: true, must_change_password: mc || !hasHash });
  }
  if (path === '/api/admin/change-password' && method === 'POST') {
    var sess2 = await requireAdmin(env, req);
    if (!sess2) return err('未登录', 401);
    var cb = await parseJsonBody(req);
    var oldPw = String(cb.old_password || '');
    var newPw = String(cb.new_password || '');
    if (newPw.length < 8) return err('新密码至少 8 位');
    var sh = await getAdminMeta(env, 'password_hash');
    var ss = await getAdminMeta(env, 'password_salt');
    if (sh) {
      var hh = await hashPassword(oldPw, ss || '');
      if (hh !== sh) return err('旧密码错误', 401);
    } else if (oldPw !== 'admin') return err('旧密码错误', 401);
    var newSalt = bufToB64(crypto.getRandomValues(new Uint8Array(16)).buffer);
    var newHash = await hashPassword(newPw, newSalt);
    await setAdminMeta(env, 'password_salt', newSalt);
    await setAdminMeta(env, 'password_hash', newHash);
    await setAdminMeta(env, 'must_change_password', '0');
    return json({ ok: true });
  }

  // ---- 管理员：需要登录的接口 ----
  var admin = await requireAdmin(env, req);
  var isAdminPath = path.indexOf('/api/admin/') === 0;
  if (isAdminPath && !admin) return err('未登录', 401);

  if (path === '/api/admin/stats' && method === 'GET') {
    var total = await env.DB.prepare('SELECT COUNT(*) as c FROM orders').first();
    var pp = await env.DB.prepare("SELECT COUNT(*) as c FROM orders WHERE status='pending_payment'").first();
    var pf = await env.DB.prepare("SELECT COUNT(*) as c FROM orders WHERE status='pending_fulfill'").first();
    var comp = await env.DB.prepare("SELECT COUNT(*) as c FROM orders WHERE status='completed'").first();
    var pu = await env.DB.prepare("SELECT COUNT(*) as c FROM orders WHERE status='pending_upstream'").first();
    var pa = await env.DB.prepare("SELECT COUNT(*) as c FROM orders WHERE status='pending_activation'").first();
    var rev = await env.DB.prepare("SELECT COALESCE(SUM(total_usdt),0) as s FROM orders WHERE status='completed'").first();
    var ap = await env.DB.prepare('SELECT COUNT(*) as c FROM products WHERE is_active=1').first();
    var stock = await env.DB.prepare('SELECT COUNT(*) as c FROM cards WHERE is_used=0 AND is_disabled=0').first();
    return json({ ok: true, stats: { total_orders: total.c, pending_payment: pp.c, pending_fulfill: pf.c, pending_upstream: pu.c, pending_activation: pa.c, completed: comp.c, revenue_usdt: rev.s, active_products: ap.c, card_stock: stock.c } });
  }
  if (path === '/api/admin/orders' && method === 'GET') {
    var st = url.searchParams.get('status') || '';
    var q = (url.searchParams.get('q') || '').trim();
    var sql = 'SELECT * FROM orders WHERE 1=1';
    var binds = [];
    if (st && ORDER_STATUSES.indexOf(st) !== -1) { sql += ' AND status = ?'; binds.push(st); }
    if (q) { sql += ' AND (order_no LIKE ? OR contact LIKE ? OR txid LIKE ?)'; binds.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
    sql += ' ORDER BY id DESC LIMIT 200';
    var stmt = env.DB.prepare(sql);
    if (binds.length) stmt = stmt.bind.apply(stmt, binds);
    var orr = await stmt.all();
    var list = (orr.results || []).map(function (x) { return sanitizeOrderForPublic(x); });
    return json({ ok: true, orders: list });
  }
  var mConfirm = path.match(/^\/api\/admin\/orders\/(\d+)\/confirm-payment$/);
  if (mConfirm && method === 'POST') {
    var oid = Number(mConfirm[1]);
    var oo = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(oid).first();
    if (!oo) return err('订单不存在', 404);
    if (oo.status !== 'pending_payment') return err('当前状态不可确认收款');
    // 管理员确认收款复用同一 fulfillAfterPayment：自营卡密自动发，上游商品走 ProdSeller 拿货（不要只发本地卡密）
    var cr2 = await fulfillAfterPayment(env, oo, oo.tx_hash || oo.txid || '', ctx);
    if (!cr2.ok) return err(cr2.reason || '发货失败');
    if (cr2.mode === 'completed') return json({ ok: true, message: '已确认收款并自动发货' });
    if (cr2.mode === 'pending_activation') return json({ ok: true, message: '已确认收款，上游激活待处理（pending_activation），轮询等待 delivered' });
    if (cr2.mode === 'pending_upstream') return json({ ok: true, message: '已确认收款，上游暂不可发货（' + (cr2.reason || '') + '），已转 pending_upstream' });
    if (cr2.mode === 'out_of_stock') return json({ ok: true, message: '已确认收款但库存不足，已转人工处理' });
    return json({ ok: true, message: '已确认收款，等待发货' });
  }
  var mFulfill = path.match(/^\/api\/admin\/orders\/(\d+)\/fulfill$/);
  if (mFulfill && method === 'POST') {
    var fb = await parseJsonBody(req);
    var fid = Number(mFulfill[1]);
    var fo = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(fid).first();
    if (!fo) return err('订单不存在', 404);
    if (fo.status === 'completed' || fo.status === 'cancelled') return err('当前状态不可发货');
    var fp = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(fo.product_id).first();
    var delivery = String(fb.delivery_content || '').trim();
    if (fp && fp.stock_type === 'card' && !delivery) {
      var ac = await assignCards(env, fid, fo.product_id, fo.quantity);
      if (!ac) return err('卡密库存不足，请先导入卡密或手动填写交付内容');
      delivery = ac;
    }
    await env.DB.prepare('UPDATE orders SET status=?, delivery_content=?, admin_note=?, paid_at=COALESCE(paid_at, ?), fulfilled_at=? WHERE id=?').bind('completed', delivery, String(fb.admin_note || ''), nowISO(), nowISO(), fid).run();
    try { var fOrd = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(fid).first(); if (fOrd) await deliverWithCtx(ctx, sendOrderEmail(env, fOrd, fp, 'delivered', delivery)); } catch (e) {}
    return json({ ok: true });
  }
  var mCancel = path.match(/^\/api\/admin\/orders\/(\d+)\/cancel$/);
  if (mCancel && method === 'POST') {
    var cb2 = await parseJsonBody(req);
    var cid = Number(mCancel[1]);
    var co = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(cid).first();
    if (!co) return err('订单不存在', 404);
    if (co.status === 'completed' || co.status === 'cancelled') return err('当前状态不可取消');
    await env.DB.prepare('UPDATE orders SET status=?, admin_note=? WHERE id=?').bind('cancelled', String(cb2.admin_note || ''), cid).run();
    return json({ ok: true });
  }

  // 商品 CRUD（管理员）
  if (path === '/api/admin/products' && method === 'GET') {
    await ensureProductColumns(env);
    var allP = await env.DB.prepare('SELECT * FROM products ORDER BY sort ASC, id ASC').all();
    var cmA = await cardStockMap(env);
    var plist = (allP.results || []).map(function (pp) { pp.card_stock = Number(cmA[String(pp.id)] || 0); return pp; });
    return json({ ok: true, products: plist });
  }
  if (path === '/api/admin/products' && method === 'POST') {
    var pb = await parseJsonBody(req);
    if (!pb.title || !pb.slug) return err('标题与 slug 必填');
    var _sp = Number(pb.sell_price != null ? pb.sell_price : pb.price_usdt);
    if (!isFinite(_sp) || _sp < 0) return err('价格无效');
    if (!validImageData(pb.image_data || '')) return err('图片格式无效（仅支持 JPG/PNG/WebP，压缩后不超过约 500KB）');
    await ensureProductColumns(env);
    await env.DB.prepare('INSERT INTO products (slug, title, category, price_usdt, sell_price, cost_price, source, prodseller_id, requires_email_activation, delivery_method, stock_type, description, notice, form_fields, image_emoji, image_data, sort, is_active, in_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(pb.slug, pb.title, pb.category || 'recharge', _sp, _sp, Number(pb.cost_price || 0), pb.source === 'prodseller' ? 'prodseller' : 'self', String(pb.prodseller_id || ''), pb.requires_email_activation ? 1 : 0, ['onsite','email','both'].indexOf(pb.delivery_method) !== -1 ? pb.delivery_method : 'both', pb.stock_type || 'manual', pb.description || '', pb.notice || '', JSON.stringify(pb.form_fields || []), pb.image_emoji || '🤖', pb.image_data || '', Number(pb.sort || 0), pb.is_active === 0 ? 0 : 1, pb.in_stock === 0 ? 0 : 1).run();
    return json({ ok: true });
  }
  var mAP = path.match(/^\/api\/admin\/products\/(\d+)$/);
  if (mAP && method === 'PUT') {
    var ub = await parseJsonBody(req);
    var pid = Number(mAP[1]);
    await ensureProductColumns(env);
    var oldP = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(pid).first();
    if (!oldP) return err('商品不存在', 404);
    var newImg = (typeof ub.image_data === 'string') ? ub.image_data : (oldP.image_data || '');
    if (!validImageData(newImg)) return err('图片格式无效（仅支持 JPG/PNG/WebP，压缩后不超过约 500KB）');
    var _usp = Number(ub.sell_price != null ? ub.sell_price : ub.price_usdt || 0);
    // in_stock 没传时保留旧值（卡密/上游商品不靠表单控制库存，别把同步值覆盖掉）
    var newInStock = (ub.in_stock == null) ? (oldP.in_stock == null ? 1 : Number(oldP.in_stock)) : (ub.in_stock === 0 ? 0 : 1);
    await env.DB.prepare('UPDATE products SET title=?, category=?, price_usdt=?, sell_price=?, cost_price=?, source=?, prodseller_id=?, requires_email_activation=?, delivery_method=?, stock_type=?, description=?, notice=?, form_fields=?, image_emoji=?, image_data=?, sort=?, is_active=?, in_stock=? WHERE id=?').bind(ub.title || '', ub.category || 'recharge', _usp, _usp, Number(ub.cost_price || 0), ub.source === 'prodseller' ? 'prodseller' : 'self', String(ub.prodseller_id || ''), ub.requires_email_activation ? 1 : 0, ['onsite','email','both'].indexOf(ub.delivery_method) !== -1 ? ub.delivery_method : 'both', ub.stock_type || 'manual', ub.description || '', ub.notice || '', JSON.stringify(ub.form_fields || []), ub.image_emoji || '🤖', newImg, Number(ub.sort || 0), ub.is_active === 0 ? 0 : 1, newInStock, pid).run();
    return json({ ok: true });
  }
  if (mAP && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(Number(mAP[1])).run();
    return json({ ok: true });
  }

  // 卡密
  if (path === '/api/admin/cards' && method === 'GET') {
    var cpid = url.searchParams.get('product_id');
    var csql = 'SELECT * FROM cards ORDER BY id DESC LIMIT 500';
    var cstmt = env.DB.prepare(csql);
    if (cpid) cstmt = env.DB.prepare('SELECT * FROM cards WHERE product_id = ? ORDER BY id DESC LIMIT 500').bind(Number(cpid));
    var cr = await cstmt.all();
    return json({ ok: true, cards: cr.results || [] });
  }
  if (path === '/api/admin/cards/import' && method === 'POST') {
    var ib = await parseJsonBody(req);
    var iPid = Number(ib.product_id || 0);
    var raw = String(ib.codes || '');
    var lines = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
    if (!iPid || !lines.length) return err('商品与卡密不能为空');
    var added = 0;
    for (var k = 0; k < lines.length; k++) {
      try { await env.DB.prepare('INSERT OR IGNORE INTO cards (product_id, code) VALUES (?, ?)').bind(iPid, lines[k]).run(); added++; } catch (e) {}
    }
    return json({ ok: true, imported: added });
  }
  var mCardDis = path.match(/^\/api\/admin\/cards\/(\d+)\/disable$/);
  if (mCardDis && method === 'POST') {
    var db2 = await parseJsonBody(req);
    await env.DB.prepare('UPDATE cards SET is_disabled = ? WHERE id = ?').bind(db2.disabled ? 1 : 0, Number(mCardDis[1])).run();
    return json({ ok: true });
  }
  var mCardDel = path.match(/^\/api\/admin\/cards\/(\d+)$/);
  if (mCardDel && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(Number(mCardDel[1])).run();
    return json({ ok: true });
  }

  // ---- 上游 ProdSeller 管理 ----
  if (path === '/api/admin/upstream/sync' && method === 'POST') {
    await ensureUpstreamTables(env);
    var okRate = await checkUpstreamRateLimit(env);
    if (!okRate) return err('上游限速：15 分钟内已达 300 次，请稍后再试', 429);
    var settingsU = await getAllSettings(env);
    var r = await prodsellerFetch(env, settingsU, '/products', { method: 'GET' });
    if (!r.ok) return err('上游拉取失败 HTTP ' + r.status, 502);
    await env.DB.prepare('INSERT INTO upstream_cache (key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at').bind('products', JSON.stringify(r.data || {}), nowISO()).run();
    var cnt = Array.isArray(r.data) ? r.data.length : (r.data && Array.isArray(r.data.products) ? r.data.products.length : 0);
    return json({ ok: true, count: cnt, fetched_at: nowISO() });
  }
  if (path === '/api/admin/upstream/cache' && method === 'GET') {
    await ensureUpstreamTables(env);
    var c = await env.DB.prepare("SELECT * FROM upstream_cache WHERE key='products'").first();
    if (!c) return json({ ok: true, cached: false });
    var payload = null; try { payload = JSON.parse(c.payload || '{}'); } catch (e) { payload = null; }
    return json({ ok: true, cached: true, fetched_at: c.fetched_at, payload: payload });
  }
  if (path === '/api/admin/upstream/balance' && method === 'GET') {
    var settingsB = await getAllSettings(env);
    var br = await prodsellerFetch(env, settingsB, '/balance', { method: 'GET' });
    if (!br.ok) return err('上游余额查询失败 HTTP ' + br.status, 502);
    return json({ ok: true, balance: br.data });
  }
  if (path === '/api/admin/upstream/import' && method === 'POST') {
    await ensureUpstreamTables(env);
    var ib2 = await parseJsonBody(req);
    var settingsI = await getAllSettings(env);
    var markup = Number(settingsI.upstream_markup || '1.2'); if (!isFinite(markup) || markup <= 0) markup = 1.2;
    var fixed = Number(settingsI.upstream_fixed || '0'); if (!isFinite(fixed)) fixed = 0;
    var c2 = await env.DB.prepare("SELECT * FROM upstream_cache WHERE key='products'").first();
    if (!c2) return err('请先执行上游同步（sync），import 只从缓存读，不直接拉上游');
    var payload2 = null; try { payload2 = JSON.parse(c2.payload || '{}'); } catch (e) { payload2 = null; }
    var arr = Array.isArray(payload2) ? payload2 : (payload2 && Array.isArray(payload2.products) ? payload2.products : []);
    var wanted = ib2.items || ib2.ids || [];
    if (!Array.isArray(wanted) || !wanted.length) return err('请选择要导入的上游商品');
    var imported = 0;
    for (var ui = 0; ui < wanted.length; ui++) {
      var sel = wanted[ui];
      var up = null;
      for (var uj = 0; uj < arr.length; uj++) { var cand = arr[uj] || {}; if (String(cand.id) === String(sel.id != null ? sel.id : sel) || String(cand.slug) === String(sel.slug || '')) { up = cand; break; } }
      if (!up) continue;
      var cost = Number(up.cost || up.cost_price || up.price || 0) || 0;
      var sell = Math.round((cost * markup + fixed) * 100) / 100;
      var slug = 'ps-' + String(up.id || up.slug || ('u' + ui)).toLowerCase().replace(/[^a-z0-9\-]+/g, '-');
      var title = up.title || up.name || ('上游商品 ' + String(up.id || ''));
      var reqAct = (up.requiresEmailActivation === true || up.requires_email_activation === true || up.activation === true) ? 1 : 0;
      var inSt = (up.inStock === false || up.in_stock === 0) ? 0 : 1;
      try {
        // 冲突时不覆盖 title/description：标题与简介已人工翻译为中文，重新导入只更新价格/库存等
        await env.DB.prepare('INSERT INTO products (slug, title, category, price_usdt, sell_price, cost_price, source, prodseller_id, requires_email_activation, delivery_method, stock_type, description, notice, form_fields, image_emoji, sort, is_active, in_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET price_usdt=excluded.price_usdt, sell_price=excluded.sell_price, cost_price=excluded.cost_price, prodseller_id=excluded.prodseller_id, requires_email_activation=excluded.requires_email_activation, in_stock=excluded.in_stock').bind(slug, title, 'recharge', sell, sell, cost, 'prodseller', String(up.id || ''), reqAct, 'both', 'manual', String(up.description || ''), '', '[]', '📦', 0, 1, inSt).run();
        imported++;
      } catch (e) {}
    }
    return json({ ok: true, imported: imported, markup: markup, fixed: fixed });
  }
  if (path === '/api/admin/upstream/orders' && method === 'GET') {
    await ensureUpstreamTables(env);
    var uo = await env.DB.prepare('SELECT * FROM upstream_orders ORDER BY id DESC LIMIT 200').all();
    return json({ ok: true, upstream_orders: uo.results || [] });
  }
  if (path === '/api/admin/upstream/alerts' && method === 'GET') {
    // 后台置顶告警：pending_upstream 订单（402 余额不足 / 409 缺货 / 上游错误）
    var al = await env.DB.prepare("SELECT * FROM orders WHERE status='pending_upstream' ORDER BY id ASC LIMIT 100").all();
    return json({ ok: true, alerts: al.results || [] });
  }
  var mUpRetry = path.match(/^\/api\/admin\/upstream\/orders\/(\d+)\/retry$/);
  if (mUpRetry && method === 'POST') {
    await ensureUpstreamTables(env);
    var rOrd = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(Number(mUpRetry[1])).first();
    if (!rOrd) return err('订单不存在', 404);
    var pollRes = await pollUpstreamActivations(env, ctx);
    return json({ ok: true, poll: pollRes.poll || pollRes });
  }

  // 设置
  if (path === '/api/admin/settings' && method === 'GET') {
    return json({ ok: true, settings: await getAllSettings(env) });
  }
  if (path === '/api/admin/settings' && method === 'POST') {
    var sb = await parseJsonBody(req);
    var entries = sb.settings || {};
    if (sb.key) entries[sb.key] = sb.value;
    var keys = Object.keys(entries);
    for (var si = 0; si < keys.length; si++) {
      await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(keys[si], String(entries[keys[si]] == null ? '' : entries[keys[si]])).run();
    }
    return json({ ok: true });
  }
  if (path === '/api/admin/cleanup' && method === 'POST') {
    await cleanupExpired(env);
    return json({ ok: true, message: '7天清理已执行' });
  }
  return err('接口不存在', 404);
}

import FRONTEND_HTML from './frontend.html';

export default {
  async fetch(req, env, ctx) {
    var url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(FRONTEND_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (url.pathname.indexOf('/api/') === 0) {
      try { return await handleApi(req, env, url, ctx); } catch (e) { return err('服务器错误：' + (e && e.message ? e.message : String(e)), 500); }
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) {
    var cron = (event && event.cron) || '';
    if (cron === '*/1 * * * *') { ctx.waitUntil((async function () { await runPolling(env, fetch, ctx); await pollUpstreamActivations(env, ctx); })()); return; }
    if (cron === '0 2 * * *') { ctx.waitUntil((async function () { await cleanupExpired(env); await pollUpstreamActivations(env, ctx); })()); return; }
    // 无 event.cron 时按时间判断：UTC 02:00 跑清理，否则跑轮询（两者都顺带跑上游激活轮询）
    var d = new Date();
    if (d.getUTCHours() === 2 && d.getUTCMinutes() === 0) { ctx.waitUntil((async function () { await cleanupExpired(env); await pollUpstreamActivations(env, ctx); })()); }
    else { ctx.waitUntil((async function () { await runPolling(env, fetch, ctx); await pollUpstreamActivations(env, ctx); })()); }
  }
};
