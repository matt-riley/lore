//! `lore` — the Lore v2 CLI: status, canonical operations, native hooks,
//! the uncertain-write journal, and offline migration/backup commands.

mod browser;
mod hooks;
mod installer;
mod journal;
mod registry;
mod service;

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand};
use protocol::RequestMeta;
use serde_json::{Value, json};

#[derive(Debug, Parser)]
#[command(name = "lore", version, about = "Lore v2 CLI")]
struct Cli {
    /// v2 configuration file.
    #[arg(long, env = "LORE_V2_CONFIG", global = true)]
    config: Option<PathBuf>,
    /// Managed data directory (for offline backup, restore and migration).
    #[arg(long, env = "LORE_V2_DATA_DIR", global = true)]
    data_dir: Option<PathBuf>,
    /// Home directory override for service and mode commands.
    #[arg(long, env = "LORE_HOME", global = true)]
    home: Option<PathBuf>,
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
    /// Invoke one canonical operation with a JSON object on stdin.
    Tool {
        name: String,
        /// Output format for the result: `text` (default) or `json`.
        #[arg(long, default_value = "text")]
        output: String,
    },
    /// Lexically browse stored memory (administrative scope selection).
    Search {
        query: String,
        #[arg(long)]
        repository: Option<String>,
        /// Explicit administrative selection across repositories.
        #[arg(long = "all-repositories")]
        all_repositories: bool,
        #[arg(long, default_value = "text")]
        output: String,
    },
    /// Recall memory for a prompt using the daemon's policy.
    Recall {
        query: String,
        #[arg(long)]
        repository: Option<String>,
        #[arg(long, default_value = "text")]
        output: String,
    },
    /// Native host hook: translate a host event into daemon calls.
    Hook { client: String, event: String },
    /// Serve the read-only dashboard from a loopback gateway.
    Browser {
        /// Local port (0 chooses a free port).
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// Open the system browser after binding.
        #[arg(long)]
        open: bool,
    },
    /// Print the checked-in capability catalog (adapters consume this).
    Capabilities {
        #[arg(long, default_value = "json")]
        output: String,
    },
    /// Inspect or resolve durable uncertain writes.
    Retries {
        #[command(subcommand)]
        action: RetriesCommand,
    },
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
    /// Portable bundles.
    Bundle {
        #[command(subcommand)]
        action: BundleCommand,
    },
    /// Optional augmentation: query expansion or context compression.
    Analyze {
        #[arg(long)]
        kind: String,
        #[arg(long, default_value = "text")]
        output: String,
    },
    /// Inspect or run maintenance tasks.
    Maintenance {
        /// Report task states and recent runs (the default).
        #[arg(long)]
        status: bool,
        /// Run one task now.
        #[arg(long)]
        task: Option<String>,
        /// Preview a task without mutating anything.
        #[arg(long = "dry-run")]
        dry_run: bool,
        /// Apply the task's mutations (hygiene marks candidates).
        #[arg(long)]
        apply: bool,
        /// Roll back one hygiene run exactly.
        #[arg(long)]
        rollback: Option<String>,
        #[arg(long, default_value = "text")]
        output: String,
    },
    /// Audit extraction runs; apply or roll back one revalidation marker.
    Audit {
        #[command(subcommand)]
        action: AuditCommand,
    },
    /// Manage the per-user lored service.
    Service {
        #[command(subcommand)]
        action: ServiceCommand,
    },
    /// Install or remove client integration files under the lore home.
    Setup {
        /// Comma-separated clients, or `all`.
        #[arg(long, value_delimiter = ',', default_value = "")]
        clients: Vec<String>,
        #[arg(long)]
        remove: bool,
        /// Replace files that lore does not own.
        #[arg(long = "replace-unowned")]
        replace_unowned: bool,
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long)]
        apply: bool,
        #[arg(long, default_value = "text")]
        output: String,
    },
    /// Install a versioned package and switch the stable launcher.
    Upgrade {
        /// Unpacked package directory (contains bin/, clients/, VERSION.json).
        #[arg(long)]
        from: PathBuf,
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long)]
        apply: bool,
        #[arg(long, default_value = "text")]
        output: String,
    },
    /// Inspect or select the installation mode.
    Mode {
        #[command(subcommand)]
        action: ModeCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ServiceCommand {
    /// Write the platform service unit and ownership manifest.
    Install {
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long)]
        apply: bool,
    },
    /// Load and start the service.
    Start {
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long)]
        apply: bool,
    },
    /// Stop the service and let the daemon drain.
    Stop {
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long)]
        apply: bool,
    },
    /// Stop then start the service.
    Restart {
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long)]
        apply: bool,
    },
    /// Reload the service after a config or binary change.
    Reload {
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long)]
        apply: bool,
    },
    /// Report installed/enabled/running/ready state.
    Status {
        #[arg(long, default_value = "text")]
        output: String,
    },
    /// Remove only owned, unmodified service files.
    Uninstall {
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long)]
        apply: bool,
    },
}

#[derive(Debug, Subcommand)]
enum BundleCommand {
    /// Render a standalone, offline HTML view of an OKF bundle.
    Visualize {
        #[arg(long)]
        bundle: PathBuf,
        #[arg(long)]
        out: Option<PathBuf>,
        /// Display name in the artifact header.
        #[arg(long)]
        name: Option<String>,
        #[arg(long, default_value = "text")]
        output: String,
    },
}

#[derive(Debug, Subcommand)]
enum AuditCommand {
    /// Report-only extraction audit (the default).
    Report {
        #[arg(long, default_value = "text")]
        output: String,
    },
    /// Apply one revalidation marker for a run.
    Apply {
        #[arg(long)]
        run: String,
        #[arg(long, default_value = "text")]
        output: String,
    },
    /// Roll back one active revalidation marker.
    Rollback {
        #[arg(long)]
        run: String,
        #[arg(long, default_value = "text")]
        output: String,
    },
}

#[derive(Debug, Subcommand)]
enum ModeCommand {
    /// Report the selected installation mode (v1 when unconfigured).
    Status {
        #[arg(long, default_value = "text")]
        output: String,
    },
    /// Select v1 or v2 for this installation.
    Select {
        #[arg(long)]
        mode: String,
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long)]
        apply: bool,
    },
}

#[derive(Debug, Subcommand)]
enum RetriesCommand {
    /// List journal entries.
    List {
        #[arg(long, default_value = "text")]
        output: String,
    },
    /// Mark one key resolved (drop its payload).
    Resolve { key: String },
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
    /// Import the repo-scoped v1 rows the main migration quarantined, as
    /// global scope. Explicit choice: nothing is imported implicitly.
    Unscoped {
        #[arg(long)]
        source: PathBuf,
        #[arg(long = "dry-run")]
        dry_run: bool,
        #[arg(long)]
        apply: bool,
        #[arg(long, default_value = "text")]
        output: String,
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
    let mut cli = Cli::parse();
    // Bare verbs work against the conventional installation: when no path is
    // supplied and the installer's config exists, use it instead of demanding
    // --config or --socket.
    if cli.config.is_none()
        && cli.socket.is_none()
        && cli.data_dir.is_none()
        && let Some(home) = std::env::var_os("HOME")
    {
        let candidate = PathBuf::from(home).join(".lore/lore.json");
        if candidate.is_file() {
            cli.config = Some(candidate);
        }
    }
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
        Command::Browser { port, open } => {
            let socket = lore_core::config::resolve_socket_path(
                cli.config.as_deref(),
                cli.socket.as_deref(),
            )
            .map_err(core_message)?;
            return browser::run(&socket, *port, *open).await;
        }
        Command::Capabilities { output } => {
            let rows: Vec<Value> = registry::rows()
                .iter()
                .map(|row| serde_json::to_value(row).unwrap_or_default())
                .collect();
            if output == "text" {
                for row in registry::rows() {
                    println!("{}\t{}\t{}", row.name, row.support, row.mutability);
                }
            } else {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&rows).unwrap_or_default()
                );
            }
            return Ok(());
        }
        Command::Retries { action } => {
            let data_dir = resolve_data_dir(&cli)?;
            let mut journal = journal::Journal::open(&data_dir)?;
            match action {
                RetriesCommand::List { output } => {
                    let entries: Vec<Value> = journal
                        .entries()
                        .map(|entry| serde_json::to_value(entry).unwrap_or_default())
                        .collect();
                    if output == "json" {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&entries).unwrap_or_default()
                        );
                    } else if entries.is_empty() {
                        println!("no uncertain writes");
                    } else {
                        for entry in &entries {
                            println!(
                                "{} {} {}",
                                entry["key"].as_str().unwrap_or("?"),
                                entry["operation"].as_str().unwrap_or("?"),
                                entry["state"].as_str().unwrap_or("?")
                            );
                        }
                    }
                    return Ok(());
                }
                RetriesCommand::Resolve { key } => {
                    return if journal.resolve(key)? {
                        println!("resolved {key}");
                        Ok(())
                    } else {
                        Err(format!("unknown retry key: {key}"))
                    };
                }
            }
        }
        Command::Hook { client, event } => {
            let socket = lore_core::config::resolve_socket_path(
                cli.config.as_deref(),
                cli.socket.as_deref(),
            )
            .map_err(core_message)?;
            let payload = read_stdin_hook()?;
            let (response, diagnostic) = hooks::run(client, event, &socket, payload).await;
            if let Some(diagnostic) = diagnostic {
                eprintln!("{diagnostic}");
            }
            println!(
                "{}",
                serde_json::to_string(&response).unwrap_or_else(|_| "{}".to_string())
            );
            return Ok(());
        }
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
            if let MigrateCommand::Unscoped {
                source,
                dry_run,
                apply,
                output,
            } = &action
            {
                let socket = cli
                    .socket
                    .clone()
                    .or_else(|| {
                        resolve_socket(cli.config.as_deref(), None, cli.data_dir.as_deref())
                    })
                    .ok_or_else(|| "provide --config or --socket".to_string())?;
                let expected = resolve_store_id(&socket).await?;
                let mut meta = audit_meta();
                meta.expected_store_id = Some(expected);
                let outcome = lore::request(
                    &socket,
                    "/v2/admin/migration-unscoped",
                    meta,
                    serde_json::json!({
                        "source": source.display().to_string(),
                        "action": if *apply && !*dry_run { "apply" } else { "preview" },
                    }),
                )
                .await
                .map_err(|error| error.to_string())?;
                if !outcome.is_success() {
                    return Err(outcome.body);
                }
                let body: Value = serde_json::from_str(&outcome.body).unwrap_or_default();
                if output == "json" {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&body["result"]).unwrap_or_default()
                    );
                } else {
                    let r = &body["result"];
                    println!(
                        "unscoped import: found {} | imported {} | already present {} | suppressed {} | evidence {}",
                        r["found"],
                        r["imported"],
                        r["alreadyPresent"],
                        r["suppressed"],
                        r["evidenceLinked"]
                    );
                }
                return Ok(());
            }
            match action {
                // Handled above, before the other migrate verbs.
                MigrateCommand::Unscoped { .. } => unreachable!("handled above"),
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
        Command::Setup {
            clients,
            remove,
            replace_unowned,
            dry_run,
            apply,
            output,
        } => {
            let home = resolve_home(cli.home.as_deref())?;
            let socket = resolve_socket(
                cli.config.as_deref(),
                cli.socket.clone(),
                cli.data_dir.as_deref(),
            );
            let version = env!("CARGO_PKG_VERSION");
            let value = if *apply && !*dry_run {
                installer::setup_apply(
                    &home,
                    clients,
                    *remove,
                    *replace_unowned,
                    version,
                    socket.as_deref(),
                )
            } else {
                installer::setup_preview(&home, clients, *remove, version, socket.as_deref())
            };
            let value = value?;
            if output == "text" {
                println!(
                    "lore setup: {} clients handled (applied: {})",
                    value["clients"].as_array().map(Vec::len).unwrap_or(0),
                    value["applied"].as_bool().unwrap_or(false)
                );
            } else {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
                );
            }
            return Ok(());
        }
        Command::Upgrade {
            from,
            dry_run,
            apply,
            output,
        } => {
            let home = resolve_home(cli.home.as_deref())?;
            let value = if *apply && !*dry_run {
                installer::upgrade_apply(&home, from)
            } else {
                installer::upgrade_preview(&home, from)
            }?;
            if output == "text" {
                println!(
                    "lore upgrade: version {} (applied: {})",
                    value["version"].as_str().unwrap_or("unknown"),
                    value["applied"].as_bool().unwrap_or(false)
                );
            } else {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
                );
            }
            return Ok(());
        }
        Command::Bundle { action } => {
            match action {
                BundleCommand::Visualize {
                    bundle,
                    out,
                    name,
                    output,
                } => {
                    let out = out.clone().unwrap_or_else(|| bundle.join("viz.html"));
                    let value =
                        lore_core::okf_visualizer::visualize_okf(bundle, &out, name.as_deref())
                            .map_err(|error| error.reason)?;
                    if output == "json" {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&value).unwrap_or_default()
                        );
                    } else {
                        println!(
                            "lore bundle visualize: {} concept(s), {} link(s) -> {}",
                            value["concepts"].as_i64().unwrap_or(0),
                            value["edges"].as_i64().unwrap_or(0),
                            value["path"].as_str().unwrap_or("")
                        );
                    }
                }
            }
            return Ok(());
        }
        Command::Analyze { kind, output } => {
            // The spec's input shape is a JSON object on stdin; the flag only
            // selects the kind.
            let mut input = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)
                .map_err(|error| error.to_string())?;
            let mut params: Value = if input.trim().is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_str(&input)
                    .map_err(|error| format!("stdin must be a JSON object: {error}"))?
            };
            params["kind"] = Value::String(kind.clone());
            let socket = cli
                .socket
                .clone()
                .or_else(|| resolve_socket(cli.config.as_deref(), None, cli.data_dir.as_deref()))
                .ok_or_else(|| "provide --config or --socket".to_string())?;
            let expected = resolve_store_id(&socket).await?;
            let mut meta = audit_meta();
            meta.expected_store_id = Some(expected);
            meta.timeout_ms = Some(31_000);
            let outcome = lore::request(&socket, "/v2/analysis", meta, params)
                .await
                .map_err(|error| error.to_string())?;
            if !outcome.is_success() {
                return Err(outcome.body);
            }
            let body: Value = serde_json::from_str(&outcome.body).unwrap_or_default();
            if output == "json" {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&body["result"]).unwrap_or_default()
                );
                return Ok(());
            }
            let result = &body["result"];
            if let Some(terms) = result["terms"].as_array() {
                println!("lore analyze: {} expanded term(s)", terms.len());
                for term in terms.iter().take(24) {
                    println!("  {}", term.as_str().unwrap_or(""));
                }
            } else if let Some(sections) = result["sections"].as_array() {
                println!("lore analyze: {} compressed section(s)", sections.len());
                for section in sections.iter().take(12) {
                    println!(
                        "  {}: {}",
                        section["id"].as_str().unwrap_or(""),
                        section["text"].as_str().unwrap_or("")
                    );
                }
            } else {
                println!("lore analyze: no output");
            }
            return Ok(());
        }
        Command::Maintenance {
            status,
            task,
            dry_run,
            apply,
            rollback,
            output,
        } => {
            let socket = cli
                .socket
                .clone()
                .or_else(|| resolve_socket(cli.config.as_deref(), None, cli.data_dir.as_deref()))
                .ok_or_else(|| "provide --config or --socket".to_string())?;
            if let Some(run_id) = rollback {
                // Rollback is a write: journal it like every other mutation.
                let (row, route) = registry::route_for("lore_maintenance")?;
                let params = serde_json::json!({
                    "action": "rollback",
                    "runId": run_id,
                    "idempotencyKey": format!("maintenance-rollback-{run_id}"),
                });
                dispatch_tool(&cli, &socket, row, route, params, true, output).await?;
                return Ok(());
            }
            if let Some(task) = task {
                let (row, route) = registry::route_for("lore_maintenance")?;
                let params = serde_json::json!({
                    "action": "run",
                    "task": task,
                    "dryRun": !*apply || *dry_run,
                    "idempotencyKey": format!("maintenance-run-{task}-{}", if *apply { "apply" } else { "dry" }),
                });
                dispatch_tool(&cli, &socket, row, route, params, true, output).await?;
                return Ok(());
            }
            // Status is a read: no journal, but the store identity is still
            // asserted by the admin route.
            let _ = status;
            let expected = resolve_store_id(&socket).await?;
            let mut meta = audit_meta();
            meta.expected_store_id = Some(expected);
            let outcome = lore::request(
                &socket,
                "/v2/admin/maintenance",
                meta,
                serde_json::json!({ "action": "status" }),
            )
            .await
            .map_err(|error| error.to_string())?;
            if !outcome.is_success() {
                return Err(outcome.body);
            }
            let body: Value = serde_json::from_str(&outcome.body).unwrap_or_default();
            if output == "json" {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&body["result"]).unwrap_or_default()
                );
            } else {
                let states = body["result"]["taskStates"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let runs = body["result"]["runs"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                println!(
                    "lore maintenance: {} task(s), {} recent run(s)",
                    states.len(),
                    runs.len()
                );
                for task in states {
                    println!(
                        "  {:<22} enabled={:<5} cadence={}s last={}",
                        task["task"].as_str().unwrap_or(""),
                        task["enabled"].as_bool().unwrap_or(false),
                        task["cadenceSeconds"].as_i64().unwrap_or(0),
                        task["lastState"].as_str().unwrap_or("never"),
                    );
                }
            }
            return Ok(());
        }
        Command::Audit { action } => {
            let (params, output, verb) = match action {
                AuditCommand::Report { output } => (json!({}), output.clone(), "report"),
                AuditCommand::Apply { run, output } => (
                    json!({ "action": "apply", "runId": run }),
                    output.clone(),
                    "apply",
                ),
                AuditCommand::Rollback { run, output } => (
                    json!({ "action": "rollback", "runId": run }),
                    output.clone(),
                    "rollback",
                ),
            };
            let socket = resolve_socket(
                cli.config.as_deref(),
                cli.socket.clone(),
                cli.data_dir.as_deref(),
            )
            .ok_or_else(|| "provide --config or --socket".to_string())?;
            let outcome =
                lore::request(&socket, "/v2/admin/audit/extractions", audit_meta(), params)
                    .await
                    .map_err(|error| error.to_string())?;
            if !outcome.is_success() {
                return Err(outcome.body);
            }
            let body: Value = serde_json::from_str(&outcome.body).unwrap_or_default();
            if output == "json" {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&body["result"]).unwrap_or_default()
                );
                return Ok(());
            }
            match verb {
                "report" => {
                    let sources = body["result"]["sources"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let revalidations = body["result"]["revalidations"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    println!("lore audit: {} source(s) audited", sources.len());
                    for entry in revalidations.iter().take(10) {
                        println!(
                            "  {} {} ({})",
                            entry["marker"].as_str().unwrap_or(""),
                            entry["state"].as_str().unwrap_or(""),
                            entry["runId"].as_str().unwrap_or("")
                        );
                    }
                }
                marker => {
                    println!(
                        "lore audit: {} {} for run {}",
                        marker,
                        body["result"]["state"].as_str().unwrap_or(""),
                        body["result"]["runId"].as_str().unwrap_or("")
                    );
                }
            }
            return Ok(());
        }
        Command::Service { action } => {
            let home = resolve_home(cli.home.as_deref())?;
            let value = match action {
                ServiceCommand::Install { dry_run, apply } => service::install(
                    &home,
                    *apply && !*dry_run,
                    cli.socket.as_deref(),
                    cli.config.as_deref(),
                )?,
                ServiceCommand::Start { dry_run, apply } => {
                    service::start(&home, *apply && !*dry_run)?
                }
                ServiceCommand::Stop { dry_run, apply } => {
                    service::stop(&home, *apply && !*dry_run)?
                }
                ServiceCommand::Restart { dry_run, apply } => {
                    service::reload(&home, *apply && !*dry_run)?
                }
                ServiceCommand::Reload { dry_run, apply } => {
                    service::reload(&home, *apply && !*dry_run)?
                }
                ServiceCommand::Status { output } => {
                    // Prefer the config the installed unit runs; a bare
                    // `service status` must still report readiness.
                    let configured = cli
                        .config
                        .clone()
                        .or_else(|| service::manifest_config_path(&home));
                    let socket = resolve_socket(
                        configured.as_deref(),
                        cli.socket.clone(),
                        cli.data_dir.as_deref(),
                    );
                    let ready = match socket {
                        Some(socket) if socket.exists() => probe_readiness(&socket).await,
                        _ => false,
                    };
                    let value = service::status(&home, ready)?;
                    if output == "text" {
                        print_service_status(&value);
                        return Ok(());
                    }
                    value
                }
                ServiceCommand::Uninstall { dry_run, apply } => {
                    service::uninstall(&home, *apply && !*dry_run)?
                }
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
            );
            return Ok(());
        }
        Command::Mode { action } => {
            let home = resolve_home(cli.home.as_deref())?;
            match action {
                ModeCommand::Status { output } => {
                    let value = service::mode_status(&home);
                    if output == "text" {
                        println!(
                            "mode: {} (configured: {})",
                            value["mode"].as_str().unwrap_or("v1"),
                            value["configured"].as_bool().unwrap_or(false)
                        );
                        return Ok(());
                    }
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
                    );
                }
                ModeCommand::Select {
                    mode,
                    dry_run,
                    apply,
                } => {
                    let value = service::mode_select(&home, mode, *apply && !*dry_run)?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
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
    match &cli.command {
        Command::Service { .. }
        | Command::Mode { .. }
        | Command::Setup { .. }
        | Command::Upgrade { .. }
        | Command::Audit { .. }
        | Command::Maintenance { .. }
        | Command::Analyze { .. }
        | Command::Bundle { .. } => {
            unreachable!("local-only commands are handled before socket resolution")
        }
        Command::Status { json: _ } => {
            let outcome = request(&socket, "/v2/status", &serde_json::json!({}), None).await?;
            print_outcome(&outcome)
        }
        Command::Tool { name, output } => {
            let (row, route) = registry::route_for(name)?;
            let params = read_stdin_params()?;
            let requires_store = row.name != "lore_status";
            dispatch_tool(&cli, &socket, row, route, params, requires_store, output).await
        }
        Command::Search {
            query,
            repository,
            all_repositories,
            output,
        } => {
            let (row, route) = registry::route_for("lore_search")?;
            let mut params = serde_json::json!({
                "query": query,
                "includeOtherRepositories": all_repositories
            });
            if let Some(repository) = repository {
                params["repository"] = Value::String(repository.clone());
            }
            dispatch_tool(&cli, &socket, row, route, params, true, output).await
        }
        Command::Recall {
            query,
            repository,
            output,
        } => {
            let (row, route) = registry::route_for("lore_recall")?;
            let mut params = serde_json::json!({ "query": query });
            if let Some(repository) = repository {
                params["repository"] = Value::String(repository.clone());
            }
            dispatch_tool(&cli, &socket, row, route, params, true, output).await
        }
        Command::Backup { .. }
        | Command::Restore { .. }
        | Command::Migrate { .. }
        | Command::Retries { .. }
        | Command::Capabilities { .. }
        | Command::Browser { .. }
        | Command::Hook { .. } => unreachable!(),
    }
}

/// Dispatch one canonical operation, journaling mutations before dispatch.
#[allow(clippy::too_many_arguments)]
async fn dispatch_tool(
    cli: &Cli,
    socket: &Path,
    row: &registry::RegistryRow,
    route: &str,
    params: Value,
    requires_store: bool,
    output: &str,
) -> Result<(), String> {
    if let Some(local) = route.strip_prefix("local:") {
        return dispatch_local(local, socket, row, output).await;
    }
    let expected = if requires_store {
        Some(resolve_store_id(socket).await?)
    } else {
        None
    };
    let mut journal = if row.mutability == "write" {
        let key = params
            .get("idempotencyKey")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{} requires idempotencyKey", row.name))?;
        let data_dir = resolve_data_dir(cli)?;
        let mut journal = journal::Journal::open(&data_dir)?;
        journal.record(journal::JournalEntry {
            key: key.to_string(),
            operation: row.name.clone(),
            store_id: expected.clone(),
            client_id: "cli".to_string(),
            created_ms: now_ms(),
            state: "uncertain".to_string(),
            payload: Some(params.clone()),
        })?;
        Some((journal, key.to_string()))
    } else {
        None
    };
    let outcome = request(socket, route, &params, expected.as_deref()).await?;
    if outcome.is_success()
        && let Some((journal, key)) = journal.as_mut()
    {
        let _ = journal.resolve(key);
    }
    print_tool_output(&outcome, &row.name, output)
}

/// Client-local operations that do not need a daemon route.
async fn dispatch_local(
    name: &str,
    socket: &Path,
    row: &registry::RegistryRow,
    output: &str,
) -> Result<(), String> {
    match name {
        "capabilities" => {
            let daemon = match resolve_store_id(socket).await {
                Ok(store_id) => {
                    let outcome =
                        request(socket, "/v2/status", &serde_json::json!({}), None).await?;
                    let value: Value =
                        serde_json::from_str(&outcome.body).map_err(|error| error.to_string())?;
                    json!({
                        "storeId": store_id,
                        "capabilities": value.pointer("/result/capabilities").cloned().unwrap_or(json!([])),
                    })
                }
                Err(_) => json!({ "storeId": null, "capabilities": null }),
            };
            let result = json!({
                "operation": row.name,
                "rows": registry::rows(),
                "daemon": daemon,
            });
            if output == "json" {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).unwrap_or_default()
                );
            } else {
                for entry in registry::rows() {
                    println!("{}\t{}\t{}", entry.name, entry.support, entry.mutability);
                }
            }
            Ok(())
        }
        other => Err(format!("unknown local operation: {other}")),
    }
}

fn print_tool_output(
    outcome: &lore::StatusOutcome,
    operation: &str,
    output: &str,
) -> Result<(), String> {
    let parsed: Option<Value> = serde_json::from_str(&outcome.body).ok();
    if output == "json" {
        println!(
            "{}",
            serde_json::to_string_pretty(&parsed.clone().unwrap_or_default()).unwrap_or_default()
        );
    } else if let Some(value) = &parsed {
        let text = match operation {
            "lore_retain" | "lore_forget" => value
                .pointer("/result/memoryId")
                .and_then(Value::as_str)
                .map(str::to_string),
            "lore_recall" => value
                .pointer("/result/context")
                .and_then(Value::as_str)
                .map(str::to_string),
            "lore_search" => value
                .pointer("/result/items")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|item| {
                            format!(
                                "{} {} {}",
                                item["id"].as_str().unwrap_or("?"),
                                item["kind"].as_str().unwrap_or("?"),
                                item["content"]
                                    .as_str()
                                    .unwrap_or("")
                                    .chars()
                                    .take(80)
                                    .collect::<String>()
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                }),
            "lore_status" => Some(format!(
                "{} {}",
                value
                    .pointer("/result/readiness")
                    .and_then(Value::as_str)
                    .unwrap_or("?"),
                value
                    .pointer("/result/storeId")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
            )),
            _ => None,
        };
        match text {
            Some(text) => println!("{text}"),
            None => println!(
                "{}",
                serde_json::to_string_pretty(value).unwrap_or_default()
            ),
        }
    }
    if outcome.is_success() {
        Ok(())
    } else {
        Err(format!("{} failed: {}", operation, outcome.body))
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

/// Resolve the owned data directory used by the write journal.
fn resolve_data_dir(cli: &Cli) -> Result<PathBuf, String> {
    let config = lore_core::config::ResolvedConfig::load(
        cli.config.as_deref(),
        cli.data_dir.as_deref(),
        None,
    )
    .map_err(core_message)?;
    Ok(config.data_dir)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Bounded hook payload read: hosts never get an unbounded stdin copy.
fn read_stdin_hook() -> Result<Value, String> {
    let mut raw = String::new();
    std::io::stdin()
        .take(1024 * 1024)
        .read_to_string(&mut raw)
        .map_err(|error| error.to_string())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(trimmed).map_err(|error| format!("invalid hook JSON: {error}"))
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

fn audit_meta() -> RequestMeta {
    RequestMeta {
        client_id: "lore.audit".to_string(),
        request_id: format!("audit-{}", std::process::id()),
        session_id: None,
        expected_store_id: None,
        timeout_ms: Some(10_000),
        required_capabilities: Vec::new(),
    }
}

fn resolve_home(home: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(home) = home {
        return Ok(home.to_path_buf());
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "cannot resolve home directory (pass --home)".to_string())
}

fn resolve_socket(
    config: Option<&Path>,
    socket: Option<PathBuf>,
    data_dir: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(socket) = socket {
        return Some(socket);
    }
    lore_core::config::resolve_socket_path_with_data_dir(config, data_dir).ok()
}

async fn probe_readiness(socket: &Path) -> bool {
    let meta = RequestMeta {
        client_id: "lore.service".to_string(),
        request_id: format!("service-{}", std::process::id()),
        session_id: None,
        expected_store_id: None,
        timeout_ms: Some(2_000),
        required_capabilities: Vec::new(),
    };
    match lore::request(socket, "/v2/status", meta, serde_json::json!({})).await {
        Ok(outcome) => serde_json::from_str::<Value>(&outcome.body)
            .map(|body| body["result"]["readiness"] == "ready")
            .unwrap_or(false),
        Err(_) => false,
    }
}

fn print_service_status(value: &Value) {
    println!(
        "lore service: state={} installed={} enabled={} running={} ready={}",
        value["state"].as_str().unwrap_or("unknown"),
        value["installed"].as_bool().unwrap_or(false),
        value["enabled"].as_bool().unwrap_or(false),
        value["running"].as_bool().unwrap_or(false),
        value["ready"].as_bool().unwrap_or(false),
    );
}
