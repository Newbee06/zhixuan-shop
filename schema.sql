-- aisou-lite schema (SQLite / Cloudflare D1)
-- 表：products, cards, orders, settings, admin_meta, sessions
-- 全部 IF NOT EXISTS，可重复执行；不要在此文件放任何真实 secret / 密码。

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'recharge',
  price_usdt REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'self',
  prodseller_id TEXT NOT NULL DEFAULT '',
  cost_price REAL NOT NULL DEFAULT 0,
  sell_price REAL NOT NULL DEFAULT 0,
  requires_email_activation INTEGER NOT NULL DEFAULT 0,
  delivery_method TEXT NOT NULL DEFAULT 'both',
  stock_type TEXT NOT NULL DEFAULT 'manual',
  description TEXT NOT NULL DEFAULT '',
  notice TEXT NOT NULL DEFAULT '',
  form_fields TEXT NOT NULL DEFAULT '[]',
  image_emoji TEXT NOT NULL DEFAULT '🤖',
  image_data TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  in_stock INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  is_used INTEGER NOT NULL DEFAULT 0,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  order_id INTEGER,
  -- 卡密预留：下单时预留给某订单，取消/超时释放，发货时优先分配预留卡
  reserved_order_id INTEGER,
  reserved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, code),
  FOREIGN KEY(product_id) REFERENCES products(id)
);
CREATE INDEX IF NOT EXISTS idx_cards_product ON cards(product_id);
CREATE INDEX IF NOT EXISTS idx_cards_used ON cards(product_id, is_used, is_disabled);
CREATE INDEX IF NOT EXISTS idx_cards_reserved ON cards(reserved_order_id);
CREATE INDEX IF NOT EXISTS idx_cards_avail ON cards(product_id, is_used, is_disabled, reserved_order_id);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  query_password TEXT NOT NULL,
  -- 查单凭证哈希：新订单下单时生成高强度凭证，只存 SHA-256 哈希，只在创建时返回一次；旧订单为空，走旧密码兼容路径
  -- 新订单 query_password 写空值（不再生成明文六位查询密码），字段保留兼容旧订单
  query_token_hash TEXT NOT NULL DEFAULT '',
  -- 订单认领：claim_token（认领者令牌）+ claimed_at（认领时间，租约起点）。认领后处理者崩溃，超租约可被接管恢复。
  claim_token TEXT NOT NULL DEFAULT '',
  claimed_at TEXT,
  -- 异常与退款：exception_reason（异常原因）+ refund_status（''/pending/refunded）+ refund_ref（系统外退款凭证）。
  exception_reason TEXT NOT NULL DEFAULT '',
  refund_status TEXT NOT NULL DEFAULT '',
  refund_ref TEXT NOT NULL DEFAULT '',
  -- 上游轮询租约：upstream_lock（持有者令牌）+ upstream_lock_expires_at（过期时间，崩溃后超时可接管）。Cron 与管理员重试互斥。
  upstream_lock TEXT NOT NULL DEFAULT '',
  upstream_lock_expires_at TEXT,
  product_id INTEGER NOT NULL,
  product_snapshot TEXT NOT NULL DEFAULT '{}',
  quantity INTEGER NOT NULL DEFAULT 1,
  price_usdt REAL NOT NULL DEFAULT 0,
  total_usdt REAL NOT NULL DEFAULT 0,
  -- CF 轮询自动发货新增字段（新库直接建表，老库由 Worker 启动时自动 ALTER 补列，见 README 迁移说明）
  actual_amount REAL NOT NULL DEFAULT 0,
  pay_address TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  last_checked_at TEXT,
  tx_hash TEXT NOT NULL DEFAULT '',
  customer_fields TEXT NOT NULL DEFAULT '{}',
  contact TEXT NOT NULL DEFAULT '',
  pay_method TEXT NOT NULL DEFAULT '',
  pay_chain TEXT NOT NULL DEFAULT '',
  wallet_address TEXT NOT NULL DEFAULT '',
  txid TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending_payment',
  delivery_content TEXT NOT NULL DEFAULT '',
  admin_note TEXT NOT NULL DEFAULT '',
  data_expired INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT,
  fulfilled_at TEXT,
  FOREIGN KEY(product_id) REFERENCES products(id)
);
CREATE INDEX IF NOT EXISTS idx_orders_no ON orders(order_no);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_actual ON orders(pay_address, actual_amount, status);
CREATE INDEX IF NOT EXISTS idx_orders_txhash ON orders(tx_hash);
CREATE INDEX IF NOT EXISTS idx_orders_expires ON orders(status, expires_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS admin_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS upstream_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  prodseller_order_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  delivered_keys TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(order_id) REFERENCES orders(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_orders_order_unique ON upstream_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_upstream_orders_psid ON upstream_orders(prodseller_order_id);

CREATE TABLE IF NOT EXISTS upstream_cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 默认设置（占位值，部署后请在后台改为真实值）
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('site_name', '智选'),
  ('announcement', '示例公告：本店仅售卖自有合法货源的虚拟商品 / 代充服务，虚拟商品一经交付不退换，下单前请仔细阅读商品说明。'),
  ('order_notice', '1. 请妥善保存订单号与查单凭证（下单成功页只展示一次），凭订单号 + 查单凭证查询订单与交付内容。\n2. 卡密 / 账号交付数据仅保留 7 天，请及时保存，逾期自动清空不补。\n3. 成品号收到后请第一时间修改密码。\n4. 虚拟商品一经交付，不因密码被修改、个人操作失误等原因提供售后。\n5. 本站仅支持 USDT 付款，请按页面展示的收款地址付款并提交 TXID。'),
  ('tg_link', 'https://t.me/your_support'),
  ('usdt_addresses', '{"Binance|X Layer":"0xYOUR_BINANCE_XLAYER_ADDRESS","Binance|TRC20":"TYOUR_BINANCE_TRC20_ADDRESS","Binance|ERC20":"0xYOUR_BINANCE_ERC20_ADDRESS","Binance|BEP20":"0xYOUR_BINANCE_BEP20_ADDRESS","OKX|X Layer":"0xYOUR_OKX_XLAYER_ADDRESS","OKX|TRC20":"TYOUR_OKX_TRC20_ADDRESS","OKX|ERC20":"0xYOUR_OKX_ERC20_ADDRESS","OKX|BEP20":"0xYOUR_OKX_BEP20_ADDRESS"}'),
  ('pay_tutorials', '{"Binance":"https://example.com/tutorial-binance","OKX":"https://example.com/tutorial-okx"}'),
  ('binance_uid', ''),
  ('poll_enabled', '1'),
  ('poll_lock_minutes', '20'),
  ('rpc_urls', '{"X Layer":["https://xlayerrpc.okx.com"],"ERC20":["https://eth.llamarpc.com","https://rpc.ankr.com/eth"],"BEP20":["https://bsc-dataseed.binance.org","https://bsc-dataseed1.defibit.io"]}'),
  ('usdt_contracts', '{"X Layer":"0x779Ded0c9e1022225f8E0630b35a9b54bE713736","ERC20":"0xdAC17F958D2ee523a2206206994597C13D831ec7","BEP20":"0x55d398326f99059fF775485246999027B3197955","TRC20":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"}'),
  ('upstream_markup', '1.2'),
  ('upstream_fixed', '0'),
  ('prodseller_base_url', 'https://prodseller.com/v1'),
  ('email_from', 'noreply@your-domain.example'),
  ('email_enabled', '0'),
  ('delivery_mode', 'both'),
  ('cny_rate', '7.2'),
  -- 第四轮：ProdSeller 门禁默认关闭（0）；Turnstile 默认关闭（0）；各链确认数默认见代码 DEFAULT_CHAIN_CONFIRMATIONS。
  ('prodseller_enabled', '0'),
  ('turnstile_enabled', '0'),
  ('turnstile_site_key', ''),
  ('chain_confirmations', '{"X Layer":1,"ERC20":12,"BEP20":15,"TRC20":19}');

-- 种子商品：4 个示例，价格/说明均为占位，请替换为自己真实商品/价格/收款地址
INSERT OR IGNORE INTO products (slug, title, category, price_usdt, stock_type, description, notice, form_fields, image_emoji, sort, is_active) VALUES
  ('chatgpt-plus-recharge', 'ChatGPT Plus 代充示例（1个月）', 'recharge', 20.00, 'manual', '示例商品：为你自己的 ChatGPT 账号代充 Plus 会员（1个月）。下单时请填写需要充值的账号邮箱，付款后管理员核对 TXID 后人工代充。', '请确认账号邮箱无误；代充需 1-24 小时；虚拟商品一经交付不退换。', '[{"key":"account_email","label":"充值账号邮箱","required":true,"placeholder":"如 your@email.com"},{"key":"account_name","label":"账号昵称（可选）","required":false,"placeholder":""}]', '💬', 10, 1),
  ('claude-pro-recharge', 'Claude Pro 代充示例（1个月）', 'recharge', 20.00, 'manual', '示例商品：为你自己的 Claude 账号代充 Pro 会员（1个月）。下单时请填写充值账号邮箱。', '请确认账号邮箱无误；代充需 1-24 小时；虚拟商品一经交付不退换。', '[{"key":"account_email","label":"充值账号邮箱","required":true,"placeholder":"如 your@email.com"}]', '🧠', 20, 1),
  ('cursor-account', 'Cursor 成品号示例', 'account', 15.00, 'card', '示例商品：全新成品号，内含 1 个月会员权益。发货后请第一时间修改密码并绑定自己的邮箱。', '成品号一经交付请立即改密；虚拟商品一经交付不退换。', '[{"key":"contact","label":"联系方式（邮箱/TG）","required":true,"placeholder":"用于接收发货通知"}]', '⌨️', 30, 1),
  ('gemini-card', 'Gemini 卡密示例', 'card', 10.00, 'card', '示例商品：卡密类，付款后管理员确认收款即自动发卡密，查询订单即可看到卡密。', '卡密请及时保存，7 天后自动清空；虚拟商品一经交付不退换。', '[{"key":"contact","label":"联系方式（邮箱/TG）","required":true,"placeholder":""}]', '✨', 40, 1);

-- 种子卡密：仅用于本地演示，生产请删除并在后台重新导入真实卡密
INSERT OR IGNORE INTO cards (product_id, code, is_used, is_disabled) VALUES
  ((SELECT id FROM products WHERE slug='gemini-card'), 'DEMO-GEMINI-0001-XXXX', 0, 0),
  ((SELECT id FROM products WHERE slug='gemini-card'), 'DEMO-GEMINI-0002-XXXX', 0, 0);

-- 图形验证码：服务端哈希存码，一次性；同 IP 下单限流窗口
CREATE TABLE IF NOT EXISTS captcha_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS order_rate (
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_rate_ip ON order_rate(ip, created_at);

-- 操作审计：订单标识、操作类型、前后状态、时间、结果与说明；绝不记密码、查单凭证、完整卡密、API Key
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  action TEXT NOT NULL DEFAULT '',
  before_status TEXT NOT NULL DEFAULT '',
  after_status TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_order ON admin_audit(order_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit(created_at);

-- 登录限流：按 IP 记失败次数与封禁截止时间
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- TXID 原子认领：tx_hash 主键，同一笔链上已验证交易只能被一个订单认领（永久有效，防跨订单重复使用）
CREATE TABLE IF NOT EXISTS txid_claims (
  tx_hash TEXT PRIMARY KEY,
  order_id INTEGER NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 公开查单限流：按 IP 记查单次数
CREATE TABLE IF NOT EXISTS lookup_rate (
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lookup_rate_ip ON lookup_rate(ip, created_at);

-- 数据库迁移版本：新库由 schema.sql 直接建到最新，预置全部版本；旧库由 Worker 的 runMigrations 按版本递进升级。
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (1), (2), (3), (4), (5), (6), (7), (8), (9), (10);

-- 第四轮（Release Readiness）：付款账本 payments —— 独立记录每一笔链上付款事件，与订单分离。
-- 状态机：submitted → discovered → verified → confirmed → posted；异常：duplicate / mismatch / unmatched / reconciled。
-- 唯一键 (chain, tx_hash, event_key)：同一链上事件只能入账一次；order_id 不唯一（同一订单可有多笔付款）。
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  chain TEXT NOT NULL DEFAULT '',
  asset TEXT NOT NULL DEFAULT 'USDT',
  pay_address TEXT NOT NULL DEFAULT '',
  tx_hash TEXT NOT NULL DEFAULT '',
  event_key TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  amount_unit TEXT NOT NULL DEFAULT 'USDT',
  block_number INTEGER,
  confirmations INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'submitted',
  reconcile_status TEXT NOT NULL DEFAULT '',
  reconcile_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_event_unique ON payments(chain, tx_hash, event_key);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_txhash ON payments(tx_hash);

-- 链上扫描游标：每链已扫描到的区块高度，持久化；RPC 失败不推进，重启可恢复。
CREATE TABLE IF NOT EXISTS scan_cursors (
  chain TEXT PRIMARY KEY,
  last_block INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- /pay 独立限流：key 为 order:<订单号> 或 ip:<IP>。
CREATE TABLE IF NOT EXISTS pay_rate (
  key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pay_rate_key ON pay_rate(key, created_at);

-- 金额唯一性：部分唯一索引，仅约束待付款订单（过期未取消的仍占位，轮询自动取消后释放）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_amount_claim ON orders(pay_address, actual_amount) WHERE status = 'pending_payment' AND pay_method != 'BinanceUID';
-- 同联系方式去重原子化：部分唯一索引，仅约束待付款且 contact 非空的订单。
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_contact_pending ON orders(contact, product_id) WHERE status = 'pending_payment' AND contact != '';
