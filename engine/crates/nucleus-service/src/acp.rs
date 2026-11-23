use std::{
    fs::{File, symlink_metadata},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

use nucleus_core::{
    Authority, Command, Phase,
    acp::{Binding, session_id},
};
use nucleus_store::{AcpSession, StoreError, TaskRow};
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::{sync::oneshot, time::Instant};

use crate::{CommandOutcome, Service, ServiceError, State, schedule::Priority};

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

pub(super) struct WriteCheck<'a> {
    pub access: &'a WriteAccess,
    pub planner: Option<&'a PendingCommand>,
}

pub(super) struct PendingCommand {
    version: i64,
    authority: Authority,
    command: Command,
    access: WriteAccess,
    reply: oneshot::Sender<Result<CommandOutcome, ServiceError>>,
}

impl PendingCommand {
    pub(super) fn current(&self, row: &TaskRow) -> bool {
        self.version == row.version && !self.reply.is_closed()
    }
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

    pub(super) async fn planner_acp_command(
        &self,
        id: &str,
        authority: Authority,
        access: WriteAccess,
        command: Command,
    ) -> Result<CommandOutcome, ServiceError> {
        let (reply, receive) = oneshot::channel();
        let version = {
            let mut state = self.state.lock().await;
            let row = self.lookup(&state, id)?;
            if state
                .acp_commands
                .get(id)
                .is_some_and(|pending| !pending.reply.is_closed())
            {
                return Ok(CommandOutcome::Pending {
                    version: row.version,
                });
            }
            state.acp_commands.insert(
                id.into(),
                PendingCommand {
                    version: row.version,
                    authority,
                    command,
                    access,
                    reply,
                },
            );
            state.schedule.wake(id, Instant::now(), Priority::Wake);
            row.version
        };
        self.wake.notify_one();
        match tokio::time::timeout(Duration::from_secs(10), receive).await {
            Ok(Ok(result)) => result,
            _ => Ok(CommandOutcome::Pending { version }),
        }
    }

    pub(super) async fn apply_acp_command(&self, row: &TaskRow) -> bool {
        let id = &row.task.identity().id;
        let Some(pending) = self.state.lock().await.acp_commands.remove(id) else {
            return false;
        };
        if pending.reply.is_closed() {
            return false;
        }
        let result = self.check_planner_command(row, &pending).await;
        let _ = pending.reply.send(result);
        true
    }

    async fn check_planner_command(
        &self,
        row: &TaskRow,
        pending: &PendingCommand,
    ) -> Result<CommandOutcome, ServiceError> {
        let id = &row.task.identity().id;
        if !pending.current(row) {
            return Err(StoreError::StaleTask.into());
        }
        if self.acp_controller(id, &pending.access.credential).await
            != Some(pending.access.controller)
        {
            return Err(ServiceError::AcpUnauthorized);
        }
        let Authority::Planner { actor } = &pending.authority else {
            return Err(ServiceError::AcpUnauthorized);
        };
        if self.responsible_planner(&row.task).await?.as_ref() != Some(actor) {
            return Err(ServiceError::QuestionPlanner);
        }
        self.command_with_session(
            id,
            &pending.authority,
            pending.command.clone(),
            Some(WriteCheck {
                access: &pending.access,
                planner: Some(pending),
            }),
        )
        .await
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
