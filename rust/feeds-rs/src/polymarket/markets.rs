use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;

use crate::config::Config;

#[derive(Debug, Clone)]
pub struct BtcMarket {
    pub condition_id: String,
    pub token_id_yes: String,
    pub token_id_no: String,
    pub end_time_ms: i64,
    pub question: String,
    pub slug: String,
    pub window_minutes: u32,
    pub liquidity: f64,
}

pub fn allowed_windows(cfg: &Config) -> Vec<u32> {
    cfg.market_window.allowed_minutes()
}

fn is_btc_related(text: &str) -> bool {
    let t = text.to_lowercase();
    t.contains("btc") || t.contains("bitcoin")
}

pub fn detect_window_minutes(text: &str) -> Option<u32> {
    let t = text.to_lowercase();
    if t.contains("btc-updown-15m") {
        return Some(15);
    }
    if t.contains("btc-updown-5m") {
        return Some(5);
    }
    if t.contains("15m")
        || t.contains("15-minute")
        || t.contains("15 minute")
        || t.contains("15 min")
    {
        return Some(15);
    }
    if t.contains("5m") || t.contains("5-minute") || t.contains("5 minute") || t.contains("5 min")
    {
        return Some(5);
    }
    None
}

pub fn match_btc_short_window_market(
    question: &str,
    slug: &str,
    tags: &str,
    allowed: &[u32],
) -> Option<u32> {
    let blob = format!("{question} {slug} {tags}");
    let blob_lower = blob.to_lowercase();
    if blob_lower.contains("world cup")
        || blob_lower.contains("fifa")
        || blob_lower.contains("election")
        || blob_lower.contains("president")
        || blob_lower.contains("gta ")
        || blob_lower.contains("super bowl")
        || blob_lower.contains("nba finals")
        || blob_lower.contains("oscar")
    {
        return None;
    }
    if !is_btc_related(&blob) {
        return None;
    }
    let window = detect_window_minutes(&blob)?;
    if allowed.contains(&window) {
        Some(window)
    } else {
        None
    }
}

fn parse_token_ids(raw: &Value) -> Vec<String> {
    match raw {
        Value::Array(arr) => arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        Value::String(s) => serde_json::from_str::<Vec<String>>(s).unwrap_or_default(),
        _ => vec![],
    }
}

fn normalize_gamma_market(
    m: &Value,
    window_minutes: u32,
    event_slug: &str,
) -> Option<BtcMarket> {
    let condition_id = m.get("conditionId")?.as_str()?.to_string();
    let token_ids = parse_token_ids(m.get("clobTokenIds").unwrap_or(&Value::Null));
    let yes = token_ids.first()?.clone();
    let no = token_ids.get(1)?.clone();
    let end_date = m.get("endDate")?.as_str()?;
    let end_time_ms = parse_iso8601_to_ms(end_date).ok()?;
    let question = m
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let slug = m
        .get("slug")
        .and_then(|v| v.as_str())
        .unwrap_or(event_slug)
        .to_string();
    let liquidity = m
        .get("liquidity")
        .and_then(|v| v.as_f64())
        .or_else(|| {
            m.get("liquidity")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
        })
        .unwrap_or(0.0);

    Some(BtcMarket {
        condition_id,
        token_id_yes: yes,
        token_id_no: no,
        end_time_ms,
        question,
        slug,
        window_minutes,
        liquidity,
    })
}

pub fn dedupe_markets(markets: Vec<BtcMarket>) -> Vec<BtcMarket> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for m in markets {
        if seen.insert(m.condition_id.clone()) {
            out.push(m);
        }
    }
    out
}

pub fn select_nearest_relevant_markets(markets: Vec<BtcMarket>, allowed: &[u32]) -> Vec<BtcMarket> {
    let now = now_ms() as i64;
    let max_window = allowed.iter().copied().max().unwrap_or(15);
    let horizon_ms = (max_window as i64) * 60_000 + 90_000;

    let mut live: Vec<BtcMarket> = markets
        .into_iter()
        .filter(|m| m.end_time_ms > now && allowed.contains(&m.window_minutes))
        .collect();
    live.sort_by_key(|m| m.end_time_ms);

    let relevant: Vec<BtcMarket> = live
        .iter()
        .filter(|m| (m.end_time_ms - now) <= horizon_ms)
        .cloned()
        .collect();

    let picked = if relevant.is_empty() {
        live.into_iter().take(8).collect()
    } else {
        relevant
    };

    picked.into_iter().take(8).collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    events: Option<Vec<SearchEvent>>,
    pagination: Option<Pagination>,
}

#[derive(Debug, Deserialize)]
struct Pagination {
    #[serde(rename = "hasMore")]
    has_more: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct SearchEvent {
    slug: Option<String>,
    title: Option<String>,
    tags: Option<Value>,
    markets: Option<Vec<Value>>,
}

const SEARCH_QUERIES: &[&str] = &[
    "bitcoin up or down",
    "btc-updown-5m",
    "btc-updown-15m",
];

pub async fn fetch_active_btc_markets(cfg: &Config) -> Result<Vec<BtcMarket>> {
    let allowed = allowed_windows(cfg);
    let client = reqwest::Client::builder()
        .user_agent("feeds-rs/0.1 polymarket_bot")
        .build()?;

    let mut combined = Vec::new();
    for query in SEARCH_QUERIES {
        combined.extend(fetch_from_search(&client, cfg, &allowed, query).await?);
    }
    combined.extend(fetch_from_crypto_tag(&client, cfg, &allowed).await?);

    let deduped = dedupe_markets(combined);
    Ok(select_nearest_relevant_markets(deduped, &allowed))
}

async fn fetch_from_search(
    client: &reqwest::Client,
    cfg: &Config,
    allowed: &[u32],
    query: &str,
) -> Result<Vec<BtcMarket>> {
    let mut matched = Vec::new();
    for page in 1..=cfg.market_search_pages {
        let url = format!(
            "{}/public-search?q={}&events_status=active&limit=50&page={}",
            cfg.gamma_api,
            urlencoding_encode(query),
            page
        );
        let data: SearchResponse = client.get(&url).send().await?.json().await?;
        let events = data.events.unwrap_or_default();
        if events.is_empty() {
            break;
        }

        for event in events {
            let event_slug = event.slug.unwrap_or_default();
            let tags = tags_to_string(&event.tags);
            for m in event.markets.unwrap_or_default() {
                if m.get("closed").and_then(|v| v.as_bool()) == Some(true) {
                    continue;
                }
                if m.get("active").and_then(|v| v.as_bool()) == Some(false) {
                    continue;
                }
                let question = m
                    .get("question")
                    .and_then(|v| v.as_str())
                    .unwrap_or(event.title.as_deref().unwrap_or(""));
                let slug = m
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&event_slug);
                let Some(window) = match_btc_short_window_market(question, slug, &tags, allowed) else {
                    continue;
                };
                if let Some(norm) = normalize_gamma_market(&m, window, &event_slug) {
                    matched.push(norm);
                }
            }
        }

        if data.pagination.and_then(|p| p.has_more) != Some(true) {
            break;
        }
    }
    Ok(matched)
}

async fn fetch_from_crypto_tag(
    client: &reqwest::Client,
    cfg: &Config,
    allowed: &[u32],
) -> Result<Vec<BtcMarket>> {
    let url = format!(
        "{}/markets?tag=crypto&closed=false&limit=100&active=true",
        cfg.gamma_api
    );
    let data: Value = client.get(&url).send().await?.json().await?;
    let markets = if let Some(arr) = data.as_array() {
        arr.clone()
    } else {
        data.get("markets")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    };

    let mut out = Vec::new();
    for m in markets {
        let question = m.get("question").and_then(|v| v.as_str()).unwrap_or("");
        let slug = m.get("slug").and_then(|v| v.as_str()).unwrap_or("");
        let tags = tags_to_string(&m.get("tags").cloned());
        let Some(window) = match_btc_short_window_market(question, slug, &tags, allowed) else {
            continue;
        };
        if let Some(norm) = normalize_gamma_market(&m, window, slug) {
            out.push(norm);
        }
    }
    Ok(out)
}

fn tags_to_string(tags: &Option<Value>) -> String {
    match tags {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<_>>()
            .join(" "),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Parse ISO-8601 UTC timestamps from Gamma (e.g. `2026-05-28T18:00:00Z`).
fn parse_iso8601_to_ms(s: &str) -> Result<i64, ()> {
    let dt = time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
        .map_err(|_| ())?;
    Ok((dt.unix_timestamp_nanos() / 1_000_000) as i64)
}
