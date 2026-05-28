/**
 * Bot → dashboard events (in-process hub + HTTP/NATS for separate processes).
 */
const { EventEmitter } = require('events');

const hub = new EventEmitter();
hub.setMaxListeners(50);

const DASHBOARD_URL = `http://127.0.0.1:${process.env.DASHBOARD_PORT || 3847}`;
const USE_NATS = process.env.USE_NATS !== 'false' && process.env.NATS_URL !== 'disabled';

let natsBridge = null;
let natsReady = null;

function getNatsBridge() {
  if (!USE_NATS) return null;
  if (!natsBridge) {
    const { createNatsBridge } = require('../lib/natsBridge');
    const { SUBJECTS } = require('../lib/nats/subjects');
    const { botEvent } = require('../lib/nats/schemas');
    natsBridge = createNatsBridge({ name: 'bot-hub' });
    natsReady = natsBridge.connect().catch(() => {});
    natsBridge._publishEvent = async (event) => {
      await natsReady;
      await natsBridge.publish(SUBJECTS.BOT_EVENTS, botEvent(event));
    };
  }
  return natsBridge;
}

function publishDashboardEvent(event) {
  const payload = {
    source: 'bot',
    timestamp: Date.now(),
    ...event,
  };
  hub.emit('dashboard', payload);

  if (USE_NATS) {
    const bridge = getNatsBridge();
    if (bridge?._publishEvent) {
      bridge._publishEvent(payload).catch(() => {});
    }
  }

  if (process.env.ENABLE_DASHBOARD_FEED === 'false') return;
  // Dashboard bridge ingests bot.events over NATS; HTTP would duplicate UI updates.
  if (USE_NATS) return;

  fetch(`${DASHBOARD_URL}/api/bot-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

module.exports = { hub, publishDashboardEvent, getNatsBridge, USE_NATS };
