//! Liveness watchdog.
//!
//! A wedged store lock must not leave a daemon that answers nothing while the
//! service manager believes it is healthy: the blocking pool fills and the
//! process sits at 0% CPU forever. This task probes the store on a bounded
//! deadline; when the probe keeps failing it exits with a distinct status so
//! launchd/systemd restarts the daemon and work resumes from the store.
//!
//! The probe runs on the blocking pool, but the timeout runs on the async
//! runtime's timer, which stays alive even when every blocking thread is stuck.

use std::sync::Arc;
use std::time::Duration;

use lore_core::store::Store;

const INTERVAL: Duration = Duration::from_secs(30);
const DEADLINE: Duration = Duration::from_secs(15);
const MAX_STRIKES: u32 = 3;
/// Exit status used when the watchdog gives up; distinct from a crash.
pub const WATCHDOG_EXIT: i32 = 70;

/// Consecutive-failure counter. A single success clears it so a slow store is
/// never mistaken for a wedged one.
#[derive(Default)]
struct Strikes(u32);

impl Strikes {
    fn success(&mut self) {
        self.0 = 0;
    }

    fn failure(&mut self) -> bool {
        self.0 += 1;
        self.0 >= MAX_STRIKES
    }
}

/// Spawn the watchdog for one store.
pub fn spawn(store: Arc<Store>) {
    tokio::spawn(async move {
        let mut strikes = Strikes::default();
        loop {
            tokio::time::sleep(INTERVAL).await;
            let probe_store = Arc::clone(&store);
            let probe = tokio::task::spawn_blocking(move || probe_store.status().map(|_| ()));
            let healthy = matches!(tokio::time::timeout(DEADLINE, probe).await, Ok(Ok(Ok(()))));
            if healthy {
                strikes.success();
                continue;
            }
            if strikes.failure() {
                eprintln!(
                    "[lored] watchdog: store unresponsive for {} probes; exiting so the service manager restarts the daemon",
                    MAX_STRIKES
                );
                std::process::exit(WATCHDOG_EXIT);
            }
            eprintln!("[lored] watchdog: store probe timed out");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strikes_exit_only_after_repeated_failures_and_reset_on_success() {
        let mut strikes = Strikes::default();
        assert!(!strikes.failure(), "one slow probe is not a wedge");
        assert!(!strikes.failure());
        // A success in between clears the count entirely.
        strikes.success();
        assert!(!strikes.failure());
        assert!(!strikes.failure());
        assert!(
            strikes.failure(),
            "three consecutive failures must trigger the exit"
        );
    }
}
