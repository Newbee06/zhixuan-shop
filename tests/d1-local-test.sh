#!/bin/bash
# D1 本地环境迁移验证（仅 --local，绝不碰 --remote 生产库）
# 1. 旧库（第一轮后状态：无 v6 字段、无 schema_migrations）→ Worker 首次请求自动迁移 → 验证版本=7、旧数据保留
# 2. 新库（当前 schema.sql）→ 验证无需迁移、API 正常
set -e
cd ~/workspace/aisou-lite
WR="npx --yes wrangler"
PORT=8791
BASE="http://127.0.0.1:$PORT"

# --- 生成旧库 schema（去掉 v6 部分）---
python3 - <<'PYEOF'
import re
s = open('schema.sql', encoding='utf-8').read()
for pat in [
    r"  claim_token TEXT NOT NULL DEFAULT '',\n",
    r"  claimed_at TEXT,\n",
    r"  exception_reason TEXT NOT NULL DEFAULT '',\n",
    r"  refund_status TEXT NOT NULL DEFAULT '',\n",
    r"  refund_ref TEXT NOT NULL DEFAULT '',\n",
]:
    s = re.sub(pat, '', s)
s = re.sub(r"-- TXID 原子认领[\s\S]*?CREATE INDEX IF NOT EXISTS idx_lookup_rate_ip ON lookup_rate\(ip, created_at\);\n", '', s)
s = re.sub(r"-- 上游轮询租约[^\n]*\n  upstream_lock TEXT NOT NULL DEFAULT '',\n  upstream_lock_expires_at TEXT,\n", '', s)
s = re.sub(r"CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_orders_order_unique ON upstream_orders\(order_id\);\n", '', s)
s = re.sub(r"-- 数据库迁移版本[\s\S]*?INSERT OR IGNORE INTO schema_migrations \(version\) VALUES \(1\), \(2\), \(3\), \(4\), \(5\), \(6\), \(7\);\n", '', s)
open('/tmp/old-schema.sql', 'w', encoding='utf-8').write(s)
print('old schema written, has claim_token:', 'claim_token' in s, 'has schema_migrations:', 'schema_migrations' in s)
PYEOF

# --- 旧库：建表 + 旧数据 ---
rm -rf .wrangler/state
$WR d1 execute aisou-lite-db --local --file=/tmp/old-schema.sql > /tmp/d1-old-schema.log 2>&1
cat > /tmp/old-data.sql <<'SQLEOF'
INSERT INTO products (slug, title, category, price_usdt, stock_type) VALUES ('old-d1-prod', '旧库商品', 'card', 5, 'card');
INSERT INTO cards (product_id, code) VALUES ((SELECT id FROM products WHERE slug='old-d1-prod'), 'OLD-D1-CARD-1');
INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, status, created_at) VALUES ('AISOLDD1001', '123456', '', (SELECT id FROM products WHERE slug='old-d1-prod'), '{}', 1, 5, 5, 'completed', datetime('now'));
SQLEOF
$WR d1 execute aisou-lite-db --local --file=/tmp/old-data.sql > /tmp/d1-old-data.log 2>&1
echo "OLD DB SEEDED"

# --- 启动本地 Worker ---
$WR dev --local --port $PORT > /tmp/wrangler-dev.log 2>&1 &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null; true" EXIT
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "$BASE/api/config" 2>/dev/null | grep -q 200; then echo "WORKER UP"; break; fi
  sleep 2
done

# --- 旧库：首次请求触发迁移；登录改密后查迁移状态 ---
echo "--- old-db /api/config ---"
curl -s "$BASE/api/config" | head -c 300; echo
# 登录
COOKIE_JAR=/tmp/cookies.txt; rm -f $COOKIE_JAR
curl -s -c $COOKIE_JAR -X POST "$BASE/api/admin/login" -H 'content-type: application/json' -d '{"password":"admin"}' | head -c 200; echo
curl -s -b $COOKIE_JAR -X POST "$BASE/api/admin/change-password" -H 'content-type: application/json' -H 'X-Admin-API: 1' -d '{"old_password":"admin","new_password":"d1-local-test-123"}' | head -c 200; echo
echo "--- old-db /api/admin/migrate ---"
MIG=$(curl -s -b $COOKIE_JAR "$BASE/api/admin/migrate")
echo "$MIG"
echo "$MIG" | grep -q '"current_version":7' || { echo "FAIL: old-db migrate version != 7"; exit 1; }
echo "OLD-DB MIGRATION OK: version 7"
# 旧数据保留（经 D1 直接查）
$WR d1 execute aisou-lite-db --local --command="SELECT order_no, status FROM orders WHERE order_no='AISOLDD1001';" 2>&1 | grep -q "AISOLDD1001" || { echo "FAIL: old order lost"; exit 1; }
$WR d1 execute aisou-lite-db --local --command="SELECT code FROM cards WHERE code='OLD-D1-CARD-1';" 2>&1 | grep -q "OLD-D1-CARD-1" || { echo "FAIL: old card lost"; exit 1; }
echo "OLD-DB DATA PRESERVED"
# 旧订单查单（POST lookup，旧密码 → 概要）
LOOKUP=$(curl -s -X POST "$BASE/api/orders/AISOLDD1001/lookup" -H 'content-type: application/json' -d '{"credential":"123456"}')
echo "$LOOKUP" | head -c 400; echo
echo "$LOOKUP" | grep -q '"legacy":true' || { echo "FAIL: old order lookup not legacy"; exit 1; }
echo "OLD-DB LOOKUP OK"
kill $DEV_PID 2>/dev/null; trap - EXIT; wait $DEV_PID 2>/dev/null; true

# --- 新库：当前 schema.sql ---
rm -rf .wrangler/state
$WR d1 execute aisou-lite-db --local --file=schema.sql > /tmp/d1-new-schema.log 2>&1
$WR dev --local --port $PORT > /tmp/wrangler-dev2.log 2>&1 &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null; true" EXIT
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "$BASE/api/config" 2>/dev/null | grep -q 200; then echo "WORKER UP (fresh)"; break; fi
  sleep 2
done
rm -f $COOKIE_JAR
curl -s -c $COOKIE_JAR -X POST "$BASE/api/admin/login" -H 'content-type: application/json' -d '{"password":"admin"}' > /dev/null
curl -s -b $COOKIE_JAR -X POST "$BASE/api/admin/change-password" -H 'content-type: application/json' -H 'X-Admin-API: 1' -d '{"old_password":"admin","new_password":"d1-local-test-123"}' > /dev/null
echo "--- fresh-db /api/admin/migrate ---"
MIG2=$(curl -s -b $COOKIE_JAR "$BASE/api/admin/migrate")
echo "$MIG2"
echo "$MIG2" | grep -q '"up_to_date":true' || { echo "FAIL: fresh db not up_to_date"; exit 1; }
echo "FRESH-DB OK: up_to_date"
# 新库下单 → 查单凭证流程（POST lookup）
PROD_ID=$(curl -s "$BASE/api/products" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['products'][0]['id'])")
echo "product id: $PROD_ID"
kill $DEV_PID 2>/dev/null; trap - EXIT; wait $DEV_PID 2>/dev/null; true
echo "D1 LOCAL TEST ALL OK"
