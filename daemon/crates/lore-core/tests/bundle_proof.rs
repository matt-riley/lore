//! Portable bundles: export, import idempotency, first-content-wins and
//! path containment.

use std::path::{Path, PathBuf};

use lore_core::config::{Limits, ResolvedConfig, ResolvedSources};
use lore_core::store::Store;
use protocol::{RecallParams, Scope};

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

fn approved_item(store: &Store, title: &str, now: i64) -> String {
    let added = store
        .backlog_add(
            None,
            "improvement",
            title,
            Some("Detail line."),
            "manual",
            None,
            None,
            now,
        )
        .expect("backlog add");
    let id = added["id"].as_str().expect("id").to_string();
    store
        .backlog_update(&id, "accepted", Some("tester"), now)
        .expect("accept");
    id
}

fn recall(store: &Store, query: &str, now: i64) -> String {
    store
        .recall(
            &RecallParams {
                query: query.to_string(),
                repository: None,
                include_other_repositories: false,
                limit: Some(5),
                context_bytes: None,
            },
            now,
            5,
            4_096,
            None,
        )
        .expect("recall")
        .context
}

#[test]
fn bundle_export_import_round_trip_is_idempotent_and_first_wins() {
    let dir = tempfile::tempdir().expect("dir");
    let store = Store::open(&config(dir.path())).expect("open");
    let now = 5_000_000i64;
    approved_item(&store, "Port the exporter", now);
    approved_item(&store, "Add a dashboard panel", now);

    // JSON export is signed and lands under the data directory.
    let exported = store.bundle_export("json", None, now).expect("json export");
    let json_path = PathBuf::from(exported["path"].as_str().expect("path"));
    assert!(json_path.starts_with(dir.path()), "{json_path:?}");
    let body: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&json_path).expect("read export")).expect("parse");
    assert_eq!(body["artifacts"].as_array().expect("artifacts").len(), 2);
    assert_eq!(body["checksum"], exported["checksum"]);

    // OKF export writes an index, one concept per artifact and a manifest.
    let okf = store.bundle_export("okf", None, now).expect("okf export");
    let okf_dir = PathBuf::from(okf["path"].as_str().expect("path"));
    assert!(okf_dir.join("index.md").is_file());
    assert!(okf_dir.join("manifest.json").is_file());
    let concept_files = std::fs::read_dir(&okf_dir)
        .expect("read dir")
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.ends_with(".md") && name != "index.md"
        })
        .count();
    assert_eq!(concept_files, 2);

    // Import creates okf_concept memories with lower confidence.
    let imported = store
        .bundle_import_okf(okf_dir.to_str().expect("utf8"), now)
        .expect("import");
    assert_eq!(imported["alreadyImported"], false);
    assert_eq!(imported["concepts"], 2);
    assert!(recall(&store, "Port the exporter", now).contains("Port the exporter"));

    // Re-importing the same bytes is a no-op.
    let repeat = store
        .bundle_import_okf(okf_dir.to_str().expect("utf8"), now)
        .expect("repeat import");
    assert_eq!(repeat["alreadyImported"], true);
    assert_eq!(repeat["concepts"], 2);

    // A changed copy keeps the first content (first import wins) and reports
    // the concepts as skipped.
    let copy_dir = okf_dir.with_file_name("changed-copy");
    copy_tree(&okf_dir, &copy_dir);
    let first_file = std::fs::read_dir(&copy_dir)
        .expect("read copy")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            name.ends_with(".md") && name != "index.md"
        })
        .expect("concept file");
    let original = std::fs::read_to_string(&first_file).expect("read concept");
    let changed_body = original.replace("Detail line.", "Changed detail that must not overwrite.");
    assert_ne!(original, changed_body);
    std::fs::write(&first_file, changed_body).expect("overwrite");
    let changed = store
        .bundle_import_okf(copy_dir.to_str().expect("utf8"), now)
        .expect("changed import");
    assert_eq!(changed["alreadyImported"], false);
    assert_eq!(changed["concepts"], 0);
    assert_eq!(changed["skipped"], 2);

    // Paths outside the data directory are refused.
    let outside = dir.path().parent().expect("parent").join("elsewhere");
    let error = store
        .bundle_import_okf(outside.to_str().expect("utf8"), now)
        .expect_err("outside path refused");
    assert_eq!(error.reason, "BUNDLE_PATH_INVALID");
    let error = store
        .bundle_export("json", Some("../escape.json"), now)
        .expect_err("traversal refused");
    assert_eq!(error.reason, "BUNDLE_PATH_INVALID");

    // The import is recorded on the evolution ledger.
    let ledger = store.ledger_page(None, 20, Some("import")).expect("ledger");
    assert!(ledger["entries"].as_array().expect("entries").len() >= 2);
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("mkdir");
    for entry in std::fs::read_dir(from).expect("read").flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().expect("type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("copy");
        }
    }
}

#[test]
fn scope_override_records_a_ledger_entry() {
    let dir = tempfile::tempdir().expect("dir");
    let store = Store::open(&config(dir.path())).expect("open");
    let now = 6_000_000i64;
    let retained = store
        .retain(
            "client-a",
            &protocol::RetainParams {
                idempotency_key: "bundle-scope-1".to_string(),
                kind: "note".to_string(),
                content: "Scoped note.".to_string(),
                scope: Scope::Global,
                repository: None,
                confidence: None,
                expires_at_ms: None,
                tags: Vec::new(),
                source_session_id: None,
            },
            now,
        )
        .expect("retain");
    let preview = store
        .scope_override_preview(
            std::slice::from_ref(&retained.memory_id),
            Some("repo"),
            Some("acme/app"),
            false,
        )
        .expect("preview");
    let fingerprint = preview["fingerprint"].as_str().expect("fingerprint");
    store
        .scope_override_apply(
            std::slice::from_ref(&retained.memory_id),
            Some("repo"),
            Some("acme/app"),
            false,
            fingerprint,
            "tester",
            "test reason",
            now,
        )
        .expect("apply");
    let ledger = store
        .ledger_page(None, 20, Some("scope_change"))
        .expect("ledger");
    assert_eq!(ledger["entries"][0]["actor"], "tester");
}
