-- Module 4 - sample query: conversion rate (transactions / visitors) for ONE location on ONE date.
-- Run AFTER schema.sql and after loading sql/sample_data/*.jsonl (see README).
-- Expected result with the sample data: Lobby Restaurant | 2026-10-20 | Tuesday | 3 | 52 | 5.77
-- ---------- SAMPLE: conversion rate for ONE location on ONE date ----------
-- Each fact is aggregated to the same grain (location x date) BEFORE joining, otherwise joining two fact tables
-- directly would multiply rows (fan-out) and inflate both numerators and denominators.
WITH tx AS (
  SELECT location_id, transaction_date AS date_key,
         COUNT(DISTINCT transaction_id) AS total_transactions,
         SUM(amount)                    AS total_revenue
  FROM hospitality_dw.fact_transactions
  WHERE status = 'COMPLETED'
    AND transaction_date = DATE '2026-10-20' AND location_id = 'LOC-001'
  GROUP BY location_id, date_key
),
vis AS (
  SELECT location_id, event_date AS date_key, SUM(in_count) AS total_visitors
  FROM hospitality_dw.fact_iot_camera_events
  WHERE event_date = DATE '2026-10-20' AND location_id = 'LOC-001'
  GROUP BY location_id, date_key
)
SELECT dl.location_name,
       dd.date_key AS date,
       dd.day_name,
       COALESCE(tx.total_transactions, 0) AS total_transactions,
       COALESCE(vis.total_visitors, 0)    AS total_visitors,
       ROUND(SAFE_DIVIDE(tx.total_transactions, vis.total_visitors) * 100, 2) AS conversion_rate_pct
FROM hospitality_dw.dim_location dl
CROSS JOIN hospitality_dw.dim_date dd
LEFT JOIN tx  ON tx.location_id  = dl.location_id AND tx.date_key  = dd.date_key
LEFT JOIN vis ON vis.location_id = dl.location_id AND vis.date_key = dd.date_key
WHERE dl.location_id = 'LOC-001' AND dd.date_key = DATE '2026-10-20';
