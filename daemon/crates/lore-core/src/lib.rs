//! Shared core for the Lore v2 daemon and CLI: configuration, storage,
//! policy and retrieval. Adapters never see SQL.

pub mod config;
pub mod error;
pub mod extraction;
pub mod ingestion;
pub mod lifecycle;
pub mod migration;
pub mod okf_visualizer;
pub mod policy;
pub mod retrieval;
pub mod skills;
pub mod store;

/// Milliseconds since the Unix epoch; `0` if the clock is before it.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Nanoseconds since the Unix epoch; `0` if the clock is before it.
pub fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
}
