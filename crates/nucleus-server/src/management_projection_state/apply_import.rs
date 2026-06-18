use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus, ManagementProjectionConflictClass,
    ManagementProjectionConflictReport, ManagementProjectionPayload, ManagementProjectionRecordId,
    ManagementProjectionRecordKind, ManagementProjectionValidationStatus,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload, LocalStoreResult,
    RevisionExpectation,
};
use nucleus_projects::encode_project_storage_payload;
use nucleus_tasks::encode_task_storage_payload;

use crate::state::ServerStateService;
use crate::runtime_receipt_state::write_runtime_receipt;

use super::types::{
    ManagementProjectionAppliedRecord, ManagementProjectionApplyBlock,
    ManagementProjectionApplyBlockKind, ManagementProjectionApplyTarget,
    ManagementProjectionImportApplyReport, ManagementProjectionImportApplyRequest,
    ManagementProjectionStagedFile,
};

pub fn apply_management_projection_import<B>(
    state: &ServerStateService<B>,
    request: ManagementProjectionImportApplyRequest,
) -> LocalStoreResult<ManagementProjectionImportApplyReport>
where
    B: LocalStoreBackend,
{
    let mut prepared = Vec::new();
    let mut blocked = Vec::new();

    for staged in request.staged {
        match prepare_staged_record(state, staged, &request.targets, &request.conflicts)? {
            PreparedApplyRecord::Ready(record, applied) => prepared.push((record, applied)),
            PreparedApplyRecord::Blocked(block) => blocked.push(block),
        }
    }

    if !blocked.is_empty() {
        let mut receipts = Vec::new();
        let mut blocked_with_receipts = Vec::new();
        for block in blocked {
            let receipt = receipt_for_block(&block);
            write_apply_receipt(state, &receipt)?;
            let mut block = block;
            block.receipt_id = Some(receipt.receipt_id.clone());
            receipts.push(receipt);
            blocked_with_receipts.push(block);
        }
        for (_record, applied) in prepared {
            let receipt = receipt_for_skipped(&applied);
            write_apply_receipt(state, &receipt)?;
            receipts.push(receipt);
        }
        return Ok(ManagementProjectionImportApplyReport {
            applied: Vec::new(),
            blocked: blocked_with_receipts,
            receipts,
            authoritative_state_mutated: false,
            scm_mutation_performed: false,
        });
    }

    let mut applied = Vec::new();
    let mut receipts = Vec::new();
    for (record, applied_record) in prepared {
        let expectation = request
            .targets
            .iter()
            .find(|target| target.record_id.0 == record.id.0)
            .map(revision_expectation)
            .unwrap_or(RevisionExpectation::MustNotExist);

        match record.domain {
            PersistenceDomain::Projects => {
                state.projects().put(record, expectation)?;
            }
            PersistenceDomain::Tasks => {
                state.tasks().put(record, expectation)?;
            }
            _ => unreachable!("prepared apply records only use project/task domains"),
        }
        let receipt = receipt_for_applied(&applied_record);
        write_apply_receipt(state, &receipt)?;
        let mut applied_record = applied_record;
        applied_record.receipt_id = receipt.receipt_id.clone();
        receipts.push(receipt);
        applied.push(applied_record);
    }

    Ok(ManagementProjectionImportApplyReport {
        authoritative_state_mutated: !applied.is_empty(),
        applied,
        blocked: Vec::new(),
        receipts,
        scm_mutation_performed: false,
    })
}

enum PreparedApplyRecord {
    Ready(LocalStoreRecord, ManagementProjectionAppliedRecord),
    Blocked(ManagementProjectionApplyBlock),
}

fn prepare_staged_record<B>(
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
                staged.document.envelope.record_id.0,
                target.expected_current_revision,
                actual
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
        matches!(conflict.class, ManagementProjectionConflictClass::Semantic(_))
            && (conflict.local_record_ref.as_ref() == Some(record_id)
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

fn revision_expectation(target: &ManagementProjectionApplyTarget) -> RevisionExpectation {
    match &target.expected_current_revision {
        Some(revision) => RevisionExpectation::Exact(revision.clone()),
        None => RevisionExpectation::MustNotExist,
    }
}

fn apply_revision(record_id: &ManagementProjectionRecordId) -> RevisionId {
    RevisionId(format!("rev:projection-apply:{}", record_id.0))
}

fn write_apply_receipt<B>(
    state: &ServerStateService<B>,
    receipt: &EngineRuntimeReceiptRecord,
) -> LocalStoreResult<()>
where
    B: LocalStoreBackend,
{
    write_runtime_receipt(
        state,
        receipt,
        RevisionId(format!("rev:{}", receipt.receipt_id.0)),
        RevisionExpectation::Any,
    )
    .map(|_| ())
}

fn receipt_for_applied(applied: &ManagementProjectionAppliedRecord) -> EngineRuntimeReceiptRecord {
    apply_receipt(
        &receipt_id(&applied.record_id, "accepted"),
        EngineRuntimeReceiptStatus::Completed,
        &applied.record_id,
        &applied.file_ref,
        vec![EngineRuntimeReceiptRef::Custom(format!(
            "revision:{}",
            applied.revision_id.0
        ))],
        Some(format!(
            "accepted management projection apply for {}",
            applied.record_id.0
        )),
    )
}

fn receipt_for_block(block: &ManagementProjectionApplyBlock) -> EngineRuntimeReceiptRecord {
    let record_id = block
        .record_id
        .clone()
        .unwrap_or_else(|| ManagementProjectionRecordId("unknown".to_owned()));
    let mut evidence_refs = vec![EngineRuntimeReceiptRef::Custom(format!(
        "block_kind:{:?}",
        block.kind
    ))];
    if let Some(conflict) = &block.conflict {
        evidence_refs.push(EngineRuntimeReceiptRef::Custom(format!(
            "conflict:{}",
            conflict.conflict_id
        )));
    }
    let status = if block.kind == ManagementProjectionApplyBlockKind::SemanticConflict {
        EngineRuntimeReceiptStatus::WaitingForApproval
    } else {
        EngineRuntimeReceiptStatus::Blocked
    };

    apply_receipt(
        &receipt_id(&record_id, "blocked"),
        status,
        &record_id,
        &block.file_ref,
        evidence_refs,
        Some(format!(
            "blocked management projection apply for {}: {:?}",
            record_id.0, block.kind
        )),
    )
}

fn receipt_for_skipped(applied: &ManagementProjectionAppliedRecord) -> EngineRuntimeReceiptRecord {
    apply_receipt(
        &receipt_id(&applied.record_id, "skipped"),
        EngineRuntimeReceiptStatus::Blocked,
        &applied.record_id,
        &applied.file_ref,
        vec![EngineRuntimeReceiptRef::Custom(
            "skipped_due_to_blocked_apply_batch".to_owned(),
        )],
        Some(format!(
            "skipped management projection apply for {} because another record was blocked",
            applied.record_id.0
        )),
    )
}

fn apply_receipt(
    receipt_id: &EngineRuntimeReceiptRecordId,
    status: EngineRuntimeReceiptStatus,
    record_id: &ManagementProjectionRecordId,
    file_ref: &nucleus_engine::ManagementProjectionFileRef,
    mut evidence_refs: Vec<EngineRuntimeReceiptRef>,
    summary: Option<String>,
) -> EngineRuntimeReceiptRecord {
    evidence_refs.push(EngineRuntimeReceiptRef::Custom(format!(
        "record:{}",
        record_id.0
    )));
    evidence_refs.push(EngineRuntimeReceiptRef::Custom(format!(
        "file:{}",
        file_ref.0
    )));

    EngineRuntimeReceiptRecord {
        receipt_id: receipt_id.clone(),
        family: EngineRuntimeReceiptEffectFamily::Custom("management_projection_apply".to_owned()),
        status,
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(
            "management_projection_apply".to_owned(),
        )),
        evidence_refs,
        artifact_refs: Vec::new(),
        summary,
    }
}

fn receipt_id(
    record_id: &ManagementProjectionRecordId,
    suffix: &str,
) -> EngineRuntimeReceiptRecordId {
    EngineRuntimeReceiptRecordId(format!(
        "receipt:management-projection-apply:{}:{suffix}",
        record_id.0
    ))
}
