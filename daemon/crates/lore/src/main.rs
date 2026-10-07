//! `lore` — the Lore v2 CLI. Stage-2 proof operations: status and the three
//! durable verbs via `tool <canonical-name>` with a JSON object on stdin.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand};
use protocol::RequestMeta;
use serde_json::Value;

#[derive(Debug, Parser)]
#[command(name = "lore", version, about = "Lore v2 CLI")]
struct Cli {
    /// v2 configuration file.
    #[arg(long, env = "LORE_V2_CONFIG", global = true)]
    config: Option<PathBuf>,
    /// Managed data directory (for offline backup, restore and migration).
    #[arg(long, env = "LORE_V2_DATA_DIR", global = true)]
    data_dir: Option<PathBuf>,
    /// Unix socket path (overrides config).
    #[arg(long, env = "LORE_V2_SOCKET", global = true)]
    socket: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Fetch daemon status.
    Status {
        /// Print the JSON response (the only output format).
        #[arg(long = "json")]
        json: bool,
    },
    /// Invoke one proof operation with a JSON object on stdin.
    Tool { name: String },
    /// Create a consistent store snapshot with a manifest.
    Backup {
        #[arg(long)]
        destination: PathBuf,
    },
    /// Restore a snapshot, preserving later deletions and receipts.
    Restore {
        #[arg(long)]
        from: PathBuf,
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long)]
        apply: bool,
        #[arg(long)]
        plan: Option<String>,
        #[arg(long = "clients-stopped")]
        clients_stopped: bool,
    },
    /// Import a released v1 store into a separate v2 destination.
    Migrate {
        #[command(subcommand)]
        action: MigrateCommand,
    },
}

#[derive(Debug, Subcommand)]
enum MigrateCommand {
    /// Preview or apply an import from a specific v1 database.
    V1 {
        #[arg(long)]
        source: PathBuf,
        #[arg(long)]
        destination: PathBuf,
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long)]
        apply: bool,
        #[arg(long)]
        plan: Option<String>,
        #[arg(long = "clients-stopped")]
        clients_stopped: bool,
    },
    /// Inspect a migration run.
    Status {
        #[arg(long)]
        destination: PathBuf,
        #[arg(long)]
        run: String,
    },
    /// Resume a staged import from its immutable snapshot.
    Resume {
        #[arg(long)]
        destination: PathBuf,
        #[arg(long)]
        run: String,
        #[arg(long)]
        apply: bool,
    },
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("lore: {message}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<(), String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0);
    match &cli.command {
        Command::Backup { destination } => {
            let store = resolve_store_path(&cli)?;
            let manifest =
                lore_core::migration::backup::backup(store.as_path(), destination, now_ms)
                    .map_err(core_message)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&manifest).unwrap_or_default()
            );
            return Ok(());
        }
        Command::Restore {
            from,
            dry_run,
            apply,
            plan,
            clients_stopped,
        } => {
            let store = resolve_store_path(&cli)?;
            let value = if *apply {
                let plan = plan
                    .as_deref()
                    .ok_or_else(|| "--apply requires --plan <fingerprint>".to_string())?;
                serde_json::to_value(
                    lore_core::migration::backup::restore_apply(
                        from,
                        &store,
                        plan,
                        *clients_stopped,
                        now_ms,
                    )
                    .map_err(core_message)?,
                )
            } else {
                let _ = dry_run;
                serde_json::to_value(
                    lore_core::migration::backup::restore_preview(from, &store)
                        .map_err(core_message)?,
                )
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&value.unwrap_or_default()).unwrap_or_default()
            );
            return Ok(());
        }
        Command::Migrate { action } => {
            match action {
                MigrateCommand::V1 {
                    source,
                    destination,
                    dry_run,
                    apply,
                    plan,
                    clients_stopped,
                } => {
                    let value = if *apply {
                        let plan = plan
                            .as_deref()
                            .ok_or_else(|| "--apply requires --plan <fingerprint>".to_string())?;
                        serde_json::to_value(
                            lore_core::migration::apply(
                                source,
                                destination,
                                plan,
                                *clients_stopped,
                                now_ms,
                            )
                            .map_err(core_message)?,
                        )
                    } else {
                        let _ = dry_run;
                        serde_json::to_value(
                            lore_core::migration::preview(source, destination)
                                .map_err(core_message)?,
                        )
                    };
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&value.unwrap_or_default())
                            .unwrap_or_default()
                    );
                }
                MigrateCommand::Status { destination, run } => {
                    let value =
                        lore_core::migration::status(destination, run).map_err(core_message)?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&value).unwrap_or_default()
                    );
                }
                MigrateCommand::Resume {
                    destination,
                    run,
                    apply,
                } => {
                    if !*apply {
                        return Err("resume requires --apply".to_string());
                    }
                    let value = lore_core::migration::resume(destination, run, now_ms)
                        .map_err(core_message)?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&value).unwrap_or_default()
                    );
                }
            }
            return Ok(());
        }
        _ => {}
    }

    let socket =
        lore_core::config::resolve_socket_path(cli.config.as_deref(), cli.socket.as_deref())
            .map_err(core_message)?;
    match cli.command {
        Command::Status { json: _ } => {
            let outcome = request(&socket, "/v2/status", &serde_json::json!({}), None).await?;
            print_outcome(&outcome)
        }
        Command::Tool { name } => {
            let (route, requires_store) = match name.as_str() {
                "lore_status" | "memory_status" => ("/v2/status", false),
                "lore_retain" | "lore_save" | "memory_save" => ("/v2/retain", true),
                "lore_forget" | "memory_forget" => ("/v2/forget", true),
                "lore_recall" | "memory_search" => ("/v2/recall", true),
                other => return Err(format!("unimplemented operation: {other}")),
            };
            let params = read_stdin_params()?;
            let expected = if requires_store {
                Some(resolve_store_id(&socket).await?)
            } else {
                None
            };
            let outcome = request(&socket, route, &params, expected.as_deref()).await?;
            print_outcome(&outcome)
        }
        Command::Backup { .. } | Command::Restore { .. } | Command::Migrate { .. } => {
            unreachable!()
        }
    }
}

fn core_message(error: lore_core::error::CoreError) -> String {
    format!("{}: {}", error.code, error.message)
}

/// Resolve the managed store path for offline operations.
fn resolve_store_path(cli: &Cli) -> Result<PathBuf, String> {
    let config = lore_core::config::ResolvedConfig::load(
        cli.config.as_deref(),
        cli.data_dir.as_deref(),
        None,
    )
    .map_err(core_message)?;
    Ok(config.store_path)
}

async fn request(
    socket: &Path,
    path: &str,
    params: &Value,
    expected_store_id: Option<&str>,
) -> Result<lore::StatusOutcome, String> {
    let meta = RequestMeta {
        client_id: "cli".to_string(),
        request_id: format!("cli-{}-{:x}", std::process::id(), nanos()),
        session_id: None,
        expected_store_id: expected_store_id.map(str::to_string),
        timeout_ms: None,
        required_capabilities: Vec::new(),
    };
    lore::request(socket, path, meta, params.clone())
        .await
        .map_err(|error| format!("{error:#}"))
}

fn read_stdin_params() -> Result<Value, String> {
    let raw = std::io::read_to_string(std::io::stdin()).map_err(|error| error.to_string())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::json!({}));
    }
    let value: Value =
        serde_json::from_str(trimmed).map_err(|error| format!("invalid JSON on stdin: {error}"))?;
    if !value.is_object() {
        return Err("stdin must carry one JSON object".to_string());
    }
    Ok(value)
}

async fn resolve_store_id(socket: &Path) -> Result<String, String> {
    let outcome = request(socket, "/v2/status", &serde_json::json!({}), None).await?;
    if !outcome.is_success() {
        return Err(format!("status failed: {}", outcome.body));
    }
    let value: Value = serde_json::from_str(&outcome.body).map_err(|error| error.to_string())?;
    value
        .get("storeId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "status response is missing storeId".to_string())
}

fn print_outcome(outcome: &lore::StatusOutcome) -> Result<(), String> {
    println!("{}", outcome.body);
    if outcome.is_success() {
        Ok(())
    } else {
        Err("request failed".to_string())
    }
}

fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
}
