/**
 * Load KEY=VALUE pairs from .env into process.env (no dependency).
 * Does not override variables already set in the environment.
 */
const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath = path.join(__dirname, '..', '.env')) {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) {
    /* ignore */
  }
}

module.exports = { loadEnvFile };
