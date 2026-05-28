mod binance;
mod config;
mod events;
mod metrics;
mod nats_pub;
mod polymarket;

use anyhow::Result;
use tokio::signal;
use tokio::time::{interval, Duration, MissedTickBehavior};
use tracing::{info, Level};
use tracing_subscriber::EnvFilter;

use crate::config::load;
use crate::metrics::FeedMetrics;
use crate::nats_pub::NatsPublisher;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive(Level::INFO.into()),
        )
        .init();

    let cfg = load()?;
    cfg.validate()?;

    info!(
        nats_url = %cfg.nats_url,
        market_window = ?cfg.market_window,
        binance_ws = %cfg.binance_ws_url,
        "feeds-rs starting"
    );

    let metrics = FeedMetrics::shared();
    let nats = NatsPublisher::connect(&cfg.nats_url, metrics.clone()).await?;
    info!("connected to NATS");

    let cfg_binance = cfg.clone();
    let nats_binance = nats.clone();
    let metrics_binance = metrics.clone();
    tokio::spawn(async move {
        binance::run_binance_feed(cfg_binance, nats_binance, metrics_binance).await;
    });

    let cfg_poly = cfg.clone();
    let nats_poly = nats.clone();
    let metrics_poly = metrics.clone();
    tokio::spawn(async move {
        polymarket::run_polymarket_feeds(cfg_poly, nats_poly, metrics_poly).await;
    });

    let metrics_log = metrics.clone();
    let interval_secs = cfg.metrics_interval_secs;
    tokio::spawn(async move {
        let mut tick = interval(Duration::from_secs(interval_secs));
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let snap = metrics_log.snapshot_and_reset_rates(interval_secs);
            info!(
                binance_connected = snap.binance_connected,
                poly_ws_connected = snap.poly_ws_connected,
                binance_msgs_per_sec = format!("{:.1}", snap.binance_msgs_per_sec),
                poly_price_msgs_per_sec = format!("{:.1}", snap.poly_price_msgs_per_sec),
                poly_orderbook_msgs_per_sec = format!("{:.1}", snap.poly_orderbook_msgs_per_sec),
                binance_reconnects = snap.binance_reconnects,
                poly_ws_reconnects = snap.poly_ws_reconnects,
                poly_market_refreshes = snap.poly_market_refreshes,
                nats_publish_errors = snap.nats_publish_errors,
                "feeds health"
            );
        }
    });

    info!("feeds-rs running — publish subjects: feeds.binance.price, feeds.polymarket.*");
    signal::ctrl_c().await?;
    info!("shutting down");
    Ok(())
}
