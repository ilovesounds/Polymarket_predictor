/**
 * Fixed-size ring buffers for BTC spot and per-market YES prices.
 */

class PriceRingBuffer {
  /**
   * @param {number} maxLen
   */
  constructor(maxLen = 50) {
    this.maxLen = Math.max(1, Number(maxLen) || 50);
    /** @type {Array<number|{ t: number, p: number }>} */
    this.buf = [];
  }

  /**
   * @param {number} price
   * @param {number} [ts] — ms epoch for { t, p } entries (Polymarket history shape)
   */
  push(price, ts = Date.now()) {
    if (!Number.isFinite(price)) return;
    const entry = Number.isFinite(ts)
      ? { t: ts, p: price }
      : price;
    this.buf.push(entry);
    if (this.buf.length > this.maxLen) {
      this.buf.splice(0, this.buf.length - this.maxLen);
    }
  }

  /** @returns {number|null} */
  latest() {
    if (!this.buf.length) return null;
    const last = this.buf[this.buf.length - 1];
    return typeof last === 'number' ? last : last.p;
  }

  /** Numeric series for momentum helpers (BTC). */
  toNumericSeries() {
    return this.buf.map((x) => (typeof x === 'number' ? x : x.p)).filter(Number.isFinite);
  }

  /** CLOB / edge-case history shape [{ t, p }, ...]. */
  toPriceHistory() {
    return this.buf.map((x) => {
      if (typeof x === 'number') return { t: Date.now(), p: x };
      return { t: x.t, p: x.p };
    });
  }

  get length() {
    return this.buf.length;
  }
}

class PriceBufferStore {
  /**
   * @param {number} maxLen
   */
  constructor(maxLen = 50) {
    this.maxLen = maxLen;
    /** @type {Map<string, PriceRingBuffer>} */
    this.byKey = new Map();
  }

  /**
   * @param {string} key — conditionId or symbol key (e.g. __btc__)
   */
  append(key, price, ts = Date.now()) {
    if (!key || !Number.isFinite(price)) return;
    let buf = this.byKey.get(key);
    if (!buf) {
      buf = new PriceRingBuffer(this.maxLen);
      this.byKey.set(key, buf);
    }
    buf.push(price, ts);
  }

  /**
   * @param {string} key
   * @returns {number|null}
   */
  latest(key) {
    return this.byKey.get(key)?.latest() ?? null;
  }

  /**
   * @param {string} key
   * @returns {Array<{ t: number, p: number }>}
   */
  getPriceHistory(key) {
    return this.byKey.get(key)?.toPriceHistory() ?? [];
  }

  /**
   * @param {string} key
   * @returns {number[]}
   */
  getNumericSeries(key) {
    return this.byKey.get(key)?.toNumericSeries() ?? [];
  }
}

const BTC_BUFFER_KEY = '__btc__';

module.exports = {
  PriceRingBuffer,
  PriceBufferStore,
  BTC_BUFFER_KEY,
};
