use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use nucleus_local_store::LocalStoreBackend;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

use crate::project_resource_target::resolve_optional_project_resource_target;
use crate::ServerStateService;

const OUTPUT_BUFFER_LIMIT: usize = 1024 * 1024;
const LOCAL_HOST_ID: &str = "host:embedded-desktop";

pub type TerminalEventSink = Arc<dyn Fn(TerminalEvent) + Send + Sync + 'static>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenRequest {
    pub project_id: String,
    pub panel_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSnapshot {
    pub session_id: String,
    pub project_id: String,
    pub panel_id: String,
    pub resource_id: Option<String>,
    pub authoritative_host_id: String,
    pub rows: u16,
    pub cols: u16,
    pub attached: bool,
    pub exited: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output {
        session_id: String,
        sequence: u64,
        data: Vec<u8>,
    },
    Exited {
        session_id: String,
        exit_code: Option<u32>,
        signal: Option<String>,
    },
    Diagnostic {
        session_id: String,
        message: String,
    },
}

#[derive(Clone, Default)]
pub struct TerminalHostRuntime {
    sessions: Arc<Mutex<HashMap<String, Arc<HostedTerminalSession>>>>,
}

struct HostedTerminalSession {
    session_id: String,
    project_id: String,
    panel_id: String,
    resource_id: Option<String>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    state: Mutex<HostedTerminalState>,
}

struct HostedTerminalState {
    rows: u16,
    cols: u16,
    next_sequence: u64,
    buffered_bytes: usize,
    buffer_was_truncated: bool,
    output: VecDeque<BufferedOutput>,
    sink: Option<TerminalEventSink>,
    exit: Option<TerminalExit>,
}

#[derive(Clone)]
struct BufferedOutput {
    sequence: u64,
    data: Vec<u8>,
}

#[derive(Clone)]
struct TerminalExit {
    exit_code: Option<u32>,
    signal: Option<String>,
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

impl HostedTerminalSession {
    fn attach(&self, sink: TerminalEventSink) -> Result<(), String> {
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

    fn snapshot(&self, attached: bool) -> Result<TerminalSessionSnapshot, String> {
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

    fn is_exited(&self) -> Result<bool, String> {
        self.state
            .lock()
            .map_err(|_| "terminal session state is unavailable".to_owned())
            .map(|state| state.exit.is_some())
    }

    fn publish_output(&self, data: Vec<u8>) {
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

    fn publish_diagnostic(&self, message: String) {
        let sink = self.state.lock().ok().and_then(|state| state.sink.clone());
        if let Some(sink) = sink {
            sink(TerminalEvent::Diagnostic {
                session_id: self.session_id.clone(),
                message,
            });
        }
    }

    fn publish_exit(&self, exit: TerminalExit) {
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

fn spawn_session(
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

fn start_reader(session: Arc<HostedTerminalSession>, mut reader: Box<dyn Read + Send>) {
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

fn validate_open_request(request: &TerminalOpenRequest) -> Result<(), String> {
    if request.project_id.trim().is_empty() || request.panel_id.trim().is_empty() {
        return Err("terminal project and panel ids are required".to_owned());
    }
    validate_size(request.rows, request.cols)
}

fn validate_size(rows: u16, cols: u16) -> Result<(), String> {
    if rows == 0 || cols == 0 {
        Err("terminal rows and columns must be positive".to_owned())
    } else {
        Ok(())
    }
}

fn terminal_working_directory<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    resource_id: Option<&str>,
) -> Result<(PathBuf, Option<String>), String>
where
    B: LocalStoreBackend,
{
    terminal_working_directory_with(
        state,
        project_id,
        resource_id,
        host_default_working_directory,
    )
}

fn terminal_working_directory_with<B, F>(
    state: &ServerStateService<B>,
    project_id: &str,
    resource_id: Option<&str>,
    host_default: F,
) -> Result<(PathBuf, Option<String>), String>
where
    B: LocalStoreBackend,
    F: FnOnce() -> Result<PathBuf, String>,
{
    match resolve_optional_project_resource_target(state, project_id, resource_id)? {
        Some(target) => Ok((target.root, Some(target.resource_id))),
        None => host_default().map(|root| (root, None)),
    }
}

fn host_default_working_directory() -> Result<PathBuf, String> {
    let path = host_home_directory()
        .ok_or_else(|| "terminal host has no available default working directory".to_owned())?;
    std::fs::canonicalize(path)
        .map_err(|error| format!("terminal host default working directory is unavailable: {error}"))
}

#[cfg(not(windows))]
fn host_home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

#[cfg(windows)]
fn host_home_directory() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            let drive = std::env::var_os("HOMEDRIVE")?;
            let path = std::env::var_os("HOMEPATH")?;
            if drive.is_empty() || path.is_empty() {
                return None;
            }
            let mut home = PathBuf::from(drive);
            home.push(path);
            Some(home)
        })
}

fn pty_size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn shell_command(project_root: &Path) -> CommandBuilder {
    let mut command = CommandBuilder::new(shell_path());
    command.cwd(project_root);
    command
}

fn shell_path() -> PathBuf {
    std::env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(platform_shell)
}

#[cfg(windows)]
fn platform_shell() -> PathBuf {
    PathBuf::from("powershell.exe")
}

#[cfg(not(windows))]
fn platform_shell() -> PathBuf {
    PathBuf::from("/bin/sh")
}

fn session_id(project_id: &str, panel_id: &str) -> String {
    let input = format!("{project_id}\0{panel_id}");
    format!("terminal:{}", blake3::hash(input.as_bytes()).to_hex())
}

fn short_session_ref(session_id: &str) -> &str {
    session_id
        .strip_prefix("terminal:")
        .unwrap_or(session_id)
        .get(..12)
        .unwrap_or(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{seed_local_project, LocalProjectSeed};
    use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
    use nucleus_local_store::{
        LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation, SqliteBackend,
    };
    use nucleus_projects::{
        decode_project_storage_record, encode_project_storage_payload,
        encode_project_storage_record, ImportanceBaseline, ImportanceLevel, Project,
        ProjectActivity, ProjectId, ProjectRetention, ProjectStatus,
    };
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn terminal_session_identity_is_stable_and_panel_scoped() {
        assert_eq!(
            session_id("project:a", "panel:1"),
            session_id("project:a", "panel:1")
        );
        assert_ne!(
            session_id("project:a", "panel:1"),
            session_id("project:a", "panel:2")
        );
    }

    #[test]
    fn terminal_sizes_reject_empty_dimensions() {
        assert!(validate_size(24, 80).is_ok());
        assert!(validate_size(0, 80).is_err());
        assert!(validate_size(24, 0).is_err());
    }

    #[test]
    fn resource_free_project_uses_host_default_working_directory() {
        let directory = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(directory.path().join("state.sqlite")));
        persist_resource_free_project(&state, "project:empty");
        let fallback = directory.path().join("host-home");
        std::fs::create_dir(&fallback).expect("create fallback");

        assert_eq!(
            terminal_working_directory_with(&state, "project:empty", None, || {
                Ok(fallback.clone())
            })
            .expect("resolve terminal working directory"),
            (fallback, None)
        );
    }

    #[test]
    fn explicit_resource_target_overrides_terminal_project_default() {
        let directory = tempfile::tempdir().expect("temp dir");
        let first = directory.path().join("first");
        let second = directory.path().join("second");
        std::fs::create_dir(&first).expect("first resource");
        std::fs::create_dir(&second).expect("second resource");
        let state =
            ServerStateService::new(SqliteBackend::new(directory.path().join("state.sqlite")));
        seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
        let id = PersistenceRecordId("project:nucleus-local".to_owned());
        let mut record = state.projects().get(&id).expect("get").expect("project");
        let previous = record.revision_id.clone();
        let mut project = decode_project_storage_record(&record.payload.bytes).expect("decode");
        project.resources[0].current_locator = Some(first.to_string_lossy().into_owned());
        let mut second_resource = project.resources[0].clone();
        second_resource.resource_id = "resource:second".to_owned();
        second_resource.display_name = "Second".to_owned();
        second_resource.current_locator = Some(second.to_string_lossy().into_owned());
        project.resources.push(second_resource);
        record.revision_id = RevisionId("rev:terminal-multi-resource".to_owned());
        record.payload = LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: encode_project_storage_payload(&project).expect("encode"),
        };
        state
            .projects()
            .put(record, RevisionExpectation::Exact(previous))
            .expect("put");

        assert_eq!(
            terminal_working_directory_with(
                &state,
                "project:nucleus-local",
                Some("resource:second"),
                || Err("host fallback must not run".to_owned()),
            )
            .expect("resolve explicit terminal target"),
            (
                second.canonicalize().expect("canonical second"),
                Some("resource:second".to_owned()),
            )
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn local_host_terminal_streams_interactive_shell_output() {
        let directory = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(directory.path().join("state.sqlite")));
        seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
        let runtime = TerminalHostRuntime::default();
        let (sender, receiver) = mpsc::channel();
        let snapshot = runtime
            .open_or_attach(
                &state,
                TerminalOpenRequest {
                    project_id: "project:nucleus-local".to_owned(),
                    panel_id: "terminal:test".to_owned(),
                    resource_id: None,
                    rows: 24,
                    cols: 80,
                },
                Arc::new(move |event| {
                    let _ = sender.send(event);
                }),
            )
            .expect("open terminal");
        assert_eq!(
            snapshot.resource_id.as_deref(),
            Some("resource:nucleus-local")
        );

        runtime
            .write(
                &snapshot.session_id,
                b"printf '__nucleus_terminal_round_trip__\\n'; exit\n",
            )
            .expect("write terminal");

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut output = Vec::new();
        while Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(TerminalEvent::Output { data, .. }) => {
                    output.extend(data);
                    if output
                        .windows(b"__nucleus_terminal_round_trip__".len())
                        .any(|window| window == b"__nucleus_terminal_round_trip__")
                    {
                        return;
                    }
                }
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => panic!("terminal event stream failed: {error}"),
            }
        }

        panic!("terminal output marker was not observed");
    }

    fn persist_resource_free_project(state: &ServerStateService<SqliteBackend>, project_id: &str) {
        let project = Project {
            id: ProjectId(project_id.to_owned()),
            display_name: "Empty project".to_owned(),
            authority_host_ref: LOCAL_HOST_ID.to_owned(),
            status: ProjectStatus::Active,
            retention: ProjectRetention::Durable,
            importance_baseline: ImportanceBaseline {
                level: ImportanceLevel::Normal,
                notes: None,
            },
            resources: Vec::new(),
            default_working_resource: None,
            management_projection: None,
            task_ids: Vec::new(),
            workspace_layout_refs: Vec::new(),
            activity: ProjectActivity {
                created_at: None,
                last_focused_at: None,
                last_agent_activity_at: None,
                last_task_activity_at: None,
            },
        };
        state
            .projects()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId(project_id.to_owned()),
                    domain: PersistenceDomain::Projects,
                    kind: PersistenceRecordKind::Project,
                    revision_id: RevisionId("rev:test:1".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: encode_project_storage_record(&project).expect("encode project"),
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("persist project");
    }
}
