//! Governance lists: paging must reach every row, including rows that share an
//! update stamp at a page boundary.

use std::path::Path;

use lore_core::config::{Limits, ResolvedConfig, ResolvedSources};
use lore_core::store::Store;
use serde_json::Value;

fn config(dir: &Path) -> ResolvedConfig {
    ResolvedConfig {
        enabled: true,
        config_path: None,
        data_dir: dir.to_path_buf(),
        socket_path: dir.join("test.sock"),
        store_path: dir.join("lore-v2.db"),
        limits: Limits::default(),
        embedding_identity: None,
        embedding: None,
        sources: ResolvedSources {
            roots: Vec::new(),
            sweep_seconds: 60,
            page_entries: 256,
            quantum_bytes: 4 * 1024 * 1024,
            max_record_bytes: 1024 * 1024,
        },
    }
}

/// Follow `nextCursor` from the first page until it ends, collecting every item id.
fn walk(mut page: impl FnMut(Option<&str>) -> Value) -> Vec<String> {
    let mut ids = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let value = page(cursor.as_deref());
        for item in value["items"].as_array().expect("items") {
            ids.push(item["id"].as_str().expect("item id").to_string());
        }
        assert!(ids.len() < 1_000, "paging never ended: {ids:?}");
        match value["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_string()),
            None => return ids,
        }
    }
}

fn assert_each_once(ids: &[String], expected: usize) {
    let mut unique = ids.to_vec();
    unique.sort();
    unique.dedup();
    assert_eq!(ids.len(), expected, "items returned: {ids:?}");
    assert_eq!(unique.len(), expected, "an item repeated: {ids:?}");
}

#[test]
fn backlog_pages_reach_every_item_that_shares_an_update_stamp() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(&config(dir.path())).expect("open");
    for index in 0..5 {
        store
            .backlog_add(
                Some(&format!("item-{index}")),
                "improvement",
                &format!("title {index}"),
                None,
                "manual",
                None,
                None,
                1_000,
            )
            .expect("backlog add");
    }
    let ids = walk(|cursor| store.backlog_list(cursor, 2, None).expect("page"));
    assert_each_once(&ids, 5);
}

#[test]
fn journal_pages_reach_every_entry_that_shares_an_update_stamp() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(&config(dir.path())).expect("open");
    for index in 0..5 {
        store
            .journal_write(None, Some(&format!("intent {index}")), "open", None, 1_000)
            .expect("journal write");
    }
    let ids = walk(|cursor| store.journal_list(cursor, 2, None).expect("page"));
    assert_each_once(&ids, 5);
}
