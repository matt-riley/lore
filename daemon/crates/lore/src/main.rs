//! `lore` — the Lore v2 CLI. G1 proof: a `status` verb that talks to `lored`
//! over the Unix socket without Node.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand};
use protocol::{RequestMeta, StatusParams};

#[derive(Debug, Parser)]
#[command(name = "lore", version, about = "Lore v2 CLI (G1 status proof)")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Fetch daemon status over the Unix socket.
    Status {
        /// Unix socket path.
        #[arg(long, env = "LORE_V2_SOCKET")]
        socket: PathBuf,
        /// Print only the JSON response body.
        #[arg(long, default_value_t = false)]
        quiet: bool,
    },
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Status { socket, quiet } => run_status(&socket, quiet).await,
    }
}

async fn run_status(socket: &Path, quiet: bool) -> ExitCode {
    let meta = RequestMeta {
        client_id: "cli".to_string(),
        request_id: format!("cli-{}-{:x}", std::process::id(), nanos()),
        session_id: None,
        expected_store_id: None,
        timeout_ms: None,
        required_capabilities: Vec::new(),
    };
    match lore::request_status(socket, meta, StatusParams::default()).await {
        Ok(outcome) => {
            if !quiet {
                eprintln!("[lore] HTTP {}", outcome.status_code);
            }
            println!("{}", outcome.body);
            if outcome.is_success() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!("[lore] {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
}
