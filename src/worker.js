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
var ORDER_STATUSES = ['pending_payment', 'pending_fulfill', 'pending_activation', 'pending_upstream', 'refund_pending', 'completed', 'cancelled'];
// refund_pending：已付款但无法交付，管理员已标记退款待处理（本系统不执行真实退款，须在系统外退款后点“确认已退款”）。
// 订单认领租约：认领后处理者崩溃，超过租约后其他请求可接管恢复（claim_token + claimed_at 实现原子认领，不单独设 processing 状态）。
var CLAIM_LEASE_MINUTES = 5;
var LOOKUP_RATE_LIMIT = 30; // 公开查单：同一 IP 每 10 分钟最多 30 次，防枚举与滥用
var LOOKUP_RATE_WINDOW_MS = 10 * 60 * 1000;
var PRODSELLER_DEFAULT_BASE = 'https://prodseller.com/v1';
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validEmail(s){ return EMAIL_RE.test(String(s||'').trim()); }
// 第七轮：旧默认联系方式字段 { key:'contact', label:'联系方式（邮箱/TG）', required:true } 已废弃。
// 前台不再渲染、后端不再强制必填。仅按 key + label 精确匹配，避免误删管理员自定义字段。
function isLegacyContactField(f){ return !!f && f.key === 'contact' && f.label === '联系方式（邮箱/TG）'; }
function getFetch(env){ return (env && env.__fetch) ? env.__fetch : fetch; }
function getProdSellerBase(env, settings){ return (env && env.PRODSELLER_BASE_URL) || (settings && settings.prodseller_base_url) || PRODSELLER_DEFAULT_BASE; }
function getEffectivePrice(prod){ var sp = Number(prod && prod.sell_price); if (isFinite(sp) && sp > 0) return sp; return Number(prod ? prod.price_usdt : 0) || 0; }
async function cardStockMap(env){
  var m = {};
  try {
    // 可用库存 = 未用 + 未禁用 + 未被任何订单预留（预留卡不再算可用，防超卖）
    var r = await env.DB.prepare('SELECT product_id, COUNT(*) as c FROM cards WHERE is_used = 0 AND is_disabled = 0 AND reserved_order_id IS NULL GROUP BY product_id').all();
    for (var i = 0; i < (r.results || []).length; i++){ m[String(r.results[i].product_id)] = Number(r.results[i].c) || 0; }
  } catch (e) {}
  return m;
}
// 管理后台卡密统计：可用 / 预留 / 已用 / 禁用（用于卡密页与商品库存展示）
async function cardStatsMap(env){
  var m = {};
  try {
    var r = await env.DB.prepare("SELECT product_id, SUM(CASE WHEN is_used=0 AND is_disabled=0 AND reserved_order_id IS NULL THEN 1 ELSE 0 END) AS avail, SUM(CASE WHEN is_used=0 AND is_disabled=0 AND reserved_order_id IS NOT NULL THEN 1 ELSE 0 END) AS reserved, SUM(CASE WHEN is_used=1 THEN 1 ELSE 0 END) AS used, SUM(CASE WHEN is_disabled=1 THEN 1 ELSE 0 END) AS disabled FROM cards GROUP BY product_id").all();
    for (var i = 0; i < (r.results || []).length; i++){
      var row = r.results[i];
      m[String(row.product_id)] = { avail: Number(row.avail) || 0, reserved: Number(row.reserved) || 0, used: Number(row.used) || 0, disabled: Number(row.disabled) || 0 };
    }
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
// ---- 第四轮（Release Readiness）新增常量 ----
// 各链确认数策略（可经 settings.chain_confirmations 以 JSON 覆盖）：未达确认数不入账、不履约，防链重组导致已发货但付款失效。
// X Layer 出块快且重组概率低，1 确认；ERC20 12 确认（约 2.5 分钟）；BEP20 15 确认（约 45 秒）；TRC20 19 确认（约 1 分钟）。
var DEFAULT_CHAIN_CONFIRMATIONS = { 'X Layer': 1, 'ERC20': 12, 'BEP20': 15, 'TRC20': 19 };
// /pay 独立限流：同一订单 10 分钟最多 5 次提交；同一 IP 10 分钟最多 20 次提交。受限不影响后台轮询继续处理。
var PAY_RATE_PER_ORDER = 5;
var PAY_RATE_PER_IP = 20;
var PAY_RATE_WINDOW_MS = 10 * 60 * 1000;
// 登录全局限流（防换 IP 分布式暴力破解）：全站 15 分钟内失败超 30 次时，全部登录拒绝 5 分钟。
var LOGIN_GLOBAL_MAX_FAIL = 30;
var LOGIN_GLOBAL_WINDOW_MS = 15 * 60 * 1000;
var LOGIN_GLOBAL_BLOCK_MS = 5 * 60 * 1000;
// EVM 扫描分页：每次 eth_getLogs 最多覆盖的区块数，避免单次 RPC 超时。
var EVM_SCAN_PAGE_BLOCKS = 1000;
// Tronscan 分页：每页 50 笔，最多页数（评估见 RELEASE_READINESS；命中上限时记警告，不得静默漏账）。
var TRONSCAN_MAX_PAGES = 20;
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
// genQueryPassword 已删除：新订单不再生成明文六位查询密码（query_password 写空值），旧订单兼容路径保留。

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
// ---- 数据库版本化迁移（第二轮重构）----
// 原则：迁移只在版本落后时执行一次，不在每次 API 请求中跑完整 PRAGMA/DDL/数据修复。
// 每个迁移幂等（先查列是否存在再 ALTER，CREATE 用 IF NOT EXISTS，数据修复用条件 UPDATE），失败不标记版本，下次重试。
// 新库直接用 schema.sql（已含全部列/表，且预置全部迁移版本），不跑迁移；旧库由 runMigrations 按版本递进升级。
async function addColumnIfMissing(env, table, colDef) {
  var colName = String(colDef).split(' ')[0];
  var info = await env.DB.prepare('PRAGMA table_info(' + table + ')').all();
  var exists = false;
  (info.results || []).forEach(function (r) { if (r.name === colName) exists = true; });
  if (!exists) await env.DB.prepare('ALTER TABLE ' + table + ' ADD COLUMN ' + colDef).run();
}
async function createTableIfMissing(env, sql) { await env.DB.prepare(sql).run(); }
async function createIndexIfMissing(env, sql) { await env.DB.prepare(sql).run(); }
// ---- 基表（第六轮修复：真正空库迁移）----
// 修复：runMigrations 原先假设基表已存在，真正空库（无 schema.sql 预导入）首次请求时 v1 的
// addColumnIfMissing 对不存在的 orders 表做 ALTER，直接 500。新库必须先建基表再跑 v1–v8。
// BASE_TABLES 与 schema.sql 的 6 张基表定义保持一致（终态列）；v1–v8 的 addColumnIfMissing 会跳过已存在列，
// 各版本 createTableIfMissing 会建其余表。基表定义变更时必须同步修改 schema.sql 与此处。
var BASE_TABLES = [
  "CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'recharge', price_usdt REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'self', prodseller_id TEXT NOT NULL DEFAULT '', cost_price REAL NOT NULL DEFAULT 0, sell_price REAL NOT NULL DEFAULT 0, requires_email_activation INTEGER NOT NULL DEFAULT 0, delivery_method TEXT NOT NULL DEFAULT 'both', stock_type TEXT NOT NULL DEFAULT 'manual', description TEXT NOT NULL DEFAULT '', notice TEXT NOT NULL DEFAULT '', form_fields TEXT NOT NULL DEFAULT '[]', image_emoji TEXT NOT NULL DEFAULT 'box', image_data TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, in_stock INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS cards (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, code TEXT NOT NULL, is_used INTEGER NOT NULL DEFAULT 0, is_disabled INTEGER NOT NULL DEFAULT 0, order_id INTEGER, reserved_order_id INTEGER, reserved_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(product_id, code), FOREIGN KEY(product_id) REFERENCES products(id))",
  "CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT UNIQUE NOT NULL, query_password TEXT NOT NULL, query_token_hash TEXT NOT NULL DEFAULT '', claim_token TEXT NOT NULL DEFAULT '', claimed_at TEXT, exception_reason TEXT NOT NULL DEFAULT '', refund_status TEXT NOT NULL DEFAULT '', refund_ref TEXT NOT NULL DEFAULT '', upstream_lock TEXT NOT NULL DEFAULT '', upstream_lock_expires_at TEXT, product_id INTEGER NOT NULL, product_snapshot TEXT NOT NULL DEFAULT '{}', quantity INTEGER NOT NULL DEFAULT 1, price_usdt REAL NOT NULL DEFAULT 0, total_usdt REAL NOT NULL DEFAULT 0, actual_amount REAL NOT NULL DEFAULT 0, pay_address TEXT NOT NULL DEFAULT '', expires_at TEXT, last_checked_at TEXT, tx_hash TEXT NOT NULL DEFAULT '', customer_fields TEXT NOT NULL DEFAULT '{}', contact TEXT NOT NULL DEFAULT '', pay_method TEXT NOT NULL DEFAULT '', pay_chain TEXT NOT NULL DEFAULT '', wallet_address TEXT NOT NULL DEFAULT '', txid TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending_payment', delivery_content TEXT NOT NULL DEFAULT '', admin_note TEXT NOT NULL DEFAULT '', data_expired INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT, fulfilled_at TEXT, FOREIGN KEY(product_id) REFERENCES products(id))",
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')",
  "CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')",
  "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL)"
];
var MIGRATIONS = [
  { version: 1, name: '订单轮询字段', up: async function (env) {
    await addColumnIfMissing(env, 'orders', "actual_amount REAL NOT NULL DEFAULT 0");
    await addColumnIfMissing(env, 'orders', "pay_address TEXT NOT NULL DEFAULT ''");
    await addColumnIfMissing(env, 'orders', "expires_at TEXT");
    await addColumnIfMissing(env, 'orders', "last_checked_at TEXT");
    await addColumnIfMissing(env, 'orders', "tx_hash TEXT NOT NULL DEFAULT ''");
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_orders_actual ON orders(pay_address, actual_amount, status)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_orders_txhash ON orders(tx_hash)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_orders_expires ON orders(status, expires_at)');
  } },
  { version: 2, name: '商品上游字段', up: async function (env) {
    await addColumnIfMissing(env, 'products', "source TEXT NOT NULL DEFAULT 'self'");
    await addColumnIfMissing(env, 'products', "prodseller_id TEXT NOT NULL DEFAULT ''");
    await addColumnIfMissing(env, 'products', "cost_price REAL NOT NULL DEFAULT 0");
    await addColumnIfMissing(env, 'products', "sell_price REAL NOT NULL DEFAULT 0");
    await addColumnIfMissing(env, 'products', "requires_email_activation INTEGER NOT NULL DEFAULT 0");
    await addColumnIfMissing(env, 'products', "delivery_method TEXT NOT NULL DEFAULT 'both'");
    await addColumnIfMissing(env, 'products', "image_data TEXT NOT NULL DEFAULT ''");
    await addColumnIfMissing(env, 'products', "in_stock INTEGER NOT NULL DEFAULT 1");
    // 兼容旧库：sell_price 仍为 0 时回填为 price_usdt（条件 UPDATE，幂等）
    await env.DB.prepare('UPDATE products SET sell_price = price_usdt WHERE sell_price IS NULL OR sell_price = 0').run();
  } },
  { version: 3, name: '上游订单与缓存表', up: async function (env) {
    await createTableIfMissing(env, "CREATE TABLE IF NOT EXISTS upstream_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, prodseller_order_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0, delivered_keys TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY(order_id) REFERENCES orders(id))");
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_upstream_orders_order ON upstream_orders(order_id)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_upstream_orders_psid ON upstream_orders(prodseller_order_id)');
    await createTableIfMissing(env, "CREATE TABLE IF NOT EXISTS upstream_cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '', fetched_at TEXT NOT NULL DEFAULT (datetime('now')))");
  } },
  { version: 4, name: '第一轮安全加固', up: async function (env) {
    await addColumnIfMissing(env, 'orders', "query_token_hash TEXT NOT NULL DEFAULT ''");
    await addColumnIfMissing(env, 'cards', "reserved_order_id INTEGER");
    await addColumnIfMissing(env, 'cards', "reserved_at TEXT");
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_cards_reserved ON cards(reserved_order_id)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_cards_avail ON cards(product_id, is_used, is_disabled, reserved_order_id)');
    await createTableIfMissing(env, "CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, action TEXT NOT NULL DEFAULT '', before_status TEXT NOT NULL DEFAULT '', after_status TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_audit_order ON admin_audit(order_id)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit(created_at)');
    await createTableIfMissing(env, "CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, blocked_until TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    // 数据修复（条件 UPDATE，幂等）：category=account 的自营商品必须走卡密自动发
    await env.DB.prepare("UPDATE products SET stock_type='card' WHERE category='account' AND source='self' AND stock_type <> 'card'").run();
  } },
  { version: 5, name: '验证码与下单限流表', up: async function (env) {
    await createTableIfMissing(env, 'CREATE TABLE IF NOT EXISTS captcha_codes (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)');
    await createTableIfMissing(env, 'CREATE TABLE IF NOT EXISTS order_rate (ip TEXT NOT NULL, created_at TEXT NOT NULL)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_order_rate_ip ON order_rate(ip, created_at)');
  } },
  { version: 6, name: '第二轮：订单认领/TXID认领/异常退款/查单限流', up: async function (env) {
    // 订单认领：claim_token（认领者令牌）+ claimed_at（认领时间，租约起点）。认领后处理者崩溃，超租约可被接管。
    await addColumnIfMissing(env, 'orders', "claim_token TEXT NOT NULL DEFAULT ''");
    await addColumnIfMissing(env, 'orders', "claimed_at TEXT");
    // 异常与退款：exception_reason（异常原因）+ refund_status（''/pending/refunded）+ refund_ref（系统外退款凭证）。
    await addColumnIfMissing(env, 'orders', "exception_reason TEXT NOT NULL DEFAULT ''");
    await addColumnIfMissing(env, 'orders', "refund_status TEXT NOT NULL DEFAULT ''");
    await addColumnIfMissing(env, 'orders', "refund_ref TEXT NOT NULL DEFAULT ''");
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_orders_claim ON orders(claim_token)');
    // TXID 原子认领：tx_hash 主键，同一笔已验证交易只能被一个订单认领（永久有效，防跨订单重复使用）。
    await createTableIfMissing(env, "CREATE TABLE IF NOT EXISTS txid_claims (tx_hash TEXT PRIMARY KEY, order_id INTEGER NOT NULL, claimed_at TEXT NOT NULL DEFAULT (datetime('now')))");
    // 公开查单限流：按 IP 记查单次数
    await createTableIfMissing(env, 'CREATE TABLE IF NOT EXISTS lookup_rate (ip TEXT NOT NULL, created_at TEXT NOT NULL)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_lookup_rate_ip ON lookup_rate(ip, created_at)');
  } },
  { version: 7, name: '第二轮补：上游轮询租约 + upstream_orders 唯一性', up: async function (env) {
    // 上游轮询租约：Cron 与管理员重试同时执行时，只能一个处理者持有某订单的租约。
    // upstream_lock（持有者令牌）+ upstream_lock_expires_at（过期时间，崩溃后超时可接管）。
    await addColumnIfMissing(env, 'orders', "upstream_lock TEXT NOT NULL DEFAULT ''");
    await addColumnIfMissing(env, 'orders', "upstream_lock_expires_at TEXT");
    // upstream_orders.order_id 唯一性：先去重（保留每个 order_id 的最新行，与代码 ORDER BY id DESC LIMIT 1 读取口径一致），再建唯一索引。
    // 去重是幂等的（第二次执行删 0 行）；唯一索引建好后 upsert 用 SQLite UPSERT 原子写入，并发不再产生重复行。
    await env.DB.prepare('DELETE FROM upstream_orders WHERE id NOT IN (SELECT MAX(id) FROM upstream_orders GROUP BY order_id)').run();
    await env.DB.prepare('DROP INDEX IF EXISTS idx_upstream_orders_order').run();
    await createIndexIfMissing(env, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_orders_order_unique ON upstream_orders(order_id)');
  } },
  { version: 8, name: '第四轮：付款账本 + 扫描游标 + /pay 限流 + 金额/联系人唯一性', up: async function (env) {
    // 付款账本 payments：独立记录每一笔链上付款事件（提交/发现/核验/确认/入账/异常），与订单分离。
    // 唯一键 (chain, tx_hash, event_key)：同一链上事件（同一交易内同一笔转账）只能入账一次，防重复轮询/并发重复入账。
    // event_key：EVM 为日志索引（logIndex），TRC20 为区块时间:金额（区分同交易内多笔转账）；/pay 提交时未知先为空，核验后回填。
    // order_id 不唯一：同一订单可有多笔付款（重复付款/部分付款/超额付款各留独立记录）。
    await createTableIfMissing(env, "CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, chain TEXT NOT NULL DEFAULT '', asset TEXT NOT NULL DEFAULT 'USDT', pay_address TEXT NOT NULL DEFAULT '', tx_hash TEXT NOT NULL DEFAULT '', event_key TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0, amount_unit TEXT NOT NULL DEFAULT 'USDT', block_number INTEGER, confirmations INTEGER NOT NULL DEFAULT 0, first_seen_at TEXT NOT NULL DEFAULT (datetime('now')), status TEXT NOT NULL DEFAULT 'submitted', reconcile_status TEXT NOT NULL DEFAULT '', reconcile_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    await createIndexIfMissing(env, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_event_unique ON payments(chain, tx_hash, event_key)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_payments_txhash ON payments(tx_hash)');
    // 链上扫描游标：每链已扫描到的区块高度，持久化；RPC 失败不推进，重启可恢复。
    await createTableIfMissing(env, "CREATE TABLE IF NOT EXISTS scan_cursors (chain TEXT PRIMARY KEY, last_block INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    // /pay 独立限流：key 为 order:<订单号> 或 ip:<IP>，计数窗口内条数即提交次数。
    await createTableIfMissing(env, 'CREATE TABLE IF NOT EXISTS pay_rate (key TEXT NOT NULL, created_at TEXT NOT NULL)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_pay_rate_key ON pay_rate(key, created_at)');
    // 金额唯一性：部分唯一索引，仅约束待付款订单。过期未取消的待付款订单仍占位（轮询 1 分钟内自动取消后释放），
    // 冲突时下单流程捕获唯一约束错误并重新生成金额，不得静默复用。
    // 若已有重复待付款金额，建索引会失败，迁移不标记版本，需先手动处理重复订单（见 RELEASE_READINESS 预检）。
    await createIndexIfMissing(env, "CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_amount_claim ON orders(pay_address, actual_amount) WHERE status = 'pending_payment'");
    // 同联系方式去重原子化：部分唯一索引，仅约束待付款且 contact 非空的订单。同一联系方式 + 同一商品只能有一笔待付款订单，
    // 与下单时的 SELECT 查重逻辑一致，但由数据库原子保证，消除 TOCTOU 窗口。
    await createIndexIfMissing(env, "CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_contact_pending ON orders(contact, product_id) WHERE status = 'pending_payment' AND contact != ''");
  } },
  { version: 9, name: '第六轮：金额唯一索引排除 BinanceUID', up: async function (env) {
    // BinanceUID 订单无链上地址（pay_address=''）且金额=总价无随机尾数，v8 的部分唯一索引
    // (pay_address, actual_amount) WHERE status='pending_payment' 会把所有同金额待付款
    // BinanceUID 订单误判为金额冲突，下单代码对 BinanceUID 唯一冲突直接 throw，导致 500。
    // BinanceUID 走管理员手动核对，不靠链上 (地址,金额) 匹配，故从索引条件中排除。
    // 旧索引约束更严（已包含 BinanceUID），数据一定满足新条件，DROP 后重建不会失败。
    await env.DB.prepare('DROP INDEX IF EXISTS idx_orders_amount_claim').run();
    await createIndexIfMissing(env, "CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_amount_claim ON orders(pay_address, actual_amount) WHERE status = 'pending_payment' AND pay_method != 'BinanceUID'");
  } }
];
// 执行待迁移：先建基表（空库首次迁移），再逐个版本 apply，成功才标记版本；任一失败抛错（带版本号与原因），不得伪装成功。
async function runMigrations(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))').run();
  // 空库首次迁移：仅当库内除迁移表与内部表外没有任何用户表时，才建基表（全新空库）。
  // 若已有部分表但缺基表（如 orders 被误删），不静默重建空表掩盖数据丢失，让 v1 的 ALTER 自然失败、版本不标记。
  // 排除：schema_migrations（迁移表）、sqlite_%（SQLite 内部）、_cf_%（Cloudflare D1 内部，如 _cf_METADATA）。
  var tblRows = await env.DB.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'schema_migrations'").first();
  var isFreshDb = tblRows ? Number(tblRows.c || 0) === 0 : true;
  if (isFreshDb) {
    for (var b = 0; b < BASE_TABLES.length; b++) {
      await env.DB.prepare(BASE_TABLES[b]).run();
    }
  }
  var applied = {};
  var rows = await env.DB.prepare('SELECT version FROM schema_migrations').all();
  (rows.results || []).forEach(function (r) { applied[Number(r.version)] = 1; });
  var done = [];
  for (var i = 0; i < MIGRATIONS.length; i++) {
    var m = MIGRATIONS[i];
    if (applied[m.version]) continue;
    try {
      await m.up(env);
    } catch (e) {
      throw new Error('数据库迁移失败 v' + m.version + '（' + m.name + '）：' + (e && e.message ? e.message : String(e)) + '。版本未标记，请检查 D1 后重试；数据未被破坏。');
    }
    await env.DB.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').bind(m.version).run();
    done.push(m.version);
  }
  return { ok: true, applied: done, current_version: MIGRATIONS.length };
}
// 每次 API 请求的轻量检查：只查一次迁移版本号（单条索引查询），版本已是最新时立即返回，不跑 PRAGMA/DDL/数据修复。
async function ensureMigrated(env) {
  try {
    var row = await env.DB.prepare('SELECT MAX(version) AS v FROM schema_migrations').first();
    var cur = row ? Number(row.v || 0) : 0;
    if (cur >= MIGRATIONS.length) return { ok: true, applied: [] };
  } catch (e) { /* schema_migrations 表不存在 → 走完整迁移 */ }
  return await runMigrations(env);
}
// 兼容：旧函数名保留为 ensureMigrated 的别名（测试与外部调用仍可使用），不再执行逐请求完整迁移。
// ---- 第四轮：付款账本（payments）----
// 状态机：submitted（用户提交 TXID，待核验）→ discovered（轮询发现，待核验）→ verified（链上核验通过）
//   → confirmed（达到该链确认数）→ posted（已入账，订单履约已触发）。
// 异常状态：duplicate（同一事件已入账，拒绝重复）、mismatch（金额与订单预期不符，需人工对账）、
//   unmatched（无法归属订单，需人工对账）。reconciled 由管理员手动标记已处理。
// 关键：同一链上事件（chain, tx_hash, event_key）唯一，重复轮询/并发提交不得重复入账。
//   同一订单可有多笔付款（order_id 不唯一），重复/部分/超额付款各留独立记录。
async function recordPayment(env, p) {
  // 幂等写入：同一事件已存在时不重复建行，返回现有行。调用方用返回的行决定后续动作。
  // p: { order_id, chain, asset, pay_address, tx_hash, event_key, amount, block_number, confirmations, status, reconcile_note }
  var now = nowISO();
  var row = await env.DB.prepare('SELECT * FROM payments WHERE chain = ? AND tx_hash = ? AND event_key = ?').bind(p.chain || '', p.tx_hash || '', p.event_key || '').first().catch(function () { return null; });
  if (row) return { ok: true, payment: row, created: false };
  var ins = await env.DB.prepare('INSERT INTO payments (order_id, chain, asset, pay_address, tx_hash, event_key, amount, amount_unit, block_number, confirmations, first_seen_at, status, reconcile_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
    p.order_id != null ? Number(p.order_id) : null, p.chain || '', p.asset || 'USDT', p.pay_address || '', p.tx_hash || '', p.event_key || '', Number(p.amount) || 0, p.amount_unit || 'USDT',
    p.block_number != null ? Number(p.block_number) : null, Number(p.confirmations) || 0, now, p.status || 'submitted', p.reconcile_note || '', now, now).run().catch(function () { return null; });
  if (ins && ins.meta && ins.meta.changes === 1) {
    var created = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(Number(ins.meta.last_row_id)).first();
    return { ok: true, payment: created, created: true };
  }
  // 并发下唯一冲突：重新读，确认归属
  var again = await env.DB.prepare('SELECT * FROM payments WHERE chain = ? AND tx_hash = ? AND event_key = ?').bind(p.chain || '', p.tx_hash || '', p.event_key || '').first().catch(function () { return null; });
  if (again) return { ok: true, payment: again, created: false };
  return { ok: false, reason: '付款记录写入失败' };
}
async function updatePayment(env, paymentId, fields) {
  // fields: { status, confirmations, block_number, event_key, order_id, reconcile_status, reconcile_note, amount }
  var sets = [], binds = [];
  var allowed = ['status', 'confirmations', 'block_number', 'event_key', 'order_id', 'reconcile_status', 'reconcile_note', 'amount', 'pay_address', 'chain'];
  for (var i = 0; i < allowed.length; i++) {
    if (fields[allowed[i]] !== undefined) { sets.push(allowed[i] + ' = ?'); binds.push(fields[allowed[i]]); }
  }
  if (!sets.length) return { ok: true };
  sets.push('updated_at = ?'); binds.push(nowISO());
  binds.push(Number(paymentId));
  var stmt = env.DB.prepare('UPDATE payments SET ' + sets.join(', ') + ' WHERE id = ?');
  var r = await stmt.bind.apply(stmt, binds).run().catch(function () { return null; });
  if (r && r.meta && r.meta.changes === 1) return { ok: true };
  return { ok: false, reason: '付款记录更新失败' };
}
async function getPaymentByEvent(env, chain, txHash, eventKey) {
  return await env.DB.prepare('SELECT * FROM payments WHERE chain = ? AND tx_hash = ? AND event_key = ?').bind(chain || '', txHash || '', eventKey || '').first().catch(function () { return null; });
}
async function getRequiredConfirmations(env, chain) {
  try {
    var settings = await getAllSettings(env);
    var map = parseJsonSafe(settings.chain_confirmations, {});
    var v = Number(map[chain]);
    if (isFinite(v) && v >= 1) return Math.floor(v);
  } catch (e) {}
  var d = Number(DEFAULT_CHAIN_CONFIRMATIONS[chain]);
  return (isFinite(d) && d >= 1) ? Math.floor(d) : 1;
}
// ---- 第四轮：链上扫描游标 ----
// 每链已扫描到的区块高度。RPC 失败不推进，重启可恢复。游标只在整页扫描成功后推进。
async function getScanCursor(env, chain) {
  var row = await env.DB.prepare('SELECT last_block FROM scan_cursors WHERE chain = ?').bind(chain || '').first().catch(function () { return null; });
  return row ? Number(row.last_block) || 0 : 0;
}
async function setScanCursor(env, chain, block) {
  await env.DB.prepare('INSERT INTO scan_cursors (chain, last_block, updated_at) VALUES (?, ?, ?) ON CONFLICT(chain) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at').bind(chain || '', Number(block) || 0, nowISO()).run().catch(function () {});
}
// ---- 第四轮：/pay 独立限流 ----
// key: 'order:<订单号>' 或 'ip:<IP>'。窗口内超限返回 true（应拒绝），否则记一条并返回 false。
async function checkPayRateLimit(env, req, orderNo) {
  try {
    var ip = getClientIp(req);
    var winStart = new Date(Date.now() - PAY_RATE_WINDOW_MS).toISOString().replace('T', ' ').slice(0, 19);
    await env.DB.prepare('DELETE FROM pay_rate WHERE created_at < ?').bind(winStart).run().catch(function () {});
    var oc = await env.DB.prepare('SELECT COUNT(*) as n FROM pay_rate WHERE key = ?').bind('order:' + orderNo).first();
    if (oc && Number(oc.n) >= PAY_RATE_PER_ORDER) return '该订单提交 TXID 过于频繁，请稍后再试（后台轮询仍会继续核验）';
    var ic = await env.DB.prepare('SELECT COUNT(*) as n FROM pay_rate WHERE key = ?').bind('ip:' + ip).first();
    if (ic && Number(ic.n) >= PAY_RATE_PER_IP) return '提交过于频繁，请稍后再试';
    await env.DB.prepare('INSERT INTO pay_rate (key, created_at) VALUES (?, ?), (?, ?)').bind('order:' + orderNo, nowISO(), 'ip:' + ip, nowISO()).run().catch(function () {});
    return null;
  } catch (e) { return null; }
}
// ---- 第四轮：登录全局限流（防换 IP 分布式暴力破解）----
async function checkLoginGlobalRateLimit(env) {
  try {
    var winStart = new Date(Date.now() - LOGIN_GLOBAL_WINDOW_MS).toISOString().replace('T', ' ').slice(0, 19);
    var blockedUntil = await getAdminMeta(env, 'login_global_blocked_until');
    if (blockedUntil && new Date(String(blockedUntil).replace(' ', 'T') + 'Z').getTime() > Date.now()) return '登录尝试过多，全站登录已临时锁定，请 5 分钟后再试';
    var row = await env.DB.prepare('SELECT COUNT(*) as n FROM login_attempts WHERE updated_at >= ?').bind(winStart).first();
    // login_attempts 只记最新一次失败/封禁，无法精确计数全站失败总数；用 admin_meta 累计窗口失败数（recordLoginFail 维护）。
    var cnt = parseInt(await getAdminMeta(env, 'login_global_fail_count') || '0', 10) || 0;
    var win = parseInt(await getAdminMeta(env, 'login_global_fail_window') || '0', 10) || 0;
    if (win && Date.now() - win > LOGIN_GLOBAL_WINDOW_MS) { cnt = 0; }
    if (cnt >= LOGIN_GLOBAL_MAX_FAIL) {
      await setAdminMeta(env, 'login_global_blocked_until', new Date(Date.now() + LOGIN_GLOBAL_BLOCK_MS).toISOString().replace('T', ' ').slice(0, 19));
      return '登录尝试过多，全站登录已临时锁定，请 5 分钟后再试';
    }
    return null;
  } catch (e) { return null; }
}
async function recordLoginFailGlobal(env) {
  try {
    var win = parseInt(await getAdminMeta(env, 'login_global_fail_window') || '0', 10) || 0;
    var cnt = parseInt(await getAdminMeta(env, 'login_global_fail_count') || '0', 10) || 0;
    if (!win || Date.now() - win > LOGIN_GLOBAL_WINDOW_MS) { win = Date.now(); cnt = 0; }
    await setAdminMeta(env, 'login_global_fail_window', String(win));
    await setAdminMeta(env, 'login_global_fail_count', String(cnt + 1));
  } catch (e) {}
}
// ---- 第四轮：Schema 预检（只读，不改数据）----
// 校验实际 Schema 是否与目标版本一致：表、列、索引、关键唯一约束。版本号与 Schema 内容不一致时报告差异，不得静默放行。
// 返回 { ok, current_version, latest_version, issues: [..], checks: { tables, columns, indexes } }。
async function precheckSchema(env) {
  var issues = [];
  var checks = { tables: [], columns: [], indexes: [] };
  var expectedTables = {
    products: ['id', 'slug', 'title', 'category', 'price_usdt', 'source', 'prodseller_id', 'cost_price', 'sell_price', 'requires_email_activation', 'delivery_method', 'stock_type', 'description', 'notice', 'form_fields', 'image_emoji', 'image_data', 'sort', 'is_active', 'in_stock', 'created_at'],
    cards: ['id', 'product_id', 'code', 'is_used', 'is_disabled', 'order_id', 'reserved_order_id', 'reserved_at', 'created_at'],
    orders: ['id', 'order_no', 'query_password', 'query_token_hash', 'claim_token', 'claimed_at', 'exception_reason', 'refund_status', 'refund_ref', 'upstream_lock', 'upstream_lock_expires_at', 'product_id', 'product_snapshot', 'quantity', 'price_usdt', 'total_usdt', 'actual_amount', 'pay_address', 'expires_at', 'last_checked_at', 'tx_hash', 'customer_fields', 'contact', 'pay_method', 'pay_chain', 'wallet_address', 'txid', 'status', 'delivery_content', 'admin_note', 'data_expired', 'created_at', 'paid_at', 'fulfilled_at'],
    settings: ['key', 'value'],
    admin_meta: ['key', 'value'],
    upstream_orders: ['id', 'order_id', 'prodseller_order_id', 'status', 'amount', 'delivered_keys', 'created_at'],
    upstream_cache: ['key', 'payload', 'fetched_at'],
    sessions: ['token', 'created_at', 'expires_at'],
    captcha_codes: ['id', 'code_hash', 'expires_at', 'attempts'],
    order_rate: ['ip', 'created_at'],
    admin_audit: ['id', 'order_id', 'action', 'before_status', 'after_status', 'note', 'created_at'],
    login_attempts: ['ip', 'attempts', 'blocked_until', 'updated_at'],
    txid_claims: ['tx_hash', 'order_id', 'claimed_at'],
    lookup_rate: ['ip', 'created_at'],
    schema_migrations: ['version', 'applied_at'],
    payments: ['id', 'order_id', 'chain', 'asset', 'pay_address', 'tx_hash', 'event_key', 'amount', 'amount_unit', 'block_number', 'confirmations', 'first_seen_at', 'status', 'reconcile_status', 'reconcile_note', 'created_at', 'updated_at'],
    scan_cursors: ['chain', 'last_block', 'updated_at'],
    pay_rate: ['key', 'created_at']
  };
  var expectedIndexes = [
    { name: 'idx_upstream_orders_order_unique', unique: 1 },
    { name: 'idx_payments_event_unique', unique: 1 },
    { name: 'idx_orders_amount_claim', unique: 1 },
    { name: 'idx_orders_contact_pending', unique: 1 }
  ];
  var curRow = await env.DB.prepare('SELECT MAX(version) AS v FROM schema_migrations').first().catch(function () { return null; });
  var curV = curRow ? Number(curRow.v || 0) : 0;
  for (var t in expectedTables) {
    try {
      var info = await env.DB.prepare('PRAGMA table_info(' + t + ')').all();
      var cols = (info.results || []).map(function (r) { return r.name; });
      if (!cols.length) { issues.push('缺表：' + t); checks.tables.push({ table: t, ok: false, missing: 'table' }); continue; }
      checks.tables.push({ table: t, ok: true });
      var missing = [];
      expectedTables[t].forEach(function (c) { if (cols.indexOf(c) === -1) missing.push(c); });
      if (missing.length) { issues.push('表 ' + t + ' 缺列：' + missing.join(', ')); checks.columns.push({ table: t, ok: false, missing: missing }); }
      else checks.columns.push({ table: t, ok: true });
    } catch (e) { issues.push('预检表 ' + t + ' 失败：' + (e && e.message ? e.message : String(e))); }
  }
  try {
    var idxRows = await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all();
    var idxMap = {};
    (idxRows.results || []).forEach(function (r) { idxMap[r.name] = String(r.sql || ''); });
    expectedIndexes.forEach(function (ei) {
      if (!idxMap[ei.name]) { issues.push('缺唯一索引：' + ei.name); checks.indexes.push({ index: ei.name, ok: false, missing: 'index' }); return; }
      if (ei.unique && idxMap[ei.name].toUpperCase().indexOf('UNIQUE') === -1) { issues.push('索引 ' + ei.name + ' 不是唯一索引'); checks.indexes.push({ index: ei.name, ok: false, missing: 'unique' }); return; }
      checks.indexes.push({ index: ei.name, ok: true });
    });
  } catch (e) { issues.push('预检索引失败：' + (e && e.message ? e.message : String(e))); }
  // 重复待付款金额检查（会影响 v8 唯一索引建立）
  try {
    var dup = await env.DB.prepare("SELECT pay_address, actual_amount, COUNT(*) as c FROM orders WHERE status = 'pending_payment' GROUP BY pay_address, actual_amount HAVING c > 1 LIMIT 5").all();
    (dup.results || []).forEach(function (r) { issues.push('重复待付款金额：地址 ' + r.pay_address + ' 金额 ' + r.actual_amount + ' 有 ' + r.c + ' 笔'); });
  } catch (e) {}
  return { ok: issues.length === 0, current_version: curV, latest_version: MIGRATIONS.length, up_to_date: curV >= MIGRATIONS.length, issues: issues, checks: checks };
}
async function logAudit(env, orderId, action, beforeStatus, afterStatus, note) {
  // 返回 true=写入成功，false=写入失败。关键操作调用方必须检查返回值，审计失败不得宣称操作完全成功。
  try {
    await env.DB.prepare('INSERT INTO admin_audit (order_id, action, before_status, after_status, note) VALUES (?, ?, ?, ?, ?)').bind(orderId == null ? null : Number(orderId), String(action || ''), String(beforeStatus || ''), String(afterStatus || ''), String(note || '').slice(0, 500)).run();
    return true;
  } catch (e) { return false; }
}
function auditFailMsg(orderId, action) {
  return '操作已执行，但审计记录写入失败，请立即检查 admin_audit 表并手动补记（订单ID：' + orderId + '，操作：' + action + '）';
}
function getClientIp(req) {
  // 生产环境 CF-Connecting-IP 由 Cloudflare 权威设置，客户端无法伪造，优先使用。
  var cf = req.headers.get('CF-Connecting-IP');
  if (cf) return String(cf).trim();
  // 仅非 CF 环境（本地开发）才用 X-Forwarded-For 的第一项；生产走 CF 头，XFF 不可信。
  var xff = req.headers.get('X-Forwarded-For');
  if (xff) return String(xff).split(',')[0].trim() || 'unknown';
  return 'unknown';
}
function checkCsrf(req, url) {
  // CSRF：管理端写操作必须有明确的同源证明，缺失 Origin 不再自动等同于安全。
  // 浏览器：Origin 必须与本站同源（现代浏览器对 POST/PUT/DELETE 一律发送 Origin）。
  // 浏览器（无 Origin 时）：Sec-Fetch-Site 必须为 same-origin。
  // 非浏览器 API 客户端：必须显式发送 X-Admin-API: 1 声明身份（仍需有效 Session；CSRF 只针对浏览器 ambient Cookie 场景）。
  var origin = req.headers.get('Origin') || '';
  if (origin) {
    var reqOrigin = url.protocol + '//' + url.host;
    if (origin !== reqOrigin) return 'Origin 校验失败，疑似跨站请求';
    return null;
  }
  var fetchSite = req.headers.get('Sec-Fetch-Site') || '';
  if (fetchSite === 'same-origin') return null;
  if ((req.headers.get('X-Admin-API') || '') === '1') return null;
  return '缺少 Origin / Sec-Fetch-Site 同源证明，疑似跨站请求；API 客户端请显式发送 X-Admin-API: 1';
}
function cookieFlags(url) {
  // 生产 HTTPS 下加 Secure；本地 http 开发不加（否则 cookie 写不进浏览器）
  var flags = 'Path=/; HttpOnly; SameSite=Lax';
  if (url && url.protocol === 'https:') flags += '; Secure';
  return flags;
}
var LOGIN_MAX_FAIL = 5; // 同一 IP 15 分钟内失败 5 次后封禁 15 分钟
var LOGIN_BLOCK_MS = 15 * 60 * 1000;
async function checkLoginRateLimit(env, ip) {
  try {
    var row = await env.DB.prepare('SELECT * FROM login_attempts WHERE ip = ?').bind(ip).first();
    if (!row) return null;
    if (row.blocked_until && new Date(String(row.blocked_until).replace(' ', 'T') + 'Z').getTime() > Date.now()) return '登录尝试过多，请 15 分钟后再试';
    return null;
  } catch (e) { return null; }
}
async function recordLoginFail(env, ip) {
  try {
    var now = nowISO();
    var row = await env.DB.prepare('SELECT * FROM login_attempts WHERE ip = ?').bind(ip).first();
    var attempts = (row ? Number(row.attempts || 0) : 0) + 1;
    var blockedUntil = '';
    if (attempts >= LOGIN_MAX_FAIL) blockedUntil = new Date(Date.now() + LOGIN_BLOCK_MS).toISOString().replace('T', ' ').slice(0, 19);
    await env.DB.prepare('INSERT INTO login_attempts (ip, attempts, blocked_until, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET attempts=excluded.attempts, blocked_until=excluded.blocked_until, updated_at=excluded.updated_at').bind(ip, attempts, blockedUntil, now).run();
  } catch (e) {}
}
async function clearLoginAttempts(env, ip) {
  try { await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run(); } catch (e) {}
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
  // 上游网络异常（超时 / DNS / 连接失败）必须转为明确的失败响应，不得抛错导致请求 500：
  // 调用方按 status=0 / ok=false 走 pending_upstream + 退避重试，恢复时用同一 Idempotency-Key 安全重试。
  var res;
  try {
    res = await getFetch(env)(url, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch (e) {
    return { status: 0, ok: false, data: null, text: '', error: '上游请求失败：' + (e && e.message ? e.message : String(e)) };
  }
  var text = '';
  try { text = await res.text(); } catch (e) { text = ''; }
  var data = null; try { data = JSON.parse(text); } catch (e) { data = null; }
  return { status: res.status, ok: res.ok, data: data, text: text };
}
async function prodsellerCreateOrder(env, settings, order, product, customerFields) {
  // 履约调用限流（第四轮 P0）：与同步共享 300/15min 计数。超限返回 429 语义，调用方按 pending_upstream + 下次轮询重试，
  // 不得因限流而误判为上游失败或重复采购。
  if (!(await checkUpstreamRateLimit(env))) return { status: 429, ok: false, data: null, text: '', error: '上游调用限流（300/15min），下次轮询重试' };
  var body = { productId: product.prodseller_id || product.slug, quantity: order.quantity, email: String(customerFields.contact_email || customerFields.delivery_email || order.contact || '').trim() };
  if (Number(product.requires_email_activation) === 1) {
    body.email = String(customerFields.activation_email || '').trim();
    body.emails = [String(customerFields.activation_email || '').trim()];
  }
  var r = await prodsellerFetch(env, settings, '/orders', { method: 'POST', idempotencyKey: order.order_no, body: body });
  return r;
}
async function prodsellerGetOrder(env, settings, psId) {
  if (!(await checkUpstreamRateLimit(env))) return { status: 429, ok: false, data: null, text: '', error: '上游调用限流（300/15min），下次轮询重试' };
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
  // SQLite UPSERT（ON CONFLICT）：单条语句原子写入，并发下不会产生重复行。
  // 依赖迁移 v7 的唯一索引 idx_upstream_orders_order_unique（upstream_orders.order_id 唯一）。
  // 空值保护（第四轮 P0）：已有非空上游订单号 / 已交付 keys 时，空字符串不得覆盖。
  // 原因：占位行（insufficient_balance / upstream_error 等）传入空 psId；若无条件覆盖，会把已成功的上游单号抹掉，
  // 导致后续轮询误判为“无上游单号”而重复创建采购。状态与金额仍可更新（状态流转是正常业务）。
  await env.DB.prepare('INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, ?, ?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET prodseller_order_id=CASE WHEN excluded.prodseller_order_id = \'\' THEN upstream_orders.prodseller_order_id ELSE excluded.prodseller_order_id END, status=excluded.status, amount=excluded.amount, delivered_keys=CASE WHEN excluded.delivered_keys = \'\' THEN upstream_orders.delivered_keys ELSE excluded.delivered_keys END').bind(orderId, psId || '', status || '', Number(amount) || 0, keys || '').run();
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
    var base = '订单号：' + order.order_no + '；商品：' + title + '；金额：' + order.total_usdt + ' USDT';
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
async function pollUpstreamActivations(env, ctx, opts) {
  // opts.orderId：管理员重试单笔订单时只处理该订单（避免误处理其他订单）；Cron 不传，处理全部待处理订单。
  var onlyOrderId = opts && opts.orderId ? Number(opts.orderId) : 0;
  var settings = await getAllSettings(env);
  var out = { checked: 0, delivered: 0, retried: 0, still_pending: 0 };
  var rows;
  if (onlyOrderId) {
    rows = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND status IN ('pending_activation','pending_upstream') ORDER BY id ASC LIMIT 1").bind(onlyOrderId).all();
  } else {
    rows = await env.DB.prepare("SELECT * FROM orders WHERE status IN ('pending_activation','pending_upstream') ORDER BY id ASC LIMIT 100").all();
  }
  var list = rows.results || [];
  for (var i = 0; i < list.length; i++) {
    var o = list[i];
    // 处理租约：Cron 与管理员重试同时执行时，只能一个处理者持有某订单的租约。
    // 单条条件 UPDATE 原子抢锁（未持有 或 已过期）；抢锁失败 = 另一处理者正在处理，跳过，不重复调上游。
    // 租约 10 分钟：处理者崩溃时，超租约后可被后续轮询接管；正常处理完在 finally 中释放。
    var lockToken = randomHex(8);
    var lease = await env.DB.prepare("UPDATE orders SET upstream_lock=?, upstream_lock_expires_at=datetime('now','+10 minutes') WHERE id=? AND status IN ('pending_activation','pending_upstream') AND (upstream_lock IS NULL OR upstream_lock='' OR upstream_lock_expires_at IS NULL OR upstream_lock_expires_at < datetime('now'))").bind(lockToken, o.id).run();
    if (!lease.meta || lease.meta.changes !== 1) { out.still_pending++; continue; }
    try {
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
    } finally {
      // 释放租约（仅释放本持有的令牌，防止释放他人接管后的租约）
      try { await env.DB.prepare('UPDATE orders SET upstream_lock=?, upstream_lock_expires_at=NULL WHERE id=? AND upstream_lock=?').bind('', o.id, lockToken).run(); } catch (e) {}
    }
  }
  return { ok: true, poll: out };
}

function parseJsonSafe(s, fallback) { try { return JSON.parse(s || ''); } catch (e) { return fallback; } }
function fmtTsPlusMinutes(min) { return new Date(Date.now() + min * 60000).toISOString().replace('T', ' ').slice(0, 19); }
function amountsEqual(a, b) { return Math.abs(Number(a) - Number(b)) < 0.000001; }
async function genActualAmount(env, baseTotal, payAddress) {
  // 随机尾数 0.0001-0.0099。SELECT 查重是尽力而为（仍有 TOCTOU 窗口），真正的原子保障是
  // v8 部分唯一索引 idx_orders_amount_claim + 下单 INSERT 冲突重试（见下单逻辑）。
  for (var attempt = 0; attempt < 50; attempt++) {
    var tail = (1 + Math.floor(Math.random() * 99)) / 10000;
    var actual = Math.round((Number(baseTotal) + tail) * 10000) / 10000;
    var clash = await env.DB.prepare("SELECT id FROM orders WHERE pay_address = ? AND ABS(actual_amount - ?) < 0.000001 AND status = 'pending_payment' AND expires_at > datetime('now') LIMIT 1").bind(payAddress, actual).first().catch(function () { return null; });
    if (!clash) return actual;
  }
  // 50 次都冲突（极小概率，地址繁忙）：返回毫秒尾数候选，仍由 INSERT 唯一约束做最终裁决；
  // 若 INSERT 也冲突，下单逻辑会重新生成并重试，不得静默复用冲突金额。
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
// TRC20：Tronscan token_trc20/transfers，匹配 to + 金额 + token + 时间。
// 分页：共享收款地址在忙时 1 分钟内可收到 >50 笔，单页 limit=50 会漏到账。按 start 偏移逐页取，最多 TRONSCAN_MAX_PAGES 页（20 页 = 1000 笔）；
// 某页已全部早于订单创建时间（减 1 分钟缓冲）时停止（后续页只会更早，不会含本订单的到账）。
// 分页上限评估（第四轮 P0）：20 页基于 Tronscan 单地址高频收款场景（1 分钟内 >1000 笔 USDT 转账的地址极少）；
// 若命中上限且未找到本订单付款，记 console 警告（不得静默漏账），运营需人工在 Tronscan 核查该地址的转账并手动对账。
async function checkTrc20Payment(fetchFn, payAddress, actualAmount, createdAtISO) {
  var createdMs = Date.parse(String(createdAtISO).replace(' ', 'T') + 'Z') || 0;
  var start = 0;
  var pageSize = 50;
  for (var page = 0; page < TRONSCAN_MAX_PAGES; page++) {
    var url = 'https://apilist.tronscanapi.com/api/token_trc20/transfers?limit=' + pageSize + '&start=' + start + '&toAddress=' + encodeURIComponent(payAddress);
    var res = await fetchFn(url);
    if (!res.ok) throw new Error('Tronscan HTTP ' + res.status);
    var j = await res.json();
    var list = (j && (j.data || j.token_transfers)) || [];
    if (!Array.isArray(list)) list = [];
    var oldestTsInPage = Infinity;
    for (var i = 0; i < list.length; i++) {
      var t = list[i] || {};
      // 本页最旧时间（页内按时间倒序，所有转账都统计，与金额过滤无关，用于提前停页判断）
      var tsAll = Number(t.block_ts || t.timestamp || 0);
      if (tsAll) oldestTsInPage = Math.min(oldestTsInPage, tsAll);
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
    if (list.length < pageSize) break; // 最后一页
    if (oldestTsInPage !== Infinity && oldestTsInPage < createdMs - 60000) break; // 本页已全部早于订单创建时间
    start += pageSize;
    if (page === TRONSCAN_MAX_PAGES - 1) {
      // 命中分页上限且未找到付款：不得静默漏账，记警告供运营人工核查。
      try { console.warn('Tronscan 分页上限命中（' + TRONSCAN_MAX_PAGES + ' 页），地址 ' + payAddress + ' 可能漏检，请人工核查 Tronscan 转账并对账'); } catch (e) {}
    }
  }
  return null;
}
// EVM/X Layer：eth_getLogs 查 USDT Transfer，至少 requiredConfirmations 确认（各链策略，见 DEFAULT_CHAIN_CONFIRMATIONS）。
// opts: { requiredConfirmations, fromBlockOverride }。fromBlockOverride 用于游标扫描；未传时回溯 200 区块（兼容旧口径）。
async function checkEvmPayment(fetchFn, rpcUrls, contract, payAddress, actualAmount, opts) {
  if (!contract || !contract.startsWith('0x')) return null;
  opts = opts || {};
  var requiredConf = Number(opts.requiredConfirmations) || 1;
  var expected = BigInt(Math.round(Number(actualAmount) * 1000000));
  var toTopic = padAddressTopic(payAddress);
  for (var ri = 0; ri < rpcUrls.length; ri++) {
    try {
      var rpc = rpcUrls[ri];
      var latestHex = await rpcCall(fetchFn, rpc, 'eth_blockNumber', []);
      var latest = parseInt(latestHex, 16);
      if (!isFinite(latest) || latest <= 0) continue;
      var fromBlock = (opts.fromBlockOverride != null) ? Number(opts.fromBlockOverride) : Math.max(0, latest - 200);
      if (!isFinite(fromBlock) || fromBlock < 0) fromBlock = Math.max(0, latest - 200);
      if (fromBlock > latest) continue;
      var toBlock = latest - requiredConf;
      if (toBlock < fromBlock) continue; // 未达到确认数的区块不扫描（防重组）
      var logs = await rpcCall(fetchFn, rpc, 'eth_getLogs', [{ address: contract, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), topics: [TRANSFER_TOPIC0, null, toTopic] }]);
      if (!Array.isArray(logs)) continue;
      for (var i = 0; i < logs.length; i++) {
        var lg = logs[i];
        var topics = lg.topics || [];
        if (topics.length < 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC0) continue;
        if (String(topics[2]).toLowerCase() !== toTopic) continue;
        var blk = parseInt(lg.blockNumber, 16);
        if (!isFinite(blk)) continue;
        var val = 0n;
        try { val = BigInt(lg.data || '0x0'); } catch (e) { continue; }
        if (val !== expected) continue;
        if (lg.transactionHash) return { txHash: String(lg.transactionHash), amount: Number(actualAmount), blockNumber: blk, logIndex: lg.logIndex != null ? String(lg.logIndex) : '', confirmations: (latest - blk) };
      }
    } catch (e) { continue; }
  }
  return null;
}
// 全局 EVM 扫描（第四轮 P0）：按链游标分页扫描，补扫漏检，重启可恢复。
// 扫描范围：[cursor, latest - requiredConfirmations]，按 EVM_SCAN_PAGE_BLOCKS 分页；整页成功后才推进游标，RPC 失败不推进。
// 对每个 Transfer 日志：记付款账本（discovered），按 to + 金额匹配待付款订单，匹配到且确认数足够时触发履约并记 posted。
// 返回 { scanned: 扫描日志数, matched: 匹配到账数, fulfilled: 履约数 }。游标失败不抛错（下次轮询重试）。
async function scanEvmChain(env, fetchFn, ctx, chain, pendingOrders) {
  var settings = await getAllSettings(env);
  var contracts = parseJsonSafe(settings.usdt_contracts, {});
  var contract = contracts[chain] || DEFAULT_USDT_CONTRACTS[chain] || '';
  var rpcMap = parseJsonSafe(settings.rpc_urls, {});
  var rpcs = rpcMap[chain] || DEFAULT_RPC_URLS[chain] || [];
  if (!contract || !contract.startsWith('0x') || !rpcs.length || !pendingOrders.length) return { scanned: 0, matched: 0, fulfilled: 0 };
  var requiredConf = await getRequiredConfirmations(env, chain);
  var cursor = await getScanCursor(env, chain);
  var out = { scanned: 0, matched: 0, fulfilled: 0 };
  // 按待付款订单的收款地址去重，只扫有待付款订单的地址，减少 RPC 调用。
  var addrSet = {};
  pendingOrders.forEach(function (o) { var a = String(o.pay_address || o.wallet_address || '').toLowerCase(); if (a) addrSet[a] = o.pay_address || o.wallet_address; });
  var addrs = Object.keys(addrSet);
  for (var ai = 0; ai < addrs.length; ai++) {
    var addr = addrSet[addrs[ai]];
    var toTopic = padAddressTopic(addr);
    // 本地址的待付款订单（按金额索引，便于匹配）
    var byAmount = {};
    pendingOrders.forEach(function (o) { if (String(o.pay_address || o.wallet_address || '').toLowerCase() === addrs[ai]) byAmount[String(Number(o.actual_amount || o.total_usdt))] = o; });
    for (var ri = 0; ri < rpcs.length; ri++) {
      try {
        var latestHex = await rpcCall(fetchFn, rpcs[ri], 'eth_blockNumber', []);
        var latest = parseInt(latestHex, 16);
        if (!isFinite(latest) || latest <= 0) continue;
        var endBlock = latest - requiredConf;
        if (endBlock < 0) endBlock = 0;
        // 首次扫描（游标为 0）时回溯 200 区块（与旧口径一致），避免从创世区块全量扫描。
        var startBlock = cursor > 0 ? cursor : Math.max(0, latest - 200);
        if (startBlock > endBlock) continue;
        var pageFrom = startBlock;
        var scannedTo = startBlock;
        while (pageFrom <= endBlock) {
          var pageTo = Math.min(pageFrom + EVM_SCAN_PAGE_BLOCKS - 1, endBlock);
          var logs = await rpcCall(fetchFn, rpcs[ri], 'eth_getLogs', [{ address: contract, fromBlock: toHex(pageFrom), toBlock: toHex(pageTo), topics: [TRANSFER_TOPIC0, null, toTopic] }]);
          if (!Array.isArray(logs)) break; // 本 RPC 异常，停在本页，不推进游标，下次重试
          for (var li = 0; li < logs.length; li++) {
            var lg = logs[li];
            var topics = lg.topics || [];
            if (topics.length < 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC0) continue;
            if (String(topics[2]).toLowerCase() !== toTopic) continue;
            var blk = parseInt(lg.blockNumber, 16);
            if (!isFinite(blk)) continue;
            var val = 0n;
            try { val = BigInt(lg.data || '0x0'); } catch (e) { continue; }
            var amt = Number(val) / 1000000;
            out.scanned++;
            var matchedOrder = byAmount[String(Number(amt))];
            if (!matchedOrder) {
              // 无法归属订单：记 unmatched，供人工对账（不得静默丢弃）。
              try { await recordPayment(env, { order_id: null, chain: chain, pay_address: addr, tx_hash: String(lg.transactionHash || ''), event_key: lg.logIndex != null ? String(lg.logIndex) : '', amount: amt, block_number: blk, confirmations: latest - blk, status: 'unmatched', reconcile_status: 'pending', reconcile_note: '全局扫描发现，无法归属订单' }); } catch (e) {}
              continue;
            }
            out.matched++;
            // 账本：发现 → 核验通过 → 确认数足够 → 履约 → 入账。同一事件重复扫描时 recordPayment 返回已有行，不重复建行。
            var evKey = lg.logIndex != null ? String(lg.logIndex) : '';
            var rec = await recordPayment(env, { order_id: matchedOrder.id, chain: chain, pay_address: addr, tx_hash: String(lg.transactionHash || ''), event_key: evKey, amount: amt, block_number: blk, confirmations: latest - blk, status: 'discovered', reconcile_note: '全局扫描发现' }).catch(function () { return null; });
            var payRow = rec && rec.payment ? rec.payment : null;
            if (payRow && payRow.status === 'posted') continue; // 已入账，跳过（防重复发货）
            if (payRow) { try { await updatePayment(env, payRow.id, { status: 'confirmed', confirmations: latest - blk }); } catch (e) {} }
            // 金额必须与订单预期精确匹配（amountsEqual），否则记 mismatch，不得履约。
            if (!amountsEqual(amt, matchedOrder.actual_amount || matchedOrder.total_usdt)) {
              if (payRow) { try { await updatePayment(env, payRow.id, { status: 'mismatch', reconcile_status: 'pending', reconcile_note: '金额与订单预期不符，需人工对账' }); } catch (e) {} }
              continue;
            }
            var r = await fulfillOrderByPayment(env, matchedOrder, String(lg.transactionHash || ''), ctx, { txVerified: true });
            if (r.ok && (r.mode === 'completed' || r.mode === 'pending_fulfill' || r.mode === 'out_of_stock' || r.mode === 'pending_activation' || r.mode === 'pending_upstream')) {
              out.fulfilled++;
              if (payRow) { try { await updatePayment(env, payRow.id, { status: 'posted' }); } catch (e) {} }
            }
          }
          scannedTo = pageTo + 1;
          pageFrom = pageTo + 1;
        }
        // 整页成功后推进游标（只推进本地址本 RPC 的成功扫描；多地址共享游标时取最大值，避免回退）。
        if (scannedTo > startBlock) {
          var curNow = await getScanCursor(env, chain);
          if (scannedTo > curNow) await setScanCursor(env, chain, scannedTo);
        }
        break; // 本地址用第一个可用 RPC 扫完即停，不重复扫其他 RPC
      } catch (e) { continue; }
    }
  }
  return out;
}
async function checkChainPayment(env, fetchFn, order) {
  var settings = await getAllSettings(env);
  if (order.pay_chain === 'TRC20') return await checkTrc20Payment(fetchFn, order.pay_address || order.wallet_address, order.actual_amount || order.total_usdt, order.created_at);
  var contracts = parseJsonSafe(settings.usdt_contracts, {});
  var contract = contracts[order.pay_chain] || DEFAULT_USDT_CONTRACTS[order.pay_chain] || '';
  var rpcMap = parseJsonSafe(settings.rpc_urls, {});
  var rpcs = rpcMap[order.pay_chain] || DEFAULT_RPC_URLS[order.pay_chain] || [];
  if (!rpcs.length) return null;
  var reqConf = await getRequiredConfirmations(env, order.pay_chain);
  return await checkEvmPayment(fetchFn, rpcs, contract, order.pay_address || order.wallet_address, order.actual_amount || order.total_usdt, { requiredConfirmations: reqConf });
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
        // 确认数：按该链确认策略（不再全链 1 确认）。收据区块号必须 <= 最新区块 - requiredConf，否则确认不足，跳过（防链重组导致已发货但付款失效）。
        try {
          var latestHex = await rpcCall(fetchFn, rpcs[ri], 'eth_blockNumber', []);
          var latestBn = parseInt(latestHex, 16);
          var receiptBn = parseInt(receipt.blockNumber, 16);
          var reqConfTxid = await getRequiredConfirmations(env, order.pay_chain);
          if (!isFinite(latestBn) || !isFinite(receiptBn) || receiptBn > latestBn - reqConfTxid) continue;
        } catch (e) { continue; }
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
// ---- 订单认领与 TXID 原子认领（第二轮 P0 并发安全）----
// 认领机制说明（不单独设 processing 状态，认领即状态）：
// 订单仍为 pending_payment，但 claim_token + claimed_at 构成租约。只有认领成功的请求才能分配卡密 / 调上游。
// 认领是单条条件 UPDATE（原子），并检查实际影响行数；认领失败立即返回，不产生任何副作用。
// 处理者崩溃后，认领超过 CLAIM_LEASE_MINUTES 分钟可被其他请求接管（重新认领），接管时能识别上次已产生的副作用（上游单号 / 已标记卡密）并恢复，不重复采购、不重复发卡。
async function claimTxid(env, txHash, orderId) {
  // 同一笔链上已验证交易只能被一个订单认领（永久有效）。同一订单重试放行。
  // 严格先到先得：已有其他订单认领时永远拒绝，不允许“接管/抢占”。
  // 原因：链上核验与管理员确认都可能看到同一笔交易；允许接管会让两个并发已验证请求互相覆盖，
  // 无法严格保证同一 TXID 只属于一个订单。归属争议必须由管理员在 D1 中核查 txid_claims 后手动处理，不得由接口自动改写。
  if (!txHash) return { ok: true };
  var existing = await env.DB.prepare('SELECT order_id FROM txid_claims WHERE tx_hash = ?').bind(txHash).first();
  if (existing) {
    if (Number(existing.order_id) === Number(orderId)) return { ok: true };
    return { ok: false, reason: '该交易哈希已用于其他订单（请勿重复提交；归属争议请在 D1 中核查 txid_claims 后手动处理）' };
  }
  var ins = await env.DB.prepare('INSERT INTO txid_claims (tx_hash, order_id) VALUES (?, ?)').bind(txHash, orderId).run().catch(function () { return null; });
  if (ins && ins.meta && ins.meta.changes === 1) return { ok: true };
  // 并发下 INSERT 冲突（主键已存在）：重新读，确认归属
  var again = await env.DB.prepare('SELECT order_id FROM txid_claims WHERE tx_hash = ?').bind(txHash).first();
  if (again && Number(again.order_id) === Number(orderId)) return { ok: true };
  return { ok: false, reason: '该交易哈希已用于其他订单（请勿重复提交；归属争议请在 D1 中核查 txid_claims 后手动处理）' };
}
async function claimOrderForPayment(env, orderId, txHash) {
  // 原子认领：status=pending_payment 且（未认领 或 认领已超租约）。成功时同时写入 paid_at（付款事实）与 tx_hash。
  // txHash 为空时不覆盖已有 tx_hash（保留 /pay 提交的 TXID）。
  // 接管时若用新 TXID 覆盖旧 tx_hash，释放旧 TXID 的认领（仅当旧认领属于本订单），避免旧认领成孤儿（旧 TXID 的真实付款无法被正确订单认领）。
  var oldTx = null;
  if (txHash) {
    var oldRow = await env.DB.prepare('SELECT tx_hash FROM orders WHERE id = ?').bind(orderId).first();
    oldTx = oldRow ? oldRow.tx_hash : null;
  }
  var token = randomHex(16);
  var now = nowISO();
  var sql = "UPDATE orders SET claim_token=?, claimed_at=?, paid_at=?" + (txHash ? ", tx_hash=?" : "") + " WHERE id=? AND status='pending_payment' AND (claim_token IS NULL OR claim_token='' OR claimed_at IS NULL OR claimed_at < datetime('now', '-" + CLAIM_LEASE_MINUTES + " minutes'))";
  var stmt = env.DB.prepare(sql);
  var binds = [token, now, now];
  if (txHash) binds.push(txHash);
  binds.push(orderId);
  var upd = await stmt.bind.apply(stmt, binds).run();
  if (!upd.meta || upd.meta.changes !== 1) return { ok: false, reason: '订单已被其他请求认领或处理', claimToken: null };
  if (oldTx && oldTx !== txHash) {
    try { await env.DB.prepare('DELETE FROM txid_claims WHERE tx_hash = ? AND order_id = ?').bind(oldTx, orderId).run(); } catch (e) {}
  }
  return { ok: true, claimToken: token };
}
// ---- 卡密领取与订单完成的一致性（两阶段 + 补偿 + 恢复）----
// 阶段 1 claimCardsForOrder：标记卡密已用（预留卡 → 已用；兜底补抢可用卡）。崩溃后重试时，已由本订单标记的卡（is_used=1, order_id=本订单）直接复用，不重复领取。
// 阶段 2 completeOrder：条件完成订单（认领令牌 / 期望状态）。若失败，补偿阶段 1 新标记的卡（恢复为预留态），不留“卡已用、订单未完成”的矛盾。
// 恢复：认领接管后，阶段 1 会找到上次已标记的卡并复用；阶段 2 完成订单。同一订单重试绝不重复消耗卡密。
async function markCardsUsed(env, orderId, cardIds, mode) {
  // mode='reserved'：只标记本订单预留的卡（reserved_order_id=本订单），防止抢走其他订单刚预留的卡。
  // mode='unreserved'：只标记未预留的卡（reserved_order_id IS NULL），防止抢走其他订单刚预留的卡。
  // SELECT 与 UPDATE 之间若无此条件，两个并发请求会抢走对方的预留卡。
  // D1 batch 一次提交标记多张卡（原子）；无 batch 的环境顺序执行（生产 D1 恒有 batch）。
  var stmts = [];
  for (var i = 0; i < cardIds.length; i++) {
    if (mode === 'reserved') stmts.push(env.DB.prepare('UPDATE cards SET is_used=1, order_id=?, reserved_order_id=NULL, reserved_at=NULL WHERE id=? AND is_used=0 AND reserved_order_id=?').bind(orderId, cardIds[i], orderId));
    else stmts.push(env.DB.prepare('UPDATE cards SET is_used=1, order_id=?, reserved_order_id=NULL, reserved_at=NULL WHERE id=? AND is_used=0 AND reserved_order_id IS NULL').bind(orderId, cardIds[i]));
  }
  if (!stmts.length) return 0;
  var results;
  if (env.DB.batch) results = await env.DB.batch(stmts);
  else { results = []; for (var j = 0; j < stmts.length; j++) results.push(await stmts[j].run()); }
  var total = 0;
  for (var k = 0; k < results.length; k++) total += Number((results[k] && results[k].meta && results[k].meta.changes) || 0);
  return total;
}
async function unmarkCards(env, orderId, cardIds) {
  // 补偿：将本轮标记的卡恢复为预留态（仅本订单标记的卡）。
  for (var i = 0; i < cardIds.length; i++) {
    await env.DB.prepare('UPDATE cards SET is_used=0, order_id=NULL, reserved_order_id=?, reserved_at=? WHERE id=? AND is_used=1 AND order_id=?').bind(orderId, nowISO(), cardIds[i], orderId).run();
  }
}
async function claimCardsForOrder(env, orderId, productId, qty) {
  // 返回 { ok, cardIds, newlyMarkedIds, codes }；失败时已标记的卡已补偿，不留半截占用。
  var cardIds = [], codes = [], newlyMarkedIds = [];
  // 1. 复用上次崩溃尝试已标记的卡（归属本订单）
  var claimed = await env.DB.prepare('SELECT id, code FROM cards WHERE product_id=? AND order_id=? AND is_used=1 ORDER BY id ASC').bind(productId, orderId).all();
  var claimedList = claimed.results || [];
  for (var i = 0; i < claimedList.length && cardIds.length < qty; i++) { cardIds.push(claimedList[i].id); codes.push(claimedList[i].code); }
  // 2. 本订单预留的卡 → 标记已用
  if (cardIds.length < qty) {
    var reserved = await env.DB.prepare('SELECT id, code FROM cards WHERE product_id=? AND reserved_order_id=? AND is_used=0 AND is_disabled=0 ORDER BY id ASC').bind(productId, orderId).all();
    var rlist = reserved.results || [];
    var toMark = [];
    for (var j = 0; j < rlist.length && cardIds.length + toMark.length < qty; j++) toMark.push(rlist[j]);
    if (toMark.length) {
      var marked = await markCardsUsed(env, orderId, toMark.map(function (c) { return c.id; }), 'reserved');
      if (marked !== toMark.length) {
        await unmarkCards(env, orderId, toMark.map(function (c) { return c.id; }).slice(0, marked));
        return { ok: false, reason: '卡密标记失败' };
      }
      for (var k = 0; k < toMark.length; k++) { cardIds.push(toMark[k].id); codes.push(toMark[k].code); newlyMarkedIds.push(toMark[k].id); }
    }
  }
  // 3. 兜底：预留不足时补抢可用卡（防御性，正常流程不应走到）
  if (cardIds.length < qty) {
    var need = qty - cardIds.length;
    var avail = await env.DB.prepare('SELECT id, code FROM cards WHERE product_id=? AND is_used=0 AND is_disabled=0 AND reserved_order_id IS NULL ORDER BY id ASC LIMIT ?').bind(productId, need).all();
    var alist = avail.results || [];
    if (alist.length < need) {
      await unmarkCards(env, orderId, newlyMarkedIds);
      return { ok: false, reason: 'out_of_stock' };
    }
    var marked2 = await markCardsUsed(env, orderId, alist.map(function (c) { return c.id; }), 'unreserved');
    if (marked2 !== alist.length) {
      await unmarkCards(env, orderId, alist.map(function (c) { return c.id; }).slice(0, marked2));
      await unmarkCards(env, orderId, newlyMarkedIds);
      return { ok: false, reason: '卡密标记失败' };
    }
    for (var m = 0; m < alist.length; m++) { cardIds.push(alist[m].id); codes.push(alist[m].code); newlyMarkedIds.push(alist[m].id); }
  }
  return { ok: true, cardIds: cardIds, newlyMarkedIds: newlyMarkedIds, codes: codes };
}
async function completeOrder(env, orderId, deliveryContent, statusSql, statusBinds) {
  // 条件完成订单（防并发重复完成）。成功时清空认领令牌。
  var sql = "UPDATE orders SET status='completed', delivery_content=?, fulfilled_at=?, claim_token='' WHERE id=? AND " + statusSql;
  var stmt = env.DB.prepare(sql);
  var binds = [deliveryContent, nowISO(), orderId].concat(statusBinds || []);
  var upd = await stmt.bind.apply(stmt, binds).run();
  if (!upd.meta || upd.meta.changes !== 1) return { ok: false, reason: '订单已被处理' };
  return { ok: true, mode: 'completed' };
}
async function releaseClaimedButUndeliveredCards(env, orderId) {
  // 释放已标记已用但订单未完成交付的卡（崩溃恢复残留 / 退款时）：这些卡未真正交付给客户，应恢复可用。
  // 仅当订单状态不是 completed 时调用（调用方保证：取消 / 确认退款路径）。
  var o = await env.DB.prepare('SELECT status FROM orders WHERE id=?').bind(orderId).first();
  if (o && o.status === 'completed') return;
  await env.DB.prepare('UPDATE cards SET is_used=0, order_id=NULL, reserved_order_id=NULL, reserved_at=NULL WHERE order_id=? AND is_used=1').bind(orderId).run();
}
async function fulfillAfterPayment(env, order, txHash, ctx, opts) {
  // 统一发货入口：轮询 / 手动 TXID / 管理员确认收款三条路径复用，禁止三份重复发货逻辑。
  // 并发安全：TXID 原子认领 → 订单原子认领（成功才继续）→ 副作用（上游/卡密）→ 条件完成。认领失败立即返回，绝不产生副作用。
  opts = opts || {};
  var txVerified = !!opts.txVerified; // 链上已验证的交易哈希（轮询 / TXID 核验）才做 TXID 认领；币安站内转账订单 ID 不是链上哈希，不认领。
  var fresh = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(order.id).first();
  if (!fresh) return { ok: false, reason: '订单不存在' };
  if (fresh.status === 'completed' || fresh.status === 'cancelled') return { ok: false, reason: '订单已被处理' };
  if (fresh.status === 'pending_activation' || fresh.status === 'pending_upstream' || fresh.status === 'refund_pending') return { ok: true, mode: fresh.status };
  if (fresh.status !== 'pending_payment') return { ok: false, reason: '当前状态不可发货' };
  var o = fresh;
  var prod = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(o.product_id).first();
  // 1. TXID 原子认领（仅链上已验证哈希才认领；管理员人工确认 txVerified=false 时不认领，避免未核验 TXID 永久污染 txid_claims）。
  // 严格先到先得：已有其他订单认领时拒绝，不接管（见 claimTxid）。
  var isChainHash = !!txHash && /^(0x)?[0-9a-fA-F]{64}$/.test(String(txHash)) && o.pay_method !== 'BinanceUID';
  if (isChainHash && txVerified) {
    var tc = await claimTxid(env, txHash, o.id);
    if (!tc.ok) return { ok: false, reason: tc.reason };
  }
  // 2. 订单原子认领（检查实际影响行数）
  var claim = await claimOrderForPayment(env, o.id, txHash);
  if (!claim.ok) return { ok: false, reason: claim.reason };
  var claimToken = claim.claimToken;
  var claimWhere = "status='pending_payment' AND claim_token=?";
  var claimBinds = [claimToken];
  // ---- 上游商品：调 ProdSeller 拿货 ----
  if (prod && prod.source === 'prodseller') {
    var settings = await getAllSettings(env);
    var cf = {}; try { cf = JSON.parse(o.customer_fields || '{}'); } catch (e) { cf = {}; }
    // 崩溃恢复：已有上游单号时只轮询状态，绝不重复采购。
    var existingUp = await env.DB.prepare('SELECT * FROM upstream_orders WHERE order_id = ? ORDER BY id DESC LIMIT 1').bind(o.id).first();
    if (existingUp && existingUp.prodseller_order_id) {
      var g = await prodsellerGetOrder(env, settings, existingUp.prodseller_order_id);
      if (g.ok) {
        var gst = upstreamStatusOf(g.data);
        var gkeys = upstreamKeysOf(g.data);
        await upsertUpstreamOrder(env, o.id, existingUp.prodseller_order_id, gst, upstreamAmountOf(g.data), gkeys);
        if (gst === 'delivered' && gkeys) {
          var compG = await completeOrder(env, o.id, gkeys, claimWhere, claimBinds);
          if (!compG.ok) return { ok: false, reason: compG.reason };
          var freshG = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first();
          await deliverWithCtx(ctx, sendOrderEmail(env, freshG, prod, 'delivered', gkeys));
          return { ok: true, mode: 'completed' };
        }
        var noteG = (gst === 'paid') ? '上游已付款待激活，轮询等待 delivered' : ('上游订单已存在（' + existingUp.prodseller_order_id + '），状态 ' + gst + '，等待轮询');
        await env.DB.prepare("UPDATE orders SET status='pending_activation', admin_note=? WHERE id=? AND claim_token=?").bind(noteG, o.id, claimToken).run();
        if (gst === 'paid') { var freshG2 = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first(); await deliverWithCtx(ctx, sendOrderEmail(env, freshG2, prod, 'activation', '')); }
        return { ok: true, mode: 'pending_activation' };
      }
      // 轮询失败：保持 pending_activation，下次轮询继续（不重复采购）
      await env.DB.prepare("UPDATE orders SET status='pending_activation', admin_note=? WHERE id=? AND claim_token=?").bind('上游订单已存在，轮询失败，等待下次轮询', o.id, claimToken).run();
      return { ok: true, mode: 'pending_activation' };
    }
    // 无上游单号：创建（Idempotency-Key=order_no，ProdSeller 侧去重；即使上次请求已发出但未保存响应，重试也不会重复扣费）。
    // ProdSeller 功能门禁（第四轮 P0）：门禁关闭时禁止发起真实采购，转 pending_upstream 等人工处理。
    if (String(settings.prodseller_enabled || '0') !== '1') {
      await env.DB.prepare("UPDATE orders SET status='pending_upstream', admin_note=? WHERE id=? AND claim_token=?").bind('上游门禁关闭（prodseller_enabled != 1），未发起真实采购，等待人工处理', o.id, claimToken).run();
      await upsertUpstreamOrder(env, o.id, '', 'gateway_closed', 0, '');
      return { ok: true, mode: 'pending_upstream', reason: 'gateway_closed' };
    }
    var cr = await prodsellerCreateOrder(env, settings, o, prod, cf);
    if (cr.status === 402) {
      await env.DB.prepare("UPDATE orders SET status='pending_upstream', admin_note=? WHERE id=? AND claim_token=?").bind('上游余额不足（402），后台置顶告警，不发货', o.id, claimToken).run();
      await upsertUpstreamOrder(env, o.id, '', 'insufficient_balance', 0, '');
      return { ok: true, mode: 'pending_upstream', reason: 'insufficient_balance' };
    }
    if (cr.status === 409) {
      await env.DB.prepare("UPDATE orders SET status='pending_upstream', admin_note=? WHERE id=? AND claim_token=?").bind('上游缺货（409），已标记缺货转人工', o.id, claimToken).run();
      await upsertUpstreamOrder(env, o.id, '', 'out_of_stock', 0, '');
      return { ok: true, mode: 'pending_upstream', reason: 'out_of_stock' };
    }
    if (cr.status === 429 || cr.status >= 500 || !cr.ok) {
      await env.DB.prepare("UPDATE orders SET status='pending_upstream', admin_note=? WHERE id=? AND claim_token=?").bind('上游调用失败 HTTP ' + cr.status + '，退避重试，下次轮询继续', o.id, claimToken).run();
      await upsertUpstreamOrder(env, o.id, '', 'upstream_error', 0, '');
      return { ok: true, mode: 'pending_upstream', reason: 'upstream_error' };
    }
    var st = upstreamStatusOf(cr.data);
    var psId = (cr.data && (cr.data.id || cr.data.orderId || cr.data.order_id)) || '';
    var keys = upstreamKeysOf(cr.data);
    await upsertUpstreamOrder(env, o.id, String(psId || ''), st, upstreamAmountOf(cr.data), keys);
    if (cr.data && cr.data.discount != null) { await env.DB.prepare('UPDATE orders SET admin_note=? WHERE id=? AND claim_token=?').bind('上游订单 ' + String(psId || '') + ' 金额 ' + upstreamAmountOf(cr.data) + ' 折扣 ' + upstreamDiscountOf(cr.data), o.id, claimToken).run(); }
    if (st === 'delivered' && keys) {
      var compU = await completeOrder(env, o.id, keys, claimWhere, claimBinds);
      if (!compU.ok) return { ok: false, reason: compU.reason };
      var fresh2 = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first();
      await deliverWithCtx(ctx, sendOrderEmail(env, fresh2, prod, 'delivered', keys));
      return { ok: true, mode: 'completed' };
    }
    if (st === 'paid') {
      await env.DB.prepare("UPDATE orders SET status='pending_activation', admin_note=? WHERE id=? AND claim_token=?").bind('上游已付款待激活，轮询等待 delivered', o.id, claimToken).run();
      var fresh3 = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first();
      await deliverWithCtx(ctx, sendOrderEmail(env, fresh3, prod, 'activation', ''));
      return { ok: true, mode: 'pending_activation' };
    }
    // 未知状态：不发货，等轮询
    await env.DB.prepare("UPDATE orders SET status='pending_activation', admin_note=? WHERE id=? AND claim_token=?").bind('上游返回未知状态 ' + st + '，等待轮询', o.id, claimToken).run();
    return { ok: true, mode: 'pending_activation' };
  }
  // ---- 自营商品 ----
  var stockType = prod ? prod.stock_type : 'manual';
  var category = prod ? prod.category : 'recharge';
  if (stockType === 'card' || category === 'account') {
    // 卡密：两阶段领取（可恢复）→ 条件完成。领取失败转人工，不吃卡。
    var cc = await claimCardsForOrder(env, o.id, o.product_id, o.quantity);
    if (!cc.ok) {
      if (cc.reason === 'out_of_stock') {
        await env.DB.prepare("UPDATE orders SET status='pending_fulfill', admin_note=? WHERE id=? AND claim_token=?").bind('out_of_stock: 库存不足待补货', o.id, claimToken).run();
        return { ok: true, mode: 'out_of_stock' };
      }
      await env.DB.prepare("UPDATE orders SET status='pending_fulfill', admin_note=? WHERE id=? AND claim_token=?").bind('卡密领取失败：' + cc.reason + '，待人工处理', o.id, claimToken).run();
      return { ok: true, mode: 'pending_fulfill', reason: cc.reason };
    }
    var compC = await completeOrder(env, o.id, cc.codes.join('\n'), claimWhere, claimBinds);
    if (!compC.ok) {
      // 订单完成失败：补偿本轮标记的卡（恢复为预留态），不留矛盾
      await unmarkCards(env, o.id, cc.newlyMarkedIds);
      return { ok: false, reason: compC.reason };
    }
    var fresh4 = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first();
    await deliverWithCtx(ctx, sendOrderEmail(env, fresh4, prod, 'delivered', cc.codes.join('\n')));
    return { ok: true, mode: 'completed' };
  }
  var up3 = await env.DB.prepare("UPDATE orders SET status='pending_fulfill', admin_note=? WHERE id=? AND claim_token=?").bind('轮询自动核验通过，等待人工代充', o.id, claimToken).run();
  if (!up3.meta || up3.meta.changes === 0) return { ok: false, reason: '订单已被处理' };
  var fresh5 = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first();
  await deliverWithCtx(ctx, sendOrderEmail(env, fresh5, prod, 'paid', ''));
  return { ok: true, mode: 'pending_fulfill' };
}
async function fulfillOrderByPayment(env, order, txHash, ctx, opts) {
  // 兼容旧名：直接复用 fulfillAfterPayment，不保留第二份发货逻辑
  return await fulfillAfterPayment(env, order, txHash, ctx, opts);
}
async function runPolling(env, fetchFn, ctx) {
  fetchFn = fetchFn || fetch;
  var settings = await getAllSettings(env);
  if (String(settings.poll_enabled || '1') === '0') return { ok: true, skipped: 'poll_disabled', checked: 0, fulfilled: 0, expired: 0 };
  var pending = await env.DB.prepare("SELECT * FROM orders WHERE status='pending_payment' AND pay_method != 'BinanceUID' ORDER BY id ASC LIMIT 100").all();
  var list = pending.results || [];
  if (!list.length) return { ok: true, checked: 0, fulfilled: 0, expired: 0, note: 'no pending, zero RPC' };
  var fulfilled = 0, expired = 0, checked = 0;
  for (var i = 0; i < list.length; i++) {
    var o = list[i];
    try {
      // 超时：仅未付款且未被认领的订单可自动取消；已确认付款（paid_at）或正在处理（claim_token）的订单绝不自动取消，走异常/恢复流程。
      if (o.expires_at && new Date(String(o.expires_at).replace(' ', 'T') + 'Z') < new Date()) {
        var ex = await env.DB.prepare("UPDATE orders SET status='cancelled', admin_note=? WHERE id=? AND status='pending_payment' AND paid_at IS NULL AND (claim_token IS NULL OR claim_token='')").bind('支付超时自动取消（20分钟未到账）', o.id).run();
        if (ex.meta && ex.meta.changes > 0) {
          expired++;
          await releaseReservation(env, o.id);
          var auditOk = await logAudit(env, o.id, 'auto_cancel_timeout', 'pending_payment', 'cancelled', '支付超时自动取消，释放卡密预留');
          if (!auditOk) console.error('audit failed: auto_cancel_timeout order=' + o.id);
        }
        continue;
      }
      checked++;
      await env.DB.prepare('UPDATE orders SET last_checked_at=? WHERE id=?').bind(nowISO(), o.id).run();
      var hit = null;
      try { hit = await checkChainPayment(env, fetchFn, o); } catch (e) { hit = null; }
      if (hit && hit.txHash) {
        // 账本：轮询发现 → 核验通过 → 确认数足够（checkChainPayment 已按各链确认策略过滤）→ 履约 → 入账。
        // event_key：EVM 为 logIndex，TRC20 为 block_ts:quant（区分同交易多笔转账）。
        var evKey = '';
        if (hit.logIndex != null && hit.logIndex !== '') evKey = String(hit.logIndex);
        else if (o.pay_chain === 'TRC20' && hit.blockTs) evKey = String(hit.blockTs) + ':' + String(hit.amount);
        var prec = await recordPayment(env, { order_id: o.id, chain: o.pay_chain, pay_address: o.pay_address || o.wallet_address, tx_hash: hit.txHash, event_key: evKey, amount: hit.amount != null ? hit.amount : (o.actual_amount || o.total_usdt), block_number: hit.blockNumber != null ? hit.blockNumber : null, confirmations: hit.confirmations != null ? hit.confirmations : 0, status: 'verified', reconcile_note: '轮询发现并核验通过' }).catch(function () { return null; });
        var payRow = prec && prec.payment ? prec.payment : null;
        if (payRow && payRow.status === 'posted') continue; // 已入账，跳过（防重复发货）
        // 金额必须与订单预期精确匹配，否则记 mismatch，不得履约（checkChainPayment 已按金额过滤，此处为二次防御）。
        if (!amountsEqual(hit.amount != null ? hit.amount : (o.actual_amount || o.total_usdt), o.actual_amount || o.total_usdt)) {
          if (payRow) { try { await updatePayment(env, payRow.id, { status: 'mismatch', reconcile_status: 'pending', reconcile_note: '金额与订单预期不符，需人工对账' }); } catch (e) {} }
          continue;
        }
        var r = await fulfillOrderByPayment(env, o, hit.txHash, ctx, { txVerified: true });
        if (r.ok && r.mode === 'completed') fulfilled++;
        if (r.ok && (r.mode === 'completed' || r.mode === 'pending_fulfill' || r.mode === 'out_of_stock' || r.mode === 'pending_activation' || r.mode === 'pending_upstream')) {
          if (payRow) { try { await updatePayment(env, payRow.id, { status: 'posted', confirmations: hit.confirmations != null ? hit.confirmations : 0 }); } catch (e) {} }
        }
      }
    } catch (e) { continue; }
  }
  // 全局 EVM 游标扫描（第四轮 P0）：补扫逐单检查可能漏掉的到账（回溯窗口不足 / 停机后恢复 / 延迟到账）。
  // 按链分组待付款订单，只扫有待付款订单的链与地址；游标持久化，RPC 失败不推进。
  try {
    var evmChains = {};
    list.forEach(function (o) { if (o.pay_chain && o.pay_chain !== 'TRC20' && o.pay_chain !== '站内转账') evmChains[o.pay_chain] = 1; });
    for (var ch in evmChains) {
      var chainOrders = list.filter(function (o) { return o.pay_chain === ch; });
      var scanRes = await scanEvmChain(env, fetchFn, ctx, ch, chainOrders);
      fulfilled += (scanRes.fulfilled || 0);
    }
  } catch (e) { /* 全局扫描失败不影响逐单结果，下次轮询重试 */ }
  return { ok: true, checked: checked, fulfilled: fulfilled, expired: expired };
}
function sanitizeOrderForPublic(o, level) {
  // level: 'full' = 凭证验证通过的本人，可看交付内容；'summary' = 仅看订单概要，绝不返回交付内容与客户隐私字段。
  // 内部字段（认领令牌、凭证哈希、旧查询密码）永不返回。
  if (!o) return null;
  var out = Object.assign({}, o);
  delete out.query_password;
  delete out.query_token_hash;
  delete out.claim_token;
  delete out.claimed_at;
  try { out.product_snapshot = JSON.parse(o.product_snapshot || '{}'); } catch (e) { out.product_snapshot = {}; }
  if (level === 'summary') {
    delete out.delivery_content;
    delete out.customer_fields;
    delete out.contact;
    delete out.txid;
    delete out.tx_hash;
    delete out.admin_note;
    delete out.wallet_address;
    delete out.pay_address;
    // 内部字段不公开：退款凭证（退款交易哈希）、内部异常原因、上游处理租约。
    delete out.refund_ref;
    delete out.exception_reason;
    delete out.upstream_lock;
    delete out.upstream_lock_expires_at;
  } else {
    try { out.customer_fields = JSON.parse(o.customer_fields || '{}'); } catch (e) { out.customer_fields = {}; }
    // 凭证验证通过的本人仍不返回内部字段（退款凭证、异常原因、上游租约仅管理员可见）。
    delete out.refund_ref;
    delete out.exception_reason;
    delete out.upstream_lock;
    delete out.upstream_lock_expires_at;
  }
  if (o.data_expired === 1 || isExpired7d(o.fulfilled_at)) {
    out.delivery_content = '';
    out.data_expired = 1;
  }
  return out;
}
// ---- 第四轮：Cloudflare Turnstile 服务端校验（可选开启）----
// 配置：settings.turnstile_enabled='1' 开启；settings.turnstile_site_key 为公开 site key（可存 settings）；
// 密钥必须经环境变量 TURNSTILE_SECRET_KEY 注入，绝不写进代码/settings/日志。
// 安全语义：开启后必须服务端校验 token；密钥缺失时 fail-closed（拒绝请求），绝不静默降级为无验证。
// 本地测试：经 env.__fetch 注入 mock fetch 拦截 siteverify 请求（生产环境无此 mock）。
// 服务不可用时：siteverify 返回非 success 或网络异常 → 拒绝请求（fail-closed），用户刷新重试。
async function verifyTurnstile(env, token, remoteIp) {
  var settings = await getAllSettings(env);
  if (String(settings.turnstile_enabled || '0') !== '1') return null; // 未开启：走 SVG 验证码路径（调用方决定）
  var secret = (env && env.TURNSTILE_SECRET_KEY) || '';
  if (!secret) return '反机器人验证未配置（Turnstile 密钥缺失），请联系管理员';
  if (!token) return '请完成反机器人验证';
  try {
    var res = await getFetch(env)('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'secret=' + encodeURIComponent(secret) + '&response=' + encodeURIComponent(String(token)) + (remoteIp ? '&remoteip=' + encodeURIComponent(remoteIp) : '')
    });
    var j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (!j || j.success !== true) return '反机器人验证失败，请刷新后重试';
    return null;
  } catch (e) {
    return '反机器人验证服务暂不可用，请稍后重试';
  }
}
// 验证码校验（一次性、5 分钟过期、最多试 3 次）：通过返回 null，不通过返回错误文案。
// 并发重放修复（第四轮 P0）：成功路径用单条原子 DELETE（WHERE id + code_hash）认领验证码，
// 两个并发请求同时验同一验证码时，只有一个 DELETE 能命中（changes=1），另一个 changes=0 视为已被消费，拒绝。
// 失败路径的 attempts 递增仍为尽力而为（并发下可能多获得一次尝试，但成功路径已原子化，无法绕过校验）。
async function verifyCaptcha(env, capId, capCode) {
  capId = String(capId || '').trim();
  capCode = String(capCode || '').trim().toUpperCase();
  if (!capId || !capCode) return '请填写图形验证码';
  var capRow = await env.DB.prepare('SELECT * FROM captcha_codes WHERE id = ?').bind(capId).first();
  if (!capRow || String(capRow.expires_at) < nowISO()) { if (capRow) { try { await env.DB.prepare('DELETE FROM captcha_codes WHERE id = ?').bind(capId).run(); } catch (e) {} } return '验证码已过期，请刷新后重试'; }
  if (Number(capRow.attempts) >= CAPTCHA_MAX_ATTEMPTS) { try { await env.DB.prepare('DELETE FROM captcha_codes WHERE id = ?').bind(capId).run(); } catch (e) {} return '验证码尝试次数过多，请刷新后重试'; }
  var inputHash = await sha256Hex(capCode);
  if (inputHash !== String(capRow.code_hash)) {
    var att = Number(capRow.attempts) + 1;
    if (att >= CAPTCHA_MAX_ATTEMPTS) { try { await env.DB.prepare('DELETE FROM captcha_codes WHERE id = ?').bind(capId).run(); } catch (e) {} return '验证码错误次数过多，请刷新后重试'; }
    try { await env.DB.prepare('UPDATE captcha_codes SET attempts = ? WHERE id = ?').bind(att, capId).run(); } catch (e) {}
    return '验证码错误，请重新输入';
  }
  // 成功：原子认领（DELETE 条件含 code_hash）。并发下只有一个请求能删到行，另一个视为已被消费。
  var del = await env.DB.prepare('DELETE FROM captcha_codes WHERE id = ? AND code_hash = ?').bind(capId, inputHash).run().catch(function () { return null; });
  if (!del || !del.meta || del.meta.changes !== 1) return '验证码已被使用，请刷新后重试';
  return null;
}
async function cleanupExpired(env) {
  // fulfilled_at 超过 7 天的已完成订单：清空交付数据并标记 data_expired
  await env.DB.prepare("UPDATE orders SET delivery_content = '', data_expired = 1 WHERE status = 'completed' AND data_expired = 0 AND fulfilled_at IS NOT NULL AND fulfilled_at < datetime('now', '-7 days')").run();
  // 清理过期 session
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  // 释放已不在待付款状态的订单仍占用的卡密预留（异常兜底）
  await releaseStaleReservations(env);
  return true;
}
// ---- 卡密预留：下单时预留，取消/超时释放，发货时优先分配预留卡 ----
// 预留失败返回 false（调用方不得静默创建注定无法交付的订单，必须删单并报错）。
async function reserveCards(env, orderId, productId, qty) {
  // 最多重试 3 轮：并发下若本轮抢到的卡被别人先占走，重新查可用卡再抢，避免误判缺货。
  for (var attempt = 0; attempt < 3; attempt++) {
    var rows = await env.DB.prepare('SELECT id FROM cards WHERE product_id = ? AND is_used = 0 AND is_disabled = 0 AND reserved_order_id IS NULL ORDER BY id ASC LIMIT ?').bind(productId, qty).all();
    var list = rows.results || [];
    if (list.length < qty) return false;
    var claimed = [];
    var ok = true;
    for (var i = 0; i < list.length; i++) {
      // 原子预留：只有“未用+未禁用+未被预留”才能抢到，防并发重复预留同一张卡
      var upd = await env.DB.prepare('UPDATE cards SET reserved_order_id = ?, reserved_at = ? WHERE id = ? AND is_used = 0 AND is_disabled = 0 AND reserved_order_id IS NULL').bind(orderId, nowISO(), list[i].id).run();
      if (upd.meta && upd.meta.changes === 1) claimed.push(list[i].id);
      else { ok = false; break; }
    }
    if (ok) return true;
    // 本轮部分被抢走：回滚已预留的，重试
    for (var j = 0; j < claimed.length; j++) {
      await env.DB.prepare('UPDATE cards SET reserved_order_id = NULL, reserved_at = NULL WHERE id = ? AND reserved_order_id = ?').bind(claimed[j], orderId).run();
    }
  }
  return false;
}
async function releaseReservation(env, orderId) {
  try { await env.DB.prepare('UPDATE cards SET reserved_order_id = NULL, reserved_at = NULL WHERE reserved_order_id = ? AND is_used = 0').bind(orderId).run(); } catch (e) {}
}
// 释放过期/异常订单的预留（日清理与轮询兜底用）：仅释放终态订单（已取消/已完成）的预留。
// 已付款待履约（pending_fulfill/pending_activation/pending_upstream/refund_pending）订单的预留必须保留，否则已付款订单的卡会被其他订单取走。
async function releaseStaleReservations(env) {
  try {
    await env.DB.prepare('UPDATE cards SET reserved_order_id = NULL, reserved_at = NULL WHERE is_used = 0 AND reserved_order_id IS NOT NULL AND reserved_order_id NOT IN (SELECT id FROM orders WHERE status NOT IN (\'cancelled\', \'completed\'))').run();
  } catch (e) {}
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
  // 数据库迁移（版本化、轻量检查）：版本已是最新时只查一次版本号，不跑 PRAGMA/DDL/数据修复。
  // 迁移失败时抛错，由顶层返回明确的迁移失败信息，不得伪装成功。
  await ensureMigrated(env);

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
      cny_rate: Number(s.cny_rate || 7.2) || 7.2,
      // Turnstile：仅暴露开关与公开 site key（密钥绝不经公开接口返回）。
      turnstile_enabled: String(s.turnstile_enabled || '0') === '1',
      turnstile_site_key: String(s.turnstile_site_key || '')
    }});
  }

  // ---- 公开：商品 ----
  if (path === '/api/products' && method === 'GET') {
    var pr = await env.DB.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY sort ASC, id ASC').all();
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
    var soldCount = 0;
    try { var soldRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM orders WHERE product_id = ? AND status = 'completed'").bind(Number(mProd[1])).first(); soldCount = Number((soldRow && soldRow.c) || 0); } catch (e) { soldCount = 0; }
    var cm1 = await cardStockMap(env);
    return json({ ok: true, product: { id: one.id, slug: one.slug, title: one.title, category: one.category, price_usdt: getEffectivePrice(one), sell_price: getEffectivePrice(one), stock_type: one.stock_type, description: one.description, notice: one.notice, form_fields: ff, image_emoji: one.image_emoji, image_data: one.image_data || '', source: one.source || 'self', prodseller_id: one.prodseller_id || '', requires_email_activation: Number(one.requires_email_activation || 0), delivery_method: one.delivery_method || 'both', in_stock: realInStock(one, cm1), sold_count: soldCount } });
  }

  // ---- 公开：图形验证码 ----
  if (path === '/api/captcha' && method === 'GET') {
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
    // 人机验证：Turnstile 开启时服务端校验 Turnstile token（fail-closed）；未开启时走 SVG 验证码（一次性、5 分钟过期、最多试 3 次）。
    // Turnstile 密钥缺失时 verifyTurnstile 返回错误，绝不静默降级为无验证。
    var settingsForCaptcha = await getAllSettings(env);
    if (String(settingsForCaptcha.turnstile_enabled || '0') === '1') {
      var tsErr = await verifyTurnstile(env, body.turnstile_token, getClientIp(req));
      if (tsErr) return err(tsErr);
    } else {
      var capErrOrder = await verifyCaptcha(env, body.captcha_id, body.captcha_code);
      if (capErrOrder) return err(capErrOrder);
    }
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
    var clientIp = getClientIp(req);
    var winStart = new Date(Date.now() - ORDER_RATE_WINDOW_MS).toISOString().replace('T', ' ').slice(0, 19);
    try { await env.DB.prepare('DELETE FROM order_rate WHERE created_at < ?').bind(winStart).run(); } catch (e) {}
    var rc = await env.DB.prepare('SELECT COUNT(*) as c FROM order_rate WHERE ip = ?').bind(clientIp).first();
    if (rc && Number(rc.c) >= ORDER_RATE_LIMIT) return err('下单过于频繁，请 10 分钟后再试');
    try { await env.DB.prepare('INSERT INTO order_rate (ip, created_at) VALUES (?, ?)').bind(clientIp, nowISO()).run(); } catch (e) {}

    var prod = await env.DB.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').bind(productId).first();
    if (!prod) return err('商品不存在', 404);
    // ProdSeller 功能门禁（第四轮 P0）：上游真实行为（Idempotency-Key、状态枚举、402/409/429 语义、限速）尚未获得真实服务商证据，
    // 默认关闭。门禁关闭时，上游商品禁止下单，避免进入真实自动采购流程。解除门禁需在 RELEASE_READINESS 中提供证据并由管理员显式开启。
    var settingsEarly = await getAllSettings(env);
    if (prod.source === 'prodseller' && String(settingsEarly.prodseller_enabled || '0') !== '1') {
      return err('该商品暂未开放购买（上游服务验证中，请联系客服）', 403);
    }
    var fields = []; try { fields = JSON.parse(prod.form_fields || '[]'); } catch (e) { fields = []; }
    var cust = body.customer_fields || {};
    if (typeof cust !== 'object') return err('客户字段无效');
    for (var i = 0; i < fields.length; i++) {
      if (isLegacyContactField(fields[i])) continue; // 第七轮：旧默认联系方式字段已废弃，不再因它必填而拒单
      if (fields[i].required && !String(cust[fields[i].key] || '').trim()) return err('请填写：' + fields[i].label);
    }
    // 三种邮箱校验：contact_email（所有订单）/ delivery_email（邮件发货类）/ activation_email（激活类）
    var contactEmail = String(cust.contact_email || body.contact || '').trim();
    var deliveryEmail = String(cust.delivery_email || '').trim();
    var activationEmail = String(cust.activation_email || '').trim();
    var activationConfirm = String(cust.activation_email_confirm || '').trim();
    // 第七轮兼容回退：需要邮件交付且 delivery_email 为空时，若 contact 为有效邮箱则回填 delivery_email。
    // 仅接受有效邮箱格式，Telegram 用户名等非邮箱文本不回填；仅对需要邮件交付的商品生效。
    var _dmForFallback = prod.delivery_method || 'both';
    var _needsEmailDelivery = (_dmForFallback === 'email' || _dmForFallback === 'both') && prod.source === 'self' && (prod.stock_type === 'card' || prod.category === 'account');
    if (_needsEmailDelivery && !deliveryEmail) {
      var _fallbackEmail = '';
      if (validEmail(contactEmail)) _fallbackEmail = contactEmail;
      else if (validEmail(String(body.contact || '').trim())) _fallbackEmail = String(body.contact || '').trim();
      if (_fallbackEmail) { deliveryEmail = _fallbackEmail; cust.delivery_email = _fallbackEmail; }
    }
    // 统一持久化：contact_email / delivery_email 以规范化（trim 后）值落库，避免主表与 customer_fields 不一致。
    if (contactEmail) cust.contact_email = contactEmail;
    if (deliveryEmail) cust.delivery_email = deliveryEmail;
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
    // 服务端统一库存校验（不能只靠前端按钮）：缺货商品直接拦截，绕过前端也无法下单。
    // 自营卡密/成品号走下单后预留（预留失败则删单报错）；对接/人工商品查 in_stock。
    if (prod.source === 'prodseller') {
      if (Number(prod.in_stock == null ? 1 : prod.in_stock) === 0) return err('商品缺货，补货中');
    } else if (!(prod.stock_type === 'card' || prod.category === 'account')) {
      if (Number(prod.in_stock == null ? 1 : prod.in_stock) === 0) return err('商品缺货，补货中');
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
    // 新订单不再生成可用的明文六位查询密码：query_password 写空值（字段保留兼容旧订单）。
    // 查单凭证：高强度不可预测（128 位），只存 SHA-256 哈希，只在创建订单时返回一次；旧订单无此字段，走旧密码兼容路径。
    var queryToken = randomHex(16);
    var queryTokenHash = await sha256Hex(queryToken);
    var effPrice = getEffectivePrice(prod);
    var total = Math.round(effPrice * qty * 100) / 100;
    var actualAmount = total;
    var expiresAt = fmtTsPlusMinutes(POLL_LOCK_MINUTES);
    if (body.pay_method !== 'BinanceUID') {
      actualAmount = await genActualAmount(env, total, wallet);
    }
    var snapshot = JSON.stringify({ id: prod.id, slug: prod.slug, title: prod.title, category: prod.category, price_usdt: effPrice, source: prod.source || 'self', requires_email_activation: Number(prod.requires_email_activation || 0), delivery_method: prod.delivery_method || 'both' });
    // INSERT 原子重试（第四轮 P0）：SELECT 查重有 TOCTOU 窗口，真正的原子保障是 v8 唯一索引。
    // 金额冲突（pay_address + actual_amount）→ 重新生成金额并重试，最多 5 次；联系人冲突（contact + product_id）→ 返回明确重复提示。
    // 冲突时绝不静默复用冲突金额，也绝不把联系人冲突误判为金额冲突。
    var insertedOrderNo = null;
    for (var insAttempt = 0; insAttempt < 5; insAttempt++) {
      try {
        await env.DB.prepare('INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(orderNo, '', queryTokenHash, productId, snapshot, qty, effPrice, total, actualAmount, wallet, expiresAt, JSON.stringify(cust), contact, body.pay_method, body.pay_chain, wallet, 'pending_payment', nowISO()).run();
        insertedOrderNo = orderNo;
        break;
      } catch (e) {
        var emsg = String((e && e.message) || e || '');
        var isUnique = /UNIQUE constraint/i.test(emsg) || /unique/i.test(emsg);
        if (!isUnique) throw e;
        // 联系人冲突：contact + product_id 唯一索引（部分索引，列名含 contact）
        if (/contact/i.test(emsg)) return err('该联系方式已有一笔待付款订单，请先完成付款或等它超时取消后再下单');
        // 金额冲突：重新生成金额并重试（非 BinanceUID 才有随机尾数；BinanceUID 金额 = total，无随机尾数，不重试）
        if (body.pay_method === 'BinanceUID') throw e;
        if (insAttempt >= 4) return err('系统繁忙，金额分配冲突，请稍后重试');
        actualAmount = await genActualAmount(env, total, wallet);
        continue;
      }
    }
    if (!insertedOrderNo) return err('系统繁忙，请稍后重试');
    // 自营卡密/成品号：下单后立即预留卡密；预留失败说明已被别人抢完，删单并报错，绝不静默创建注定无法交付的订单。
    if (prod.source === 'self' && (prod.stock_type === 'card' || prod.category === 'account')) {
      var newOrder = await env.DB.prepare('SELECT id FROM orders WHERE order_no = ?').bind(orderNo).first();
      if (!newOrder || !(await reserveCards(env, newOrder.id, productId, qty))) {
        await env.DB.prepare('DELETE FROM orders WHERE order_no = ?').bind(orderNo).run();
        return err('卡密库存不足，补货中');
      }
    }
    // 订单确认邮件（waitUntil，不阻塞下单响应）
    try { var createdOrder = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first(); if (createdOrder) deliverWithCtx(ctx, sendOrderEmail(env, createdOrder, prod, 'confirm', '')); } catch (e) {}
    return json({ ok: true, order: { order_no: orderNo, query_token: queryToken, total_usdt: total, actual_amount: actualAmount, pay_address: wallet, expires_at: expiresAt, wallet_address: wallet, pay_method: body.pay_method, pay_chain: body.pay_chain } });
  }

  // ---- 公开：查单 ----
  // 公开查单限流：同一 IP 每 10 分钟最多 30 次，防枚举与滥用。计数失败不阻塞查询（限流本身不可用时放行，但记录）。
  async function checkLookupRateLimit(env, req) {
    var ip = getClientIp(req);
    var winStart = new Date(Date.now() - LOOKUP_RATE_WINDOW_MS).toISOString().replace('T', ' ').slice(0, 19);
    try { await env.DB.prepare('DELETE FROM lookup_rate WHERE created_at < ?').bind(winStart).run(); } catch (e) {}
    var c = await env.DB.prepare('SELECT COUNT(*) as n FROM lookup_rate WHERE ip = ?').bind(ip).first();
    if (c && Number(c.n) >= LOOKUP_RATE_LIMIT) return '查单过于频繁，请 10 分钟后再试';
    try { await env.DB.prepare('INSERT INTO lookup_rate (ip, created_at) VALUES (?, ?)').bind(ip, nowISO()).run(); } catch (e) {}
    return null;
  }
  // 按邮箱查订单列表：已关闭（第四轮 P0，E-02）。邮箱本身不是身份凭证，仅凭邮箱即可枚举购买历史属隐私泄露。
  // 统一入口：订单号 + 高强度查单凭证（POST /api/orders/:no/lookup）。无邮箱 OTP 兼容路径（邮件已移除，无法发送 OTP）。
  if (path === '/api/orders' && method === 'GET') {
    return err('邮箱查单已关闭，请使用订单号 + 查单凭证查询（下单成功页展示一次）', 410);
  }
  // GET 单订单：仅返回概要（不含交付内容与客户隐私），绝不经 URL 凭证返回敏感数据。
  // 完整详情必须走 POST /api/orders/:no/lookup（凭证在请求体中，不进 URL/日志）。
  var mOrderNo = path.match(/^\/api\/orders\/([^\/]+)$/);
  if (mOrderNo && method === 'GET') {
    var no = decodeURIComponent(mOrderNo[1]);
    var ord = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(no).first();
    if (!ord) return err('订单不存在', 404);
    return json({ ok: true, order: sanitizeOrderForPublic(ord, 'summary') });
  }
  // POST 查单验证：凭证在请求体中。正确凭证 → 完整详情（含交付内容）；旧订单正确旧密码 → 仅概要。
  var mLookup = path.match(/^\/api\/orders\/([^\/]+)\/lookup$/);
  if (mLookup && method === 'POST') {
    var lb2 = await parseJsonBody(req);
    var cred = String(lb2.token || lb2.credential || lb2.password || '').trim();
    if (!cred) return err('请提供查单凭证（新订单）或旧查询密码（旧订单）', 401);
    var rateErrLookup = await checkLookupRateLimit(env, req);
    if (rateErrLookup) return err(rateErrLookup, 429);
    var noL = decodeURIComponent(mLookup[1]);
    var ordL = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(noL).first();
    if (!ordL) return err('订单不存在', 404);
    // 新订单（有凭证哈希）：验证凭证哈希，验证通过返回完整详情。
    if (ordL.query_token_hash) {
      if ((await sha256Hex(cred)) !== ordL.query_token_hash) return err('查单凭证错误', 401);
      return json({ ok: true, order: sanitizeOrderForPublic(ordL, 'full') });
    }
    // 旧订单（无凭证哈希）：用旧查询密码验证，但只返回概要，不返回交付内容与客户隐私（需交付内容请联系客服）。
    if (cred && cred === ordL.query_password && ordL.query_password) return json({ ok: true, order: sanitizeOrderForPublic(ordL, 'summary'), legacy: true });
    return err('查单凭证或旧查询密码错误，请联系客服获取交付内容', 401);
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
    // /pay 独立限流（第四轮 P0）：同一订单 10 分钟最多 5 次，同一 IP 10 分钟最多 20 次。
    // 受限不影响后台轮询继续核验已到账的付款，订单不会因限流永久无法处理。
    var payRateErr = await checkPayRateLimit(env, req, no2);
    if (payRateErr) return err(payRateErr, 429);
    // 付款账本：提交时先记一笔 submitted（event_key 未知为空，核验后回填）。同一 (chain, tx_hash, '') 重复提交不重复建行。
    // BinanceUID 无链上 TXID，不记链上付款账本（站内转账走管理员手动核对）。
    var payRec = null;
    if (o2.pay_method !== 'BinanceUID') {
      try { var pr = await recordPayment(env, { order_id: o2.id, chain: o2.pay_chain, pay_address: o2.pay_address || o2.wallet_address, tx_hash: txid, event_key: '', amount: o2.actual_amount || o2.total_usdt, status: 'submitted', reconcile_note: '用户经 /pay 提交' }); payRec = pr.payment || null; } catch (e) { payRec = null; }
    }
    // 币安 UID 站内转账：无链上 TXID，只存内部订单 ID，走手动核对
    if (o2.pay_method === 'BinanceUID') {
      await env.DB.prepare('UPDATE orders SET txid = ?, tx_hash = ? WHERE order_no = ?').bind(txid, txid, no2).run();
      return json({ ok: true, message: '已提交币安订单 ID，请等待管理员核对', auto: false });
    }
    // 链上：可选兜底，按需核验同一 TXID，成功即自动发货（链上核验通过 = 链上证明）。
    // TXID 认领严格先到先得：若该 TXID 已被其他订单认领，返回明确错误，不静默接受为“已提交”（否则客户误以为付款成功，实际订单永远无法认领）。
    var hit = null;
    try { hit = await checkTxidPayment(env, fetch, o2, txid); } catch (e) { hit = null; }
    if (hit && hit.txHash) {
      // 核验通过：账本推进为 verified/confirmed（确认数由 checkTxidPayment 的 1 确认口径保证；全局确认策略见 runPolling）。
      if (payRec) { try { await updatePayment(env, payRec.id, { status: 'verified', confirmations: 1 }); } catch (e) {} }
      var fr = await fulfillOrderByPayment(env, o2, hit.txHash, ctx, { txVerified: true });
      if (fr.ok && (fr.mode === 'completed' || fr.mode === 'pending_fulfill' || fr.mode === 'out_of_stock')) {
        if (payRec) { try { await updatePayment(env, payRec.id, { status: 'posted' }); } catch (e) {} }
      }
      if (fr.ok && fr.mode === 'completed') return json({ ok: true, message: '核验通过，已自动发货', auto: true });
      if (fr.ok && fr.mode === 'pending_fulfill') return json({ ok: true, message: '核验通过，已自动派单，等待人工代充', auto: true });
      if (fr.ok && fr.mode === 'out_of_stock') return json({ ok: true, message: '核验通过但库存不足，已转人工处理', auto: true });
      if (fr.reason && /已用于其他订单/.test(fr.reason)) {
        // 账本：该 TXID 已归属其他订单，标记 duplicate（需人工对账，不得静默接受）。
        if (payRec) { try { await updatePayment(env, payRec.id, { status: 'duplicate', reconcile_status: 'pending', reconcile_note: 'TXID 已用于其他订单' }); } catch (e) {} }
        return err('该交易哈希已用于其他订单，请勿重复提交；如确认归属有误请联系客服', 409);
      }
    }
    await env.DB.prepare('UPDATE orders SET txid = ? WHERE order_no = ?').bind(txid, no2).run();
    return json({ ok: true, message: 'TXID 已提交，轮询会在 1-3 分钟内自动核验；若链上还未确认请稍后再查', auto: false });
  }

  // ---- 管理员：登录 / 退出 / 改密 ----
  if (path === '/api/admin/login' && method === 'POST') {
    var lb = await parseJsonBody(req);
    var pw = String(lb.password || '');
    if (!pw) return err('请输入密码');
    // 登录限流：同一 IP 失败过多时封禁 15 分钟，防暴力破解
    var loginIp = getClientIp(req);
    var rateErr = await checkLoginRateLimit(env, loginIp);
    if (rateErr) return err(rateErr, 429);
    // 全局限流（第四轮 P0）：全站 15 分钟内失败超 30 次时，全部登录拒绝 5 分钟，防换 IP 分布式暴力破解。
    var globalRateErr = await checkLoginGlobalRateLimit(env);
    if (globalRateErr) return err(globalRateErr, 429);
    var storedHash = await getAdminMeta(env, 'password_hash');
    var storedSalt = await getAdminMeta(env, 'password_salt');
    var mustChange = (await getAdminMeta(env, 'must_change_password')) === '1';
    if (!storedHash) {
      if (pw !== 'admin') { await recordLoginFail(env, loginIp); await recordLoginFailGlobal(env); return err('密码错误', 401); }
      mustChange = true;
    } else {
      var h = await hashPassword(pw, storedSalt || '');
      if (h !== storedHash) { await recordLoginFail(env, loginIp); await recordLoginFailGlobal(env); return err('密码错误', 401); }
    }
    await clearLoginAttempts(env, loginIp);
    var token = randomHex(32);
    var exp = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString().replace('T', ' ').slice(0, 19);
    await env.DB.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').bind(token, exp).run();
    var resp = json({ ok: true, must_change_password: mustChange });
    resp.headers.set('Set-Cookie', 'session_token=' + token + '; ' + cookieFlags(url) + '; Max-Age=' + SESSION_MAX_AGE);
    return resp;
  }
  if (path === '/api/admin/logout' && method === 'POST') {
    var tok = getCookie(req, 'session_token');
    if (tok) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(tok).run();
    var r2 = json({ ok: true });
    r2.headers.set('Set-Cookie', 'session_token=; ' + cookieFlags(url) + '; Max-Age=0');
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
    // 改密是管理端写操作，必须同样做 CSRF 校验（本接口在通用 CSRF 检查之前，需单独校验）。
    var csrfErrPw = checkCsrf(req, url);
    if (csrfErrPw) return err(csrfErrPw, 403);
    var cb = await parseJsonBody(req);
    var oldPw = String(cb.old_password || '');
    var newPw = String(cb.new_password || '');
    if (newPw.length < 8) return err('新密码至少 8 位');
    if (newPw.length > 128) return err('新密码过长（最多 128 位）');
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
    // 改密后作废除当前会话外的所有会话（防被盗会话继续使用），当前会话保留以免锁死管理员
    var curTok = getCookie(req, 'session_token');
    if (curTok) await env.DB.prepare('DELETE FROM sessions WHERE token != ?').bind(curTok).run();
    return json({ ok: true });
  }

  // ---- 管理员：需要登录的接口 ----
  var admin = await requireAdmin(env, req);
  var isAdminPath = path.indexOf('/api/admin/') === 0;
  if (isAdminPath && !admin) return err('未登录', 401);
  // 改密拦截：未完成改密的会话只能访问 me / change-password / logout，其余管理接口一律拒绝（不能只靠前端隐藏菜单）。
  if (isAdminPath && admin) {
    var mustCh = (await getAdminMeta(env, 'must_change_password')) === '1';
    var hasH = !!(await getAdminMeta(env, 'password_hash'));
    var mustChangeNow = mustCh || !hasH;
    var allowedWhenMustChange = (path === '/api/admin/me' || path === '/api/admin/change-password' || path === '/api/admin/logout');
    if (mustChangeNow && !allowedWhenMustChange) return err('请先修改初始密码', 403);
  }
  // CSRF：管理端写操作（POST/PUT/DELETE）带 Origin 时必须同源
  if (isAdminPath && admin && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
    var csrfErr = checkCsrf(req, url);
    if (csrfErr) return err(csrfErr, 403);
  }

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
    var dateFrom = (url.searchParams.get('date_from') || '').trim();
    var dateTo = (url.searchParams.get('date_to') || '').trim();
    var page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    var pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20', 10) || 20));
    var sql = 'SELECT * FROM orders WHERE 1=1';
    var countSql = 'SELECT COUNT(*) as c FROM orders WHERE 1=1';
    var binds = [];
    if (st && ORDER_STATUSES.indexOf(st) !== -1) { sql += ' AND status = ?'; countSql += ' AND status = ?'; binds.push(st); }
    if (q) { sql += ' AND (order_no LIKE ? OR contact LIKE ? OR txid LIKE ?)'; countSql += ' AND (order_no LIKE ? OR contact LIKE ? OR txid LIKE ?)'; binds.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
    if (dateFrom) { sql += ' AND created_at >= ?'; countSql += ' AND created_at >= ?'; binds.push(dateFrom); }
    if (dateTo) { sql += ' AND created_at <= ?'; countSql += ' AND created_at <= ?'; binds.push(dateTo + ' 23:59:59'); }
    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    var stmt = env.DB.prepare(sql);
    var cstmt = env.DB.prepare(countSql);
    var allBinds = binds.concat([pageSize, (page - 1) * pageSize]);
    stmt = stmt.bind.apply(stmt, allBinds);
    if (binds.length) cstmt = cstmt.bind.apply(cstmt, binds);
    var orr = await stmt.all();
    var totalRow = await cstmt.first();
    var total = Number((totalRow && totalRow.c) || 0);
    var list = (orr.results || []).map(function (x) { return sanitizeOrderForPublic(x); });
    return json({ ok: true, orders: list, total: total, page: page, page_size: pageSize, total_pages: Math.max(1, Math.ceil(total / pageSize)) });
  }
  var mAdminOrder = path.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (mAdminOrder && method === 'GET') {
    var oneOrd = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(Number(mAdminOrder[1])).first();
    if (!oneOrd) return err('订单不存在', 404);
    return json({ ok: true, order: sanitizeOrderForPublic(oneOrd) });
  }
  var mConfirm = path.match(/^\/api\/admin\/orders\/(\d+)\/confirm-payment$/);
  if (mConfirm && method === 'POST') {
    var oid = Number(mConfirm[1]);
    var oo = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(oid).first();
    if (!oo) return err('订单不存在', 404);
    if (oo.status !== 'pending_payment') return err('当前状态不可确认收款');
    // 管理员确认收款复用同一 fulfillAfterPayment：自营卡密自动发，上游商品走 ProdSeller 拿货（不要只发本地卡密）。
    // 管理员确认无新鲜链上证明（txVerified=false）：不认领 TXID（避免未核验 TXID 污染 txid_claims）；管理员已在系统外核对到账，确认即发货。
    var cbConfirm = await parseJsonBody(req);
    var confirmReason = String(cbConfirm.reason || cbConfirm.admin_note || '').trim();
    var cr2 = await fulfillAfterPayment(env, oo, oo.tx_hash || oo.txid || '', ctx, { txVerified: false });
    if (!cr2.ok) return err(cr2.reason || '发货失败');
    var afterSt = (await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(oid).first() || {}).status || oo.status;
    var auditOkC = await logAudit(env, oid, 'confirm_payment', 'pending_payment', afterSt, '管理员人工确认收款' + (confirmReason ? '，原因：' + confirmReason : ''));
    if (!auditOkC) return err(auditFailMsg(oid, 'confirm_payment'), 500);
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
    // 状态机：待付款订单不能直接发货（必须先确认收款）；已完成/已取消为终态，不可发货。
    // 待发货 / 激活待处理 / 上游异常 / 退款待处理可由管理员手动发货（显式兜底，如上游卡住时手动交付；退款待处理发货后退款不再需要）。
    if (fo.status === 'pending_payment') return err('待付款订单不能直接发货，请先确认收款');
    if (fo.status === 'completed' || fo.status === 'cancelled') return err('当前状态不可发货');
    var fp = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(fo.product_id).first();
    var delivery = String(fb.delivery_content || '').trim();
    var autoAssigned = null; // 自动发卡时记录本轮新标记的卡，供完成失败时补偿
    if (fp && fp.stock_type === 'card' && !delivery) {
      // 自动发卡：两阶段领取（可恢复）→ 条件完成。领取失败返回错误，不吃卡。
      var ccF = await claimCardsForOrder(env, fid, fo.product_id, fo.quantity);
      if (!ccF.ok) return err(ccF.reason === 'out_of_stock' ? '卡密库存不足，请先导入卡密或手动填写交付内容' : ('卡密领取失败：' + ccF.reason));
      delivery = ccF.codes.join('\n');
      autoAssigned = ccF.newlyMarkedIds;
    }
    if (!delivery) return err('请填写交付内容');
    var fulfillNote = String(fb.admin_note || '').trim();
    var upF = await env.DB.prepare("UPDATE orders SET status='completed', delivery_content=?, admin_note=?, paid_at=COALESCE(paid_at, ?), fulfilled_at=?, refund_status='', exception_reason='', claim_token='' WHERE id=? AND status IN ('pending_fulfill','pending_activation','pending_upstream','refund_pending')").bind(delivery, fulfillNote, nowISO(), nowISO(), fid).run();
    if (!upF.meta || upF.meta.changes === 0) {
      // 完成失败（并发下已被其他操作处理）：补偿本轮自动标记的卡
      if (autoAssigned && autoAssigned.length) await unmarkCards(env, fid, autoAssigned);
      return err('当前状态不可发货（可能已被其他操作处理）');
    }
    // 人工填写交付内容完成：释放该订单尚未使用的预留卡（必须在完成状态转换成功后释放，不提前、不释放他人卡）。
    // 自动发卡时预留卡已转为已用，releaseReservation 只释放 is_used=0 的预留卡，不会误释放已用卡。
    await releaseReservation(env, fid);
    var auditOkF = await logAudit(env, fid, 'fulfill', fo.status, 'completed', '管理员手动发货' + (fulfillNote ? '，备注：' + fulfillNote : ''));
    if (!auditOkF) return err(auditFailMsg(fid, 'fulfill'), 500);
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
    // 已付款订单保护：pending_fulfill / pending_activation / pending_upstream / refund_pending 均为已付款状态，不得普通取消。
    // pending_payment 但 paid_at 已设置（已确认付款、处理中或处理崩溃待恢复）同样不得普通取消。
    if (co.status !== 'pending_payment') {
      return err('已付款订单不能通过普通取消接口取消（当前状态：' + co.status + '）。如无法交付请走异常处理（标记退款待处理），本系统不执行真实退款，须在系统外退款后点“确认已退款”。', 409);
    }
    if (co.paid_at) {
      return err('该订单已确认付款（处理中），不能普通取消。如无法交付请走异常处理流程。', 409);
    }
    var cancelReason = String(cb2.reason || cb2.admin_note || '').trim();
    // 条件取消：仅未付款、未被认领的待付款订单。并发下付款认领与取消只允许一个成功。
    var upC = await env.DB.prepare("UPDATE orders SET status='cancelled', admin_note=? WHERE id=? AND status='pending_payment' AND paid_at IS NULL AND (claim_token IS NULL OR claim_token='')").bind(cancelReason, cid).run();
    if (!upC.meta || upC.meta.changes === 0) return err('当前状态不可取消（可能已被其他操作处理或已确认付款）');
    // 取消时释放本订单的卡密预留（仅 is_used=0 的预留卡）
    await releaseReservation(env, cid);
    var auditOkX = await logAudit(env, cid, 'cancel', co.status, 'cancelled', '管理员取消订单' + (cancelReason ? '，原因：' + cancelReason : ''));
    if (!auditOkX) return err(auditFailMsg(cid, 'cancel'), 500);
    return json({ ok: true });
  }
  // ---- 已付款订单异常处理（第二轮 P0）----
  // 原则：已付款订单不得普通取消；无完整退款系统，不得假装退款；不得把“记录原因”当作退款已完成。
  // 流程：exception（标记退款待处理，状态→refund_pending）→ 管理员在系统外真实退款 → refund-confirm（确认已退款，状态→cancelled）。
  // refund-confirm 不执行任何资金操作，只是记录“管理员确认已在系统外完成退款”这一事实。
  var mException = path.match(/^\/api\/admin\/orders\/(\d+)\/exception$/);
  if (mException && method === 'POST') {
    var eb = await parseJsonBody(req);
    var eid = Number(mException[1]);
    var eo = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(eid).first();
    if (!eo) return err('订单不存在', 404);
    if (eo.status === 'completed' || eo.status === 'cancelled') return err('当前状态不可标记异常');
    var exReason = String(eb.reason || '').trim();
    if (!exReason) return err('请填写异常原因');
    var exNote = String(eb.note || eb.admin_note || '').trim();
    var refundNeeded = !!eb.refund_needed;
    if (refundNeeded) {
      // 退款仅针对已付款订单：未付款（pending_payment / paid_at 为空）的订单没有收到钱，无需退款，应直接取消，不得制造幽灵退款义务。
      if (eo.status === 'pending_payment' || !eo.paid_at) return err('未付款订单无需退款，请直接取消订单');
      var upE = await env.DB.prepare("UPDATE orders SET status='refund_pending', refund_status='pending', exception_reason=?, admin_note=? WHERE id=? AND status IN ('pending_fulfill','pending_activation','pending_upstream') AND paid_at IS NOT NULL").bind(exReason, exNote, eid).run();
      if (!upE.meta || upE.meta.changes === 0) return err('当前状态不可标记异常（可能已被处理）');
      var auditOkE = await logAudit(env, eid, 'order_exception', eo.status, 'refund_pending', '异常处理：标记退款待处理，原因：' + exReason + (exNote ? '，备注：' + exNote : ''));
      if (!auditOkE) return err(auditFailMsg(eid, 'order_exception'), 500);
      return json({ ok: true, message: '已标记为退款待处理。注意：本系统不执行真实退款，请在系统外完成退款后点“确认已退款”。' });
    }
    // 不需要退款：仅记录异常原因与审计，状态不变（后续可重试 / 手动发货）。
    await env.DB.prepare('UPDATE orders SET exception_reason=?, admin_note=? WHERE id=?').bind(exReason, exNote, eid).run();
    var auditOkE2 = await logAudit(env, eid, 'order_exception_note', eo.status, eo.status, '异常记录（不退款）：' + exReason + (exNote ? '，备注：' + exNote : ''));
    if (!auditOkE2) return err(auditFailMsg(eid, 'order_exception_note'), 500);
    return json({ ok: true, message: '异常原因已记录，订单状态未变。' });
  }
  var mRefundConfirm = path.match(/^\/api\/admin\/orders\/(\d+)\/refund-confirm$/);
  if (mRefundConfirm && method === 'POST') {
    var rb = await parseJsonBody(req);
    var rid = Number(mRefundConfirm[1]);
    var ro = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(rid).first();
    if (!ro) return err('订单不存在', 404);
    if (ro.status !== 'refund_pending') return err('仅退款待处理（refund_pending）订单可确认退款');
    var refundRef = String(rb.refund_ref || '').trim();
    if (!refundRef) return err('请填写退款凭证（退款交易哈希 / 转账记录编号），用于审计');
    var refundNote = String(rb.note || rb.admin_note || '').trim();
    var upR = await env.DB.prepare("UPDATE orders SET status='cancelled', refund_status='refunded', refund_ref=?, admin_note=? WHERE id=? AND status='refund_pending'").bind(refundRef, refundNote, rid).run();
    if (!upR.meta || upR.meta.changes === 0) return err('当前状态不可确认退款（可能已被处理）');
    await releaseReservation(env, rid);
    await releaseClaimedButUndeliveredCards(env, rid);
    var auditOkR = await logAudit(env, rid, 'refund_confirm', 'refund_pending', 'cancelled', '管理员确认已在系统外完成退款，退款凭证：' + refundRef + (refundNote ? '，备注：' + refundNote : ''));
    if (!auditOkR) return err(auditFailMsg(rid, 'refund_confirm'), 500);
    return json({ ok: true, message: '已确认退款，订单已取消。' });
  }

  // 商品 CRUD（管理员）— 服务端统一校验与规范化，不只依赖前端 onchange
  function normalizeProductInput(b) {
    // 返回 { ok, error, data }；data 为规范化后的字段。
    var title = String(b.title || '').trim();
    if (!title) return { ok: false, error: '标题必填' };
    if (title.length > 200) return { ok: false, error: '标题过长（最多 200 字符）' };
    var slug = String(b.slug || '').trim().toLowerCase().replace(/[^a-z0-9\-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) slug = 'p-' + Date.now().toString(36);
    if (slug.length > 100) return { ok: false, error: 'slug 过长（最多 100 字符）' };
    var category = String(b.category || 'recharge');
    if (['recharge', 'account', 'card'].indexOf(category) === -1) return { ok: false, error: '分类无效（代充 / 成品号 / 卡密）' };
    var source = b.source === 'prodseller' ? 'prodseller' : 'self';
    var stockType = String(b.stock_type || 'manual');
    if (['card', 'manual'].indexOf(stockType) === -1) return { ok: false, error: '库存类型无效' };
    // 规范化：自营卡密/成品号必须走卡密自动发；上游商品库存由同步决定，stock_type 统一为 manual（忽略）。
    if (source === 'self' && (category === 'card' || category === 'account')) stockType = 'card';
    if (source === 'prodseller') stockType = 'manual';
    var sellPrice = Number(b.sell_price != null ? b.sell_price : b.price_usdt);
    if (!isFinite(sellPrice) || sellPrice < 0 || sellPrice > 1000000) return { ok: false, error: '售价无效（0 ~ 1000000）' };
    var costPrice = Number(b.cost_price || 0);
    if (!isFinite(costPrice) || costPrice < 0 || costPrice > 1000000) return { ok: false, error: '成本价无效（0 ~ 1000000）' };
    var deliveryMethod = ['onsite', 'email', 'both'].indexOf(b.delivery_method) !== -1 ? b.delivery_method : 'both';
    var formFields = b.form_fields || [];
    if (typeof formFields === 'string') { try { formFields = JSON.parse(formFields); } catch (e) { return { ok: false, error: '自定义字段 JSON 无效' }; } }
    if (!Array.isArray(formFields)) return { ok: false, error: '自定义字段必须是数组' };
    if (!validImageData(b.image_data || '')) return { ok: false, error: '图片格式无效（仅支持 JPG/PNG/WebP，压缩后不超过约 500KB）' };
    return { ok: true, data: {
      slug: slug, title: title, category: category,
      sell_price: sellPrice, cost_price: costPrice, source: source,
      prodseller_id: String(b.prodseller_id || ''),
      requires_email_activation: b.requires_email_activation ? 1 : 0,
      delivery_method: deliveryMethod, stock_type: stockType,
      description: String(b.description || '').slice(0, 5000),
      notice: String(b.notice || '').slice(0, 5000),
      form_fields: JSON.stringify(formFields),
      image_emoji: String(b.image_emoji || 'box').slice(0, 10),
      image_data: b.image_data || '',
      sort: Number(b.sort || 0) || 0,
      is_active: b.is_active === 0 ? 0 : 1,
      in_stock: b.in_stock === 0 ? 0 : 1
    } };
  }
  if (path === '/api/admin/products' && method === 'GET') {
    var qP = (url.searchParams.get('q') || '').trim();
    var catP = url.searchParams.get('category') || '';
    var srcP = url.searchParams.get('source') || '';
    var actP = url.searchParams.get('is_active') || '';
    var stockP = url.searchParams.get('stock') || '';
    var pageP = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    var pageSizeP = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '50', 10) || 50));
    var psql = 'SELECT * FROM products WHERE 1=1';
    var pcountSql = 'SELECT COUNT(*) as c FROM products WHERE 1=1';
    var pbinds = [];
    if (qP) { psql += ' AND (title LIKE ? OR slug LIKE ?)'; pcountSql += ' AND (title LIKE ? OR slug LIKE ?)'; pbinds.push('%' + qP + '%', '%' + qP + '%'); }
    if (['recharge', 'account', 'card'].indexOf(catP) !== -1) { psql += ' AND category = ?'; pcountSql += ' AND category = ?'; pbinds.push(catP); }
    if (['self', 'prodseller'].indexOf(srcP) !== -1) { psql += ' AND source = ?'; pcountSql += ' AND source = ?'; pbinds.push(srcP); }
    if (actP === '0' || actP === '1') { psql += ' AND is_active = ?'; pcountSql += ' AND is_active = ?'; pbinds.push(Number(actP)); }
    psql += ' ORDER BY sort ASC, id ASC LIMIT ? OFFSET ?';
    var pStmt = env.DB.prepare(psql).bind.apply(env.DB.prepare(psql), pbinds.concat([pageSizeP, (pageP - 1) * pageSizeP]));
    var pcStmt = env.DB.prepare(pcountSql);
    if (pbinds.length) pcStmt = pcStmt.bind.apply(pcStmt, pbinds);
    var allP = await pStmt.all();
    var totalPRow = await pcStmt.first();
    var totalP = Number((totalPRow && totalPRow.c) || 0);
    var cmA = await cardStockMap(env);
    var cStats = await cardStatsMap(env);
    var plist = (allP.results || []).map(function (pp) {
      pp.card_stock = Number(cmA[String(pp.id)] || 0);
      var cs = cStats[String(pp.id)] || { avail: 0, reserved: 0, used: 0, disabled: 0 };
      pp.card_reserved = cs.reserved; pp.card_used = cs.used; pp.card_disabled = cs.disabled;
      return pp;
    });
    // 缺货筛选需结合真实库存口径，在内存中过滤（分页总数以过滤后为准）
    if (stockP === 'out') plist = plist.filter(function (x) { return realInStock(x, cmA) === 0; });
    else if (stockP === 'in') plist = plist.filter(function (x) { return realInStock(x, cmA) === 1; });
    return json({ ok: true, products: plist, total: stockP ? plist.length : totalP, page: pageP, page_size: pageSizeP, total_pages: Math.max(1, Math.ceil((stockP ? plist.length : totalP) / pageSizeP)) });
  }
  if (path === '/api/admin/products' && method === 'POST') {
    var pb = await parseJsonBody(req);
    var norm = normalizeProductInput(pb);
    if (!norm.ok) return err(norm.error);
    // slug 唯一性校验
    var slugDup = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(norm.data.slug).first();
    if (slugDup) return err('slug 已被其他商品使用，请换一个');
    var d = norm.data;
    await env.DB.prepare('INSERT INTO products (slug, title, category, price_usdt, sell_price, cost_price, source, prodseller_id, requires_email_activation, delivery_method, stock_type, description, notice, form_fields, image_emoji, image_data, sort, is_active, in_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(d.slug, d.title, d.category, d.sell_price, d.sell_price, d.cost_price, d.source, d.prodseller_id, d.requires_email_activation, d.delivery_method, d.stock_type, d.description, d.notice, d.form_fields, d.image_emoji, d.image_data, d.sort, d.is_active, d.in_stock).run();
    return json({ ok: true });
  }
  var mAP = path.match(/^\/api\/admin\/products\/(\d+)$/);
  if (mAP && method === 'PUT') {
    var ub = await parseJsonBody(req);
    var pid = Number(mAP[1]);
    var oldP = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(pid).first();
    if (!oldP) return err('商品不存在', 404);
    // 编辑时 image_data 未传则保留旧图；slug 可改但必须唯一（排除自己）。
    if (typeof ub.image_data !== 'string') ub.image_data = oldP.image_data || '';
    if (ub.slug == null || String(ub.slug).trim() === '') ub.slug = oldP.slug;
    var normU = normalizeProductInput(ub);
    if (!normU.ok) return err(normU.error);
    var slugDupU = await env.DB.prepare('SELECT id FROM products WHERE slug = ? AND id != ?').bind(normU.data.slug, pid).first();
    if (slugDupU) return err('slug 已被其他商品使用，请换一个');
    var du = normU.data;
    // in_stock 没传时保留旧值（卡密/上游商品不靠表单控制库存，别把同步值覆盖掉）
    var newInStock = (ub.in_stock == null) ? (oldP.in_stock == null ? 1 : Number(oldP.in_stock)) : (ub.in_stock === 0 ? 0 : 1);
    await env.DB.prepare('UPDATE products SET slug=?, title=?, category=?, price_usdt=?, sell_price=?, cost_price=?, source=?, prodseller_id=?, requires_email_activation=?, delivery_method=?, stock_type=?, description=?, notice=?, form_fields=?, image_emoji=?, image_data=?, sort=?, is_active=?, in_stock=? WHERE id=?').bind(du.slug, du.title, du.category, du.sell_price, du.sell_price, du.cost_price, du.source, du.prodseller_id, du.requires_email_activation, du.delivery_method, du.stock_type, du.description, du.notice, du.form_fields, du.image_emoji, du.image_data, du.sort, du.is_active, newInStock, pid).run();
    return json({ ok: true });
  }
  if (mAP && method === 'DELETE') {
    var delId = Number(mAP[1]);
    var delP = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(delId).first();
    if (!delP) return err('商品不存在', 404);
    // 删除前检查关联数据：已有订单时禁止物理删除（订单快照依赖商品），请下架；还有卡密时先处理卡密。
    var ordCnt = await env.DB.prepare('SELECT COUNT(*) as c FROM orders WHERE product_id = ?').bind(delId).first();
    if (ordCnt && Number(ordCnt.c) > 0) return err('该商品已有 ' + ordCnt.c + ' 笔订单，无法物理删除（订单快照依赖商品），请改用下架（is_active=0）', 409);
    var cardCnt = await env.DB.prepare('SELECT COUNT(*) as c FROM cards WHERE product_id = ?').bind(delId).first();
    if (cardCnt && Number(cardCnt.c) > 0) return err('该商品还有 ' + cardCnt.c + ' 条卡密，请先在卡密页删除或转移卡密后再删除商品', 409);
    await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(delId).run();
    var auditOkDel = await logAudit(env, null, 'product_delete', '', '', '删除商品 ID ' + delId + '（' + String(delP.title || '') + '）');
    if (!auditOkDel) return err(auditFailMsg(delId, 'product_delete'), 500);
    return json({ ok: true });
  }

  // 卡密
  if (path === '/api/admin/cards' && method === 'GET') {
    var cpid = url.searchParams.get('product_id');
    var cstatus = url.searchParams.get('status') || '';
    var cq = (url.searchParams.get('q') || '').trim();
    var cpage = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    var cpageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20', 10) || 20));
    var csql = 'SELECT * FROM cards WHERE 1=1';
    var ccountSql = 'SELECT COUNT(*) as c FROM cards WHERE 1=1';
    var cbinds = [];
    if (cpid) { csql += ' AND product_id = ?'; ccountSql += ' AND product_id = ?'; cbinds.push(Number(cpid)); }
    if (cstatus === 'unused') { csql += ' AND is_used = 0 AND is_disabled = 0 AND reserved_order_id IS NULL'; ccountSql += ' AND is_used = 0 AND is_disabled = 0 AND reserved_order_id IS NULL'; }
    else if (cstatus === 'used') { csql += ' AND is_used = 1'; ccountSql += ' AND is_used = 1'; }
    else if (cstatus === 'disabled') { csql += ' AND is_disabled = 1'; ccountSql += ' AND is_disabled = 1'; }
    else if (cstatus === 'reserved') { csql += ' AND is_used = 0 AND is_disabled = 0 AND reserved_order_id IS NOT NULL'; ccountSql += ' AND is_used = 0 AND is_disabled = 0 AND reserved_order_id IS NOT NULL'; }
    if (cq) { csql += ' AND (code LIKE ? OR CAST(id AS TEXT) LIKE ?)'; ccountSql += ' AND (code LIKE ? OR CAST(id AS TEXT) LIKE ?)'; cbinds.push('%' + cq + '%', '%' + cq + '%'); }
    csql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    var cStmt = env.DB.prepare(csql).bind.apply(env.DB.prepare(csql), cbinds.concat([cpageSize, (cpage - 1) * cpageSize]));
    var ccStmt = env.DB.prepare(ccountSql);
    if (cbinds.length) ccStmt = ccStmt.bind.apply(ccStmt, cbinds);
    var cr = await cStmt.all();
    var cTotalRow = await ccStmt.first();
    var cTotal = Number((cTotalRow && cTotalRow.c) || 0);
    return json({ ok: true, cards: cr.results || [], total: cTotal, page: cpage, page_size: cpageSize, total_pages: Math.max(1, Math.ceil(cTotal / cpageSize)) });
  }
  if (path === '/api/admin/cards/import' && method === 'POST') {
    var ib = await parseJsonBody(req);
    var iPid = Number(ib.product_id || 0);
    var raw = String(ib.codes || '');
    var lines = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
    if (!iPid || !lines.length) return err('商品与卡密不能为空');
    // 卡密只对自营卡密/成品号商品有意义：对接商品靠上游发货、人工商品靠手动交付，导入卡密无意义且会污染库存。
    var iProd = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(iPid).first();
    if (!iProd) return err('商品不存在', 404);
    if (iProd.source === 'prodseller') return err('对接商品不需要导入卡密（付款后由上游发货）');
    if (!(iProd.stock_type === 'card' || iProd.category === 'account' || iProd.category === 'card')) return err('仅自营卡密/成品号商品可导入卡密（人工发货商品请在订单页手动填写交付内容）');
    var added = 0, duplicate = 0, invalid = 0;
    for (var k = 0; k < lines.length; k++) {
      var code = lines[k];
      if (code.length > 2000) { invalid++; continue; }
      // 先查是否重复：INSERT OR IGNORE 的 changes 才是真实新增数，不能把循环次数当成功数
      var ex = await env.DB.prepare('SELECT id FROM cards WHERE product_id = ? AND code = ?').bind(iPid, code).first();
      if (ex) { duplicate++; continue; }
      try {
        var ins = await env.DB.prepare('INSERT INTO cards (product_id, code) VALUES (?, ?)').bind(iPid, code).run();
        if (ins.meta && ins.meta.changes === 1) added++; else duplicate++;
      } catch (e) { duplicate++; }
    }
    return json({ ok: true, imported: added, added: added, duplicate: duplicate, invalid: invalid, total: lines.length });
  }
  var mCardDis = path.match(/^\/api\/admin\/cards\/(\d+)\/disable$/);
  if (mCardDis && method === 'POST') {
    var db2 = await parseJsonBody(req);
    var disId = Number(mCardDis[1]);
    var disCard = await env.DB.prepare('SELECT * FROM cards WHERE id = ?').bind(disId).first();
    if (!disCard) return err('卡密不存在', 404);
    // 被订单预留的卡不能禁用（会破坏已下单未付款的预留）；已用的卡禁用无意义，同样拒绝。
    if (disCard.is_used) return err('已用卡密不能禁用');
    if (disCard.reserved_order_id) return err('该卡密已被订单预留，订单取消/超时后自动释放，暂不能禁用');
    await env.DB.prepare('UPDATE cards SET is_disabled = ? WHERE id = ?').bind(db2.disabled ? 1 : 0, disId).run();
    return json({ ok: true });
  }
  var mCardDel = path.match(/^\/api\/admin\/cards\/(\d+)$/);
  if (mCardDel && method === 'DELETE') {
    var delCardId = Number(mCardDel[1]);
    var delCard = await env.DB.prepare('SELECT * FROM cards WHERE id = ?').bind(delCardId).first();
    if (!delCard) return err('卡密不存在', 404);
    // 已用 / 被预留的卡密受保护：已用卡关联历史交付，删除会破坏订单一致性；预留卡正在被订单占用。
    if (delCard.is_used) return err('已用卡密不能删除（关联历史交付记录）');
    if (delCard.reserved_order_id) return err('该卡密已被订单预留，订单取消/超时后自动释放，暂不能删除');
    await env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(delCardId).run();
    return json({ ok: true });
  }

  // ---- 上游 ProdSeller 管理 ----
  if (path === '/api/admin/upstream/sync' && method === 'POST') {
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
        await env.DB.prepare('INSERT INTO products (slug, title, category, price_usdt, sell_price, cost_price, source, prodseller_id, requires_email_activation, delivery_method, stock_type, description, notice, form_fields, image_emoji, sort, is_active, in_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET price_usdt=excluded.price_usdt, sell_price=excluded.sell_price, cost_price=excluded.cost_price, prodseller_id=excluded.prodseller_id, requires_email_activation=excluded.requires_email_activation, in_stock=excluded.in_stock').bind(slug, title, 'recharge', sell, sell, cost, 'prodseller', String(up.id || ''), reqAct, 'both', 'manual', String(up.description || ''), '', '[]', 'box', 0, 1, inSt).run();
        imported++;
      } catch (e) {}
    }
    return json({ ok: true, imported: imported, markup: markup, fixed: fixed });
  }
  if (path === '/api/admin/upstream/orders' && method === 'GET') {
    var upPage = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    var upPageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20', 10) || 20));
    var uo = await env.DB.prepare('SELECT * FROM upstream_orders ORDER BY id DESC LIMIT ? OFFSET ?').bind(upPageSize, (upPage - 1) * upPageSize).all();
    var uoTotalRow = await env.DB.prepare('SELECT COUNT(*) as c FROM upstream_orders').first();
    var uoTotal = Number((uoTotalRow && uoTotalRow.c) || 0);
    return json({ ok: true, upstream_orders: uo.results || [], total: uoTotal, page: upPage, page_size: upPageSize, total_pages: Math.max(1, Math.ceil(uoTotal / upPageSize)) });
  }
  if (path === '/api/admin/upstream/alerts' && method === 'GET') {
    // 后台置顶告警：pending_upstream 订单（402 余额不足 / 409 缺货 / 上游错误）
    var al = await env.DB.prepare("SELECT * FROM orders WHERE status='pending_upstream' ORDER BY id ASC LIMIT 100").all();
    return json({ ok: true, alerts: al.results || [] });
  }
  var mUpRetry = path.match(/^\/api\/admin\/upstream\/orders\/(\d+)\/retry$/);
  if (mUpRetry && method === 'POST') {
    var rOrd = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(Number(mUpRetry[1])).first();
    if (!rOrd) return err('订单不存在', 404);
    var rb = await parseJsonBody(req);
    var retryReason = String(rb.reason || '').trim();
    var beforeRetry = rOrd.status;
    var pollRes = await pollUpstreamActivations(env, ctx, { orderId: Number(mUpRetry[1]) });
    var afterRetry = (await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(Number(mUpRetry[1])).first() || {}).status || beforeRetry;
    var auditOkRetry = await logAudit(env, Number(mUpRetry[1]), 'upstream_retry', beforeRetry, afterRetry, '管理员重试上游轮询' + (retryReason ? '，原因：' + retryReason : ''));
    if (!auditOkRetry) return err(auditFailMsg(Number(mUpRetry[1]), 'upstream_retry'), 500);
    return json({ ok: true, poll: pollRes.poll || pollRes });
  }

  // ---- 操作审计 ----
  if (path === '/api/admin/audit' && method === 'GET') {
    var aAction = url.searchParams.get('action') || '';
    var aOrderId = url.searchParams.get('order_id') || '';
    var aPage = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    var aPageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20', 10) || 20));
    var asql = 'SELECT * FROM admin_audit WHERE 1=1';
    var acountSql = 'SELECT COUNT(*) as c FROM admin_audit WHERE 1=1';
    var abinds = [];
    if (aAction) { asql += ' AND action = ?'; acountSql += ' AND action = ?'; abinds.push(aAction); }
    if (aOrderId) { asql += ' AND order_id = ?'; acountSql += ' AND order_id = ?'; abinds.push(Number(aOrderId)); }
    asql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    var aStmt = env.DB.prepare(asql).bind.apply(env.DB.prepare(asql), abinds.concat([aPageSize, (aPage - 1) * aPageSize]));
    var acStmt = env.DB.prepare(acountSql);
    if (abinds.length) acStmt = acStmt.bind.apply(acStmt, abinds);
    var ar = await aStmt.all();
    var aTotalRow = await acStmt.first();
    var aTotal = Number((aTotalRow && aTotalRow.c) || 0);
    return json({ ok: true, audit: ar.results || [], total: aTotal, page: aPage, page_size: aPageSize, total_pages: Math.max(1, Math.ceil(aTotal / aPageSize)) });
  }

  // 设置 — 保存前校验：JSON 结构、数值范围、URL 格式；敏感键禁止经普通设置写入。
  function validateSetting(key, value) {
    var v = String(value == null ? '' : value);
    var jsonKeys = ['usdt_addresses', 'pay_tutorials', 'rpc_urls', 'usdt_contracts'];
    if (jsonKeys.indexOf(key) !== -1) {
      var parsed;
      try { parsed = JSON.parse(v || '{}'); } catch (e) { return '设置 ' + key + ' 不是合法 JSON'; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '设置 ' + key + ' 必须是 JSON 对象';
      if (key === 'usdt_addresses') {
        var ak = Object.keys(parsed);
        for (var i = 0; i < ak.length; i++) { if (ak[i].indexOf('|') === -1) return 'usdt_addresses 的键必须是“支付方式|链”格式，如 Binance|X Layer'; if (typeof parsed[ak[i]] !== 'string' || !parsed[ak[i]].trim()) return 'usdt_addresses 的 ' + ak[i] + ' 地址不能为空'; }
      }
      if (key === 'rpc_urls') {
        var rk = Object.keys(parsed);
        for (var j = 0; j < rk.length; j++) { if (!Array.isArray(parsed[rk[j]]) || !parsed[rk[j]].length) return 'rpc_urls 的 ' + rk[j] + ' 必须是非空 URL 数组'; for (var u = 0; u < parsed[rk[j]].length; u++) { if (typeof parsed[rk[j]][u] !== 'string' || parsed[rk[j]][u].indexOf('http') !== 0) return 'rpc_urls 的 ' + rk[j] + ' 包含无效 URL'; } }
      }
      if (key === 'usdt_contracts') {
        var ck = Object.keys(parsed);
        for (var m = 0; m < ck.length; m++) { if (typeof parsed[ck[m]] !== 'string') return 'usdt_contracts 的 ' + ck[m] + ' 必须是字符串'; }
      }
      if (key === 'pay_tutorials') {
        var tk = Object.keys(parsed);
        for (var n = 0; n < tk.length; n++) { if (typeof parsed[tk[n]] !== 'string' || (parsed[tk[n]] && parsed[tk[n]].indexOf('http') !== 0)) return 'pay_tutorials 的 ' + tk[n] + ' 必须是 URL'; }
      }
      return null;
    }
    if (key === 'upstream_markup') { var mk = Number(v); if (!isFinite(mk) || mk <= 0 || mk > 100) return 'upstream_markup 必须是 0~100 之间的倍率'; return null; }
    if (key === 'upstream_fixed') { var fx = Number(v); if (!isFinite(fx) || fx < 0 || fx > 1000000) return 'upstream_fixed 必须是 0~1000000 之间的固定加价'; return null; }
    if (key === 'cny_rate') { var cr = Number(v); if (!isFinite(cr) || cr <= 0 || cr > 1000) return 'cny_rate 必须是 0~1000 之间的汇率'; return null; }
    if (key === 'poll_enabled') { if (v !== '0' && v !== '1') return 'poll_enabled 只能是 0 或 1'; return null; }
    if (key === 'tg_link') { if (v && v.indexOf('http') !== 0) return 'tg_link 必须是 URL'; return null; }
    if (key === 'prodseller_base_url') { if (v && v.indexOf('https://prodseller.com/') !== 0) return 'prodseller_base_url 仅允许官方域名 https://prodseller.com/（自定义端点请经环境变量 PRODSELLER_BASE_URL 配置，避免 API Key 被发往非官方地址）'; return null; }
    if (key === 'prodseller_enabled') { if (v !== '0' && v !== '1') return 'prodseller_enabled 只能是 0 或 1（默认 0 关闭；开启前须在 RELEASE_READINESS 中提供上游真实行为验证证据）'; return null; }
    if (key === 'turnstile_enabled') { if (v !== '0' && v !== '1') return 'turnstile_enabled 只能是 0 或 1'; return null; }
    if (key === 'turnstile_site_key') { if (v && v.length > 200) return 'turnstile_site_key 过长'; return null; }
    if (key === 'chain_confirmations') {
      var cc; try { cc = JSON.parse(v || '{}'); } catch (e) { return '设置 chain_confirmations 不是合法 JSON'; }
      if (!cc || typeof cc !== 'object' || Array.isArray(cc)) return '设置 chain_confirmations 必须是 JSON 对象';
      var cck = Object.keys(cc);
      for (var ci = 0; ci < cck.length; ci++) { var cv = Number(cc[cck[ci]]); if (!isFinite(cv) || cv < 1 || cv > 100 || Math.floor(cv) !== cv) return 'chain_confirmations 的 ' + cck[ci] + ' 必须是 1~100 的整数'; }
      return null;
    }
    if (key === 'site_name') { if (!v.trim()) return 'site_name 不能为空'; if (v.length > 100) return 'site_name 过长（最多 100 字符）'; return null; }
    if (key === 'binance_uid') { if (v && !/^[0-9]+$/.test(v.trim())) return 'binance_uid 必须是纯数字'; return null; }
    var lowerKey = key.toLowerCase();
    if (lowerKey.indexOf('password') !== -1 || lowerKey.indexOf('secret') !== -1 || lowerKey.indexOf('token') !== -1 || lowerKey.indexOf('api_key') !== -1 || lowerKey.indexOf('apikey') !== -1) return '设置 ' + key + ' 含敏感词，禁止经普通设置写入（请走 Secrets）';
    return null;
  }
  if (path === '/api/admin/settings' && method === 'GET') {
    return json({ ok: true, settings: await getAllSettings(env) });
  }
  if (path === '/api/admin/settings' && method === 'POST') {
    var sb = await parseJsonBody(req);
    var entries = sb.settings || {};
    if (sb.key) entries[sb.key] = sb.value;
    var keys = Object.keys(entries);
    // 先全部校验通过再写，避免一半有效一半无效造成配置半截生效
    for (var si = 0; si < keys.length; si++) {
      var vErr = validateSetting(keys[si], entries[keys[si]]);
      if (vErr) return err(vErr);
    }
    for (var sj = 0; sj < keys.length; sj++) {
      await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(keys[sj], String(entries[keys[sj]] == null ? '' : entries[keys[sj]])).run();
    }
    var auditOkS = await logAudit(env, null, 'settings_update', '', '', '修改设置：' + keys.join('、'));
    if (!auditOkS) return err('设置已保存，但审计记录写入失败，请立即检查 admin_audit 表并手动补记（操作：settings_update）', 500);
    return json({ ok: true });
  }
  if (path === '/api/admin/cleanup' && method === 'POST') {
    await cleanupExpired(env);
    return json({ ok: true, message: '7天清理已执行' });
  }
  // ---- 管理员：付款账本（第四轮 P0）----
  // GET /api/admin/payments?status=&order_id=&page= —— 按状态/订单筛选付款记录，含订单号。
  if (path === '/api/admin/payments' && method === 'GET') {
    var pStatus = String(url.searchParams.get('status') || '').trim();
    var pOrderId = String(url.searchParams.get('order_id') || '').trim();
    var pPage = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    var pPageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20', 10) || 20));
    var pOff = (pPage - 1) * pPageSize;
    var pWhere = [], pBinds = [];
    if (pStatus) { pWhere.push('p.status = ?'); pBinds.push(pStatus); }
    if (pOrderId) { pWhere.push('p.order_id = ?'); pBinds.push(Number(pOrderId)); }
    var pWhereSql = pWhere.length ? ('WHERE ' + pWhere.join(' AND ')) : '';
    var pStmt = env.DB.prepare('SELECT p.*, o.order_no FROM payments p LEFT JOIN orders o ON o.id = p.order_id ' + pWhereSql + ' ORDER BY p.id DESC LIMIT ? OFFSET ?');
    var pTotalStmt = env.DB.prepare('SELECT COUNT(*) as c FROM payments p ' + pWhereSql);
    var pRows = await pStmt.bind.apply(pStmt, pBinds.concat([pPageSize, pOff])).all();
    var pTotalRow = await pTotalStmt.bind.apply(pTotalStmt, pBinds).first();
    var pTotal = Number((pTotalRow && pTotalRow.c) || 0);
    return json({ ok: true, payments: pRows.results || [], total: pTotal, page: pPage, page_size: pPageSize, total_pages: Math.max(1, Math.ceil(pTotal / pPageSize)) });
  }
  // POST /api/admin/payments/:id/reconcile —— 人工对账：把 mismatch/unmatched 的付款标记为 reconciled，并写对账备注。
  // 仅能标记，不得直接把付款改为 posted（posted 必须经链上核验 + 履约流程）。
  var mPayRecon = path.match(/^\/api\/admin\/payments\/(\d+)\/reconcile$/);
  if (mPayRecon && method === 'POST') {
    var rb = await parseJsonBody(req);
    var rNote = String(rb.note || '').trim();
    if (!rNote) return err('请填写对账备注');
    var payId = Number(mPayRecon[1]);
    var payRow = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(payId).first();
    if (!payRow) return err('付款记录不存在', 404);
    if (payRow.status === 'posted') return err('已入账的付款无需对账');
    await updatePayment(env, payId, { status: 'reconciled', reconcile_status: 'resolved', reconcile_note: rNote });
    await logAudit(env, payRow.order_id, 'payment_reconcile', payRow.status, 'reconciled', '人工对账付款记录 #' + payId + '：' + rNote);
    return json({ ok: true });
  }
  // GET /api/admin/schema-check —— Schema 预检（只读）：校验实际 Schema 与目标版本是否一致，版本号与内容不一致时报告差异。
  if (path === '/api/admin/schema-check' && method === 'GET') {
    var pre = await precheckSchema(env);
    return json({ ok: true, precheck: pre });
  }
  // 数据库迁移（显式触发）：返回本次应用的版本列表与当前版本。迁移失败时返回明确的版本号与原因，不伪装成功。
  if (path === '/api/admin/migrate' && method === 'POST') {
    var migRes = await runMigrations(env);
    return json({ ok: true, applied: migRes.applied, current_version: migRes.current_version, message: migRes.applied.length ? ('已应用迁移：v' + migRes.applied.join('、v')) : '数据库已是最新版本，无需迁移' });
  }
  if (path === '/api/admin/migrate' && method === 'GET') {
    var curRow = await env.DB.prepare('SELECT MAX(version) AS v FROM schema_migrations').first().catch(function () { return null; });
    var curV = curRow ? Number(curRow.v || 0) : 0;
    return json({ ok: true, current_version: curV, latest_version: MIGRATIONS.length, up_to_date: curV >= MIGRATIONS.length });
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
      try { return await handleApi(req, env, url, ctx); } catch (e) {
        // 错误脱敏（第四轮 P0）：公开接口只返回稳定通用的错误消息 + 关联 ID，绝不返回 SQL、数据库结构、内部路径、堆栈或凭据。
        // 内部详情只记 Worker 日志（console.error），运营凭 request_id 在日志中关联定位。
        var reqId = 'req_' + randomHex(8);
        try { console.error('[' + reqId + '] API 500 ' + req.method + ' ' + url.pathname + ' :: ' + (e && e.stack ? e.stack : (e && e.message ? e.message : String(e)))); } catch (ee) {}
        return err('服务器内部错误（关联 ID：' + reqId + '，请联系管理员并提供该 ID）', 500);
      }
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) {
    // 定时任务先做轻量迁移检查（版本落后时才执行迁移），迁移失败时抛错进入 Worker 日志，不得静默。
    await ensureMigrated(env);
    var cron = (event && event.cron) || '';
    if (cron === '*/1 * * * *') { ctx.waitUntil((async function () { await runPolling(env, fetch, ctx); await pollUpstreamActivations(env, ctx); })()); return; }
    if (cron === '0 2 * * *') { ctx.waitUntil((async function () { await cleanupExpired(env); await pollUpstreamActivations(env, ctx); })()); return; }
    // 无 event.cron 时按时间判断：UTC 02:00 跑清理，否则跑轮询（两者都顺带跑上游激活轮询）
    var d = new Date();
    if (d.getUTCHours() === 2 && d.getUTCMinutes() === 0) { ctx.waitUntil((async function () { await cleanupExpired(env); await pollUpstreamActivations(env, ctx); })()); }
    else { ctx.waitUntil((async function () { await runPolling(env, fetch, ctx); await pollUpstreamActivations(env, ctx); })()); }
  }
};
