#!/bin/bash
# D1 本地环境迁移验证（仅 --local，绝不碰 --remote 生产库）
# 覆盖：
#  1. 旧库（去掉 v6/v7 部分，无 schema_migrations）→ Worker 首次请求自动迁移 → 版本=21、旧数据保留
#  2. 旧库重复 upstream_orders 去重（保留每个 order_id 的最新行）+ 唯一索引创建
#  3. 迁移幂等：重复调用 POST /api/admin/migrate，版本仍为 21，不报错、不丢数据
#  4. 迁移失败恢复：上游订单表结构损坏 → 迁移失败（503 migration_failed、不标版本）→ 修复后重试 → 成功到 v21
#  5. 新库（当前 schema.sql）→ 无需迁移、API 正常
#  6. 真正空库（不导入任何 schema）→ Worker 首次请求自动建基表 + 迁移到 v21 + schema-check ok
#  7. v16 索引：旧库/空库迁移后 6 个索引（idx_cards_product、idx_cards_used、idx_orders_no、idx_orders_status、idx_orders_created、idx_sessions_expires）必须存在；新库 schema.sql 自带 6 个索引，与迁移后结构一致
#  8. v17 列：旧库/空库迁移后 txid_claims 必须有 claim_token / source / order_lease_token 三列；新库 schema.sql 自带三列，与迁移后结构一致；旧库预置的遗留认领行保留且三列为默认值
#  9. v18：旧库/空库迁移后 orders 必须有 pending_tx_hash / payment_state 两列 + lookup_attempts 表 + 索引；新库 schema.sql 自带，与迁移后结构一致
# 全部使用虚构数据，不读取、不复制生产数据。
set -e
cd "$(dirname "$0")/.."
# 优先用仓库锁定的本地 wrangler（package.json + package-lock.json），否则回退 npx（CI 仍需显式版本时见工作流）。
if [ -x "node_modules/.bin/wrangler" ]; then WR="node_modules/.bin/wrangler"; else WR="npx --yes wrangler@4.151.0"; fi

# P3-9：精确解析 wrangler d1 execute --local 的 JSON 输出（不截第一个数字、不拼子串匹配）。
# 用法：VAL=$(d1_json_value "SELECT COUNT(*) AS c FROM ..." "c")
# 输出：指定字段的实际值；空结果输出 EMPTY；SQL/命令失败或 JSON 解析失败时打印错误并返回非零
# （set -e 下即失败退出，不静默放行、不把解析失败当 0/通过）。
d1_json_value() {
  local sql="$1" field="$2" raw
  raw=$($WR d1 execute aisou-lite-db --local --command="$sql" 2>&1) || { echo "FAIL: d1 execute failed: $sql" >&2; echo "$raw" >&2; return 1; }
  FIELD="$field" RAW="$raw" python3 -c '
import json, os, sys
t = os.environ["RAW"]
try:
    d = json.loads(t[t.index("\n["):])
except Exception:
    try:
        d = json.loads(t)
    except Exception:
        print("FAIL: D1 JSON parse failed", file=sys.stderr); print(t[:500], file=sys.stderr); sys.exit(2)
rows = (d[0].get("results") or []) if isinstance(d, list) and d else []
if not rows:
    print("EMPTY"); sys.exit(0)
print(rows[0].get(os.environ["FIELD"], "EMPTY"))
'
}

# 精确解析 /api/admin/migrate 响应中的 current_version（不用 grep 子串匹配）。
# 用法：check_migrate_version "$响应体" 18 "上下文"；非 JSON 或版本不符即失败退出。
check_migrate_version() {
  local body="$1" want="$2" ctx="$3"
  echo "$body" | WANT="$want" CTX="$ctx" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("FAIL: [%s] migrate response is not JSON: %s" % (os.environ["CTX"], e), file=sys.stderr); sys.exit(2)
v = d.get("current_version")
if v != int(os.environ["WANT"]):
    print("FAIL: [%s] migrate current_version != %s (got %r, body=%s)" % (os.environ["CTX"], os.environ["WANT"], v, json.dumps(d)[:300]), file=sys.stderr); sys.exit(1)
print("MIGRATE VERSION OK [%s]: current_version=%s" % (os.environ["CTX"], v))
'
}

# 断言 6 个 v16 索引各恰好存在 1 个（验实际行数，不用 grep 子串）。
# 用法：check_v16_indexes "old-db"；任一索引缺失/重复即失败退出。
check_v16_indexes() {
  local ctx="$1" idx c
  for idx in idx_cards_product idx_cards_used idx_orders_no idx_orders_status idx_orders_created idx_sessions_expires; do
    c=$(d1_json_value "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name='$idx';" "c")
    [ "$c" = "1" ] || { echo "FAIL: [$ctx] v16 index $idx count != 1 (got '$c')"; exit 1; }
  done
  echo "V16 INDEXES OK [$ctx]: 6/6"
}
# 断言 v18：orders 有 pending_tx_hash / payment_state 两列（各恰好 1 列）+ lookup_attempts 表 + 索引。
# 用法：check_v18 "old-db"；任一缺失即失败退出。
check_v18() {
  local ctx="$1" col c
  for col in pending_tx_hash payment_state; do
    c=$(d1_json_value "SELECT COUNT(*) AS c FROM pragma_table_info('orders') WHERE name='$col';" "c")
    [ "$c" = "1" ] || { echo "FAIL: [$ctx] v18 orders column $col count != 1 (got '$c')"; exit 1; }
  done
  c=$(d1_json_value "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='lookup_attempts';" "c")
  [ "$c" = "1" ] || { echo "FAIL: [$ctx] v18 lookup_attempts table missing"; exit 1; }
  c=$(d1_json_value "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name='idx_lookup_attempts_order';" "c")
  [ "$c" = "1" ] || { echo "FAIL: [$ctx] v18 idx_lookup_attempts_order missing"; exit 1; }
  echo "V18 OK [$ctx]: orders 2 cols + lookup_attempts + index"
}
# 断言 v19/v20：pricing_templates、categories、唯一索引 idx_categories_key，以及 3 条内置分类。
check_v20() {
  local ctx="$1" c
  c=$(d1_json_value "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='pricing_templates';" "c")
  [ "$c" = "1" ] || { echo "FAIL: [$ctx] pricing_templates missing"; exit 1; }
  c=$(d1_json_value "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='categories';" "c")
  [ "$c" = "1" ] || { echo "FAIL: [$ctx] categories missing"; exit 1; }
  c=$(d1_json_value "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name='idx_categories_key';" "c")
  [ "$c" = "1" ] || { echo "FAIL: [$ctx] idx_categories_key missing"; exit 1; }
  c=$(d1_json_value "SELECT COUNT(*) AS c FROM categories WHERE cat_key IN ('recharge','account','card');" "c")
  [ "$c" = "3" ] || { echo "FAIL: [$ctx] builtin categories count != 3 (got '$c')"; exit 1; }
  echo "V20 OK [$ctx]: pricing_templates + categories + 3 builtins"
}
# 断言 txid_claims 有 v17 三列（claim_token / source / order_lease_token），各恰好 1 列。
# 用法：check_v17_claim_columns "old-db"；任一列缺失/重复即失败退出。
check_v17_claim_columns() {
  local ctx="$1" col c
  for col in claim_token source order_lease_token; do
    c=$(d1_json_value "SELECT COUNT(*) AS c FROM pragma_table_info('txid_claims') WHERE name='$col';" "c")
    [ "$c" = "1" ] || { echo "FAIL: [$ctx] v17 column $col count != 1 (got '$c')"; exit 1; }
  done
  echo "V17 CLAIM COLUMNS OK [$ctx]: 3/3"
}
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
    r"  pending_tx_hash TEXT NOT NULL DEFAULT '',\n",
    r"  payment_state TEXT NOT NULL DEFAULT '',\n",
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
# v16：旧库模拟须去掉 6 个 v16 索引（否则旧库已含索引，测不到 v16 真正建索引；新库 schema.sql 仍保留它们）。
# 行尾可能带 "-- v16（P2-4）..." 注释，用 [^\n]* 一并去掉。
for _idx_pat in [
    r"CREATE INDEX IF NOT EXISTS idx_cards_product ON cards\(product_id\);[^\n]*\n",
    r"CREATE INDEX IF NOT EXISTS idx_cards_used ON cards\(product_id, is_used, is_disabled\);[^\n]*\n",
    r"CREATE INDEX IF NOT EXISTS idx_orders_no ON orders\(order_no\);[^\n]*\n",
    r"CREATE INDEX IF NOT EXISTS idx_orders_status ON orders\(status\);[^\n]*\n",
    r"CREATE INDEX IF NOT EXISTS idx_orders_created ON orders\(created_at\);[^\n]*\n",
    r"CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions\(expires_at\);[^\n]*\n",
]:
    s = re.sub(_idx_pat, '', s)
for _must_absent in ['idx_cards_product', 'idx_cards_used', 'idx_orders_no', 'idx_orders_status', 'idx_orders_created', 'idx_sessions_expires']:
    assert _must_absent not in s, 'old schema still contains ' + _must_absent
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
$WR dev --local --port $PORT --var ZHIXUAN_SETUP_TOKEN:test-setup-token > "$TMPDIR_D1/wrangler-dev.log" 2>&1 &
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
curl -s -c "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/login" -H 'content-type: application/json' -d '{"setup_token":"test-setup-token"}' | head -c 200; echo
curl -s -b "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/change-password" -H 'content-type: application/json' -H 'X-Admin-API: 1' -d '{"old_password":"","new_password":"d1-local-test-123"}' | head -c 200; echo
echo "--- old-db /api/admin/migrate ---"
MIG=$(curl -s -b "$COOKIE_JAR_FILE" "$BASE/api/admin/migrate")
echo "$MIG"
check_migrate_version "$MIG" 21 "old-db migrate"
echo "OLD-DB MIGRATION OK: version 21"
# 旧数据保留（经 D1 直接查）
$WR d1 execute aisou-lite-db --local --command="SELECT order_no, status FROM orders WHERE order_no='AISOLDD1001';" 2>&1 | grep -q "AISOLDD1001" || { echo "FAIL: old order lost"; exit 1; }
$WR d1 execute aisou-lite-db --local --command="SELECT code FROM cards WHERE code='OLD-D1-CARD-1';" 2>&1 | grep -q "OLD-D1-CARD-1" || { echo "FAIL: old card lost"; exit 1; }
echo "OLD-DB DATA PRESERVED"
# 去重：同一 order_id 只剩 1 行，且保留最新行 PS-OLD-2（精确解析 COUNT，不拼凑单字符；两步解析，避免嵌套引号）
DEDUP_COUNT=$(d1_json_value "SELECT COUNT(*) AS c FROM upstream_orders WHERE order_id=(SELECT id FROM orders WHERE order_no='AISOLDD1001');" "c")
[ "$DEDUP_COUNT" = "1" ] || { echo "FAIL: dedup count != 1 (got '$DEDUP_COUNT')"; exit 1; }
UPSTREAM_KEPT=$($WR d1 execute aisou-lite-db --local --command="SELECT prodseller_order_id FROM upstream_orders WHERE order_id=(SELECT id FROM orders WHERE order_no='AISOLDD1001');" 2>&1)
echo "$UPSTREAM_KEPT" | grep -q "PS-OLD-2" || { echo "FAIL: dedup did not keep latest row PS-OLD-2"; echo "$UPSTREAM_KEPT"; exit 1; }
echo "$UPSTREAM_KEPT" | grep -q "PS-OLD-1" && { echo "FAIL: dedup left stale row PS-OLD-1"; exit 1; }
echo "DEDUP OK: kept latest PS-OLD-2 only"
# 唯一索引存在
$WR d1 execute aisou-lite-db --local --command="SELECT name FROM sqlite_master WHERE type='index' AND name='idx_upstream_orders_order_unique';" 2>&1 | grep -q "idx_upstream_orders_order_unique" || { echo "FAIL: unique index missing"; exit 1; }
echo "UNIQUE INDEX OK: idx_upstream_orders_order_unique"
# v16：旧库迁移后 6 个索引必须存在（旧库模拟已去掉它们）
check_v16_indexes "old-db"
# v17：旧库迁移后 txid_claims 三列必须存在
check_v17_claim_columns "old-db"
# v18：旧库迁移后 orders 两列 + lookup_attempts 表必须存在
check_v18 "old-db"
check_v20 "old-db"
# 幂等：重复迁移两次，版本仍 21，不报错
for i in 1 2; do
  MIGX=$(curl -s -b "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/migrate" -H 'X-Admin-API: 1')
  echo "re-migrate $i: $MIGX"
  check_migrate_version "$MIGX" 21 "re-migrate $i"
  echo "$MIGX" | grep -q '"ok":true' || { echo "FAIL: re-migrate $i not ok"; exit 1; }
done
echo "IDEMPOTENT MIGRATION OK"
# 旧订单查单（POST lookup，旧查询密码 → 概要；首次成功后即迁移为 salted 哈希，明文清空）
# B-P1-6：/lookup 需图形验证码；B-P1-4 起 SVG 不再含 <text> 可解析，故经 D1 直接种子一个已知验证码（code=AB12）。
CAP_HASH=$(python3 -c "import hashlib; print(hashlib.sha256(b'AB12').hexdigest())")
$WR d1 execute aisou-lite-db --local --command="INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES ('d1-lookup-cap', '$CAP_HASH', datetime('now','+5 minutes'), 0);" > /dev/null 2>&1
LOOKUP=$(curl -s -X POST "$BASE/api/orders/AISOLDD1001/lookup" -H 'content-type: application/json' -d '{"credential":"123456","captcha_id":"d1-lookup-cap","captcha_code":"AB12"}')
echo "$LOOKUP" | head -c 400; echo
echo "$LOOKUP" | grep -q '"legacy":true' || { echo "FAIL: old order lookup not legacy"; exit 1; }
echo "OLD-DB LOOKUP OK"

# v17 遗留兼容：模拟 v17 前认领行（仅 3 列写入，三列默认）→ 重复迁移 no-op 后行仍在且三列为默认值（不清空/不重建）
$WR d1 execute aisou-lite-db --local --command="INSERT INTO txid_claims (tx_hash, order_id, claimed_at) VALUES ('legacy-v17-check-tx', (SELECT id FROM orders WHERE order_no='AISOLDD1001'), datetime('now'));" > /dev/null 2>&1
MIGL=$(curl -s -b "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/migrate" -H 'X-Admin-API: 1')
check_migrate_version "$MIGL" 21 "legacy-claim re-migrate"
LEGACY_ROW=$($WR d1 execute aisou-lite-db --local --command="SELECT claim_token, source, order_lease_token FROM txid_claims WHERE tx_hash='legacy-v17-check-tx';" 2>&1)
echo "$LEGACY_ROW" | grep -q "chain_verified" || { echo "FAIL: legacy claim row lost or source default wrong"; echo "$LEGACY_ROW"; exit 1; }
echo "V17 LEGACY CLAIM ROW OK: pre-v17-style row preserved with defaults"

kill $DEV_PID 2>/dev/null; trap - EXIT; wait $DEV_PID 2>/dev/null || true

# --- 迁移失败恢复：损坏 upstream_orders（去掉 id 列）→ 迁移失败不标版本 → 修复后重试成功 ---
rm -rf .wrangler/state
$WR d1 execute aisou-lite-db --local --file="$OLD_SCHEMA" > "$TMPDIR_D1/d1-fail-schema.log" 2>&1
$WR d1 execute aisou-lite-db --local --command="DROP TABLE upstream_orders; CREATE TABLE upstream_orders (order_id INTEGER NOT NULL, prodseller_order_id TEXT NOT NULL DEFAULT '');" > "$TMPDIR_D1/d1-fail-corrupt.log" 2>&1
echo "BROKEN DB SEEDED (upstream_orders without id column)"
$WR dev --local --port $PORT --var ZHIXUAN_SETUP_TOKEN:test-setup-token > "$TMPDIR_D1/wrangler-dev-fail.log" 2>&1 &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null; true" EXIT
for i in $(seq 1 30); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/config" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "503" ]; then echo "WORKER UP (migration failing as expected, HTTP 503 migration_failed)"; break; fi
  if [ "$HTTP_CODE" = "200" ]; then echo "FAIL: broken db unexpectedly migrated OK (HTTP 200)"; exit 1; fi
  sleep 2
done
FAIL_BODY=$(curl -s "$BASE/api/config")
echo "fail body: $(echo "$FAIL_BODY" | head -c 300)"
echo "$FAIL_BODY" | grep -q '"ok":false' || { echo "FAIL: broken migration did not return ok:false"; exit 1; }
# 版本未标为 16（经 D1 直接查：schema_migrations 无 16，或表不存在；精确解析 COUNT，不截第一个数字）
VER17=$(d1_json_value "SELECT COUNT(*) AS c FROM schema_migrations WHERE version=18;" "c")
if [ "$VER17" = "1" ]; then echo "FAIL: failed migration incorrectly marked version 18"; exit 1; fi
echo "FAILURE NOT MARKED OK: version 18 not recorded after failed migration"
# 修复：按正确结构重建 upstream_orders（含 id 列）。
# 注意：v3（建表迁移）已标记为已应用，不会重跑，因此不能只 DROP 表——必须按正确结构重建，否则 v8 仍会因表不存在而失败。
# 这是迁移机制的设计假设（已应用的迁移不重跑；表被误删需人工按正确结构重建），此处验证的是“失败不标版本 + 修复后重试成功”。
$WR d1 execute aisou-lite-db --local --command="DROP TABLE upstream_orders; CREATE TABLE upstream_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, prodseller_order_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0, delivered_keys TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY(order_id) REFERENCES orders(id));" > "$TMPDIR_D1/d1-fail-fix.log" 2>&1
FIX_BODY=$(curl -s "$BASE/api/config")
echo "fix body: $(echo "$FIX_BODY" | head -c 300)"
echo "$FIX_BODY" | grep -q '"ok":true' || { echo "FAIL: migration did not recover after fix"; exit 1; }
FIX_VER=$(d1_json_value "SELECT MAX(version) AS v FROM schema_migrations;" "v")
[ "$FIX_VER" = "21" ] || { echo "FAIL: version != 21 after fix (got '$FIX_VER')"; exit 1; }
echo "FAILURE RECOVERY OK: fixed db migrated to v21"
kill $DEV_PID 2>/dev/null; trap - EXIT; wait $DEV_PID 2>/dev/null || true

# --- 真正空库：不导入任何 schema，Worker 首次请求必须自动建基表 + 迁移到 v21 ---
rm -rf .wrangler/state
$WR dev --local --port $PORT --var ZHIXUAN_SETUP_TOKEN:test-setup-token > "$TMPDIR_D1/wrangler-dev-empty.log" 2>&1 &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null; true" EXIT
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "$BASE/api/config" 2>/dev/null | grep -q 200; then echo "WORKER UP (empty db)"; break; fi
  sleep 2
done
EMPTY_CFG=$(curl -s "$BASE/api/config")
echo "$EMPTY_CFG" | grep -q '"ok":true' || { echo "FAIL: empty db /api/config not ok (base tables missing?)"; echo "$EMPTY_CFG" | head -c 300; exit 1; }
echo "EMPTY-DB CONFIG OK: first request migrated empty db"
EMPTY_VER=$(d1_json_value "SELECT MAX(version) AS v FROM schema_migrations;" "v")
[ "$EMPTY_VER" = "21" ] || { echo "FAIL: empty db version != 21 after migration (got '$EMPTY_VER')"; exit 1; }
echo "EMPTY-DB MIGRATION OK: version 21"
# 空库迁移后 6 个 v16 索引必须存在
check_v16_indexes "empty-db"
# v17：空库迁移后 txid_claims 三列必须存在
check_v17_claim_columns "empty-db"
# v18：空库迁移后 orders 两列 + lookup_attempts 表必须存在
check_v18 "empty-db"
check_v20 "empty-db"
# 空库预检：登录改密后 schema-check 必须 ok=true（无差异）
rm -f "$COOKIE_JAR_FILE"
curl -s -c "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/login" -H 'content-type: application/json' -d '{"setup_token":"test-setup-token"}' > /dev/null
curl -s -b "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/change-password" -H 'content-type: application/json' -H 'X-Admin-API: 1' -d '{"old_password":"","new_password":"d1-local-test-123"}' > /dev/null
EMPTY_PRE=$(curl -s -b "$COOKIE_JAR_FILE" "$BASE/api/admin/schema-check")
echo "$EMPTY_PRE" | grep -q '"ok":true' || { echo "FAIL: empty db schema-check not ok"; echo "$EMPTY_PRE" | head -c 500; exit 1; }
echo "EMPTY-DB SCHEMA-CHECK OK"
kill $DEV_PID 2>/dev/null; trap - EXIT; wait $DEV_PID 2>/dev/null || true

# --- 新库：当前 schema.sql ---
rm -rf .wrangler/state
# schema.sql 建 schema_migrations 表（IF NOT EXISTS）；此处先建表是幂等的安全措施，与 Worker runMigrations 一致。
# （旧注释称 schema.sql 不建该表，与实际文件不符，已纠正；schema.sql 第 233 行起确有 CREATE TABLE schema_migrations。）
$WR d1 execute aisou-lite-db --local --command="CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));" > /dev/null 2>&1
$WR d1 execute aisou-lite-db --local --file=schema.sql > "$TMPDIR_D1/d1-new-schema.log" 2>&1
$WR dev --local --port $PORT --var ZHIXUAN_SETUP_TOKEN:test-setup-token > "$TMPDIR_D1/wrangler-dev2.log" 2>&1 &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null; true" EXIT
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "$BASE/api/config" 2>/dev/null | grep -q 200; then echo "WORKER UP (fresh)"; break; fi
  sleep 2
done
rm -f "$COOKIE_JAR_FILE"
curl -s -c "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/login" -H 'content-type: application/json' -d '{"setup_token":"test-setup-token"}' > /dev/null
curl -s -b "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/change-password" -H 'content-type: application/json' -H 'X-Admin-API: 1' -d '{"old_password":"","new_password":"d1-local-test-123"}' > /dev/null
echo "--- fresh-db /api/admin/migrate ---"
MIG2=$(curl -s -b "$COOKIE_JAR_FILE" "$BASE/api/admin/migrate")
echo "$MIG2"
echo "$MIG2" | grep -q '"up_to_date":true' || { echo "FAIL: fresh db not up_to_date"; exit 1; }
echo "FRESH-DB OK: up_to_date"
# 新库 schema.sql 自带 6 个 v16 索引，与迁移后结构一致
check_v16_indexes "fresh-db"
# v17：新库 schema.sql 自带 txid_claims 三列，与迁移后结构一致
check_v17_claim_columns "fresh-db"
# v18：新库 schema.sql 自带 orders 两列 + lookup_attempts 表，与迁移后结构一致
check_v18 "fresh-db"
check_v20 "fresh-db"
# 新库下单 → 查询密码查单断言（真实下单 + /secret 验密；P2-20：此处此前只取了 product id 就结束，现补齐）
# 下单需有效收款地址（种子为占位符会拒单），先经管理员接口配置。
curl -s -b "$COOKIE_JAR_FILE" -X POST "$BASE/api/admin/settings" -H 'content-type: application/json' -H 'X-Admin-API: 1' -d '{"settings":{"usdt_addresses":"{\"OKX|X Layer\":\"0x1111111111111111111111111111111111111111\",\"Binance|BEP20\":\"0x2222222222222222222222222222222222222222\"}"}}' | grep -q '"ok":true' || { echo "FAIL: fresh-db set usdt_addresses"; exit 1; }
PROD_ID=$(curl -s "$BASE/api/products" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['products'][0]['id'])")
echo "product id: $PROD_ID"
# 图形验证码：B-P1-4 起 SVG 不再含 <text> 可解析，故经 D1 直接种子一个已知验证码（code=AB12）。
CAP_ID="d1-order-cap"
CAP_CODE="AB12"
CAP_HASH=$(python3 -c "import hashlib; print(hashlib.sha256(b'AB12').hexdigest())")
$WR d1 execute aisou-lite-db --local --command="INSERT INTO captcha_codes (id, code_hash, expires_at, attempts) VALUES ('$CAP_ID', '$CAP_HASH', datetime('now','+5 minutes'), 0);" > /dev/null 2>&1
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
