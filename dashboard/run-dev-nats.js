/**
 * Start NATS + feed publisher + dashboard + paper bot.
 *   npm run dev:nats
 */
const { spawn, execSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const children = [];

function run(name, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      USE_NATS: 'true',
      USE_NATS_FEEDS: 'true',
      NATS_URL: process.env.NATS_URL || 'nats://127.0.0.1:4222',
      PAPER_TRADE: 'true',
      ENABLE_DASHBOARD_FEED: 'true',
      ...extraEnv,
    },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    console.log(`[dev:nats] ${name} exited (${code})`);
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

try {
  execSync('docker compose up -d nats', { cwd: root, stdio: 'inherit' });
} catch (e) {
  console.warn('[dev:nats] docker compose failed — ensure NATS is running on :4222');
}

setTimeout(() => {
  run('feeds', ['feeds/natsPublisher.js']);
  run('dashboard', [path.join('dashboard', 'server.js')]);
  setTimeout(() => {
    run('bot', ['bot.js'], { BOT_USE_NATS_FEEDS: 'true' });
  }, 1500);
}, 800);
