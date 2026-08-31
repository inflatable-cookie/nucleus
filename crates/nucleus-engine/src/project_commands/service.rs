//! Engine project lifecycle command service.
//!
//! Module index over the command service surface: create and lifecycle
//! execution, retention guards, and action application.

mod actions;
mod guards;
mod helpers;

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_projects::{
    decode_project_storage_record, encode_project_storage_payload, encode_project_storage_record,
    ImportanceBaseline, ImportanceLevel, Project, ProjectActivity, ProjectRetention,
    ProjectStatus,
};

use super::model::{
    EngineProjectCommand, EngineProjectCommandError, EngineProjectCreateCommand,
    EngineProjectLifecycleAction, EngineProjectLifecycleCommand, EngineProjectLifecycleReceipt,
    EngineProjectRepository, EngineProjectRetentionChoice,
};
use crate::task_commands::{EngineRevisionExpectation, EngineTaskRecord};

use actions::{action_name, action_value, apply_action};
use helpers::{codec_error, invalid, project_id_for_create, request_fingerprint};

#[derive(Debug)]
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
        let transient = command.retention == EngineProjectRetentionChoice::Transient;
        let display_name = command.display_name.trim();
        let display_name = if display_name.is_empty() {
            if transient {
                "New Chat"
            } else {
                return Err(invalid("project name must not be empty"));
            }
        } else {
            display_name
        };
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
            retention: if transient {
                ProjectRetention::Transient
            } else {
                ProjectRetention::Durable
            },
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
        } else if command.action == EngineProjectLifecycleAction::ExpireTransient {
            self.refuse_expiry_with_durable_children(&project)?;
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
