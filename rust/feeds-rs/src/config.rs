use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Config {
    pub nats_url: String,
    pub market_window: MarketWindow,
    pub binance_ws_url: String,
    pub gamma_api: String,
    pub clob_api: String,
    pub polymarket_ws_url: String,
    pub market_refresh_ms: u64,
    pub orderbook_poll_ms: u64,
    pub midpoint_fallback_ms: u64,
    pub market_search_pages: u32,
    pub max_poly_markets: usize,
    pub metrics_interval_secs: u64,
}

pub const WINDOW_1D_MINUTES: u32 = 1440;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarketWindow {
    Five,
    Fifteen,
    OneDay,
    Both,
    All,
}

impl MarketWindow {
    pub fn allowed_minutes(self) -> Vec<u32> {
        match self {
            MarketWindow::Five => vec![5],
            MarketWindow::Fifteen => vec![15],
            MarketWindow::OneDay => vec![WINDOW_1D_MINUTES],
            MarketWindow::Both => vec![5, 15],
            MarketWindow::All => vec![5, 15, WINDOW_1D_MINUTES],
        }
    }
}

fn parse_market_window(raw: &str) -> MarketWindow {
    let v = raw.trim().to_lowercase();
    match v.as_str() {
        "5" | "5m" => MarketWindow::Five,
        "1d" | "1day" | "daily" | "1440" => MarketWindow::OneDay,
        "both" | "5,15" | "15,5" => MarketWindow::Both,
        "all" => MarketWindow::All,
        _ => MarketWindow::Fifteen,
    }
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_u32(key: &str, default: u32) -> u32 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

pub fn load() -> Result<Config> {
    let nats_url =
        std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".to_string());
    let market_window = parse_market_window(
        &std::env::var("MARKET_WINDOW").unwrap_or_else(|_| "15".to_string()),
    );

    Ok(Config {
        nats_url,
        market_window,
        binance_ws_url: std::env::var("BINANCE_WS_URL")
            .unwrap_or_else(|_| "wss://stream.binance.com:9443/ws/btcusdt@aggTrade".to_string()),
        gamma_api: std::env::var("GAMMA_API")
            .unwrap_or_else(|_| "https://gamma-api.polymarket.com".to_string()),
        clob_api: std::env::var("CLOB_API")
            .unwrap_or_else(|_| "https://clob.polymarket.com".to_string()),
        polymarket_ws_url: std::env::var("POLYMARKET_WS_URL").unwrap_or_else(|_| {
            "wss://ws-subscriptions-clob.polymarket.com/ws/market".to_string()
        }),
        market_refresh_ms: env_u64("MARKET_REFRESH_MS", 45_000),
        orderbook_poll_ms: env_u64("ORDERBOOK_POLL_MS", 1_000),
        midpoint_fallback_ms: env_u64("MIDPOINT_FALLBACK_MS", 5_000),
        market_search_pages: env_u32("MARKET_SEARCH_PAGES", 12),
        max_poly_markets: env_u32("MAX_POLY_MARKETS", 6) as usize,
        metrics_interval_secs: env_u64("METRICS_INTERVAL_SECS", 10),
    })
}

impl Config {
    pub fn validate(&self) -> Result<()> {
        url::Url::parse(&self.nats_url).context("invalid NATS_URL")?;
        url::Url::parse(&self.binance_ws_url).context("invalid BINANCE_WS_URL")?;
        Ok(())
    }
}
