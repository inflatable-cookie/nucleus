use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};
use nucleus_projects::{
    decode_project_storage_record, encode_project_storage_payload, ImportanceBaseline,
    ImportanceLevel, Project, ProjectActivity, ProjectId, ProjectRetention, ProjectStatus,
};

use super::handler::LocalControlRequestHandler;
use crate::commands::{
    ProjectCommand, ProjectCreateCommand, ProjectLifecycleAction, ProjectLifecycleCommand,
};
use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};
use crate::project_lifecycle::{
    persist_project_lifecycle_receipt, read_project_lifecycle_receipt,
    ProjectLifecycleReceiptRecord,
};

pub(crate) fn handle_project_command<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: ProjectCommand,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend + Clone,
{
    let result = match command {
        ProjectCommand::Create(command) => create_project(handler, command_id, command),
        ProjectCommand::Lifecycle(command) => lifecycle_project(handler, command_id, command),
        ProjectCommand::Resource(command) => {
            super::project_resource_commands::mutate_project_resource(handler, command_id, command)
        }
    };
    match result {
        Ok(()) => ServerCommandReceiptStatus::AcceptedForStateMutation,
        Err(error) => ServerCommandReceiptStatus::Rejected(error),
    }
}

fn create_project<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: ProjectCreateCommand,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    validate_common(
        handler,
        &command.actor_ref,
        &command.authority_host_ref,
        &command.idempotency_key,
    )?;
    let display_name = command.display_name.trim();
    if display_name.is_empty() {
        return Err(invalid("project name must not be empty"));
    }
    let project_id = project_id_for_create(&command.idempotency_key);
    let fingerprint = request_fingerprint(&[
        "create",
        &project_id.0,
        display_name,
        &command.actor_ref,
        &command.authority_host_ref,
    ]);
    if receipt_replayed(handler, &command.idempotency_key, &fingerprint)? {
        return Ok(());
    }

    let project = Project {
        id: project_id.clone(),
        display_name: display_name.to_owned(),
        authority_host_ref: command.authority_host_ref.clone(),
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
            created_at: Some(std::time::SystemTime::now()),
            last_focused_at: None,
            last_agent_activity_at: None,
            last_task_activity_at: None,
        },
    };
    let revision = RevisionId(format!("rev:project-create:{command_id}"));
    let payload = nucleus_projects::encode_project_storage_record(&project).map_err(codec_error)?;
    handler
        .state()
        .projects()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(project_id.0.clone()),
                domain: PersistenceDomain::Projects,
                kind: PersistenceRecordKind::Project,
                revision_id: revision.clone(),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: payload,
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .map_err(storage_error)?;
    persist_receipt(
        handler,
        ProjectLifecycleReceiptRecord::applied(
            command_id,
            command.idempotency_key,
            fingerprint,
            project_id.0,
            "create".to_owned(),
            command.actor_ref,
            command.authority_host_ref,
            None,
            Some(revision.0),
        ),
    )
}

fn lifecycle_project<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: ProjectLifecycleCommand,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    validate_common(
        handler,
        &command.actor_ref,
        &command.authority_host_ref,
        &command.idempotency_key,
    )?;
    let action = action_name(&command.action);
    let action_value = action_value(&command.action);
    let fingerprint = request_fingerprint(&[
        action,
        &command.project_id.0,
        &command.expected_revision.0,
        &command.actor_ref,
        &command.authority_host_ref,
        action_value,
    ]);
    if receipt_replayed(handler, &command.idempotency_key, &fingerprint)? {
        return Ok(());
    }

    let record_id = PersistenceRecordId(command.project_id.0.clone());
    let record = handler
        .state()
        .projects()
        .get(&record_id)
        .map_err(storage_error)?
        .ok_or_else(|| ServerControlError::NotFound {
            reason: format!("project not found: {}", command.project_id.0),
        })?;
    if record.kind != PersistenceRecordKind::Project {
        return Err(invalid("project lifecycle target is not a project record"));
    }
    if record.revision_id != command.expected_revision {
        return Err(ServerControlError::Conflict {
            reason: format!("project revision conflict for {}", command.project_id.0),
        });
    }
    let mut project = decode_project_storage_record(&record.payload.bytes).map_err(codec_error)?;
    if project.authority_host_ref != command.authority_host_ref {
        return Err(ServerControlError::Unauthorized {
            reason: format!(
                "project metadata is authoritative on {}",
                project.authority_host_ref
            ),
        });
    }

    let resulting_revision = if command.action == ProjectLifecycleAction::Delete {
        let impact = deletion_impact(handler, &project)?;
        if !impact.is_empty() {
            return Err(ServerControlError::InvalidRequest {
                reason: impact.refusal_reason(),
            });
        }
        handler
            .state()
            .projects()
            .delete(
                &record_id,
                RevisionExpectation::Exact(command.expected_revision.clone()),
            )
            .map_err(storage_error)?;
        None
    } else {
        apply_action(&mut project, &command.action)?;
        let revision = RevisionId(format!("rev:project-{action}:{command_id}"));
        let payload = encode_project_storage_payload(&project).map_err(codec_error)?;
        handler
            .state()
            .projects()
            .put(
                LocalStoreRecord {
                    id: record_id,
                    domain: PersistenceDomain::Projects,
                    kind: PersistenceRecordKind::Project,
                    revision_id: revision.clone(),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: payload,
                    },
                },
                RevisionExpectation::Exact(command.expected_revision.clone()),
            )
            .map_err(storage_error)?;
        Some(revision.0)
    };

    persist_receipt(
        handler,
        ProjectLifecycleReceiptRecord::applied(
            command_id,
            command.idempotency_key,
            fingerprint,
            command.project_id.0,
            action.to_owned(),
            command.actor_ref,
            command.authority_host_ref,
            Some(command.expected_revision.0),
            resulting_revision,
        ),
    )
}

fn apply_action(
    project: &mut nucleus_projects::ProjectStorageRecord,
    action: &ProjectLifecycleAction,
) -> Result<(), ServerControlError> {
    match action {
        ProjectLifecycleAction::Rename { display_name } => {
            let display_name = display_name.trim();
            if display_name.is_empty() {
                return Err(invalid("project name must not be empty"));
            }
            project.display_name = display_name.to_owned();
        }
        ProjectLifecycleAction::Park => {
            project.status = nucleus_projects::ProjectStorageStatus::Parked
        }
        ProjectLifecycleAction::Archive => {
            project.status = nucleus_projects::ProjectStorageStatus::Archived
        }
        ProjectLifecycleAction::Restore => {
            project.status = nucleus_projects::ProjectStorageStatus::Active
        }
        ProjectLifecycleAction::Delete => unreachable!("delete handled before update"),
    }
    Ok(())
}

#[derive(Default)]
struct ProjectDeletionImpact {
    resources: usize,
    project_task_refs: usize,
    project_workspace_refs: usize,
    task_records: usize,
    planning_records: usize,
    memory_records: usize,
    conversation_records: usize,
    research_records: usize,
    workspace_records: usize,
}

impl ProjectDeletionImpact {
    fn is_empty(&self) -> bool {
        self.resources == 0
            && self.project_task_refs == 0
            && self.project_workspace_refs == 0
            && self.task_records == 0
            && self.planning_records == 0
            && self.memory_records == 0
            && self.conversation_records == 0
            && self.research_records == 0
            && self.workspace_records == 0
    }

    fn refusal_reason(&self) -> String {
        format!(
            "project deletion refused: retained resources={}, task_refs={}, workspace_refs={}, tasks={}, planning={}, memory={}, conversations={}, research={}, workspaces={}",
            self.resources,
            self.project_task_refs,
            self.project_workspace_refs,
            self.task_records,
            self.planning_records,
            self.memory_records,
            self.conversation_records,
            self.research_records,
            self.workspace_records,
        )
    }
}

fn deletion_impact<B>(
    handler: &LocalControlRequestHandler<B>,
    project: &nucleus_projects::ProjectStorageRecord,
) -> Result<ProjectDeletionImpact, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let project_id = &project.project_id;
    Ok(ProjectDeletionImpact {
        resources: project.resources.len(),
        project_task_refs: 0,
        project_workspace_refs: 0,
        task_records: matching_project_records(
            handler.state().tasks().list().map_err(storage_error)?,
            project_id,
        )?,
        planning_records: matching_project_records(
            handler.state().planning().list().map_err(storage_error)?,
            project_id,
        )?,
        memory_records: matching_project_records(
            handler
                .state()
                .shared_memory()
                .list()
                .map_err(storage_error)?,
            project_id,
        )?,
        conversation_records: matching_project_records(
            handler
                .state()
                .agent_sessions()
                .list()
                .map_err(storage_error)?,
            project_id,
        )?,
        research_records: matching_project_records(
            handler
                .state()
                .deep_research()
                .list()
                .map_err(storage_error)?,
            project_id,
        )?,
        workspace_records: matching_project_records(
            handler.state().workspaces().list().map_err(storage_error)?,
            project_id,
        )?,
    })
}

fn matching_project_records(
    records: Vec<LocalStoreRecord>,
    project_id: &str,
) -> Result<usize, ServerControlError> {
    records.into_iter().try_fold(0, |count, record| {
        let value: serde_json::Value =
            serde_json::from_slice(&record.payload.bytes).map_err(|_| {
                ServerControlError::InvalidRequest {
                    reason: format!(
                        "project deletion cannot prove retained record safety: {}",
                        record.id.0
                    ),
                }
            })?;
        Ok(count + usize::from(json_references_project(&value, project_id)))
    })
}

fn json_references_project(value: &serde_json::Value, project_id: &str) -> bool {
    match value {
        serde_json::Value::Object(values) => values.iter().any(|(key, value)| {
            matches!(key.as_str(), "project_id" | "project_ref")
                && value.as_str() == Some(project_id)
                || json_references_project(value, project_id)
        }),
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| json_references_project(value, project_id)),
        _ => false,
    }
}

fn validate_common<B>(
    handler: &LocalControlRequestHandler<B>,
    actor_ref: &str,
    authority_host_ref: &str,
    idempotency_key: &str,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if actor_ref.trim().is_empty() {
        return Err(invalid("project lifecycle command requires an actor ref"));
    }
    if idempotency_key.trim().is_empty() {
        return Err(invalid(
            "project lifecycle command requires an idempotency key",
        ));
    }
    if authority_host_ref != handler.authority_host_id().0 {
        return Err(ServerControlError::Unauthorized {
            reason: format!(
                "project lifecycle command must run on authority host {}",
                handler.authority_host_id().0
            ),
        });
    }
    Ok(())
}

fn receipt_replayed<B>(
    handler: &LocalControlRequestHandler<B>,
    idempotency_key: &str,
    fingerprint: &str,
) -> Result<bool, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let Some(receipt) =
        read_project_lifecycle_receipt(handler.state(), idempotency_key).map_err(storage_error)?
    else {
        return Ok(false);
    };
    if receipt.request_fingerprint == fingerprint {
        Ok(true)
    } else {
        Err(ServerControlError::Conflict {
            reason: "project lifecycle idempotency key is already bound to another request"
                .to_owned(),
        })
    }
}

fn persist_receipt<B>(
    handler: &LocalControlRequestHandler<B>,
    receipt: ProjectLifecycleReceiptRecord,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    persist_project_lifecycle_receipt(handler.state(), &receipt).map_err(storage_error)
}

fn project_id_for_create(idempotency_key: &str) -> ProjectId {
    let hash = blake3::hash(idempotency_key.as_bytes())
        .to_hex()
        .to_string();
    ProjectId(format!("project:{}", &hash[..24]))
}

fn request_fingerprint(parts: &[&str]) -> String {
    let mut hasher = blake3::Hasher::new();
    for part in parts {
        hasher.update(&(part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

fn action_name(action: &ProjectLifecycleAction) -> &'static str {
    match action {
        ProjectLifecycleAction::Rename { .. } => "rename",
        ProjectLifecycleAction::Park => "park",
        ProjectLifecycleAction::Archive => "archive",
        ProjectLifecycleAction::Restore => "restore",
        ProjectLifecycleAction::Delete => "delete",
    }
}

fn action_value(action: &ProjectLifecycleAction) -> &str {
    match action {
        ProjectLifecycleAction::Rename { display_name } => display_name.trim(),
        _ => "",
    }
}

fn invalid(reason: &str) -> ServerControlError {
    ServerControlError::InvalidRequest {
        reason: reason.to_owned(),
    }
}

fn codec_error(error: nucleus_projects::ProjectRecordCodecError) -> ServerControlError {
    ServerControlError::StorageUnavailable {
        reason: error.reason,
    }
}

fn storage_error(error: LocalStoreError) -> ServerControlError {
    match error {
        LocalStoreError::RevisionConflict(_) => ServerControlError::Conflict {
            reason: "project lifecycle storage revision conflict".to_owned(),
        },
        other => ServerControlError::StorageUnavailable {
            reason: format!("{other:?}"),
        },
    }
}
