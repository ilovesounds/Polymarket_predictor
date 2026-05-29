/**
 * Env gates for optional NATS and Chainlink (shared by bot, dashboard, bridges).
 */

const DEFAULT_PUBLIC_POLYGON_RPC = 'https://polygon-rpc.com';

function isNatsEnabled(env = process.env, urlOverride) {
  if (env.USE_NATS === 'false') return false;
  const url = String(urlOverride ?? env.NATS_URL ?? 'nats://127.0.0.1:4222').trim();
  return url.length > 0 && url.toLowerCase() !== 'disabled';
}

function isChainlinkEnabled(env = process.env) {
  const rpc = String(env.POLYGON_RPC || '').trim();
  if (String(env.ENABLE_CHAINLINK || '').toLowerCase() === 'true') {
    return Boolean(rpc);
  }
  if (!rpc) return false;
  if (rpc === DEFAULT_PUBLIC_POLYGON_RPC) return false;
  return true;
}

function resolvePolygonRpc(env = process.env) {
  const rpc = String(env.POLYGON_RPC || '').trim();
  return rpc || DEFAULT_PUBLIC_POLYGON_RPC;
}

module.exports = {
  DEFAULT_PUBLIC_POLYGON_RPC,
  isNatsEnabled,
  isChainlinkEnabled,
  resolvePolygonRpc,
};
