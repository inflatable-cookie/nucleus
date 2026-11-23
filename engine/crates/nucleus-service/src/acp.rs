use std::{
    fs::{File, symlink_metadata},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use crate::{Service, ServiceError, State};
use nucleus_core::{
    Phase,
    acp::{Binding, session_id},
};
use nucleus_store::AcpSession;
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const BINDINGS: &str = "acp-bindings";
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
        read_only: bool,
    ) -> Result<MintedSession, ServiceError> {
        let state = self.state.lock().await;
        let row = self.lookup(&state, task)?;
        let worktrees = self.worktrees()?;
        let checkout =
            worktrees.checkout(&self.project.checkout, &self.project.repository, task)?;
        let session_id = session_id(checkout.path());
        let credential = random_key()?;
        let command_credential = if read_only || row.task.phase() == Phase::Done {
            None
        } else {
            Some(random_key()?)
        };
        let binding = Binding {
            session_id: session_id.clone(),
            task_id: task.into(),
            endpoint: self.callback,
            credential,
            command_credential,
        };
        let root = self.storage.database();
        root.ensure_child(Path::new(BINDINGS))?;
        let directory = root.path().join(BINDINGS);
        if !symlink_metadata(&directory).is_ok_and(|metadata| {
            metadata.is_dir() && metadata.permissions().mode() & GROUP_OR_OTHER_PERMISSIONS == 0
        }) {
            return Err(ServiceError::AcpBinding);
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
        serde_json::to_writer(temporary.as_file_mut(), &binding)
            .map_err(|_| ServiceError::AcpBinding)?;
        temporary.as_file().sync_all()?;
        // Publish the verifiers first so rebinding revokes old credentials even
        // if writing the replacement pointer is interrupted.
        state.store.bind_acp(
            task,
            &AcpSession {
                reader: digest(&credential),
                writer: command_credential.as_ref().map(digest),
                controller,
            },
        )?;
        let binding_path = directory.join(format!("{session_id}.json"));
        temporary
            .persist(&binding_path)
            .map_err(|_| ServiceError::AcpBinding)?;
        File::open(directory)?.sync_all()?;
        self.publish(task, row.version);
        Ok(MintedSession {
            session_id,
            binding_path,
        })
    }

    pub(super) async fn acp_reader(&self, task: &str, key: &[u8; 32]) -> bool {
        if self.storage.database().verify().is_err() {
            return false;
        }
        let state = self.state.lock().await;
        state
            .store
            .acp_session(task)
            .ok()
            .flatten()
            .is_some_and(|session| bool::from(session.reader.ct_eq(&digest(key))))
    }

    pub(super) async fn acp_controller(&self, task: &str, key: &[u8; 32]) -> Option<[u8; 32]> {
        self.storage.database().verify().ok()?;
        let state = self.state.lock().await;
        writer_controller(&state, task, key)
    }
}

pub(super) fn writer_controller(state: &State, task: &str, key: &[u8; 32]) -> Option<[u8; 32]> {
    let session = state.store.acp_session(task).ok()??;
    bool::from(session.writer?.ct_eq(&digest(key))).then_some(session.controller)
}

fn random_key() -> Result<[u8; 32], ServiceError> {
    let mut key = [0; 32];
    getrandom::fill(&mut key).map_err(|_| ServiceError::AcpBinding)?;
    Ok(key)
}

fn digest(key: &[u8; 32]) -> [u8; 32] {
    Sha256::digest(key).into()
}
