use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use longhorn_core::{NotificationAuthorityId, NotificationCauseId, NotificationId, OperationId};
use longhorn_notifications::{
    NotificationActionProjection, NotificationAuthorityEpoch, NotificationDraftProjection,
    NotificationLedger, NotificationLedgerLimits, NotificationMutationCommand,
    NotificationMutationResult, NotificationProtocolVersion, NotificationReadStateProjection,
    NotificationRetentionClassProjection, NotificationSeverityProjection, NotificationSnapshot,
    NotificationSnapshotQuery, NotificationSnapshotResponse,
};
use longhorn_tauri_notifications::{
    notification_mutation_changed_event, NotificationHostError, NotificationHostService,
    TauriNotificationState, NOTIFICATION_CHANGED_EVENT,
};
use serde::{Deserialize, Serialize};
use tauri::{App, AppHandle, Emitter, Manager, Runtime};

const AUTHORITY_ID: &str = "nucleus:desktop-notifications";
const SOURCE_OPERATIONS: &str = "nucleus:operations";
const SOURCE_COMMANDS: &str = "nucleus:commands";
const ACTION_OPEN_FORGE: &str = "nucleus:sidebar.show-forge";
const RETAINED_LIMIT: usize = 100;
const SNAPSHOT_LIMIT: u64 = 100;
const RETAINED_WEIGHT_LIMIT: u64 = 512 * 1024;

#[derive(Clone)]
pub(crate) struct NucleusNotificationState {
    runtime: Arc<NucleusNotificationRuntime>,
}

struct NucleusNotificationRuntime {
    ledger: Mutex<NotificationLedger>,
    persistence_path: PathBuf,
    sequence: Mutex<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PersistedLedger {
    schema_version: u16,
    records_newest_first: Vec<PersistedRecord>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PersistedRecord {
    notification_id: NotificationId,
    draft: NotificationDraftProjection,
    read_state: NotificationReadStateProjection,
}

impl NucleusNotificationRuntime {
    fn new(persistence_path: PathBuf) -> Result<Self, String> {
        let mut ledger = empty_ledger()?;
        if persistence_path.exists() {
            match read_persisted(&persistence_path)
                .and_then(|persisted| restore(&mut ledger, persisted))
            {
                Ok(()) => {}
                Err(error) => {
                    let quarantine = persistence_path.with_extension("json.corrupt");
                    let _ = fs::rename(&persistence_path, &quarantine);
                    eprintln!("notification ledger recovery started empty: {error}");
                    ledger = empty_ledger()?;
                }
            }
        }
        let sequence = ledger
            .records()
            .filter_map(|record| {
                record
                    .notification_id()
                    .to_string()
                    .rsplit(':')
                    .next()?
                    .parse()
                    .ok()
            })
            .max()
            .unwrap_or(0);
        Ok(Self {
            ledger: Mutex::new(ledger),
            persistence_path,
            sequence: Mutex::new(sequence),
        })
    }

    fn authorize(caller: &str) -> Result<(), NotificationHostError> {
        if caller == "main" {
            Ok(())
        } else {
            Err(NotificationHostError::authority(
                "notification caller is not authorized",
                false,
            ))
        }
    }

    fn publish_operation_failure<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        operation_id: &OperationId,
        kind: &str,
        scope: Option<&str>,
        label: &str,
    ) -> Result<(), String> {
        let result = self.operation_failure_mutation(operation_id, kind, scope, label)?;
        publish(app, &result)
    }

    fn operation_failure_mutation(
        &self,
        operation_id: &OperationId,
        kind: &str,
        scope: Option<&str>,
        label: &str,
    ) -> Result<NotificationMutationResult, String> {
        let sequence = self.next_sequence()?;
        let mut ledger = self
            .ledger
            .lock()
            .map_err(|_| "notification authority unavailable")?;
        let snapshot = NotificationSnapshot::from_ledger(&ledger, 0, SNAPSHOT_LIMIT)
            .map_err(|error| error.to_string())?;
        let actions = if kind.starts_with("nucleus:forge-") {
            vec![NotificationActionProjection {
                reference_id: id(ACTION_OPEN_FORGE)?,
                label: "Open Forge".to_owned(),
            }]
        } else {
            Vec::new()
        };
        let scope_summary = scope
            .map(|value| format!(" in {value}"))
            .unwrap_or_default();
        let result = ledger
            .execute_protocol_mutation(NotificationMutationCommand::Add {
                request_id: id(&format!("request:nucleus-notification:{sequence}:add"))?,
                protocol_version: NotificationProtocolVersion::CURRENT,
                authority: snapshot.authority,
                expected_ledger_revision: snapshot.ledger_revision,
                notification_id: id(&format!("notification:nucleus:{sequence}"))?,
                draft: NotificationDraftProjection {
                    source_id: id(SOURCE_OPERATIONS)?,
                    severity: NotificationSeverityProjection::Error,
                    title: format!("{label} failed"),
                    summary: format!("Background work{scope_summary} stopped without success."),
                    cause_id: id::<NotificationCauseId>(&operation_id.to_string()).ok(),
                    actions,
                    replacement_key: None,
                    producer_token: None,
                    retention_class: NotificationRetentionClassProjection::Standard,
                    presentation_time_unix_ms: presentation_time(),
                },
            })
            .map_err(|error| error.to_string())?;
        persist_committed(&self.persistence_path, &result)?;
        Ok(result)
    }

    fn command_refusal_mutation(
        &self,
        command_id: &str,
        scope: Option<&str>,
        label: &str,
        reason: &str,
    ) -> Result<NotificationMutationResult, String> {
        let sequence = self.next_sequence()?;
        let mut ledger = self
            .ledger
            .lock()
            .map_err(|_| "notification authority unavailable")?;
        let snapshot = NotificationSnapshot::from_ledger(&ledger, 0, SNAPSHOT_LIMIT)
            .map_err(|error| error.to_string())?;
        let scope_summary = scope
            .map(|value| format!(" in {value}"))
            .unwrap_or_default();
        let result = ledger
            .execute_protocol_mutation(NotificationMutationCommand::Add {
                request_id: id(&format!("request:nucleus-notification:{sequence}:add"))?,
                protocol_version: NotificationProtocolVersion::CURRENT,
                authority: snapshot.authority,
                expected_ledger_revision: snapshot.ledger_revision,
                notification_id: id(&format!("notification:nucleus:{sequence}"))?,
                draft: NotificationDraftProjection {
                    source_id: id(SOURCE_COMMANDS)?,
                    severity: NotificationSeverityProjection::Warning,
                    title: format!("{label} refused"),
                    summary: format!("{reason}{scope_summary}"),
                    cause_id: id::<NotificationCauseId>(command_id).ok(),
                    actions: Vec::new(),
                    replacement_key: None,
                    producer_token: None,
                    retention_class: NotificationRetentionClassProjection::Standard,
                    presentation_time_unix_ms: presentation_time(),
                },
            })
            .map_err(|error| error.to_string())?;
        persist_committed(&self.persistence_path, &result)?;
        Ok(result)
    }

    fn next_sequence(&self) -> Result<u64, String> {
        let mut sequence = self
            .sequence
            .lock()
            .map_err(|_| "notification sequence unavailable")?;
        *sequence = sequence
            .checked_add(1)
            .ok_or("notification sequence exhausted")?;
        Ok(*sequence)
    }
}

impl NotificationHostService for NucleusNotificationRuntime {
    fn snapshot(
        &self,
        caller: &str,
        query: NotificationSnapshotQuery,
    ) -> Result<NotificationSnapshotResponse, NotificationHostError> {
        Self::authorize(caller)?;
        self.ledger
            .lock()
            .map_err(|_| {
                NotificationHostError::authority("notification authority unavailable", true)
            })?
            .execute_protocol_snapshot(query)
            .map_err(|error| NotificationHostError::authority(error.to_string(), false))
    }

    fn mutate(
        &self,
        caller: &str,
        command: NotificationMutationCommand,
    ) -> Result<NotificationMutationResult, NotificationHostError> {
        Self::authorize(caller)?;
        if !matches!(
            command,
            NotificationMutationCommand::MarkSeen { .. }
                | NotificationMutationCommand::Dismiss { .. }
                | NotificationMutationCommand::Clear { .. }
        ) {
            return Err(NotificationHostError::authority(
                "renderer may only mark, dismiss, or clear retained notifications",
                false,
            ));
        }
        let result = self
            .ledger
            .lock()
            .map_err(|_| {
                NotificationHostError::authority("notification authority unavailable", true)
            })?
            .execute_protocol_mutation(command)
            .map_err(|error| NotificationHostError::authority(error.to_string(), false))?;
        persist_committed(&self.persistence_path, &result)
            .map_err(|error| NotificationHostError::authority(error, true))?;
        Ok(result)
    }
}

pub(crate) fn install(app: &App, persistence_path: PathBuf) -> Result<(), String> {
    let runtime = Arc::new(NucleusNotificationRuntime::new(persistence_path)?);
    let service: Arc<dyn NotificationHostService> = runtime.clone();
    app.manage(NucleusNotificationState { runtime });
    app.manage(TauriNotificationState::new(service));
    Ok(())
}

pub(crate) fn publish_operation_failure<R: Runtime>(
    app: &AppHandle<R>,
    operation_id: &OperationId,
    kind: &str,
    scope: Option<&str>,
    label: &str,
) {
    let Some(state) = app.try_state::<NucleusNotificationState>() else {
        return;
    };
    if let Err(error) =
        state
            .runtime
            .publish_operation_failure(app, operation_id, kind, scope, label)
    {
        eprintln!("operation failure notification publication failed: {error}");
    }
}

pub(crate) fn publish_command_refusal<R: Runtime>(
    app: &AppHandle<R>,
    command_id: &str,
    scope: Option<&str>,
    label: &str,
    reason: &str,
) {
    let Some(state) = app.try_state::<NucleusNotificationState>() else {
        return;
    };
    match state
        .runtime
        .command_refusal_mutation(command_id, scope, label, reason)
        .and_then(|result| publish(app, &result))
    {
        Ok(()) => {}
        Err(error) => eprintln!("command refusal notification publication failed: {error}"),
    }
}

fn empty_ledger() -> Result<NotificationLedger, String> {
    Ok(NotificationLedger::new(
        id::<NotificationAuthorityId>(AUTHORITY_ID)?,
        NotificationAuthorityEpoch::new(1).map_err(|error| error.to_string())?,
        NotificationLedgerLimits::new(RETAINED_LIMIT, RETAINED_WEIGHT_LIMIT)
            .map_err(|error| error.to_string())?,
    ))
}

fn restore(ledger: &mut NotificationLedger, persisted: PersistedLedger) -> Result<(), String> {
    if persisted.schema_version != 1 {
        return Err(format!(
            "unsupported notification ledger schema {}",
            persisted.schema_version
        ));
    }
    for (index, record) in persisted.records_newest_first.into_iter().rev().enumerate() {
        let snapshot = NotificationSnapshot::from_ledger(ledger, 0, SNAPSHOT_LIMIT)
            .map_err(|error| error.to_string())?;
        let result = ledger
            .execute_protocol_mutation(NotificationMutationCommand::Add {
                request_id: id(&format!("request:nucleus-notification:restore:{index}:add"))?,
                protocol_version: NotificationProtocolVersion::CURRENT,
                authority: snapshot.authority,
                expected_ledger_revision: snapshot.ledger_revision,
                notification_id: record.notification_id.clone(),
                draft: record.draft,
            })
            .map_err(|error| error.to_string())?;
        if !matches!(result, NotificationMutationResult::Committed { .. }) {
            return Err("persisted notification replay was rejected".to_owned());
        }
        if record.read_state == NotificationReadStateProjection::Seen {
            let snapshot = NotificationSnapshot::from_ledger(ledger, 0, SNAPSHOT_LIMIT)
                .map_err(|error| error.to_string())?;
            let result = ledger
                .execute_protocol_mutation(NotificationMutationCommand::MarkSeen {
                    request_id: id(&format!(
                        "request:nucleus-notification:restore:{index}:seen"
                    ))?,
                    protocol_version: NotificationProtocolVersion::CURRENT,
                    authority: snapshot.authority,
                    expected_ledger_revision: snapshot.ledger_revision,
                    notification_id: record.notification_id,
                })
                .map_err(|error| error.to_string())?;
            if !matches!(result, NotificationMutationResult::Committed { .. }) {
                return Err("persisted notification read state was rejected".to_owned());
            }
        }
    }
    Ok(())
}

fn persist_committed(path: &Path, result: &NotificationMutationResult) -> Result<(), String> {
    let NotificationMutationResult::Committed { snapshot, .. } = result else {
        return Ok(());
    };
    let persisted = PersistedLedger {
        schema_version: 1,
        records_newest_first: snapshot
            .page
            .records
            .iter()
            .map(|record| PersistedRecord {
                notification_id: record.notification_id.clone(),
                draft: record.draft.clone(),
                read_state: record.read_state,
            })
            .collect(),
    };
    let bytes = serde_json::to_vec_pretty(&persisted).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn read_persisted(path: &Path) -> Result<PersistedLedger, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn publish<R: Runtime>(
    app: &AppHandle<R>,
    result: &NotificationMutationResult,
) -> Result<(), String> {
    if let Some(event) = notification_mutation_changed_event(result) {
        app.emit(NOTIFICATION_CHANGED_EVENT, event)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn presentation_time() -> Option<i64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    i64::try_from(millis).ok()
}

fn id<T>(value: &str) -> Result<T, String>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    value.parse::<T>().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests;
