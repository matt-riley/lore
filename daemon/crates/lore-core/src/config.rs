//! v2 configuration and path resolution.
//!
//! Strict: a missing or non-2 `configVersion`, unknown keys, unsafe paths and
//! a v1 database inside the managed directory all fail closed before any
//! storage is created.

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, CoreResult};

/// Wire/store schema version this build owns.
pub const STORE_SCHEMA_VERSION: i64 = 3;
/// Configuration version accepted by this build.
pub const CONFIG_VERSION: u32 = 2;

fn default_embedding_endpoint() -> String {
    "http://127.0.0.1:12434/v1".to_string()
}
fn default_provider_timeout_ms() -> u64 {
    30_000
}
fn default_min_similarity() -> f64 {
    0.35
}

/// Embedding provider configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbeddingsProviderFile {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_embedding_endpoint")]
    pub endpoint: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub dimensions: usize,
    #[serde(default)]
    pub generation: u32,
    #[serde(default = "default_provider_timeout_ms")]
    pub timeout_ms: u64,
    /// Explicit opt-in before a non-loopback endpoint receives any text.
    #[serde(default)]
    pub allow_remote: bool,
    #[serde(default = "default_min_similarity")]
    pub min_similarity: f64,
}

impl Default for EmbeddingsProviderFile {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: default_embedding_endpoint(),
            model: String::new(),
            dimensions: 0,
            generation: 0,
            timeout_ms: default_provider_timeout_ms(),
            allow_remote: false,
            min_similarity: default_min_similarity(),
        }
    }
}

/// Provider configuration block.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidersFile {
    #[serde(default)]
    pub embeddings: EmbeddingsProviderFile,
}

fn default_sweep_seconds() -> u64 {
    60
}
fn default_page_entries() -> usize {
    256
}
fn default_quantum_bytes() -> usize {
    4 * 1024 * 1024
}
fn default_max_record_bytes() -> usize {
    1024 * 1024
}

/// One approved source root. Roots are disabled until listed here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRootFile {
    pub root_id: String,
    pub client: String,
    pub path: String,
    #[serde(default)]
    pub repository: Option<String>,
}

/// Approved source discovery configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcesFile {
    #[serde(default)]
    pub roots: Vec<SourceRootFile>,
    #[serde(default = "default_sweep_seconds")]
    pub sweep_seconds: u64,
    #[serde(default = "default_page_entries")]
    pub page_entries: usize,
    #[serde(default = "default_quantum_bytes")]
    pub quantum_bytes: usize,
    #[serde(default = "default_max_record_bytes")]
    pub max_record_bytes: usize,
}

impl Default for SourcesFile {
    fn default() -> Self {
        Self {
            roots: Vec::new(),
            sweep_seconds: default_sweep_seconds(),
            page_entries: default_page_entries(),
            quantum_bytes: default_quantum_bytes(),
            max_record_bytes: default_max_record_bytes(),
        }
    }
}

/// Validated approved source root.
#[derive(Debug, Clone)]
pub struct ResolvedSourceRoot {
    pub root_id: String,
    pub client: String,
    pub path: PathBuf,
    pub repository: Option<String>,
}

/// Validated source capture settings.
#[derive(Debug, Clone)]
pub struct ResolvedSources {
    pub roots: Vec<ResolvedSourceRoot>,
    pub sweep_seconds: u64,
    pub page_entries: usize,
    pub quantum_bytes: usize,
    pub max_record_bytes: usize,
}

/// Validated embedding settings exposed to the daemon.
#[derive(Debug, Clone)]
pub struct ResolvedEmbedding {
    pub endpoint: String,
    pub model: String,
    pub dimensions: usize,
    pub generation: u32,
    pub timeout_ms: u64,
    pub min_similarity: f64,
    /// Sanitized identity slug persisted beside vectors and intents.
    pub identity: String,
    /// Short display identity for Status.
    pub display: String,
}

fn default_content_bytes() -> usize {
    64 * 1024
}
fn default_query_bytes() -> usize {
    16 * 1024
}
fn default_tags() -> usize {
    32
}
fn default_tag_bytes() -> usize {
    128
}
fn default_results() -> u32 {
    6
}
fn default_results_limit() -> u32 {
    20
}
fn default_context_bytes() -> u32 {
    8 * 1024
}
fn default_max_context_bytes() -> u32 {
    32 * 1024
}
fn default_recall_server_ms() -> u64 {
    160
}
fn default_max_memories() -> i64 {
    100_000
}
fn default_max_receipts() -> i64 {
    1_000_000
}
fn default_candidate_pool() -> usize {
    200
}

/// Stage-2 limits. Defaults are the normative values from
/// `docs/v2/configuration-storage.md`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    #[serde(default = "default_content_bytes")]
    pub max_content_bytes: usize,
    #[serde(default = "default_query_bytes")]
    pub max_query_bytes: usize,
    #[serde(default = "default_tags")]
    pub max_tags: usize,
    #[serde(default = "default_tag_bytes")]
    pub max_tag_bytes: usize,
    #[serde(default = "default_results")]
    pub default_results: u32,
    #[serde(default = "default_results_limit")]
    pub max_results: u32,
    #[serde(default = "default_context_bytes")]
    pub default_context_bytes: u32,
    #[serde(default = "default_max_context_bytes")]
    pub max_context_bytes: u32,
    #[serde(default = "default_recall_server_ms")]
    pub recall_server_ms: u64,
    #[serde(default = "default_max_memories")]
    pub max_memories: i64,
    #[serde(default = "default_max_receipts")]
    pub max_receipts: i64,
    #[serde(default = "default_candidate_pool")]
    pub candidate_pool: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_content_bytes: default_content_bytes(),
            max_query_bytes: default_query_bytes(),
            max_tags: default_tags(),
            max_tag_bytes: default_tag_bytes(),
            default_results: default_results(),
            max_results: default_results_limit(),
            default_context_bytes: default_context_bytes(),
            max_context_bytes: default_max_context_bytes(),
            recall_server_ms: default_recall_server_ms(),
            max_memories: default_max_memories(),
            max_receipts: default_max_receipts(),
            candidate_pool: default_candidate_pool(),
        }
    }
}

/// Parsed `lore.json` for v2.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigFile {
    pub config_version: u32,
    #[serde(default)]
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub socket_path: Option<String>,
    #[serde(default)]
    pub limits: Limits,
    #[serde(default)]
    pub providers: ProvidersFile,
    #[serde(default)]
    pub sources: SourcesFile,
}

/// Config with every path resolved and validated.
#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    pub enabled: bool,
    pub config_path: Option<PathBuf>,
    pub data_dir: PathBuf,
    pub socket_path: PathBuf,
    pub store_path: PathBuf,
    pub limits: Limits,
    /// Embedding identity slug when the provider is enabled.
    pub embedding_identity: Option<String>,
    /// Validated embedding settings when the provider is enabled.
    pub embedding: Option<ResolvedEmbedding>,
    /// Approved source discovery and capture settings.
    pub sources: ResolvedSources,
}

impl ResolvedConfig {
    /// Load and validate configuration. Command-line overrides win over the
    /// file, and relative configured paths resolve against the config file's
    /// directory, never the working directory.
    pub fn load(
        config_path: Option<&Path>,
        data_dir_override: Option<&Path>,
        socket_override: Option<&Path>,
    ) -> CoreResult<Self> {
        let (config_path, file, base) = read_config(config_path)?;

        let data_dir = match data_dir_override {
            Some(path) => absolutize(path, &base),
            None => match file.as_ref().and_then(|file| file.data_dir.as_deref()) {
                Some(value) => absolutize(Path::new(value), &base),
                None => {
                    if config_path.is_some() {
                        base.clone()
                    } else {
                        return Err(CoreError::invalid(
                            "CONFIG_REQUIRED",
                            "provide --config or --data-dir",
                        ));
                    }
                }
            },
        };
        ensure_private_dir(&data_dir, "data directory")?;

        let v1_database = data_dir.join("lore.db");
        if v1_database.exists() {
            return Err(CoreError::precondition(
                "V1_DATABASE_PRESENT",
                format!(
                    "refusing to manage a directory containing {}",
                    v1_database.display()
                ),
            ));
        }

        let store_path = data_dir.join("lore-v2.db");
        if let Ok(metadata) = std::fs::symlink_metadata(&store_path)
            && (metadata.file_type().is_symlink() || !metadata.is_file())
        {
            return Err(CoreError::precondition(
                "UNSAFE_PATH",
                format!("store path is not a regular file: {}", store_path.display()),
            ));
        }

        let socket_path = match socket_override {
            Some(path) => absolutize(path, &base),
            None => match file.as_ref().and_then(|file| file.socket_path.as_deref()) {
                Some(value) => absolutize(Path::new(value), &base),
                None => default_socket_path(&data_dir),
            },
        };
        if socket_path.as_os_str().len() > 100 {
            return Err(CoreError::invalid(
                "SOCKET_PATH_TOO_LONG",
                "socket path must be at most 100 bytes",
            ));
        }
        let socket_parent = socket_path.parent().ok_or_else(|| {
            CoreError::invalid("UNSAFE_PATH", "socket path needs a parent directory")
        })?;
        ensure_private_dir(socket_parent, "socket directory")?;

        let providers = file
            .as_ref()
            .map(|file| file.providers.clone())
            .unwrap_or_default();
        let embedding = resolve_embedding(&providers)?;
        let sources = resolve_sources(
            file.as_ref()
                .map(|file| file.sources.clone())
                .unwrap_or_default(),
            &base,
        )?;

        Ok(Self {
            enabled: file.as_ref().map(|file| file.enabled).unwrap_or(false),
            config_path,
            data_dir,
            socket_path,
            store_path,
            limits: file
                .as_ref()
                .map(|file| file.limits.clone())
                .unwrap_or_default(),
            embedding_identity: embedding
                .as_ref()
                .map(|embedding| embedding.identity.clone()),
            embedding,
            sources,
        })
    }
}

fn absolutize(path: &Path, base: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

/// Clients with a shipped parser. An unrecognized client never ingests.
pub const SOURCE_CLIENTS: [&str; 5] = ["pi", "codex", "claude", "antigravity", "copilot"];

fn resolve_sources(file: SourcesFile, base: &Path) -> CoreResult<ResolvedSources> {
    let mut roots = Vec::with_capacity(file.roots.len());
    let mut seen = std::collections::HashSet::new();
    for root in &file.roots {
        if root.root_id.trim().is_empty() || root.root_id.len() > 128 {
            return Err(CoreError::invalid(
                "SOURCE_ROOT_INVALID",
                "rootId is required and must be at most 128 bytes",
            ));
        }
        if !seen.insert(root.root_id.clone()) {
            return Err(CoreError::invalid(
                "SOURCE_ROOT_INVALID",
                format!("duplicate rootId {}", root.root_id),
            ));
        }
        if !SOURCE_CLIENTS.contains(&root.client.as_str()) {
            return Err(CoreError::invalid(
                "SOURCE_CLIENT_UNSUPPORTED",
                format!("unsupported source client {}", root.client),
            ));
        }
        let path = absolutize(Path::new(&root.path), base);
        if !path.is_absolute() {
            return Err(CoreError::invalid(
                "SOURCE_ROOT_INVALID",
                "source root path must be absolute",
            ));
        }
        roots.push(ResolvedSourceRoot {
            root_id: root.root_id.clone(),
            client: root.client.clone(),
            path,
            repository: root.repository.clone(),
        });
    }
    Ok(ResolvedSources {
        roots,
        sweep_seconds: file.sweep_seconds.clamp(5, 3_600),
        page_entries: file.page_entries.clamp(1, 4_096),
        quantum_bytes: file.quantum_bytes.clamp(64 * 1024, 64 * 1024 * 1024),
        max_record_bytes: file.max_record_bytes.clamp(64 * 1024, 16 * 1024 * 1024),
    })
}

/// Validate and resolve the embedding provider configuration.
fn resolve_embedding(providers: &ProvidersFile) -> CoreResult<Option<ResolvedEmbedding>> {
    let file = &providers.embeddings;
    if !file.enabled {
        return Ok(None);
    }
    if file.model.trim().is_empty() {
        return Err(CoreError::invalid(
            "PROVIDER_MODEL_INVALID",
            "embedding model is required when embeddings are enabled",
        ));
    }
    if file.dimensions == 0 || file.dimensions > 3_072 {
        return Err(CoreError::invalid(
            "PROVIDER_DIMENSIONS",
            "embedding dimensions must be 1-3072",
        ));
    }
    if !file.min_similarity.is_finite() || !(0.0..=1.0).contains(&file.min_similarity) {
        return Err(CoreError::invalid(
            "PROVIDER_CONFIG",
            "minSimilarity must be within 0-1",
        ));
    }
    let parsed = url::Url::parse(&file.endpoint).map_err(|_| {
        CoreError::invalid(
            "PROVIDER_CONFIG",
            "embedding endpoint must be an absolute URL",
        )
    })?;
    let loopback = matches!(
        parsed.host_str().unwrap_or_default(),
        "127.0.0.1" | "::1" | "[::1]" | "localhost"
    );
    if !loopback && !file.allow_remote {
        return Err(CoreError::precondition(
            "PROVIDER_REMOTE_NOT_ALLOWED",
            "remote embedding endpoints require allowRemote: true",
        ));
    }
    let identity = lore_provider::ProviderIdentity::new(
        &file.endpoint,
        &file.model,
        file.generation,
        file.dimensions,
    )
    .map_err(|error| CoreError::invalid(error.category(), error.to_string()))?;
    Ok(Some(ResolvedEmbedding {
        endpoint: file.endpoint.clone(),
        model: file.model.clone(),
        dimensions: file.dimensions,
        generation: file.generation,
        timeout_ms: file.timeout_ms.clamp(50, 60_000),
        min_similarity: file.min_similarity,
        identity: identity.slug(),
        display: identity.display(),
    }))
}

fn read_config(
    config_path: Option<&Path>,
) -> CoreResult<(Option<PathBuf>, Option<ConfigFile>, PathBuf)> {
    let config_path = match config_path {
        Some(path) => Some(
            std::fs::canonicalize(path)
                .map_err(|error| CoreError::invalid("CONFIG_UNREADABLE", format!("{error}")))?,
        ),
        None => None,
    };
    let base = config_path
        .as_deref()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let file = match &config_path {
        Some(path) => {
            let raw = std::fs::read_to_string(path)
                .map_err(|error| CoreError::invalid("CONFIG_UNREADABLE", format!("{error}")))?;
            let parsed: ConfigFile = serde_json::from_str(&raw).map_err(|error| {
                CoreError::invalid("CONFIG_INVALID", format!("could not parse config: {error}"))
            })?;
            if parsed.config_version != CONFIG_VERSION {
                return Err(CoreError::invalid(
                    "CONFIG_VERSION",
                    format!(
                        "configVersion {} is not supported (expected {CONFIG_VERSION})",
                        parsed.config_version
                    ),
                ));
            }
            Some(parsed)
        }
        None => None,
    };
    Ok((config_path, file, base))
}

/// Resolve only the endpoint path, without creating or validating storage.
/// The CLI uses this so a read-only command never mutates the data directory.
pub fn resolve_socket_path(
    config_path: Option<&Path>,
    socket_override: Option<&Path>,
) -> CoreResult<PathBuf> {
    let (_, file, base) = read_config(config_path)?;
    let path = match socket_override {
        Some(path) => absolutize(path, &base),
        None => match file.as_ref().and_then(|file| file.socket_path.as_deref()) {
            Some(value) => absolutize(Path::new(value), &base),
            None => {
                let data_dir = match file.as_ref().and_then(|file| file.data_dir.as_deref()) {
                    Some(value) => absolutize(Path::new(value), &base),
                    None if config_path.is_some() => base.clone(),
                    None => {
                        return Err(CoreError::invalid(
                            "CONFIG_REQUIRED",
                            "provide --config or --socket",
                        ));
                    }
                };
                default_socket_path(&data_dir)
            }
        },
    };
    Ok(path)
}

/// Fail unless `path` is an owned private directory; create it when missing.
pub fn ensure_private_dir(path: &Path, label: &str) -> CoreResult<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(CoreError::precondition(
                    "UNSAFE_PATH",
                    format!("{label} is not a directory: {}", path.display()),
                ));
            }
            if metadata.uid() != effective_uid() {
                return Err(CoreError::precondition(
                    "UNSAFE_PATH",
                    format!("{label} is not owned by this user: {}", path.display()),
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(path)?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

/// Process EUID, used for ownership checks and the runtime directory.
pub fn effective_uid() -> u32 {
    // SAFETY: geteuid is a pure lookup with no memory effects.
    unsafe { libc::geteuid() }
}

/// Private runtime base: an owned 0700 `XDG_RUNTIME_DIR`, else `/tmp/lore-<uid>`.
pub fn runtime_dir() -> PathBuf {
    if let Ok(value) = std::env::var("XDG_RUNTIME_DIR") {
        let path = PathBuf::from(value);
        if let Ok(metadata) = std::fs::symlink_metadata(&path)
            && metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == effective_uid()
            && metadata.permissions().mode() & 0o077 == 0
        {
            return path;
        }
    }
    PathBuf::from(format!("/tmp/lore-{}", effective_uid()))
}

/// Endpoint basename: first 24 hex characters of the canonical data-dir hash.
pub fn socket_basename(data_dir: &Path) -> String {
    let canonical = std::fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("{}.sock", &digest[..24])
}

fn default_socket_path(data_dir: &Path) -> PathBuf {
    runtime_dir().join(socket_basename(data_dir))
}
