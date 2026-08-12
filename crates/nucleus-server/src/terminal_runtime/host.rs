//! Terminal host runtime: the session registry and open/write/resize/close
//! surface over hosted terminal sessions.
//!
//! Split from the terminal_runtime god file; behavior unchanged.

use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};

use nucleus_local_store::LocalStoreBackend;

use super::env::{
    pty_size, session_id, terminal_working_directory, validate_open_request, validate_size,
};
use super::session::HostedTerminalSession;
use super::spawn::{spawn_session, start_reader};
use super::types::{
    TerminalEventSink, TerminalOpenRequest, TerminalSessionSnapshot,
};
use crate::ServerStateService;

#[derive(Clone, Default)]
pub struct TerminalHostRuntime {
    sessions: Arc<Mutex<HashMap<String, Arc<HostedTerminalSession>>>>,
}

impl TerminalHostRuntime {
    pub fn open_or_attach<B>(
        &self,
        server_state: &ServerStateService<B>,
        request: TerminalOpenRequest,
        sink: TerminalEventSink,
    ) -> Result<TerminalSessionSnapshot, String>
    where
        B: LocalStoreBackend,
    {
        validate_open_request(&request)?;
        let (working_directory, resource_id) = terminal_working_directory(
            server_state,
            &request.project_id,
            request.resource_id.as_deref(),
        )?;
        let session_id = session_id(&request.project_id, &request.panel_id);

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "terminal session registry is unavailable".to_owned())?;
        if let Some(session) = sessions.get(&session_id).cloned() {
            drop(sessions);
            if session.project_id != request.project_id || session.panel_id != request.panel_id {
                return Err("terminal session identity collision".to_owned());
            }
            if session.resource_id != resource_id {
                return Err(
                    "terminal panel target changed; close its existing session before reopening"
                        .to_owned(),
                );
            }
            session.attach(sink)?;
            return session.snapshot(true);
        }

        let (hosted, reader) = spawn_session(&request, resource_id, &working_directory, sink)?;
        let session = Arc::new(hosted);
        sessions.insert(session_id, Arc::clone(&session));
        drop(sessions);
        start_reader(Arc::clone(&session), reader);
        session.snapshot(false)
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        let session = self.required_session(session_id)?;
        if session.is_exited()? {
            return Err("terminal session has exited".to_owned());
        }
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "terminal input stream is unavailable".to_owned())?;
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("terminal input failed: {error}"))
    }

    pub fn resize(&self, session_id: &str, rows: u16, cols: u16) -> Result<(), String> {
        validate_size(rows, cols)?;
        let session = self.required_session(session_id)?;
        session
            .master
            .lock()
            .map_err(|_| "terminal PTY is unavailable".to_owned())?
            .resize(pty_size(rows, cols))
            .map_err(|error| format!("terminal resize failed: {error}"))?;
        let mut state = session
            .state
            .lock()
            .map_err(|_| "terminal session state is unavailable".to_owned())?;
        state.rows = rows;
        state.cols = cols;
        Ok(())
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "terminal session registry is unavailable".to_owned())?
            .remove(session_id);
        let Some(session) = session else {
            return Ok(());
        };
        if let Ok(mut state) = session.state.lock() {
            state.sink = None;
        }
        if session.is_exited()? {
            return Ok(());
        }
        let result = session
            .child
            .lock()
            .map_err(|_| "terminal process is unavailable".to_owned())?
            .kill()
            .map_err(|error| format!("terminal close failed: {error}"));
        result
    }

    pub fn close_for_panel(&self, project_id: &str, panel_id: &str) -> Result<(), String> {
        self.close(&session_id(project_id, panel_id))
    }

    pub fn close_for_project(&self, project_id: &str) -> Result<(), String> {
        let session_ids = self
            .sessions
            .lock()
            .map_err(|_| "terminal session registry is unavailable".to_owned())?
            .values()
            .filter(|session| session.project_id == project_id)
            .map(|session| session.session_id.clone())
            .collect::<Vec<_>>();
        for session_id in session_ids {
            self.close(&session_id)?;
        }
        Ok(())
    }

    fn session(&self, session_id: &str) -> Result<Option<Arc<HostedTerminalSession>>, String> {
        self.sessions
            .lock()
            .map_err(|_| "terminal session registry is unavailable".to_owned())
            .map(|sessions| sessions.get(session_id).cloned())
    }

    fn required_session(&self, session_id: &str) -> Result<Arc<HostedTerminalSession>, String> {
        self.session(session_id)?
            .ok_or_else(|| "terminal session was not found on this host".to_owned())
    }
}
