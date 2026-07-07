use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};

use crate::{
    SelectedTaskReviewDecisionAdmissionStatus, SelectedTaskReviewDecisionPersistenceBlocker,
    SelectedTaskReviewDecisionPersistenceInput, SelectedTaskReviewDecisionPersistenceStatus,
    SelectedTaskReviewDecisionRecord, SelectedTaskReviewNext, ServerStateService,
};

const SELECTED_TASK_REVIEW_DECISION_PREFIX: &str = "selected-task-review-decision:";

pub fn persist_selected_task_review_decision<B>(
    state: &ServerStateService<B>,
    input: SelectedTaskReviewDecisionPersistenceInput,
) -> LocalStoreResult<SelectedTaskReviewDecisionRecord>
where
    B: LocalStoreBackend,
{
    let decision_id = input.admission.decision_id.clone();
    if input.existing_decision_ids.contains(&decision_id) {
        return Ok(decision_record(
            input,
            SelectedTaskReviewDecisionPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    if !blockers.is_empty() {
        return Ok(decision_record(
            input,
            SelectedTaskReviewDecisionPersistenceStatus::Blocked,
            blockers,
            false,
        ));
    }

    let record = decision_record(
        input,
        SelectedTaskReviewDecisionPersistenceStatus::Persisted,
        Vec::new(),
        false,
    );
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.decision_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.decision_id)),
            payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

pub fn read_selected_task_review_decisions<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<SelectedTaskReviewDecisionRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| {
            record
                .id
                .0
                .starts_with(SELECTED_TASK_REVIEW_DECISION_PREFIX)
        })
        .map(|record| {
            serde_json::from_slice::<SelectedTaskReviewDecisionRecord>(&record.payload.bytes)
                .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.decision_id.cmp(&right.decision_id));
    Ok(records)
}

fn decision_record(
    input: SelectedTaskReviewDecisionPersistenceInput,
    status: SelectedTaskReviewDecisionPersistenceStatus,
    blockers: Vec<SelectedTaskReviewDecisionPersistenceBlocker>,
    duplicate_decision_detected: bool,
) -> SelectedTaskReviewDecisionRecord {
    let command = input.admission.command.as_ref();
    SelectedTaskReviewDecisionRecord {
        decision_id: input.admission.decision_id,
        admission_id: input.admission.admission_id,
        project_id: input.admission.project_id.0,
        task_id: input.admission.task_id.0,
        work_item_refs: unique_sorted(input.review_next.review.work_item_refs.clone()),
        action: input.admission.action,
        outcome: command
            .map(|command| command.outcome)
            .unwrap_or_else(|| fallback_outcome(input.admission.action)),
        operator_ref: input.admission.operator_ref,
        expected_revision: command
            .map(|command| command.expected_revision.0.clone())
            .unwrap_or_default(),
        reviewed_evidence_refs: unique_sorted(input.admission.evidence_refs),
        receipt_refs: unique_sorted(input.review_next.evidence.receipt_refs.clone()),
        timeline_refs: decision_timeline_refs(&input.review_next, &status),
        reason_summary: command.and_then(|command| command.reason.clone()),
        idempotency_key: command
            .map(|command| command.idempotency_key.clone())
            .unwrap_or_default(),
        status,
        blockers,
        duplicate_decision_detected,
        review_mutation_performed: false,
        task_lifecycle_mutation_performed: false,
        provider_execution_performed: false,
        provider_write_performed: false,
        scm_or_forge_mutation_performed: false,
        accepted_memory_apply_performed: false,
        planning_apply_performed: false,
        projection_write_performed: false,
        agent_scheduling_performed: false,
        ui_effect_performed: false,
        raw_provider_material_retained: false,
        raw_command_output_retained: false,
    }
}

fn blockers(
    input: &SelectedTaskReviewDecisionPersistenceInput,
) -> Vec<SelectedTaskReviewDecisionPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.admission.status != SelectedTaskReviewDecisionAdmissionStatus::Admitted {
        blockers.push(SelectedTaskReviewDecisionPersistenceBlocker::AdmissionNotAdmitted);
    }
    if input.admission.command.is_none() {
        blockers.push(SelectedTaskReviewDecisionPersistenceBlocker::MissingCommand);
    }
    if input.admission.project_id != input.review_next.project_id {
        blockers.push(SelectedTaskReviewDecisionPersistenceBlocker::ProjectMismatch);
    }
    if input.admission.task_id != input.review_next.task_id {
        blockers.push(SelectedTaskReviewDecisionPersistenceBlocker::TaskMismatch);
    }
    if input.review_next.review.work_item_refs.is_empty() {
        blockers.push(SelectedTaskReviewDecisionPersistenceBlocker::MissingWorkItemRef);
    }
    if input.admission.evidence_refs.is_empty() {
        blockers.push(SelectedTaskReviewDecisionPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_provider_material_present {
        blockers.push(SelectedTaskReviewDecisionPersistenceBlocker::RawProviderMaterialPresent);
    }
    if input.raw_command_output_present {
        blockers.push(SelectedTaskReviewDecisionPersistenceBlocker::RawCommandOutputPresent);
    }
    if input.task_lifecycle_mutation_requested {
        blockers.push(SelectedTaskReviewDecisionPersistenceBlocker::TaskLifecycleMutationRequested);
    }
    if input.provider_execution_requested {
        blockers.push(SelectedTaskReviewDecisionPersistenceBlocker::ProviderExecutionRequested);
    }
    if input.scm_or_forge_mutation_requested {
        blockers.push(SelectedTaskReviewDecisionPersistenceBlocker::ScmOrForgeMutationRequested);
    }
    if input.memory_or_planning_apply_requested {
        blockers.push(SelectedTaskReviewDecisionPersistenceBlocker::MemoryOrPlanningApplyRequested);
    }
    if input.ui_effect_requested {
        blockers.push(SelectedTaskReviewDecisionPersistenceBlocker::UiEffectRequested);
    }
    blockers
}

fn decision_timeline_refs(
    review_next: &SelectedTaskReviewNext,
    status: &SelectedTaskReviewDecisionPersistenceStatus,
) -> Vec<String> {
    let mut refs = review_next.evidence.timeline_refs.clone();
    if *status == SelectedTaskReviewDecisionPersistenceStatus::Persisted {
        refs.push(format!(
            "timeline:selected-task-review-decision:{}",
            review_next.task_id.0
        ));
    }
    unique_sorted(refs)
}

fn fallback_outcome(
    action: crate::SelectedTaskReviewDecisionAction,
) -> crate::SelectedTaskReviewDecisionOutcome {
    match action {
        crate::SelectedTaskReviewDecisionAction::AcceptEvidence => {
            crate::SelectedTaskReviewDecisionOutcome::Accepted
        }
        crate::SelectedTaskReviewDecisionAction::RejectEvidence => {
            crate::SelectedTaskReviewDecisionOutcome::Rejected
        }
        crate::SelectedTaskReviewDecisionAction::RequestChanges => {
            crate::SelectedTaskReviewDecisionOutcome::NeedsChanges
        }
        crate::SelectedTaskReviewDecisionAction::AbandonReview => {
            crate::SelectedTaskReviewDecisionOutcome::Abandoned
        }
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.retain(|value| !value.trim().is_empty());
    for value in &mut values {
        *value = value.trim().to_owned();
    }
    values.sort();
    values.dedup();
    values
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}
