// aisou-lite — Cloudflare Worker + D1 轻量版虚拟商品售卖站
// 单文件、无构建步骤、vanilla JS + CSS。免费版：单 Worker + 单 D1 + 2 个 cron。
// 安全：PBKDF2 迭代 100000（Workers 生产上限），参数化查询，httpOnly session cookie。
// 支付：CF 轮询自动发货（链上按精确金额匹配），双链收口：欧易 USDT0 · X Layer、币安 USDT · BEP20。服务端白名单强制，历史订单仍可查询与恢复。
// 轮询原理：下单生成 actual_amount = 基础价 + 随机尾数 0.0001-0.0099，锁定 20 分钟；
// cron 每 1 分钟查 D1 有无 pending_payment，无则零 RPC；有则查 EVM 公开 RPC 匹配 to+金额。仅支持 OKX X Layer 与币安 BEP20。

var PBKDF2_ITERATIONS = 100000;
var SESSION_MAX_AGE = 7 * 24 * 3600;
var PAY_WHITELIST = [['OKX', 'X Layer'], ['Binance', 'BEP20']];
var PAY_METHODS = PAY_WHITELIST.map(function (c) { return c[0]; });
var PAY_CHAINS = PAY_WHITELIST.map(function (c) { return c[1]; });
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
// P2-7：卡密掩码——前 4 + ****；长度 ≤4 时全掩码，不泄露长度以外的信息。
function maskCardCode(code) {
  var s = String(code || '');
  if (s.length <= 4) return '****';
  return s.slice(0, 4) + '****';
}
function validImageData(s){
  if (typeof s !== 'string') return false;
  if (s.length === 0) return true;
  if (s.length > 700000) return false;
  return s.indexOf('data:image/jpeg;base64,') === 0 || s.indexOf('data:image/png;base64,') === 0 || s.indexOf('data:image/webp;base64,') === 0;
}
var POLL_LOCK_MINUTES = 20;
var TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
var DEFAULT_RPC_URLS = { 'X Layer': ['https://xlayerrpc.okx.com'], 'BEP20': ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io'] };
// ---- 第四轮（Release Readiness）新增常量 ----
// 各链确认数策略（可经 settings.chain_confirmations 以 JSON 覆盖）：未达确认数不入账、不履约，防链重组导致已发货但付款失效。
// X Layer 出块快且重组概率低，1 确认；BEP20 15 确认（约 45 秒）。仅支持这两条链。
var DEFAULT_CHAIN_CONFIRMATIONS = { 'X Layer': 1, 'BEP20': 15 };
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
var DEFAULT_USDT_CONTRACTS = { 'X Layer': '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', 'BEP20': '0x55d398326f99059fF775485246999027B3197955' };
// 第九轮：X Layer 默认代币 = USDT0（欧易 + Tether 2025-09-09 上线 X Layer 的当前标准，欧易提币/充值走 USDT0；6 位精度，LayerZero OFT v2）。
// 旧版 X Layer USDT（0x1e4a5963abfd975d8c9021ce480b42188849d41d）是不同资产，绝不混用、绝不自动接受。
// BEP20 默认 = Binance-Peg USDT 0x55d398326f99059fF775485246999027B3197955，18 位精度（BscScan 合约源码 _decimals=18）。
// 注意：BEP20 精度是 18，不是 6；核验时必须用合约实际 decimals（见 getTokenDecimals），不得硬编码 6。
// 管理员可在 settings.usdt_contracts 中显式覆盖任一链的合约（覆盖后仍按该合约实际 decimals 核验）。

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
  var r = randomHex(8).toUpperCase();
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
// 恒定时间比较（P3-13）：比较哈希/口令时不因首个不同字节位置泄露信息；长度不同时仍走满循环。
function timingSafeEqual(a, b) {
  var x = String(a == null ? '' : a), y = String(b == null ? '' : b);
  var xb = new TextEncoder().encode(x), yb = new TextEncoder().encode(y);
  if (xb.length === 0 && yb.length === 0) return true;
  var n = Math.max(xb.length, yb.length);
  var diff = xb.length ^ yb.length;
  for (var i = 0; i < n; i++) diff |= ((i < xb.length ? xb[i] : 0) ^ (i < yb.length ? yb[i] : 0));
  return diff === 0;
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
  if (exists) return;
  try {
    await env.DB.prepare('ALTER TABLE ' + table + ' ADD COLUMN ' + colDef).run();
  } catch (e) {
    // P3-28：并发首次迁移时两方同时 ALTER 会报 duplicate column；重查一次，列已存在则忽略，否则原错上抛。
    var info2 = await env.DB.prepare('PRAGMA table_info(' + table + ')').all();
    var exists2 = false;
    (info2.results || []).forEach(function (r) { if (r.name === colName) exists2 = true; });
    if (!exists2) throw e;
  }
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
// App 图标标题匹配：按标题关键词映射到 app_icons 的 app_key；无匹配返回 ''。
// 顺序重要：先匹配更具体的组合（如 'prime video' 在 'avira' 之后不影响，因 Avira Prime 不含 'prime video'）。
var APP_ICON_MATCH = [
  ['chatgpt', ['chatgpt']],
  ['claude', ['claude']],
  ['duolingo', ['duolingo', '多邻国']],
  ['gmail', ['gmail']],
  ['canva', ['canva']],
  ['gemini', ['gemini']],
  ['notion', ['notion']],
  ['figma', ['figma']],
  ['spotify', ['spotify']],
  ['telegram', ['telegram']],
  ['cursor', ['cursor']],
  ['codex', ['codex']],
  ['ilovepdf', ['ilovepdf']],
  ['capcut', ['capcut']],
  ['office', ['office 365', 'microsoft 365', 'office']],
  ['miro', ['miro']],
  ['edx', ['edx']],
  ['jetbrains', ['jetbrains']],
  ['framer', ['framer']],
  ['autodesk', ['autodesk', 'autocad']],
  ['hbo', ['hbo']],
  ['appletv', ['apple tv']],
  ['scribd', ['scribd']],
  ['elevenlabs', ['elevenlabs']],
  ['wisprflow', ['wispr flow', 'wispr']],
  ['avira', ['avira']],
  ['outlook', ['outlook', 'hotmail']],
  ['museai', ['muse ai', 'muse']],
  ['adobe', ['adobe', 'express']],
  ['primevideo', ['prime video']]
];
function matchAppIconKey(title) {
  var t = String(title || '').toLowerCase();
  for (var i = 0; i < APP_ICON_MATCH.length; i++) {
    var kws = APP_ICON_MATCH[i][1];
    for (var j = 0; j < kws.length; j++) {
      if (t.indexOf(kws[j]) !== -1) return APP_ICON_MATCH[i][0];
    }
  }
  return '';
}

// App 图标种子（生成脚本产出，勿手改）：[app_key, theme, name, image_data]；v11 建表+种子，v12 刷新暗版。
var APP_ICON_SEED = [
      ['adobe', 'light', 'Adobe', 'data:image/jpeg;base64,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'],
      ['adobe', 'dark', 'Adobe', 'data:image/jpeg;base64,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'],
      ['appletv', 'light', 'Apple TV', 'data:image/jpeg;base64,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'],
      ['appletv', 'dark', 'Apple TV', 'data:image/jpeg;base64,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'],
      ['autodesk', 'light', 'Autodesk', 'data:image/jpeg;base64,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'],
      ['autodesk', 'dark', 'Autodesk', 'data:image/jpeg;base64,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GSccZ7oPFAEM/lOTHUAP+rmS3P6XTfhd1/VqwZa+ajCrlrT83UGuZ1IzZlzWv9DdpADxgbcKoXhdVvzN0S9xWpBqMpUxMGZjPmduwu4I2gOPnOQeFYKnemn18woE1c9OqFPqkNgY+LJ4LXgeM+R8xkdslBFXlqBQa3YkpbdGpM1IwZSO2LDEaIHhoAfkZyT+epyTvmzb1oMlSb4lYsrPSsPpw55mcdgN2W5IJxyCC3z8qPeM9Z0xBk5e1aZOS3Q3daYmX5dGzjHGT2x93c8K31W59Obz9im682tSM7KyzJciBtLXBuT3wc8k84CCB1B09faUrKVGQqIqdEm3bYEYEEsJG4A44IIBII74PA86PSJuiSWkNnRq/AdGkmzsPndhsN+Yu17x+c0HuP64waHdl9UGsytEtynSM3LWzTozHxckdeIBwdoyQDhz+55LvGF9r0vm2Knp5JWzb8tUYTJSO2I0zTW+6A/PIcecv+CDzrjI1iDeTJyejdenTEPEk5ow2GB7zMfpZOSfOR8hma06hai0KdsL/DF6SU5OwpdzfZo0sGl7Wj3eS4YLeQCO4OPnnNQ9jNSmfo4RhJdR3Q62Opsz6d2OM4xnCK50REBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREH//Z'],
      ['avira', 'light', 'Avira', 'data:image/jpeg;base64,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'],
      ['avira', 'dark', 'Avira', 'data:image/jpeg;base64,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'],
      ['canva', 'light', 'Canva', 'data:image/jpeg;base64,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'],
      ['canva', 'dark', 'Canva', 'data:image/jpeg;base64,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'],
      ['capcut', 'light', 'CapCut', 'data:image/jpeg;base64,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'],
      ['capcut', 'dark', 'CapCut', 'data:image/jpeg;base64,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'],
      ['chatgpt', 'light', 'ChatGPT', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAcFBQYFBAcGBgYIBwcICxILCwoKCxYPEA0SGhYbGhkWGRgcICgiHB4mHhgZIzAkJiorLS4tGyIyNTEsNSgsLSz/2wBDAQcICAsJCxULCxUsHRkdLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCz/wAARCACgAKADASIAAhEBAxEB/8QAHAAAAQQDAQAAAAAAAAAAAAAACAABAgcDBQYE/8QASRAAAQIEAwUEBQgHBgYDAAAAAQIDAAQFEQYHIRIxUWFxE0GBkRQiMmKhCCNCcnSCsbMVJzdSkrLBMzRDZHPwFyQlg6LRNZPh/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAH/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwAkYUKFANqeUK3Uw8KAbZTwEKw4CHhQCsOAhWHAQoUArDgIVhwEK8K4gGsOAhbI4CHhQDbI4CFsjgIeFANsJP0R5Q3Zo/dHlEoUBHYHcSPGH1G/WHhQChQ27UQ8A3f0hXhu7rCgHvCvDXhQDwrw0aXFeJ5XClBdqEyO0XfYZZBsXXDuTfuGhJPcATAZsQYlpeGZD0qpzIaSq4bbSNpbh4JSNT+A77RTmI89qg66tqkMtSLYOilAPOnr9BPT1o4Cr1qt44xLsILk7OTSuzSlsb/cQPooH/6T3xauEcjqdJsNzGIl+nTJFzLNKKWUciRqs+Q6wFYzWZeKJlwqXWp8E9wmS38E2EPJ5nYrlHAputTyrdyn+2HksGCWkcNUWnNBuTpEjLpHciXQPja8QqGE6DVWi3PUaRmEnvUwkEdCACPOAqjDWfUylxDFelETLe4vS6ezcHMoJ2VeBEXJRq5Tq/TkT1Mmm5mXXptJOqT3gjeDyMUTmblvh7D6RMUupiWmFm4pzqi4oi/tJO9IHvac44PDmL6thSoPO02dcaUsFtRQApKx3XSdDbuO8QBg7Q4iFfnAozGaOK3nCpVan0nk8EfBIEeqQzexbIqCv0o+8nvS+lDyT5i/xgCkvCvFP4Wz3k51xLFelkypOnpMvdSB9ZB9ZI5i8WzKzbE7KtzEs82+w6naQ42oKSocQRvgM8KGhXgHhA2VbjDXhlHQHgRAIeynpCvDHQDpDXgJXhXiN40uJ8W0vCdPEzUXjtruGmEauOkdyRw4k2A7zAby8DfnTilyqYrdkGnD2EiTLIF9NrQuq87J+7zjHinOyuVV5bNPdNPl+5uVV633nd/8No4OmJexDiqSlZi+1NTDbJuST6yxcknedTrAX9k3gpqh4dbrM00P0jUUbSSoatMn2UjgVe0fAd0WelNoxMtobSENpCUIGykDuA0A8o4DMTNRnB7yqdJsoenwgKWt3+za2t2g1Uq2ttBuuYDuqpV6fRJFU5UptqVl06bbirXPADeTyGsU3jPPB1W3KUFCpRB07daQXlfVTuR1NzyEVjUMQYhxvW0JSqan5x07LYCdpduCEjRA6W5mLJwbkVYonMUvG59b0Jhep+usfgnzgK7pVHxJjuqONyMu9MKWq7zqlHZB4uOH+uvARcOF8jqLTWkO1taqpM7y2klthPKw1V4nwiyafTZSmSTcpIyzUrLNiyGmkhKR4f1jHWK7S8PSJm6pONyrW5O1qpZ4JSNVHkIDzyuFKDJtBuXolOaSO4SqP6iPFVMvMK1dspmqFJhR/wARlHYrHii0aalZy4XqVTMm8t+n3NkOzQSG1dSCdj71o75C0uISpKgpKhcEG4I4iAHzHOS03RGHKlQHXZ2UbG0tlQ+faHEW9sDkAeRjSZc5kTmDammWm1LepTyrvMjXYv8A4iOfEd45wT5F4HjOrArdFqLdbpzQblJ1Z20JFg29vNuAULm3EHjAEJKzTM3KtTEu6l1l1IWhaTcKSRcEeEZrxTmQmK11CizNAmF7S5GzzFz/AISjqn7qvgqLhBgJXiLh+bV0MK8Mo+oroYB1d3SGvCXvHSGvAarEuIZXDFAmKpN+sloWQ2DZTqzolA5k+Que6BXrVarWPsVltG3Nzk2sNpQ1uPBtA7kD/wBk98d78oDE7i6uxRWVnYlGwpQHe64N/gi38ZjdZDYOakaErEky2DNTu03Lkj2GgbEjmpQPgOcB6sMZN0nD9Dfm6whupVIMLVY6ssnZJ9UfSI/ePgBFOYNVfM2h/bJf8RBY1IWo85/oOfyGBJwWr9aFDH+clvxEAYLe6BlzyP6x5sHcew/KEEy2dIGLPVVsyZr/ALH5QgLjyko8hIZeUublpVtuZnWe0feCfXcJUd532FtBujuHnmZSXW/MOoZZbG0txxQSlI4knQRTlBzTo2EssKLKp/56otSoCmUq2UNG59tfd0Fz0irsVZjV3GU4EOPKdRtWaYbSQ0k92yj6R5m5gLfxnnjI01tcvQEpmHN3pbqT2f3Eb19TYdYpl6o4kx3XdhkTdQnX9Lj13Cn8EJ6WEcwlSm5/angtVlWVtXB36g8P6QSuV+MMFP09qmUqWaos2u20w6oEvq4h0/2h5Gx5QFU1nJ/F1Apiaj6MiZATtOplHO1W19ZNtRzTeMGDs0a7g5xLDbwekr6yrxKmuez3oPTTiDBWBPgRHC40ymoGLg5MBsU6oq19JYSLLPvo3K66HnAe7B+ZtBxelDLD3ok+of3R9QClfUVuWOmvKMuZdORU8uaw2pIK2GfSUclNna/AEeMDbivAGJMCTG3NMFcntepNM3Uyo92u9B5G3KN3Rs5KwjD87QqsoTzMzLOS6HJhVnWtpJAO39IC+4684CGTk8qn5syjCTZEx2suRxBQSPikQUiDcQJ2U6fTc4KYto7SEPLcvyS2rWCub9mAy3hifVPSFeGJ9U9IB1nUdIid0O4dR0iBOkAIeak6ubzIqylEm048Bf3TsD4JEFLhmRbpuF6XJNgBDEo0gfwC/wAbwK+bMmuQzMqzahYKm3FDouyx/NBSYRqTdWwhSJ9sgpflGleOyAR5gwGyqn/w879nc/kMCHgpX606GP8AOS34iC7qh/6PO/Z3P5DAa4cqbFJzCpk/MlXYyz7Dq9kXOykgmw79IA0kHSBdz7J/4jTgG8hi3/1CCVpNXp9ap6J2mzjM5LL3ONKuL8D3g8jrA0Z9KtmXM/8AY/KEB4cG5X4kxuGphV5WmjT0qYB2CO/YTvWemnOCCwdltQMGtpXJS/pE9aypx8Aufd7kDp5mFlaL5X4eP+UH8yo7ECA4zGWV+H8ZIW7MseiVAjScYACz9cbljrrzgfMYZY4kwO6p5TQmZAqsmaZBU2ddAob0HrpwJgt443NjTK+sH3W/zUQFKYHzxq9AU3I1QqqUkj1ezeX862PccO/oq/UQQGGMZ0TF0p21KnEuLSLuML9V1v6yeHMXHOBMwVhBzG+I5mlMPty75bddQtwEpJTbQ21F779YlVKNijL2stiaZmZJ9s7TLqFkX5tuDf4eIgDLeZamGVtOoQ424NlSFgKSocCDoRFO4/yKkagw7P4YbErNC6jJE/NOfUJ9g8vZ6Rq8B5/l1xmn4oSFhSggTraQlab6XcRuI95NukXxcEQAbYTxBPZfYxanBL/OsKU04y6nZKknRaDfVKtN/cRBd0OsydeosrVJB3tJaaQFoPeOIPAg3BHERTef2B2nJZvE8m0EuKUGZvZG8n2HOumyfux5Pk6YqcU5P4bmFkpKTNMAncoWDgHUbJ8DAEBeH7j0iAMOO/pAO4fW8IheHWdfCI3gKC+UVhVwzEpiGXQSh5Il3iB7LiblBPVNx90R6fk+46aekFYVnXQl5ClOye0faB1W31B9YDmeEXJXKNJ4gok1S59vtJaZRsKA3jvCge4g2IPEQH2MKFO5eYxelxMguyzqSl1lWyTcBSFi3sqsQbdxgDQ0WkggEEWIO4xRGPfk/wDbOO1DCrupJV6C8qxHJtf4BXnHvy+z5kalLtSWJliXmAAkTqU+ovm4keyeY06RcjL7M0wh5h1DrTg2kLQoKSocQRoYANabXsUZe11YQuakJpo7LqFJIJHBaDoodfAxDG+MTjKtt1N5LSJp7sw4hoEJGykJvruva9u6CzxPg6iYukvR6vIofKRZt5Pqut/VVvHTdygesdZD1iglyeopVVJJHrfNp+ebHvIHtdU+QgL0ysP6rsPfZB/MqOxBgP8ABmaeIMEPJlw72skFetLPXU0eNu9B5jxBgisGZp4fxihtll70KoKH91fULqPuK3L/AB5QHbXjjs2P2XVn6rf5qIw4xzUoOEkOs9qJ+fRoZdlYCWz769yemp5QO+NM1a/jB1SC6TLpN0MNApZQe4hO9R5qvytAbnII3zSX9nmP6QS9QpMhWZFcjUZRmblXdFNOp2gefI8xrAx/J4KlZkgq9oyr9/IQVDZ1T1EAE+JJFim4zmZSXBDbL7rabm5slxSRfwAg1JY/MN/VH4QGeNf2hz32p/8ANVBlSp+Yb+qPwgNVjiQRU8B1uUWL7cm4oclJTtA+aRAxZTzapDOSl7Bsl2YLZHJaCP6wT2NZ5NOwLWppZA2JNxI5qUnZA81CBfyplVT2c1N2BdLMyXCRwQgk/hAF2g3SIyJ3npGFv2RGVB1PSAio6jpDXhid3SGvAOToYELOF5UzmhVAvUCbcFjwSAkfAQXh3QJ+d9PVIZmzrqkkIeeS8DyWgH8QYD3YhyOq8pSZasUBxVQbcYQ8tpsbLzZKQTZP0xr3a8o5/CeZGI8CTZabdUJcK+cl3UlTSj33TvSeYsYJjLyqIrOX9Gm0qBV6MlpfJaPUI/8AGMGMstMP4zbUucl/R54iwm2AA594bljrrzEB5MF5uUDFyGmFupp1QXoGHljYcPuL3HobHkY7w+RECRjHKfEeCHFzTKfSqeD/AHhkEot76d6PHTnGSi51YpodIVTTOOqGzstlxsOrbHuKVu8b27oC4M2MK4GmJNc5WHU02qOJJbclUhTzx95vcoe8bfWgYn1Lp9S7Onu9qBYkDUAx08hS8V5jVhxMs1MTC3Td5alE+Ljh3ePgIu3BGRlGoKW5qs7FUnBr2dvmEHodVnrpygKgwlllibHrqJhaPR6ffWYeBS0OOyN6z08TFq1/LCgYLyvqrsqwZqfDbYM2+AVD5xF9kbkDprzi4G2koQlKQEpSLAAWAHARw2btbpsngidpb022mdmgjs2AbrsFpUVEdybA6nwgKa+T/wDtQc+zzH9IKRs6p6iBb+T8oLzLcWncZeYI+EFG3vT1EAGONf2izv2p/wDNVBkyx+Yb+qPwgOcaD9Y05zmX/wA1UXhjPOmm0SmmXojqZiaKAn0op+bbNvog+2r/AMeu6A8mfmNmZOmJw/LOBTu0l6Zsdx3tt9b+seQTxjS/J0wu4H57Ecwg2SkyzJI3qVYrI6Cw8TFd4ew9WszMWhCO0KCsuuvOkqDYJ1cWe8n4nSCwoFFk8P0WVpcg3sS0sjYTfeeKjzJuT1gNqndGRHteEYxE2z63hAY73APKFEUn1E9BD3gHinc/sIqqlEYrkui65Udi/YbkE3QrwUSPvRcMYZmXZm5V2XmGkusupKFoWLhSSLEGAHnInHrdJm3MO1R0NMTLl2lrNg29useAVp4gcYIsGBazNyynsIVRVSpyVvU1xXzbu/Z9xfPge/rG9wDnlMUtlqmV5tybZbASlZVZ5scLnRY62POAIdSApJBAIIsQe8RwdWybwhVqsmfXIuSyr7S2pZzs21npbT7to29OzFwrU20qarUuyo/QmCWlD+LTyMeqYxphmVQVu16ngcEvBZPgm5gPdTKTJUiRRJ0+ValJZv2W2k7I68zzOsPU6rT6JIqnKlNtSrCdNpw7zwA3k8hFa4szzpVLYW3SG+3e3B6YSUoHRHtK8bCKWna3inMKthLXpU0+7omw2l24JA0QnpYcYCysc58rTtyWH0rlgdO2IBfV0GoR1Nz0itKPhrFWYtSWGGXXEKVd5xSiEA8XHDvPmeUWhgnIWXldicxK52rh9b0RpWn31jf0T5xcsjIS1PlG5WTl25eXbFkNtJCUp8BAcTlzlZIYF2psvGbqTjfZqcA2UISdSEjfrYan4R3z8w3Jyrky8oJaYQXFk9wSLn4CJgARV2dGOJejUF2isOgzEwkGYsfYb3hHVWmn7t+IgB6rLc5iDGSkySVrmnV3SlAuorWoqsBxuYsTC2QtaqkyiaxE+ZFneUqIceVyCdyfE+ESyIwu9U8TvYim0HspQlSSRvdUNB4Ak+UEahAAgNXh3DVMwzS0SFKlUsMjVR3qcV+8pXef9iNyBaGFhD3gHibftHoYxxNveroYCDg2HFptayjpy7ojePTON2IcA36H/f8AvujyQErwrxGFAQmJdqaYcYfaQ604nZWhaQpKhwIO+KlxZkLSKq4uYoz/AOj3Tr2LgK2r8j7SfjFuwoAXpvJXG9NWUyiFPoG4sTCVDyJB+EYWcpswJlWwuWmW0neVuoQPxgpSkQ2wOEAHOLMAVnB1RZ/SLCllQ2woK20rHfZXeR3iLLyvzPw/R6emnTVORKKOi5qXRda/9Qbz4acou+qUeRrNPXJVGVbmZde9Cx38Qd4PMRTmKPk/NvPLmKDPBN9QzMHZUOQWN/iIC2JDFuHZ9sLlq1Irv3KeCFDwVYxkm8W4fkEFUxWpFFu5LwWT4JuYG2Yyqx9IL2G5SadSNxQUuj4GFL5XY/nVbC5WaZSd5WUtD4mAsvGeeUlIS65eiBXaqFhMOp1H1G+PNVuhipKDh6u5l4lHqr7Pb7Rx10lQQCdVrPeT5mLCw18n8NvJmK9PJ4lqXO2o8is6DwBi46PRJChyCJKmyrctLo12UDeeJO8nmYDHhygSWG6JL0uRRsssjVR9pajvUeZjcDQREC0PASvCvEYUBK8ZpcXV4iMG8x7pZvZTcwGcgEWOojXPsFlXFJ3GNjCIBFjqIDUw0et2TOpbN/dP/uPOptab7SFC282084ojCiO0n95PnD3B+kPOAUPDXHEecP4jzgFDERK3MecLZPEecBjKAe6G7McIzbB4jzhdmeXnEGMJAh7Rk7JXLzhdkrl5wEIUT7JXEDxh+yP7yfOKMcLedIzpllG2/wABHoblkp1MQYpeXJN1R7IUKA//2Q=='],
      ['chatgpt', 'dark', 'ChatGPT', 'data:image/jpeg;base64,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'],
      ['claude', 'light', 'Claude', 'data:image/jpeg;base64,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'],
      ['claude', 'dark', 'Claude', 'data:image/jpeg;base64,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'],
      ['codex', 'light', 'Codex', 'data:image/jpeg;base64,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'],
      ['codex', 'dark', 'Codex', 'data:image/jpeg;base64,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'],
      ['cursor', 'light', 'Cursor', 'data:image/jpeg;base64,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'],
      ['cursor', 'dark', 'Cursor', 'data:image/jpeg;base64,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'],
      ['elevenlabs', 'light', 'ElevenLabs', 'data:image/jpeg;base64,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'],
      ['elevenlabs', 'dark', 'ElevenLabs', 'data:image/jpeg;base64,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'],
      ['figma', 'light', 'Figma', 'data:image/jpeg;base64,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'],
      ['figma', 'dark', 'Figma', 'data:image/jpeg;base64,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'],
      ['framer', 'light', 'Framer', 'data:image/jpeg;base64,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'],
      ['framer', 'dark', 'Framer', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAcFBQYFBAcGBgYIBwcICxILCwoKCxYPEA0SGhYbGhkWGRgcICgiHB4mHhgZIzAkJiorLS4tGyIyNTEsNSgsLSz/2wBDAQcICAsJCxULCxUsHRkdLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCz/wAARCACgAKADASIAAhEBAxEB/8QAHQAAAgIDAQEBAAAAAAAAAAAAAAECAwQHCAYFCf/EADwQAAECBAQDBQUGBAcAAAAAAAEAAgMEBREGITFBBxJRExRSYYEIcZGU4hcYIjJCsSTB0vBTYmWEoaLC/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAH/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwDRqEK5jeX3qiLYXiUw1o0ATuhQNCSEDQkhA/h8EJWRZA0JIQMIKSEDQkhAFrTqAq3QvCfRWIQY6Fc9ocPNUqiyGN1Yqxk0I5lBYhV8yOZBYkocyLklBO6OYIa0k2srBAcdkFdylcrIEs4nZS7o/wAKDFundZPc3+H/AISMq8aiyDHv1RzBWmXcNrqp7HNzt8UBcIUDkjmQWIVZcjmQWKuIN0cyCbghBG6d0kIHdF0kIHdANneSiTZRLgDdBvXhbw6wDjnDbIj5qomry4tOQBMhhaScnNaAbsPUdDuvfN9n7BoGTqn6zX0rlmg4iqeFq5L1akTBl5qB+V1rtcN2OG7TuD+67A4a8TKZxFofeJcsl6hAAE3KF1zDOnM3xMJ0Poc0HyBwCwcN6l819KPsDwf4ql819K2chBrL7A8H+KpfNfSl9gWD/FUvmvpWzkINYHgBg46uqfzX0qp/s9YLcBd1Ty6Tf0raiTtCg/P8vBJzuhY7X33Voegsui6SEDui6SECulcoSQSuguSCYF/RAr3cFU85qbnAnLKyrdqgrcQBos3DuI6nhOvy9YpE0ZaagHJwzDm7tcN2nceozF1iFjn5AKDpaJsg7X4acS6bxFonbwCJeowABNyZN3Qidx1Ydj6HNe3XAOHa7V8JV2WrFHjvl5qAbgjNrgdWubuDoR/Ndj8M+JVN4i0PvEC0tUIAAm5NzrmG7xN8TDsfQ5oPboQhAJO0KaR0KD88YRV7SsWH+YrICC9pJTuq2k31U0DuUXSQggSi9lHm/v0SuUE+bNHMoXSvZAy5IOF23uBfUbdUrqt7vxNA6oOtYfs64IhtA5qne2f8Tb/yrPu9YJ/1P5n6Vs2JEAeRl8FDtBff+8kGsz7PGBz+qqfN/Ss2gcE8L4YrkCsUqaq8vNwHXDhM3DmnVrhy5tIFiP5rYHa+aXaDy+CDS3FjHnEnh5VO8Sxps3Qpl9oEyZM3huOfZvs/W2h/UB1uFrr7ymPelJ+UP9a6kqdPkq3TJim1KWhzMnMt7OLBeLtcD+x6EaLkLitwrneH1U7xL9pNUCZfaWmSLmGTn2cTo4bHQjzuEH2fvKY96Un5Q/1pH2lMeHIikjoe6E2/7rUiY1QTh/m0srwqmBWoJtUrqAOSNEE7ouoE3RdAroukhA7pISKBONgqXH8bVN6q1c3O22aD9A48Udu7Py/ZV9qOqw40YxIznDIE3GaQiE5XKDN7UdUdqL672WCYhtql2pJNjqUGcYlx1PS9li1ORkaxTo9MqUBkxIzTTDiwXi7XDr5Z2zGYNiFX2hB1CYiEHUIOTOKXC+b4f1XtoBiTVEmXfw8yRmw69m8+Iddx6heCaM89V3PUZCTrFNmKdUZWFNycyzljQoouHD+RGoIzBAXK/E7hfN4BqImZcxJmhzLiJeZcM2O/w4nR3Q6Ee4hB4VqsCg3S6kCgldF0kIHdK6EIFdF0rIQMlIlCR0QRcbqq1wbAeqmSq977oOs+H3EKSxvQmv5hDqMuxomoDnWIda3OP8pO+2i9Y6YD9T8QuMKHWqhh+rwanTJkwZqAbjcEHUOG7ToQum8D49kca0bvEANgTsAATUq43LD4h1Ydj6aoPa94al3kDPW2drrA7yNrfD+/chkyHvDQWfi0zz0QaAf7QOMe0d2cKkw2EmzO6F1hfIX5s7dUh7QOMx+ikH/ZfUtYHVJBtIe0JjMaQqP8l9SwcQca8VYmw7OUWfh0sSk40Ni9lKcrjYggg8xsbjotdqTUFrbWUxkqRkrBmgldF0s0WQO6LpWKASgQclzBQ5kIJh90ON1AlF0CcoKd7qJ1QJZ9ErM9h+rQanTJh0CagHI2uCN2kbgjZYCEHT2D8ZSWNKT3qUAgTkFoEzKE3MI+JvVhzz9CvQyz396Zdxtc/suT6LWp7D9Vg1KmzDpeagnXZw3a4btPQrpbAuKpDHUrCmZK0vOQSBNyd84R8TfEwnQ7aHzDlu9y73pINg4+ZQgFIJBMIJAKYNlWNVLmQS5yjn81C46IOiCzmS5vd6qAKCQdkDifhiOGmahdZE1D0ePcVioJXTvZQQgkTdIpIQCEIQGyypCpTlLm2zdPm40lMAFvaQXlrgDqLjZYqEDOZvtsUkIQMISQgknzKCaB3RfySRdBK4ClD/FFaLXzVSypWHq8+4IMgi4sVhRoJhO6tOhWckRcWKo+ahZUSV3YfQqh0J7b3YcvJQQQhCAQhCAQhCAQhCAQhCAQhCAQpthPdazDn5K+HK7vPoEFUGCYrujRqVmgWFggCwsE1R//2Q=='],
      ['gemini', 'light', 'Gemini', 'data:image/jpeg;base64,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'],
      ['gemini', 'dark', 'Gemini', 'data:image/jpeg;base64,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'],
      ['gmail', 'light', 'Gmail', 'data:image/jpeg;base64,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'],
      ['gmail', 'dark', 'Gmail', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAQDAwMDAgQDAwMEBAQFBgoGBgUFBgwICQcKDgwPDg4MDQ0PERYTDxAVEQ0NExoTFRcYGRkZDxIbHRsYHRYYGRj/2wBDAQQEBAYFBgsGBgsYEA0QGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBj/wAARCACgAKADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD43oooqgCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAoopQrMcKpP0FACUUEEHBGDRQAUUUUAFFFFAHVfDzwHqnxE8bReH9MligAQz3NxKRiCEEBnxnLH5gAB684AJH2P4d8L+E/A+mw2XhjRbWOaGD7O+oyRKbi4Utube4ALAsM4PAwAAAAB5h+zBpJtPhz4j8QrdEm9uxZeRtxs8lEbfuzzn7SRjHG3qc8etyn5a2iko36n6nwdk9H6usVUjeUvwVyjrttpviLSJNJ1/Tba+snJbypEyFYqV3r/dcBmAYYYZOCK+aPil8Irvw9qcus+FbK4u9DlDytDCrStY7VLMG6kxBQSHPKgEMTgM30pKarfaHhk3IxGDng459c9j715VbEOlK59Rm3DGFzSlZrln0kt/+CvI+HKK90+IfwbhnS+8ReD8LJkSto6RYB67zEQeD90iPGD8wUg7EPhddNGvCtHmgz8XzXKMTldZ0cTG3Z9Gu6/q66hRRRWx5gUUUUAFFS21tc3t7DZ2dvLcXEzrFFDChd5HY4Cqo5JJIAAr6c+DnweXwfqMfi3xrBE+swyE6fYJIsq27KeJiykqX4ypBIXhh820pxY/H0sFSdWq/l1Z6WWZViMxq+zoR9X0RhfBX9nu38UaSni74gG7tNHcq1lYxN5cl2NwJdzjIjYAqAuGbdu3KAu/6/wBGew0vTodN0PSbHTbCHPlW1vAqImWLHaoAVckknAHJNcpDdy3UweUjA4VRwFHoBXRWJ6V/PvGGf4nMZvnlaC2j0X+b8z9Do5DQy+ny2vLqyz4v8E+EviX4Xk0Pxdo9vcIY3S3u0RRPZsxUl4XIJRsohOOG2gMGXIP55fFX4Z6x8KPiJN4X1eeG6Roxc2d3CQBcQMzKrlcko2UYFT0KnBZSrH9KLL7tfLn7cDEweA0J+79vOPr9mH/stdnhjxBiqeYxy2cnKnNOyfRpN3Xa9mmj5PPMJTUXVirNHyJRRRX9BnywUUUUAfUn7Ot8lj8IpnmYiB9Xu0k9gYbTn8K9dmjAQMrBkPKsOQRXiPwP/wCSFXP/AGF7r/0VZ16HpmuS6efs8wMtqeqd19x/hXk/2oqGIlRq/D0fb/gH7zwpg5VMno1Ke9np31ZrXC9azZjg4rXl8qeAXFvIJIm6MO31rKuF61OMs9UfUYd30KLyMjblPNef/EL4cWHivSjqGh2ltZ65AGYiNRGt4CSxD44L5JIc887WJXaY+5nJBqFHIYEHBHevAWJnQqc8GVmWT4bNMO6GJjdfin3T7/1sfJmsaPqWga5c6Pq9o1re2zbJImIPbIIIJDKQQQwJDAggkEGqNfUvjHwRpHj20t476c2N/AQsV9HGHYIWyyFSV3DkkAkYYkgjLZ+cfEvhvVfCniGbR9XhCzR8pImTHMnZ0JAypx3AIOQQCCB9TgsdDEx00l2PwLiPhjE5LV9/3qb2l+j7P8+nlkVc0vS9Q1vWLfStKtXury4fZHEnUn6ngADkk8AAk8Vq+E/BXiLxrqMlpoNl5wh2med2CRwhmwCxPU9TtGWIViAQpx9O+GND0nwB4WGhaERLcSESXl+Rhp5ACM/QZYKOignHLOzGNx8MNHvLsPhzhfE5zUuvdpreX6Lz/L8DL8EfDbQPh20N/I51LxEYNkkz4MUDHO7ylwCAQQvzZYgE/KHKDvrWeSebzZnLuxySa51HJkyTkk8k1u6dkkV+d51iZ105TZ+44bKMNlmGVHDxsvzOs0/kiut05eBXLaYnSupiubXTrE3d7KIolHU9SfQDua/Jc1pzqz5IK7eyR8nnGIp0ISqVJJRWrb2R0tt5cVu00zrHGgyzscACvj39sXV11fU/Cs0Ofs8Yu0iz3H7nn8f8K9w1rxVc6zJ5KZgs1Pywg9fdvU/yr5y/aak3weFfb7V/7Sr9K4B4TlluIji8V/Eadl/Kmvz/ACP59x/GcM2zSng8J/CTd3/M1F/h+Z8+0UUV+xHrBRRRQB9J/A//AJIXc/8AYYuv/RVnXWSdTXJ/A/8A5IXc/wDYYuv/AEVZ11j9TXxea/7zM/o3gb/kTUfn+bLGn389lJmM5RvvRno1bLPDdwGa3P8AvIeq1zidazvF2u33hnwFqGu6b5X2m18l0Eq7lYGeNWUjrgqzDggjPBBwanB15tqj0f4Ht5nUp4WjPFy+wm3bqkrm9cp1qjyDWf4X8d6B47t5W0oTW15CivNZ3G3eMgZKkcOoY7d2BnglV3AVquhB6Vli6Uqc+WS1Ly3H0MdQVfDy5osRXqHV9G0XxNpUmm69ZRTxvGY0nKAywZwd0bYyrZVTkdcYIZSVL8EGlD1hTqSpyUouzOjFYSliqbo1oqUXumO0mw0vwv4ai8P+HoTDaJkySt/rJ3OMux9TgfkB0AAGamlyaQAk0VKkqknKTuwwuEpYWmqVGNoroSwZaQV02mJ0rnrZCZAMc1n+NPiXo/gHw/IYpra+1xz5cGnrIGMbbQd8wByiAMp5wXzhf4mTz8ThKuKkqVFXkzy88zCjgqDrV5WS/qy8z1lb620u1E1xlm/gjHVj/Sua1TWrrU7nzLh/lX7kan5UHt/jXLeDPEWq+JPg5outa1ci5vriWfzZRGse7a5UfKoA6AdvfrmrbzHPeu/LeHKWAk6klzVO/b0/z3Z/DPiJ4g4vO8bUwkfcoQk0o92na8u/ktl5vU1Y5+a8W/aPffb+GPb7T/7Sr1aOY5ryD9oR99t4b9vtH/tOvpcFTarRf9bHzPCFfmzaiv8AF/6Szw+iiiveP20KKKKAPpP4H/8AJC7r/sMXX/oq0rrH6muT+B//ACQu5/7DF1/6Ks66yTqa+LzX/eZn9G8Df8iaj8/zY1Otc38Tv+SN65/uQ/8ApRFXSJ1rm/id/wAkb1z/AHIf/SiKsMD/AB4eq/M9LiX/AJFWJ/wS/JnznpOrajoWtW+raTdNbXlu2+ORQDjjBBByGUgkFSCCCQQQSK+gvhr4+i8Z2X9k6iyR67BGXIAx9qjUZZ1H95QCWUdACw+UNs+cKOhyK+wxeDp4mPLLfoz+fch4hxWTVvaUHeL3i9n/AJPs/wBND7DeMq2CMGoWXFeZeAfi5ZT6bbaF4vllS8WQRQ6k2PLdCDgzMTlWBAG7kMGy20qzP6tNA8blXBBBxyK+PxWEqYaXLNH9BZHn+Fzej7XDy16rqn5/57MrKtTIn/6/SkZoobd55pEihjUu8jnCqoGSSewA5ryb4hfFm5sdVbRfBWoIvkbkuNTg2yBnIKlYW5Hy54lXncAUICh3eEwdTEy5YbdWRn3EOFyej7Su7ye0Vu/+B3f/AAxt+OvivB4Wu7rQtEgS71VIzG9w7Ax2cuRwVwd7AbsqcANjduwyV8/3FxPd3ct1dTSTzyuZJJZGLM7E5JJPJJPeo6K+wwuDp4aPLBa9X3P59zvPsVnFf22Iei2j0S/rd9fwPqr4YnH7P/h7/rrc/wDow1tu3NYPwzOPgD4f/wCutx/6MNbTtzXvU8o9pBTtvqfyrns7Zlif8c//AEpk0bc15J8fzm28Of8Abx/7Tr1eNq8m+PhzbeHf+3j/ANp1GIyv2FN1LbHqcFSvnND/ALe/9IkeK0UUV5x++BRRRQB9J/A//khd1/2GLr/0VaV1j9a5P4H/APJC7n/sMXX/AKKs66yTrXxea/7zM/o3gb/kTUfn+bGp1rm/id/yRvXP9yH/ANKIq6ROtc38Tv8Akjeuf7kP/pRFWGB/jw9V+Z6XEv8AyKsT/gl+TPmaiiivuz+YAr0jwh8YNX8P2I07WbaTWrGG3WG1j85YJINp+XMmxi6hSVwwyAEAIVdp83orOrRhVjy1FdHZgcwxGAq+2ws3GXl+vR/M7zxv8UdU8X2h0y3tF0zS9wdoFkMkkuAvEj4UFQwLABV6jduKqRwdFFFKlClHlgrInG46vjarr4mblJ9X/WgUUUVocp9UfDJN3wA8Pn/prcf+jDW28fNZfwtXP7Pvh/8A663P/o1q3nj5r9XyzA8+EpStvFfkfgec5fzZhiJW3nL/ANKZXjjryX4+rttvDv8A28f+069kjjryD9oRdtv4b/7eP/adcfEGC9ngKk/T/wBKR6XCOB9lm1Gdtub/ANJZ4fRRRX5oftQUUUUAfSfwQ/5IVc/9hi6/9FWdda4ya+fvhZ47tfB2r3VpqVurafqJjWa5AYvAV3YbA6r853AAtwpHQq3uc3iPwtFO0beJ9EYqcEpfwyD/AL6ViD+Br5PNsNU9u5pXTP3jgTOcJ/ZkKEqijOF002l10epcUYNc18Tv+SN65/uQ/wDpRFWr/wAJR4V/6GbR/wDwLT/GuR+J3i7w2/w1vtKtdXt727vtiQpZyLLt2SxuS+D8q4UgHqSRgEBivLgaFT28Pde6PZ4lzPCPK8QlVjdwklqt2rI+f6KKK+2P5uCiiigAooooAKKKKAPrD4Vtj9n7w+P+mtz/AOjWroWbJrzj4WeN/DS/Cix0G81a2sbvT5ZPMW7kWIOHdmBTJ+YY6+h69iev/wCEr8Kf9DRo3/gWn+NftORYvDrAUU6i+FdV2Py7M8LW+t1XyP4n08zaR8GvHf2hWzB4a/7ef/aVejSeL/CMMEk8nijSNkaNIwW7QsQBk4GcseOAMk9ACa8H+K/ji28YeJIINKZ20rT1dIZHUL5zsRvlUFQwUhUAVufl3YUsVHmcXZjhvqMqMZpylayTvs0/0O/h3BVvrcari1GN9WvK36nAUUUV+Un6EFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQB/9k='],
      ['hbo', 'light', 'HBO Max', 'data:image/jpeg;base64,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'],
      ['hbo', 'dark', 'HBO Max', 'data:image/jpeg;base64,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'],
      ['jetbrains', 'light', 'JetBrains', 'data:image/jpeg;base64,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'],
      ['jetbrains', 'dark', 'JetBrains', 'data:image/jpeg;base64,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'],
      ['office', 'light', 'Microsoft 365', 'data:image/jpeg;base64,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'],
      ['office', 'dark', 'Microsoft 365', 'data:image/jpeg;base64,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'],
      ['miro', 'light', 'Miro', 'data:image/jpeg;base64,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'],
      ['miro', 'dark', 'Miro', 'data:image/jpeg;base64,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'],
      ['museai', 'light', 'Muse AI', 'data:image/jpeg;base64,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'],
      ['museai', 'dark', 'Muse AI', 'data:image/jpeg;base64,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'],
      ['notion', 'light', 'Notion', 'data:image/jpeg;base64,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'],
      ['notion', 'dark', 'Notion', 'data:image/jpeg;base64,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'],
      ['outlook', 'light', 'Outlook', 'data:image/jpeg;base64,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'],
      ['outlook', 'dark', 'Outlook', 'data:image/jpeg;base64,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'],
      ['primevideo', 'light', 'Prime Video', 'data:image/jpeg;base64,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'],
      ['primevideo', 'dark', 'Prime Video', 'data:image/jpeg;base64,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'],
      ['scribd', 'light', 'Scribd', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAcFBQYFBAcGBgYIBwcICxILCwoKCxYPEA0SGhYbGhkWGRgcICgiHB4mHhgZIzAkJiorLS4tGyIyNTEsNSgsLSz/2wBDAQcICAsJCxULCxUsHRkdLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCz/wAARCACgAKADASIAAhEBAxEB/8QAHAABAAMBAQEBAQAAAAAAAAAAAAYHCAUCAQME/8QAQBAAAQMCAgYFCAgGAwEAAAAAAQACAwQGBREHEiExNnRBUXGxshQXUmGBkZLSExUiMjM0VaEWJEJUgsEmYmOU/8QAGgEAAgMBAQAAAAAAAAAAAAAAAAQBAgMFBv/EAC0RAAIBAwIFAgYCAwAAAAAAAAABAgMEERIxBRQhNHETMkFSgZHR8CIjUWHh/9oADAMBAAIRAxEAPwDSK8TTRU8D5ppGRRRtL3veQ1rWgZkkncAk00VPA+aaRkUUbS973kNa1oGZJJ3ALON933V3jiAa0Pp8MgdnBTk7Sd2u/Le4+4A5DpJrKWkSu7uNrHL6t7ImVz6a/wASltym62+WVDe0ZsZ8JBd2FqrvELyuPFXzGrxute2dupJG2Usjc3LIjUbk3Ijfs2riIl3Js8rWvK1Z5lL8BERQKhERABERABERABERABERAHbw+8rjwp8JpMbrWNgbqRxulL42tyyA1HZtyA3bNisS2NNf4dLcdN1N8sp29gzez4iS3sDVUCKVJoao3lai8xl+DXcM0VRAyaGRksUjQ9j2EOa5pGYII3gr2s3WJfdXZ2IFrg+owyd2c9ODtB3a7M9zh7iBkegjR0M0VRAyaGRksUjQ9j2EOa5pGYII3gpiMtR6q0u43Ucro1uio9Ndz/l7cpZeqer1XfAw5H/Igj0CFUC7d5Yg7Fb1xerM7Khrql7Y5GZFro2nVZkRsI1Q3b071xEvJ5Z5W8rOtWlJ/qCIuxbFtVd14v8AV1FLDFN9G6XWmJDchl1A9ajcXjFzajFdWcdFZHmRuL+9w343/KnmRuL+9w343/KraGNcjcfIyt0UsurR5itoYdFW19RSSxyyiICFzic8iekDZsUTVWsbi9SnOlLTNYYREQZhERABEUstXR5it3YdLW0FRSRRxSmIiZzgc8gegHZtQlnY0p051ZaYLLImisjzI3F/e4b8b/lTzI3F/e4b8b/lVtDGORuPkZW6LsXPbVXamL/V1bLDLN9G2XWhJLcjn1gdS46rsKyi4ScZboK39Clz/mLcqpeuek1nfGwZn/IAD0yVUC7dm4g7Cr1wirE7KdraljZJH5BrY3HVfmTsA1S7b0b1MXhjFnWdGtGS/UcRERQKhT/Qzx8eUl72qAKf6GePjykve1Wjuhuy7iHkv9Mx1osrXFLILoxUCR+Xlk39R9MraUtJ6i8vOVSeM5Le04H/AIjQ86PA9UYvTnvcMnPc4etxK8rCTy8nlru45ip6mMBF6Yx8kjY42ue9xyDWjMnsC79LYd01jA+HAqzVO0F7BH4iFGMmEac5+1ZI8i71ZZFz0EZfUYFWtY3e5keuB8Oa4RBa4tIIIORB2EIwEoSh0ksHxXnoPP8AxGu50+Bioxemve0ZNe5o9TiFMXpeTe0uOXqepjJrzMdaLK1uyyG6MKBkeR5ZD/UfTC1SmIy1HqbO85pN4xgoDTNx8OUi73KAKf6ZuPhykXe5QBYS3Z5e97ifkIiKooEREAFP9DPHx5SXvaoAp/oZ4+PKS97VaO6G7LuIeS/1lO4+KcV5ybxlasWU7j4pxXnJvGVpUOzxn2Q+pzV3bStWtu7Gm0NKfo42jXnnIzETev1k9AXDWh9E+Cx4VYtNUaoE+IfzEjstpB2NHsbl7ys4Ryzk2NsrirplsurOzbdn4Pa1K2PD6VolyyfUPGtK/td/oZBd3ILnY9jdJbuCVGJ1hP0MDc8m/ecScg0esnYqSxPTJctXUudQ+TYfDn9ljYxI7L1udv8AYAtnJR6HpK11Qs0oP7Iv5Rm6rDwa66d3lMAgrMvsVUTQHtPr9Ieo/sqwwLTPjVLVsGMRxV9KTk8xsEcjR1jLYewj2q7qKsgxGhhrKWQSwTsEkbxuIIzBUpqRNKvQvIuK6/6Zly4cArbZxqXDa9gEjNrXt+7I07nD1H9ty5avvTHgEeIWl9aMYPKcOcHaw3mNxAcO4+xUKsJLDPMXtvy9VwW3wOjbnFOFc5D4wtWLKducU4VzkPjC1YtKex2ODeyfkoDTNx8OUi73KAKf6ZuPhykXe5QBZy3Zxr3uJ+QiIqigREQAU/0M8fHlJe9qgCn+hnj48pL3tVo7obsu4h5L/WU7j4pxXnJvGVqxZTuPinFecm8ZWlQ7PGfZD6nNWn7FnZUWHgske7ySNvtAyP7grMCtzRBetPTQ/wAOYhKIs3l1JI85Ak7THn0HPaOvMjqVKbwxHhVaNOtiXxJ3pBt6puWzqmhoyPKQ5ssbScg8tOern6xn7VnGuw+swuodBX0s1LK05FszC0/vvWtV+U9NBVRGOohjmjO9sjQ4e4rWUNXU7F5w+NzLWnhmRlOLc0qYxbeBQYXT0lJUQwF2o6XW1gCScth9atzEtGtp4nrGTCIoHu/rpyYj7m7P2UJx7QhqxvlwLEXOcNogqstvqDx/sLPRKOxy+QurZ66Tz4/6cHFtL+L4xg9Xh1RhtA2KqidE4t18wCMsxmd6r9f14lhlbhFfJRYhTSU1TH95jxt7R1j1hfyKjbe5y61WpVl/a8tHStzinCuch8YWrFlO3OKcK5yHxhasWtPY73BvZPyUBpm4+HKRd7lAFP8ATNx8OUi73KALOW7ONe9xPyERFUUCIiACn+hnj48pL3tUAU/0M8fHlJe9qtHdDdl3EPJf6yncfFOK85N4ytWLKdx8U4rzk3jK0qHZ4z7IfU5qL3CwSTxxucGB7g0uPRmcs1anmKrP16D/AOZ3zLJRb2OHRtqtfPprOCOW/pTuPAomQPmZiNMwZCOpzLmjqDxt9+anOHaccLlybiOF1VKel0Tmyt/0VAr10e1VmU1JUSVrKyOoe6MuZEWahAzGeZO/b7lD1bVKPQaV3dWr9OT2+D6mmcL0h2ti72x0+MQMldujmzidn1fayUlBBGxZB3jJXboTxusrsMr8NqZHyxURY6FzjmWNdnm3PqzbmO1XjPLwzq2XEnXmqc11f+CQaSbShuS2ZpY4h9YUbDLA8DactpZ2Efvks5bxmtekAjI7QVkmtY2LEKmNn3WSvaOwOOSioviK8YpRjKNRfE/rtzinCuch8YWrFlO3OKcK5yHxhasU09jfg3sn5KA0zcfDlIu9ygCn+mbj4cpF3uUAWct2ca97ifkIiKooEREAFP8AQzx8eUl72qAKf6GePjykve1Wjuhuy7iHkv8AWU7j4pxXnJvGVqxZTuPinFecm8ZWlQ7PGfZD6nN3hacsW4I7jtCjrA8GdjBDOM9okaMj79h9qzGpJZd5VlnYqZ4QZqSbIVFOTkHgbiOpw6D7FnCWlnL4fdK3qfy2e5oe4cAorlwWbDa5pMUu0Ob95jhucPWFSmK6G7lo6hwoRT4jDn9lzZBG7L1td09hKuW37rwe5qUTYbWMkdlm+F32ZGdrd/8ApdnYtnFSPR1rWhdpSf3Rnug0QXXVzNbPT09FGd75Zg7L2NzJVx2daFHZ+Dmkp3maaV2vPO4ZGR27d0AdAUhXNxq4cLt6jNTidZHTsy+yHHNz/U1u8nsQoqPUrQs6Fr/Nfdn5XTjkVu2zW4lK4AxRn6Mek87Gj35LLJJcSXHNx2k9ZUtv2+6i8a9rI2Op8NpyTDCTtcfTd6/V0KIrKcss4HEbpXFRKGyOlbnFOFc5D4wtWLKducU4VzkPjC1Yr09jpcG9k/JQGmbj4cpF3uUAU/0zcfDlIu9ygCzluzjXvcT8hERVFAiIgAp/oZ4+PKS97VAFP9DPHx5SXvarR3Q3ZdxDyX+sq3G138U4r9l35yboPplaqXnUb6I9y2lHUenvbPmklnGDIhaRvBHaF8V5ab2hto0OQA/nR0f9HqjVhJYeDy91b8vU9POT3HLJDK2SJ7o5G7Q5ji0jsIUgpdIF10bA2LHastGwCQiTxAqOIozgwhUnD2toktRpEu2qZqvx2qaP/PVZ+7QCo/PUT1U7pqiaSeV298jy5x9pX5IjLZM6k5+5thfQ0ncCewL4ry0INDrRrswD/OneP+jFMVqeDa1t+YqennBUFutd/FOFfZd+ch6D6YWq151Gj+ke5elvGOk9RZWfKprOclAaZuPhykXe5QBT/TNx8OUi73KALGW7PMXvcT8hERVFDt3lh7sKvXF6QwMp2tqXujjZkGtjcdZmQGwDVLdnRuXEVv6a7Y/L3HSxdUFXqt+B5yH+JJPoAKoFMlhjV5RdGtKL/UF2bXuWqtTGfrKjhhml+idFqzZ6uRy6iOpcZFGwvCbhJSjuiy/Pjj/6bhvuk+ZPPjj/AOm4b7pPmVaIra2N8/cfOyXXZpExO8MNioq2kpIWRSiUGEOzJyI6Sdm1RFEVW87i1SrOrLVN5YREQZhERABS609ImJ2fhstFRUlJPHLKZSZg7MHIDLYRs2KIohPGxpTqzpS1QeGWX58cf/TcN90nzJ58cf8A03DfdJ8yrRFbWxnn7j52dm6Llqrrxn6yrIYYZfomxasOerkM+snrXGRFXcUnNzk5S3YXbs3D3YreuEUggZUNdUsdJG/ItdG06z8wdhGqHbOncuIrf0KWx+YuOqi64KTWb8bxmP8AEEH0wVMVljFnRdatGK/UW5NDFUQPhmjZLFI0sex4DmuaRkQQd4KzjfdiVdnYgHNL6jDJ3ZQVBG0HfqPy3OHuIGY6QNIrxNDFUQPhmjZLFI0sex4DmuaRkQQd4KYlHUequ7SN1HD6NbMyIit+59Cn4lVblT1u8jqHdpyY/wCEAO7S5V3iFm3HhT5hV4JWsbA3XkkbEXxtblmTrtzbkBv27Eu4tHla1nWovEo/g4iIigVCIiACIiACIiACIiACIiACLt4fZtx4q+EUmCVr2zt145HRFkbm5Zg67sm5Ebtu1WJbGhT8OquOp6neR07uw5Pf8QIb2hylRbGqNnWrPEY/ghtiWJV3jiBc4vp8MgdlPUAbSd+ozPe4+4A5noB0dDDFTwMhhjZFFG0MYxgDWtaBkAANwCQwxU8DIYY2RRRtDGMYA1rWgZAADcAvaYjHSeqtLSNrHC6t7s//2Q=='],
      ['scribd', 'dark', 'Scribd', 'data:image/jpeg;base64,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'],
      ['spotify', 'light', 'Spotify', 'data:image/jpeg;base64,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'],
      ['spotify', 'dark', 'Spotify', 'data:image/jpeg;base64,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'],
      ['telegram', 'light', 'Telegram', 'data:image/jpeg;base64,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'],
      ['telegram', 'dark', 'Telegram', 'data:image/jpeg;base64,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'],
      ['wisprflow', 'light', 'Wispr Flow', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAcFBQYFBAcGBgYIBwcICxILCwoKCxYPEA0SGhYbGhkWGRgcICgiHB4mHhgZIzAkJiorLS4tGyIyNTEsNSgsLSz/2wBDAQcICAsJCxULCxUsHRkdLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCz/wAARCACgAKADASIAAhEBAxEB/8QAHQABAQEBAQADAQEAAAAAAAAAAAgHBgUCAwQJAf/EADkQAAEDAgIGBwYFBQEAAAAAAAEAAgMEBQYRBwgSITGzEzdBUWFzsTM0NnFydRUiMoGRFFN0kpOh/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKRX11FRDSU0tTUzRwQQsMkkkjg1rGgZlxJ3AAb80qKiGkppampmjgghYZJJJHBrWNAzLiTuAA35qO9KWlKv0iXcMYJKSyUzyaWkJ3k8Okky3F5HZwaDkM8yXBouNtZT21Fg6i72fiFW36htRxf6uBf4gsWQ3fSLjG+SVLq/EtykZVM6OWFk7ooXt2dkt6NmTMiOIy378+JXNIgIiICIiAiIgIiICIiAiIg6W0aRcY2OSndQYluUbKVnRxQvndLCxuzshvRvzZkBwGW7dlwC17BOsp7GixjRdzPxCkb9I2pIv9nEs8AGKfEQf0Cp6iGrpoqmmmjngmYJI5I3BzXtIzDgRuII35r7FG+i3SlX6O7uWPElXZKl4NVSA7weHSR57g8Ds4OAyOWQLbEp6iGrpoqmmmjngmYJI5I3BzXtIzDgRuII35oMA1lMbe6YOop+6qr9h3/OM5O+by1w/tkKfF0ukW7vvmkm/wBe6qjq2PrZGRTR7Ja+JjtiPIt3EbDW7+3jv4rmkBERARe7RYJxRcrb+IUWHbnU0ZG0Jo6Zxa4d43bx8l4jmuY9zHtLXNORaRkQe4hB8UREBERAREQEREBF8mMdI9rGNLnOOTWtGZJ7gO1e3XYJxTbLcbhXYdudNSAZmaSmcGtHed24fNB4SIiAqD1a8be94OrZ++qoNt3/AEjGbvk8NaP7hKnxdLo6u77HpJsFe2qjpGMrY2SzSbIayJ7tiTMu3AbDnb+zju4oOaREQF2miOwUeJdKNot1wjEtJtPmkjIzEmwwuDT4EgZ+C4taRoC65bX5NRyigr1jGsYGtAa1oyAG4BTVrL4dordf7TeqWJsU9yZJHUbIy23M2cnnxydkT4BUsp/1pfYYY+up9I0E8oiICIv22yz3K91X9Na7fVV84GZjp4nSOA7zkN37oPxIv23Oz3KyVX9NdLfVUE+WYjqInRuI7xmN/wCy/EgIiINx1Z8O0Vwv13vVVE2We3Njjpw4Z7Dn7RLx45Nyz8SqUexr2FrgHNcMiCMwVgOq17tifzKb0kW/oIt0uWCjw1pRu9ut8YipNpk0cYGQj22BxaPAEnLwXFrSNPvXLdPJp+UFm6AiIgIiIC0jQF1y2vyajlFZutI0Bdctr8mo5RQV8p/1pfYYY+up9I1QCn/Wl9hhj66n0jQTyiIgE5Anu3q09E+GaHDWji0R0sTRNV00dVUSgfmlke0OJJ8M8h3AKK3fod8irtwZ8B2D7dT8pqDxtK+GqHEuji7x1cTTLSU0lVTykfmikY0uBB8csj3gqLAcwD371dmM/gO//bqjlOUJN/Q35BB/qIiCh9Vr3bE/mU3pIt/WAarXu2J/MpvSRb+gkHT71y3TyaflBZutI0+9ct08mn5QWboCIiAiIgLSNAXXLa/JqOUVm60jQF1y2vyajlFBXyn/AFpfYYY+up9I1QCn/Wl9hhj66n0jQTyi6bA2A7vj+9m32trGNiaHz1EufRwtzyBOXEnsA47+4labetWS50lqdPab9FcKtjczTywdCHnua7aOR+f8hBhbv0O+RV24M+A7B9up+U1QrUQy08k0E0bopYi5j2PGTmuG4gjsIKurBnwHYPt1PymoGM/gO/8A26o5TlCTf0N+QV24z+A7/wDbqjlOUK08MtRJDBDG6WWUtYxjBm5zjuAA7SSg+KLc7LqyXOrtTZ7tfobfVvbmKeKDpgw9znbQ3/L+SsyxzgO74AvbbfdWse2VpfBURZ9HM3PI5Z7wR2g8Mx3goNh1WvdsT+ZTeki39YBqte7Yn8ym9JFv6CQdPvXLdPJp+UFm60jT71y3TyaflBZugIiICIiAtI0Bdctr8mo5RWbrSNAXXLa/JqOUUFfKf9aX2GGPrqfSNUAp/wBaX2GGPrqfSNB6GrBEwYTvcoaNt1c1pd2kCJuQ/wDT/K3A8CsR1Yfg28/cBymrbjwKCKtL8TItLeJWxtDQanayHeWNJP8AJKrvBnwHYPt1PymqR9MfW7iX/IHKYq4wZ8B2D7dT8pqBjP4Dv/26o5TlImiCJkulvDTZGhwFTtZHvDHEH+QFXeM/gO//AG6o5TlI+hzrdw1/kHlPQWkOCw/WfiYcJ2SUtG22uc0O7QDE7Mf+D+FuA4BYjrPfBtm+4HlOQedqte7Yn8ym9JFv6wDVa92xP5lN6SLf0Eg6feuW6eTT8oLN1pGn3rlunk0/KCzdAREQEREBaRoC65bX5NRyis3WkaAuuW1+TUcooK+U/wCtL7DDH11PpGqAU/60vsMMfXU+kaD0tWH4NvP3Acpq248CsR1Yfg28/cBymrbjwKCLdMfW7iX/ACBymKuMGfAdg+3U/KapI0wjPS/iQd9QOWxUnofxpbsU4CttPDPGLhb6dlNU0+f52lgDQ7LtaQAQf27EHSYz+A7/APbqjlOUj6HOt3DX+QeU9UnpgxpbsLYCuVPNPGbhcKd9NTU+f53F4LS7LsaASSf27VNuh4ZaX8OAdlQeW9BaI4BYjrPfBtm+4HlOW3DgFiOs98G2b7geU5B52q17tifzKb0kW/rANVr3bE/mU3pIt/QSDp965bp5NPygs3WkafeuW6eTT8oLN0BERAREQFpGgLrltfk1HKKzddpojv8AR4a0pWi43CQRUm0+CSRxyEe2wtDj4AkZ+CC0lP8ArS+wwx9dT6Rrf2va9gc0ghwzBHapq1l8RUVxv9pstLK2We2skkqC057Dn7OTD45NzI8Qg/DoE0j2zCFbXWe9zClorg9ssVS79EcgGyQ7uBGW/gCN/Fb7etI+ErDan19XfqF8YbmxkEzZZJfBrWkkk/wogQNA4AD5BB62Kb7JifFlzvcsfROrp3SiPPPYbwa3PtyAAXmRTSwSiWGR8UjeD2OLXD9xvXwRB85ZpJ5TLNI+WR3F73Fzj+53r1MK32TDGLLZe4o+ldQztlMeeW23g5ufZmCQvIRBb9k0j4Sv1qZX0l+oWRlub2TzNiki8HNcQQR/CwHT3pHtmL62hs9kmFVRW97pZalv6JJCNkBveAM9/aTu4LHi0E7wD8wiCh9Vr3bE/mU3pIt/U06tGI6G3X272WqlbFPcmxSU+0cttzNoFg8cnZgeBVKve2NjnucGtaMyScgAgkLT71y3TyaflBZuuz0t4go8TaUbvcbe8S0m0yGOQHMSBjA0uHgSDl4LjEBERB0ukW0Psekm/wBA6ljpGMrZHxQx7IayJ7tuPIN3AbDm7uzhu4LmlQespgn3TGNFB3UtfsN/5yHJvzYXOP8AbAU+ICIiD3aLG2KbbbRb6LEVzpqQDZEMdS4NaO4b9w+S8RznPe573FznHMuJzJPeSviiAiIgIiICIiAiIg+TXOY9r2OLXNOYIORB7wV7VbjTE9yt34fXYhudTRkZGGWpe5pHcRnv/deGiAiIgLpdHVoffNJNgoG0sdWx9bG+WGTZLXxMdtyZh24jYa7d28N/Bc0qD1a8E+94xrYO+loNtv8A0kGbfkwOaf7gKDf6inhq6aWmqYY54JmGOSORoc17SMi0g7iCN2SjvSlotr9Hd3D2GSrslS8ilqyN4PHo5MtweB28HAZjLIhtkL66inhq6aWmqYY54JmGOSORoc17SMi0g7iCN2SD+fqKg8batftq3B1b3v8Aw+rd9R2Y5f8AVoD/ABJeshu+jrGNjkqW1+GrlGylZ0kszIHSwsbs7Rd0jM2ZAcTnu358Cg5pERAREQEREBERAREQEREBF0to0dYxvklO2gw1cpGVTOkimfA6KF7dnaDukfkzIjgc9+7LiFr2CdWv2NbjGt7n/h9I76TsyS/7NIZ4EPQZ1ot0W1+kS7l7zJSWSmeBVVYG8nj0cee4vI7eDQcznmA6xKenhpKaKmpoY4IIWCOOONoa1jQMg0AbgAN2SU9PDSU0VNTQxwQQsEcccbQ1rGgZBoA3AAbsl9iD/9k='],
      ['wisprflow', 'dark', 'Wispr Flow', 'data:image/jpeg;base64,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'],
      ['edx', 'light', 'edX', 'data:image/jpeg;base64,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'],
      ['edx', 'dark', 'edX', 'data:image/jpeg;base64,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'],
      ['ilovepdf', 'light', 'iLovePDF', 'data:image/jpeg;base64,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'],
      ['ilovepdf', 'dark', 'iLovePDF', 'data:image/jpeg;base64,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'],
      ['duolingo', 'light', '多邻国', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAcFBQYFBAcGBgYIBwcICxILCwoKCxYPEA0SGhYbGhkWGRgcICgiHB4mHhgZIzAkJiorLS4tGyIyNTEsNSgsLSz/2wBDAQcICAsJCxULCxUsHRkdLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCz/wAARCACgAKADASIAAhEBAxEB/8QAHAABAAIDAQEBAAAAAAAAAAAAAAQFAwYHAgEI/8QAQhAAAQMCAwQHAwkFCQEAAAAAAQACAwQRBQYSITFBUQcTIjJhcYFSkbEUFSM1YnOhwdEIMzZykhZCQ3SDsrPC4fD/xAAbAQACAgMBAAAAAAAAAAAAAAAAAwUHAQQGAv/EACoRAAIBAwMDAwQDAQAAAAAAAAABAgMEEQUhMRJBUSIywQZhcdEUI+Hw/9oADAMBAAIRAxEAPwD9IrzJIyKN0kj2sYwFznONgAN5JSSRkUbpJHtYxgLnOcbAAbySuUZkzJPj1VYaoqOM/Rxc/tO8fh7yYvUdRhYwTazJ8IVVqqmi/wAY6Qu/DhMPMdfKPMXa33EE+oWq1WP4tWukM+IVDhINLmNeWsIta2kWH4KvRcBc6jc3LzUm8eFsiNlVnPlhERaAsIiIAIiIAIiIAIiIAIiIAsKXH8WonRmDEKhojGlrHPLmAWtbSbj8FtWD9IXchxaHkOviHkLub7ySPQLRUW/bajc2zzTm8eHuhkas4cM7lHIyWNskb2vY8BzXNNwQdxBXpcmy3mSfAaqx1S0ch+ki5fab4/H3EdXjkZLG2SN7XseA5rmm4IO4grv9O1GF9BtLElyiSpVVURo/SFjH7rCYX8pZ7H+lpsfWxHslaKrDH6o1uYa6cyNlBmcGvbaxaDZtreACiQ07prkEADiVwGpXTuLmdR8ZwvwuCNqy65tmJS6Wma9mt4vfcFgmgfCe1tB3EKxibpiY3kAoupLbYWRKml0DXGOzxHJRVcKDVU2m8kY7PEcl5hPOzAioiJ4BERABERABERABSqal1jXIOzwHNKWm1WkkHZ4DmpyTOeNkBCqqZrGa2CwG8KIrWVuqJzeYKroYHzHs7AN5KzTltuBjW9dHuMfvcJmfzlguf6mi59bAe0VpU1O+GxJBB4hS8AqjRZhoZxI2ICZoc91rBpNnXv4EqU026dvcwqLjOH+HyMpS6JplerSFnVwtb4bVWMYXvDWi5Kt1E1XwhZ5exsjC1wuCvoFgByX1N5txSfsZCL2YJg3UYpAOekrwsuLXKAg1VNou9g7PEclFVwoFTS6LvjHZ4jknQnnZmCMiInAEREAFKpqbXZ7x2eA5pTUpcQ+QWbwHNTkmc8bIAiL31E2nV1UluekpKi3wjJjIuCOa+MY2Nga0WAXrjZFj7AY5mdZC5vhsVWrhVD2ljy1wsQnUnyjBPpYerj1Edp34KQit8t4UMUxMdaLwQjW8c+Q9fyXqhRndVo0ocyPUYuTwiTgWV5MRY2pqi6KnO1oHef8AoFuVHhlHQMDaanjjtxAuT671JADRYCwC+q0rDSreyglBZl3b5/wlKdKMFsFBrcHoMQaRPTsLvbaLOHqFAx3OuXstVDafFsTippnN1iMtc5xHOzQdiyYJm/AMxuLMKxWnqpGi5jDtLwOek2P4KRqUoVY9NRJr7jGk9marjmXZsJPWxkzUpPfttb4H9VTLrMsTJonRyND2PFi07iFzTGcOOF4nJT7SzvRk8Wnd+noq713SI2bVaj7H28P9EfXo9HqXBVSUkchuOyfBYDQP4PafNTkXNKckapBbQOv2ngeQWeOljjN7ajzKzohzkwCvMDy3NigE8xMNLfYR3n+X6qJgWGfOuKMhdfqm9uQj2Rw9dy6SxjY2NYxoa1osANwC6fQtHjd/31/auF5f6NuhR6/VLgi0WE0NAwCnpmNPtEXcfUqYqXHM4YBluRseLYpBSyvGoRklzyOekAmyxYNnnLWYKjqMNxennnO6IksefJrgCfRWFTpwpR6YJJfY30ktkWlZhVFXsIqKZjz7VrOHqNq0zHcsy4Y01FOXTU3G/eZ58x4rfl8c0PaWuAIIsQdxUbf6Tb3sH1LEuzXP+i6lKM0ckUarh1x6wO038Qr3MOFjCsUdGwfQyDXH4Dl6KqVW1qU7aq6c+Ysi5RcXhn1b1kuAR4M+W3allNz4DZ+q0VdAyh/D0X87/ip76Zine5faL+DYtl6y8RFpOeekmnyRXU1LNhs1Y+oiMrSyRrQLG1jdWUSJrvT3S0rsu4ZVuDRVsqjGw8SwsJcPK4aVw6mqZ6OqjqaaZ8M8Tg5kjHWc08wVfZzzriOdcUZU1gbDBCC2CnYSWxg7zfiTYXPgtcQB+pOjrNT83ZPgrajT8sicYKjSLAvbbtAeIIPqvGeYB1dJUW7V3MJ8N4+BWqdARP8AZzFhfZ8rH/GFuWePq2m+9/6lQ2uRUrCpnx8oTWWYM0lERVQRYREQBueR4AKOqqLdpzwz0Av+a2la7kr6ml++PwCi58z5DkalpJZaGWsdVucxjWPDAC0A7SfNW1o0VGxpJeCVorEEaV0/UtMKDB6uzRVda+IHi5mm5HkDb3+K4o1zmPa9ri1zTdrgbEHmDwV7m/OGI5yxcVtdpjZG3RDBH3Ym8fMniVQKWGn6S6Js4VGacsyRV8hkr8PcIpJDvkaRdrj47CD4i/Fb4uI/s/k/L8cF9nVw/F67cgDWc7QB2GQT27Ucun0I/wDAtJW+5y+of9Vv5rQlWf1LFRvm13SI25XrC6BlD+Hov53/ABXP1veTJg/BXRX7UUpBHntXr6Zkle4feL+DNt7zYVwnp9/iPCf8q/8A3ruy5h015VqMYwOmxaiidLNhurrWNF3GJ1rkDjpIB8rqyiROAIi+ta57g1rS5zjYAC5J5AIA7p0Bfw7i3+bb/wAYW554+rab73/qVD6Lsrz5WyXFDWM0VlU81EzDvYSAA0+IAF/G6zZ5mHU0kF+0XOf6AW/NQ+tyUbCpnx8oTWeIM09F6jjdIeyPVTYMLknF2guHPcFU2d8GvQsa9ddUFt5eyICKfPhckAu4FoPHeFCkidGe0PVGd8Ga9jXoLqmtvK3N4yV9Sy/fH4BaD+0B9X4H99L/ALQt4yPMHUNTBfayQO9CP/FXdLOVqjM2T70UZlrKGT5RGwb5BYhzR42Nx4hW3o0lKxpNeDYo+xH5qRfSCCQdhGxfFLDTsH7P/wBYY593D8Xrty5x0M5VqMBy1PX1sToqnEnNeI3CzmRtHZvyJuTbxC6OgCgzl9Q/6rfzWhLd87ThmFww/wB6SW/oAf1C0hVn9SyTvcLskRtz7wrrLGKtw3E9MrrQT2a4+yeB/wDua16lm62KxPabsKzqEt687StGrDmImMnF5R1wG6LSMCzU6jY2lrtT4W7GyDa5o5HmFuNNWU9ZGJKeZkrTxabq1bHUqF9BSpvfuu6/7ySkKkZrY1HGuifKeNVTqmShfSTPN3upZDGHHmW7vwUrL3RvlnLNS2poqDrKpvdnqHmR7fK+wegW1KNWYjSUEZfUzsj8Cdp8hvW/Ocaceqbwj22luzO97Y2Oe9wa1ouSdwC5vjNecXxh8rb9WOxHf2Rx9d6l49mWTEwaenDoqW+2/ef5+HgqSOTqn6rXVea/q8bv+ih7Vy/L/RqurTnUjGb9Odye1oY0ACwCs6SuhipmsfdpbyF7rWjjcLZC10b7DiLFZ2YtRv8A8XT/ADAhcnFVKbykd3GiqtKLgvT2x4L6rroZaZzGXcXcxayrHND2kEXBUR+LUbP8XV/KCVg+e4S8NbE+x4mwsiUalR5aCVJUqUnNenvnwW2B4j8z4wHSH6F/Yk8juPoujNcHNBaQQRcELk0knWu1Wts4K+wHM78Oa2mqg6WmHdI7zP1C67QNYjar+PXeIvh+H+jhFVpwqSjB+nOxPzB0Z5YzHVOqqugMNU83fNTvMbnHmbbCfEhY8D6K8q4DVsqoaF1TURm7JKp5k0nmBuv42W00lfS10YfTTslHgdo8xvCkKwoTjNdUXlG0nngISALnYAsFVXU1FGX1M7Im/aO0+i0zHc0Or2OpqMOjpzsc47HP8PAKOv8AU6FjBubzLsu4upVjBbkPMmKDE8UJjN4IRoYefM+v5KpRR6ubq4tIPad+AVVV607qtKrPmTIuUnJ5ZBjkdG8OadoVjDO2ZtxsPEKsQEtNwbEcQvcoKR5LhfWPdG7Uxxa7m02Kr4657RZ4DvHcVnFbEd+oeiR0Si9jJYHEK0t0msnI5dY79VHJLnFziSTxO0rB8sh9o+5Y3VzB3WE+exepOpP3Nv8AIN55JW4KFU1WoFkZ2cTzWGWokl7xsOQ3LGvUKeN2YPDxfavCzLyWAp6Z12k67C3pKhcJ4XDXyY17YOK+hgC9IbDVtdhcUnQt08Plv4JVNVaAGSHs8DyU0G4uNoVQskU8kXdOzkdyROnndHIlq1xa7U0lpHEGxWf5wrdOn5ZUW5dY79VWMrmnvsI8tqyfLIfaPuXmLqQ2i2jKbXBIc5z3anOLncyblfFGdWxDdqPosMla92xgDBz3leeiUnuYJU07YW7druAVa97pHlzjclfCSTcm5KJ8YKIFhj9KaLMNdAY2xATOLWNtYNJu21vAhV63rpCwf91i0LOUU9h/S42Hpcn2QtFUlqNs7a5nTfGcr8MZVj0TaCIi0BYREQAREQAREQAREQAREQAREQAREQAVhgFKa3MNDAI2ygzNLmOtYtBu69/AFV63ro9wf97i0zOcUFx/U4XHpcH2gt/TrZ3NzCmuM5f4QylHrmkbxJGyWN0cjGvY8FrmuFwQd4IXKMyZbnwGquNUtHIfo5eX2XePx94HWV5kjZLG6ORjXseC1zXC4IO8ELv9R06F9BJvElwySq0lURw1FvWMdHvfmwmbmeolPmbNd7gAfUrVarAMWonSCfD6hojGpz2sLmAWvfULj8VwFzp1zbPFSDx5W6I2VKcOUV6Ii0BYREQAREQAREQAREQAREQARWFLgGLVroxBh9Q4SDU17mFrCLXvqNh+K2rB+j3uTYtNyPURHyNnO94IHoVv22nXNy8U4PHl7IZGlOfCKDLeW58eqrnVFRxn6SXn9lvj8PcD1eONkUbY42NYxgDWtaLAAbgAkcbIo2xxsaxjAGta0WAA3ABel3+nadCxg0nmT5ZJUqSpo//Z'],
      ['duolingo', 'dark', '多邻国', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAcFBQYFBAcGBgYIBwcICxILCwoKCxYPEA0SGhYbGhkWGRgcICgiHB4mHhgZIzAkJiorLS4tGyIyNTEsNSgsLSz/2wBDAQcICAsJCxULCxUsHRkdLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCz/wAARCACgAKADASIAAhEBAxEB/8QAHAAAAQUBAQEAAAAAAAAAAAAAAAMEBQYHAgEI/8QAQxAAAQMCAwQHAwgHCQEAAAAAAQACAwQRBQYSITFBUQcTIjJhcYEUUrEjNWJzkaHB0QgVMzZygpIWQkN0g7KzwuHw/8QAGwEAAgIDAQAAAAAAAAAAAAAAAAUDBwECBgT/xAAqEQACAQMDAwMEAwEAAAAAAAAAAQIDBBEFITESQVEiMsEGYXHRFCPh8P/aAAwDAQACEQMRAD8Aw1dRxvmlZFEx0kjyGta0XLidwA4lEcb5pWRRMdJI8hrWtFy4ncAOJW15SylT5ao9TtM1fKPlZgNg+i3k347zwAWalqULCCbWZPhEVWqqaKzgPRd3J8bn5H2aE+Rs532ggejlc6PLOCUDYhT4XStdEdTHujD3g3vfUbm9/FSqFwFzqVzcvNSbx4WyFsqs58sEIQl5GCEIQAIQhAAhCEACEIQAIQhAEVWZZwSvbKKjC6VzpTqe9sYY8m976hY3v4qmY90Xd+fBJ+Z9mmPmbNd9gAPq5aQhMLbUrm2eac3jw90SRqzhwz5ykjfDK+KVjo5GEtc1wsWkbwRwK5W25tylT5lo9TdMNfEPkpiNh+i7m34bxxBxSSN8Mr4pWOjkYS1zXCxaRvBHArv9N1KF/BtLElyhlSqqojRei7Af22Nzx84afUP6nC4/lBB94LSFFZZoxQZXw6nEToXNga57HXuHkanXvtB1E7FNQ07prkEADiVX+pXTuLmdR8ZwvwuBbVl1zbEk7paZr2a3i99wSE0D4T2toO4hSMTdMTG8gErqS22IxpU0uga4x2eI5JqphMaqm03kjHZ4jktYTzswGqEIU4AhCEACEIQAIQhAAnVNS6xrkHZ4DmilptVpJB2eA5p8oZzxsgGVVTNYzWwWA3hNFKyt1RObzBUdDA+Y9nYBvJWacttwE1m/SjgP7HG4I+UNRpH9LjYfykk+6Fps1O+GxJBB4hQuZqMV+V8RpzE6ZzoHOYxt7l4GptrbSdQGxNNNunb3MKi4zh/h8klKXRNMlVKQs6uFrfDaoxjC94a0XJUulNV8IjOXsbIwtcLgr0CwA5L1G824qH7GQQuzBMG6jFIBz0lcLLi1ygGNVTaLvYOzxHJNVMJhU0ui74x2eI5KaE87MwNkIQpgBCEIAE6pqbXZ7x2eA5opqUuIfILN4DmnyhnPGyAEIXfUTadXVSW56SoVFvhGRMi4I5rxjGxsDWiwC642QsfYBOZnWQub4bFFqYUQ9pY8tcLEKak+UYH9LD1ceojtO+5OEKXy3hQxTEx1ovBCNbxz5D1/BbUKM7qtGlDmRtGLk8Ic4FleTEWNqaouipztaB3n/kFcqPDKOgYG01PHHbiBcn13pyAGiwFgF6rSsNKt7KCUFmXdvn/BpTpRgtgTGtwegxBpE9Owu99os4eoTDHc65ey1UNp8WxOKmmc3WIy1znEc7NB2JTBM34BmNxZhWK09VI0XMYdpeBz0mx+5MalKFWPTUSa+5I0nsyq45l2bCT1sZM1KT37bW+B/NQy1mWJk0To5Gh7HixadxCzTGcOOF4nJT7SzvRk8Wnd+Xoq713SI2bVaj7H28P9C+vR6PUuCKkpI5Dcdk+CQNA/g9p80+QuaU5I8oxbQOv2ngeQS8dLHGb21HmUuhDnJgCnMDy3NigE8xMNLfYR3n+X5ppgWGfrXFGQuv1Te3IR7o4eu5aSxjY2NYxoa1osANwC6fQtHjd/31/auF5f6PXQo9fqlwNaLCaGgYBT0zGn3iLuPqU8ULjmcMAy3I2PFsUgpZXjUIyS55HPSATZJYNnnLWYKjqMNxennnO6IksefJrgCfRWFTpwpR6YJJfY96SWyJSswqir2EVFMx5961nD1G1UzHcsy4Y01FOXTU3G/eZ58x4q/LxzQ9pa4AgixB3FLb/Sbe9g+pYl2a5/0jqUozRkibVcOuPWB2m/eFO5hwsYVijo2D5GQa4/AcvRRSq2tSnbVXTnzFiuUXF4Z6r1kuAR4M+W3allNz4DZ+aoq0DKH7vRfxv+KffTMU73L7Rfwei2XrJxCFSc89JNPkiupqWbDZqx9REZWlkjWgWNrG6soYld6e6Wldl3DKtwaKtlUY2HiWFhLh5XDSsOpqmejqo6mmmfDPE4OZIx1nNPMFT2c864jnXFGVNYGwwQgtgp2ElsYO834k2Fz4KuIA+pOjrNT83ZPgrajT7ZE4wVGkWBe23aA8QQfVcZ5gHV0lRbtXcwnw3j4FVToCJ/s5iwvs9rH/GFcs8fNtN9b/1KTa5FSsKmfHyiGsswZSUIQqoFYIQhAFzyPABR1VRbtOeGegF/xVpVdyV8zS/XH4BNc+Z8hyNS0kstDLWOq3OYxrHhgBaAdpPmra0aKjY0kvA1orEEUrp+paYUGD1dmiq618QPFzNNyPIG32+KxRrnMe17XFrmm7XA2IPMHgp3N+cMRzli4ra7TGyNuiGCPuxN4+ZPEqATYlPpLomzhUZpyzJFXyGSvw9wikkO+RpF2uPjsIPiL8VfFiP6P5Pt+OC+zq4fi9bcgCs52gDsMgnt2o5dPoR/4FSVfc5fMP8Aqt/FUJVn9SxUb5td0hbcr1gtAyh+70X8b/is/V7yZMH4K6K/ailII89q2+mZJXuH3i/gzbe8sKwnp9/ePCf8q/8A3rdlmHTXlWoxjA6bFqKJ0s2G6utY0XcYnWuQOOkgHyurKGJgCEL1rXPcGtaXOcbAAXJPIBAG6dAX7u4t/m2/8YVzzx82031v/Upn0XZXnytkuKGsZorKp5qJmHewkABp8QAL+N0tnmYdTSQX7Rc5/oBb8Un1uSjYVM+PlENZ4gynoXUcbpD2R6p7Bhck4u0Fw57gqmzvg89Cxr111QW3l7IYIT+fC5IBdwLQeO8JlJE6M9oeqM74M17GvQXVNbeVuXjJXzLL9cfgFQf0gPm/A/rpf9oV4yPMHUNTBfayQO9CP/FHdLOVqjM2T70UZlrKGT2iNg3yCxDmjxsbjxCtvRpKVjSa8Hoo+xHzUhekEEg7CNi8TYlNg/R/+cMc+rh+L1tyzjoZyrUYDlqevrYnRVOJOa8RuFnMjaOzfkTcm3iFo6AIDOXzD/qt/FUJXfO04ZhcMP8Aeklv6AH8wqQqz+pZJ3uF2SFtz7wU1ljFW4biemV1oJ7NcfdPA/8A3NV6lm62KxPabsKXSS3rztK0asOYkMZOLyjXAboVIwLNTqNjaWu1PhbsbINrmjkeYVxpqynrIxJTzMlaeLTdWrY6lQvoKVN7913X/eRpCpGa2KjjXRPlPGqp1TJQvpJnm73UshjDjzLd33J1l7o3yzlmpbU0VB1lU3uz1DzI9vlfYPQK1JtWYjSUEZfUzsj8Cdp8hvXvnONOPVN4Ru2luxd72xsc97g1rRck7gFm+M15xfGHytv1Y7Ed/dHH13p3j2ZZMTBp6cOipb7b95/n4eChI5OqfqtdV5r+rxu/6KHtXL8v9HldWnOpGM36c7j9rQxoAFgFJ0ldDFTNY+7S3kL3VaONwtkLXRvsOIsUuzFqN/8Ai6f4gQuTiqlN5SO7jRVWlFwXp7Y8E9V10MtM5jLuLuYtZRjmh7SCLgpo/FqNn+Lq/hBKQ/XcJeGtifY8TYWRKNSo8tBKkqVKTmvT3z4JbA8R/U+MB0h+Rf2JPI7j6LRmuDmgtIIIuCFk0knWu1Wts4KewHM78Oa2mqg6WmHdI7zPzC67QNYjar+PXeIvh+H+jhFVpwqSjB+nOw/zB0Z5YzHVOqqugMNU83fNTvMbnHmbbCfEhJ4H0V5VwGrZVQ0LqmojN2SVTzJpPMDdfxsrTSV9LXRh9NOyUeB2jzG8JwrChOM11ReUepPPAIJAFzsASFVXU1FGX1M7Im/SO0+ipmO5odXsdTUYdHTnY5x2Of4eAS6/1OhYwbm8y7LuR1KsYLcZ5kxQYnihMZvBCNDDz5n1/BRKE3q5uri0g9p33BVVXrTuq0qs+ZMVyk5PLGMcjo3hzTtCkYZ2zNuNh4hRiAS03BsRxC3lBSNSYXrHujdqY4tdzabFR8dc9os8B3juKXFbEd+oeig6JRexkkDiFaW6TWTkcusd+abklzi5xJJ4naUh7ZD7x+xJurmDusJ89i2k6k/c2/yDeeR1uCZVNVqBZGdnE80jLUSS942HIbkmtoU8bswcPF9q4Sy5LAVOmddpOuwt6SoXCeFw18ia7YOK9DAF0hsNW12FxSdC3Tw+W/gdU1VoAZIezwPJPQbi42hRCUinki7p2cjuUE6ed0ciSrXFrtTSWkcQbFL/AKwrdOn2yoty6x35qMZXNPfYR5bUp7ZD7x+xaxdSG0W0ZTa4HDnOe7U5xc7mTcrxNnVsQ3aj6JGSte7YwBg57yteiUnuYHU07YW7druAUa97pHlzjcleEkm5NyUKeMFECKyzWCvyvh1QJXTOdA1r3uvcvA0uvfaTqB2qVWb9F2PftsEnk5zU+o/1NFz/ADAAe8VpCZ6lbO2uZ03xnK/DJKseibQIQhLyMEIQgAQhCABCEIAEIQgAQhCABCEIAEIQgAUVmasFBlfEagyuhc2BzWPbe4eRpba20HURtUqs36Uce/Y4JBJymqNJ/pabH+Ygj3SmGm2zubmFNcZy/wAIkpR65pGdRyPhlZLE90cjCHNc02LSNxB4FbXlLNtPmWj0u0w18Q+VhB2H6TebfhuPAnEl1HI+GVksT3RyMIc1zTYtI3EHgV3+pabC/gk3iS4Yyq0lUR9GoWb4D0o9yDG4OQ9phHkLub9pJHo1XOjzNgle2I0+KUrnSnSxjpAx5N7W0mxvfwXAXOm3Ns8VIPHlboWypThyiVQhCXkYIQhAAhCEACEIQAIQhAAhCEACFFVmZsEoGymoxSla6I6XsbIHvBva2kXN7+CpmPdKPfgwSDmPaZh5i7W/YQT6tTC2025uXinB48vZEkaU58Is2bc20+WqPS3TNXyj5KEnYPpO5N+O4cSMUkkfNK+WV7pJHkuc5xuXE7yTxKJJHzSvlle6SR5LnOcblxO8k8SuV3+m6bCwg0nmT5YypUlTR//Z'],
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
    // event_key：EVM 为日志索引（logIndex）；/pay 提交时未知先为空，核验后回填。
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
  } },
  { version: 10, name: '第九轮：X Layer 合约占位符替换为核实的 USDT0 合约（仅精确占位符）', up: async function (env) {
    // 种子/旧配置里的 X Layer 合约占位符 0xYOUR_XLAYER_USDT_CONTRACT 会覆盖代码默认值且格式非法，
    // 导致 X Layer 核验 fail-closed（永远不认账）。仅替换精确占位符为核实的 USDT0 合约；
    // 管理员已显式配置的任何其他合约一律不动（保留显式配置能力）。
    await env.DB.prepare("UPDATE settings SET value = REPLACE(value, '\"X Layer\":\"0xYOUR_XLAYER_USDT_CONTRACT\"', '\"X Layer\":\"0x779Ded0c9e1022225f8E0630b35a9b54bE713736\"') WHERE key = 'usdt_contracts' AND value LIKE '%0xYOUR_XLAYER_USDT_CONTRACT%'").run();
  } },
  { version: 11, name: '第十轮：App 图标库（明/暗两版）+ 商品 app_icon_key + 标题自动匹配', up: async function (env) {
    // App 图标库：每 App 两行（light/dark），前端随主题切换；图标为官方 iOS 图标/品牌 Logo 处理后的 160x160 JPEG。
    await createTableIfMissing(env, "CREATE TABLE IF NOT EXISTS app_icons (app_key TEXT NOT NULL, theme TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', image_data TEXT NOT NULL DEFAULT '', PRIMARY KEY (app_key, theme))");
    await addColumnIfMissing(env, 'products', "app_icon_key TEXT NOT NULL DEFAULT ''");
    // 种子图标（生成脚本产出，勿手改）：[app_key, theme, name, image_data]
    for (var s = 0; s < APP_ICON_SEED.length; s++) {
      await env.DB.prepare('INSERT OR IGNORE INTO app_icons (app_key, theme, name, image_data) VALUES (?, ?, ?, ?)').bind(APP_ICON_SEED[s][0], APP_ICON_SEED[s][1], APP_ICON_SEED[s][2], APP_ICON_SEED[s][3]).run();
    }
    // 现有商品按标题自动匹配 App 图标（仅当 app_icon_key 为空时；幂等）。
    var prods = await env.DB.prepare('SELECT id, title, app_icon_key FROM products').all();
    var rows = (prods.results || []);
    for (var p = 0; p < rows.length; p++) {
      if (rows[p].app_icon_key) continue;
      var k = matchAppIconKey(String(rows[p].title || ''));
      if (k) await env.DB.prepare('UPDATE products SET app_icon_key = ? WHERE id = ?').bind(k, rows[p].id).run();
    }
  } },
  { version: 12, name: '第十轮补丁：刷新 App 图标暗版（黑底白 Logo / 彩色 Logo 深底）', up: async function (env) {
    // v11 种子用 INSERT OR IGNORE，已有库的暗版图标不会被新版覆盖；v12 用 UPDATE 把暗版刷为最新种子值。
    // 仅更新 image_data（图标库无后台改名/改图入口，name 恒为种子值）。
    for (var s = 0; s < APP_ICON_SEED.length; s++) {
      if (APP_ICON_SEED[s][1] !== 'dark') continue;
      await env.DB.prepare('UPDATE app_icons SET image_data = ? WHERE app_key = ? AND theme = ?').bind(APP_ICON_SEED[s][3], APP_ICON_SEED[s][0], 'dark').run();
    }
  } },
  { version: 13, name: '第十轮补丁2：刷新 App 图标暗版（Telegram 泛洪填充去白底）', up: async function (env) {
    // 种子暗版再次变更（Telegram）时，v12 已标记已应用不会重跑；v13 重新执行同一 UPDATE，把全部暗版刷为当前种子值。
    // 以后每次种子暗版变更，都须追加新迁移版本重刷（已应用的迁移不重跑）。
    for (var s = 0; s < APP_ICON_SEED.length; s++) {
      if (APP_ICON_SEED[s][1] !== 'dark') continue;
      await env.DB.prepare('UPDATE app_icons SET image_data = ? WHERE app_key = ? AND theme = ?').bind(APP_ICON_SEED[s][3], APP_ICON_SEED[s][0], 'dark').run();
    }
  } },
  { version: 14, name: '查单改 aisou.pro 方向：买家自设查询密码（只存哈希）+ 按单密码取卡密', up: async function (env) {
    // query_password_hash：买家下单时自设的查询密码的 SHA-256 哈希（绝不存明文）。空 = 未设密码，查卡密无需密码。
    // 旧订单兼容：query_password（旧明文密码）与 query_token_hash（旧系统凭证）保留，老路径继续可用。
    await addColumnIfMissing(env, 'orders', "query_password_hash TEXT NOT NULL DEFAULT ''");
    // secret_attempts：按单密码取卡密的尝试记录（order_no + ip + 时间），防针对单订单的密码爆破。
    await createTableIfMissing(env, 'CREATE TABLE IF NOT EXISTS secret_attempts (order_no TEXT NOT NULL, ip TEXT NOT NULL, created_at TEXT NOT NULL)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_secret_attempts_order ON secret_attempts(order_no, created_at)');
  } },
  { version: 15, name: 'P0：查询密码必填 + 随机salt PBKDF2 + 移除邮箱查询', up: async function (env) {
    // query_password_salt：每订单随机 16 字节 salt（base64），与 hashPassword（PBKDF2 10万次）配对。
    // salt 为空 + hash 非空 = v14 遗留无 salt 哈希（仅 staging 测试订单），按 legacy 处理（仅管理员流程，不走 /secret）。
    await addColumnIfMissing(env, 'orders', "query_password_salt TEXT NOT NULL DEFAULT ''");
  } },
  { version: 16, name: 'P2-4：补 6 个查询索引（旧库缺失，新库 schema.sql 已有）', up: async function (env) {
    // 核对结论（2026-10-18）：schema.sql 已有这 6 个索引；MIGRATIONS v1–v15 均未建它们，
    // 故经迁移升级的旧库缺失这 6 个索引，新库（schema.sql 建库）不缺。v16 只补真缺失的 6 个。
    // 调用点：orders 按 order_no 查单、按 status 扫待付款、按 created_at 倒序查单；cards 按 product_id/is_used
    // 统计与分配；sessions 按 expires_at 清理过期会话。均为非唯一普通索引，CREATE INDEX IF NOT EXISTS 幂等，
    // 已有索引的库（新库）执行为 no-op；不删历史订单/账本/卡密，不加 claim_token 列（认领仍用 created + claimed_at 持有者戳）。
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_cards_product ON cards(product_id)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_cards_used ON cards(product_id, is_used, is_disabled)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_orders_no ON orders(order_no)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at)');
    await createIndexIfMissing(env, 'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)');
  } },
  { version: 17, name: 'P1-1/P1-2：txid_claims 加 claim_token + source + order_lease_token（TXID 认领令牌化 + 人工/链上共享全局认领）', up: async function (env) {
    // claim_token：每次新认领的密码学安全随机令牌（randomHex(32)），是认领行的唯一持有凭证。
    //   回滚删除必须同时匹配 (tx_hash, order_id, claim_token) + 当前订单租约仍属本请求（EXISTS orders.claim_token=本请求租约），
    //   租约被接管后旧请求的回滚条件不再满足，删不掉新请求在用的认领。claim_token 为空 = v17 前遗留认领行，
    //   永远不被令牌回滚删除（宁可保留，不冒险释放他人依赖的认领）。
    // source：认领来源，'chain_verified'（链上验证通过后认领）或 'manual_confirmed'（管理员系统外核对后人工确认认领）。
    //   人工确认与链上确认共享同一 txid_claims 全局原子认领（tx_hash 主键），不再另建防重表、不再靠先 SELECT 后 INSERT。
    //   manual_confirmed 仅表示人工确认，不构成链上证据，不伪造回执/区块高度/确认数；链上验证仍须验网络/合约/地址/金额/回执/确认数。
    // order_lease_token：认领时持有者的订单租约令牌（orders.claim_token）。同订单租约接管时新持有者收养认领行
    //   （UPDATE order_lease_token=新租约），旧持有者回滚因租约已变而失败。现有数据兼容：旧行三列均为默认值，
    //   不清空/重建/丢失现有 txid_claims 记录；旧行 source 默认 'chain_verified'（v17 前只有链上路径写 txid_claims，
    //   人工路径只写 payments manual_confirmed 行，见 claimTxid 的遗留 manual 行兼容检查）。
    await addColumnIfMissing(env, 'txid_claims', "claim_token TEXT NOT NULL DEFAULT ''");
    await addColumnIfMissing(env, 'txid_claims', "source TEXT NOT NULL DEFAULT 'chain_verified'");
    await addColumnIfMissing(env, 'txid_claims', "order_lease_token TEXT NOT NULL DEFAULT ''");
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
  // P2-1/P3-3：账本状态转换表。posted / reconciled / manual_confirmed 为终态，任何路径不得降级
  // （扫描回填、普通对账均不得把 posted 改回 discovered/verified/confirmed）。
  // 非法转换直接拒绝，不写库；调用方需按终态处理（posted 行只补元数据，不改状态）。
  var PAYMENT_TRANSITIONS = {
    submitted: ['discovered', 'verified', 'confirmed', 'posted', 'mismatch', 'unmatched', 'duplicate', 'manual_confirmed'],
    discovered: ['verified', 'confirmed', 'posted', 'mismatch', 'unmatched', 'duplicate', 'manual_confirmed'],
    verified: ['confirmed', 'posted', 'mismatch', 'duplicate', 'manual_confirmed'],
    confirmed: ['posted', 'mismatch', 'duplicate', 'manual_confirmed'],
    posted: [],
    mismatch: ['reconciled'],
    unmatched: ['reconciled'],
    duplicate: ['reconciled'],
    reconciled: [],
    manual_confirmed: []
  };
  if (fields.status !== undefined) {
    var curRow = await env.DB.prepare('SELECT status FROM payments WHERE id = ?').bind(Number(paymentId)).first().catch(function () { return null; });
    if (!curRow) return { ok: false, reason: '付款记录不存在' };
    var fromSt = String(curRow.status || '');
    var toSt = String(fields.status);
    if (toSt !== fromSt && (!PAYMENT_TRANSITIONS[fromSt] || PAYMENT_TRANSITIONS[fromSt].indexOf(toSt) === -1)) {
      return { ok: false, reason: 'illegal_payment_transition', from: fromSt, to: toSt };
    }
  }
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
async function getRequiredConfirmations(env, chain, orderAmount) {
  // P3-15：大额订单分级确认数（仅 X Layer）。订单金额 >= large_order_usdt（默认 100）时用
  // large_order_confirmations（默认 12）；BEP20 始终走原有口径（默认 15），不分级。
  // settings 覆盖：chain_confirmations 显式值仍优先于默认值，但大额分级优先于 chain_confirmations（大额安全优先）。
  try {
    var settings = await getAllSettings(env);
    if (chain === 'X Layer' && orderAmount != null && isFinite(Number(orderAmount))) {
      var threshold = Number(settings.large_order_usdt);
      if (!isFinite(threshold) || threshold <= 0) threshold = 100;
      var largeConf = Number(settings.large_order_confirmations);
      if (!isFinite(largeConf) || largeConf < 1) largeConf = 12;
      if (Number(orderAmount) >= threshold) return Math.floor(largeConf);
    }
    var map = parseJsonSafe(settings.chain_confirmations, {});
    var v = Number(map[chain]);
    if (isFinite(v) && v >= 1) return Math.floor(v);
  } catch (e) {}
  var d = Number(DEFAULT_CHAIN_CONFIRMATIONS[chain]);
  return (isFinite(d) && d >= 1) ? Math.floor(d) : 1;
}
// ---- 第四轮：链上扫描游标 ----
// 游标 key：第九轮起为“链|地址”（如 'BEP20|0xabc...'），按地址独立存储，地址变更/多地址时互不跳过。
// 旧按链游标行（如 key='X Layer'）保留在库不再使用。游标只在整页扫描成功后推进；RPC 失败不推进，重启可恢复。
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
    // P3-5：原子记数（INSERT…SELECT…WHERE count < N，同 /secret 模式），消除先查后插的 TOCTOU 超限窗口。
    // 先记订单维：超限则拒绝，不再记 IP 维；再记 IP 维：超限则拒绝（订单维已记一条，偏保守）。
    var oi = await env.DB.prepare('INSERT INTO pay_rate (key, created_at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM pay_rate WHERE key = ?) < ?').bind('order:' + orderNo, nowISO(), 'order:' + orderNo, PAY_RATE_PER_ORDER).run().catch(function () { return null; });
    if (!oi || !oi.meta || oi.meta.changes !== 1) return '该订单提交 TXID 过于频繁，请稍后再试（后台轮询仍会继续核验）';
    var ii = await env.DB.prepare('INSERT INTO pay_rate (key, created_at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM pay_rate WHERE key = ?) < ?').bind('ip:' + ip, nowISO(), 'ip:' + ip, PAY_RATE_PER_IP).run().catch(function () { return null; });
    if (!ii || !ii.meta || ii.meta.changes !== 1) return '提交过于频繁，请稍后再试';
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
      // P2-7：锁定触发时失败计数清零，锁满即解锁，不延长（窗口计数不跨锁延续，避免锁定被反复延长至 ~15 分钟）。
      await setAdminMeta(env, 'login_global_fail_count', '0');
      await setAdminMeta(env, 'login_global_fail_window', String(Date.now()));
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
    products: ['id', 'slug', 'title', 'category', 'price_usdt', 'source', 'prodseller_id', 'cost_price', 'sell_price', 'requires_email_activation', 'delivery_method', 'stock_type', 'description', 'notice', 'form_fields', 'image_emoji', 'image_data', 'app_icon_key', 'sort', 'is_active', 'in_stock', 'created_at'],
    cards: ['id', 'product_id', 'code', 'is_used', 'is_disabled', 'order_id', 'reserved_order_id', 'reserved_at', 'created_at'],
    orders: ['id', 'order_no', 'query_password', 'query_token_hash', 'query_password_hash', 'query_password_salt', 'claim_token', 'claimed_at', 'exception_reason', 'refund_status', 'refund_ref', 'upstream_lock', 'upstream_lock_expires_at', 'product_id', 'product_snapshot', 'quantity', 'price_usdt', 'total_usdt', 'actual_amount', 'pay_address', 'expires_at', 'last_checked_at', 'tx_hash', 'customer_fields', 'contact', 'pay_method', 'pay_chain', 'wallet_address', 'txid', 'status', 'delivery_content', 'admin_note', 'data_expired', 'created_at', 'paid_at', 'fulfilled_at'],
    settings: ['key', 'value'],
    admin_meta: ['key', 'value'],
    upstream_orders: ['id', 'order_id', 'prodseller_order_id', 'status', 'amount', 'delivered_keys', 'created_at'],
    upstream_cache: ['key', 'payload', 'fetched_at'],
    sessions: ['token', 'created_at', 'expires_at'],
    captcha_codes: ['id', 'code_hash', 'expires_at', 'attempts'],
    order_rate: ['ip', 'created_at'],
    admin_audit: ['id', 'order_id', 'action', 'before_status', 'after_status', 'note', 'created_at'],
    login_attempts: ['ip', 'attempts', 'blocked_until', 'updated_at'],
    txid_claims: ['tx_hash', 'order_id', 'claimed_at', 'claim_token', 'source', 'order_lease_token'],
    lookup_rate: ['ip', 'created_at'],
    schema_migrations: ['version', 'applied_at'],
    payments: ['id', 'order_id', 'chain', 'asset', 'pay_address', 'tx_hash', 'event_key', 'amount', 'amount_unit', 'block_number', 'confirmations', 'first_seen_at', 'status', 'reconcile_status', 'reconcile_note', 'created_at', 'updated_at'],
    scan_cursors: ['chain', 'last_block', 'updated_at'],
    pay_rate: ['key', 'created_at'],
    app_icons: ['app_key', 'theme', 'name', 'image_data'],
    secret_attempts: ['order_no', 'ip', 'created_at']
  };
  var expectedIndexes = [
    { name: 'idx_upstream_orders_order_unique', unique: 1 },
    { name: 'idx_payments_event_unique', unique: 1 },
    { name: 'idx_orders_amount_claim', unique: 1 },
    { name: 'idx_orders_contact_pending', unique: 1 },
    // P2-4（v16，集成补全）：6 个非唯一查询索引（unique: 0，仅校验存在）。
    { name: 'idx_cards_product', unique: 0 },
    { name: 'idx_cards_used', unique: 0 },
    { name: 'idx_orders_no', unique: 0 },
    { name: 'idx_orders_status', unique: 0 },
    { name: 'idx_orders_created', unique: 0 },
    { name: 'idx_sessions_expires', unique: 0 }
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
      if (!idxMap[ei.name]) { issues.push('缺' + (ei.unique ? '唯一' : '') + '索引：' + ei.name); checks.indexes.push({ index: ei.name, ok: false, missing: 'index' }); return; }
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
  // P1-1：门禁单点。所有调用方（fulfillAfterPayment、pollUpstreamActivations、管理员重试）都经此入口，
  // 门禁关闭时一律不发起真实采购；调用方按 403/pending_upstream 处理，不重复下单。
  if (String((settings && settings.prodseller_enabled) || '0') !== '1') return { status: 403, ok: false, data: null, text: '', error: '上游门禁关闭（prodseller_enabled != 1），未发起真实采购' };
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
// P1-4：上游终态失败枚举（ProdSeller 连接器文档仅明确 paid → delivered；终态失败按审查报告口径
// 取 cancelled/failed/expired/refunded，另含 canceled 美式拼写）。命中即停止轮询、转异常，不再重试。
var UPSTREAM_TERMINAL_FAILURES = ['cancelled', 'canceled', 'failed', 'expired', 'refunded'];
function isUpstreamTerminalFailure(st) { return UPSTREAM_TERMINAL_FAILURES.indexOf(String(st || '').toLowerCase()) !== -1; }
// P1-10：delivered keys 行数（按换行拆分、去空行），完成前必须 >= 订单 quantity。
function countDeliveredKeys(keys) {
  if (!keys) return 0;
  return String(keys).split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; }).length;
}
// P2-3：上游已 delivered 但 keys 不足时的统一文案：缺失数 + 建议，不标完成。
function upstreamDeliveredShortfallNote(keys, qty) {
  var n = countDeliveredKeys(keys);
  var q = Number(qty) || 0;
  return '上游已 delivered 但 keys 不足（' + n + ' < ' + q + '），缺 ' + Math.max(0, q - n) + ' 个，未完成，等补发/人工处理；建议：联系上游补发缺失 keys，或人工在上游后台核对上游订单后处理';
}
// P3-6：有效过期时间（毫秒时间戳）。
// expires_at 有效时用它；缺失/空串/无效时间时按历史回退：created_at + 20 分钟付款窗口；
// created_at 也无效时返回 null（永不自动取消，安全处理）。
function effectiveExpiryMs(o) {
  var t = Date.parse(String((o && o.expires_at) || '').replace(' ', 'T') + 'Z');
  if (isFinite(t)) return t;
  var c = Date.parse(String((o && o.created_at) || '').replace(' ', 'T') + 'Z');
  if (!isFinite(c)) return null;
  return c + POLL_LOCK_MINUTES * 60000;
}
function isLegacyExpiryFallback(o) {
  return !isFinite(Date.parse(String((o && o.expires_at) || '').replace(' ', 'T') + 'Z'));
}
// claimTxid 冲突“已用于其他订单”、订单已终态“订单已被处理”/“当前状态不可发货”。
function isTerminalFulfillRejection(reason) {
  var r = String(reason || '');
  return r.indexOf('已用于其他订单') !== -1 || r.indexOf('订单已被处理') !== -1 || r.indexOf('当前状态不可发货') !== -1;
}
// P1-4：上游终态失败统一处理：转 refund_pending（停止轮询）+ exception_reason/admin_note 记录
// 上游单号与状态 + 审计。调用方传入租约守卫（poll 用 upstream_lock，fulfill 用 claim_token）。
async function applyUpstreamTerminalFailure(env, orderId, psId, st, whereSql, whereBinds) {
  var msg = '上游订单终态失败（状态 ' + st + '，上游单号 ' + (psId || '无') + '），已停止轮询，转异常待退款处理';
  var beforeRow = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first().catch(function () { return null; });
  var binds = [msg, msg, orderId].concat(whereBinds || []);
  var stmt = env.DB.prepare("UPDATE orders SET status='refund_pending', refund_status='pending', exception_reason=?, admin_note=? WHERE id=? AND " + whereSql);
  var upd2 = await stmt.bind.apply(stmt, binds).run();
  if (upd2.meta && upd2.meta.changes === 1) {
    await logAudit(env, orderId, 'upstream_terminal_failure', (beforeRow && beforeRow.status) || '', 'refund_pending', msg);
    return { ok: true };
  }
  return { ok: false, reason: '订单已被其他操作处理' };
}
async function getLatestUpstream(env, orderId) {
  try { return await env.DB.prepare('SELECT * FROM upstream_orders WHERE order_id = ? ORDER BY id DESC LIMIT 1').bind(orderId).first(); } catch (e) { return null; }
}
// P2-10/P2-15/P3-25：上游轮询失败状态（存 upstream_cache，key='upstream_fail:<orderId>'，不新增表/列）。
// payload: {count, nextRetryAt(ms), lastError}。退避：2/4/8/16/30/30…分钟；成功后清零。
async function getUpstreamFailState(env, orderId) {
  try {
    var row = await env.DB.prepare('SELECT payload FROM upstream_cache WHERE key = ?').bind('upstream_fail:' + orderId).first();
    if (!row) return { count: 0, nextRetryAt: 0, lastError: '' };
    var p = parseJsonSafe(row.payload || '{}', {});
    return { count: Number(p.count) || 0, nextRetryAt: Number(p.nextRetryAt) || 0, lastError: String(p.lastError || '') };
  } catch (e) { return { count: 0, nextRetryAt: 0, lastError: '' }; }
}
async function recordUpstreamFail(env, orderId, errorText) {
  var st = await getUpstreamFailState(env, orderId);
  var count = st.count + 1;
  var delayMin = Math.min(Math.pow(2, count), 30);
  var nextRetryAt = Date.now() + delayMin * 60000;
  try {
    await env.DB.prepare('INSERT INTO upstream_cache (key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at').bind('upstream_fail:' + orderId, JSON.stringify({ count: count, nextRetryAt: nextRetryAt, lastError: String(errorText || '').slice(0, 200) }), nowISO()).run();
  } catch (e) {}
  return { count: count, nextRetryAt: nextRetryAt, delayMin: delayMin };
}
async function clearUpstreamFail(env, orderId) {
  try { await env.DB.prepare('DELETE FROM upstream_cache WHERE key = ?').bind('upstream_fail:' + orderId).run(); } catch (e) {}
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
async function upsertUpstreamOrder(env, orderId, psId, status, amount, keys, opts) {
  // SQLite UPSERT（ON CONFLICT）：单条语句原子写入，并发下不会产生重复行。
  // 依赖迁移 v7 的唯一索引 idx_upstream_orders_order_unique（upstream_orders.order_id 唯一）。
  // 空值保护（第四轮 P0）：已有非空上游订单号 / 已交付 keys 时，空字符串不得覆盖。
  // 原因：占位行（insufficient_balance / upstream_error 等）传入空 psId；若无条件覆盖，会把已成功的上游单号抹掉，
  // 导致后续轮询误判为“无上游单号”而重复创建采购。状态与金额仍可更新（状态流转是正常业务）。
  // P2-13：租约条件写入。opts.claimToken（fulfillAfterPayment 的订单认领）或 opts.upstreamLock
  // （pollUpstreamActivations 的上游轮询租约）任一传入时，先校验订单行仍持有该租约；租约已失
  // （被接管/已完成）则放弃写入，避免过期处理者覆盖新处理者的上游单号/状态/keys。
  opts = opts || {};
  if (opts.claimToken || opts.upstreamLock) {
    var leaseRow = await env.DB.prepare('SELECT claim_token, upstream_lock FROM orders WHERE id = ?').bind(orderId).first().catch(function () { return null; });
    if (!leaseRow) return { ok: false, reason: 'lease_check_failed' };
    if (opts.claimToken && String(leaseRow.claim_token || '') !== String(opts.claimToken)) return { ok: false, reason: 'lease_lost' };
    if (opts.upstreamLock && String(leaseRow.upstream_lock || '') !== String(opts.upstreamLock)) return { ok: false, reason: 'lease_lost' };
  }
  await env.DB.prepare('INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount, delivered_keys) VALUES (?, ?, ?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET prodseller_order_id=CASE WHEN excluded.prodseller_order_id = \'\' THEN upstream_orders.prodseller_order_id ELSE excluded.prodseller_order_id END, status=excluded.status, amount=excluded.amount, delivered_keys=CASE WHEN excluded.delivered_keys = \'\' THEN upstream_orders.delivered_keys ELSE excluded.delivered_keys END').bind(orderId, psId || '', status || '', Number(amount) || 0, keys || '').run();
  return { ok: true };
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
// P2-15：超期升级（告警，不改状态、不自动退款）：pending_activation 超 2 小时未 delivered、
// pending_upstream 失败重试超 10 次时，写 exception_reason + admin_note + 审计告警，轮询继续。
// 仅升级一次（admin_note 已含升级标记时跳过）；持有有效上游租约的订单跳过，避免与处理者竞态。
async function escalateStaleUpstreamOrders(env) {
  try {
    var stale = await env.DB.prepare("SELECT * FROM orders WHERE status = 'pending_activation' AND COALESCE(paid_at, created_at) < datetime('now', '-2 hours') AND (upstream_lock IS NULL OR upstream_lock = '' OR upstream_lock_expires_at IS NULL OR upstream_lock_expires_at < datetime('now'))").all();
    for (var i = 0; i < ((stale.results || []).length); i++) {
      var o = stale.results[i];
      if (String(o.admin_note || '').indexOf('已升级告警') !== -1) continue;
      var msg = '上游激活超时（pending_activation 超过 2 小时未 delivered），已升级告警，请人工核查上游订单';
      // P3-2：UPDATE 带租约守卫（未持有或已过期才可写），过期处理者不覆盖新处理者的 admin_note。
      await env.DB.prepare("UPDATE orders SET exception_reason=?, admin_note=? WHERE id=? AND status='pending_activation' AND (upstream_lock IS NULL OR upstream_lock = '' OR upstream_lock_expires_at IS NULL OR upstream_lock_expires_at < datetime('now'))").bind(msg, (o.admin_note ? o.admin_note + '；' : '') + msg + '（已升级告警）', o.id).run();
      await logAudit(env, o.id, 'upstream_escalation', 'pending_activation', 'pending_activation', msg);
    }
    var stuck = await env.DB.prepare("SELECT * FROM orders WHERE status = 'pending_upstream' AND (upstream_lock IS NULL OR upstream_lock = '' OR upstream_lock_expires_at IS NULL OR upstream_lock_expires_at < datetime('now'))").all();
    for (var j = 0; j < ((stuck.results || []).length); j++) {
      var o2 = stuck.results[j];
      if (String(o2.admin_note || '').indexOf('已升级告警') !== -1) continue;
      var fs = await getUpstreamFailState(env, o2.id);
      if (fs.count < 10) continue;
      var msg2 = '上游创建/轮询失败已达 ' + fs.count + ' 次（pending_upstream），已升级告警，请人工核查上游订单';
      // P3-2：UPDATE 带租约守卫，过期处理者不覆盖新处理者。
      await env.DB.prepare("UPDATE orders SET exception_reason=?, admin_note=? WHERE id=? AND status='pending_upstream' AND (upstream_lock IS NULL OR upstream_lock = '' OR upstream_lock_expires_at IS NULL OR upstream_lock_expires_at < datetime('now'))").bind(msg2, (o2.admin_note ? o2.admin_note + '；' : '') + msg2 + '（已升级告警）', o2.id).run();
      await logAudit(env, o2.id, 'upstream_escalation', 'pending_upstream', 'pending_upstream', msg2);
    }
  } catch (e) {}
}
async function pollUpstreamActivations(env, ctx, opts) {
  // opts.orderId：管理员重试单笔订单时只处理该订单（避免误处理其他订单）；Cron 不传，处理全部待处理订单。
  var onlyOrderId = opts && opts.orderId ? Number(opts.orderId) : 0;
  var settings = await getAllSettings(env);
  var out = { checked: 0, delivered: 0, retried: 0, still_pending: 0 };
  // P2-15：每轮先做超期升级（告警），再处理队列。
  await escalateStaleUpstreamOrders(env);
  var rows;
  if (onlyOrderId) {
    rows = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND status IN ('pending_activation','pending_upstream') ORDER BY id ASC LIMIT 1").bind(onlyOrderId).all();
  } else {
    // P2-10：退避中的订单（失败计数 + nextRetryAt 未到）不占轮询名额；显式单笔重试（onlyOrderId）绕过退避。
    // json_extract 失败时（如旧 SQLite）回退到无过滤查询，轮询不因此中断。
    try {
      rows = await env.DB.prepare("SELECT * FROM orders WHERE status IN ('pending_activation','pending_upstream') AND NOT EXISTS (SELECT 1 FROM upstream_cache WHERE key = 'upstream_fail:' || orders.id AND CAST(json_extract(payload, '$.nextRetryAt') AS INTEGER) > ?) ORDER BY id ASC LIMIT 100").bind(Date.now()).all();
    } catch (e) {
      rows = await env.DB.prepare("SELECT * FROM orders WHERE status IN ('pending_activation','pending_upstream') ORDER BY id ASC LIMIT 100").all();
    }
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
      // P1-11：已标记 no_psid_awaiting_manual 的订单（创建成功但响应无单号）绝不再次创建，等人工处理。
      if (!psId && up && up.status === 'no_psid_awaiting_manual') { out.still_pending++; continue; }
      // pending_upstream 且尚无上游单号（402/429/500 后）：重试下单（Idempotency-Key=order_no 防重复扣费）
      if (!psId) {
        var cf0 = {}; try { cf0 = JSON.parse(o.customer_fields || '{}'); } catch (e) { cf0 = {}; }
        var cr = await prodsellerCreateOrder(env, settings, o, prod, cf0);
        // P1-1：门禁关闭（403）不重试、不记失败，仅更新备注等人工开闸。
        if (cr.status === 403) { await env.DB.prepare('UPDATE orders SET admin_note=? WHERE id=? AND upstream_lock=?').bind('上游门禁关闭（prodseller_enabled != 1），未发起真实采购，等待人工处理', o.id, lockToken).run(); out.still_pending++; continue; }
        if (cr.status === 402) { var f402 = await recordUpstreamFail(env, o.id, '上游余额不足 402'); await env.DB.prepare('UPDATE orders SET admin_note=? WHERE id=? AND upstream_lock=?').bind('上游余额不足（402），待充值后重试，不发货（轮询失败 ' + f402.count + ' 次，下次重试约 ' + f402.delayMin + ' 分钟后）', o.id, lockToken).run(); out.still_pending++; continue; }
        if (cr.status === 409) { var f409 = await recordUpstreamFail(env, o.id, '上游缺货 409'); await env.DB.prepare('UPDATE orders SET admin_note=? WHERE id=? AND upstream_lock=?').bind('上游缺货（409），已转人工（轮询失败 ' + f409.count + ' 次）', o.id, lockToken).run(); out.still_pending++; continue; }
        if (cr.status === 429 || cr.status >= 500 || !cr.ok) { var fErr = await recordUpstreamFail(env, o.id, '上游重试失败 HTTP ' + cr.status); await env.DB.prepare('UPDATE orders SET admin_note=? WHERE id=? AND upstream_lock=?').bind('上游重试失败 HTTP ' + cr.status + '，下次轮询继续重试（轮询失败 ' + fErr.count + ' 次，下次重试约 ' + fErr.delayMin + ' 分钟后）', o.id, lockToken).run(); out.still_pending++; continue; }
        var st0 = upstreamStatusOf(cr.data);
        var psId0 = (cr.data && (cr.data.id || cr.data.orderId || cr.data.order_id)) || '';
        var keys0 = upstreamKeysOf(cr.data);
        await upsertUpstreamOrder(env, o.id, String(psId0 || ''), st0, upstreamAmountOf(cr.data), keys0, { upstreamLock: lockToken });
        // P1-11：创建成功但响应无单号 → 置 pending_upstream + 人工标记，不盲目重建（连接器无按 order_no 查询接口）。
        if (!psId0) {
          await upsertUpstreamOrder(env, o.id, '', 'no_psid_awaiting_manual', upstreamAmountOf(cr.data), keys0, { upstreamLock: lockToken });
          await env.DB.prepare('UPDATE orders SET admin_note=? WHERE id=? AND upstream_lock=?').bind('上游创建成功但响应无单号，已停止自动重试创建，需人工在上游后台按商城订单号核对上游订单后处理', o.id, lockToken).run();
          out.still_pending++; continue;
        }
        await clearUpstreamFail(env, o.id);
        // P1-4：上游终态失败 → 转异常 + 停止轮询。
        if (isUpstreamTerminalFailure(st0)) { await applyUpstreamTerminalFailure(env, o.id, String(psId0), st0, "status IN ('pending_activation','pending_upstream') AND upstream_lock=?", [lockToken]); out.still_pending++; continue; }
        // P2-3：上游已 delivered 时必须校验交付数与订单数一致：keys 为空/不足 → 明确 pending_activation
        // + admin_note 记缺失数与建议 + 审计，绝不标完成；足够 → 完成（P3-1：UPDATE 带 upstream_lock
        // 持有者令牌 + 状态检查，行数须为预期值 1，否则不发邮件、不称交付成功）。
        if (st0 === 'delivered') {
          if (countDeliveredKeys(keys0) < o.quantity) {
            await env.DB.prepare("UPDATE orders SET status='pending_activation', admin_note=? WHERE id=? AND upstream_lock=?").bind(upstreamDeliveredShortfallNote(keys0, o.quantity), o.id, lockToken).run();
            await logAudit(env, o.id, 'upstream_keys_insufficient', o.status, 'pending_activation', upstreamDeliveredShortfallNote(keys0, o.quantity));
            out.still_pending++; continue;
          }
          var done0 = await env.DB.prepare("UPDATE orders SET status='completed', delivery_content=?, fulfilled_at=?, claim_token='' WHERE id=? AND status IN ('pending_activation','pending_upstream') AND upstream_lock=?").bind(keys0, nowISO(), o.id, lockToken).run(); if (done0.meta && done0.meta.changes === 1) { out.delivered++; var fresh0 = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first(); await deliverWithCtx(ctx, sendOrderEmail(env, fresh0, prod, 'delivered', keys0)); } else { out.still_pending++; } continue; }
        if (st0 === 'paid') { await env.DB.prepare("UPDATE orders SET status='pending_activation' WHERE id=? AND upstream_lock=?").bind(o.id, lockToken).run(); out.still_pending++; continue; }
        out.still_pending++; continue;
      }
      // 已有上游单号：轮询 GET /v1/orders/:id 直到 delivered，deliveredKey 出现前不发
      var g = await prodsellerGetOrder(env, settings, psId);
      // P3-25：GET 失败时记录失败原因与次数到 admin_note，404（上游订单不存在）单独处理；同时记退避。
      if (!g.ok) {
        var gErr = (g.status === 404) ? ('上游订单不存在（404），上游单号 ' + psId + '，请人工在上游后台核查') : ('上游轮询 GET 失败 HTTP ' + g.status);
        var fGet = await recordUpstreamFail(env, o.id, gErr);
        await env.DB.prepare('UPDATE orders SET admin_note=? WHERE id=? AND upstream_lock=?').bind(gErr + '（轮询失败 ' + fGet.count + ' 次，下次重试约 ' + fGet.delayMin + ' 分钟后）', o.id, lockToken).run();
        out.still_pending++; continue;
      }
      await clearUpstreamFail(env, o.id);
      var st = upstreamStatusOf(g.data);
      var keys = upstreamKeysOf(g.data);
      await upsertUpstreamOrder(env, o.id, psId, st, upstreamAmountOf(g.data), keys, { upstreamLock: lockToken });
      // P1-4：上游终态失败 → 转异常 + 停止轮询。
      if (isUpstreamTerminalFailure(st)) { await applyUpstreamTerminalFailure(env, o.id, psId, st, "status IN ('pending_activation','pending_upstream') AND upstream_lock=?", [lockToken]); out.still_pending++; continue; }
      if (st === 'delivered') {
        // P2-3：keys 为空/不足 → 明确 pending_activation + 缺失数与建议 + 审计，绝不标完成。
        if (countDeliveredKeys(keys) < o.quantity) {
          await env.DB.prepare("UPDATE orders SET status='pending_activation', admin_note=? WHERE id=? AND upstream_lock=?").bind(upstreamDeliveredShortfallNote(keys, o.quantity), o.id, lockToken).run();
          await logAudit(env, o.id, 'upstream_keys_insufficient', o.status, 'pending_activation', upstreamDeliveredShortfallNote(keys, o.quantity));
          out.still_pending++; continue;
        }
        // P3-1：完成 UPDATE 带 upstream_lock 持有者令牌 + 状态检查，行数须为 1，否则不发邮件、不称交付成功。
        var done = await env.DB.prepare("UPDATE orders SET status='completed', delivery_content=?, fulfilled_at=?, claim_token='' WHERE id=? AND status IN ('pending_activation','pending_upstream') AND upstream_lock=?").bind(keys, nowISO(), o.id, lockToken).run();
        if (done.meta && done.meta.changes === 1) { out.delivered++; var fresh = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first(); await deliverWithCtx(ctx, sendOrderEmail(env, fresh, prod, 'delivered', keys)); }
        else { out.still_pending++; }
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
// ---- 第九轮：代币精度（按合约实际 decimals，不得硬编码）----
// USDT 在不同链精度不同：X Layer USDT0 = 6，BEP20 Binance-Peg USDT = 18。
// 核验时必须用合约实际 decimals() 换算金额，否则会漏认真实到账（BEP20 按 6 位算永远对不上），
// 或误认粉尘转账为全额付款（BEP20 按 6 位算，5005700 个最小单位 = 5.0057e-12 USDT 也会被当成 5.0057 USDT）。
// decimals 通过 eth_call decimals() 读取并缓存（同一 Worker 隔离期内复用）；读取失败时 fail-closed（该 RPC 不认账）。
var TOKEN_DECIMALS_CACHE = {};
async function getTokenDecimals(fetchFn, rpcUrl, contract) {
  var key = String(rpcUrl) + '|' + String(contract).toLowerCase();
  if (TOKEN_DECIMALS_CACHE[key] !== undefined) return TOKEN_DECIMALS_CACHE[key];
  try {
    var res = await rpcCall(fetchFn, rpcUrl, 'eth_call', [{ to: contract, data: '0x313ce567' }, 'latest']);
    var dec = parseInt(String(res), 16);
    if (isFinite(dec) && dec >= 0 && dec <= 36) { TOKEN_DECIMALS_CACHE[key] = dec; return dec; }
  } catch (e) {}
  return null;
}
function isValidEvmAddress(s) { return /^0x[0-9a-fA-F]{40}$/.test(String(s || '')); }
// 金额（USDT 单位，如 5.0057）→ 原始最小单位（BigInt），按实际 decimals 精确换算，避免 float 精度丢失。
// 18 位精度时 float 无法精确表示 5.0057e18（超出 2^53），必须用字符串拆分做整数运算。
// 科学计数法（如 1e-7）先经 toFixed 展开为定点字符串再拆分。
function amountToRaw(amount, decimals) {
  var s = String(amount);
  var neg = false;
  if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
  if (/[eE]/.test(s)) {
    var n = Number(s);
    if (!isFinite(n)) return 0n;
    s = n.toFixed(Math.min(decimals, 20));
  }
  var parts = s.split('.');
  var intPart = ((parts[0] || '0').replace(/[^0-9]/g, '')) || '0';
  var fracPart = (parts[1] || '').replace(/[^0-9]/g, '');
  if (fracPart.length > decimals) fracPart = fracPart.slice(0, decimals);
  while (fracPart.length < decimals) fracPart += '0';
  var raw = BigInt(intPart) * (10n ** BigInt(decimals)) + BigInt(fracPart || '0');
  return neg ? -raw : raw;
}
// 原始最小单位（BigInt）→ 金额（USDT 单位，Number，仅用于账本展示与容差比较；匹配一律用 BigInt）。
function rawToAmount(raw, decimals) {
  return Number(raw) / Math.pow(10, decimals);
}
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
// EVM/X Layer：eth_getLogs 查 USDT Transfer，至少 requiredConfirmations 确认（各链策略，见 DEFAULT_CHAIN_CONFIRMATIONS）。
// opts: { requiredConfirmations, fromBlockOverride }。fromBlockOverride 用于游标扫描；未传时回溯 200 区块（兼容旧口径）。
async function checkEvmPayment(fetchFn, rpcUrls, contract, payAddress, actualAmount, opts) {
  // 第九轮：严格核验。合约地址格式非法 → 不认账；decimals 读取失败 → 该 RPC 不认账（fail-closed）；
  // 日志 address 必须与配置合约严格一致（不得只信 RPC 的 address 过滤）；金额按合约实际 decimals 精确 BigInt 比较。
  if (!isValidEvmAddress(contract) || !isValidEvmAddress(payAddress)) return null;
  opts = opts || {};
  var requiredConf = Number(opts.requiredConfirmations) || 1;
  var toTopic = padAddressTopic(payAddress);
  // P2-2：区分“RPC 失败”与“核验成功但未找到付款”。至少一个 RPC 成功完成核验（日志查询返回数组，
  // 或 RPC 正常但确认数未达而跳过搜索）才算核验成功；全部 RPC 失败时抛错，由调用方（runPolling）
  // 判定为 RPC 失败，不推进 last_checked_at，失败订单下轮仍排前面尽快重试。
  var anyRpcOk = false;
  for (var ri = 0; ri < rpcUrls.length; ri++) {
    try {
      var rpc = rpcUrls[ri];
      var decimals = await getTokenDecimals(fetchFn, rpc, contract);
      if (decimals === null) continue; // 合约精度读不到：该 RPC 不认账，换下一个 RPC
      var expected = amountToRaw(actualAmount, decimals);
      var latestHex = await rpcCall(fetchFn, rpc, 'eth_blockNumber', []);
      var latest = parseInt(latestHex, 16);
      if (!isFinite(latest) || latest <= 0) continue;
      var fromBlock = (opts.fromBlockOverride != null) ? Number(opts.fromBlockOverride) : Math.max(0, latest - 200);
      if (!isFinite(fromBlock) || fromBlock < 0) fromBlock = Math.max(0, latest - 200);
      if (fromBlock > latest) continue;
      var toBlock = latest - requiredConf;
      if (toBlock < fromBlock) { anyRpcOk = true; continue; } // RPC 正常，仅确认数未达而跳过搜索（不算 RPC 失败）
      var logs = await rpcCall(fetchFn, rpc, 'eth_getLogs', [{ address: contract, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), topics: [TRANSFER_TOPIC0, null, toTopic] }]);
      if (!Array.isArray(logs)) continue;
      anyRpcOk = true;
      for (var i = 0; i < logs.length; i++) {
        var lg = logs[i];
        // 严格匹配合约地址：RPC 可能忽略 address 过滤返回无关日志，不得仅凭 topics 认账。
        if (String(lg.address || '').toLowerCase() !== String(contract).toLowerCase()) continue;
        var topics = lg.topics || [];
        if (topics.length < 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC0) continue;
        if (String(topics[2]).toLowerCase() !== toTopic) continue;
        var blk = parseInt(lg.blockNumber, 16);
        if (!isFinite(blk)) continue;
        // 区块范围校验：不得只信 RPC 的 fromBlock/toBlock 过滤（RPC 可能返回范围外日志，如未达确认数的区块）。
        if (blk < fromBlock || blk > toBlock) continue;
        var val = 0n;
        try { val = BigInt(lg.data || '0x0'); } catch (e) { continue; }
        if (val !== expected) continue;
        if (lg.transactionHash) return { txHash: String(lg.transactionHash), amount: Number(actualAmount), blockNumber: blk, logIndex: lg.logIndex != null ? String(lg.logIndex) : '', confirmations: (latest - blk) };
      }
    } catch (e) { continue; }
  }
  // P2-2：全部 RPC 均未成功完成核验 → 抛错（非“未找到付款”），调用方按 RPC 失败处理。
  if (!anyRpcOk) throw new Error('all RPC failed (checkEvmPayment)');
  return null;
}
// 全局 EVM 扫描（第四轮 P0）：按链游标分页扫描，补扫漏检，重启可恢复。
// 扫描范围：[cursor, latest - requiredConfirmations]，按 EVM_SCAN_PAGE_BLOCKS 分页；整页成功后才推进游标，RPC 失败不推进。
// 对每个 Transfer 日志：记付款账本（discovered），按 to + 金额匹配待付款订单，匹配到且确认数足够时触发履约并记 posted。
// 返回 { scanned: 扫描日志数, matched: 匹配到账数, fulfilled: 履约数 }。游标失败不抛错（下次轮询重试）。
async function scanEvmChain(env, fetchFn, ctx, chain, pendingOrders) {
  // 白名单封堵：仅 X Layer / BEP20 可扫描；旧链订单不自动认账。
  if (PAY_CHAINS.indexOf(chain) === -1) return { scanned: 0, matched: 0, fulfilled: 0 };
  var settings = await getAllSettings(env);
  var contracts = parseJsonSafe(settings.usdt_contracts, {});
  var contract = contracts[chain] || DEFAULT_USDT_CONTRACTS[chain] || '';
  var rpcMap = parseJsonSafe(settings.rpc_urls, {});
  var rpcs = rpcMap[chain] || DEFAULT_RPC_URLS[chain] || [];
  if (!isValidEvmAddress(contract) || !rpcs.length || !pendingOrders.length) return { scanned: 0, matched: 0, fulfilled: 0 };
  // P3-15：扫描用确认数按本链待付款订单的最大金额取分级值（有大额订单时整链用大额确认数，
  // 避免大额付款在低确认数下被提前履约；小额订单随之多等几分钟，偏保守）。
  var maxAmt = 0;
  pendingOrders.forEach(function (o) { var a = Number(o.actual_amount || o.total_usdt) || 0; if (a > maxAmt) maxAmt = a; });
  var requiredConf = await getRequiredConfirmations(env, chain, maxAmt || undefined);
  var out = { scanned: 0, matched: 0, fulfilled: 0 };
  // 按待付款订单的收款地址去重，只扫有待付款订单的地址，减少 RPC 调用。地址格式非法时跳过（不认账）。
  var addrSet = {};
  pendingOrders.forEach(function (o) { var rawAddr = o.pay_address || o.wallet_address || ''; var a = String(rawAddr).toLowerCase(); if (a && isValidEvmAddress(rawAddr)) addrSet[a] = rawAddr; });
  var addrs = Object.keys(addrSet);
  for (var ai = 0; ai < addrs.length; ai++) {
    var addr = addrSet[addrs[ai]];
    var toTopic = padAddressTopic(addr);
    // 第九轮：游标按“链|地址”独立存储，不再多地址共享一个链游标。
    // 旧按链游标的风险：地址 A 的扫描把链游标推到 1000 后，地址 B 的首笔订单（创建于 990 区块、付款在 995 区块）
    // 若沿用链游标会从 1000 开始扫，漏掉 B 在 995 区块的到账。按地址独立游标后，B 首扫从 latest-200 开始，不漏。
    // 旧链游标行（如 key='X Layer'）保留在库不再使用，不删除。
    var cursorKey = chain + '|' + addrs[ai];
    var cursor = await getScanCursor(env, cursorKey);
    // 本地址的待付款订单（按金额索引，便于匹配）
    var addrOrders = pendingOrders.filter(function (o) { return String(o.pay_address || o.wallet_address || '').toLowerCase() === addrs[ai]; });
    for (var ri = 0; ri < rpcs.length; ri++) {
      try {
        var decimals = await getTokenDecimals(fetchFn, rpcs[ri], contract);
        if (decimals === null) continue; // 合约精度读不到：该 RPC 不认账，换下一个 RPC
        // 按合约实际 decimals 精确换算待匹配金额（BigInt），避免 float 精度丢失（BEP20 18 位时 float 无法精确表示）。
        var byRaw = {};
        addrOrders.forEach(function (o) { byRaw[String(amountToRaw(o.actual_amount || o.total_usdt, decimals))] = o; });
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
        var pageBlocks = EVM_SCAN_PAGE_BLOCKS;
        var blockedBlock = 0; // P2-11：页内非终态履约失败的最小事件区块，游标不越过它
        while (pageFrom <= endBlock) {
          var pageTo = Math.min(pageFrom + pageBlocks - 1, endBlock);
          var logs = await rpcCall(fetchFn, rpcs[ri], 'eth_getLogs', [{ address: contract, fromBlock: toHex(pageFrom), toBlock: toHex(pageTo), topics: [TRANSFER_TOPIC0, null, toTopic] }]);
          if (!Array.isArray(logs)) break; // 本 RPC 异常，停在本页，不推进游标，下次重试
          // P3-29：返回条数触及常见截断上限（10000 条）时缩小页宽重扫同一页；已是最小页宽仍截断则
          // 中断本轮（不推进游标越过该页），下次以更小页宽重扫，避免截断丢失的日志被游标越过。
          if (logs.length >= 10000) {
            if (pageBlocks > 10) { pageBlocks = Math.max(10, Math.floor(pageBlocks / 2)); continue; }
            break;
          }
          var pageBlockedAt = 0;
          for (var li = 0; li < logs.length; li++) {
            var lg = logs[li];
            // 严格匹配合约地址：RPC 可能忽略 address 过滤返回无关日志，不得仅凭 topics 认账。
            if (String(lg.address || '').toLowerCase() !== String(contract).toLowerCase()) continue;
            var topics = lg.topics || [];
            if (topics.length < 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC0) continue;
            if (String(topics[2]).toLowerCase() !== toTopic) continue;
            var blk = parseInt(lg.blockNumber, 16);
            if (!isFinite(blk)) continue;
            // 区块范围校验：不得只信 RPC 的 fromBlock/toBlock 过滤（RPC 可能返回范围外日志，如未达确认数的区块）。
            if (blk < pageFrom || blk > pageTo) continue;
            var val = 0n;
            try { val = BigInt(lg.data || '0x0'); } catch (e) { continue; }
            var amt = rawToAmount(val, decimals);
            out.scanned++;
            var matchedOrder = byRaw[String(val)];
            if (!matchedOrder) {
              // 无法归属订单：记 unmatched，供人工对账（不得静默丢弃）。
              try { await recordPayment(env, { order_id: null, chain: chain, pay_address: addr, tx_hash: String(lg.transactionHash || ''), event_key: lg.logIndex != null ? String(lg.logIndex) : '', amount: amt, block_number: blk, confirmations: latest - blk, status: 'unmatched', reconcile_status: 'pending', reconcile_note: '全局扫描发现，无法归属订单' }); } catch (e) {}
              continue;
            }
            out.matched++;
            // 账本：发现 → 核验通过 → 确认数足够 → 履约 → 入账。同一事件重复扫描时 recordPayment 返回已有行，不重复建行。
            var evKey = lg.logIndex != null ? String(lg.logIndex) : '';
            // P3-27：先查 /pay 留下的 event_key='' 同交易行（同订单归属），回填 event_key，不再另建一行。
            var payRow = null;
            var existingEmpty = null;
            try { existingEmpty = await env.DB.prepare("SELECT * FROM payments WHERE chain = ? AND tx_hash = ? AND event_key = ''").bind(chain, String(lg.transactionHash || '')).first(); } catch (e) { existingEmpty = null; }
            if (existingEmpty && (existingEmpty.order_id == null || Number(existingEmpty.order_id) === Number(matchedOrder.id))) {
              // P2-1：回填 event_key 时不得把 posted 降级为 discovered。
              // posted / manual_confirmed / reconciled 为终态：只补元数据（event_key/金额/区块/确认数），不改状态；
              // submitted/discovered 才可置为 discovered。
              var backfillFields = { event_key: evKey, order_id: matchedOrder.id, amount: amt, block_number: blk, confirmations: latest - blk, reconcile_note: '全局扫描发现（回填 event_key）' };
              if (existingEmpty.status === 'submitted' || existingEmpty.status === 'discovered') backfillFields.status = 'discovered';
              var backfill = await updatePayment(env, existingEmpty.id, backfillFields).catch(function () { return { ok: false }; });
              if (backfill && backfill.ok) payRow = Object.assign({}, existingEmpty, { event_key: evKey, order_id: matchedOrder.id, amount: amt, block_number: blk, confirmations: latest - blk, status: (backfillFields.status || existingEmpty.status) });
            }
            if (!payRow) {
              var rec = await recordPayment(env, { order_id: matchedOrder.id, chain: chain, pay_address: addr, tx_hash: String(lg.transactionHash || ''), event_key: evKey, amount: amt, block_number: blk, confirmations: latest - blk, status: 'discovered', reconcile_note: '全局扫描发现' }).catch(function () { return null; });
              payRow = rec && rec.payment ? rec.payment : null;
            }
            if (payRow && payRow.status === 'posted') continue; // 已入账，跳过（防重复发货）
            if (payRow) { try { await updatePayment(env, payRow.id, { status: 'confirmed', confirmations: latest - blk }); } catch (e) {} }
            // 金额必须与订单预期精确匹配（amountsEqual），否则记 mismatch，不得履约（BigInt 已精确匹配，此处为二次防御）。
            if (!amountsEqual(amt, matchedOrder.actual_amount || matchedOrder.total_usdt)) {
              if (payRow) { try { await updatePayment(env, payRow.id, { status: 'mismatch', reconcile_status: 'pending', reconcile_note: '金额与订单预期不符，需人工对账' }); } catch (e) {} }
              continue;
            }
            var r = await fulfillOrderByPayment(env, matchedOrder, String(lg.transactionHash || ''), ctx, { txVerified: true });
            if (r.ok && (r.mode === 'completed' || r.mode === 'pending_fulfill' || r.mode === 'out_of_stock' || r.mode === 'pending_activation' || r.mode === 'pending_upstream')) {
              out.fulfilled++;
              if (payRow) { try { await updatePayment(env, payRow.id, { status: 'posted' }); } catch (e) {} }
            } else if (!r.ok && !isTerminalFulfillRejection(r.reason)) {
              // P2-11：非终态履约失败（如瞬时 DB 错误）时记下该事件区块，游标不越过它，下次重扫；
              // 终态拒绝（TXID 已被他单认领 / 订单已终态）不阻塞游标。
              if (!pageBlockedAt || blk < pageBlockedAt) pageBlockedAt = blk;
            }
          }
          if (pageBlockedAt && (!blockedBlock || pageBlockedAt < blockedBlock)) blockedBlock = pageBlockedAt;
          scannedTo = pageTo + 1;
          pageFrom = pageTo + 1;
        }
        // P2-11：本轮有非终态履约失败时，游标只推进到最早失败事件所在区块，不越过它。
        if (blockedBlock && blockedBlock < scannedTo) scannedTo = blockedBlock;
        // 整页成功后推进本地址游标（只推进，不回退；RPC 失败不推进，下次重试）。
        if (scannedTo > startBlock) {
          var curNow = await getScanCursor(env, cursorKey);
          if (scannedTo > curNow) await setScanCursor(env, cursorKey, scannedTo);
        }
        break; // 本地址用第一个可用 RPC 扫完即停，不重复扫其他 RPC
      } catch (e) { continue; }
    }
  }
  return out;
}
async function checkChainPayment(env, fetchFn, order) {
  // 白名单封堵：仅 OKX X Layer / 币安 BEP20 两种组合可走链上核验；旧 TRC20/ERC20/站内转账订单不自动认账，转人工审核。
  if (!validPayCombo(order.pay_method, order.pay_chain)) return null;
  var settings = await getAllSettings(env);
  var contracts = parseJsonSafe(settings.usdt_contracts, {});
  var contract = contracts[order.pay_chain] || DEFAULT_USDT_CONTRACTS[order.pay_chain] || '';
  var rpcMap = parseJsonSafe(settings.rpc_urls, {});
  var rpcs = rpcMap[order.pay_chain] || DEFAULT_RPC_URLS[order.pay_chain] || [];
  if (!rpcs.length) return null;
  var reqConf = await getRequiredConfirmations(env, order.pay_chain, order.actual_amount || order.total_usdt);
  return await checkEvmPayment(fetchFn, rpcs, contract, order.pay_address || order.wallet_address, order.actual_amount || order.total_usdt, { requiredConfirmations: reqConf });
}
async function checkTxidPayment(env, fetchFn, order, txid) {
  // 按需核验：用户主动提交 TXID 时复用同一链上核验（EVM 查 receipt 日志）。白名单封堵：非首期两种组合不核验。
  var settings = await getAllSettings(env);
  if (!validPayCombo(order.pay_method, order.pay_chain)) return null;
  try {
    var contracts = parseJsonSafe(settings.usdt_contracts, {});
    var contract = contracts[order.pay_chain] || DEFAULT_USDT_CONTRACTS[order.pay_chain] || '';
    var rpcMap = parseJsonSafe(settings.rpc_urls, {});
    var rpcs = rpcMap[order.pay_chain] || DEFAULT_RPC_URLS[order.pay_chain] || [];
    if (!isValidEvmAddress(contract) || !isValidEvmAddress(order.pay_address || order.wallet_address)) return null;
    var toTopic = padAddressTopic(order.pay_address || order.wallet_address);
    for (var ri = 0; ri < rpcs.length; ri++) {
      try {
        // 第九轮：按合约实际 decimals 精确换算金额；decimals 读不到时该 RPC 不认账。
        var decimalsTx = await getTokenDecimals(fetchFn, rpcs[ri], contract);
        if (decimalsTx === null) continue;
        var expected = amountToRaw(order.actual_amount || order.total_usdt, decimalsTx);
        var receipt = await rpcCall(fetchFn, rpcs[ri], 'eth_getTransactionReceipt', [txid]);
        if (!receipt || receipt.status !== '0x1') continue;
        // 确认数：按该链确认策略（不再全链 1 确认）。收据区块号必须 <= 最新区块 - requiredConf，否则确认不足，跳过（防链重组导致已发货但付款失效）。
        try {
          var latestHex = await rpcCall(fetchFn, rpcs[ri], 'eth_blockNumber', []);
          var latestBn = parseInt(latestHex, 16);
          var receiptBn = parseInt(receipt.blockNumber, 16);
          var reqConfTxid = await getRequiredConfirmations(env, order.pay_chain, order.actual_amount || order.total_usdt);
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
// ---- 确定性测试钩子（仅测试用）：生产 env 无 __testHooks 时为 no-op。钩子用于在认领关键点制造确定性交错
// （Barrier / Deferred），不依赖调度/时间窗口。钩子抛错被吞掉，绝不影响业务路径。
async function testHook(env, name, arg) {
  try {
    var h = env && env.__testHooks;
    if (h && typeof h[name] === 'function') await h[name](arg);
  } catch (e) {}
}
// 条件释放订单租约：仅当租约仍属本请求时清空 claim_token/claimed_at。clearPaidAt=true 时同时清 paid_at
// （用于 TXID 认领失败：本次未建立任何付款事实，订单应恢复为可取消/可重试的未付款态；认领成功后的账本失败
// 则保留 paid_at，因为 TXID 已为本订单占用，订单不得被当作未付款取消）。
async function releaseOrderLease(env, orderId, leaseToken, clearPaidAt) {
  if (!leaseToken) return;
  try {
    if (clearPaidAt) {
      // paid_at 不是付款证据本身，但已有 TXID 认领时它与消费事实绑定：绝不因本次失败而清掉，
      // 否则订单会看起来像“从未付款”，后续取消路径可能误判。仅当本订单无任何 TXID 认领时才可清 paid_at。
      var consumed = await env.DB.prepare('SELECT 1 AS x FROM txid_claims WHERE order_id = ? LIMIT 1').bind(orderId).first().catch(function () { return null; });
      if (consumed) clearPaidAt = false;
    }
    var sql = clearPaidAt
      ? 'UPDATE orders SET claim_token = ' + "''" + ', claimed_at = NULL, paid_at = NULL WHERE id = ? AND claim_token = ?'
      : 'UPDATE orders SET claim_token = ' + "''" + ', claimed_at = NULL WHERE id = ? AND claim_token = ?';
    await env.DB.prepare(sql).bind(orderId, leaseToken).run();
  } catch (e) {}
}
async function claimTxid(env, txHash, orderId, opts) {
  // 同一笔交易只能被一个订单认领（永久有效，tx_hash 主键原子保证）。同一订单重试/接管收养旧认领。
  // 严格先到先得：已有其他订单认领时永远拒绝，不允许“接管/抢占”。
  // 原因：链上核验与管理员确认都可能看到同一笔交易；允许接管会让两个并发已验证请求互相覆盖，
  // 无法严格保证同一 TXID 只属于一个订单。归属争议必须由管理员在 D1 中核查 txid_claims 后手动处理，不得由接口自动改写。
  // P1-1/P1-2（v17）：每次新认领生成密码学安全随机 claim_token（randomHex(32)），持久化到 txid_claims.claim_token；
  // 人工确认与链上确认共享同一 txid_claims 全局原子认领，source 区分 'chain_verified' / 'manual_confirmed'，
  // 不再另建防重表、不再靠先 SELECT 后 INSERT；胜负由 tx_hash 主键唯一约束决定。
  // 收养：同订单已有认领时不新建，只把 order_lease_token 更新为本请求租约（接管者收养），不覆盖 source
  // （人工/链上来源以首次认领为准，不伪造）。
  // 永久保留：已成功写入 txid_claims 的认领永不被任何普通 API、租约接管或失败恢复流程自动删除。
  // 历史上存在过的 releaseTxidClaim 回滚原语已删除——没有任何调用方可以证明“该认领从未成为付款事实”，
  // 任何删除都会把已消费 TXID 放回全局可用池。归属争议只允许管理员在 D1 中人工对账处理（独立授权 + 审计），
  // 不由接口自动改写。
  opts = opts || {};
  var source = opts.source === 'manual_confirmed' ? 'manual_confirmed' : 'chain_verified';
  var leaseToken = opts.leaseToken || '';
  if (!txHash) return { ok: true, created: false, claimToken: null, claimedAt: null, source: null };
  await testHook(env, 'beforeTxidClaim', { txHash: txHash, orderId: orderId, source: source });
  var existing = await env.DB.prepare('SELECT order_id, claimed_at, claim_token, source, order_lease_token FROM txid_claims WHERE tx_hash = ?').bind(txHash).first().catch(function () { return null; });
  if (existing) {
    if (Number(existing.order_id) !== Number(orderId)) return { ok: false, reason: '该交易哈希已用于其他订单（请勿重复提交；归属争议请在 D1 中核查 txid_claims 后手动处理）' };
    if (leaseToken) { try { await env.DB.prepare('UPDATE txid_claims SET order_lease_token = ? WHERE tx_hash = ? AND order_id = ?').bind(leaseToken, txHash, orderId).run(); } catch (e) {} }
    return { ok: true, created: false, claimToken: existing.claim_token || null, claimedAt: existing.claimed_at || null, source: existing.source || 'chain_verified' };
  }
  // 遗留兼容：v17 前人工确认只写 payments manual_confirmed 行、不写 txid_claims。无认领行时若遗留人工行归属他单，拒绝；
  // 归属本单时继续新建认领行（把遗留消耗收敛到全局认领表），之后以认领表为准。
  var manualRow = await env.DB.prepare("SELECT order_id FROM payments WHERE tx_hash = ? AND status = 'manual_confirmed' LIMIT 1").bind(txHash).first().catch(function () { return null; });
  if (manualRow && Number(manualRow.order_id) !== Number(orderId)) {
    return { ok: false, reason: '该交易哈希已用于其他订单（请勿重复提交；归属争议请在 D1 中核查 txid_claims 后手动处理）' };
  }
  // 确定性并发点：两个并发请求都已通过上面的 SELECT（无认领行），在此 Barrier 处汇合后再同时 INSERT，
  // 胜负由 tx_hash 主键原子约束决定，不依赖先 SELECT 后 INSERT。测试用 env.__testHooks.beforeTxidInsert 控制。
  await testHook(env, 'beforeTxidInsert', { txHash: txHash, orderId: orderId, source: source });
  var claimedAt = nowISO();
  var myToken = randomHex(32);
  var ins = null;
  try {
    ins = await env.DB.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at, claim_token, source, order_lease_token) VALUES (?, ?, ?, ?, ?, ?)').bind(txHash, orderId, claimedAt, myToken, source, leaseToken || '').run();
  } catch (e) {
    // 列缺失的极端旧库（迁移未跑完）回退 3 列插入，令牌为空则该行永不被令牌回滚删除（宁可保留）。
    if (/no such column/i.test(String((e && e.message) || e))) {
      try { ins = await env.DB.prepare('INSERT INTO txid_claims (tx_hash, order_id, claimed_at) VALUES (?, ?, ?)').bind(txHash, orderId, claimedAt).run(); myToken = ''; } catch (e2) { ins = null; }
    } else { ins = null; }
  }
  if (ins && ins.meta && ins.meta.changes === 1) return { ok: true, created: true, claimToken: myToken || null, claimedAt: claimedAt, source: source };
  // 并发下 INSERT 冲突（主键已存在）：重新读，确认归属（同订单收养，他单拒绝）
  var again = await env.DB.prepare('SELECT order_id, claimed_at, claim_token, source FROM txid_claims WHERE tx_hash = ?').bind(txHash).first().catch(function () { return null; });
  if (again && Number(again.order_id) === Number(orderId)) {
    if (leaseToken) { try { await env.DB.prepare('UPDATE txid_claims SET order_lease_token = ? WHERE tx_hash = ? AND order_id = ?').bind(leaseToken, txHash, orderId).run(); } catch (e) {} }
    return { ok: true, created: false, claimToken: again.claim_token || null, claimedAt: again.claimed_at || null, source: again.source || 'chain_verified' };
  }
  // P3-30：重读为空 = 非冲突型 DB 错误（INSERT 失败且无占用行），不得谎称“已用于其他订单”。
  if (!again) return { ok: false, reason: '认领失败，请重试', transient: true };
  return { ok: false, reason: '该交易哈希已用于其他订单（请勿重复提交；归属争议请在 D1 中核查 txid_claims 后手动处理）' };
}
// P1-1：releaseTxidClaim 已彻底删除（本轮资金安全修复）。已成功取得全局消费权的认领不自动删除：
// 普通支付失败、订单租约释放、付款账本失败、订单取消路径都不能移除已消费 TXID 的全局防重证据。
// 唯一允许的纠正途径是管理员在 D1 中的独立人工对账操作（独立授权、可审计证据、严格流程），不在本代码中提供自动删除入口。
// P1-2：TXID 是否已被他单消耗（txid_claims 认领，或 v17 前遗留的人工 manual_confirmed 账本行）。
// 仅作 /pay 前置快筛（409 前置提示、省验证码），不是权威判定：权威判定是 claimTxid 的原子 INSERT + 主键约束。
// 新消耗一律以 txid_claims 为准（人工与链上共享同一全局认领表）。
async function txHashConsumedByOther(env, txHash, orderId) {
  if (!txHash) return null;
  var c = await env.DB.prepare('SELECT order_id FROM txid_claims WHERE tx_hash = ?').bind(txHash).first().catch(function () { return null; });
  if (c && Number(c.order_id) !== Number(orderId)) return '该交易哈希已用于其他订单（请勿重复提交；归属争议请在 D1 中核查 txid_claims 后手动处理）';
  var m = await env.DB.prepare("SELECT order_id FROM payments WHERE tx_hash = ? AND status = 'manual_confirmed' LIMIT 1").bind(txHash).first().catch(function () { return null; });
  if (m && Number(m.order_id) !== Number(orderId)) return '该交易哈希已用于其他订单（请勿重复提交；归属争议请在 D1 中核查 txid_claims 后手动处理）';
  return null;
}
async function claimOrderForPayment(env, orderId, txHash) {
  // 原子认领：status=pending_payment 且（未认领 或 认领已超租约）。成功时同时写入 paid_at（付款处理标记，非付款证据）与 tx_hash。
  // txHash 为空时不覆盖已有 tx_hash。
  // 永久保留（本轮修复）：旧 TXID 一旦已在 txid_claims 中取得全局消费权，绝不因新租约、新 TXID 提交或旧请求失败而被删除。
  // 候选 TXID 与已消费 TXID 严格区分：若旧 tx_hash 已有本订单的认领行，orders.tx_hash 保持为第一笔已消费 TXID（付款证据），
  // 不被尚未验证的新候选 TXID 覆盖；新 TXID 若通过完整链上核验并取得自身认领，将作为该订单的第二笔付款事件
  // （独立的 txid_claims 行 + payments 行），绝不通过覆盖 tx_hash 或删除历史认领来伪造只有一笔付款。
  // 旧 tx_hash 无认领行时（仅是上次租约留下的候选、从未成为付款事实），新 TXID 可正常覆盖。
  var oldTx = null;
  var oldConsumed = false;
  if (txHash) {
    var oldRow = await env.DB.prepare('SELECT tx_hash FROM orders WHERE id = ?').bind(orderId).first();
    oldTx = oldRow ? oldRow.tx_hash : null;
    if (oldTx && oldTx !== txHash) {
      var oc = await env.DB.prepare('SELECT 1 AS x FROM txid_claims WHERE tx_hash = ? AND order_id = ? LIMIT 1').bind(oldTx, orderId).first().catch(function () { return null; });
      oldConsumed = !!oc;
    }
  }
  var token = randomHex(16);
  var now = nowISO();
  // oldConsumed 时不写 tx_hash：保留第一笔已消费 TXID 作为付款证据；新候选 TXID 不得覆盖它。
  var sql = "UPDATE orders SET claim_token=?, claimed_at=?, paid_at=?" + ((txHash && !oldConsumed) ? ", tx_hash=?" : "") + " WHERE id=? AND status='pending_payment' AND (claim_token IS NULL OR claim_token='' OR claimed_at IS NULL OR claimed_at < datetime('now', '-" + CLAIM_LEASE_MINUTES + " minutes'))";
  var stmt = env.DB.prepare(sql);
  var binds = [token, now, now];
  if (txHash && !oldConsumed) binds.push(txHash);
  binds.push(orderId);
  var upd = await stmt.bind.apply(stmt, binds).run();
  if (!upd.meta || upd.meta.changes !== 1) return { ok: false, reason: '订单已被其他请求认领或处理', claimToken: null };
  return { ok: true, claimToken: token, preservedOldTxHash: oldConsumed ? oldTx : null };
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
  // P1-6：返回成功标记的卡 id 列表（而非数量），补偿只还这些确切 id；按前缀 slice 补偿会漏还非前缀成功的卡。
  var stmts = [];
  for (var i = 0; i < cardIds.length; i++) {
    if (mode === 'reserved') stmts.push(env.DB.prepare('UPDATE cards SET is_used=1, order_id=?, reserved_order_id=NULL, reserved_at=NULL WHERE id=? AND is_used=0 AND reserved_order_id=?').bind(orderId, cardIds[i], orderId));
    else stmts.push(env.DB.prepare('UPDATE cards SET is_used=1, order_id=?, reserved_order_id=NULL, reserved_at=NULL WHERE id=? AND is_used=0 AND reserved_order_id IS NULL').bind(orderId, cardIds[i]));
  }
  if (!stmts.length) return [];
  var results;
  if (env.DB.batch) results = await env.DB.batch(stmts);
  else { results = []; for (var j = 0; j < stmts.length; j++) results.push(await stmts[j].run()); }
  var okIds = [];
  for (var k = 0; k < results.length; k++) {
    if (results[k] && results[k].meta && Number(results[k].meta.changes || 0) > 0) okIds.push(cardIds[k]);
  }
  return okIds;
}
async function unmarkCards(env, orderId, cardIds) {
  // 补偿：将本轮标记的卡恢复为预留态（仅本订单标记的卡）。
  // P1-7：订单状态保护——订单已 completed 时绝不还卡（已交付的卡还回池子会造成同一张卡卖两次）。
  var o = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first().catch(function () { return null; });
  if (o && o.status === 'completed') return;
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
      if (marked.length !== toMark.length) {
        await unmarkCards(env, orderId, marked);
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
    if (marked2.length !== alist.length) {
      await unmarkCards(env, orderId, marked2);
      await unmarkCards(env, orderId, newlyMarkedIds);
      return { ok: false, reason: '卡密标记失败' };
    }
    for (var m = 0; m < alist.length; m++) { cardIds.push(alist[m].id); codes.push(alist[m].code); newlyMarkedIds.push(alist[m].id); }
  }
  return { ok: true, cardIds: cardIds, newlyMarkedIds: newlyMarkedIds, codes: codes };
}
async function completeOrder(env, orderId, deliveryContent, statusSql, statusBinds) {
  // 条件完成订单（防并发重复完成）。成功时清空认领令牌与过期异常标记（P3-24：自动发货完成
  // 不残留 exception_reason，与手动发货行为一致）。
  var sql = "UPDATE orders SET status='completed', delivery_content=?, fulfilled_at=?, claim_token='', exception_reason='' WHERE id=? AND " + statusSql;
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
// P1-6：手动发货 delivery 非空时，检查本订单名下 is_used=1 的残留卡。code 出现在本次交付内容
// （按行精确匹配）中的视为已交付、保留；未出现的视为崩溃残留/误标，释放回可用池，返回释放/保留数，
// 调用方把释放数记入审计，绝不静默丢弃。
async function releaseResidualMarkedCards(env, orderId, delivery) {
  var delivered = {};
  String(delivery || '').split('\n').forEach(function (s) { var t = s.trim(); if (t) delivered[t] = 1; });
  var rows = await env.DB.prepare('SELECT id, code FROM cards WHERE order_id = ? AND is_used = 1').bind(orderId).all().catch(function () { return { results: [] }; });
  var released = 0, kept = 0;
  for (var i = 0; i < (rows.results || []).length; i++) {
    var c = rows.results[i];
    if (delivered[String(c.code || '').trim()]) { kept++; continue; }
    var upd = await env.DB.prepare('UPDATE cards SET is_used=0, order_id=NULL, reserved_order_id=NULL, reserved_at=NULL WHERE id=? AND is_used=1 AND order_id=?').bind(c.id, orderId).run().catch(function () { return null; });
    if (upd && upd.meta && upd.meta.changes === 1) released++;
  }
  return { released: released, kept: kept };
}
async function fulfillAfterPayment(env, order, txHash, ctx, opts) {
  // 统一发货入口：轮询 / 手动 TXID / 管理员确认收款三条路径复用，禁止三份重复发货逻辑。
  // 并发安全：订单原子认领（租约-first，成功才继续）→ TXID 原子认领（租约绑定）→ 副作用（上游/卡密）→ 条件完成。认领失败立即返回，绝不产生副作用。
  opts = opts || {};
  var txVerified = !!opts.txVerified; // 链上已验证的交易哈希（轮询 / TXID 核验）才做 TXID 认领；币安站内转账订单 ID 不是链上哈希，不认领。
  var manualConfirm = !!opts.manualConfirm; // P1-2：独立人工确认通道（管理员已在系统外核对到账）。
  // 人工通道规则：必须带人工原因 + 额外确认标志（调用方传入 manualReason + manualConfirmedFlag），
  // 订单标记为人工确认态（审计 action=manual_confirm_payment + admin_note【人工确认收款】前缀 + payments manual_confirmed 行），
  // 写 txid_claims 全局认领（source=manual_confirmed，与链上共享同一全局原子认领），绝不伪装成正常链上已付。
  var manualReason = String(opts.manualReason || '').trim();
  if (manualConfirm && (!manualReason || !opts.manualConfirmedFlag)) return { ok: false, reason: '人工确认需提供原因与确认标志' };
  var fresh = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(order.id).first();
  if (!fresh) return { ok: false, reason: '订单不存在' };
  if (fresh.status === 'completed' || fresh.status === 'cancelled') return { ok: false, reason: '订单已被处理' };
  if (fresh.status === 'pending_activation' || fresh.status === 'pending_upstream' || fresh.status === 'refund_pending') return { ok: true, mode: fresh.status };
  if (fresh.status !== 'pending_payment') return { ok: false, reason: '当前状态不可发货' };
  var o = fresh;
  var prod = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(o.product_id).first();
  // 1. 订单原子认领（先租约，后 TXID 认领；租约-first）。
  // 旧顺序（先 TXID 认领、后订单认领）的竞态：A 插认领得 created=true；B 看到同订单已有认领得 created=false；
  // B 获订单租约开始履约；A 订单认领失败触发回滚，删掉 B 依赖的认领；第三订单可重认领。
  // 新顺序消除该交错：未获订单租约的请求根本不触碰 TXID 认领；获租约后才认领 TXID；认领失败时释放本请求租约
  // （清 paid_at，本次未建立付款事实），不触碰认领行（本次未新建；已属本订单的旧认领由收养逻辑绑定新租约）。
  var claim = await claimOrderForPayment(env, o.id, txHash);
  if (!claim.ok) return { ok: false, reason: claim.reason };
  var claimToken = claim.claimToken;
  // 2. TXID 认领（仅链上哈希）。
  // 链上通道：仅当 txVerified=true（已通过完整链上核验：网络+白名单合约+收款地址+精确金额+回执+确认数）
  // 才认领；格式像 64 位哈希本身不是证据，未核验的 TXID 绝不认领、绝不发货。
  // 人工通道：与链上共享同一 txid_claims 全局原子认领，source='manual_confirmed'；TXID 已归属他单时拒绝，
  // 链上验证成功也不能绕过（claimTxid 对他单认领一律拒绝）。同订单已有认领时收养（不重复建行、不覆盖 source）。
  var isChainHash = !!txHash && /^(0x)?[0-9a-fA-F]{64}$/.test(String(txHash)) && o.pay_method !== 'BinanceUID';
  var txClaim = null;
  if (isChainHash && !manualConfirm && !txVerified) {
    await releaseOrderLease(env, o.id, claimToken, true);
    return { ok: false, reason: '该交易未经链上核验，拒绝发货（请走链上核验或人工确认通道）' };
  }
  if (isChainHash) {
    var tc = await claimTxid(env, txHash, o.id, { source: manualConfirm ? 'manual_confirmed' : 'chain_verified', leaseToken: claimToken });
    if (!tc.ok) {
      await releaseOrderLease(env, o.id, claimToken, true);
      return { ok: false, reason: tc.reason };
    }
    txClaim = tc;
    // 注意：本函数失败路径永不删除认领行（已消费认领永久保留，同订单重试收养；releaseTxidClaim 已删除，无自动释放入口）。
    // 确定性测试点：租约 + TXID 认领均已持有、副作用尚未开始。测试可在此暂停本请求、让接管请求完成，
    // 再恢复本请求，验证本请求不再破坏接管者的认领/租约（见 tests/txid-race-deterministic-test.mjs）。
    await testHook(env, 'afterTxidClaimAndLease', { orderId: o.id, claimToken: claimToken, txClaimToken: tc.claimToken || null, source: tc.source || null, manualConfirm: manualConfirm });
  }
  // 3. 人工账本（仅人工通道 + 链上哈希）：认领成功后记 manual_confirmed 账本行（event_key=manual:<订单ID>）。
  // 失败关闭：账本写入失败时绝不静默把订单推为已付款/已交付；只有查询确认已有账本行（同订单、同 TXID、
  // status=manual_confirmed）时才按幂等重试继续，否则释放租约（保留 TXID 认领，同订单可安全重试，不向他单开放 TXID）
  // 并返回失败。认领行保留是恢复语义：重试收养同一认领，不重复建行。不能仅因 INSERT 报错就假定幂等冲突。
  // 审计写入失败语义继续遵循 P1-7（ok:true + audit_failed:true，不得重复业务副作用）；不要宣称多条 D1 写形成数据库事务。
  if (manualConfirm && isChainHash) {
    var ledgerOk = false;
    try {
      var li = await env.DB.prepare('INSERT INTO payments (order_id, chain, asset, pay_address, tx_hash, event_key, amount, amount_unit, block_number, confirmations, first_seen_at, status, reconcile_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
        o.id, o.pay_chain || '', 'USDT', o.pay_address || o.wallet_address || '', txHash, 'manual:' + o.id, Number(o.actual_amount || o.total_usdt) || 0, 'USDT', null, 0, nowISO(), 'manual_confirmed', ('人工确认收款，原因：' + manualReason).slice(0, 500), nowISO(), nowISO()).run();
      if (li && li.meta && li.meta.changes === 1) ledgerOk = true;
    } catch (e) { ledgerOk = false; }
    if (!ledgerOk) {
      var exLedger = await env.DB.prepare('SELECT * FROM payments WHERE chain = ? AND tx_hash = ? AND event_key = ?').bind(o.pay_chain || '', txHash, 'manual:' + o.id).first().catch(function () { return null; });
      if (exLedger && Number(exLedger.order_id) === Number(o.id) && String(exLedger.status) === 'manual_confirmed') ledgerOk = true;
    }
    if (!ledgerOk) {
      await releaseOrderLease(env, o.id, claimToken, false);
      return { ok: false, reason: '人工确认账本写入失败，请重试（TXID 认领已保留，同订单可安全重试）' };
    }
  }
  var claimWhere = "status='pending_payment' AND claim_token=?";
  var claimBinds = [claimToken];
  // ---- 上游商品：调 ProdSeller 拿货 ----
  if (prod && prod.source === 'prodseller') {
    var settings = await getAllSettings(env);
    var cf = {}; try { cf = JSON.parse(o.customer_fields || '{}'); } catch (e) { cf = {}; }
    // 崩溃恢复：已有上游单号时只轮询状态，绝不重复采购。
    var existingUp = await env.DB.prepare('SELECT * FROM upstream_orders WHERE order_id = ? ORDER BY id DESC LIMIT 1').bind(o.id).first();
    // P1-11：上次创建成功但响应无单号时已置 no_psid_awaiting_manual 标记（无上游单号可查，
    // 连接器亦无按业务单号查询的接口），此处绝不再次创建，等人工在上游后台核对后处理。
    if (existingUp && !existingUp.prodseller_order_id && existingUp.status === 'no_psid_awaiting_manual') {
      await env.DB.prepare("UPDATE orders SET status='pending_upstream', admin_note=? WHERE id=? AND claim_token=?").bind('上游创建成功但响应无单号，已停止自动重试创建，需人工在上游后台按商城订单号核对后处理', o.id, claimToken).run();
      return { ok: true, mode: 'pending_upstream', reason: 'no_psid_awaiting_manual' };
    }
    if (existingUp && existingUp.prodseller_order_id) {
      var g = await prodsellerGetOrder(env, settings, existingUp.prodseller_order_id);
      if (g.ok) {
        var gst = upstreamStatusOf(g.data);
        var gkeys = upstreamKeysOf(g.data);
        await upsertUpstreamOrder(env, o.id, existingUp.prodseller_order_id, gst, upstreamAmountOf(g.data), gkeys, { claimToken: claimToken });
        // P1-4：上游终态失败 → 转异常 + 停止轮询。
        if (isUpstreamTerminalFailure(gst)) {
          await applyUpstreamTerminalFailure(env, o.id, existingUp.prodseller_order_id, gst, "status='pending_payment' AND claim_token=?", [claimToken]);
          return { ok: true, mode: 'refund_pending', reason: 'upstream_terminal_' + gst };
        }
        if (gst === 'delivered') {
          // P2-3：keys 为空/不足 → 明确 pending_activation + 缺失数与建议 + 审计，绝不标完成。
          if (countDeliveredKeys(gkeys) < o.quantity) {
            await env.DB.prepare("UPDATE orders SET status='pending_activation', admin_note=? WHERE id=? AND claim_token=?").bind(upstreamDeliveredShortfallNote(gkeys, o.quantity), o.id, claimToken).run();
            await logAudit(env, o.id, 'upstream_keys_insufficient', o.status, 'pending_activation', upstreamDeliveredShortfallNote(gkeys, o.quantity));
            return { ok: true, mode: 'pending_activation', reason: 'insufficient_keys' };
          }
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
      await upsertUpstreamOrder(env, o.id, '', 'gateway_closed', 0, '', { claimToken: claimToken });
      return { ok: true, mode: 'pending_upstream', reason: 'gateway_closed' };
    }
    var cr = await prodsellerCreateOrder(env, settings, o, prod, cf);
    // P1-1：门禁单点在 prodsellerCreateOrder 入口（403）；此处按门禁关闭处理，不当作上游错误重试。
    if (cr.status === 403) {
      await env.DB.prepare("UPDATE orders SET status='pending_upstream', admin_note=? WHERE id=? AND claim_token=?").bind('上游门禁关闭（prodseller_enabled != 1），未发起真实采购，等待人工处理', o.id, claimToken).run();
      await upsertUpstreamOrder(env, o.id, '', 'gateway_closed', 0, '', { claimToken: claimToken });
      return { ok: true, mode: 'pending_upstream', reason: 'gateway_closed' };
    }
    if (cr.status === 402) {
      await env.DB.prepare("UPDATE orders SET status='pending_upstream', admin_note=? WHERE id=? AND claim_token=?").bind('上游余额不足（402），后台置顶告警，不发货', o.id, claimToken).run();
      await upsertUpstreamOrder(env, o.id, '', 'insufficient_balance', 0, '', { claimToken: claimToken });
      return { ok: true, mode: 'pending_upstream', reason: 'insufficient_balance' };
    }
    if (cr.status === 409) {
      await env.DB.prepare("UPDATE orders SET status='pending_upstream', admin_note=? WHERE id=? AND claim_token=?").bind('上游缺货（409），已标记缺货转人工', o.id, claimToken).run();
      await upsertUpstreamOrder(env, o.id, '', 'out_of_stock', 0, '', { claimToken: claimToken });
      return { ok: true, mode: 'pending_upstream', reason: 'out_of_stock' };
    }
    if (cr.status === 429 || cr.status >= 500 || !cr.ok) {
      await env.DB.prepare("UPDATE orders SET status='pending_upstream', admin_note=? WHERE id=? AND claim_token=?").bind('上游调用失败 HTTP ' + cr.status + '，退避重试，下次轮询继续', o.id, claimToken).run();
      await upsertUpstreamOrder(env, o.id, '', 'upstream_error', 0, '', { claimToken: claimToken });
      return { ok: true, mode: 'pending_upstream', reason: 'upstream_error' };
    }
    var st = upstreamStatusOf(cr.data);
    var psId = (cr.data && (cr.data.id || cr.data.orderId || cr.data.order_id)) || '';
    var keys = upstreamKeysOf(cr.data);
    await upsertUpstreamOrder(env, o.id, String(psId || ''), st, upstreamAmountOf(cr.data), keys, { claimToken: claimToken });
    if (cr.data && cr.data.discount != null) { await env.DB.prepare('UPDATE orders SET admin_note=? WHERE id=? AND claim_token=?').bind('上游订单 ' + String(psId || '') + ' 金额 ' + upstreamAmountOf(cr.data) + ' 折扣 ' + upstreamDiscountOf(cr.data), o.id, claimToken).run(); }
    // P1-11：创建成功但响应无单号 → 不盲目重建。连接器无按业务单号（order_no）查询上游订单的接口，
    // 无法按 order_no 查回上游单号；置 pending_upstream + 人工处理标记，轮询不再对该订单重复创建。
    if (!psId) {
      await env.DB.prepare("UPDATE orders SET status='pending_upstream', admin_note=? WHERE id=? AND claim_token=?").bind('上游创建成功但响应无单号，已停止自动重试创建，需人工在上游后台按商城订单号核对上游订单后处理', o.id, claimToken).run();
      await upsertUpstreamOrder(env, o.id, '', 'no_psid_awaiting_manual', upstreamAmountOf(cr.data), keys, { claimToken: claimToken });
      return { ok: true, mode: 'pending_upstream', reason: 'no_psid_awaiting_manual' };
    }
    // P1-4：上游终态失败 → 转异常 + 停止轮询。
    if (isUpstreamTerminalFailure(st)) {
      await applyUpstreamTerminalFailure(env, o.id, String(psId), st, "status='pending_payment' AND claim_token=?", [claimToken]);
      return { ok: true, mode: 'refund_pending', reason: 'upstream_terminal_' + st };
    }
    if (st === 'delivered') {
      // P2-3：keys 为空/不足 → 明确 pending_activation + 缺失数与建议 + 审计，绝不标完成。
      if (countDeliveredKeys(keys) < o.quantity) {
        await env.DB.prepare("UPDATE orders SET status='pending_activation', admin_note=? WHERE id=? AND claim_token=?").bind(upstreamDeliveredShortfallNote(keys, o.quantity), o.id, claimToken).run();
        await logAudit(env, o.id, 'upstream_keys_insufficient', o.status, 'pending_activation', upstreamDeliveredShortfallNote(keys, o.quantity));
        return { ok: true, mode: 'pending_activation', reason: 'insufficient_keys' };
      }
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
    // P1-8：卡密分支完成成功后释放剩余预留（只动 is_used=0 的预留卡，不误动已用卡），不留 24h 冻结。
    await releaseReservation(env, o.id);
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
// 本轮（PR #4 后续）资金安全：订单是否已拥有“已消费付款事实”。
// 付款事实 = txid_claims 中的全局 TXID 认领（已取得全局消费权），或 payments 中 verified/confirmed/posted/manual_confirmed
// 账本行（链上已验证 / 已入账 / 人工确认）。submitted/discovered/duplicate/mismatch/unmatched 不是本订单的付款事实，
// 不触发保护。paid_at 只是租约获取时的时间戳，不是付款证据：无认领、无账本、租约已过期时仍可取消（P1-3 陈旧认领恢复）。
// 查询失败时 fail-closed（视为已有付款事实），绝不因一次读失败就取消可能已付款的订单。
async function orderHasConsumedPayment(env, orderId) {
  try {
    var c = await env.DB.prepare('SELECT 1 AS x FROM txid_claims WHERE order_id = ? LIMIT 1').bind(orderId).first();
    if (c) return true;
    var p = await env.DB.prepare("SELECT 1 AS x FROM payments WHERE order_id = ? AND status IN ('verified', 'confirmed', 'posted', 'manual_confirmed') LIMIT 1").bind(orderId).first();
    return !!p;
  } catch (e) { return true; }
}
// 单笔过期取消（超时取消与管理员取消的共享守卫，单条条件 UPDATE 原子执行）。
// 允许取消当且仅当：状态 pending_payment + 已过期 + 无已消费付款事实 +（未认领 或 租约已过期）。
// UPDATE 内含 NOT EXISTS 双重守卫：预检与 UPDATE 之间的竞态（付款认领恰好在此间写入）也会被单条语句挡住，
// 付款处理与取消只允许一个成功。取消绝不删除 txid_claims / payments（认领永久保留，账本不回滚）。
// 审计失败不回滚取消（取消本身已提交），仅记日志；重复运行幂等（第二次 UPDATE 因状态已变命中 0 行，不重复写审计/释放）。
async function tryExpireOrder(env, orderId) {
  try {
    var o = await env.DB.prepare('SELECT id, expires_at, created_at, paid_at, claim_token, claimed_at, status FROM orders WHERE id = ?').bind(orderId).first();
    if (!o || o.status !== 'pending_payment') return { expired: false };
    var expMs = effectiveExpiryMs(o);
    if (expMs == null || expMs >= Date.now()) return { expired: false };
    if (await orderHasConsumedPayment(env, orderId)) return { expired: false, reason: 'consumed_payment' };
    var fallbackNote = isLegacyExpiryFallback(o) ? '（历史回退：expires_at 缺失/无效，按 created_at + 20 分钟判定）' : '';
    var upd = await env.DB.prepare("UPDATE orders SET status='cancelled', admin_note=?, claim_token='', upstream_lock='', upstream_lock_expires_at=NULL WHERE id=? AND status='pending_payment' AND NOT EXISTS (SELECT 1 FROM txid_claims WHERE order_id = orders.id) AND NOT EXISTS (SELECT 1 FROM payments WHERE order_id = orders.id AND status IN ('verified', 'confirmed', 'posted', 'manual_confirmed')) AND ((paid_at IS NULL AND (claim_token IS NULL OR claim_token='')) OR (claimed_at IS NOT NULL AND claimed_at < datetime('now', '-" + CLAIM_LEASE_MINUTES + " minutes')))").bind('支付超时自动取消（20分钟未到账）' + fallbackNote, orderId).run();
    if (upd.meta && upd.meta.changes > 0) {
      await releaseReservation(env, orderId);
      await releaseClaimedButUndeliveredCards(env, orderId);
      var auditOk = await logAudit(env, orderId, 'auto_cancel_timeout', 'pending_payment', 'cancelled', '支付超时自动取消，释放卡密预留' + fallbackNote);
      if (!auditOk) console.error('audit failed: auto_cancel_timeout order=' + orderId);
      return { expired: true };
    }
    return { expired: false };
  } catch (e) { return { expired: false, reason: 'error' }; }
}
// 过期清理（独立职责，与链上扫描解耦）：遍历待付款订单，逐笔 tryExpireOrder。无 RPC 调用。
async function expireUnpaidOrders(env) {
  var expired = 0;
  var expCandidates = await env.DB.prepare("SELECT id FROM orders WHERE status='pending_payment' ORDER BY id ASC LIMIT 500").all().catch(function () { return { results: [] }; });
  var expList = (expCandidates.results || []);
  for (var ei = 0; ei < expList.length; ei++) {
    var r = await tryExpireOrder(env, expList[ei].id);
    if (r.expired) expired++;
  }
  return expired;
}
async function runPolling(env, fetchFn, ctx) {
  fetchFn = fetchFn || fetch;
  var settings = await getAllSettings(env);
  // 职责解耦（本轮修复）：poll_enabled 只控制“链上支付扫描 + 需要 RPC 的核验逻辑”，不再控制过期清理。
  // poll_enabled=0 时：跳过全部 RPC（零链上调用），但仍运行过期清理，避免过期未付款订单永久冻结卡密预留。
  // poll_enabled=1 时：先过期清理，再链上扫描。过期清理本身不启用真实收款、不调上游、不改 poll 语义。
  var expired = await expireUnpaidOrders(env);
  if (String(settings.poll_enabled || '1') === '0') return { ok: true, skipped: 'poll_scan_disabled', checked: 0, fulfilled: 0, expired: expired, expiry_cleanup: 1 };
  // P2-2 Phase B：公平轮转。orders 表已有 last_checked_at 列，用它排序并处理 NULL/空串：
  // 从未检查（NULL/''）优先，其次最久未检查，避免前 100 笔钉死导致第 101 笔后新订单饿死。
  var pending = await env.DB.prepare("SELECT * FROM orders WHERE status='pending_payment' ORDER BY CASE WHEN last_checked_at IS NULL OR last_checked_at='' THEN 0 ELSE 1 END, last_checked_at ASC, id ASC LIMIT 100").all();
  var list = pending.results || [];
  if (!list.length) return { ok: true, checked: 0, fulfilled: 0, expired: expired, note: list.length === 0 && expired === 0 ? 'no pending, zero RPC' : 'all pending expired-cancelled' };
  var fulfilled = 0, checked = 0;
  for (var i = 0; i < list.length; i++) {
    var o = list[i];
    try {
      // 超时：未付款且未被认领的订单可自动取消（与 Phase A 同一 tryExpireOrder 守卫，含已消费付款事实保护）；
      // 已消费付款事实 / 有效租约的订单绝不自动取消，走异常/恢复流程。P3-6：用有效过期时间判定。
      var oExpMs = effectiveExpiryMs(o);
      if (oExpMs != null && oExpMs < Date.now()) {
        var exR = await tryExpireOrder(env, o.id);
        if (exR.expired) expired++;
        continue;
      }
      // P2-12：BinanceUID 订单只做超时取消（上方），不链上核验。
      if (o.pay_method === 'BinanceUID') continue;
      checked++;
      var hit = null;
      var rpcOk = false;
      try { hit = await checkChainPayment(env, fetchFn, o); rpcOk = true; } catch (e) { hit = null; }
      // P2-2（集成修复）：RPC 出错不推进 last_checked_at，仅成功核验后推进；失败订单下轮仍排前面，尽快重试。
      if (rpcOk) await env.DB.prepare('UPDATE orders SET last_checked_at=? WHERE id=?').bind(nowISO(), o.id).run();
      if (hit && hit.txHash) {
        // 账本：轮询发现 → 核验通过 → 确认数足够（checkChainPayment 已按各链确认策略过滤）→ 履约 → 入账。
        // event_key：EVM 为 logIndex（区分同交易多笔转账）。
        var evKey = '';
        if (hit.logIndex != null && hit.logIndex !== '') evKey = String(hit.logIndex);
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
    list.forEach(function (o) { if (validPayCombo(o.pay_method, o.pay_chain)) evmChains[o.pay_chain] = 1; });
    for (var ch in evmChains) {
      var chainOrders = list.filter(function (o) { return o.pay_chain === ch; });
      var scanRes = await scanEvmChain(env, fetchFn, ctx, ch, chainOrders);
      fulfilled += (scanRes.fulfilled || 0);
    }
  } catch (e) { /* 全局扫描失败不影响逐单结果，下次轮询重试 */ }
  return { ok: true, checked: checked, fulfilled: fulfilled, expired: expired };
}
function sanitizeOrderForPublic(o, level) {
  // level: 'full' = 凭证验证通过的本人，可看交付内容；'summary' = 仅看订单概要，绝不返回交付内容与客户隐私字段；
  // 'admin' = 管理端详情，保留 exception_reason/refund_ref/admin_note 等管理员可见字段，仍剥离凭证哈希类字段。
  // P3-2：默认 summary（fail-closed），调用方必须显式传 'full'/'admin' 才放宽。
  // 内部字段（认领令牌、凭证哈希、旧查询密码、salt）永不返回。
  if (!o) return null;
  var out = Object.assign({}, o);
  delete out.query_password;
  delete out.query_token_hash;
  delete out.query_password_salt;
  // 只暴露“是否设了查询密码”（与查询列表的 credential_type 同口径），不暴露哈希本身。
  out.has_query_password = (o.query_password_salt && o.query_password_hash) ? 1 : 0;
  delete out.query_password_hash;
  delete out.claim_token;
  delete out.claimed_at;
  try { out.product_snapshot = JSON.parse(o.product_snapshot || '{}'); } catch (e) { out.product_snapshot = {}; }
  if (level === 'admin') {
    try { out.customer_fields = JSON.parse(o.customer_fields || '{}'); } catch (e) { out.customer_fields = {}; }
    // 管理端详情：保留 admin_note / exception_reason / refund_ref / upstream_lock 等管理员可见字段。
  } else if (level === 'full') {
    try { out.customer_fields = JSON.parse(o.customer_fields || '{}'); } catch (e) { out.customer_fields = {}; }
    // P2-1：full 分支同样删除 admin_note（内部备注不得泄露给买家）；退款凭证、异常原因、上游租约仅管理员可见。
    delete out.admin_note;
    delete out.refund_ref;
    delete out.exception_reason;
    delete out.upstream_lock;
    delete out.upstream_lock_expires_at;
  } else {
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
  // P1-3：开启但 Site Key 缺失 → 失败关闭，拒绝请求并给明确错误，不得回落到 SVG 验证码路径。
  if (!String(settings.turnstile_site_key || '').trim()) return '反机器人验证未配置（Turnstile Site Key 缺失），请联系管理员';
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
  // P3-7：摘要比较用恒定时间比较（长度不一致时 timingSafeEqual 仍走满循环，不泄露长度/前缀信息）。
  if (!timingSafeEqual(inputHash, String(capRow.code_hash))) {
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
  // 第九轮：严格白名单。新订单仅允许 OKX|X Layer、Binance|BEP20。
  // 拒绝：OKX+BEP20、Binance+X Layer、任意+TRC20/ERC20、BinanceUID+站内转账、未知组合。
  for (var i = 0; i < PAY_WHITELIST.length; i++) {
    if (PAY_WHITELIST[i][0] === method && PAY_WHITELIST[i][1] === chain) return true;
  }
  return false;
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
      return { id: p.id, slug: p.slug, title: p.title, category: p.category, price_usdt: eff, sell_price: eff, stock_type: p.stock_type, description: p.description, notice: p.notice, form_fields: f, image_emoji: p.image_emoji, image_data: p.image_data || '', app_icon_key: p.app_icon_key || '', sort: p.sort, source: p.source || 'self', prodseller_id: p.prodseller_id || '', requires_email_activation: Number(p.requires_email_activation || 0), delivery_method: p.delivery_method || 'both', in_stock: realInStock(p, cm) };
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
    return json({ ok: true, product: { id: one.id, slug: one.slug, title: one.title, category: one.category, price_usdt: getEffectivePrice(one), sell_price: getEffectivePrice(one), stock_type: one.stock_type, description: one.description, notice: one.notice, form_fields: ff, image_emoji: one.image_emoji, image_data: one.image_data || '', app_icon_key: one.app_icon_key || '', source: one.source || 'self', prodseller_id: one.prodseller_id || '', requires_email_activation: Number(one.requires_email_activation || 0), delivery_method: one.delivery_method || 'both', in_stock: realInStock(one, cm1), sold_count: soldCount } });
  }

  // ---- 公开：App 图标库（明/暗两版）----
  // 前端商品图片选择器与主题切换使用；公开只读，无敏感数据。
  if (path === '/api/app-icons' && method === 'GET') {
    try {
      var rows = await env.DB.prepare('SELECT app_key, theme, name, image_data FROM app_icons ORDER BY name ASC, theme ASC').all();
      var icons = {};
      (rows.results || []).forEach(function (r) {
        var k = String(r.app_key || '');
        if (!k) return;
        if (!icons[k]) icons[k] = { key: k, name: String(r.name || k), light: '', dark: '' };
        if (r.theme === 'light') icons[k].light = String(r.image_data || '');
        else if (r.theme === 'dark') icons[k].dark = String(r.image_data || '');
        if (r.name) icons[k].name = String(r.name);
      });
      return json({ ok: true, icons: icons });
    } catch (e) {
      // 表不存在（迁移前）时返回空库，前端回退默认图标，不 500。
      return json({ ok: true, icons: {} });
    }
  }

  // ---- 公开：图形验证码 ----
  // P3-14：GET /api/captcha 加 IP 限流（30 次/10 分钟，原子记数，复用 pay_rate 表 captcha: 维），防无限制生成验证码行。
  if (path === '/api/captcha' && method === 'GET') {
    try { await env.DB.prepare('DELETE FROM captcha_codes WHERE expires_at < ?').bind(nowISO()).run(); } catch (e) {}
    var capIp = getClientIp(req);
    var capWin = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    try { await env.DB.prepare('DELETE FROM pay_rate WHERE created_at < ?').bind(capWin).run(); } catch (e) {}
    var capIns = await env.DB.prepare('INSERT INTO pay_rate (key, created_at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM pay_rate WHERE key = ?) < 30').bind('captcha:' + capIp, nowISO(), 'captcha:' + capIp).run().catch(function () { return null; });
    if (!capIns || !capIns.meta || capIns.meta.changes !== 1) return err('验证码获取过于频繁，请 10 分钟后再试', 429);
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
    // P2-10：数量后端独立校验（不依赖前端）：缺失默认 1；显式值必须为整数且 1–99。
    // 布尔/对象/数组/非数值字符串一律拒绝；"3.0" 等整数值字符串接受。
    var qtyRaw = body.quantity;
    var qty;
    if (qtyRaw == null || qtyRaw === '') qty = 1;
    else if (typeof qtyRaw === 'boolean' || typeof qtyRaw === 'object') return err('数量无效（必须为 1–99 的整数）');
    else { qty = Number(qtyRaw); if (!Number.isInteger(qty) || qty < 1 || qty > 99) return err('数量无效（必须为 1–99 的整数）'); }
    var productId = Number(body.product_id || 0);
    if (!productId) return err('商品或数量无效');
    if (!validPayMethod(body.pay_method) || !validPayChain(body.pay_chain) || !validPayCombo(body.pay_method, body.pay_chain)) return err('支付方式或链无效（仅支持：欧易 USDT0 · X Layer、币安 USDT · BEP20）');
    // 预检（无副作用、纯校验）在验证码消费之前：商品存在 → 门禁 → 字段 → 邮箱 → 库存 → 收款地址 → 查询密码格式。
    var prodPre = await env.DB.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').bind(productId).first();
    if (!prodPre) return err('商品不存在', 404);
    // 预检（无副作用、纯校验）在验证码消费之前：商品存在 → 门禁 → 去重 → 字段 → 邮箱 → 库存 → 收款地址 → 查询密码格式 → 限流 → 验证码。
    // P3-5：去重/限流预检查与验证码消费在 INSERT 之前；去重在必填字段校验之前（重复提示优先，见下方）。
    var prod = prodPre;
    // ProdSeller 功能门禁（第四轮 P0）：上游真实行为（Idempotency-Key、状态枚举、402/409/429 语义、限速）尚未获得真实服务商证据，
    // 默认关闭。门禁关闭时，上游商品禁止下单，避免进入真实自动采购流程。解除门禁需在 RELEASE_READINESS 中提供证据并由管理员显式开启。
    var settingsEarly = await getAllSettings(env);
    if (prod.source === 'prodseller' && String(settingsEarly.prodseller_enabled || '0') !== '1') {
      return err('该商品暂未开放购买（上游服务验证中，请联系客服）', 403);
    }
    // P3-5：冲突预检查（同一联系方式去重）在验证码消费之前，且在必填字段校验之前——
    // 与旧行为一致：同时命中“重复下单”与“必填缺失”时，返回明确的重复下单提示（旧测试 P2-3 钉此文案）。
    // 去重在限流之前：被重复下单挡住的尝试不占限流名额，用户重试始终看到明确的重复提示。
    // 去重失败 / 限流命中时不消费验证码。
    var custEarly2 = body.customer_fields || {};
    if (typeof custEarly2 !== 'object') return err('客户字段无效');
    var contactIdentity = String(custEarly2.contact_email || body.contact || custEarly2.activation_email || '').trim().toLowerCase();
    if (contactIdentity) {
      var dupFound = false;
      try {
        var dupRow = await env.DB.prepare("SELECT id FROM orders WHERE status = 'pending_payment' AND expires_at > ? AND (LOWER(contact) = ? OR LOWER(json_extract(customer_fields, '$.contact_email')) = ? OR LOWER(json_extract(customer_fields, '$.activation_email')) = ?) LIMIT 1").bind(nowISO(), contactIdentity, contactIdentity, contactIdentity).first();
        dupFound = !!dupRow;
      } catch (e) {
        var pend = await env.DB.prepare("SELECT order_no, contact, customer_fields FROM orders WHERE status = 'pending_payment' AND expires_at > ?").bind(nowISO()).all();
        for (var di = 0; di < (pend.results || []).length; di++) {
          var po = pend.results[di]; var pcf = {}; try { pcf = JSON.parse(po.customer_fields || '{}'); } catch (e2) { pcf = {}; }
          var pIdent = String(pcf.contact_email || po.contact || '').trim().toLowerCase();
          if (pIdent && pIdent === contactIdentity) { dupFound = true; break; }
        }
      }
      if (dupFound) return err('该联系方式已有一笔待付款订单，请先完成付款或等它超时取消后再下单');
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
      // P2-10：两次输入必须一致——确认字段缺失也拒绝（无法验证一致性，不得放行）。
      if (!activationConfirm) return err('请再次输入激活邮箱确认（两次输入必须一致）');
      if (activationConfirm !== activationEmail) return err('两次激活邮箱不一致，请重新确认');
      // P2-10：勾选确认后端独立校验——activation_confirm 须为真（body 或 customer_fields；
      // 前端下单请求必须发送 activation_confirm:true，见前端契约）。显式 false/缺失一律拒绝。
      var actFlag = body.activation_confirm;
      if (actFlag === undefined) actFlag = cust.activation_confirm;
      if (!(actFlag === true || actFlag === 1 || actFlag === '1' || actFlag === 'true' || actFlag === 'TRUE')) return err('请勾选确认激活邮箱无误');
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
    wallet = addrMap[body.pay_method + '|' + body.pay_chain] || '';
    // 第九轮：所选方式没有有效收款地址时拒绝创建订单，不得生成无收款地址却显示下单成功的订单。
    // EVM 收款地址格式：0x + 40 位十六进制。历史订单不受影响（创建时不重校验旧订单）。
    wallet = String(wallet || '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return err('该支付方式暂未配置有效收款地址，请联系管理员配置后再下单');
    var orderNo = genOrderNo();
    // 查询密码（P0，必填）：买家下单时自设，6-64 位。存储 = 随机 16 字节 salt + PBKDF2(10万次) 哈希（与管理员密码同一方案），绝不存明文。
    // 无 salt 的 v14 遗留哈希按 legacy 处理（仅管理员流程）。新订单不再生成系统查单凭证（query_token_hash 写空）。
    var queryPasswordRaw = String(body.query_password || '').trim();
    if (!queryPasswordRaw) return err('请设置查询密码（查询卡密时需要输入，请牢记）');
    if (queryPasswordRaw.length < 6) return err('查询密码至少 6 位');
    if (queryPasswordRaw.length > 64) return err('查询密码过长（最多 64 字符）');
    // 同 IP 限流：10 分钟内最多下单 10 笔，防批量刷单（P3-5：原子 INSERT…SELECT…WHERE count < N）。
    var clientIp = getClientIp(req);
    var winStart = new Date(Date.now() - ORDER_RATE_WINDOW_MS).toISOString().replace('T', ' ').slice(0, 19);
    try { await env.DB.prepare('DELETE FROM order_rate WHERE created_at < ?').bind(winStart).run(); } catch (e) {}
    var oIns = await env.DB.prepare('INSERT INTO order_rate (ip, created_at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM order_rate WHERE ip = ?) < ?').bind(clientIp, nowISO(), clientIp, ORDER_RATE_LIMIT).run().catch(function () { return null; });
    if (!oIns || !oIns.meta || oIns.meta.changes !== 1) return err('下单过于频繁，请 10 分钟后再试');
    // 人机验证（最后消费）：Turnstile 开启时服务端校验 Turnstile token（fail-closed）；
    // 未开启时走 SVG 验证码（一次性、5 分钟过期、最多试 3 次）。密钥缺失时拒绝，绝不静默降级。
    var settingsForCaptcha = await getAllSettings(env);
    if (String(settingsForCaptcha.turnstile_enabled || '0') === '1') {
      var tsErr = await verifyTurnstile(env, body.turnstile_token, getClientIp(req));
      if (tsErr) return err(tsErr);
    } else {
      var capErrOrder = await verifyCaptcha(env, body.captcha_id, body.captcha_code);
      if (capErrOrder) return err(capErrOrder);
    }
    var queryPasswordSalt = bufToB64(crypto.getRandomValues(new Uint8Array(16)).buffer);
    var queryPasswordHash = await hashPassword(queryPasswordRaw, queryPasswordSalt);
    var effPrice = getEffectivePrice(prod);
    var total = Math.round(effPrice * qty * 100) / 100;
    var actualAmount = total;
    var expiresAt = fmtTsPlusMinutes(POLL_LOCK_MINUTES);
    actualAmount = await genActualAmount(env, total, wallet);
    var snapshot = JSON.stringify({ id: prod.id, slug: prod.slug, title: prod.title, category: prod.category, price_usdt: effPrice, source: prod.source || 'self', requires_email_activation: Number(prod.requires_email_activation || 0), delivery_method: prod.delivery_method || 'both' });
    // INSERT 原子重试（第四轮 P0）：SELECT 查重有 TOCTOU 窗口，真正的原子保障是 v8 唯一索引。
    // 金额冲突（pay_address + actual_amount）→ 重新生成金额并重试，最多 5 次；联系人冲突（contact + product_id）→ 返回明确重复提示。
    // 冲突时绝不静默复用冲突金额，也绝不把联系人冲突误判为金额冲突。
    var insertedOrderNo = null;
    for (var insAttempt = 0; insAttempt < 5; insAttempt++) {
      try {
        await env.DB.prepare('INSERT INTO orders (order_no, query_password, query_token_hash, query_password_hash, query_password_salt, product_id, product_snapshot, quantity, price_usdt, total_usdt, actual_amount, pay_address, expires_at, customer_fields, contact, pay_method, pay_chain, wallet_address, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(orderNo, '', '', queryPasswordHash, queryPasswordSalt, productId, snapshot, qty, effPrice, total, actualAmount, wallet, expiresAt, JSON.stringify(cust), contact, body.pay_method, body.pay_chain, wallet, 'pending_payment', nowISO()).run();
        insertedOrderNo = orderNo;
        break;
      } catch (e) {
        var emsg = String((e && e.message) || e || '');
        var isUnique = /UNIQUE constraint/i.test(emsg) || /unique/i.test(emsg);
        if (!isUnique) throw e;
        // 联系人冲突：contact + product_id 唯一索引（部分索引，列名含 contact）
        if (/contact/i.test(emsg)) return err('该联系方式已有一笔待付款订单，请先完成付款或等它超时取消后再下单');
        // 金额冲突：重新生成金额并重试
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
    return json({ ok: true, order: { order_no: orderNo, has_query_password: 1, total_usdt: total, actual_amount: actualAmount, pay_address: wallet, expires_at: expiresAt, wallet_address: wallet, pay_method: body.pay_method, pay_chain: body.pay_chain } });
  }

  // ---- 公开：查单 ----
  // 公开查单限流：同一 IP 每 10 分钟最多 30 次，防枚举与滥用。计数失败不阻塞查询（限流本身不可用时放行，但记录）。
  async function checkLookupRateLimit(env, req) {
    var ip = getClientIp(req);
    var winStart = new Date(Date.now() - LOOKUP_RATE_WINDOW_MS).toISOString().replace('T', ' ').slice(0, 19);
    try { await env.DB.prepare('DELETE FROM lookup_rate WHERE created_at < ?').bind(winStart).run(); } catch (e) {}
    // P3-5：原子记数（INSERT…SELECT…WHERE count < N，同 /secret 模式），消除先查后插的 TOCTOU 超限窗口。
    var ins = await env.DB.prepare('INSERT INTO lookup_rate (ip, created_at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM lookup_rate WHERE ip = ?) < ?').bind(ip, nowISO(), ip, LOOKUP_RATE_LIMIT).run().catch(function () { return null; });
    if (!ins || !ins.meta || ins.meta.changes !== 1) return '查单过于频繁，请 10 分钟后再试';
    return null;
  }
  // 旧 GET /api/orders 已停用（P1-6）：当前查单流程为“订单号或下单邮箱 + 图形验证码”走 POST /api/orders/lookup。
  // 邮箱 + 图形验证码 ≠ 邮箱所有权证明；查单只返回最小概要。无邮箱 OTP 兼容路径（邮件 OTP 未实现）。
  if (path === '/api/orders' && method === 'GET') {
    return err('旧接口停用，请用订单号或下单邮箱+验证码走当前查单流程', 410);
  }
  // GET 单订单：仅返回概要（不含交付内容与客户隐私），绝不经 URL 凭证返回敏感数据。
  // 完整详情必须走 POST /api/orders/:no/lookup（凭证在请求体中，不进 URL/日志）。
  var mOrderNo = path.match(/^\/api\/orders\/([^\/]+)$/);
  if (mOrderNo && method === 'GET') {
    // P2-4：单订单 GET 同样加查单限流（与 /query 一致），防订单号枚举。
    var rateErrSingle = await checkLookupRateLimit(env, req);
    if (rateErrSingle) return err(rateErrSingle, 429);
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
    // P3-18：/lookup 错误文案统一为“查单凭证错误”，不区分新旧订单（新订单仍须走 /secret + 查询密码）。
    if (ordL.query_password_salt && ordL.query_password_hash) return err('查单凭证错误', 401);
    // 旧订单（有系统凭证哈希）：验证凭证哈希，验证通过返回完整详情。
    if (ordL.query_token_hash) {
      if (!timingSafeEqual(await sha256Hex(cred), ordL.query_token_hash)) return err('查单凭证错误', 401);
      return json({ ok: true, order: sanitizeOrderForPublic(ordL, 'full') });
    }
    // 旧订单（无凭证哈希）：用旧查询密码验证，但只返回概要，不返回交付内容与客户隐私（需交付内容请联系客服）。
    // P2-2：明文验证成功后立即迁移为 salt+PBKDF2 哈希并清空明文 query_password 列（不做全量批量迁移）。
    if (cred && ordL.query_password && timingSafeEqual(cred, ordL.query_password)) {
      try {
        var migSalt = bufToB64(crypto.getRandomValues(new Uint8Array(16)).buffer);
        var migHash = await hashPassword(cred, migSalt);
        await env.DB.prepare('UPDATE orders SET query_password_hash = ?, query_password_salt = ?, query_password = ? WHERE order_no = ?').bind(migHash, migSalt, '', noL).run();
      } catch (e) {}
      return json({ ok: true, order: sanitizeOrderForPublic(ordL, 'summary'), legacy: true });
    }
    return err('查单凭证错误', 401);
  }
  // POST 查单列表：接受订单号，或联系方式（邮箱/订单号双查）。
  // P3-4：匹配订单号 OR LOWER(contact) OR LOWER(customer_fields.contact_email)，精确大小写不敏感，
  // 不部分匹配。activation_email 不作为查询键（它是待开通账号，不是联系身份；下单时若未填
  // contact_email 会回填为 activation_email，故覆盖）。JSON 字段空/NULL/无效 JSON 不报错
  //（json_extract 对无效 JSON 返回 NULL；异常时回退到 contact 列 + JS 解析）。
  // 列表仅含订单概要（无 delivery_content、无 has_delivery），卡密必须按单走 /secret 验密码。
  if (path === '/api/orders/query' && method === 'POST') {
    var qb = await parseJsonBody(req);
    var keywords = String(qb.keywords || '').trim();
    if (!keywords) return err('请输入订单号再查询');
    if (keywords.length > 200) return err('查询关键词过长');
    // P3-5：限流预检查在验证码消费之前——限流命中时不消费验证码。
    var rateErrQ = await checkLookupRateLimit(env, req);
    if (rateErrQ) return err(rateErrQ, 429);
    var capErrQ = await verifyCaptcha(env, qb.captcha_id, qb.captcha_code);
    if (capErrQ) return err(capErrQ, 401);
    var qRows;
    if (keywords.indexOf('@') !== -1) {
      // 含 @ 按联系方式精确匹配（大小写不敏感，不部分匹配）。
      var emailKey = keywords.toLowerCase();
      try {
        qRows = await env.DB.prepare('SELECT * FROM orders WHERE (LOWER(contact) = ? OR LOWER(json_extract(customer_fields, \'$.contact_email\')) = ?) ORDER BY created_at DESC LIMIT 10').bind(emailKey, emailKey).all();
      } catch (e) {
        // json_extract 不可用时回退：按 contact 列查 + JS 解析 customer_fields 补 contact_email。
        var fbRows = await env.DB.prepare('SELECT * FROM orders WHERE LOWER(contact) = ? ORDER BY created_at DESC LIMIT 10').bind(emailKey).all();
        var fbList = fbRows.results || [];
        var extra = await env.DB.prepare('SELECT * FROM orders WHERE contact IS NULL OR contact = \'\' ORDER BY created_at DESC LIMIT 200').all();
        (extra.results || []).forEach(function (x) {
          var cf0 = {}; try { cf0 = JSON.parse(x.customer_fields || '{}'); } catch (ee) { cf0 = {}; }
          if (String(cf0.contact_email || '').toLowerCase() === emailKey) fbList.push(x);
        });
        qRows = { results: fbList.slice(0, 10) };
      }
    } else {
      qRows = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ? ORDER BY created_at DESC LIMIT 10').bind(keywords).all();
    }
    var qList = (qRows.results || []).map(function (o) {
      var snap = {}; try { snap = JSON.parse(o.product_snapshot || '{}'); } catch (e) { snap = {}; }
      // 凭证类型：password=新订单（salted 查询密码）/ token=旧订单系统凭证 / legacy=无有效凭证（仅管理员流程）
      var credType = 'legacy';
      if (o.query_password_salt && o.query_password_hash) credType = 'password';
      else if (o.query_token_hash) credType = 'token';
      var item = { order_no: o.order_no, status: o.status, product_title: snap.title || '', quantity: o.quantity, total_usdt: o.total_usdt, actual_amount: o.actual_amount, pay_method: o.pay_method, pay_chain: o.pay_chain, created_at: o.created_at, paid_at: o.paid_at, expires_at: o.expires_at, credential_type: credType };
      // P1-13：pending_payment 订单附带 pay_address（商家公开收款地址，非买家隐私），成功页刷新后仍能恢复付款信息。
      if (o.status === 'pending_payment') item.pay_address = o.pay_address || '';
      return item;
    });
    return json({ ok: true, orders: qList, total: qList.length });
  }
  // POST 按单取卡密（P0）：唯一公开的卡密读取路径。查询密码必填（6-64 位），用 salt + PBKDF2 校验。
  // 限流覆盖全部执行路径：IP 级 + 按单原子记数（单条 SQL 记数，防并发绕过）。空密码、缺失凭证、legacy 订单、认证成功均记数。
  // 错误消息统一为通用文案，不泄露密码是否正确、订单是否有卡密。
  var mSecret = path.match(/^\/api\/orders\/([^\/]+)\/secret$/);
  if (mSecret && method === 'POST') {
    var sb = await parseJsonBody(req);
    var noS = decodeURIComponent(mSecret[1]);
    var ordS = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(noS).first();
    if (!ordS) return err('订单不存在', 404);
    // IP 级限流（防枚举/爆破）
    var rateErrS = await checkLookupRateLimit(env, req);
    if (rateErrS) return err(rateErrS, 429);
    // 按单原子记数：INSERT ... WHERE count < 5 单条语句执行，D1 串行化保证并发不绕过。changes=0 即已达上限。
    var ipS = (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    var winStartS = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    try { await env.DB.prepare('DELETE FROM secret_attempts WHERE created_at < ?').bind(winStartS).run(); } catch (e) {}
    var insS = await env.DB.prepare('INSERT INTO secret_attempts (order_no, ip, created_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM secret_attempts WHERE order_no = ?) < 5').bind(noS, ipS, nowISO(), noS).run().catch(function () { return null; });
    if (!insS || !insS.meta || insS.meta.changes === 0) return err('该订单密码尝试次数过多，请 10 分钟后再试', 429);
    // 密码必填：空/缺失一律拒绝（不区分 legacy/未付款，避免信息泄露）。
    var pw = String(sb.password || '').trim();
    if (!pw) return err('请输入查询密码', 401);
    // 旧订单（系统凭证）：不走此口，请用老 /lookup。
    if (ordS.query_token_hash) return err('旧订单请使用订单号 + 查单凭证在原查询方式查询', 410);
    // legacy（无 salted 密码）：仅管理员流程，绝不匿名返回卡密。
    if (!ordS.query_password_salt || !ordS.query_password_hash) return err('该订单未设置查询密码，请联系客服处理', 403);
    // PBKDF2 校验（与管理员密码同一方案，恒定时间比较）。错误 → 通用 401，不区分密码错/订单状态。
    var calcHash = '';
    try { calcHash = await hashPassword(pw, ordS.query_password_salt); } catch (e) { calcHash = ''; }
    if (!calcHash || !timingSafeEqual(calcHash, ordS.query_password_hash)) return err('查询密码错误', 401);
    // P1-9：/secret 返回前校验 7 天过期（与 sanitizeOrderForPublic 同口径），过期则拒绝，不返回已过期应清空的卡密。
    if (ordS.data_expired === 1 || isExpired7d(ordS.fulfilled_at)) return err('交付内容已过期（仅保留 7 天）', 410);
    // 认证通过后才返回状态相关信息：未付款/无交付 → 明确提示（已认证用户可看状态）。
    if (ordS.status !== 'completed' && !ordS.delivery_content) return err('订单尚未付款或暂无交付内容');
    return json({ ok: true, order_no: ordS.order_no, delivery_content: ordS.delivery_content || '' });
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
    // 白名单封堵：仅首期两种组合可提交 TXID 核验；旧 TRC20/ERC20/站内转账订单请联系客服人工处理。
    if (!validPayCombo(o2.pay_method, o2.pay_chain)) return err('该订单的支付方式不在首期支持范围内，请联系客服处理');
    // P3-5：验证码不在限流/去重拒绝前消费。顺序：格式检查 → 限流预检查 → 冲突预检查
    //（TXID 已被他单认领/人工确认时直接 409，不消费验证码）→ 真正执行敏感操作前原子消费验证码
    //（verifyCaptcha 成功路径单条 DELETE 认领，防两并发共用）→ 链上核验。
    // /pay 独立限流（第四轮 P0）：同一订单 10 分钟最多 5 次，同一 IP 10 分钟最多 20 次。
    // 受限不影响后台轮询继续核验已到账的付款，订单不会因限流永久无法处理。
    var payRateErr = await checkPayRateLimit(env, req, no2);
    if (payRateErr) return err(payRateErr, 429);
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(txid)) {
      var payConsumed = await txHashConsumedByOther(env, txid, o2.id);
      if (payConsumed) return err(payConsumed, 409);
    }
    // P3-4：/pay 增加验证码校验（字段名与下单一致：captcha_id / captcha_code；Turnstile 开启时走 Turnstile），
    // 防知订单号者耗尽该订单的 /pay 配额。注意：验证码一次性，提交前需先取新验证码。
    var settingsPay = await getAllSettings(env);
    if (String(settingsPay.turnstile_enabled || '0') === '1') {
      var tsErrPay = await verifyTurnstile(env, b.turnstile_token, getClientIp(req));
      if (tsErrPay) return err(tsErrPay);
    } else {
      var capErrPay = await verifyCaptcha(env, b.captcha_id, b.captcha_code);
      if (capErrPay) return err(capErrPay);
    }
    // P3-3：核验失败不建账本行。账本行只在核验通过后建（verified），失败仅把 TXID 存订单（且仅当 txid 为空时）。

    // 链上：可选兜底，按需核验同一 TXID，成功即自动发货（链上核验通过 = 链上证明）。
    // TXID 认领严格先到先得：若该 TXID 已被其他订单认领，返回明确错误，不静默接受为“已提交”（否则客户误以为付款成功，实际订单永远无法认领）。
    var hit = null;
    try { hit = await checkTxidPayment(env, fetch, o2, txid); } catch (e) { hit = null; }
    if (hit && hit.txHash) {
      // 核验通过：建账本行（verified，event_key 未知为空，扫描时回填；确认数由 checkTxidPayment 按该链确认策略保证，与 runPolling 一致）。
      var payRec = null;
      try { var pr = await recordPayment(env, { order_id: o2.id, chain: o2.pay_chain, pay_address: o2.pay_address || o2.wallet_address, tx_hash: hit.txHash, event_key: '', amount: o2.actual_amount || o2.total_usdt, status: 'verified', reconcile_note: '用户经 /pay 提交并核验通过' }); payRec = pr.payment || null; } catch (e) { payRec = null; }
      var fr = await fulfillOrderByPayment(env, o2, hit.txHash, ctx, { txVerified: true });
      if (fr.ok && (fr.mode === 'completed' || fr.mode === 'pending_fulfill' || fr.mode === 'out_of_stock')) {
        // 认领胜者归属修正：recordPayment 在认领前写入，两个并发 /pay 争抢同一 TXID 时共享同一事件行
        // （先记录者是失败方时行归属失败方）。入账时把 order_id 修正为认领胜者（本订单），否则账本会显示
        // “失败订单已入账、胜者订单无入账”的错误对账状态。pay_address 保持首次记录值（既有行为，本轮不改）。
        if (payRec) { try { await updatePayment(env, payRec.id, { status: 'posted', order_id: o2.id }); } catch (e) {} }
      }
      if (fr.ok && fr.mode === 'completed') return json({ ok: true, message: '核验通过，已自动发货', auto: true });
      if (fr.ok && fr.mode === 'pending_fulfill') return json({ ok: true, message: '核验通过，已自动派单，等待人工代充', auto: true });
      if (fr.ok && fr.mode === 'out_of_stock') return json({ ok: true, message: '核验通过但库存不足，已转人工处理', auto: true });
      if (fr.reason && /已用于其他订单/.test(fr.reason)) {
        // 账本：该 TXID 已归属其他订单，标记 duplicate（需人工对账，不得静默接受）。
        try { var prDup = await recordPayment(env, { order_id: o2.id, chain: o2.pay_chain, pay_address: o2.pay_address || o2.wallet_address, tx_hash: hit.txHash, event_key: '', amount: o2.actual_amount || o2.total_usdt, status: 'duplicate', reconcile_status: 'pending', reconcile_note: 'TXID 已用于其他订单' }); } catch (e) {}
        return err('该交易哈希已用于其他订单，请勿重复提交；如确认归属有误请联系客服', 409);
      }
    }
    // P3-3 + P3-21：仅当 txid 为空时写入，且加 status='pending_payment' 状态守卫，不覆盖已提交的真实 TXID。
    await env.DB.prepare("UPDATE orders SET txid = ? WHERE order_no = ? AND status='pending_payment' AND (txid IS NULL OR txid='')").bind(txid, no2).run();
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
      if (!timingSafeEqual(pw, 'admin')) { await recordLoginFail(env, loginIp); await recordLoginFailGlobal(env); return err('密码错误', 401); }
      mustChange = true;
    } else {
      var h = await hashPassword(pw, storedSalt || '');
      if (!timingSafeEqual(h, storedHash)) { await recordLoginFail(env, loginIp); await recordLoginFailGlobal(env); return err('密码错误', 401); }
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
    // P3-11：logout 加 CSRF 校验（与通用管理端写操作同一扇门），防跨站请求登出管理员。
    var csrfErrLogout = checkCsrf(req, url);
    if (csrfErrLogout) return err(csrfErrLogout, 403);
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
    // P3-12：改密校验新密码 ≠ 旧密码。
    if (newPw === oldPw) return err('新密码不能与旧密码相同');
    var sh = await getAdminMeta(env, 'password_hash');
    var ss = await getAdminMeta(env, 'password_salt');
    if (sh) {
      var hh = await hashPassword(oldPw, ss || '');
      if (!timingSafeEqual(hh, sh)) return err('旧密码错误', 401);
    } else if (!timingSafeEqual(oldPw, 'admin')) return err('旧密码错误', 401);
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
    if (q) { sql += ' AND (instr(order_no, ?) > 0 OR instr(contact, ?) > 0 OR instr(txid, ?) > 0)'; countSql += ' AND (instr(order_no, ?) > 0 OR instr(contact, ?) > 0 OR instr(txid, ?) > 0)'; binds.push(q, q, q); }
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
    // 管理端列表仅返回概要（不含 delivery_content/联系方式/客户字段），防批量卡密暴露；详情走单订单接口。
    var list = (orr.results || []).map(function (x) { return sanitizeOrderForPublic(x, 'summary'); });
    return json({ ok: true, orders: list, total: total, page: page, page_size: pageSize, total_pages: Math.max(1, Math.ceil(total / pageSize)) });
  }
  var mAdminOrder = path.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (mAdminOrder && method === 'GET') {
    var oneOrd = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(Number(mAdminOrder[1])).first();
    if (!oneOrd) return err('订单不存在', 404);
    return json({ ok: true, order: sanitizeOrderForPublic(oneOrd, 'admin') });
  }
  var mConfirm = path.match(/^\/api\/admin\/orders\/(\d+)\/confirm-payment$/);
  if (mConfirm && method === 'POST') {
    var oid = Number(mConfirm[1]);
    var oo = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(oid).first();
    if (!oo) return err('订单不存在', 404);
    if (oo.status !== 'pending_payment') return err('当前状态不可确认收款');
    // P1-2：独立人工确认通道（与链上自动认领明确区分）。
    // 要求：人工原因（必填）+ 额外确认标志（manual_confirm=true，由前端确认弹窗发送；
    // 若客户端显式传 manual_confirm=false 则拒绝）。fulfillAfterPayment 走 manualConfirm 分支：
    // 写 txid_claims 全局认领（source=manual_confirmed，与链上共享同一全局原子认领），订单标记为人工确认态（审计 action=manual_confirm_payment +
    // admin_note【人工确认收款】前缀 + payments manual_confirmed 行），绝不伪装成正常链上已付。
    // 无链上证据时保留待核查态：人工确认仅表示管理员已在系统外核对到账，不代表链上核验通过。
    var cbConfirm = await parseJsonBody(req);
    var confirmReason = String(cbConfirm.reason || cbConfirm.admin_note || '').trim();
    if (!confirmReason) return err('请填写人工确认原因（必填，记入审计）', 400);
    if (cbConfirm.manual_confirm !== undefined && cbConfirm.manual_confirm !== true) return err('人工确认需显式确认 manual_confirm', 400);
    var cr2 = await fulfillAfterPayment(env, oo, oo.tx_hash || oo.txid || '', ctx, { txVerified: false, manualConfirm: true, manualReason: confirmReason, manualConfirmedFlag: true });
    if (!cr2.ok) return err(cr2.reason || '发货失败');
    // 人工确认态标记：追加【人工确认收款】前缀到 admin_note（后续分支的 admin_note 写入已完成，
    // 此处追加不会被覆盖；NOT LIKE 守卫防重复追加）。
    try { await env.DB.prepare("UPDATE orders SET admin_note = '【人工确认收款】原因：' || ? || '；' || COALESCE(admin_note, '') WHERE id = ? AND admin_note NOT LIKE '%【人工确认收款】%'").bind(confirmReason.slice(0, 200), oid).run(); } catch (e) {}
    var afterSt = (await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(oid).first() || {}).status || oo.status;
    var auditOkC = await logAudit(env, oid, 'manual_confirm_payment', 'pending_payment', afterSt, '管理员人工确认收款（人工确认态，非链上自动核验），原因：' + confirmReason);
    // P3-20：审计失败不返回 500（副作用已提交）：记录日志 + 返回成功并附带 audit_failed 警告。
    var auditExtraC = {};
    if (!auditOkC) { console.error('audit failed: manual_confirm_payment order=' + oid); auditExtraC = { audit_failed: true, warning: auditFailMsg(oid, 'manual_confirm_payment') }; }
    if (cr2.mode === 'completed') return json(Object.assign({ ok: true, message: '已人工确认收款并自动发货（人工确认态，非链上自动核验）' }, auditExtraC));
    if (cr2.mode === 'pending_activation') return json(Object.assign({ ok: true, message: '已人工确认收款，上游激活待处理（pending_activation），轮询等待 delivered' }, auditExtraC));
    if (cr2.mode === 'pending_upstream') return json(Object.assign({ ok: true, message: '已人工确认收款，上游暂不可发货（' + (cr2.reason || '') + '），已转 pending_upstream' }, auditExtraC));
    if (cr2.mode === 'out_of_stock') return json(Object.assign({ ok: true, message: '已人工确认收款但库存不足，已转人工处理' }, auditExtraC));
    if (cr2.mode === 'refund_pending') return json(Object.assign({ ok: true, message: '已人工确认收款，但上游订单终态失败，已转异常待退款处理' }, auditExtraC));
    return json(Object.assign({ ok: true, message: '已人工确认收款，等待发货' }, auditExtraC));
  }
  var mFulfill = path.match(/^\/api\/admin\/orders\/(\d+)\/fulfill$/);
  if (mFulfill && method === 'POST') {
    var fb = await parseJsonBody(req);
    var fid = Number(mFulfill[1]);
    var fo = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(fid).first();
    if (!fo) return err('订单不存在', 404);
    // 状态机：待付款订单不能直接发货（必须先确认收款）；已完成/已取消为终态，不可发货。
    if (fo.status === 'pending_payment') return err('待付款订单不能直接发货，请先确认收款');
    if (fo.status === 'completed' || fo.status === 'cancelled') return err('当前状态不可发货');
    // P1-12：refund_pending 禁直接手动发货（会清空退款标记、抹掉待退款义务）。如确认无需退款，
    // 须先走单独的“撤销退款义务”动作（写明退款未执行 + 审计），再发货；本接口不提供该兜底。
    if (fo.status === 'refund_pending') return err('退款待处理（refund_pending）订单不可直接手动发货：该订单已有待退款义务，直接发货会清空退款标记。如确认无需退款，请先单独撤销退款义务（写明退款未执行 + 审计）后再发货。', 409);
    // P1-5：上游订单作废确认旗标。pending_activation/pending_upstream 且有上游单号时，必须由管理员先在
    // 上游后台作废该上游订单，并在请求体中确认 upstream_voided === true（前端配合加复选框），否则 409；
    // 无上游单号时不要求旗标。本系统不调用上游取消接口，只做确认旗标路径。
    var foUp = await getLatestUpstream(env, fid);
    var foPsId = foUp ? (foUp.prodseller_order_id || '') : '';
    if ((fo.status === 'pending_activation' || fo.status === 'pending_upstream') && foPsId && fb.upstream_voided !== true) return err('请先在上游后台作废该上游订单，并确认 upstream_voided（上游单号：' + foPsId + '）', 409);
    // P1-7：手动发货认领租约（条件 UPDATE，复用 upstream_lock，5 分钟过期）。并发手动发货/轮询处理同一订单时
    // 只有一个能持有租约；租约过期后可接管。完成 UPDATE 同样带租约条件，失败时释放租约。
    var fulfillLease = randomHex(16);
    var fulfillLeaseExp = new Date(Date.now() + 5 * 60000).toISOString().replace('T', ' ').slice(0, 19);
    var leaseF = await env.DB.prepare("UPDATE orders SET upstream_lock=?, upstream_lock_expires_at=? WHERE id=? AND status IN ('pending_fulfill','pending_activation','pending_upstream') AND (upstream_lock IS NULL OR upstream_lock='' OR upstream_lock_expires_at IS NULL OR upstream_lock_expires_at < datetime('now'))").bind(fulfillLease, fulfillLeaseExp, fid).run();
    if (!leaseF.meta || leaseF.meta.changes !== 1) return err('当前状态不可发货（可能已被其他操作处理或正在被轮询处理，请稍后再试）');
    var releaseFulfillLease = async function () { try { await env.DB.prepare('UPDATE orders SET upstream_lock=?, upstream_lock_expires_at=NULL WHERE id=? AND upstream_lock=?').bind('', fid, fulfillLease).run(); } catch (e) {} };
    var fp = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(fo.product_id).first();
    var delivery = String(fb.delivery_content || '').trim();
    var autoAssigned = null; // 自动发卡时记录本轮新标记的卡，供完成失败时补偿
    if (fp && fp.stock_type === 'card' && !delivery) {
      // 自动发卡：两阶段领取（可恢复）→ 条件完成。领取失败返回错误，不吃卡。
      var ccF = await claimCardsForOrder(env, fid, fo.product_id, fo.quantity);
      if (!ccF.ok) { await releaseFulfillLease(); return err(ccF.reason === 'out_of_stock' ? '卡密库存不足，请先导入卡密或手动填写交付内容' : ('卡密领取失败：' + ccF.reason)); }
      delivery = ccF.codes.join('\n');
      autoAssigned = ccF.newlyMarkedIds;
    }
    if (!delivery) { await releaseFulfillLease(); return err('请填写交付内容'); }
    var fulfillNote = String(fb.admin_note || '').trim();
    var upF = await env.DB.prepare("UPDATE orders SET status='completed', delivery_content=?, admin_note=?, paid_at=COALESCE(paid_at, ?), fulfilled_at=?, refund_status='', exception_reason='', claim_token='', upstream_lock='', upstream_lock_expires_at=NULL WHERE id=? AND status IN ('pending_fulfill','pending_activation','pending_upstream') AND upstream_lock=?").bind(delivery, fulfillNote, nowISO(), nowISO(), fid, fulfillLease).run();
    if (!upF.meta || upF.meta.changes === 0) {
      // 完成失败（并发下已被其他操作处理）：补偿本轮自动标记的卡（unmarkCards 有 completed 保护，已完成时不还卡）
      if (autoAssigned && autoAssigned.length) await unmarkCards(env, fid, autoAssigned);
      await releaseFulfillLease();
      return err('当前状态不可发货（可能已被其他操作处理）');
    }
    // P1-6：delivery 非空时检查本订单名下 is_used=1 的残留卡，未随本次交付发出的释放回可用池并记入审计。
    var residual = await releaseResidualMarkedCards(env, fid, delivery);
    // 人工填写交付内容完成：释放该订单尚未使用的预留卡（必须在完成状态转换成功后释放，不提前、不释放他人卡）。
    // 自动发卡时预留卡已转为已用，releaseReservation 只释放 is_used=0 的预留卡，不会误释放已用卡。
    await releaseReservation(env, fid);
    var auditOkF = await logAudit(env, fid, 'fulfill', fo.status, 'completed', '管理员手动发货' + (fulfillNote ? '，备注：' + fulfillNote : '') + (foPsId && (fo.status === 'pending_activation' || fo.status === 'pending_upstream') ? '，上游单号：' + foPsId + '（已确认上游作废 upstream_voided）' : (foPsId ? '，上游单号：' + foPsId : '')) + (residual.released ? '，释放残留已标记卡 ' + residual.released + ' 张（未随本次交付发出）' : ''));
    // P3-20：审计失败不返回 500：记录日志 + 返回成功并附带 audit_failed 警告。
    if (!auditOkF) { console.error('audit failed: fulfill order=' + fid); return json({ ok: true, audit_failed: true, warning: auditFailMsg(fid, 'fulfill') }); }
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
    // pending_payment 的保护以“已消费付款事实”（txid_claims 认领 / payments 已入账行）为准，见下方 orderHasConsumedPayment 预检：
    // paid_at 只是租约时间戳，无认领、无账本且租约已过期时（P1-3 陈旧认领）仍可取消，避免崩溃订单永久钉死。
    if (co.status !== 'pending_payment') {
      return err('已付款订单不能通过普通取消接口取消（当前状态：' + co.status + '）。如无法交付请走异常处理（标记退款待处理），本系统不执行真实退款，须在系统外退款后点“确认已退款”。', 409);
    }
    var leaseExpired = !!co.claimed_at && (new Date(String(co.claimed_at).replace(' ', 'T') + 'Z').getTime() < Date.now() - CLAIM_LEASE_MINUTES * 60000);
    if (co.paid_at && !leaseExpired) {
      return err('该订单已确认付款（处理中），不能普通取消。如无法交付请走异常处理流程。', 409);
    }
    // 本轮资金安全：已有已消费 TXID 认领或已入账付款记录的订单，普通取消一律拒绝（即使租约已过期），
    // 必须走异常/退款流程；取消绝不删除认领或账本。预检 + 下方 UPDATE 内 NOT EXISTS 双重守卫，防预检与取消之间的认领竞态。
    if (await orderHasConsumedPayment(env, cid)) {
      return err('该订单已有已消费 TXID 认领或已入账付款记录，不能普通取消；请走异常处理（标记退款待处理），本系统不执行真实退款，须在系统外退款后点“确认已退款”。', 409);
    }
    var cancelReason = String(cb2.reason || cb2.admin_note || '').trim();
    // 条件取消：未付款未认领的待付款订单，或租约过期的陈旧认领。并发下付款认领与取消只允许一个成功。
    var upC = await env.DB.prepare("UPDATE orders SET status='cancelled', admin_note=? WHERE id=? AND status='pending_payment' AND NOT EXISTS (SELECT 1 FROM txid_claims WHERE order_id = orders.id) AND NOT EXISTS (SELECT 1 FROM payments WHERE order_id = orders.id AND status IN ('verified', 'confirmed', 'posted', 'manual_confirmed')) AND (((paid_at IS NULL) AND (claim_token IS NULL OR claim_token='')) OR (claimed_at IS NOT NULL AND claimed_at < datetime('now', '-" + CLAIM_LEASE_MINUTES + " minutes')))").bind(cancelReason, cid).run();
    if (!upC.meta || upC.meta.changes === 0) return err('当前状态不可取消（可能已被其他操作处理或已确认付款）');
    // 取消时释放本订单的卡密预留（仅 is_used=0 的预留卡）与陈旧认领已标记未交付的卡。
    await releaseReservation(env, cid);
    await releaseClaimedButUndeliveredCards(env, cid);
    var auditOkX = await logAudit(env, cid, 'cancel', co.status, 'cancelled', '管理员取消订单' + (cancelReason ? '，原因：' + cancelReason : ''));
    // P3-20：审计失败不返回 500：记录日志 + 返回成功并附带 audit_failed 警告。
    if (!auditOkX) { console.error('audit failed: cancel order=' + cid); return json({ ok: true, audit_failed: true, warning: auditFailMsg(cid, 'cancel') }); }
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
    // P1-5：exception 时把上游单号记入 admin_note + 审计（本系统不调用上游取消接口，如需取消请到上游后台作废）。
    var exUp = await getLatestUpstream(env, eid);
    var exPsId = exUp ? (exUp.prodseller_order_id || '') : '';
    var exUpNote = exPsId ? ('上游单号：' + exPsId + '（如需取消请到上游后台作废）') : '';
    var exAdminNote = (exNote ? exNote + '；' : '') + exUpNote;
    if (refundNeeded) {
      // 退款仅针对已付款订单：未付款（pending_payment / paid_at 为空）的订单没有收到钱，无需退款，应直接取消，不得制造幽灵退款义务。
      if (eo.status === 'pending_payment' || !eo.paid_at) return err('未付款订单无需退款，请直接取消订单');
      var upE = await env.DB.prepare("UPDATE orders SET status='refund_pending', refund_status='pending', exception_reason=?, admin_note=? WHERE id=? AND status IN ('pending_fulfill','pending_activation','pending_upstream') AND paid_at IS NOT NULL").bind(exReason, exAdminNote, eid).run();
      if (!upE.meta || upE.meta.changes === 0) return err('当前状态不可标记异常（可能已被处理）');
      var auditOkE = await logAudit(env, eid, 'order_exception', eo.status, 'refund_pending', '异常处理：标记退款待处理，原因：' + exReason + (exNote ? '，备注：' + exNote : '') + (exUpNote ? '，' + exUpNote : ''));
      if (!auditOkE) { console.error('audit failed: order_exception order=' + eid); return json({ ok: true, message: '已标记为退款待处理。注意：本系统不执行真实退款，请在系统外完成退款后点“确认已退款”。', audit_failed: true, warning: auditFailMsg(eid, 'order_exception') }); }
      return json({ ok: true, message: '已标记为退款待处理。注意：本系统不执行真实退款，请在系统外完成退款后点“确认已退款”。' });
    }
    // 不需要退款：仅记录异常原因与审计，状态不变（后续可重试 / 手动发货）。
    // P3-7：UPDATE 加状态守卫（不覆盖已完成订单的 admin_note）并检查 changes。
    var upEN = await env.DB.prepare("UPDATE orders SET exception_reason=?, admin_note=? WHERE id=? AND status != 'completed'").bind(exReason, exAdminNote, eid).run();
    if (!upEN.meta || upEN.meta.changes === 0) return err('当前状态不可标记异常（可能已被处理）');
    var auditOkE2 = await logAudit(env, eid, 'order_exception_note', eo.status, eo.status, '异常记录（不退款）：' + exReason + (exNote ? '，备注：' + exNote : '') + (exUpNote ? '，' + exUpNote : ''));
    if (!auditOkE2) { console.error('audit failed: order_exception_note order=' + eid); return json({ ok: true, message: '异常原因已记录，订单状态未变。', audit_failed: true, warning: auditFailMsg(eid, 'order_exception_note') }); }
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
    // P1-5：有上游单号时，确认退款前要求管理员先在上游后台作废该上游订单并确认 upstream_voided === true，
    // 防退款后上游仍交付造成“退款 + 收货”双重得利；无上游单号时不要求旗标。本系统不调用上游取消接口。
    var rfUp = await getLatestUpstream(env, rid);
    var rfPsId = rfUp ? (rfUp.prodseller_order_id || '') : '';
    if (rfPsId && rb.upstream_voided !== true) return err('请先在上游后台作废该上游订单，并确认 upstream_voided（上游单号：' + rfPsId + '）', 409);
    var refundNote = String(rb.note || rb.admin_note || '').trim();
    var upR = await env.DB.prepare("UPDATE orders SET status='cancelled', refund_status='refunded', refund_ref=?, admin_note=? WHERE id=? AND status='refund_pending'").bind(refundRef, refundNote, rid).run();
    if (!upR.meta || upR.meta.changes === 0) return err('当前状态不可确认退款（可能已被处理）');
    await releaseReservation(env, rid);
    await releaseClaimedButUndeliveredCards(env, rid);
    var auditOkR = await logAudit(env, rid, 'refund_confirm', 'refund_pending', 'cancelled', '管理员确认已在系统外完成退款，退款凭证：' + refundRef + (refundNote ? '，备注：' + refundNote : '') + (rfPsId ? '，上游单号：' + rfPsId + '（已确认上游作废 upstream_voided）' : ''));
    if (!auditOkR) { console.error('audit failed: refund_confirm order=' + rid); return json({ ok: true, message: '已确认退款，订单已取消。', audit_failed: true, warning: auditFailMsg(rid, 'refund_confirm') }); }
    return json({ ok: true, message: '已确认退款，订单已取消。' });
  }

  // 管理端：重置某订单的查询密码（买家忘密码时客服可用；管理员提供新密码，服务端 salt+PBKDF2 存储，记审计）。
  // 管理员本身已可查看交付内容，重置不产生额外权限。响应不返回新密码（管理员已知自己设的值）。
  var mResetQP = path.match(/^\/api\/admin\/orders\/(\d+)\/reset-query-password$/);
  if (mResetQP && method === 'POST') {
    var rq = await parseJsonBody(req);
    var newPw = String(rq.new_password || '').trim();
    if (!newPw) return err('请提供新查询密码');
    if (newPw.length < 6) return err('查询密码至少 6 位');
    if (newPw.length > 64) return err('查询密码过长（最多 64 字符）');
    var rqId = Number(mResetQP[1]);
    var rqO = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(rqId).first();
    if (!rqO) return err('订单不存在', 404);
    var newSalt = bufToB64(crypto.getRandomValues(new Uint8Array(16)).buffer);
    var newHash = await hashPassword(newPw, newSalt);
    // P3-6：同步清空遗留明文 query_password 列，并检查 logAudit 返回值。
    await env.DB.prepare('UPDATE orders SET query_password_hash = ?, query_password_salt = ?, query_password = ? WHERE id = ?').bind(newHash, newSalt, '', rqId).run();
    var auditOkRQ = await logAudit(env, rqId, 'reset_query_password', rqO.status, rqO.status, '管理员重置了该订单的查询密码');
    if (!auditOkRQ) { console.error('audit failed: reset_query_password order=' + rqId); return json({ ok: true, message: '查询密码已重置，请将新密码告知买家', audit_failed: true, warning: auditFailMsg(rqId, 'reset_query_password') }); }
    return json({ ok: true, message: '查询密码已重置，请将新密码告知买家' });
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
    // App 图标与上传图片互斥：选了 App 图标则上传图清空；App 图标 key 只允许小写字母数字（前端选择器只提供合法 key）。
    var appIconKey = String(b.app_icon_key || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
    var imageData = b.image_data || '';
    if (appIconKey) imageData = '';
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
      image_data: imageData,
      app_icon_key: appIconKey,
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
    if (qP) { psql += ' AND (instr(title, ?) > 0 OR instr(slug, ?) > 0)'; pcountSql += ' AND (instr(title, ?) > 0 OR instr(slug, ?) > 0)'; pbinds.push(qP, qP); }
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
    // App 图标 key 若非空，必须在图标库中存在（防伪造 key）。
    if (d.app_icon_key) {
      var iconRow = await env.DB.prepare('SELECT 1 AS ok FROM app_icons WHERE app_key = ? LIMIT 1').bind(d.app_icon_key).first();
      if (!iconRow) return err('App 图标不存在，请重新选择');
    }
    await env.DB.prepare('INSERT INTO products (slug, title, category, price_usdt, sell_price, cost_price, source, prodseller_id, requires_email_activation, delivery_method, stock_type, description, notice, form_fields, image_emoji, image_data, app_icon_key, sort, is_active, in_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(d.slug, d.title, d.category, d.sell_price, d.sell_price, d.cost_price, d.source, d.prodseller_id, d.requires_email_activation, d.delivery_method, d.stock_type, d.description, d.notice, d.form_fields, d.image_emoji, d.image_data, d.app_icon_key, d.sort, d.is_active, d.in_stock).run();
    return json({ ok: true });
  }
  var mAP = path.match(/^\/api\/admin\/products\/(\d+)$/);
  if (mAP && method === 'PUT') {
    var ub = await parseJsonBody(req);
    var pid = Number(mAP[1]);
    var oldP = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(pid).first();
    if (!oldP) return err('商品不存在', 404);
    // 编辑时 image_data / app_icon_key 未传则保留旧值；slug 可改但必须唯一（排除自己）。
    if (typeof ub.image_data !== 'string') ub.image_data = oldP.image_data || '';
    if (typeof ub.app_icon_key !== 'string') ub.app_icon_key = oldP.app_icon_key || '';
    if (ub.slug == null || String(ub.slug).trim() === '') ub.slug = oldP.slug;
    var normU = normalizeProductInput(ub);
    if (!normU.ok) return err(normU.error);
    var slugDupU = await env.DB.prepare('SELECT id FROM products WHERE slug = ? AND id != ?').bind(normU.data.slug, pid).first();
    if (slugDupU) return err('slug 已被其他商品使用，请换一个');
    var du = normU.data;
    // in_stock 没传时保留旧值（卡密/上游商品不靠表单控制库存，别把同步值覆盖掉）
    var newInStock = (ub.in_stock == null) ? (oldP.in_stock == null ? 1 : Number(oldP.in_stock)) : (ub.in_stock === 0 ? 0 : 1);
    // App 图标 key 若非空，必须在图标库中存在（防伪造 key）。
    if (du.app_icon_key) {
      var iconRowU = await env.DB.prepare('SELECT 1 AS ok FROM app_icons WHERE app_key = ? LIMIT 1').bind(du.app_icon_key).first();
      if (!iconRowU) return err('App 图标不存在，请重新选择');
    }
    await env.DB.prepare('UPDATE products SET slug=?, title=?, category=?, price_usdt=?, sell_price=?, cost_price=?, source=?, prodseller_id=?, requires_email_activation=?, delivery_method=?, stock_type=?, description=?, notice=?, form_fields=?, image_emoji=?, image_data=?, app_icon_key=?, sort=?, is_active=?, in_stock=? WHERE id=?').bind(du.slug, du.title, du.category, du.sell_price, du.sell_price, du.cost_price, du.source, du.prodseller_id, du.requires_email_activation, du.delivery_method, du.stock_type, du.description, du.notice, du.form_fields, du.image_emoji, du.image_data, du.app_icon_key, du.sort, du.is_active, newInStock, pid).run();
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
    if (!auditOkDel) { console.error('audit failed: product_delete product=' + delId); return json({ ok: true, audit_failed: true, warning: auditFailMsg(delId, 'product_delete') }); }
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
    if (cq) { csql += ' AND (instr(code, ?) > 0 OR instr(CAST(id AS TEXT), ?) > 0)'; ccountSql += ' AND (instr(code, ?) > 0 OR instr(CAST(id AS TEXT), ?) > 0)'; cbinds.push(cq, cq); }
    csql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    var cStmt = env.DB.prepare(csql).bind.apply(env.DB.prepare(csql), cbinds.concat([cpageSize, (cpage - 1) * cpageSize]));
    var ccStmt = env.DB.prepare(ccountSql);
    if (cbinds.length) ccStmt = ccStmt.bind.apply(ccStmt, cbinds);
    var cr = await cStmt.all();
    var cTotalRow = await ccStmt.first();
    var cTotal = Number((cTotalRow && cTotalRow.c) || 0);
    // P3-10：卡密列表记审计（操作 + 商品 + 数量，不记 code）。审计失败不阻塞查询（读操作）。
    await logAudit(env, null, 'cards_list', '', '', '查看卡密列表，商品ID：' + String(cpid || '全部') + '，状态：' + (cstatus || '全部') + '，数量：' + cTotal);
    // P2-7：列表默认不再返回完整 code，改为 code_masked（前 4 + ****）；完整 code 须走
    // GET /api/admin/cards/:id/reveal 单条查看（写审计但审计中绝不记卡密正文）。
    var maskedCards = (cr.results || []).map(function (c) {
      var out = Object.assign({}, c);
      delete out.code;
      out.code_masked = maskCardCode(c.code);
      return out;
    });
    return json({ ok: true, cards: maskedCards, total: cTotal, page: cpage, page_size: cpageSize, total_pages: Math.max(1, Math.ceil(cTotal / cpageSize)) });
  }
  // GET /api/admin/cards/:id/reveal —— 单条查看完整卡密（有效管理员会话）。
  // 响应头禁缓存（json() 已设 cache-control: no-store）；写审计但审计中绝不记卡密正文。
  var mCardReveal = path.match(/^\/api\/admin\/cards\/(\d+)\/reveal$/);
  if (mCardReveal && method === 'GET') {
    var revealId = Number(mCardReveal[1]);
    var revealCard = await env.DB.prepare('SELECT * FROM cards WHERE id = ?').bind(revealId).first();
    if (!revealCard) return err('卡密不存在', 404);
    await logAudit(env, null, 'card_reveal', '', '', '查看单条卡密，卡密ID：' + revealId + '，商品ID：' + revealCard.product_id + '（不记卡密正文）');
    var revealResp = json({ ok: true, id: revealCard.id, product_id: revealCard.product_id, code: revealCard.code });
    revealResp.headers.set('cache-control', 'no-store, no-cache, must-revalidate');
    return revealResp;
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
      } catch (e) {
        // P3-31：SELECT-then-INSERT 竞态下唯一约束冲突按“已存在”计入跳过数；其他 DB 错误计入无效，不静默误分类。
        if (/UNIQUE constraint/i.test(String((e && e.message) || e || ''))) duplicate++; else invalid++;
      }
    }
    // P3-10：卡密导入记审计（操作 + 商品 + 数量，不记 code）。
    var auditOkImp = await logAudit(env, null, 'cards_import', '', '', '导入卡密，商品ID：' + iPid + '，新增：' + added + '，已存在跳过：' + duplicate + '，无效：' + invalid);
    if (!auditOkImp) return json({ ok: true, imported: added, added: added, duplicate: duplicate, invalid: invalid, total: lines.length, audit_failed: true, warning: auditFailMsg(null, 'cards_import') });
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
      // 上游商品按标题自动匹配 App 图标（仅新导入时设置；冲突重导入不覆盖人工选的图标）。
      var upIconKey = matchAppIconKey(String(title || ''));
      try {
        // 冲突时不覆盖 title/description：标题与简介已人工翻译为中文，重新导入只更新价格/库存等
        await env.DB.prepare('INSERT INTO products (slug, title, category, price_usdt, sell_price, cost_price, source, prodseller_id, requires_email_activation, delivery_method, stock_type, description, notice, form_fields, image_emoji, app_icon_key, sort, is_active, in_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET price_usdt=excluded.price_usdt, sell_price=excluded.sell_price, cost_price=excluded.cost_price, prodseller_id=excluded.prodseller_id, requires_email_activation=excluded.requires_email_activation, in_stock=excluded.in_stock').bind(slug, title, 'recharge', sell, sell, cost, 'prodseller', String(up.id || ''), reqAct, 'both', 'manual', String(up.description || ''), '', '[]', 'box', upIconKey, 0, 1, inSt).run();
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
    // P2-14：同时覆盖 pending_activation 超 30 分钟未 delivered 的订单，并区分“等待中”与“异常卡死”
    // （alert_reason）。P3-8：走 sanitize summary 脱敏，不返回原始订单行。
    var alUp = await env.DB.prepare("SELECT * FROM orders WHERE status='pending_upstream' ORDER BY id ASC LIMIT 100").all();
    var alAct = await env.DB.prepare("SELECT * FROM orders WHERE status='pending_activation' AND COALESCE(paid_at, created_at) < datetime('now', '-30 minutes') ORDER BY id ASC LIMIT 100").all();
    var alerts = [];
    (alUp.results || []).forEach(function (x) { var s = sanitizeOrderForPublic(x, 'summary'); s.alert_reason = '上游待处理（pending_upstream）'; alerts.push(s); });
    (alAct.results || []).forEach(function (x) { var s = sanitizeOrderForPublic(x, 'summary'); s.alert_reason = '上游已付款超 30 分钟未 delivered（pending_activation），等待中/异常卡死待核查'; alerts.push(s); });
    return json({ ok: true, alerts: alerts });
  }
  var mUpRetry = path.match(/^\/api\/admin\/upstream\/orders\/(\d+)\/retry$/);
  if (mUpRetry && method === 'POST') {
    var rOrd = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(Number(mUpRetry[1])).first();
    if (!rOrd) return err('订单不存在', 404);
    // P3-22：上游重试接口对非 pending_activation/pending_upstream 订单返回 409，不制造“重试成功”假象。
    if (rOrd.status !== 'pending_activation' && rOrd.status !== 'pending_upstream') return err('仅 pending_activation / pending_upstream 订单可重试上游（当前状态：' + rOrd.status + '）', 409);
    var rb = await parseJsonBody(req);
    var retryReason = String(rb.reason || '').trim();
    var beforeRetry = rOrd.status;
    var pollRes = await pollUpstreamActivations(env, ctx, { orderId: Number(mUpRetry[1]) });
    var afterRetry = (await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(Number(mUpRetry[1])).first() || {}).status || beforeRetry;
    var auditOkRetry = await logAudit(env, Number(mUpRetry[1]), 'upstream_retry', beforeRetry, afterRetry, '管理员重试上游轮询' + (retryReason ? '，原因：' + retryReason : ''));
    if (!auditOkRetry) { console.error('audit failed: upstream_retry order=' + Number(mUpRetry[1])); return json({ ok: true, poll: pollRes.poll || pollRes, audit_failed: true, warning: auditFailMsg(Number(mUpRetry[1]), 'upstream_retry') }); }
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
        for (var i = 0; i < ak.length; i++) { if (ak[i].indexOf('|') === -1) return 'usdt_addresses 的键必须是“支付方式|链”格式，如 OKX|X Layer、Binance|BEP20'; if (typeof parsed[ak[i]] !== 'string' || !parsed[ak[i]].trim()) return 'usdt_addresses 的 ' + ak[i] + ' 地址不能为空'; }
      }
      if (key === 'rpc_urls') {
        var rk = Object.keys(parsed);
        for (var j = 0; j < rk.length; j++) { if (!Array.isArray(parsed[rk[j]]) || !parsed[rk[j]].length) return 'rpc_urls 的 ' + rk[j] + ' 必须是非空 URL 数组'; for (var u = 0; u < parsed[rk[j]].length; u++) { if (typeof parsed[rk[j]][u] !== 'string' || parsed[rk[j]][u].indexOf('https://') !== 0) return 'rpc_urls 的 ' + rk[j] + ' 必须使用 https:// 前缀（明文 http 可被中间人伪造链上日志）'; } }
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
    if (key === 'large_order_usdt') { var lou = Number(v); if (!isFinite(lou) || lou <= 0 || lou > 1000000) return 'large_order_usdt 必须是 0~1000000 之间的大额阈值（USDT）'; return null; }
    if (key === 'large_order_confirmations') { var loc = Number(v); if (!isFinite(loc) || loc < 1 || loc > 100 || Math.floor(loc) !== loc) return 'large_order_confirmations 必须是 1~100 的整数'; return null; }
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
    // P1-3：后台设置校验——开启 Turnstile 时若 Site Key 或 Secret 缺失，拒绝保存启用（失败关闭）。
    // 按合并后配置判定（本次提交 + 现有配置），避免分两次提交绕过校验。
    if (keys.indexOf('turnstile_enabled') !== -1 || keys.indexOf('turnstile_site_key') !== -1) {
      var mergedTurnstile = await getAllSettings(env);
      for (var mk = 0; mk < keys.length; mk++) mergedTurnstile[keys[mk]] = String(entries[keys[mk]] == null ? '' : entries[keys[mk]]);
      if (String(mergedTurnstile.turnstile_enabled || '0') === '1') {
        if (!String(mergedTurnstile.turnstile_site_key || '').trim()) return err('开启 Turnstile 时必须配置 Site Key（turnstile_site_key），已拒绝保存启用');
        if (!(env && env.TURNSTILE_SECRET_KEY)) return err('开启 Turnstile 时服务端 Secret 未配置（TURNSTILE_SECRET_KEY），已拒绝保存启用');
      }
    }
    for (var sj = 0; sj < keys.length; sj++) {
      await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(keys[sj], String(entries[keys[sj]] == null ? '' : entries[keys[sj]])).run();
    }
    var auditOkS = await logAudit(env, null, 'settings_update', '', '', '修改设置：' + keys.join('、'));
    if (!auditOkS) { console.error('audit failed: settings_update'); return json({ ok: true, audit_failed: true, warning: '设置已保存，但审计记录写入失败，请立即检查 admin_audit 表并手动补记（操作：settings_update）' }); }
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
    // P3-3：账本对账只接受合法转换——仅 mismatch（金额不符）/ unmatched（无法匹配）/
    // duplicate（重复事件）可人工对账为 reconciled，且须带原因 + 审计。
    // submitted/discovered/verified/confirmed（处理中）不得直接对账为已处理；
    // posted 为终态不得降级；reconciled/manual_confirmed 为终态不得重复对账。
    if (['mismatch', 'unmatched', 'duplicate'].indexOf(String(payRow.status)) === -1) {
      return err('当前状态（' + payRow.status + '）不可人工对账，仅金额不符 / 无法匹配 / 重复事件可对账', 409);
    }
    // P3-3 并发对账：状态守卫必须在 UPDATE 里原子生效（不能只靠前面的 SELECT，
    // 否则两并发都读到 mismatch、都对账成功）。行数 !== 1 说明已被其他请求处理。
    var reconRes = await env.DB.prepare("UPDATE payments SET status='reconciled', reconcile_status='resolved', reconcile_note=?, updated_at=? WHERE id=? AND status IN ('mismatch','unmatched','duplicate')").bind(rNote, nowISO(), payId).run();
    if (!reconRes || !reconRes.meta || reconRes.meta.changes !== 1) return err('该付款记录已被其他请求处理', 409);
    var auditOkRecon = await logAudit(env, payRow.order_id, 'payment_reconcile', payRow.status, 'reconciled', '人工对账付款记录 #' + payId + '：' + rNote);
    if (!auditOkRecon) { console.error('audit failed: payment_reconcile payment=' + payId); return json({ ok: true, audit_failed: true, warning: auditFailMsg(payRow.order_id, 'payment_reconcile') }); }
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
