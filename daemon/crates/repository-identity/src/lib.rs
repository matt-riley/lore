//! Repository identity resolution, ported from the v1 contract in
//! `lib/utils/repository-identity.mjs`.
//!
//! The shared fixtures under `tests/v2/fixtures/repository-identity.json` are
//! asserted from both languages, so the port cannot drift silently. Git
//! remote inspection uses the `git` CLI; a local-only repository falls back to
//! a hash of its canonical Git common directory, which keeps linked worktrees
//! on one identity.

use std::path::Path;
use std::process::Command;

use sha2::{Digest, Sha256};

/// Explicit legacy-to-canonical mapping approved by the user.
#[derive(Debug, Clone)]
pub struct Mapping {
    pub legacy: String,
    pub canonical: String,
}

/// Inputs for [`resolve_repository_identity`].
#[derive(Debug, Default)]
pub struct ResolveInput<'a> {
    /// Directory to inspect for live Git identity.
    pub cwd: Option<&'a Path>,
    /// Host-provided identity, which always wins.
    pub explicit: Option<&'a str>,
    /// Legacy identity that requires an explicit mapping.
    pub legacy: Option<&'a str>,
    /// Approved legacy mappings.
    pub mappings: &'a [Mapping],
}

/// Normalize a remote transport to `host/path`, keeping host and full path.
///
/// Supports `ssh://`, `https://`, `http://`, `git://` and scp-like
/// `user@host:path` forms. Unknown transports, empty paths, unsafe segments
/// and whitespace are rejected.
pub fn canonical_remote_identity(value: &str) -> Option<String> {
    let text = value.trim();
    if text.is_empty() {
        return None;
    }

    let (host, remote_path) = if text.contains("://") {
        let url = url::Url::parse(text).ok()?;
        if !matches!(url.scheme(), "ssh" | "https" | "http" | "git") {
            return None;
        }
        let mut host = url.host_str()?.to_lowercase();
        if let Some(port) = url.port() {
            host.push(':');
            host.push_str(&port.to_string());
        }
        (host, url.path().to_string())
    } else {
        let separator = scp_separator(text)?;
        let (host_part, rest) = text.split_at(separator);
        let remote_path = &rest[1..];
        let host = if let Some(index) = host_part.rfind('@') {
            let user = &host_part[..index];
            if user.is_empty()
                || user
                    .chars()
                    .any(|c| c.is_whitespace() || c == '/' || c == ':' || c == '@')
            {
                return None;
            }
            &host_part[index + 1..]
        } else {
            host_part
        };
        if host.is_empty() || host.chars().any(char::is_whitespace) || host.contains('/') {
            return None;
        }
        if host.starts_with('[') {
            if !host.ends_with(']') || host.len() < 3 {
                return None;
            }
        } else if host.contains(':') || host.len() <= 1 {
            return None;
        }
        (host.to_lowercase(), remote_path.to_string())
    };

    let remote_path = remote_path.trim_matches('/');
    let remote_path = remote_path.strip_suffix(".git").unwrap_or(remote_path);
    if host.is_empty() || remote_path.is_empty() {
        return None;
    }
    if remote_path
        .chars()
        .any(|c| c.is_whitespace() || c == '?' || c == '#')
    {
        return None;
    }
    if remote_path
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    Some(format!("{host}/{remote_path}"))
}

/// Locate the host/path separator of an scp-like remote, allowing a bracketed
/// IPv6 host.
fn scp_separator(text: &str) -> Option<usize> {
    if let Some(stripped) = text.strip_prefix('[') {
        let close = stripped.find(']')? + 1;
        let offset = text[close + 1..].find(':')?;
        return Some(close + 1 + offset);
    }
    text.find(':')
}

/// Resolve live Git identity, or an explicitly approved legacy association.
///
/// `explicit` always wins. Otherwise a Git work tree resolves to its origin
/// remote or `local:<sha256>` of the canonical Git common directory. Only
/// explicitly mapped legacy identifiers are trusted for non-repository paths.
pub fn resolve_repository_identity(input: ResolveInput<'_>) -> Option<String> {
    if let Some(explicit) = input.explicit.map(str::trim).filter(|v| !v.is_empty()) {
        return Some(explicit.to_string());
    }
    if let Some(cwd) = input.cwd
        && let Some(identity) = resolve_from_git(cwd)
    {
        return Some(identity);
    }
    mapped_identity(
        input.legacy.map(str::trim).filter(|v| !v.is_empty()),
        input.mappings,
    )
}

fn resolve_from_git(cwd: &Path) -> Option<String> {
    let common = git(cwd, &["rev-parse", "--git-common-dir"])?;
    let common_path = std::fs::canonicalize(cwd.join(&common)).ok()?;
    if let Some(remote) = git(cwd, &["remote", "get-url", "origin"])
        .as_deref()
        .and_then(canonical_remote_identity)
    {
        return Some(remote);
    }
    let mut hasher = Sha256::new();
    hasher.update(common_path.to_string_lossy().as_bytes());
    Some(format!("local:{:x}", hasher.finalize()))
}

fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn mapped_identity(legacy: Option<&str>, mappings: &[Mapping]) -> Option<String> {
    let legacy = legacy?;
    let mut matches: Vec<&str> = mappings
        .iter()
        .filter(|mapping| mapping.legacy == legacy)
        .map(|mapping| mapping.canonical.as_str())
        .filter(|canonical| !canonical.trim().is_empty())
        .collect();
    matches.sort_unstable();
    matches.dedup();
    if matches.len() == 1 {
        Some(matches[0].to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    fn fixtures() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../../tests/v2/fixtures/repository-identity.json"
        ))
        .expect("fixture json parses")
    }

    #[test]
    fn canonicalization_matches_shared_fixtures() {
        for case in fixtures()["canonicalRemote"].as_array().expect("cases") {
            let input = case["input"].as_str().expect("input");
            let expected = case["expected"].as_str().map(str::to_string);
            assert_eq!(canonical_remote_identity(input), expected, "input: {input}");
        }
    }

    #[test]
    fn resolution_matches_shared_fixtures() {
        for case in fixtures()["resolve"].as_array().expect("cases") {
            let input = &case["input"];
            let expected = case["expected"].as_str().map(str::to_string);
            let mappings: Vec<Mapping> = input["mappings"]
                .as_array()
                .map(|rows| {
                    rows.iter()
                        .map(|row| Mapping {
                            legacy: row["legacy"].as_str().unwrap_or_default().to_string(),
                            canonical: row["canonical"].as_str().unwrap_or_default().to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let resolved = resolve_repository_identity(ResolveInput {
                explicit: input["explicit"].as_str(),
                legacy: input["legacy"].as_str(),
                mappings: &mappings,
                ..Default::default()
            });
            assert_eq!(resolved, expected, "input: {input}");
        }
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args([
                "-c",
                "init.defaultBranch=main",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap_or_else(|error| panic!("git {args:?}: {error}"));
        assert!(status.success(), "git {args:?} failed");
    }

    fn resolve_at(cwd: &Path) -> Option<String> {
        resolve_repository_identity(ResolveInput {
            cwd: Some(cwd),
            ..Default::default()
        })
    }

    #[test]
    fn local_repos_are_isolated_and_worktrees_share_identity() {
        let root = tempfile::tempdir().expect("tempdir");
        let first = root.path().join("one/project");
        let second = root.path().join("two/project");
        std::fs::create_dir_all(&first).expect("first");
        std::fs::create_dir_all(&second).expect("second");
        run_git(&first, &["init", "-q"]);
        run_git(&second, &["init", "-q"]);
        run_git(&first, &["commit", "--allow-empty", "-m", "fixture"]);
        let linked = root.path().join("linked");
        run_git(
            &first,
            &[
                "worktree",
                "add",
                "--detach",
                linked.to_str().expect("utf8"),
            ],
        );

        let first_identity = resolve_at(&first).expect("first identity");
        assert!(first_identity.starts_with("local:"), "{first_identity}");
        assert_eq!(first_identity.len(), "local:".len() + 64);
        let second_identity = resolve_at(&second).expect("second identity");
        assert_ne!(first_identity, second_identity);
        assert_eq!(
            first_identity,
            resolve_at(&linked).expect("linked identity")
        );
    }

    #[test]
    fn origin_remote_wins_over_the_local_hash() {
        let root = tempfile::tempdir().expect("tempdir");
        let repo = root.path().join("project");
        std::fs::create_dir_all(&repo).expect("repo");
        run_git(&repo, &["init", "-q"]);
        run_git(
            &repo,
            &["remote", "add", "origin", "git@github.com:team/project.git"],
        );
        assert_eq!(
            resolve_at(&repo).as_deref(),
            Some("github.com/team/project")
        );
    }

    #[test]
    fn non_repository_paths_use_explicit_or_mapped_legacy_only() {
        let root = tempfile::tempdir().expect("tempdir");
        let plain = root.path().join("plain");
        std::fs::create_dir_all(&plain).expect("plain");

        assert_eq!(resolve_at(&plain), None);
        let explicit = resolve_repository_identity(ResolveInput {
            cwd: Some(&plain),
            explicit: Some(" custom/key "),
            ..Default::default()
        });
        assert_eq!(explicit.as_deref(), Some("custom/key"));

        let mappings = vec![Mapping {
            legacy: "team/project".to_string(),
            canonical: "github.com/team/project".to_string(),
        }];
        let mapped = resolve_repository_identity(ResolveInput {
            cwd: Some(&plain),
            legacy: Some("team/project"),
            mappings: &mappings,
            ..Default::default()
        });
        assert_eq!(mapped.as_deref(), Some("github.com/team/project"));
    }
}
