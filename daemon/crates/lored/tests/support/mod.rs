//! Shared `lored` test harness.
//!
//! Each integration test binary includes this module with `mod support;`. The
//! daemon's stderr is captured to a file beside its config rather than
//! discarded, so a daemon that dies mid-test is explained instead of surfacing
//! as a bare connection error.

#![allow(
    dead_code,
    reason = "each test binary links the whole harness but uses only part of it"
)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// A spawned `lored` with a temp home and captured stderr.
pub struct Daemon {
    child: Option<Child>,
    /// The daemon's socket path, as written into its config.
    pub socket: PathBuf,
    /// The temp home holding the config, database and captured stderr.
    pub dir: tempfile::TempDir,
    stderr_path: PathBuf,
}

impl Daemon {
    /// The config every test starts from: enabled, with paths inside `dir`.
    pub fn config_with(dir: &Path) -> Value {
        json!({
            "configVersion": 2,
            "enabled": true,
            "dataDir": dir.to_str().expect("utf8 dir"),
            "socketPath": dir.join("lored.sock").to_str().expect("utf8 socket"),
        })
    }

    /// Spawn `lored` against `dir`, writing `config` to `<dir>/lore.json`.
    /// `config` must include `socketPath` inside `dir`.
    pub fn spawn(dir: tempfile::TempDir, config: &Value, extra: &[&str]) -> Self {
        let socket = PathBuf::from(
            config["socketPath"]
                .as_str()
                .expect("test config needs a socketPath"),
        );
        let config_path = dir.path().join("lore.json");
        std::fs::write(
            &config_path,
            serde_json::to_vec_pretty(config).expect("config json"),
        )
        .expect("write config");
        // A file, not Stdio::null(): a daemon that dies still leaves its reason.
        let stderr_path = dir.path().join("lored.stderr");
        let stderr = std::fs::File::create(&stderr_path).expect("stderr file");
        let child = Command::new(env!("CARGO_BIN_EXE_lored"))
            .arg("--config")
            .arg(&config_path)
            .args(extra)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr))
            .spawn()
            .expect("spawn lored");
        Self {
            child: Some(child),
            socket,
            dir,
            stderr_path,
        }
    }

    /// Spawn with the default config.
    pub fn start() -> Self {
        Self::start_with(&[])
    }

    /// Spawn with the default config and extra command-line arguments.
    pub fn start_with(extra: &[&str]) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = Self::config_with(dir.path());
        Self::spawn(dir, &config, extra)
    }

    pub fn database_path(&self) -> PathBuf {
        self.dir.path().join("lore-v2.db")
    }

    pub fn sources_dir(&self) -> PathBuf {
        self.dir.path().join("sources")
    }

    /// Everything the daemon has written to stderr so far.
    pub fn stderr(&self) -> String {
        std::fs::read_to_string(&self.stderr_path).unwrap_or_default()
    }

    /// Wait for the socket to accept a connection, panicking with the captured
    /// stderr when it never does.
    pub async fn wait_for_socket(&self) {
        for _ in 0..500 {
            if tokio::net::UnixStream::connect(&self.socket).await.is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "daemon never accepted a connection; stderr:\n{}",
            self.stderr()
        );
    }
}

/// Captured daemon stderr for a socket, for request helpers that only carry the
/// socket path. Empty when the daemon has written nothing (or was not spawned
/// by this harness).
pub fn stderr_for(socket: &Path) -> String {
    let Some(dir) = socket.parent() else {
        return String::new();
    };
    std::fs::read_to_string(dir.join("lored.stderr")).unwrap_or_default()
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        // Nothing to signal (or report) when it already exited.
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        // SIGTERM lets the daemon exit cleanly, so coverage counters are written.
        // SIGKILL would discard them.
        unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
        // Wait for a clean exit, then fall back to SIGKILL so a stuck daemon cannot hang the test.
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}
