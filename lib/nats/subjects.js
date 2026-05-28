/**
 * NATS subject taxonomy — shared by Node (dashboard/bot/publisher) and Rust feeds.
 */
const SUBJECTS = Object.freeze({
  FEEDS_BINANCE_PRICE: 'feeds.binance.price',
  FEEDS_POLYMARKET_PRICE: 'feeds.polymarket.price',
  FEEDS_POLYMARKET_ORDERBOOK: 'feeds.polymarket.orderbook',
  FEEDS_POLYMARKET_TRADES: 'feeds.polymarket.trades',
  FEEDS_POLYMARKET_MARKETS: 'feeds.polymarket.markets',
  BOT_STATUS: 'bot.status',
  BOT_EVENTS: 'bot.events',
  BOT_CONTROL: 'bot.control',
});

/** Wildcards for dashboard bridge subscribers */
const WILDCARDS = Object.freeze({
  FEEDS_ALL: 'feeds.>',
  BOT_ALL: 'bot.>',
});

module.exports = { SUBJECTS, WILDCARDS };
