'use strict';
const { getNetSuiteCredentials } = require('./secrets');

let token = null; // { value, exp }
async function getAccessToken() {
  if (token && token.exp > Date.now() + 30_000) return token.value;
  const c = await getNetSuiteCredentials();
  const res = await fetch(c.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`NetSuite token endpoint HTTP ${res.status}`);
  const j = await res.json();
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
function* days(from, to) {
  for (const d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    yield d.toISOString().slice(0, 10);
  }
}

function mockTransactions({ from, to, locationId }) {
  const locs = ['LOC-001', 'LOC-002', 'LOC-003'].filter((l) => !locationId || l === locationId);
  const out = [];
  for (const date of days(from, to)) {
    for (const loc of locs) {
      const n = 3 + (hash(date + loc) % 5);
      for (let i = 0; i < n; i++) {
        out.push({ id: `TX-${loc}-${date}-${i}`, locationId: loc, date, transactionTime: `${date}T${String(10 + i).padStart(2, '0')}:15:00+08:00`,
                   amount: 50000 + ((hash(date + loc + i) % 40) * 12500), currency: 'IDR' });
      }
    }
  }
  return out;
}

async function getTransactions({ from, to, locationId, limit }) {
  if (process.env.NETSUITE_MODE !== 'live') return mockTransactions({ from, to, locationId }).slice(0, limit);
  const token = await getAccessToken();
  const qs = new URLSearchParams({ from, to, limit: String(limit), ...(locationId && { locationId }) });
  const res = await fetch(`${process.env.NETSUITE_REST_URL}/transactions?${qs}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`NetSuite HTTP ${res.status}`);
  return (await res.json()).items; // adapt mapping to the real NetSuite payload
}
module.exports = { getTransactions, days };
