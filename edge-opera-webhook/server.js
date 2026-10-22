'use strict';
/**
 * Edge Middleware (Opera PMS bridge)
 * POST /webhook/opera  -> validate Bearer -> persist to outbox -> 202 immediately
 * Background worker    -> sign (HMAC-SHA256) -> push to NetSuite -> retry w/ backoff
 */
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const cfg = {
  port: Number(process.env.PORT || 3000),
  operaToken: process.env.OPERA_BEARER_TOKEN,
  netsuiteUrl: process.env.NETSUITE_URL,
  hmacSecret: process.env.NETSUITE_HMAC_SECRET,
  dbPath: process.env.QUEUE_DB_PATH || './queue.db',
  maxAttempts: Number(process.env.MAX_ATTEMPTS || 8),
};
for (const k of ['operaToken', 'netsuiteUrl', 'hmacSecret']) {
  if (!cfg[k]) { console.error(`FATAL missing config: ${k}`); process.exit(1); }
}

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));

/* ---------- Durable outbox (SQLite) : survives crash / reboot / NetSuite downtime ---------- */
const db = new Database(cfg.dbPath);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS outbox (
  idempotency_key TEXT PRIMARY KEY,           -- <- the idempotency guarantee lives here
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | sent | dead
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  created_at      INTEGER NOT NULL
)`);
// Crash recovery: anything left 'processing' by a previous run goes back to pending.
db.prepare(`UPDATE outbox SET status='pending' WHERE status='processing'`).run();

const stmt = {
  insert: db.prepare(`INSERT OR IGNORE INTO outbox (idempotency_key,payload,next_attempt_at,created_at) VALUES (?,?,?,?)`),
  due: db.prepare(`SELECT * FROM outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT 10`),
  processing: db.prepare(`UPDATE outbox SET status='processing' WHERE idempotency_key=?`),
  sent: db.prepare(`UPDATE outbox SET status='sent', last_error=NULL WHERE idempotency_key=?`),
  retry: db.prepare(`UPDATE outbox SET status='pending', attempts=?, next_attempt_at=?, last_error=? WHERE idempotency_key=?`),
  dead: db.prepare(`UPDATE outbox SET status='dead', attempts=?, last_error=? WHERE idempotency_key=?`),
};

/* ---------- Auth middleware: Bearer token (constant-time compare) ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest(); // fixed length => timingSafeEqual never throws
function bearerAuth(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!m) return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'missing_bearer_token' });
  if (!crypto.timingSafeEqual(sha(m[1]), sha(cfg.operaToken))) {
    log('warn', 'invalid bearer token', { ip: req.ip });
    return res.status(403).json({ error: 'invalid_token' });
  }
  next();
}

/* ---------- HTTP layer ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/webhook/opera', bearerAuth, (req, res) => {
  if (!req.rawBody || !req.rawBody.length) return res.status(400).json({ error: 'empty_or_non_json_body' });

  // Idempotency key: prefer the one Opera sends; fall back to SHA-256 of the exact raw body.
  const key = req.get('Idempotency-Key') || crypto.createHash('sha256').update(req.rawBody).digest('hex');
  const now = Date.now();
  const r = stmt.insert.run(key, req.rawBody.toString('utf8'), now, now);

  // Respond 202 immediately; the push to NetSuite happens in the background worker.
  res.status(202).json({ status: 'accepted', idempotencyKey: key, duplicate: r.changes === 0 });
});

app.use((err, _req, res, _next) => {            // malformed JSON etc.
  log('warn', 'request error', { err: err.message });
  res.status(err.status || 400).json({ error: 'bad_request' });
});

/* ---------- Background worker: HMAC-SHA256 signing + delivery + retry ---------- */
function sign(body, ts, nonce) {
  // Signed string = "<timestamp>.<nonce>.<raw body>"  -> prevents tampering AND replay.
  return crypto.createHmac('sha256', cfg.hmacSecret).update(`${ts}.${nonce}.${body}`).digest('hex');
}

async function pushToNetSuite(row) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const res = await fetch(cfg.netsuiteUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': ts,
      'X-Nonce': nonce,
      'X-Signature': `sha256=${sign(row.payload, ts, nonce)}`,
      'Idempotency-Key': row.idempotency_key,     // lets NetSuite de-dup our retries too
    },
    body: row.payload,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) { const e = new Error(`NetSuite HTTP ${res.status}`); e.status = res.status; throw e; }
}

let busy = false;
async function drain() {
  if (busy) return;
  busy = true;
  try {
    for (const row of stmt.due.all(Date.now())) {
      stmt.processing.run(row.idempotency_key);
      try {
        await pushToNetSuite(row);
        stmt.sent.run(row.idempotency_key);
        log('info', 'delivered to NetSuite', { key: row.idempotency_key });
      } catch (e) {
        const attempts = row.attempts + 1;
        const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
        const permanent = e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status);
        log('error', timedOut ? 'TIMEOUT calling NetSuite' : 'push failed', { key: row.idempotency_key, attempts, err: e.message });
        if (permanent || attempts >= cfg.maxAttempts) {
          stmt.dead.run(attempts, e.message, row.idempotency_key);    // needs manual attention
        } else {
          const backoff = Math.min(2 ** attempts * 1000, 300_000) + Math.random() * 1000;
          stmt.retry.run(attempts, Date.now() + backoff, e.message, row.idempotency_key);
        }
      }
    }
  } finally { busy = false; }
}
const timer = setInterval(drain, 2000);

const server = app.listen(cfg.port, () => log('info', `opera webhook listening on :${cfg.port}`));
function shutdown(sig) {
  log('info', `${sig} received, shutting down`);
  clearInterval(timer);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
