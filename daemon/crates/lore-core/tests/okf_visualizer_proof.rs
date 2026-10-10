//! OKF visualizer export: escaping, graph content, bounds and read-only input.

use std::path::Path;

use lore_core::okf_visualizer::visualize_okf;

fn write_bundle(root: &Path) {
    std::fs::create_dir_all(root.join("artifacts")).expect("mkdir");
    std::fs::write(root.join("index.md"), "# Example Bundle\n").expect("index");
    std::fs::write(
        root.join("artifacts/a1.md"),
        "---\nid: artifacts/a1\ntype: decision\ntitle: First artifact\ndescription: Links to the second.\ntags: [alpha, beta]\n---\n\nSee [the second](../artifacts/a2.md) for context.\n",
    )
    .expect("a1");
    std::fs::write(
        root.join("artifacts/a2.md"),
        "---\nid: artifacts/a2\ntype: note\ntitle: Second artifact\n---\n\nBack to [a1](a1.md).\n",
    )
    .expect("a2");
}

#[test]
fn export_renders_an_offline_artifact_with_links_and_backlinks() {
    let dir = tempfile::tempdir().expect("dir");
    let bundle = dir.path().join("bundle");
    write_bundle(&bundle);
    let out = dir.path().join("viz.html");

    let report = visualize_okf(&bundle, &out, Some("Example Bundle")).expect("visualize");
    assert_eq!(report["concepts"], 2);
    assert_eq!(report["edges"], 2);
    assert_eq!(report["readOnlyInput"], true);

    let html = std::fs::read_to_string(&out).expect("html");
    assert!(html.starts_with("<!DOCTYPE html>"));
    assert!(html.contains("Example Bundle"));
    assert!(html.contains("First artifact"));
    assert!(html.contains("Backlinks: artifacts/a2"));
    assert!(html.contains("id=\"okf-bundle-data\""));
    // Fully offline: no CDN or script sources.
    assert!(!html.contains("http://"), "no CDN links");
    assert!(!html.contains("https://"), "no CDN links");
    assert!(!html.contains("<script src"));
}

#[test]
fn export_escapes_content_and_the_embedded_json_block() {
    let dir = tempfile::tempdir().expect("dir");
    let bundle = dir.path().join("bundle");
    std::fs::create_dir_all(&bundle).expect("mkdir");
    std::fs::write(bundle.join("index.md"), "# Escapes\n").expect("index");
    std::fs::write(
        bundle.join("hostile.md"),
        "---\nid: hostile\ntype: note\ntitle: <script>alert(1)</script>\ndescription: \"</script><script>alert(2)</script>\"\n---\n\nBody with </script><script>alert(3)</script> tail.\n",
    )
    .expect("hostile");

    let out = dir.path().join("viz.html");
    visualize_okf(&bundle, &out, None).expect("visualize");
    let html = std::fs::read_to_string(&out).expect("html");
    assert!(
        !html.contains("<script>alert(1)</script>"),
        "title must be escaped"
    );
    assert!(
        !html.contains("</script><script>alert(2)</script>"),
        "description must be escaped"
    );
    assert!(
        !html.contains("</script><script>alert(3)</script>"),
        "body must be escaped"
    );
    assert!(html.contains("&lt;script&gt;"), "escaped form present");
    // The only script element is the JSON data block, and it cannot be closed
    // by hostile content.
    let script_opens = html.matches("<script").count();
    let script_closes = html.matches("</script>").count();
    assert_eq!(script_opens, 1, "exactly one script element");
    assert_eq!(script_closes, 1, "exactly one script element");
}

#[test]
fn export_is_bounded_and_refuses_non_bundles() {
    let dir = tempfile::tempdir().expect("dir");

    // Missing index.md.
    let plain = dir.path().join("plain");
    std::fs::create_dir_all(&plain).expect("mkdir");
    let error = visualize_okf(&plain, &dir.path().join("x.html"), None).expect_err("refused");
    assert_eq!(error.reason, "OKF_INDEX_MISSING");

    // Oversized concept files are refused.
    let big = dir.path().join("big");
    std::fs::create_dir_all(&big).expect("mkdir");
    std::fs::write(big.join("index.md"), "# Big\n").expect("index");
    std::fs::write(big.join("huge.md"), "x".repeat(300 * 1024)).expect("huge");
    let error = visualize_okf(&big, &dir.path().join("y.html"), None).expect_err("refused");
    assert_eq!(error.reason, "OKF_FILE_TOO_LARGE");

    // Non-directories are refused.
    let file = dir.path().join("file.md");
    std::fs::write(&file, "# nope\n").expect("file");
    let error = visualize_okf(&file, &dir.path().join("z.html"), None).expect_err("refused");
    assert_eq!(error.reason, "OKF_BUNDLE_NOT_FOUND");
}
