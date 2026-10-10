//! Skill validation: read configured skill roots, check SKILL.md front
//! matter and structure, and report results. Never executes skill text.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_SKILL_FILES: usize = 200;
const MAX_SKILL_BYTES: u64 = 256 * 1024;
const MAX_DEPTH: usize = 4;

/// One validated skill file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillReport {
    pub path: String,
    pub name: Option<String>,
    pub ok: bool,
    pub issues: Vec<String>,
}

/// Validation result across all roots.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillValidation {
    pub roots: Vec<String>,
    pub skills: Vec<SkillReport>,
    pub ok: bool,
    pub scanned: usize,
}

fn frontmatter_fields(body: &str) -> Option<Vec<(String, String)>> {
    let rest = body.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let header = &rest[..end];
    let mut fields = Vec::new();
    for line in header.lines() {
        if let Some((key, value)) = line.split_once(':') {
            fields.push((
                key.trim().to_lowercase(),
                value.trim().trim_matches('"').to_string(),
            ));
        }
    }
    Some(fields)
}

fn validate_file(path: &Path) -> SkillReport {
    let display = path.display().to_string();
    let mut issues = Vec::new();
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            issues.push(format!("unreadable: {error}"));
            return SkillReport {
                path: display,
                name: None,
                ok: false,
                issues,
            };
        }
    };
    if bytes.len() as u64 > MAX_SKILL_BYTES {
        issues.push("file exceeds the size limit".to_string());
    }
    let body = String::from_utf8_lossy(&bytes);
    let fields = match frontmatter_fields(&body) {
        Some(fields) => fields,
        None => {
            issues.push("missing YAML front matter".to_string());
            Vec::new()
        }
    };
    let name = fields
        .iter()
        .find(|(key, _)| key == "name")
        .map(|(_, value)| value.clone());
    let description = fields
        .iter()
        .find(|(key, _)| key == "description")
        .map(|(_, value)| value.clone());
    if name.as_deref().unwrap_or("").trim().is_empty() {
        issues.push("front matter needs a name".to_string());
    }
    if description.as_deref().unwrap_or("").trim().is_empty() {
        issues.push("front matter needs a description".to_string());
    }
    let body_after = body
        .split_once("\n---")
        .map(|(_, after)| after)
        .unwrap_or_default()
        .trim();
    if body_after.is_empty() {
        issues.push("SKILL.md has no body".to_string());
    }
    SkillReport {
        path: display,
        name,
        ok: issues.is_empty(),
        issues,
    }
}

fn expected_name(path: &Path) -> Option<String> {
    path.parent()?
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
}

/// Validate every `SKILL.md` under the given roots. When no roots are
/// supplied, no scanning happens and the call reports an empty result.
pub fn validate(paths: &[String]) -> SkillValidation {
    let roots: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let mut skills = Vec::new();
    let mut scanned = 0usize;
    for root in &roots {
        if !root.is_dir() {
            skills.push(SkillReport {
                path: root.display().to_string(),
                name: None,
                ok: false,
                issues: vec!["root is not a directory".to_string()],
            });
            continue;
        }
        let mut stack = vec![(root.clone(), 0usize)];
        while let Some((directory, depth)) = stack.pop() {
            if depth > MAX_DEPTH || scanned >= MAX_SKILL_FILES {
                continue;
            }
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let file_type = match entry.file_type() {
                    Ok(file_type) => file_type,
                    Err(_) => continue,
                };
                if file_type.is_symlink() {
                    continue;
                }
                if file_type.is_dir() {
                    stack.push((path, depth + 1));
                    continue;
                }
                if path.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
                    continue;
                }
                if scanned >= MAX_SKILL_FILES {
                    break;
                }
                scanned += 1;
                let mut report = validate_file(&path);
                if let Some(expected) = expected_name(&path)
                    && let Some(name) = report.name.as_deref()
                    && !name.is_empty()
                    && name != expected
                {
                    report.issues.push(format!(
                        "front matter name {name:?} does not match directory {expected:?}"
                    ));
                    report.ok = false;
                }
                skills.push(report);
            }
        }
    }
    let ok = skills.iter().all(|skill| skill.ok);
    SkillValidation {
        roots: roots
            .iter()
            .map(|root| root.display().to_string())
            .collect(),
        skills,
        ok,
        scanned,
    }
}

/// Default skill roots: the Pi agent skills directory and the store-local
/// `skills` directory. Missing roots are skipped.
pub fn default_roots(home: Option<&Path>, data_dir: Option<&Path>) -> Vec<String> {
    let mut roots = Vec::new();
    if let Some(home) = home {
        let pi = home.join(".pi/agent/skills");
        if pi.is_dir() {
            roots.push(pi.display().to_string());
        }
    }
    if let Some(data_dir) = data_dir {
        let local = data_dir.join("skills");
        if local.is_dir() {
            roots.push(local.display().to_string());
        }
    }
    roots
}

/// Serialize a validation result into the admin response shape.
pub fn to_value(validation: &SkillValidation) -> Value {
    serde_json::to_value(validation).unwrap_or(Value::Null)
}
