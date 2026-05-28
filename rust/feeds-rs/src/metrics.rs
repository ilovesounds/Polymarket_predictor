use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Default)]
pub struct FeedMetrics {
    pub binance_msgs: AtomicU64,
    pub binance_reconnects: AtomicU64,
    pub poly_price_msgs: AtomicU64,
    pub poly_orderbook_msgs: AtomicU64,
    pub poly_market_refreshes: AtomicU64,
    pub poly_ws_reconnects: AtomicU64,
    pub nats_publish_errors: AtomicU64,
    pub binance_connected: AtomicU64,
    pub poly_ws_connected: AtomicU64,
}

pub type SharedMetrics = Arc<FeedMetrics>;

impl FeedMetrics {
    pub fn shared() -> SharedMetrics {
        Arc::new(FeedMetrics::default())
    }

    pub fn inc(&self, counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }

    pub fn set_flag(&self, flag: &AtomicU64, on: bool) {
        flag.store(if on { 1 } else { 0 }, Ordering::Relaxed);
    }

    pub fn snapshot_and_reset_rates(&self, interval_secs: u64) -> MetricsSnapshot {
        let binance = self.binance_msgs.swap(0, Ordering::Relaxed);
        let poly_price = self.poly_price_msgs.swap(0, Ordering::Relaxed);
        let poly_ob = self.poly_orderbook_msgs.swap(0, Ordering::Relaxed);

        MetricsSnapshot {
            interval_secs,
            binance_msgs_per_sec: binance as f64 / interval_secs as f64,
            poly_price_msgs_per_sec: poly_price as f64 / interval_secs as f64,
            poly_orderbook_msgs_per_sec: poly_ob as f64 / interval_secs as f64,
            binance_reconnects: self.binance_reconnects.load(Ordering::Relaxed),
            poly_ws_reconnects: self.poly_ws_reconnects.load(Ordering::Relaxed),
            poly_market_refreshes: self.poly_market_refreshes.load(Ordering::Relaxed),
            nats_publish_errors: self.nats_publish_errors.load(Ordering::Relaxed),
            binance_connected: self.binance_connected.load(Ordering::Relaxed) == 1,
            poly_ws_connected: self.poly_ws_connected.load(Ordering::Relaxed) == 1,
        }
    }
}

#[derive(Debug)]
pub struct MetricsSnapshot {
    pub interval_secs: u64,
    pub binance_msgs_per_sec: f64,
    pub poly_price_msgs_per_sec: f64,
    pub poly_orderbook_msgs_per_sec: f64,
    pub binance_reconnects: u64,
    pub poly_ws_reconnects: u64,
    pub poly_market_refreshes: u64,
    pub nats_publish_errors: u64,
    pub binance_connected: bool,
    pub poly_ws_connected: bool,
}
