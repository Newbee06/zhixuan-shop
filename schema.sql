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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  is_used INTEGER NOT NULL DEFAULT 0,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  order_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, code),
  FOREIGN KEY(product_id) REFERENCES products(id)
);
CREATE INDEX IF NOT EXISTS idx_cards_product ON cards(product_id);
CREATE INDEX IF NOT EXISTS idx_cards_used ON cards(product_id, is_used, is_disabled);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  query_password TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_upstream_orders_order ON upstream_orders(order_id);
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
  ('order_notice', '1. 建议注册/留好订单号与查询密码，便于查询与售后。\n2. 卡密 / 账号交付数据仅保留 7 天，请及时保存，逾期自动清空不补。\n3. 成品号收到后请第一时间修改密码。\n4. 虚拟商品一经交付，不因密码被修改、个人操作失误等原因提供售后。\n5. 本站仅支持 USDT 付款，请按页面展示的收款地址付款并提交 TXID。'),
  ('tg_link', 'https://t.me/your_support'),
  ('usdt_addresses', '{"Binance|X Layer":"0xYOUR_BINANCE_XLAYER_ADDRESS","Binance|TRC20":"TYOUR_BINANCE_TRC20_ADDRESS","Binance|ERC20":"0xYOUR_BINANCE_ERC20_ADDRESS","Binance|BEP20":"0xYOUR_BINANCE_BEP20_ADDRESS","OKX|X Layer":"0xYOUR_OKX_XLAYER_ADDRESS","OKX|TRC20":"TYOUR_OKX_TRC20_ADDRESS","OKX|ERC20":"0xYOUR_OKX_ERC20_ADDRESS","OKX|BEP20":"0xYOUR_OKX_BEP20_ADDRESS"}'),
  ('pay_tutorials', '{"Binance":"https://example.com/tutorial-binance","OKX":"https://example.com/tutorial-okx"}'),
  ('binance_uid', ''),
  ('poll_enabled', '1'),
  ('poll_lock_minutes', '20'),
  ('rpc_urls', '{"X Layer":["https://xlayerrpc.okx.com"],"ERC20":["https://eth.llamarpc.com","https://rpc.ankr.com/eth"],"BEP20":["https://bsc-dataseed.binance.org","https://bsc-dataseed1.defibit.io"]}'),
  ('usdt_contracts', '{"X Layer":"0xYOUR_XLAYER_USDT_CONTRACT","ERC20":"0xdAC17F958D2ee523a2206206994597C13D831ec7","BEP20":"0x55d398326f99059fF775485246999027B3197955","TRC20":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"}'),
  ('upstream_markup', '1.2'),
  ('upstream_fixed', '0'),
  ('prodseller_base_url', 'https://prodseller.com/v1'),
  ('email_from', 'noreply@your-domain.example'),
  ('email_enabled', '0'),
  ('delivery_mode', 'both'),
  ('cny_rate', '7.2');

-- 种子商品：4 个示例，价格/说明均为占位，请替换为自己真实商品/价格/收款地址
INSERT OR IGNORE INTO products (slug, title, category, price_usdt, stock_type, description, notice, form_fields, image_emoji, sort, is_active) VALUES
  ('chatgpt-plus-recharge', 'ChatGPT Plus 代充示例（1个月）', 'recharge', 20.00, 'manual', '示例商品：为你自己的 ChatGPT 账号代充 Plus 会员（1个月）。下单时请填写需要充值的账号邮箱，付款后管理员核对 TXID 后人工代充。', '请确认账号邮箱无误；代充需 1-24 小时；虚拟商品一经交付不退换。', '[{"key":"account_email","label":"充值账号邮箱","required":true,"placeholder":"如 your@email.com"},{"key":"account_name","label":"账号昵称（可选）","required":false,"placeholder":""}]', '💬', 10, 1),
  ('claude-pro-recharge', 'Claude Pro 代充示例（1个月）', 'recharge', 20.00, 'manual', '示例商品：为你自己的 Claude 账号代充 Pro 会员（1个月）。下单时请填写充值账号邮箱。', '请确认账号邮箱无误；代充需 1-24 小时；虚拟商品一经交付不退换。', '[{"key":"account_email","label":"充值账号邮箱","required":true,"placeholder":"如 your@email.com"}]', '🧠', 20, 1),
  ('cursor-account', 'Cursor 成品号示例', 'account', 15.00, 'manual', '示例商品：全新成品号，内含 1 个月会员权益。发货后请第一时间修改密码并绑定自己的邮箱。', '成品号一经交付请立即改密；虚拟商品一经交付不退换。', '[{"key":"contact","label":"联系方式（邮箱/TG）","required":true,"placeholder":"用于接收发货通知"}]', '⌨️', 30, 1),
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
