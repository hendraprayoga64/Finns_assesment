'use strict';
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { getTransactions } = require('./netsuite');
const bq = require('./bigquery');

const typeDefs = /* GraphQL */ `
  type Location { id: ID!, name: String!, area: String }

  "A NetSuite transaction, enriched with IoT visitor data from BigQuery"
  type Transaction {
    id: ID!
    date: String!
    transactionTime: String!
    amount: Float!
    currency: String!
    location: Location
    visitorsAtLocationThatDay: Int!
  }

  "Camera people-count aggregated per location per day (BigQuery)"
  type VisitorCount { date: String!, visitors: Int!, location: Location }

  "Combined dataset: NetSuite transactions + IoT visitors"
  type LocationDailyMetric {
    date: String!
    location: Location
    totalTransactions: Int!
    totalRevenue: Float!
    totalVisitors: Int!
    conversionRate: Float
  }

  type Query {
    transactions(from: String!, to: String!, locationId: ID, limit: Int = 100): [Transaction!]!
    visitorCounts(from: String!, to: String!, locationId: ID): [VisitorCount!]!
    dailyMetrics(from: String!, to: String!, locationId: ID): [LocationDailyMetric!]!
  }
`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function checkRange(from, to) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error('Dates must be YYYY-MM-DD');
  if (new Date(to) < new Date(from)) throw new Error('"to" must be >= "from"');
  if ((new Date(to) - new Date(from)) / 864e5 > 92) throw new Error('Range too large (max 93 days)');
}
const toLocation = (r) => r && { id: r.location_id, name: r.location_name, area: r.area };

const resolvers = {
  Query: {
    transactions: (_p, { from, to, locationId, limit }) => {
      checkRange(from, to);
      return getTransactions({ from, to, locationId, limit: Math.min(limit, 1000) });
    },
    visitorCounts: async (_p, { from, to, locationId }) => {
      checkRange(from, to);
      return bq.visitorCountsRange({ from, to, locationId });          // read directly from BigQuery (IoT bypassed us)
    },
    dailyMetrics: async (_p, { from, to, locationId }, { loaders }) => {
      checkRange(from, to);
      const txs = await getTransactions({ from, to, locationId, limit: 1000 });
      const groups = new Map();
      for (const t of txs) {
        const k = `${t.locationId}|${t.date}`;
        const g = groups.get(k) || { date: t.date, locationId: t.locationId, totalTransactions: 0, totalRevenue: 0 };
        g.totalTransactions++; g.totalRevenue += t.amount; groups.set(k, g);
      }
      // N groups -> N loader.load() calls -> coalesced into ONE BigQuery query
      return Promise.all([...groups.entries()].map(async ([k, g]) => {
        const totalVisitors = await loaders.visitors.load(k);
        return { ...g, totalVisitors, conversionRate: totalVisitors ? g.totalTransactions / totalVisitors : null };
      }));
    },
  },
  Transaction: {
    location: (t, _a, { loaders }) => loaders.location.load(t.locationId).then(toLocation),
    visitorsAtLocationThatDay: (t, _a, { loaders }) => loaders.visitors.load(`${t.locationId}|${t.date}`),
  },
  VisitorCount: {
    location: (v, _a, { loaders }) => loaders.location.load(v.location_id).then(toLocation),
    visitors: (v) => Number(v.visitors),
  },
  LocationDailyMetric: {
    location: (m, _a, { loaders }) => loaders.location.load(m.locationId).then(toLocation),
  },
};

module.exports = { schema: makeExecutableSchema({ typeDefs, resolvers }) };
