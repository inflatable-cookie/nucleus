use std::{
    fs::{File, symlink_metadata},
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use crate::{ControllerScope, Service, ServiceError, State};
use nucleus_core::{
    Authority, Phase,
    acp::{Binding, InboxBinding, session_id},
};
use nucleus_store::AcpSession;
use rustix::fs::{Mode, OFlags, open};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const BINDINGS: &str = "acp-bindings";
const SESSION_SCRATCH: &str = "acp-scratch";
const GROUP_OR_OTHER_PERMISSIONS: u32 = 0o077;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MintedSession {
    pub session_id: String,
    pub binding_path: PathBuf,
}

#[derive(Clone)]
pub(super) struct WriteAccess {
    pub credential: [u8; 32],
    pub controller: [u8; 32],
}

impl Service {
    pub(super) async fn bind_acp(
        &self,
        task: &str,
        controller: [u8; 32],
        authority: &Authority,
        scope: &ControllerScope,
        read_only: bool,
    ) -> Result<MintedSession, ServiceError> {
        let mut state = self.state.lock().await;
        let row = self.lookup(&state, task)?;
        scope.task(&state, row.task.identity())?;
        if !read_only
            && row.task.phase() != Phase::Done
            && let Authority::Planner { actor } = authority
        {
            let check = state.check_planner_authority(&row.task, actor);
            if matches!(check, Err(ServiceError::PlannerAuthorityUnknown)) {
                self.request_planner_check(&mut state, &row.task);
            }
            check?;
        }
        self.resolve_project(&state, row.task.identity())?;
        let checkout = nucleus_work::checkout_path(
            self.storage.work().path(),
            &row.task.identity().repository,
            task,
        );
        let command_credential = if read_only || row.task.phase() == Phase::Done {
            None
        } else {
            Some(random_key()?)
        };
        let (session_id, binding_path, scratch_dir) = self.acp_paths(&checkout)?;
        let binding = Binding {
            session_id: session_id.clone(),
            task_id: task.into(),
            endpoint: self.callback,
            credential: random_key()?,
            command_credential,
            scratch_dir: Some(scratch_dir),
        };
        write_binding(&state, &binding_path, &binding, Some(controller))?;
        self.publish(task, row.version);
        Ok(MintedSession {
            session_id,
            binding_path,
        })
    }

    pub(super) async fn ensure_parent_reader(
        &self,
        task: &str,
        checkout: &Path,
    ) -> Result<(), ServiceError> {
        let state = self.state.lock().await;
        let _ = self.lookup(&state, task)?;
        let (session_id, binding_path, scratch_dir) = self.acp_paths(checkout)?;
        if let Some(verifier) = state.store.acp_session(task)?
            && let Some(mut binding) = existing_binding::<Binding>(&binding_path)?
        {
            if binding.task_id != task
                || binding.session_id != session_id
                || !bool::from(verifier.reader.ct_eq(&digest(&binding.credential)))
            {
                return Err(ServiceError::AcpBinding);
            }
            if binding.scratch_dir.as_ref() != Some(&scratch_dir)
                || binding.endpoint != self.callback
            {
                binding.scratch_dir = Some(scratch_dir);
                binding.endpoint = self.callback;
                write_binding(&state, &binding_path, &binding, None)?;
            }
            return Ok(());
        }
        write_binding(
            &state,
            &binding_path,
            &Binding {
                session_id,
                task_id: task.into(),
                endpoint: self.callback,
                credential: random_key()?,
                command_credential: None,
                scratch_dir: Some(scratch_dir),
            },
            Some([0; 32]),
        )
    }

    fn acp_paths(&self, checkout: &Path) -> Result<(String, PathBuf, PathBuf), ServiceError> {
        let session_id = session_id(checkout);
        let root = self.storage.database();
        let relative_scratch = Path::new(SESSION_SCRATCH).join(&session_id);
        let scratch = root.path().join(&relative_scratch);
        if scratch.starts_with(checkout) || scratch.starts_with(self.storage.scratch().path()) {
            return Err(ServiceError::AcpBinding);
        }
        root.ensure_child(&relative_scratch)?;
        let binding_path = self.acp_binding_path(&session_id)?;
        Ok((session_id, binding_path, scratch))
    }

    fn acp_binding_path(&self, session_id: &str) -> Result<PathBuf, ServiceError> {
        let root = self.storage.database();
        root.ensure_child(Path::new(BINDINGS))?;
        let directory = root.path().join(BINDINGS);
        if !symlink_metadata(&directory).is_ok_and(|metadata| {
            metadata.is_dir() && metadata.permissions().mode() & GROUP_OR_OTHER_PERMISSIONS == 0
        }) {
            return Err(ServiceError::AcpBinding);
        }
        Ok(directory.join(format!("{session_id}.json")))
    }

    pub(super) fn ensure_inbox_binding(&self, directory: &Path) -> Result<[u8; 32], ServiceError> {
        let session_id = session_id(directory);
        let path = self.acp_binding_path(&session_id)?;
        let key = match existing_binding::<InboxBinding>(&path)? {
            Some(binding) if binding.session_id == session_id => {
                if binding.endpoint == self.callback {
                    return Ok(binding.inbox_credential);
                }
                binding.inbox_credential
            }
            Some(_) => return Err(ServiceError::AcpBinding),
            None => random_key()?,
        };
        let binding = InboxBinding {
            session_id,
            endpoint: self.callback,
            inbox_credential: key,
        };
        let (file, directory) = prepare_binding(&path, &binding)?;
        publish_binding(file, &path, directory)?;
        Ok(key)
    }

    pub(super) async fn acp_reader(&self, task: &str, key: &[u8; 32]) -> Option<[u8; 32]> {
        self.storage.database().verify().ok()?;
        let state = self.state.lock().await;
        reader_controller(&state, task, key)
    }

    pub(super) async fn acp_credential(
        &self,
        selector: &str,
        key: &[u8; 32],
        access: SessionAccess,
    ) -> Option<(String, [u8; 32])> {
        self.storage.database().verify().ok()?;
        let state = self.state.lock().await;
        let controller = match access {
            SessionAccess::Read => reader_controller,
            SessionAccess::Write => writer_controller,
        };
        if !selector.contains('#') {
            return controller(&state, selector, key).map(|digest| (selector.into(), digest));
        }
        crate::numbers::TaskReference::parse(selector)
            .ok()?
            .candidates(&state)
            .ok()?
            .into_iter()
            .find_map(|id| controller(&state, &id, key).map(|digest| (id, digest)))
    }
}

#[derive(Clone, Copy)]
pub(super) enum SessionAccess {
    Read,
    Write,
}

fn existing_binding<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, ServiceError> {
    let file = match open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(file) => File::from(file),
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(_) => return Err(ServiceError::AcpBinding),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.permissions().mode() & GROUP_OR_OTHER_PERMISSIONS != 0
        || metadata.len() > 4096
    {
        return Err(ServiceError::AcpBinding);
    }
    serde_json::from_reader(file.take(4096))
        .map(Some)
        .map_err(|_| ServiceError::AcpBinding)
}

fn write_binding(
    state: &State,
    path: &Path,
    binding: &Binding,
    controller: Option<[u8; 32]>,
) -> Result<(), ServiceError> {
    let (temporary, directory) = prepare_binding(path, binding)?;
    if let Some(controller) = controller {
        // Rebinding revokes old credentials even if writing the pointer is interrupted.
        state.store.bind_acp(
            &binding.task_id,
            &AcpSession {
                reader: digest(&binding.credential),
                writer: binding.command_credential.as_ref().map(digest),
                controller,
            },
        )?;
    }
    publish_binding(temporary, path, directory)
}

fn prepare_binding<'a>(
    path: &'a Path,
    binding: &impl Serialize,
) -> Result<(tempfile::NamedTempFile, &'a Path), ServiceError> {
    let directory = path.parent().ok_or(ServiceError::AcpBinding)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(temporary.as_file_mut(), binding)
        .map_err(|_| ServiceError::AcpBinding)?;
    temporary.as_file().sync_all()?;
    Ok((temporary, directory))
}

fn publish_binding(
    temporary: tempfile::NamedTempFile,
    path: &Path,
    directory: &Path,
) -> Result<(), ServiceError> {
    temporary
        .persist(path)
        .map_err(|_| ServiceError::AcpBinding)?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

pub(super) fn writer_controller(state: &State, task: &str, key: &[u8; 32]) -> Option<[u8; 32]> {
    let session = state.store.acp_session(task).ok()??;
    bool::from(session.writer?.ct_eq(&digest(key))).then_some(session.controller)
}

fn reader_controller(state: &State, task: &str, key: &[u8; 32]) -> Option<[u8; 32]> {
    let session = state.store.acp_session(task).ok()??;
    bool::from(session.reader.ct_eq(&digest(key))).then_some(session.controller)
}

fn random_key() -> Result<[u8; 32], ServiceError> {
    let mut key = [0; 32];
    getrandom::fill(&mut key).map_err(|_| ServiceError::AcpBinding)?;
    Ok(key)
}

fn digest(key: &[u8; 32]) -> [u8; 32] {
    Sha256::digest(key).into()
}
