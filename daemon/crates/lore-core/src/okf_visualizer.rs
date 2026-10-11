//! OKF v0.1 visualizer export.
//!
//! An explicit, read-only CLI export: it consumes an approved bundle
//! directory and writes one standalone, fully offline HTML artifact (no CDN,
//! no scripts) plus an embedded JSON graph for tooling. It never starts model
//! inference, never mutates the bundle, and rejects traversal or symlinked
//! content outside the bundle root.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};

use crate::error::{CoreError, CoreResult};

const MAX_CONCEPTS: usize = 200;
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_DEPTH: usize = 4;
const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;

/// One parsed concept.
#[derive(Debug, Clone)]
struct Concept {
    id: String,
    kind: String,
    title: String,
    description: String,
    tags: Vec<String>,
    body: String,
    links: Vec<String>,
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Serialize JSON so it can live inside a `<script>` element: `<`, `>` and
/// `&` become unicode escapes, which makes `</script>` impossible.
fn escape_json_block(value: &Value) -> String {
    let raw = serde_json::to_string(value).unwrap_or_default();
    raw.replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

fn normalize_relative(path: &Path) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// Minimal frontmatter parser: `key: value` scalars and `[a, b]` lists.
fn parse_frontmatter(raw: &str) -> (BTreeMap<String, String>, String) {
    let mut fields = BTreeMap::new();
    let Some(rest) = raw.strip_prefix("---") else {
        return (fields, raw.to_string());
    };
    let Some(end) = rest.find("\n---") else {
        return (fields, raw.to_string());
    };
    for line in rest[..end].lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        fields.insert(key.trim().to_lowercase(), value.trim().to_string());
    }
    let body = rest[end + 4..].trim_start_matches(['\n', '\r']).to_string();
    (fields, body)
}

fn frontmatter_list(value: &str) -> Vec<String> {
    value
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|item| item.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

/// Markdown link targets ending in `.md`, resolved against the document dir.
fn extract_links(body: &str, document_dir: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find("](") {
        let after = &rest[start + 2..];
        let Some(end) = after.find(')') else {
            break;
        };
        let target = after[..end].split('#').next().unwrap_or("").trim();
        if (target.ends_with(".md") || target.ends_with(".markdown")) && !target.contains("://") {
            let resolved = if document_dir.is_empty() {
                PathBuf::from(target)
            } else {
                Path::new(document_dir).join(target)
            };
            if let Some(normalized) = normalize_relative(&resolved) {
                links.push(normalized);
            }
        }
        rest = &after[end..];
    }
    links
}

fn walk_markdown(_root: &Path, dir: &Path, depth: usize, out: &mut Vec<PathBuf>) -> CoreResult<()> {
    if depth > MAX_DEPTH || out.len() >= MAX_CONCEPTS {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir)
        .map_err(|error| CoreError::invalid("OKF_BUNDLE_UNREADABLE", error.to_string()))?;
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| !path.is_symlink())
        .collect();
    paths.sort();
    for path in paths {
        if out.len() >= MAX_CONCEPTS {
            break;
        }
        if path.is_dir() {
            walk_markdown(_root, &path, depth + 1, out)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "md" || extension == "markdown")
        {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if name.eq_ignore_ascii_case("index.md") {
                continue;
            }
            out.push(path);
        }
    }
    Ok(())
}

fn read_concept(root: &Path, path: &Path) -> CoreResult<Concept> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| CoreError::invalid("OKF_FILE_UNREADABLE", error.to_string()))?;
    if metadata.len() > MAX_FILE_BYTES {
        return Err(CoreError::invalid(
            "OKF_FILE_TOO_LARGE",
            format!("{} exceeds the bundle file limit", path.display()),
        ));
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|error| CoreError::invalid("OKF_FILE_UNREADABLE", error.to_string()))?;
    let relative = path.strip_prefix(root).unwrap_or(path);
    let normalized = normalize_relative(relative)
        .ok_or_else(|| CoreError::invalid("OKF_PATH_INVALID", "concept path escapes the bundle"))?;
    let document_dir = normalized
        .rsplit_once('/')
        .map(|(dir, _)| dir.to_string())
        .unwrap_or_default();
    let (fields, body) = parse_frontmatter(&raw);
    let id = fields
        .get("id")
        .map(|value| value.trim_matches('"').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            normalized
                .trim_end_matches(".md")
                .trim_end_matches(".markdown")
                .to_string()
        });
    Ok(Concept {
        id,
        kind: fields
            .get("type")
            .map(|value| value.trim_matches('"').to_string())
            .unwrap_or_else(|| "concept".to_string()),
        title: fields
            .get("title")
            .map(|value| value.trim_matches('"').to_string())
            .unwrap_or_else(|| {
                normalized
                    .trim_end_matches(".md")
                    .trim_end_matches(".markdown")
                    .to_string()
            }),
        description: fields
            .get("description")
            .map(|value| value.trim_matches('"').to_string())
            .unwrap_or_default(),
        tags: fields
            .get("tags")
            .map(|value| frontmatter_list(value))
            .unwrap_or_default(),
        links: extract_links(&body, &document_dir),
        body,
    })
}

/// Read a bundle, build the graph and render the standalone artifact.
pub fn visualize_okf(bundle_dir: &Path, out: &Path, name: Option<&str>) -> CoreResult<Value> {
    if !bundle_dir.is_dir() {
        return Err(CoreError::invalid(
            "OKF_BUNDLE_NOT_FOUND",
            format!("{} is not a bundle directory", bundle_dir.display()),
        ));
    }
    if !bundle_dir.join("index.md").is_file() {
        return Err(CoreError::invalid(
            "OKF_INDEX_MISSING",
            "an OKF bundle must contain index.md",
        ));
    }
    let root = std::fs::canonicalize(bundle_dir)
        .map_err(|error| CoreError::invalid("OKF_BUNDLE_UNREADABLE", error.to_string()))?;
    let mut files = Vec::new();
    walk_markdown(&root, &root, 0, &mut files)?;
    let mut concepts: Vec<Concept> = Vec::new();
    for file in &files {
        concepts.push(read_concept(&root, file)?);
    }
    let by_document: BTreeMap<String, String> = files
        .iter()
        .filter_map(|file| {
            let normalized = normalize_relative(file.strip_prefix(&root).ok()?)?;
            Some((normalized, file.clone()))
        })
        .filter_map(|(normalized, _)| {
            let concept = concepts.iter().find(|concept| {
                concept.id
                    == normalized
                        .trim_end_matches(".md")
                        .trim_end_matches(".markdown")
                    || concept.id == normalized
            })?;
            Some((normalized, concept.id.clone()))
        })
        .collect();
    let mut edges: Vec<Value> = Vec::new();
    let mut backlinks: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for concept in &concepts {
        for link in &concept.links {
            let Some(target) = by_document.get(link) else {
                continue;
            };
            if target == &concept.id {
                continue;
            }
            edges.push(json!({ "source": concept.id, "target": target }));
            backlinks
                .entry(target.clone())
                .or_default()
                .push(concept.id.clone());
        }
    }
    let label = name
        .map(str::to_string)
        .or_else(|| {
            bundle_dir
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "okf-bundle".to_string());

    let mut html = String::new();
    html.push_str("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n");
    html.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    html.push_str(&format!("<title>{}</title>\n", escape_html(&label)));
    html.push_str(
        "<style>body{font-family:ui-sans-serif,system-ui,sans-serif;margin:2rem;max-width:70rem}\
         h1{margin-bottom:.25rem}.muted{color:#666}.concept{border:1px solid #ddd;border-radius:.5rem;\
         padding:1rem;margin:1rem 0}.tag{background:#eef;border-radius:.5rem;padding:.1rem .4rem;\
         margin-right:.25rem;font-size:.8rem}pre{background:#f7f7f7;padding:.5rem;overflow:auto}\
         a{color:#06c}</style>\n",
    );
    html.push_str("</head>\n<body>\n");
    html.push_str(&format!("<h1>{}</h1>\n", escape_html(&label)));
    html.push_str(&format!(
        "<p class=\"muted\">{} concept(s), {} link(s) — static offline export</p>\n",
        concepts.len(),
        edges.len()
    ));
    for concept in &concepts {
        html.push_str("<section class=\"concept\">\n");
        html.push_str(&format!(
            "<h2 id=\"{}\">{}</h2>\n",
            escape_html(&concept.id),
            escape_html(&concept.title)
        ));
        html.push_str(&format!(
            "<p class=\"muted\">{} · {}</p>\n",
            escape_html(&concept.kind),
            escape_html(&concept.id)
        ));
        if !concept.description.is_empty() {
            html.push_str(&format!("<p>{}</p>\n", escape_html(&concept.description)));
        }
        if !concept.tags.is_empty() {
            html.push_str("<p>");
            for tag in &concept.tags {
                html.push_str(&format!("<span class=\"tag\">{}</span>", escape_html(tag)));
            }
            html.push_str("</p>\n");
        }
        html.push_str(&format!("<pre>{}</pre>\n", escape_html(&concept.body)));
        if let Some(links) = backlinks.get(&concept.id) {
            html.push_str(&format!(
                "<p class=\"muted\">Backlinks: {}</p>\n",
                links
                    .iter()
                    .map(|id| escape_html(id))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        html.push_str("</section>\n");
    }
    let graph = json!({
        "name": label,
        "concepts": concepts
            .iter()
            .map(|concept| json!({
                "id": concept.id,
                "type": concept.kind,
                "title": concept.title,
                "description": concept.description,
                "tags": concept.tags,
            }))
            .collect::<Vec<_>>(),
        "edges": edges,
    });
    html.push_str(&format!(
        "<script type=\"application/json\" id=\"okf-bundle-data\">{}</script>\n",
        escape_json_block(&graph)
    ));
    html.push_str("</body>\n</html>\n");
    if html.len() > MAX_HTML_BYTES {
        return Err(CoreError::invalid(
            "OKF_EXPORT_TOO_LARGE",
            "the rendered artifact exceeds the export limit",
        ));
    }
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| CoreError::invalid("OKF_EXPORT_FAILED", error.to_string()))?;
    }
    std::fs::write(out, html.as_bytes())
        .map_err(|error| CoreError::invalid("OKF_EXPORT_FAILED", error.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(out, std::fs::Permissions::from_mode(0o600));
    }
    Ok(json!({
        "path": out.display().to_string(),
        "concepts": concepts.len(),
        "edges": edges.len(),
        "bytes": html.len(),
        "readOnlyInput": true,
    }))
}
