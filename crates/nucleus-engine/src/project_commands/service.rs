//! Engine project lifecycle command service.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_projects::{
    decode_project_storage_record, encode_project_storage_payload, encode_project_storage_record,
    ImportanceBaseline, ImportanceLevel, Project, ProjectActivity, ProjectId, ProjectRetention,
    ProjectStatus,
};

use super::model::{
    EngineProjectCommand, EngineProjectCommandError, EngineProjectCreateCommand,
    EngineProjectLifecycleAction, EngineProjectLifecycleCommand, EngineProjectLifecycleReceipt,
    EngineProjectRepository, EngineProjectScanDomain,
};
use crate::task_commands::{EngineRevisionExpectation, EngineTaskRecord};

pub struct EngineProjectCommandService<R> {
    repository: R,
}

type CommandResult<R> =
    Result<(), EngineProjectCommandError<<R as EngineProjectRepository>::Error>>;

impl<R> EngineProjectCommandService<R>
where
    R: EngineProjectRepository,
{
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    pub fn execute(&self, command_id: &str, command: EngineProjectCommand) -> CommandResult<R> {
        match command {
            EngineProjectCommand::Create(command) => self.create_project(command_id, command),
            EngineProjectCommand::Lifecycle(command) => self.lifecycle_project(command_id, command),
        }
    }

    fn create_project(
        &self,
        command_id: &str,
        command: EngineProjectCreateCommand,
    ) -> CommandResult<R> {
        self.validate_common(
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
        if self.receipt_replayed(&command.idempotency_key, &fingerprint)? {
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
        let payload = encode_project_storage_record(&project).map_err(codec_error)?;
        self.repository
            .put_project_record(
                EngineTaskRecord {
                    id: PersistenceRecordId(project_id.0.clone()),
                    domain: PersistenceDomain::Projects,
                    kind: PersistenceRecordKind::Project,
                    revision_id: revision.clone(),
                    payload,
                },
                EngineRevisionExpectation::MustNotExist,
            )
            .map_err(EngineProjectCommandError::Storage)?;
        self.repository
            .persist_receipt(EngineProjectLifecycleReceipt {
                command_id: command_id.to_owned(),
                idempotency_key: command.idempotency_key,
                request_fingerprint: fingerprint,
                project_id: project_id.0,
                action: "create".to_owned(),
                actor_ref: command.actor_ref,
                authority_host_ref: command.authority_host_ref,
                previous_revision: None,
                resulting_revision: Some(revision.0),
            })
            .map_err(EngineProjectCommandError::Storage)
    }

    fn lifecycle_project(
        &self,
        command_id: &str,
        command: EngineProjectLifecycleCommand,
    ) -> CommandResult<R> {
        self.validate_common(
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
        if self.receipt_replayed(&command.idempotency_key, &fingerprint)? {
            return Ok(());
        }

        let record_id = PersistenceRecordId(command.project_id.0.clone());
        let record = self
            .repository
            .get_project_record(&record_id)
            .map_err(EngineProjectCommandError::Storage)?
            .ok_or_else(|| EngineProjectCommandError::NotFound {
                reason: format!("project not found: {}", command.project_id.0),
            })?;
        if record.kind != PersistenceRecordKind::Project {
            return Err(invalid("project lifecycle target is not a project record"));
        }
        if record.revision_id != command.expected_revision {
            return Err(EngineProjectCommandError::Conflict {
                reason: format!("project revision conflict for {}", command.project_id.0),
            });
        }
        let mut project = decode_project_storage_record(&record.payload).map_err(codec_error)?;
        if project.authority_host_ref != command.authority_host_ref {
            return Err(EngineProjectCommandError::Unauthorized {
                reason: format!(
                    "project metadata is authoritative on {}",
                    project.authority_host_ref
                ),
            });
        }

        let resulting_revision = if command.action == EngineProjectLifecycleAction::Delete {
            self.refuse_delete_with_retained_records(&project)?;
            self.repository
                .delete_project_record(
                    &record_id,
                    EngineRevisionExpectation::Exact(command.expected_revision.clone()),
                )
                .map_err(EngineProjectCommandError::Storage)?;
            None
        } else {
            apply_action(&mut project, &command.action)?;
            let revision = RevisionId(format!("rev:project-{action}:{command_id}"));
            let payload = encode_project_storage_payload(&project).map_err(codec_error)?;
            self.repository
                .put_project_record(
                    EngineTaskRecord {
                        id: record_id,
                        domain: PersistenceDomain::Projects,
                        kind: PersistenceRecordKind::Project,
                        revision_id: revision.clone(),
                        payload,
                    },
                    EngineRevisionExpectation::Exact(command.expected_revision.clone()),
                )
                .map_err(EngineProjectCommandError::Storage)?;
            Some(revision.0)
        };

        self.repository
            .persist_receipt(EngineProjectLifecycleReceipt {
                command_id: command_id.to_owned(),
                idempotency_key: command.idempotency_key,
                request_fingerprint: fingerprint,
                project_id: command.project_id.0,
                action: action.to_owned(),
                actor_ref: command.actor_ref,
                authority_host_ref: command.authority_host_ref,
                previous_revision: Some(command.expected_revision.0),
                resulting_revision,
            })
            .map_err(EngineProjectCommandError::Storage)
    }

    /// A project deletes only when nothing still references it: no attached
    /// resources, refs, or records in any scanned domain.
    fn refuse_delete_with_retained_records(
        &self,
        project: &nucleus_projects::ProjectStorageRecord,
    ) -> CommandResult<R> {
        let mut retained: Vec<String> = Vec::new();
        if !project.resources.is_empty() {
            retained.push(format!("resources={}", project.resources.len()));
        }
        for domain in EngineProjectScanDomain::ALL {
            let matches = self
                .repository
                .domain_payloads(domain)
                .map_err(EngineProjectCommandError::Storage)?
                .into_iter()
                .try_fold(0_usize, |count, (record_id, payload)| {
                    let value: serde_json::Value =
                        serde_json::from_slice(&payload).map_err(|_| {
                            invalid(&format!(
                                "project deletion cannot prove retained record safety: {record_id}"
                            ))
                        })?;
                    Ok(count + usize::from(json_references_project(&value, &project.project_id)))
                })?;
            if matches > 0 {
                retained.push(format!("{}={matches}", domain.label()));
            }
        }
        if retained.is_empty() {
            Ok(())
        } else {
            Err(invalid(&format!(
                "project deletion refused: retained {}",
                retained.join(", ")
            )))
        }
    }

    fn validate_common(
        &self,
        actor_ref: &str,
        authority_host_ref: &str,
        idempotency_key: &str,
    ) -> CommandResult<R> {
        if actor_ref.trim().is_empty() {
            return Err(invalid("project lifecycle command requires an actor ref"));
        }
        if idempotency_key.trim().is_empty() {
            return Err(invalid(
                "project lifecycle command requires an idempotency key",
            ));
        }
        let authority = self.repository.authority_host_ref();
        if authority_host_ref != authority {
            return Err(EngineProjectCommandError::Unauthorized {
                reason: format!("project lifecycle command must run on authority host {authority}"),
            });
        }
        Ok(())
    }

    fn receipt_replayed(
        &self,
        idempotency_key: &str,
        fingerprint: &str,
    ) -> Result<bool, EngineProjectCommandError<R::Error>> {
        let Some(previous) = self
            .repository
            .receipt_fingerprint(idempotency_key)
            .map_err(EngineProjectCommandError::Storage)?
        else {
            return Ok(false);
        };
        if previous == fingerprint {
            Ok(true)
        } else {
            Err(EngineProjectCommandError::Conflict {
                reason: "project lifecycle idempotency key is already bound to another request"
                    .to_owned(),
            })
        }
    }
}

fn apply_action<E>(
    project: &mut nucleus_projects::ProjectStorageRecord,
    action: &EngineProjectLifecycleAction,
) -> Result<(), EngineProjectCommandError<E>> {
    match action {
        EngineProjectLifecycleAction::Rename { display_name } => {
            let display_name = display_name.trim();
            if display_name.is_empty() {
                return Err(invalid("project name must not be empty"));
            }
            project.display_name = display_name.to_owned();
        }
        EngineProjectLifecycleAction::Park => {
            project.status = nucleus_projects::ProjectStorageStatus::Parked
        }
        EngineProjectLifecycleAction::Archive => {
            project.status = nucleus_projects::ProjectStorageStatus::Archived
        }
        EngineProjectLifecycleAction::Restore => {
            project.status = nucleus_projects::ProjectStorageStatus::Active
        }
        EngineProjectLifecycleAction::Delete => {
            unreachable!("delete handled before update")
        }
    }
    Ok(())
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

fn action_name(action: &EngineProjectLifecycleAction) -> &'static str {
    match action {
        EngineProjectLifecycleAction::Rename { .. } => "rename",
        EngineProjectLifecycleAction::Park => "park",
        EngineProjectLifecycleAction::Archive => "archive",
        EngineProjectLifecycleAction::Restore => "restore",
        EngineProjectLifecycleAction::Delete => "delete",
    }
}

fn action_value(action: &EngineProjectLifecycleAction) -> &str {
    match action {
        EngineProjectLifecycleAction::Rename { display_name } => display_name.trim(),
        _ => "",
    }
}

fn invalid<E>(reason: &str) -> EngineProjectCommandError<E> {
    EngineProjectCommandError::InvalidRequest {
        reason: reason.to_owned(),
    }
}

fn codec_error<E>(error: nucleus_projects::ProjectRecordCodecError) -> EngineProjectCommandError<E> {
    EngineProjectCommandError::Codec {
        reason: error.reason,
    }
}
