//! The thin parent of the engine process. A process cannot log its own
//! SIGKILL, so the parent records how the engine ended.

use std::{env, os::unix::process::ExitStatusExt, path::Path, process::ExitStatus, str::FromStr};

use nix::{
    sys::{
        resource::{UsageWho, getrusage},
        signal::{Signal, kill},
    },
    unistd::Pid,
};
use signal_hook::low_level::emulate_default_handler;
use tokio::{process::Command, time::Instant};

use crate::{Result, ShutdownSignals, open_settings, serve_log};

/// Run this `serve` command as a child under this parent, which takes no lock
/// or port.
pub(super) async fn run(home: Option<&Path>) -> Result<()> {
    let mut engine = Command::new(env::current_exe()?);
    engine.args(env::args_os().skip(1)).arg("--supervised");
    supervise(engine, home).await
}

/// Run the engine, forward shutdown signals to it, record how it ended and exit
/// with its status.
async fn supervise(mut command: Command, home: Option<&Path>) -> Result<()> {
    // Listen first, so no signal can take the parent and leave the engine.
    let mut signals = ShutdownSignals::new()?;
    let started = Instant::now();
    let mut engine = command.spawn()?;
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
        // Die by the same signal. This restores its default action first,
        // because this process listens for the signals it forwards.
        if let Err(error) = emulate_default_handler(number) {
            serve_log::line(format_args!("could not end by signal {number}: {error}"));
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

#[cfg(test)]
mod tests {
    use std::process::Stdio;

    use tokio::{
        io::{AsyncBufReadExt, BufReader},
        time::{Duration, timeout},
    };

    use super::*;

    #[tokio::test]
    async fn the_parent_dies_by_the_forwarded_signal_that_ended_its_child() {
        const CHILD_HOME: &str = "NUCLEUS_TEST_SUPERVISOR_HOME";
        if let Some(home) = env::var_os(CHILD_HOME) {
            // This child keeps the default action for every forwarded signal.
            let mut engine = Command::new("/bin/sh");
            engine.args(["-c", "echo ready; exec sleep 30"]);
            supervise(engine, Some(Path::new(&home))).await.unwrap();
            panic!("the parent returned");
        }

        let home = tempfile::tempdir().unwrap();
        for signal in [Signal::SIGTERM, Signal::SIGINT, Signal::SIGHUP] {
            let mut parent = Command::new(env::current_exe().unwrap())
                .args([
                    "--exact",
                    "supervise::tests::the_parent_dies_by_the_forwarded_signal_that_ended_its_child",
                ])
                .env(CHILD_HOME, home.path().canonicalize().unwrap())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let mut output = BufReader::new(parent.stdout.take().unwrap()).lines();
            // The child starts after the parent listens for signals.
            timeout(Duration::from_secs(5), async {
                while !output
                    .next_line()
                    .await
                    .unwrap()
                    .unwrap()
                    .ends_with("ready")
                {}
            })
            .await
            .expect("the child starts");
            let process = i32::try_from(parent.id().unwrap()).unwrap();
            kill(Pid::from_raw(process), signal).unwrap();
            let ended = timeout(Duration::from_secs(5), parent.wait_with_output())
                .await
                .expect("both processes end")
                .unwrap();
            let log = String::from_utf8_lossy(&ended.stderr);
            assert_eq!(ended.status.signal(), Some(signal as i32), "{log}");
            let cause = format!(
                "signal {} ({}), uptime ",
                signal as i32,
                signal.as_str().trim_start_matches("SIG")
            );
            assert!(log.contains(&cause), "{log}");
        }
    }
}
