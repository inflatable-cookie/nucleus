use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    EngineRuntimeReceiptRecordId, ManagementProjectionConflictClass,
    ManagementProjectionConflictReport, ManagementProjectionPayload, ManagementProjectionRecordId,
    ManagementProjectionRecordKind, ManagementProjectionValidationStatus,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload, LocalStoreResult,
};
use nucleus_projects::encode_project_storage_payload;
use nucleus_tasks::encode_task_storage_payload;

use crate::state::ServerStateService;

use super::super::types::{
    ManagementProjectionAppliedRecord, ManagementProjectionApplyBlock,
    ManagementProjectionApplyBlockKind, ManagementProjectionApplyTarget,
    ManagementProjectionStagedFile,
};

pub(super) enum PreparedApplyRecord {
    Ready(LocalStoreRecord, ManagementProjectionAppliedRecord),
    Blocked(ManagementProjectionApplyBlock),
}

pub(super) fn prepare_staged_record<B>(
    state: &ServerStateService<B>,
    staged: ManagementProjectionStagedFile,
    targets: &[ManagementProjectionApplyTarget],
    conflicts: &[ManagementProjectionConflictReport],
) -> LocalStoreResult<PreparedApplyRecord>
where
    B: LocalStoreBackend,
{
    match staged.validation.status {
        ManagementProjectionValidationStatus::Valid
        | ManagementProjectionValidationStatus::ValidWithWarnings => {}
        ManagementProjectionValidationStatus::Invalid => {
            return Ok(blocked(
                staged,
                ManagementProjectionApplyBlockKind::InvalidRecord,
                "invalid staged projection record requires repair before apply",
            ));
        }
        ManagementProjectionValidationStatus::UnsupportedSchema => {
            return Ok(blocked(
                staged,
                ManagementProjectionApplyBlockKind::UnsupportedSchema,
                "unsupported staged projection schema requires migration before apply",
            ));
        }
    }

    let target = match targets
        .iter()
        .find(|target| target.record_id == staged.document.envelope.record_id)
    {
        Some(target) => target,
        None => {
            return Ok(blocked(
                staged,
                ManagementProjectionApplyBlockKind::MissingApplyTarget,
                "staged projection record was not explicitly targeted for apply",
            ));
        }
    };

    if let Some(conflict) = semantic_conflict_for(&staged.document.envelope.record_id, conflicts) {
        return Ok(blocked_with_conflict(
            staged,
            ManagementProjectionApplyBlockKind::SemanticConflict,
            "semantic projection conflict requires review before apply",
            conflict.clone(),
        ));
    }

    match staged.document.envelope.record_kind {
        ManagementProjectionRecordKind::Project => prepare_project(state, staged, target),
        ManagementProjectionRecordKind::Task => prepare_task(state, staged, target),
        _ => Ok(blocked(
            staged,
            ManagementProjectionApplyBlockKind::UnsupportedRecordKind,
            "only project and task projection records can be applied in this lane",
        )),
    }
}

fn prepare_project<B>(
    state: &ServerStateService<B>,
    staged: ManagementProjectionStagedFile,
    target: &ManagementProjectionApplyTarget,
) -> LocalStoreResult<PreparedApplyRecord>
where
    B: LocalStoreBackend,
{
    let ManagementProjectionPayload::Project(project) = &staged.document.payload else {
        return Ok(blocked(
            staged,
            ManagementProjectionApplyBlockKind::UnsupportedPayload,
            "project projection record did not contain a project payload",
        ));
    };
    if staged.document.envelope.record_id.0 != project.project_id {
        return Ok(blocked(
            staged,
            ManagementProjectionApplyBlockKind::RecordIdMismatch,
            "projection envelope record id does not match project payload id",
        ));
    }

    if let Some(block) = preflight_revision(
        state
            .projects()
            .get(&PersistenceRecordId(project.project_id.clone()))?,
        target,
        &staged,
    ) {
        return Ok(PreparedApplyRecord::Blocked(block));
    }
    let payload = encode_project_storage_payload(project).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.reason,
        }
    })?;
    let revision_id = apply_revision(&staged.document.envelope.record_id);
    let record = LocalStoreRecord {
        id: PersistenceRecordId(project.project_id.clone()),
        domain: PersistenceDomain::Projects,
        kind: PersistenceRecordKind::Project,
        revision_id: revision_id.clone(),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    Ok(PreparedApplyRecord::Ready(
        record,
        applied_record(&staged, revision_id, "applied project projection record"),
    ))
}

fn prepare_task<B>(
    state: &ServerStateService<B>,
    staged: ManagementProjectionStagedFile,
    target: &ManagementProjectionApplyTarget,
) -> LocalStoreResult<PreparedApplyRecord>
where
    B: LocalStoreBackend,
{
    let ManagementProjectionPayload::Task(task) = &staged.document.payload else {
        return Ok(blocked(
            staged,
            ManagementProjectionApplyBlockKind::UnsupportedPayload,
            "task projection record did not contain a task payload",
        ));
    };
    if staged.document.envelope.record_id.0 != task.task_id {
        return Ok(blocked(
            staged,
            ManagementProjectionApplyBlockKind::RecordIdMismatch,
            "projection envelope record id does not match task payload id",
        ));
    }

    if let Some(block) = preflight_revision(
        state
            .tasks()
            .get(&PersistenceRecordId(task.task_id.clone()))?,
        target,
        &staged,
    ) {
        return Ok(PreparedApplyRecord::Blocked(block));
    }
    let payload =
        encode_task_storage_payload(task).map_err(|error| LocalStoreError::InvalidRecord {
            reason: error.reason,
        })?;
    let revision_id = apply_revision(&staged.document.envelope.record_id);
    let record = LocalStoreRecord {
        id: PersistenceRecordId(task.task_id.clone()),
        domain: PersistenceDomain::Tasks,
        kind: PersistenceRecordKind::Task,
        revision_id: revision_id.clone(),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    Ok(PreparedApplyRecord::Ready(
        record,
        applied_record(&staged, revision_id, "applied task projection record"),
    ))
}

fn preflight_revision(
    existing: Option<LocalStoreRecord>,
    target: &ManagementProjectionApplyTarget,
    staged: &ManagementProjectionStagedFile,
) -> Option<ManagementProjectionApplyBlock> {
    let actual = existing.map(|record| record.revision_id);
    match (&target.expected_current_revision, actual.as_ref()) {
        (None, None) => None,
        (Some(expected), Some(actual)) if expected == actual => None,
        _ => Some(ManagementProjectionApplyBlock {
            record_id: Some(staged.document.envelope.record_id.clone()),
            file_ref: staged.file_ref.clone(),
            kind: ManagementProjectionApplyBlockKind::RevisionConflict,
            summary: format!(
                "management projection apply revision conflict for {}; expected {:?}, actual {:?}",
                staged.document.envelope.record_id.0, target.expected_current_revision, actual
            ),
            conflict: None,
            receipt_id: None,
        }),
    }
}

fn semantic_conflict_for<'a>(
    record_id: &ManagementProjectionRecordId,
    conflicts: &'a [ManagementProjectionConflictReport],
) -> Option<&'a ManagementProjectionConflictReport> {
    conflicts.iter().find(|conflict| {
        matches!(
            conflict.class,
            ManagementProjectionConflictClass::Semantic(_)
        ) && (conflict.local_record_ref.as_ref() == Some(record_id)
            || conflict.incoming_record_ref.as_ref() == Some(record_id))
    })
}

fn blocked(
    staged: ManagementProjectionStagedFile,
    kind: ManagementProjectionApplyBlockKind,
    summary: &str,
) -> PreparedApplyRecord {
    PreparedApplyRecord::Blocked(ManagementProjectionApplyBlock {
        record_id: Some(staged.document.envelope.record_id),
        file_ref: staged.file_ref,
        kind,
        summary: summary.to_owned(),
        conflict: None,
        receipt_id: None,
    })
}

fn blocked_with_conflict(
    staged: ManagementProjectionStagedFile,
    kind: ManagementProjectionApplyBlockKind,
    summary: &str,
    conflict: ManagementProjectionConflictReport,
) -> PreparedApplyRecord {
    PreparedApplyRecord::Blocked(ManagementProjectionApplyBlock {
        record_id: Some(staged.document.envelope.record_id),
        file_ref: staged.file_ref,
        kind,
        summary: summary.to_owned(),
        conflict: Some(conflict),
        receipt_id: None,
    })
}

fn applied_record(
    staged: &ManagementProjectionStagedFile,
    revision_id: RevisionId,
    summary: &str,
) -> ManagementProjectionAppliedRecord {
    ManagementProjectionAppliedRecord {
        record_id: staged.document.envelope.record_id.clone(),
        file_ref: staged.file_ref.clone(),
        revision_id,
        receipt_id: EngineRuntimeReceiptRecordId("receipt:pending".to_owned()),
        summary: summary.to_owned(),
    }
}

fn apply_revision(record_id: &ManagementProjectionRecordId) -> RevisionId {
    RevisionId(format!("rev:projection-apply:{}", record_id.0))
}
