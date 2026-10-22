'use strict';
const DataLoader = require('dataloader');
const bq = require('./bigquery');

// Loaders are created PER REQUEST (cache must never leak between users/requests).
function createLoaders() {
  return {
    // N parent rows asking for their Location -> 1 BigQuery query
    location: new DataLoader(async (ids) => {
      const rows = await bq.locationsByIds([...ids]);
      const byId = new Map(rows.map((r) => [r.location_id, r]));
      return ids.map((id) => byId.get(id) || null);            // result order MUST match key order
    }),
    // N (location,date) pairs asking for visitors -> 1 BigQuery query
    visitors: new DataLoader(async (keys) => {
      const pairs = keys.map((k) => { const [locationId, date] = k.split('|'); return { locationId, date }; });
      const rows = await bq.visitorsByLocationDate(pairs);
      const byKey = new Map(rows.map((r) => [`${r.location_id}|${r.date}`, Number(r.visitors)]));
      return keys.map((k) => byKey.get(k) ?? 0);
    }),
  };
}
module.exports = { createLoaders };
