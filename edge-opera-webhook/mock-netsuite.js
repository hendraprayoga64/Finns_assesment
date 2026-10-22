'use strict';
// Tiny NetSuite stand-in: verifies the HMAC signature. FAIL_RATE=0.5 simulates outages (tests retry/idempotency).
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const secret = process.env.NETSUITE_HMAC_SECRET || 'change-me-shared-hmac-secret';
const failRate = Number(process.env.FAIL_RATE || 0);
const seen = new Set();
const app = express();
app.use(express.json({ verify: (req, _r, buf) => { req.raw = buf.toString('utf8'); } }));
app.post('/netsuite', (req, res) => {
  const ts = req.get('X-Timestamp'), nonce = req.get('X-Nonce');
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${nonce}.${req.raw}`).digest('hex');
  const given = req.get('X-Signature') || '';
  const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) { console.log('BAD SIGNATURE'); return res.status(401).end(); }
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.status(401).json({ error: 'stale_timestamp' });
  if (Math.random() < failRate) { console.log('simulated 503'); return res.status(503).end(); }
  const key = req.get('Idempotency-Key');
  console.log(seen.has(key) ? 'DUPLICATE ignored' : 'ACCEPTED', key);
  seen.add(key);
  res.json({ ok: true });
});
app.listen(4000, () => console.log('mock NetSuite on :4000'));
