//! Terminal session spawning: PTY creation, shell command construction, and
//! the reader thread that publishes output and exit events.
//!
//! Split from the terminal_runtime god file; behavior unchanged.

use std::collections::VecDeque;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::native_pty_system;

use super::env::{pty_size, session_id, shell_command, short_session_ref};
use super::session::{HostedTerminalSession, HostedTerminalState, TerminalExit};
use super::types::{TerminalEventSink, TerminalOpenRequest};

pub(super) fn spawn_session(
    request: &TerminalOpenRequest,
    resource_id: Option<String>,
    project_root: &Path,
    sink: TerminalEventSink,
) -> Result<(HostedTerminalSession, Box<dyn Read + Send>), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(pty_size(request.rows, request.cols))
        .map_err(|error| format!("terminal PTY creation failed: {error}"))?;
    let mut command = shell_command(project_root);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Nucleus");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("terminal shell spawn failed: {error}"))?;
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("terminal output stream failed: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("terminal input stream failed: {error}"))?;
    let session_id = session_id(&request.project_id, &request.panel_id);
    let session = HostedTerminalSession {
        session_id,
        project_id: request.project_id.clone(),
        panel_id: request.panel_id.clone(),
        resource_id,
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        state: Mutex::new(HostedTerminalState {
            rows: request.rows,
            cols: request.cols,
            next_sequence: 1,
            buffered_bytes: 0,
            buffer_was_truncated: false,
            output: VecDeque::new(),
            sink: Some(sink),
            exit: None,
        }),
    };
    Ok((session, reader))
}

pub(super) fn start_reader(session: Arc<HostedTerminalSession>, mut reader: Box<dyn Read + Send>) {
    thread::Builder::new()
        .name(format!(
            "terminal-reader-{}",
            short_session_ref(&session.session_id)
        ))
        .spawn(move || {
            let mut buffer = vec![0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => session.publish_output(buffer[..read].to_vec()),
                    Err(error) => {
                        session.publish_diagnostic(format!("terminal output failed: {error}"));
                        break;
                    }
                }
            }
            let exit = session
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.wait().ok())
                .map(|status| TerminalExit {
                    exit_code: Some(status.exit_code()),
                    signal: status.signal().map(str::to_owned),
                })
                .unwrap_or(TerminalExit {
                    exit_code: None,
                    signal: None,
                });
            session.publish_exit(exit);
        })
        .expect("terminal reader thread should start");
}
