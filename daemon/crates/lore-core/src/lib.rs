//! Shared core for the Lore v2 daemon and CLI: configuration, storage,
//! policy and retrieval. Adapters never see SQL.

pub mod config;
pub mod error;
pub mod extraction;
pub mod ingestion;
pub mod lifecycle;
pub mod migration;
pub mod policy;
pub mod retrieval;
pub mod skills;
pub mod store;
