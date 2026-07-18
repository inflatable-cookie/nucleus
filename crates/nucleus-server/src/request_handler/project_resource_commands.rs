use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};
use nucleus_projects::{
    encode_project_storage_payload, ProjectResourceKind, ProjectResourceStorageKind,
};

use super::handler::LocalControlRequestHandler;
use crate::commands::{ProjectResourceAction, ProjectResourceCommand};
use crate::control_api::ServerControlError;
use crate::project_lifecycle::{
    persist_project_lifecycle_receipt, read_project_lifecycle_receipt,
    ProjectLifecycleReceiptRecord,
};
use crate::project_resource_control::{
    admit_project_resource_mutation, ProjectResourceMutationAdmissionBlockerKind,
    ProjectResourceMutationAdmissionContext, ProjectResourceMutationCandidate,
};

mod mutation;

pub(crate) fn mutate_project_resource<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: ProjectResourceCommand,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    validate_command(handler, &command)?;
    let fingerprint = request_fingerprint(&command);
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
        return Err(invalid("project resource target is not a project record"));
    }
    let mut project = nucleus_projects::decode_project_storage_record(&record.payload.bytes)
        .map_err(codec_error)?;
    admit_mutation(&command, &record.revision_id, &project)?;

    let action = resource_action_name(&command.action);
    apply_resource_action(&mut project, &command)?;
    if matches!(command.action, ProjectResourceAction::Attach { .. })
        && project.retention == nucleus_projects::ProjectRetentionStorage::Transient
    {
        // Spec 012: a durable child must not leave a transient project
        // vulnerable to silent expiry; attaching a resource promotes the
        // project in place within the same mutation.
        project.retention = nucleus_projects::ProjectRetentionStorage::Durable;
    }
    let revision = RevisionId(format!("rev:project-resource-{action}:{command_id}"));
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

    persist_project_lifecycle_receipt(
        handler.state(),
        &ProjectLifecycleReceiptRecord::applied(
            command_id,
            command.idempotency_key,
            fingerprint,
            command.project_id.0,
            format!("resource_{action}"),
            command.actor_ref,
            command.authority_host_ref,
            Some(command.expected_revision.0),
            Some(revision.0),
        ),
    )
    .map_err(storage_error)
}

fn validate_command<B>(
    handler: &LocalControlRequestHandler<B>,
    command: &ProjectResourceCommand,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if command.idempotency_key.trim().is_empty() {
        return Err(invalid(
            "project resource command requires an idempotency key",
        ));
    }
    if command.authority_host_ref != handler.authority_host_id().0 {
        return Err(ServerControlError::Unauthorized {
            reason: format!(
                "project resource command must run on authority host {}",
                handler.authority_host_id().0
            ),
        });
    }
    Ok(())
}

fn admit_mutation(
    command: &ProjectResourceCommand,
    current_revision: &RevisionId,
    project: &nucleus_projects::ProjectStorageRecord,
) -> Result<(), ServerControlError> {
    let resource = resource_id(&command.action)
        .and_then(|resource_id| project.resource(resource_id))
        .map(|resource| (resource.resource_id.clone(), resource_kind(&resource.kind)));
    if resource_id(&command.action).is_some() && resource.is_none() {
        return Err(ServerControlError::NotFound {
            reason: "project resource was not found".to_owned(),
        });
    }
    let candidate = ProjectResourceMutationCandidate {
        project_id: command.project_id.clone(),
        resource_id: resource
            .as_ref()
            .map(|(resource_id, _)| nucleus_projects::ProjectResourceId(resource_id.clone())),
        resource_kind: resource
            .map(|(_, kind)| kind)
            .unwrap_or(ProjectResourceKind::FilesystemFolder),
        expected_revision: command.expected_revision.clone(),
        actor_ref: command.actor_ref.clone(),
        authority_host_ref: command.authority_host_ref.clone(),
    };
    let admission = admit_project_resource_mutation(
        candidate,
        &ProjectResourceMutationAdmissionContext {
            current_revision: current_revision.clone(),
            authoritative_host_ref: project.authority_host_ref.clone(),
        },
    );
    let Some(blocker) = admission.blocker else {
        return Ok(());
    };
    Err(match blocker.kind {
        ProjectResourceMutationAdmissionBlockerKind::MissingActor => invalid(&blocker.reason),
        ProjectResourceMutationAdmissionBlockerKind::StaleRevision => {
            ServerControlError::Conflict {
                reason: blocker.reason,
            }
        }
        ProjectResourceMutationAdmissionBlockerKind::WrongAuthorityHost => {
            ServerControlError::Unauthorized {
                reason: blocker.reason,
            }
        }
    })
}

fn apply_resource_action(
    project: &mut nucleus_projects::ProjectStorageRecord,
    command: &ProjectResourceCommand,
) -> Result<(), ServerControlError> {
    match &command.action {
        ProjectResourceAction::Attach { locator } => {
            mutation::attach_resource(project, command, locator)
        }
        ProjectResourceAction::Update {
            resource_id,
            display_name,
            role,
            set_as_default,
        } => mutation::update_resource(
            project,
            &resource_id.0,
            display_name.as_deref(),
            role.as_ref(),
            *set_as_default,
        ),
        ProjectResourceAction::Repair {
            resource_id,
            locator,
        } => mutation::repair_resource(project, &resource_id.0, locator),
        ProjectResourceAction::Remove { resource_id } => {
            mutation::remove_resource(project, &resource_id.0)
        }
    }
}

fn resource_id(action: &ProjectResourceAction) -> Option<&str> {
    match action {
        ProjectResourceAction::Attach { .. } => None,
        ProjectResourceAction::Update { resource_id, .. }
        | ProjectResourceAction::Repair { resource_id, .. }
        | ProjectResourceAction::Remove { resource_id } => Some(&resource_id.0),
    }
}

fn resource_kind(kind: &ProjectResourceStorageKind) -> ProjectResourceKind {
    match kind {
        ProjectResourceStorageKind::FilesystemFolder => ProjectResourceKind::FilesystemFolder,
        ProjectResourceStorageKind::GitRepository => ProjectResourceKind::GitRepository,
    }
}

fn resource_action_name(action: &ProjectResourceAction) -> &'static str {
    match action {
        ProjectResourceAction::Attach { .. } => "attach",
        ProjectResourceAction::Update { .. } => "update",
        ProjectResourceAction::Repair { .. } => "repair",
        ProjectResourceAction::Remove { .. } => "remove",
    }
}

fn request_fingerprint(command: &ProjectResourceCommand) -> String {
    let mut values = vec![
        resource_action_name(&command.action).to_owned(),
        command.project_id.0.clone(),
        command.expected_revision.0.clone(),
        command.actor_ref.clone(),
        command.authority_host_ref.clone(),
    ];
    match &command.action {
        ProjectResourceAction::Attach { locator } => {
            values.push(locator.to_string_lossy().into_owned())
        }
        ProjectResourceAction::Update {
            resource_id,
            display_name,
            role,
            set_as_default,
        } => {
            values.push(resource_id.0.clone());
            values.push(display_name.clone().unwrap_or_default());
            values.push(format!("{role:?}"));
            values.push(format!("{set_as_default:?}"));
        }
        ProjectResourceAction::Repair {
            resource_id,
            locator,
        } => {
            values.push(resource_id.0.clone());
            values.push(locator.to_string_lossy().into_owned());
        }
        ProjectResourceAction::Remove { resource_id } => values.push(resource_id.0.clone()),
    }
    let refs = values.iter().map(String::as_str).collect::<Vec<_>>();
    let mut hasher = blake3::Hasher::new();
    for value in refs {
        hasher.update(&(value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
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
            reason: "project resource idempotency key is already bound to another request"
                .to_owned(),
        })
    }
}

fn invalid(reason: &str) -> ServerControlError {
    invalid_owned(reason.to_owned())
}

fn invalid_owned(reason: String) -> ServerControlError {
    ServerControlError::InvalidRequest { reason }
}

fn codec_error(error: nucleus_projects::ProjectRecordCodecError) -> ServerControlError {
    ServerControlError::StorageUnavailable {
        reason: error.reason,
    }
}

fn storage_error(error: LocalStoreError) -> ServerControlError {
    match error {
        LocalStoreError::RevisionConflict(_) => ServerControlError::Conflict {
            reason: "project resource storage revision conflict".to_owned(),
        },
        other => ServerControlError::StorageUnavailable {
            reason: format!("{other:?}"),
        },
    }
}
