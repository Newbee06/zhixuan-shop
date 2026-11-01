-- 只读查重。不要执行任何 UPDATE / DELETE。
-- 找出 payments、txid_claims 里规范化成 0x+小写后会变成同一笔的行。
-- kind = cross_order：不同订单（或一边未归属）冲突。迁移必须失败，把这些行交给人工对账，禁止自动合并或删除。
-- kind = same_order：同一订单的重复行。迁移可以合并成一行，再把保留行改成规范形。冲突清零前不要建唯一索引。
-- 规范表达式与 src/worker.js 的 TX_CANON_EXPR、v21 迁移保持一致。

WITH claim_norm AS (
  SELECT
    tx_hash,
    order_id,
    CASE
      WHEN length(tx_hash)=66 AND lower(substr(tx_hash,1,2))='0x' AND length(substr(tx_hash,3))=64 AND lower(substr(tx_hash,3)) NOT GLOB '*[^0-9a-f]*' THEN '0x'||lower(substr(tx_hash,3))
      WHEN length(tx_hash)=64 AND lower(tx_hash) NOT GLOB '*[^0-9a-f]*' THEN '0x'||lower(tx_hash)
      ELSE tx_hash
    END AS norm
  FROM txid_claims
),
claim_dup AS (
  SELECT
    'txid_claims' AS table_name,
    norm,
    COUNT(*) AS n,
    COUNT(DISTINCT order_id) AS distinct_orders,
    GROUP_CONCAT(tx_hash || ' order=' || order_id, ' | ') AS rows
  FROM claim_norm
  GROUP BY norm
  HAVING COUNT(*) > 1
),
pay_norm AS (
  SELECT
    id,
    order_id,
    chain,
    event_key,
    tx_hash,
    CASE
      WHEN length(tx_hash)=66 AND lower(substr(tx_hash,1,2))='0x' AND length(substr(tx_hash,3))=64 AND lower(substr(tx_hash,3)) NOT GLOB '*[^0-9a-f]*' THEN '0x'||lower(substr(tx_hash,3))
      WHEN length(tx_hash)=64 AND lower(tx_hash) NOT GLOB '*[^0-9a-f]*' THEN '0x'||lower(tx_hash)
      ELSE tx_hash
    END AS norm
  FROM payments
),
pay_dup AS (
  SELECT
    'payments' AS table_name,
    chain || ' / ' || norm || ' / ' || event_key AS norm,
    COUNT(*) AS n,
    COUNT(DISTINCT IFNULL(order_id, -1)) AS distinct_orders,
    GROUP_CONCAT('#' || id || ' ' || tx_hash || ' order=' || IFNULL(CAST(order_id AS TEXT), 'NULL'), ' | ') AS rows
  FROM pay_norm
  GROUP BY chain, norm, event_key
  HAVING COUNT(*) > 1
)
SELECT
  table_name,
  CASE WHEN distinct_orders > 1 THEN 'cross_order' ELSE 'same_order' END AS kind,
  norm,
  n,
  distinct_orders,
  rows
FROM claim_dup
UNION ALL
SELECT
  table_name,
  CASE WHEN distinct_orders > 1 THEN 'cross_order' ELSE 'same_order' END AS kind,
  norm,
  n,
  distinct_orders,
  rows
FROM pay_dup
ORDER BY kind, table_name, norm;
