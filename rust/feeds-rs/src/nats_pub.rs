use anyhow::Result;
use async_nats::Client;
use serde::Serialize;

use crate::events::FeedEvent;
use crate::metrics::SharedMetrics;

#[derive(Clone)]
pub struct NatsPublisher {
    client: Client,
    metrics: SharedMetrics,
}

impl NatsPublisher {
    pub async fn connect(url: &str, metrics: SharedMetrics) -> Result<Self> {
        let client = async_nats::connect(url).await?;
        Ok(Self { client, metrics })
    }

    pub async fn publish<T: Serialize>(&self, subject: &str, payload: &T) -> Result<()> {
        let bytes = serde_json::to_vec(payload)?;
        self.client
            .publish(subject.to_string(), bytes.into())
            .await
            .map_err(|e| {
                self.metrics
                    .nats_publish_errors
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                e
            })?;
        Ok(())
    }

    pub async fn publish_event(&self, subject: &str, event: &FeedEvent) -> Result<()> {
        self.publish(subject, event).await
    }
}
