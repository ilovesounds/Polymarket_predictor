use serde::Serialize;

/// Normalized feed event published to NATS (JSON payload).
#[derive(Debug, Clone, Serialize)]
pub struct FeedEvent {
    pub source: &'static str,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub market_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yes_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    pub ts_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markets: Option<Vec<MarketSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yes: Option<BookSideSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no: Option<BookSideSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trade_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exchange_ts_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MarketSummary {
    pub condition_id: String,
    pub question: String,
    pub window_minutes: u32,
    pub end_time_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_id_yes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_id_no: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BookSideSummary {
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bid_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask_size: Option<f64>,
}

pub mod subjects {
    pub const BINANCE_PRICE: &str = "feeds.binance.price";
    pub const POLY_PRICE: &str = "feeds.polymarket.price";
    pub const POLY_ORDERBOOK: &str = "feeds.polymarket.orderbook";
    pub const POLY_MARKETS: &str = "feeds.polymarket.markets";
}
