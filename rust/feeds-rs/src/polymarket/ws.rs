use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{watch, RwLock};
use tokio::time::{interval, sleep, Duration, MissedTickBehavior};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

use crate::config::Config;
use crate::metrics::SharedMetrics;
use crate::nats_pub::NatsPublisher;
use crate::polymarket::markets::BtcMarket;
use crate::polymarket::rest::publish_price_event;

#[derive(Debug, Default, Clone)]
pub struct MarketPrices {
    pub yes: Option<f64>,
    pub no: Option<f64>,
}

pub type PriceState = Arc<RwLock<HashMap<String, MarketPrices>>>;

pub fn new_price_state() -> PriceState {
    Arc::new(RwLock::new(HashMap::new()))
}

pub async fn run_market_ws(
    cfg: Config,
    nats: NatsPublisher,
    metrics: SharedMetrics,
    market: BtcMarket,
    prices: PriceState,
    cancel: watch::Receiver<bool>,
) {
    let mut backoff_ms = 2_000u64;
    loop {
        if *cancel.borrow() {
            return;
        }
        match run_market_session(&cfg, &nats, &metrics, &market, &prices, &cancel).await {
            Ok(()) => warn!(condition_id = %market.condition_id, "polymarket market ws closed"),
            Err(e) => error!(condition_id = %market.condition_id, error = %e, "polymarket market ws error"),
        }
        if *cancel.borrow() {
            return;
        }
        metrics.inc(&metrics.poly_ws_reconnects);
        metrics.set_flag(&metrics.poly_ws_connected, false);
        sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms * 2).min(30_000);
    }
}

async fn run_market_session(
    cfg: &Config,
    nats: &NatsPublisher,
    metrics: &SharedMetrics,
    market: &BtcMarket,
    prices: &PriceState,
    cancel: &watch::Receiver<bool>,
) -> Result<()> {
    let (ws, _) = connect_async(&cfg.polymarket_ws_url)
        .await
        .with_context(|| format!("connect polymarket ws {}", cfg.polymarket_ws_url))?;

    let (mut write, mut read) = ws.split();
    let sub = serde_json::json!({
        "type": "market",
        "assets_ids": [&market.token_id_yes, &market.token_id_no],
        "custom_feature_enabled": true,
    });
    write
        .send(Message::Text(sub.to_string().into()))
        .await?;

    info!(condition_id = %market.condition_id, "polymarket clob ws subscribed");
    metrics.set_flag(&metrics.poly_ws_connected, true);

    let mut ping = interval(Duration::from_secs(10));
    ping.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = ping.tick() => {
                if *cancel.borrow() { break; }
                write.send(Message::Text("PING".into())).await?;
            }
            msg = read.next() => {
                if *cancel.borrow() { break; }
                let Some(msg) = msg else { break; };
                let msg = msg?;
                match msg {
                    Message::Text(text) => {
                        if text == "PONG" || text.eq_ignore_ascii_case("pong") {
                            continue;
                        }
                        if let Some((yes_price, no_price, via)) =
                            parse_clob_market_message(&text, market)
                        {
                            let (yes, no) = {
                                let mut guard = prices.write().await;
                                let entry = guard.entry(market.condition_id.clone()).or_default();
                                if let Some(y) = yes_price { entry.yes = Some(y); }
                                if let Some(n) = no_price { entry.no = Some(n); }
                                (entry.yes, entry.no)
                            };
                            publish_price_event(nats, metrics, market, yes, no, "both", via).await?;
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }

    Ok(())
}

fn parse_clob_market_message(
    text: &str,
    market: &BtcMarket,
) -> Option<(Option<f64>, Option<f64>, &'static str)> {
    let v: Value = serde_json::from_str(text).ok()?;

    if let Some(changes) = v.get("price_changes").and_then(|c| c.as_array()) {
        let mut yes = None;
        let mut no = None;
        for ch in changes {
            let asset = ch.get("asset_id").and_then(|a| a.as_str())?;
            let price = parse_price_value(ch.get("price"))?;
            if asset == market.token_id_yes {
                yes = Some(price);
            } else if asset == market.token_id_no {
                no = Some(price);
            }
        }
        if yes.is_some() || no.is_some() {
            return Some((yes, no, "ws_price_change"));
        }
    }

    if let Some(asset) = v.get("asset_id").and_then(|a| a.as_str()) {
        if let (Some(best_bid), Some(best_ask)) = (
            parse_price_value(v.get("best_bid")),
            parse_price_value(v.get("best_ask")),
        ) {
            let mid = (best_bid + best_ask) / 2.0;
            if asset == market.token_id_yes {
                return Some((Some(mid), None, "ws_best_bid_ask"));
            }
            if asset == market.token_id_no {
                return Some((None, Some(mid), "ws_best_bid_ask"));
            }
        }
    }

    // Initial book snapshot array
    if let Some(arr) = v.as_array() {
        let mut yes = None;
        let mut no = None;
        for item in arr {
            let asset = item.get("asset_id").and_then(|a| a.as_str())?;
            if let Some(p) = parse_price_value(item.get("price")) {
                if asset == market.token_id_yes {
                    yes = Some(p);
                } else if asset == market.token_id_no {
                    no = Some(p);
                }
            }
        }
        if yes.is_some() || no.is_some() {
            return Some((yes, no, "ws_book"));
        }
    }

    None
}

fn parse_price_value(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}
