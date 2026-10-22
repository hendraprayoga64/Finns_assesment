'use strict';
// BigQuery access. Auth = Application Default Credentials (Cloud Run runtime service account). No JSON key anywhere.
const MODE = process.env.BQ_MODE || 'mock';
const DS = process.env.BQ_DATASET || 'hospitality_dw';
const { days } = require('./netsuite');

let _bq;
const bq = () => (_bq ||= new (require('@google-cloud/bigquery').BigQuery)({ projectId: process.env.GCP_PROJECT }));

const MOCK_LOCATIONS = [
  { location_id: 'LOC-001', location_name: 'Lobby Restaurant', area: 'Restaurant' },
  { location_id: 'LOC-002', location_name: 'Beach Club', area: 'Leisure' },
  { location_id: 'LOC-003', location_name: 'Spa', area: 'Wellness' },
];
const mockVisitors = (loc, date) => 40 + ([...(loc + date)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 120);

/** ONE query for MANY (location, date) pairs - this is what the DataLoader batch function calls. */
async function visitorsByLocationDate(pairs) {
  console.log(`[BQ] visitorsByLocationDate: 1 query for ${pairs.length} keys`);
  if (MODE === 'mock') return pairs.map((p) => ({ location_id: p.locationId, date: p.date, visitors: mockVisitors(p.locationId, p.date) }));
  const dates = [...new Set(pairs.map((p) => p.date))].sort();
  const [rows] = await bq().query({
    query: `SELECT location_id, CAST(event_date AS STRING) AS date, SUM(in_count) AS visitors
            FROM \`${DS}.fact_iot_camera_events\`
            WHERE event_date BETWEEN DATE(@minDate) AND DATE(@maxDate)         -- partition pruning
              AND location_id IN UNNEST(@locationIds)
              AND CAST(event_date AS STRING) IN UNNEST(@dates)
            GROUP BY location_id, date`,
    params: { minDate: dates[0], maxDate: dates.at(-1), locationIds: [...new Set(pairs.map((p) => p.locationId))], dates },
    types: { minDate: 'STRING', maxDate: 'STRING', locationIds: ['STRING'], dates: ['STRING'] },
  });
  return rows;
}

async function locationsByIds(ids) {
  console.log(`[BQ] locationsByIds: 1 query for ${ids.length} keys`);
  if (MODE === 'mock') return MOCK_LOCATIONS.filter((l) => ids.includes(l.location_id));
  const [rows] = await bq().query({
    query: `SELECT location_id, location_name, area FROM \`${DS}.dim_location\` WHERE location_id IN UNNEST(@ids)`,
    params: { ids }, types: { ids: ['STRING'] },
  });
  return rows;
}

async function visitorCountsRange({ from, to, locationId }) {
  if (MODE === 'mock') {
    return MOCK_LOCATIONS.filter((l) => !locationId || l.location_id === locationId)
      .flatMap((l) => [...days(from, to)].map((d) => ({ location_id: l.location_id, date: d, visitors: mockVisitors(l.location_id, d) })));
  }
  const [rows] = await bq().query({
    query: `SELECT location_id, CAST(event_date AS STRING) AS date, SUM(in_count) AS visitors
            FROM \`${DS}.fact_iot_camera_events\`
            WHERE event_date BETWEEN DATE(@from) AND DATE(@to) AND (@loc IS NULL OR location_id = @loc)
            GROUP BY location_id, date ORDER BY date, location_id`,
    params: { from, to, loc: locationId || null }, types: { from: 'STRING', to: 'STRING', loc: 'STRING' },
  });
  return rows;
}
module.exports = { visitorsByLocationDate, locationsByIds, visitorCountsRange };
