use anyhow::{Context, Result};
use serde::Deserialize;
use crate::config::Config;
use crate::events::{BookSideSummary, FeedEvent, subjects};
use crate::metrics::SharedMetrics;
use crate::nats_pub::NatsPublisher;
use crate::polymarket::markets::BtcMarket;

#[derive(Debug, Deserialize)]
struct MidpointResponse {
    mid: String,
}

#[derive(Debug, Deserialize)]
struct BookResponse {
    bids: Option<Vec<BookLevel>>,
    asks: Option<Vec<BookLevel>>,
}

#[derive(Debug, Deserialize)]
struct BookLevel {
    price: String,
    size: String,
}

pub async fn fetch_midpoint(cfg: &Config, token_id: &str) -> Result<f64> {
    let url = format!("{}/midpoint?token_id={token_id}", cfg.clob_api);
    let client = reqwest::Client::new();
    let data: MidpointResponse = client.get(url).send().await?.json().await?;
    data.mid
        .parse()
        .context("invalid midpoint")
}

pub async fn fetch_order_book(cfg: &Config, token_id: &str) -> Result<(Vec<(f64, f64)>, Vec<(f64, f64)>)> {
    let url = format!("{}/book?token_id={token_id}", cfg.clob_api);
    let client = reqwest::Client::new();
    let data: BookResponse = client.get(url).send().await?.json().await?;
    let bids = parse_levels(data.bids);
    let asks = parse_levels(data.asks);
    Ok((bids, asks))
}

fn parse_levels(levels: Option<Vec<BookLevel>>) -> Vec<(f64, f64)> {
    levels
        .unwrap_or_default()
        .into_iter()
        .filter_map(|l| {
            let price = l.price.parse().ok()?;
            let size = l.size.parse().ok()?;
            Some((price, size))
        })
        .collect()
}

fn summarize_side(levels: &[(f64, f64)], side: &str) -> BookSideSummary {
    if levels.is_empty() {
        return BookSideSummary {
            bid: None,
            ask: None,
            bid_size: None,
            ask_size: None,
        };
    }
    let (price, size) = if side == "bid" {
        levels
            .iter()
            .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
            .copied()
            .unwrap_or((0.0, 0.0))
    } else {
        levels
            .iter()
            .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
            .copied()
            .unwrap_or((0.0, 0.0))
    };

    if side == "bid" {
        BookSideSummary {
            bid: Some(price),
            ask: None,
            bid_size: Some(size),
            ask_size: None,
        }
    } else {
        BookSideSummary {
            bid: None,
            ask: Some(price),
            bid_size: None,
            ask_size: Some(size),
        }
    }
}

pub async fn publish_orderbook_snapshot(
    cfg: &Config,
    nats: &NatsPublisher,
    metrics: &SharedMetrics,
    market: &BtcMarket,
) -> Result<()> {
    let (yes_book, no_book) = tokio::join!(
        fetch_order_book(cfg, &market.token_id_yes),
        fetch_order_book(cfg, &market.token_id_no),
    );
    let (yes_bids, yes_asks) = yes_book.unwrap_or((vec![], vec![]));
    let (no_bids, no_asks) = no_book.unwrap_or((vec![], vec![]));

    let mut yes = summarize_side(&yes_bids, "bid");
    let yes_ask = summarize_side(&yes_asks, "ask");
    yes.ask = yes_ask.ask;
    yes.ask_size = yes_ask.ask_size;

    let mut no = summarize_side(&no_bids, "bid");
    let no_ask = summarize_side(&no_asks, "ask");
    no.ask = no_ask.ask;
    no.ask_size = no_ask.ask_size;

    metrics.inc(&metrics.poly_orderbook_msgs);
    let event = FeedEvent {
        source: "polymarket",
        event_type: "orderbook",
        market_id: Some(market.condition_id.clone()),
        yes_price: None,
        no_price: None,
        price: None,
        ts_ms: now_ms(),
        window_minutes: Some(market.window_minutes),
        symbol: None,
        side: None,
        via: Some("clob_rest".to_string()),
        question: Some(market.question.clone()),
        end_time_ms: Some(market.end_time_ms),
        markets: None,
        yes: Some(yes),
        no: Some(no),
        trade_id: None,
        exchange_ts_ms: None,
    };
    nats.publish_event(subjects::POLY_ORDERBOOK, &event).await
}

pub async fn publish_midpoint_snapshot(
    cfg: &Config,
    nats: &NatsPublisher,
    metrics: &SharedMetrics,
    market: &BtcMarket,
) -> Result<()> {
    let (yes, no) = tokio::join!(
        fetch_midpoint(cfg, &market.token_id_yes),
        fetch_midpoint(cfg, &market.token_id_no),
    );
    let yes_price = yes.ok();
    let no_price = no.ok();
    if yes_price.is_none() && no_price.is_none() {
        return Ok(());
    }
    publish_price_event(
        nats,
        metrics,
        market,
        yes_price,
        no_price,
        "snapshot",
        "midpoint_rest",
    )
    .await
}

pub async fn publish_price_event(
    nats: &NatsPublisher,
    metrics: &SharedMetrics,
    market: &BtcMarket,
    yes_price: Option<f64>,
    no_price: Option<f64>,
    side: &str,
    via: &str,
) -> Result<()> {
    let yes = yes_price.filter(|p| p.is_finite());
    let no = no_price
        .filter(|p| p.is_finite())
        .or_else(|| yes.map(|y| (1.0 - y).clamp(0.0, 1.0)));

    metrics.inc(&metrics.poly_price_msgs);
    let event = FeedEvent {
        source: "polymarket",
        event_type: "price",
        market_id: Some(market.condition_id.clone()),
        yes_price: yes,
        no_price: no,
        price: None,
        ts_ms: now_ms(),
        window_minutes: Some(market.window_minutes),
        symbol: None,
        side: Some(side.to_string()),
        via: Some(via.to_string()),
        question: Some(market.question.clone()),
        end_time_ms: Some(market.end_time_ms),
        markets: None,
        yes: None,
        no: None,
        trade_id: None,
        exchange_ts_ms: None,
    };
    nats.publish_event(subjects::POLY_PRICE, &event).await
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
