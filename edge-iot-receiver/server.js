'use strict';
/**
 * Edge Middleware (IoT)
 * POST /api/v1/iot/people-count  -> validate static API key -> buffer in SQLite -> 202
 * Every 60 s                     -> ONE batched insert into BigQuery (micro-batching)
 */
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');

const cfg = {
  port: Number(process.env.PORT || 3100),
  apiKey: process.env.IOT_API_KEY,
  flushMs: Number(process.env.FLUSH_INTERVAL_MS || 60_000),
  batchSize: Number(process.env.BATCH_SIZE || 500),
  dbPath: process.env.BUFFER_DB_PATH || './iot-buffer.db',
  bqMode: process.env.BQ_MODE || 'mock',
  dataset: process.env.BQ_DATASET || 'hospitality_dw',
  table: process.env.BQ_TABLE || 'fact_iot_camera_events',
  tz: 'Asia/Makassar',
};
if (!cfg.apiKey) { console.error('FATAL missing IOT_API_KEY'); process.exit(1); }
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));

/* ---------- Local buffer (SQLite): no data loss if BigQuery/internet is down or the process restarts ---------- */
const db = new Database(cfg.dbPath);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS buffer (
  event_id TEXT PRIMARY KEY, event_ts TEXT NOT NULL, camera_id TEXT NOT NULL, location_id TEXT NOT NULL,
  in_count INTEGER NOT NULL, out_count INTEGER NOT NULL)`);
const insertEvt = db.prepare(`INSERT OR IGNORE INTO buffer VALUES (@event_id,@event_ts,@camera_id,@location_id,@in_count,@out_count)`);
const selectBatch = db.prepare(`SELECT * FROM buffer ORDER BY rowid LIMIT ?`);

/* ---------- BigQuery sink ---------- */
let table;
async function bqInsert(rows) {
  if (cfg.bqMode === 'mock') {
    fs.appendFileSync('./bq-mock.jsonl', rows.map((r) => JSON.stringify(r.json)).join('\n') + '\n');
    return;
  }
  if (!table) {
    const { BigQuery } = require('@google-cloud/bigquery');
    // Credentials come from ADC -> GOOGLE_APPLICATION_CREDENTIALS = WIF config (no private key inside).
    table = new BigQuery({ projectId: process.env.GCP_PROJECT }).dataset(cfg.dataset).table(cfg.table);
  }
  await table.insert(rows, { raw: true });   // raw:true => {insertId, json}; insertId = best-effort BQ de-dup
}

/* ---------- Auth middleware: static API key (constant-time compare) ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest();
function apiKeyAuth(req, res, next) {
  const key = req.get('X-API-Key') || '';
  if (!key) return res.status(401).json({ error: 'missing_api_key' });
  if (!crypto.timingSafeEqual(sha(key), sha(cfg.apiKey))) {
    log('warn', 'invalid api key', { ip: req.ip });
    return res.status(403).json({ error: 'invalid_api_key' });
  }
  next();
}

/* ---------- Strict payload validation ---------- */
const isCount = (n) => Number.isInteger(n) && n >= 0 && n < 1_000_000;
function validate(b) {
  const errors = [];
  if (!b || typeof b !== 'object') return ['body must be a JSON object'];
  if (typeof b.camera_id !== 'string' || !b.camera_id) errors.push('camera_id required');
  if (typeof b.location_id !== 'string' || !b.location_id) errors.push('location_id required');
  if (typeof b.timestamp !== 'string' || Number.isNaN(Date.parse(b.timestamp))) errors.push('timestamp must be ISO-8601');
  if (!isCount(b.in_count)) errors.push('in_count must be a non-negative integer');
  if (!isCount(b.out_count)) errors.push('out_count must be a non-negative integer');
  return errors;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/api/v1/iot/people-count', apiKeyAuth, (req, res) => {
  const errors = validate(req.body);
  if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });
  const b = req.body;
  const eventTs = new Date(b.timestamp).toISOString();
  const event_id = b.event_id || crypto.createHash('sha256').update(`${b.camera_id}|${eventTs}`).digest('hex');
  const r = insertEvt.run({ event_id, event_ts: eventTs, camera_id: b.camera_id, location_id: b.location_id, in_count: b.in_count, out_count: b.out_count });
  res.status(202).json({ status: 'buffered', eventId: event_id, duplicate: r.changes === 0 });
});

app.use((err, _req, res, _next) => { res.status(err.status || 400).json({ error: 'bad_request' }); });

/* ---------- Micro-batching: flush the buffer to BigQuery every 60 s ---------- */
const localDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: cfg.tz }).format(new Date(iso)); // YYYY-MM-DD
let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    let total = 0;
    for (;;) {
      const rows = selectBatch.all(cfg.batchSize);
      if (!rows.length) break;
      const now = new Date().toISOString();
      await bqInsert(rows.map((r) => ({
        insertId: r.event_id,
        json: { event_id: r.event_id, event_ts: r.event_ts, event_date: localDate(r.event_ts), camera_id: r.camera_id,
                location_id: r.location_id, in_count: r.in_count, out_count: r.out_count, ingested_at: now },
      })));
      // Delete only AFTER BigQuery acknowledged => at-least-once delivery; insertId de-dups retries.
      db.prepare(`DELETE FROM buffer WHERE event_id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((r) => r.event_id));
      total += rows.length;
    }
    if (total) log('info', 'flushed batch to BigQuery', { rows: total });
  } catch (e) {
    log('error', 'BigQuery flush failed - rows kept in buffer, will retry next tick', { err: e.message });
  } finally { flushing = false; }
}
const timer = setInterval(flush, cfg.flushMs);

const server = app.listen(cfg.port, () => log('info', `iot receiver listening on :${cfg.port}`));
async function shutdown(sig) {
  log('info', `${sig} received: final flush`);
  clearInterval(timer);
  server.close();
  await flush();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
