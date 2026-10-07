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
    let socket =
        lore_core::config::resolve_socket_path(cli.config.as_deref(), cli.socket.as_deref())
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
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
    }
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
