'use strict';
const express = require('express');
const { createHandler } = require('graphql-http/lib/use/express');
const { schema } = require('./schema');
const { createLoaders } = require('./loaders');

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// In production Cloud Run is deployed with --no-allow-unauthenticated: callers (BI backend) must present a
// Google-signed ID token and hold roles/run.invoker, so no auth code is needed in the app itself.
app.post('/graphql', express.json({ limit: '100kb' }), createHandler({
  schema,
  context: () => ({ loaders: createLoaders() }),      // fresh DataLoaders per request
}));

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`GraphQL server on :${port}/graphql  (BQ_MODE=${process.env.BQ_MODE || 'mock'})`));
