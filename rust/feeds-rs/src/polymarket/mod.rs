pub mod markets;
pub mod rest;
pub mod ws;

use anyhow::Result;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{interval, Duration, MissedTickBehavior};
use tracing::{error, info, warn};

use crate::config::Config;
use crate::events::{subjects, FeedEvent, MarketSummary};
use crate::metrics::SharedMetrics;
use crate::nats_pub::NatsPublisher;
use crate::polymarket::markets::{fetch_active_btc_markets, BtcMarket};
use crate::polymarket::rest::{publish_midpoint_snapshot, publish_orderbook_snapshot};
use crate::polymarket::ws::{new_price_state, run_market_ws};

struct PolySession {
    cancel: watch::Sender<bool>,
    handles: Vec<JoinHandle<()>>,
}

impl PolySession {
    fn abort(&mut self) {
        let _ = self.cancel.send(true);
        while let Some(h) = self.handles.pop() {
            h.abort();
        }
    }
}

pub async fn run_polymarket_feeds(cfg: Config, nats: NatsPublisher, metrics: SharedMetrics) {
    let prices = new_price_state();
    let mut session: Option<PolySession> = None;
    let mut markets: Vec<BtcMarket> = Vec::new();

    if let Err(e) = refresh_markets(&cfg, &nats, &metrics, &mut markets).await {
        error!(error = %e, "initial polymarket market fetch failed");
    } else {
        session = Some(spawn_market_sessions(&cfg, nats.clone(), metrics.clone(), &markets, prices.clone()).await);
    }

    let mut refresh = interval(Duration::from_millis(cfg.market_refresh_ms));
    refresh.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let mut ob_tick = interval(Duration::from_millis(cfg.orderbook_poll_ms));
    ob_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let mut mid_tick = interval(Duration::from_millis(cfg.midpoint_fallback_ms));
    mid_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = refresh.tick() => {
                metrics.inc(&metrics.poly_market_refreshes);
                match refresh_markets(&cfg, &nats, &metrics, &mut markets).await {
                    Ok(()) => {
                        if let Some(mut old) = session.take() {
                            old.abort();
                        }
                        session = Some(spawn_market_sessions(&cfg, nats.clone(), metrics.clone(), &markets, prices.clone()).await);
                    }
                    Err(e) => error!(error = %e, "polymarket market refresh failed"),
                }
            }
            _ = ob_tick.tick() => {
                let slice: Vec<_> = markets.iter().take(cfg.max_poly_markets).cloned().collect();
                for market in slice {
                    if let Err(e) = publish_orderbook_snapshot(&cfg, &nats, &metrics, &market).await {
                        warn!(error = %e, condition_id = %market.condition_id, "orderbook publish failed");
                    }
                }
            }
            _ = mid_tick.tick() => {
                let slice: Vec<_> = markets.iter().take(cfg.max_poly_markets).cloned().collect();
                for market in slice {
                    if let Err(e) = publish_midpoint_snapshot(&cfg, &nats, &metrics, &market).await {
                        warn!(error = %e, condition_id = %market.condition_id, "midpoint fallback failed");
                    }
                }
            }
        }
    }
}

async fn refresh_markets(
    cfg: &Config,
    nats: &NatsPublisher,
    _metrics: &SharedMetrics,
    out: &mut Vec<BtcMarket>,
) -> Result<()> {
    let fetched = fetch_active_btc_markets(cfg).await?;
    *out = fetched.clone();

    let summaries: Vec<MarketSummary> = fetched
        .iter()
        .map(|m| MarketSummary {
            condition_id: m.condition_id.clone(),
            question: m.question.clone(),
            window_minutes: m.window_minutes,
            end_time_ms: m.end_time_ms,
            slug: Some(m.slug.clone()),
            token_id_yes: Some(m.token_id_yes.clone()),
            token_id_no: Some(m.token_id_no.clone()),
        })
        .collect();

    let event = FeedEvent {
        source: "polymarket",
        event_type: "markets",
        market_id: None,
        yes_price: None,
        no_price: None,
        price: None,
        ts_ms: now_ms(),
        window_minutes: None,
        symbol: None,
        side: None,
        via: Some("gamma_rest".to_string()),
        question: None,
        end_time_ms: None,
        markets: Some(summaries),
        yes: None,
        no: None,
        trade_id: None,
        exchange_ts_ms: None,
    };
    nats.publish_event(subjects::POLY_MARKETS, &event).await?;
    info!(count = fetched.len(), "polymarket markets refreshed");
    Ok(())
}

async fn spawn_market_sessions(
    cfg: &Config,
    nats: NatsPublisher,
    metrics: SharedMetrics,
    markets: &[BtcMarket],
    prices: crate::polymarket::ws::PriceState,
) -> PolySession {
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let mut handles = Vec::new();

    for market in markets.iter().take(cfg.max_poly_markets) {
        let cfg_m = cfg.clone();
        let nats_m = nats.clone();
        let metrics_m = metrics.clone();
        let market_m = market.clone();
        let prices_m = prices.clone();
        let cancel_m = cancel_rx.clone();
        handles.push(tokio::spawn(async move {
            run_market_ws(cfg_m, nats_m, metrics_m, market_m, prices_m, cancel_m).await;
        }));
    }

    PolySession {
        cancel: cancel_tx,
        handles,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
