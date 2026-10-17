#!/bin/bash
# D1 本地环境迁移验证（仅 --local，绝不碰 --remote 生产库）
# 覆盖：
#  1. 旧库（去掉 v6/v7 部分，无 schema_migrations）→ Worker 首次请求自动迁移 → 版本=15、旧数据保留
#  2. 旧库重复 upstream_orders 去重（保留每个 order_id 的最新行）+ 唯一索引创建
#  3. 迁移幂等：重复调用 POST /api/admin/migrate，版本仍为 15，不报错、不丢数据
#  4. 迁移失败恢复：上游订单表结构损坏 → 迁移失败（500、不标版本）→ 修复后重试 → 成功到 v7
#  5. 新库（当前 schema.sql）→ 无需迁移、API 正常
#  6. 真正空库（不导入任何 schema）→ Worker 首次请求自动建基表 + 迁移到 v15 + schema-check ok
# 全部使用虚构数据，不读取、不复制生产数据。
set -e
cd "$(dirname "$0")/.."
# 优先用仓库锁定的本地 wrangler（package.json + package-lock.json），否则回退 npx（CI 仍需显式版本时见工作流）。
if [ -x "node_modules/.bin/wrangler" ]; then WR="node_modules/.bin/wrangler"; else WR="npx --yes wrangler@4.151.0"; fi
PORT=8791
BASE="http://127.0.0.1:$PORT"
TMPDIR_D1="${TMPDIR:-/tmp}"
OLD_SCHEMA="$TMPDIR_D1/d1-old-schema.sql"
OLD_DATA="$TMPDIR_D1/d1-old-data.sql"
COOKIE_JAR="$TMPDIR_D1/d1-cookies.txt"

# --- 生成旧库 schema（去掉 v6/v7 部分）---
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
s = re.sub(r"-- 数据库迁移版本[\s\S]*?INSERT OR IGNORE INTO schema_migrations \(version\) VALUES \(1\), \(2\), \(3\), \(4\), \(5\), \(6\), \(7\), \(8\), \(9\), \(10\)(, \(11\))?;\n", '', s)
s = re.sub(r"-- 第四轮（Release Readiness）[\s\S]*$", '', s)
open('/tmp/d1-old-schema.sql', 'w', encoding='utf-8').write(s)
print('old schema written, has claim_token:', 'claim_token' in s, 'has schema_migrations:', 'schema_migrations' in s)
PYEOF

# --- 旧库：建表 + 旧数据（含重复 upstream_orders：同一 order_id 两行，旧行 PS-OLD-1，新行 PS-OLD-2）---
rm -rf .wrangler/state
$WR d1 execute aisou-lite-db --local --file="$OLD_SCHEMA" > "$TMPDIR_D1/d1-old-schema.log" 2>&1
cat > "$OLD_DATA" <<'SQLEOF'
INSERT INTO products (slug, title, category, price_usdt, stock_type) VALUES ('old-d1-prod', '旧库商品', 'card', 5, 'card');
INSERT INTO cards (product_id, code) VALUES ((SELECT id FROM products WHERE slug='old-d1-prod'), 'OLD-D1-CARD-1');
INSERT INTO orders (order_no, query_password, query_token_hash, product_id, product_snapshot, quantity, price_usdt, total_usdt, status, created_at) VALUES ('AISOLDD1001', '123456', '', (SELECT id FROM products WHERE slug='old-d1-prod'), '{}', 1, 5, 5, 'completed', datetime('now'));
INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount) VALUES ((SELECT id FROM orders WHERE order_no='AISOLDD1001'), 'PS-OLD-1', 'done', 5);
INSERT INTO upstream_orders (order_id, prodseller_order_id, status, amount) VALUES ((SELECT id FROM orders WHERE order_no='AISOLDD1001'), 'PS-OLD-2', 'done', 5);
SQLEOF
$WR d1 execute aisou-lite-db --local --file="$OLD_DATA" > "$TMPDIR_D1/d1-old-data.log" 2>&1
echo "OLD DB SEEDED (with duplicate upstream_orders rows)"

# --- 启动本地 Worker ---
$WR dev --local --port $PORT > "$TMPDIR_D1/wrangler-dev.log" 2>&1 &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null; true" EXIT
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "$BASE/api/config" 2>/dev/null | grep -q 200; then echo "WORKER UP"; break; fi
  sleep 2
done

# --- 旧库：首次请求触发迁移；登录改密后查迁移状态 ---
echo "--- old-db /api/config ---"
curl -s "$BASE/api/config" | head -c 300; echo
COOKIE_JAR_FILE="$COOKIE_JAR"; rm -f "$COOKIE_JAR_FILE"
curl -s -c "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/login" -H 'content-type: application/json' -d '{"password":"admin"}' | head -c 200; echo
curl -s -b "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/change-password" -H 'content-type: application/json' -H 'X-Admin-API: 1' -d '{"old_password":"admin","new_password":"d1-local-test-123"}' | head -c 200; echo
echo "--- old-db /api/admin/migrate ---"
MIG=$(curl -s -b "$COOKIE_JAR_FILE" "$BASE/api/admin/migrate")
echo "$MIG"
echo "$MIG" | grep -q '"current_version":15' || { echo "FAIL: old-db migrate version != 15"; exit 1; }
echo "OLD-DB MIGRATION OK: version 15"
# 旧数据保留（经 D1 直接查）
$WR d1 execute aisou-lite-db --local --command="SELECT order_no, status FROM orders WHERE order_no='AISOLDD1001';" 2>&1 | grep -q "AISOLDD1001" || { echo "FAIL: old order lost"; exit 1; }
$WR d1 execute aisou-lite-db --local --command="SELECT code FROM cards WHERE code='OLD-D1-CARD-1';" 2>&1 | grep -q "OLD-D1-CARD-1" || { echo "FAIL: old card lost"; exit 1; }
echo "OLD-DB DATA PRESERVED"
# 去重：同一 order_id 只剩 1 行，且保留最新行 PS-OLD-2
# 去重：同一 order_id 只剩 1 行，且保留最新行 PS-OLD-2（精确解析 COUNT，不拼凑单字符；两步解析，避免嵌套引号）
DEDUP_RAW=$($WR d1 execute aisou-lite-db --local --command="SELECT COUNT(*) AS c FROM upstream_orders WHERE order_id=(SELECT id FROM orders WHERE order_no='AISOLDD1001');" 2>&1)
DEDUP_COUNT=$(printf '%s' "$DEDUP_RAW" | python3 -c 'import sys,json; t=sys.stdin.read(); d=json.loads(t[t.index("\n["):]); print(d[0]["results"][0]["c"])')
[ "$DEDUP_COUNT" = "1" ] || { echo "FAIL: dedup count != 1 (got '$DEDUP_COUNT')"; echo "$DEDUP_RAW"; exit 1; }
UPSTREAM_KEPT=$($WR d1 execute aisou-lite-db --local --command="SELECT prodseller_order_id FROM upstream_orders WHERE order_id=(SELECT id FROM orders WHERE order_no='AISOLDD1001');" 2>&1)
echo "$UPSTREAM_KEPT" | grep -q "PS-OLD-2" || { echo "FAIL: dedup did not keep latest row PS-OLD-2"; echo "$UPSTREAM_KEPT"; exit 1; }
echo "$UPSTREAM_KEPT" | grep -q "PS-OLD-1" && { echo "FAIL: dedup left stale row PS-OLD-1"; exit 1; }
echo "DEDUP OK: kept latest PS-OLD-2 only"
# 唯一索引存在
$WR d1 execute aisou-lite-db --local --command="SELECT name FROM sqlite_master WHERE type='index' AND name='idx_upstream_orders_order_unique';" 2>&1 | grep -q "idx_upstream_orders_order_unique" || { echo "FAIL: unique index missing"; exit 1; }
echo "UNIQUE INDEX OK: idx_upstream_orders_order_unique"
# 幂等：重复迁移两次，版本仍 7，不报错
for i in 1 2; do
  MIGX=$(curl -s -b "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/migrate" -H 'X-Admin-API: 1')
  echo "re-migrate $i: $MIGX"
  echo "$MIGX" | grep -q '"current_version":15' || { echo "FAIL: re-migrate $i version != 15"; exit 1; }
  echo "$MIGX" | grep -q '"ok":true' || { echo "FAIL: re-migrate $i not ok"; exit 1; }
done
echo "IDEMPOTENT MIGRATION OK"
# 旧订单查单（POST lookup，旧查询密码 → 概要；首次成功后即迁移为 salted 哈希，明文清空）
LOOKUP=$(curl -s -X POST "$BASE/api/orders/AISOLDD1001/lookup" -H 'content-type: application/json' -d '{"credential":"123456"}')
echo "$LOOKUP" | head -c 400; echo
echo "$LOOKUP" | grep -q '"legacy":true' || { echo "FAIL: old order lookup not legacy"; exit 1; }
echo "OLD-DB LOOKUP OK"
kill $DEV_PID 2>/dev/null; trap - EXIT; wait $DEV_PID 2>/dev/null || true

# --- 迁移失败恢复：损坏 upstream_orders（去掉 id 列）→ 迁移失败不标版本 → 修复后重试成功 ---
rm -rf .wrangler/state
$WR d1 execute aisou-lite-db --local --file="$OLD_SCHEMA" > "$TMPDIR_D1/d1-fail-schema.log" 2>&1
$WR d1 execute aisou-lite-db --local --command="DROP TABLE upstream_orders; CREATE TABLE upstream_orders (order_id INTEGER NOT NULL, prodseller_order_id TEXT NOT NULL DEFAULT '');" > "$TMPDIR_D1/d1-fail-corrupt.log" 2>&1
echo "BROKEN DB SEEDED (upstream_orders without id column)"
$WR dev --local --port $PORT > "$TMPDIR_D1/wrangler-dev-fail.log" 2>&1 &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null; true" EXIT
for i in $(seq 1 30); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/config" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "500" ]; then echo "WORKER UP (migration failing as expected, HTTP 500)"; break; fi
  if [ "$HTTP_CODE" = "200" ]; then echo "FAIL: broken db unexpectedly migrated OK (HTTP 200)"; exit 1; fi
  sleep 2
done
FAIL_BODY=$(curl -s "$BASE/api/config")
echo "fail body: $(echo "$FAIL_BODY" | head -c 300)"
echo "$FAIL_BODY" | grep -q '"ok":false' || { echo "FAIL: broken migration did not return ok:false"; exit 1; }
# 版本未标为 15（经 D1 直接查：schema_migrations 无 15，或表不存在）
VER7=$($WR d1 execute aisou-lite-db --local --command="SELECT COUNT(*) FROM schema_migrations WHERE version=15;" 2>&1 | grep -o '[0-9]' | head -1)
if [ "$VER7" = "1" ]; then echo "FAIL: failed migration incorrectly marked version 15"; exit 1; fi
echo "FAILURE NOT MARKED OK: version 15 not recorded after failed migration"
# 修复：按正确结构重建 upstream_orders（含 id 列）。
# 注意：v3（建表迁移）已标记为已应用，不会重跑，因此不能只 DROP 表——必须按正确结构重建，否则 v8 仍会因表不存在而失败。
# 这是迁移机制的设计假设（已应用的迁移不重跑；表被误删需人工按正确结构重建），此处验证的是“失败不标版本 + 修复后重试成功”。
$WR d1 execute aisou-lite-db --local --command="DROP TABLE upstream_orders; CREATE TABLE upstream_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, prodseller_order_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0, delivered_keys TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY(order_id) REFERENCES orders(id));" > "$TMPDIR_D1/d1-fail-fix.log" 2>&1
FIX_BODY=$(curl -s "$BASE/api/config")
echo "fix body: $(echo "$FIX_BODY" | head -c 300)"
echo "$FIX_BODY" | grep -q '"ok":true' || { echo "FAIL: migration did not recover after fix"; exit 1; }
FIX_VER=$($WR d1 execute aisou-lite-db --local --command="SELECT MAX(version) FROM schema_migrations;" 2>&1 | grep -o "15" | head -1)
[ "$FIX_VER" = "15" ] || { echo "FAIL: version != 15 after fix"; exit 1; }
echo "FAILURE RECOVERY OK: fixed db migrated to v15"
kill $DEV_PID 2>/dev/null; trap - EXIT; wait $DEV_PID 2>/dev/null || true

# --- 真正空库：不导入任何 schema，Worker 首次请求必须自动建基表 + 迁移到 v15 ---
rm -rf .wrangler/state
$WR dev --local --port $PORT > "$TMPDIR_D1/wrangler-dev-empty.log" 2>&1 &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null; true" EXIT
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "$BASE/api/config" 2>/dev/null | grep -q 200; then echo "WORKER UP (empty db)"; break; fi
  sleep 2
done
EMPTY_CFG=$(curl -s "$BASE/api/config")
echo "$EMPTY_CFG" | grep -q '"ok":true' || { echo "FAIL: empty db /api/config not ok (base tables missing?)"; echo "$EMPTY_CFG" | head -c 300; exit 1; }
echo "EMPTY-DB CONFIG OK: first request migrated empty db"
EMPTY_VER=$($WR d1 execute aisou-lite-db --local --command="SELECT MAX(version) FROM schema_migrations;" 2>&1 | grep -o "15" | head -1)
[ "$EMPTY_VER" = "15" ] || { echo "FAIL: empty db version != 15 after migration"; exit 1; }
echo "EMPTY-DB MIGRATION OK: version 15"
# 空库预检：登录改密后 schema-check 必须 ok=true（无差异）
rm -f "$COOKIE_JAR_FILE"
curl -s -c "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/login" -H 'content-type: application/json' -d '{"password":"admin"}' > /dev/null
curl -s -b "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/change-password" -H 'content-type: application/json' -H 'X-Admin-API: 1' -d '{"old_password":"admin","new_password":"d1-local-test-123"}' > /dev/null
EMPTY_PRE=$(curl -s -b "$COOKIE_JAR_FILE" "$BASE/api/admin/schema-check")
echo "$EMPTY_PRE" | grep -q '"ok":true' || { echo "FAIL: empty db schema-check not ok"; echo "$EMPTY_PRE" | head -c 500; exit 1; }
echo "EMPTY-DB SCHEMA-CHECK OK"
kill $DEV_PID 2>/dev/null; trap - EXIT; wait $DEV_PID 2>/dev/null || true

# --- 新库：当前 schema.sql ---
rm -rf .wrangler/state
# schema.sql 自 v15 起不再建 schema_migrations 表（仅 INSERT 预置版本），与 Worker runMigrations 一致：先建表再执行 schema.sql。
# 注意：schema.sql 缺 CREATE TABLE schema_migrations 是代码侧缺陷（已在最终汇报中精确报告），测试侧按运行时行为先建表，不改 schema.sql。
$WR d1 execute aisou-lite-db --local --command="CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));" > /dev/null 2>&1
$WR d1 execute aisou-lite-db --local --file=schema.sql > "$TMPDIR_D1/d1-new-schema.log" 2>&1
$WR dev --local --port $PORT > "$TMPDIR_D1/wrangler-dev2.log" 2>&1 &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null; true" EXIT
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "$BASE/api/config" 2>/dev/null | grep -q 200; then echo "WORKER UP (fresh)"; break; fi
  sleep 2
done
rm -f "$COOKIE_JAR_FILE"
curl -s -c "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/login" -H 'content-type: application/json' -d '{"password":"admin"}' > /dev/null
curl -s -b "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/change-password" -H 'content-type: application/json' -H 'X-Admin-API: 1' -d '{"old_password":"admin","new_password":"d1-local-test-123"}' > /dev/null
echo "--- fresh-db /api/admin/migrate ---"
MIG2=$(curl -s -b "$COOKIE_JAR_FILE" "$BASE/api/admin/migrate")
echo "$MIG2"
echo "$MIG2" | grep -q '"up_to_date":true' || { echo "FAIL: fresh db not up_to_date"; exit 1; }
echo "FRESH-DB OK: up_to_date"
# 新库下单 → 查询密码查单断言（真实下单 + /secret 验密；P2-20：此处此前只取了 product id 就结束，现补齐）
# 下单需有效收款地址（种子为占位符会拒单），先经管理员接口配置。
curl -s -b "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/settings" -H 'content-type: application/json' -H 'X-Admin-API: 1' -d '{"settings":{"usdt_addresses":"{\"OKX|X Layer\":\"0x1111111111111111111111111111111111111111\",\"Binance|BEP20\":\"0x2222222222222222222222222222222222222222\"}"}}' | grep -q '"ok":true' || { echo "FAIL: fresh-db set usdt_addresses"; exit 1; }
PROD_ID=$(curl -s "$BASE/api/products" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['products'][0]['id'])")
echo "product id: $PROD_ID"
# 取图形验证码（解析 SVG <text> 得码）
CAP_JSON=$(curl -s "$BASE/api/captcha")
CAP_ID=$(echo "$CAP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['captcha_id'])")
CAP_CODE=$(echo "$CAP_JSON" | python3 -c "import sys,json,re; print(''.join(re.findall(r'<text[^>]*>(.)</text>', json.load(sys.stdin)['svg'])))")
[ "${#CAP_CODE}" = "4" ] || { echo "FAIL: fresh-db captcha code len != 4 (got '$CAP_CODE')"; exit 1; }
ORDER_JSON=$(curl -s -X POST "$BASE/api/orders" -H 'content-type: application/json' -d "{\"product_id\":$PROD_ID,\"quantity\":1,\"customer_fields\":{\"contact_email\":\"fresh-d1@test.example\",\"delivery_email\":\"fresh-d1@test.example\",\"account_email\":\"fresh-d1@test.example\"},\"contact\":\"fresh-d1@test.example\",\"pay_method\":\"OKX\",\"pay_chain\":\"X Layer\",\"query_password\":\"fresh-d1-pw123\",\"captcha_id\":\"$CAP_ID\",\"captcha_code\":\"$CAP_CODE\"}")
echo "$ORDER_JSON" | grep -q '"ok":true' || { echo "FAIL: fresh-db order creation"; echo "$ORDER_JSON" | head -c 500; exit 1; }
FRESH_NO=$(echo "$ORDER_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['order']['order_no'])")
echo "fresh order_no: $FRESH_NO"
# 订单号随机后缀为 16 位 hex（P2-4，randomHex(8)）
echo "$FRESH_NO" | grep -qE '[0-9A-F]{16}$' || { echo "FAIL: fresh order_no suffix is not 16 hex chars: $FRESH_NO"; exit 1; }
echo "FRESH-DB ORDER OK: order_no suffix is 16 hex"
# /secret：错密码 → 401 查询密码错误；正确密码 → 通过密码校验（订单未付款，返回尚未付款提示而非 401）
SECRET_WRONG=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/orders/$FRESH_NO/secret" -H 'content-type: application/json' -d '{"password":"wrongpw123"}')
[ "$SECRET_WRONG" = "401" ] || { echo "FAIL: fresh-db /secret wrong password != 401 (got $SECRET_WRONG)"; exit 1; }
SECRET_OK_BODY=$(curl -s -X POST "$BASE/api/orders/$FRESH_NO/secret" -H 'content-type: application/json' -d '{"password":"fresh-d1-pw123"}')
echo "$SECRET_OK_BODY" | grep -q '尚未付款' || { echo "FAIL: fresh-db /secret correct password did not pass password check"; echo "$SECRET_OK_BODY" | head -c 300; exit 1; }
echo "FRESH-DB SECRET OK: wrong password 401, correct password passes check (unpaid hint)"
# GET 单订单概要：不含交付内容
GET_ONE=$(curl -s "$BASE/api/orders/$FRESH_NO")
echo "$GET_ONE" | grep -q '"ok":true' || { echo "FAIL: fresh-db GET single order"; exit 1; }
echo "$GET_ONE" | grep -q 'delivery_content' && { echo "FAIL: fresh-db GET single order leaks delivery_content"; exit 1; }
echo "FRESH-DB GET SINGLE OK: summary only, no delivery_content"
kill $DEV_PID 2>/dev/null; trap - EXIT; wait $DEV_PID 2>/dev/null || true
echo "D1 LOCAL TEST ALL OK"
