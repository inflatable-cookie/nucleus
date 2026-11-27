//! The thin parent of the engine process. A process cannot log its own
//! SIGKILL, so the parent records how the engine ended.

use std::{env, os::unix::process::ExitStatusExt, path::Path, process::ExitStatus, str::FromStr};

use nix::{
    sys::{
        resource::{UsageWho, getrusage},
        signal::{Signal, kill, raise},
    },
    unistd::Pid,
};
use tokio::{process::Command, time::Instant};

use crate::{Result, ShutdownSignals, open_settings, serve_log};

/// Run this `serve` command as a child, forward shutdown signals to it, record
/// how it ended and exit with its status. The parent takes no lock or port.
pub(super) async fn run(home: Option<&Path>) -> Result<()> {
    // Listen first, so no signal can take the parent and leave the engine.
    let mut signals = ShutdownSignals::new()?;
    let started = Instant::now();
    let mut engine = Command::new(env::current_exe()?)
        .args(env::args_os().skip(1))
        .arg("--supervised")
        .spawn()?;
    let process = engine.id().ok_or("the engine process has no ID")?;
    let child = Pid::from_raw(process.try_into()?);
    let status = loop {
        tokio::select! {
            status = engine.wait() => break status?,
            name = signals.next() => {
                // The wait above has not reaped the engine, so the ID is its own.
                if let Err(error) = kill(child, Signal::from_str(name)?) {
                    serve_log::line(format_args!("could not forward {name}: {error}"));
                }
            }
        }
    };
    // The engine is this process's only child.
    let peak = getrusage(UsageWho::RUSAGE_CHILDREN).map_or_else(
        |_| "unavailable".into(),
        |usage| {
            // Apple reports bytes. Other systems report KiB.
            let unit = if cfg!(target_vendor = "apple") {
                1024
            } else {
                1
            };
            format!("{} KiB", usage.max_rss() / unit)
        },
    );
    let cause = format!(
        "{}, uptime {:.3}s, peak RSS {peak}",
        ending(status),
        started.elapsed().as_secs_f64()
    );
    // Record before releasing any inherited startup lock by exiting.
    if let Ok(settings) = open_settings(home)
        && let Err(error) = serve_log::record_exit(settings.home(), process, &cause)
    {
        serve_log::line(format_args!(
            "could not record the engine exit cause: {error}"
        ));
    }
    serve_log::line(format_args!(
        "Nucleus engine process {process} ended: {cause}"
    ));
    if let Some(number) = status.signal() {
        // End the same way, unless this process handles that signal.
        if let Ok(signal) = Signal::try_from(number) {
            let _ = raise(signal);
        }
        std::process::exit(128 + number);
    }
    std::process::exit(status.code().unwrap_or(1));
}

fn ending(status: ExitStatus) -> String {
    if let Some(number) = status.signal() {
        let name = Signal::try_from(number).map_or("unknown", |signal| {
            signal.as_str().trim_start_matches("SIG")
        });
        format!("signal {number} ({name})")
    } else {
        format!("exit code {}", status.code().unwrap_or(-1))
    }
}
