-- ============================================================================
-- Module 4 - BigQuery Star Schema (Standard SQL)  -  DDL ONLY
-- Run this file ONCE. Then load sql/sample_data/*.jsonl and run conversion_rate_query.sql.
-- Grain:  fact_transactions        = 1 row per NetSuite transaction
--         fact_iot_camera_events   = 1 row per camera people-count reading
-- Both facts share conformed dimensions: dim_location + dim_date  => enables conversion-rate analysis.
-- Note: BigQuery PK/FK are NOT ENFORCED (metadata for the optimizer / BI tools only).
-- ============================================================================
-- No explicit location: the dataset is created in the region the query runs in (US by default in the Sandbox).
-- In production, pin it, e.g.  OPTIONS (location = 'asia-southeast2')  and run the query in that same region.
CREATE SCHEMA IF NOT EXISTS hospitality_dw;

-- ---------- DIMENSIONS ----------
CREATE TABLE IF NOT EXISTS hospitality_dw.dim_location (
  location_id    STRING NOT NULL,        -- business key shared by NetSuite & cameras (edge can write it without a lookup)
  location_name  STRING NOT NULL,
  area           STRING,                 -- e.g. Restaurant, Spa, Beach Club
  property_name  STRING,
  floor_level    STRING,
  timezone       STRING DEFAULT 'Asia/Makassar',
  is_active      BOOL   DEFAULT TRUE,
  PRIMARY KEY (location_id) NOT ENFORCED
);

-- dim_date is built with CREATE TABLE AS SELECT (DDL), NOT INSERT (DML), so it also works in the free tier / Sandbox,
-- where DML is blocked. The primary key is added afterwards (metadata only, not enforced); run that ALTER only once.
CREATE TABLE IF NOT EXISTS hospitality_dw.dim_date AS
SELECT d                                   AS date_key,
       EXTRACT(YEAR FROM d)                AS cal_year,
       EXTRACT(QUARTER FROM d)             AS cal_quarter,
       EXTRACT(MONTH FROM d)               AS cal_month,
       FORMAT_DATE('%B', d)                AS month_name,
       EXTRACT(DAY FROM d)                 AS day_of_month,
       EXTRACT(DAYOFWEEK FROM d)           AS day_of_week,   -- 1 = Sunday ... 7 = Saturday
       FORMAT_DATE('%A', d)                AS day_name,
       EXTRACT(DAYOFWEEK FROM d) IN (1, 7) AS is_weekend
FROM UNNEST(GENERATE_DATE_ARRAY('2024-01-01', '2030-12-31')) AS d;

ALTER TABLE hospitality_dw.dim_date ADD PRIMARY KEY (date_key) NOT ENFORCED;

-- ---------- FACTS ----------
CREATE TABLE IF NOT EXISTS hospitality_dw.fact_transactions (
  transaction_id        STRING    NOT NULL,       -- NetSuite transaction number (de-dup key)
  transaction_ts        TIMESTAMP NOT NULL,
  transaction_date      DATE      NOT NULL,       -- local property date (Asia/Makassar) -> dim_date
  location_id           STRING    NOT NULL,       -- -> dim_location
  netsuite_internal_id  STRING,
  status                STRING,                   -- COMPLETED | VOIDED ...
  item_count            INT64,
  amount                NUMERIC,
  tax_amount            NUMERIC,
  currency              STRING,
  ingested_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT fk_tx_loc  FOREIGN KEY (location_id)      REFERENCES hospitality_dw.dim_location (location_id) NOT ENFORCED,
  CONSTRAINT fk_tx_date FOREIGN KEY (transaction_date) REFERENCES hospitality_dw.dim_date (date_key)        NOT ENFORCED
)
PARTITION BY transaction_date
CLUSTER BY location_id;

CREATE TABLE IF NOT EXISTS hospitality_dw.fact_iot_camera_events (
  event_id      STRING    NOT NULL,               -- camera event id / hash (de-dup key)
  event_ts      TIMESTAMP NOT NULL,
  event_date    DATE      NOT NULL,               -- local property date (Asia/Makassar) -> dim_date
  camera_id     STRING    NOT NULL,
  location_id   STRING    NOT NULL,               -- -> dim_location
  in_count      INT64,                            -- people entering in the interval
  out_count     INT64,
  ingested_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT fk_iot_loc  FOREIGN KEY (location_id) REFERENCES hospitality_dw.dim_location (location_id) NOT ENFORCED,
  CONSTRAINT fk_iot_date FOREIGN KEY (event_date)  REFERENCES hospitality_dw.dim_date (date_key)        NOT ENFORCED
)
PARTITION BY event_date
CLUSTER BY location_id, camera_id;
