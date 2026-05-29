/**
 * Keep-alive HTTP for Gamma / CLOB / Data API (Node fetch + undici Agent).
 */

const { Agent } = require('undici');

const gammaAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 120_000,
  connections: 6,
});

const clobAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 120_000,
  connections: 10,
});

const dataAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 120_000,
  connections: 4,
});

const DEFAULT_HEADERS = {
  // Polymarket may return brotli without Content-Encoding when using undici Agent;
  // identity avoids compressed bodies that break res.json().
  'Accept-Encoding': 'identity',
};

function mergeHeaders(opts = {}) {
  const incoming = opts.headers instanceof Headers
    ? Object.fromEntries(opts.headers.entries())
    : { ...(opts.headers || {}) };
  return { ...DEFAULT_HEADERS, ...incoming };
}

/**
 * @param {string} url
 * @param {RequestInit} [opts]
 * @param {import('undici').Agent} [agent]
 */
function fetchWithAgent(url, opts = {}, agent = clobAgent) {
  return fetch(url, {
    ...opts,
    headers: mergeHeaders(opts),
    dispatcher: agent,
  });
}

function fetchGamma(url, opts = {}) {
  return fetchWithAgent(url, opts, gammaAgent);
}

function fetchClob(url, opts = {}) {
  return fetchWithAgent(url, opts, clobAgent);
}

function fetchDataApi(url, opts = {}) {
  return fetchWithAgent(url, opts, dataAgent);
}

module.exports = {
  gammaAgent,
  clobAgent,
  dataAgent,
  fetchWithAgent,
  fetchGamma,
  fetchClob,
  fetchDataApi,
};
