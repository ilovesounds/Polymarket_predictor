/**
 * bot.js — Entry point for the live/paper trading loop
 *
 * Architecture (template-aligned):
 *   bot/Config.js          — env configuration
 *   bot/SessionManager.js  — indefinite | timed | trades | pnl
 *   bot/MarketScanner.js   — Gamma fetch + CLOB enrichment
 *   bot/StrategyRouter.js  — pluggable strategies (priority list)
 *   bot/PolymarketBot.js   — scan → evaluate → execute
 *
 * Run: npm run paper:live  |  PRIVATE_KEY=0x... node bot.js
 */

const { loadEnvFile } = require('./lib/loadEnv');
const { loadConfig } = require('./bot/Config');
const { PolymarketBot } = require('./bot/PolymarketBot');

loadEnvFile();

async function main() {
  const config = loadConfig();
  const bot = new PolymarketBot(config);
  await bot.start();
}

main().catch(console.error);
