-- v2 商品上游字段（幂等说明同 v1）
ALTER TABLE products ADD COLUMN source TEXT NOT NULL DEFAULT 'self';
ALTER TABLE products ADD COLUMN prodseller_id TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN cost_price REAL NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN sell_price REAL NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN requires_email_activation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN delivery_method TEXT NOT NULL DEFAULT 'both';
ALTER TABLE products ADD COLUMN image_data TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN in_stock INTEGER NOT NULL DEFAULT 1;
-- 兼容旧库：sell_price 仍为 0 时回填为 price_usdt（条件 UPDATE，幂等）
UPDATE products SET sell_price = price_usdt WHERE sell_price IS NULL OR sell_price = 0;
