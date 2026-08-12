//! Hosted terminal session: the live PTY session record, its output buffer,
//! and event publication.
//!
//! Split from the terminal_runtime god file; behavior unchanged.

use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Arc, Mutex};

use portable_pty::{Child, MasterPty};

use super::types::{TerminalEvent, TerminalEventSink, TerminalSessionSnapshot};
use super::OUTPUT_BUFFER_LIMIT;
use super::LOCAL_HOST_ID;

pub(super) struct HostedTerminalSession {
    pub(super) session_id: String,
    pub(super) project_id: String,
    pub(super) panel_id: String,
    pub(super) resource_id: Option<String>,
    pub(super) master: Mutex<Box<dyn MasterPty + Send>>,
    pub(super) writer: Mutex<Box<dyn Write + Send>>,
    pub(super) child: Mutex<Box<dyn Child + Send + Sync>>,
    pub(super) state: Mutex<HostedTerminalState>,
}

pub(super) struct HostedTerminalState {
    pub(super) rows: u16,
    pub(super) cols: u16,
    pub(super) next_sequence: u64,
    pub(super) buffered_bytes: usize,
    pub(super) buffer_was_truncated: bool,
    pub(super) output: VecDeque<BufferedOutput>,
    pub(super) sink: Option<TerminalEventSink>,
    pub(super) exit: Option<TerminalExit>,
}

#[derive(Clone)]
pub(super) struct BufferedOutput {
    pub(super) sequence: u64,
    pub(super) data: Vec<u8>,
}

#[derive(Clone)]
pub(super) struct TerminalExit {
    pub(super) exit_code: Option<u32>,
    pub(super) signal: Option<String>,
}

impl HostedTerminalSession {
    pub(super) fn attach(&self, sink: TerminalEventSink) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "terminal session state is unavailable".to_owned())?;
        state.sink = Some(Arc::clone(&sink));
        if state.buffer_was_truncated {
            sink(TerminalEvent::Diagnostic {
                session_id: self.session_id.clone(),
                message: "Earlier terminal output is no longer available".to_owned(),
            });
        }
        for output in &state.output {
            sink(TerminalEvent::Output {
                session_id: self.session_id.clone(),
                sequence: output.sequence,
                data: output.data.clone(),
            });
        }
        if let Some(exit) = &state.exit {
            sink(TerminalEvent::Exited {
                session_id: self.session_id.clone(),
                exit_code: exit.exit_code,
                signal: exit.signal.clone(),
            });
        }
        Ok(())
    }

    pub(super) fn snapshot(&self, attached: bool) -> Result<TerminalSessionSnapshot, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "terminal session state is unavailable".to_owned())?;
        Ok(TerminalSessionSnapshot {
            session_id: self.session_id.clone(),
            project_id: self.project_id.clone(),
            panel_id: self.panel_id.clone(),
            resource_id: self.resource_id.clone(),
            authoritative_host_id: LOCAL_HOST_ID.to_owned(),
            rows: state.rows,
            cols: state.cols,
            attached,
            exited: state.exit.is_some(),
        })
    }

    pub(super) fn is_exited(&self) -> Result<bool, String> {
        self.state
            .lock()
            .map_err(|_| "terminal session state is unavailable".to_owned())
            .map(|state| state.exit.is_some())
    }

    pub(super) fn publish_output(&self, data: Vec<u8>) {
        let (event, sink) = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let sequence = state.next_sequence;
            state.next_sequence += 1;
            state.buffered_bytes += data.len();
            state.output.push_back(BufferedOutput {
                sequence,
                data: data.clone(),
            });
            while state.buffered_bytes > OUTPUT_BUFFER_LIMIT {
                let Some(removed) = state.output.pop_front() else {
                    break;
                };
                state.buffered_bytes = state.buffered_bytes.saturating_sub(removed.data.len());
                state.buffer_was_truncated = true;
            }
            (
                TerminalEvent::Output {
                    session_id: self.session_id.clone(),
                    sequence,
                    data,
                },
                state.sink.clone(),
            )
        };
        if let Some(sink) = sink {
            sink(event);
        }
    }

    pub(super) fn publish_diagnostic(&self, message: String) {
        let sink = self.state.lock().ok().and_then(|state| state.sink.clone());
        if let Some(sink) = sink {
            sink(TerminalEvent::Diagnostic {
                session_id: self.session_id.clone(),
                message,
            });
        }
    }

    pub(super) fn publish_exit(&self, exit: TerminalExit) {
        let sink = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            state.exit = Some(exit.clone());
            state.sink.clone()
        };
        if let Some(sink) = sink {
            sink(TerminalEvent::Exited {
                session_id: self.session_id.clone(),
                exit_code: exit.exit_code,
                signal: exit.signal,
            });
        }
    }
}
