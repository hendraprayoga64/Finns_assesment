'use strict';
// NetSuite OAuth2 credentials live in GCP Secret Manager as ONE JSON secret:
//   {"tokenUrl":"...","clientId":"...","clientSecret":"..."}
// Cloud Run's runtime service account (secretAccessor on THIS secret only) reads it via ADC - no keys in code.
const TTL_MS = 5 * 60 * 1000;
let cache = null;

async function getNetSuiteCredentials() {
  if (process.env.SECRETS_MODE !== 'live') {
    return { tokenUrl: 'http://mock/token', clientId: 'mock-client', clientSecret: 'mock-secret' };
  }
  if (cache && cache.exp > Date.now()) return cache.value;      // cache => fewer API calls, fast rotation pickup
  const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const name = `projects/${process.env.GCP_PROJECT}/secrets/${process.env.NETSUITE_SECRET_NAME || 'netsuite-oauth'}` +
               `/versions/${process.env.NETSUITE_SECRET_VERSION || 'latest'}`;
  const [version] = await client.accessSecretVersion({ name });
  const value = JSON.parse(version.payload.data.toString('utf8'));
  cache = { value, exp: Date.now() + TTL_MS };
  return value;                                                  // never logged, never written to disk
}
module.exports = { getNetSuiteCredentials };
