use anyhow::{Context, Result};
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::time::{sleep, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

use crate::config::Config;
use crate::events::{subjects, FeedEvent};
use crate::metrics::SharedMetrics;
use crate::nats_pub::NatsPublisher;

#[derive(Debug, Deserialize)]
struct AggTrade {
    #[serde(rename = "E")]
    event_time: Option<u64>,
    #[serde(rename = "a")]
    agg_id: Option<u64>,
    p: String,
}

pub async fn run_binance_feed(cfg: Config, nats: NatsPublisher, metrics: SharedMetrics) {
    let mut backoff_ms = 2_000u64;
    loop {
        match run_binance_session(&cfg, &nats, &metrics).await {
            Ok(()) => warn!("binance ws session ended cleanly"),
            Err(e) => error!(error = %e, "binance ws session error"),
        }
        metrics.inc(&metrics.binance_reconnects);
        metrics.set_flag(&metrics.binance_connected, false);
        info!(backoff_ms, "binance reconnecting");
        sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms * 2).min(30_000);
    }
}

async fn run_binance_session(
    cfg: &Config,
    nats: &NatsPublisher,
    metrics: &SharedMetrics,
) -> Result<()> {
    let (ws, _) = connect_async(&cfg.binance_ws_url)
        .await
        .with_context(|| format!("connect binance ws {}", cfg.binance_ws_url))?;

    info!(url = %cfg.binance_ws_url, "binance ws connected");
    metrics.set_flag(&metrics.binance_connected, true);

    let (_, mut read) = ws.split();
    while let Some(msg) = read.next().await {
        let msg = msg?;
        if let Message::Text(text) = msg {
            if let Some(trade) = parse_agg_trade(&text) {
                let ts_ms = trade
                    .event_time
                    .unwrap_or_else(|| now_ms());
                let price: f64 = trade.p.parse().unwrap_or(f64::NAN);
                if !price.is_finite() {
                    continue;
                }

                metrics.inc(&metrics.binance_msgs);
                let event = FeedEvent {
                    source: "binance",
                    event_type: "price",
                    market_id: Some("BTCUSDT".to_string()),
                    yes_price: None,
                    no_price: None,
                    price: Some(price),
                    ts_ms,
                    window_minutes: None,
                    symbol: Some("BTCUSDT".to_string()),
                    side: None,
                    via: Some("aggTrade".to_string()),
                    question: None,
                    end_time_ms: None,
                    markets: None,
                    yes: None,
                    no: None,
                    trade_id: trade.agg_id,
                    exchange_ts_ms: trade.event_time,
                };
                nats.publish_event(subjects::BINANCE_PRICE, &event).await?;
            }
        } else if let Message::Close(_) = msg {
            break;
        }
    }

    Ok(())
}

fn parse_agg_trade(text: &str) -> Option<AggTrade> {
    // Hot path: only parse fields we need.
    serde_json::from_str(text).ok()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
