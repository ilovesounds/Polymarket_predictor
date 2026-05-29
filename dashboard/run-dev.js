/**
 * Start dashboard + paper bot together.
 *   npm run dev
 */
const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const children = [];

function run(name, script, extraEnv = {}) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    console.log(`[dev] ${name} exited (${code})`);
    shutdown();
  });
  children.push(child);
}

function shutdown() {
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch (_) {}
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run('dashboard', path.join('dashboard', 'server.js'));
setTimeout(() => {
  run('bot', 'bot.js', {
    PAPER_TRADE: 'true',
    ENABLE_DASHBOARD_FEED: 'true',
    MARKET_WINDOW: process.env.MARKET_WINDOW || 'all',
  });
}, 1500);
