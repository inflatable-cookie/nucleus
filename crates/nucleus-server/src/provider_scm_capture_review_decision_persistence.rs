//! Persistence for explicit SCM capture operator review decisions.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::{ScmCaptureReviewReadinessRecord, ScmCaptureReviewReadinessStatus, ServerStateService};

const SCM_CAPTURE_REVIEW_DECISION_PREFIX: &str = "scm-capture-review-decision:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureReviewDecisionPersistenceInput {
    pub readiness: ScmCaptureReviewReadinessRecord,
    pub decision: ScmCaptureReviewDecision,
    pub existing_decision_ids: Vec<String>,
    pub raw_output_present: bool,
    pub change_request_requested: bool,
    pub scm_mutation_requested: bool,
    pub forge_effect_requested: bool,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureReviewDecisionRecord {
    pub decision_id: String,
    pub readiness_id: String,
    pub workflow_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub repo_id: String,
    pub operator_ref: String,
    pub decision: ScmCaptureReviewDecision,
    pub evidence_refs: Vec<String>,
    pub readiness_status: ScmCaptureReviewReadinessStatus,
    pub status: ScmCaptureReviewDecisionPersistenceStatus,
    pub blockers: Vec<ScmCaptureReviewDecisionPersistenceBlocker>,
    pub duplicate_decision_detected: bool,
    pub change_request_authority_granted: bool,
    pub scm_mutation_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureReviewDecision {
    Accept,
    Reject(String),
    NeedsChanges(String),
    Abandon(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureReviewDecisionPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureReviewDecisionPersistenceBlocker {
    ReadinessNotReady,
    OperatorRefMissing,
    MissingEvidenceRef,
    EmptyEvidenceRef,
    DecisionReasonMissing,
    RawOutputPresent,
    ChangeRequestRequested,
    ScmMutationRequested,
    ForgeEffectRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureReviewDecisionDiagnosticsRecord {
    pub diagnostics_id: String,
    pub decision_count: usize,
    pub persisted_decision_count: usize,
    pub duplicate_decision_count: usize,
    pub blocked_decision_count: usize,
    pub accepted_count: usize,
    pub rejected_count: usize,
    pub needs_changes_count: usize,
    pub abandoned_count: usize,
    pub blocker_count: usize,
    pub change_request_authority_granted: bool,
    pub scm_mutation_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

pub fn persist_scm_capture_review_decision<B>(
    state: &ServerStateService<B>,
    input: ScmCaptureReviewDecisionPersistenceInput,
) -> LocalStoreResult<ScmCaptureReviewDecisionRecord>
where
    B: LocalStoreBackend,
{
    let decision_id = decision_id(&input.readiness);
    if input.existing_decision_ids.contains(&decision_id) {
        return Ok(decision_record(
            input,
            decision_id,
            ScmCaptureReviewDecisionPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    if !blockers.is_empty() {
        return Ok(decision_record(
            input,
            decision_id,
            ScmCaptureReviewDecisionPersistenceStatus::Blocked,
            blockers,
            false,
        ));
    }

    let record = decision_record(
        input,
        decision_id,
        ScmCaptureReviewDecisionPersistenceStatus::Persisted,
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

pub fn read_scm_capture_review_decisions<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ScmCaptureReviewDecisionRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(SCM_CAPTURE_REVIEW_DECISION_PREFIX))
        .map(|record| {
            serde_json::from_slice::<ScmCaptureReviewDecisionRecord>(&record.payload.bytes)
                .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.decision_id.cmp(&right.decision_id));
    Ok(records)
}

pub fn scm_capture_review_decision_diagnostics(
    records: Vec<ScmCaptureReviewDecisionRecord>,
) -> ScmCaptureReviewDecisionDiagnosticsRecord {
    ScmCaptureReviewDecisionDiagnosticsRecord {
        diagnostics_id: "scm-capture-review-decision-diagnostics".to_owned(),
        decision_count: records.len(),
        persisted_decision_count: records
            .iter()
            .filter(|record| record.status == ScmCaptureReviewDecisionPersistenceStatus::Persisted)
            .count(),
        duplicate_decision_count: records
            .iter()
            .filter(|record| {
                record.status == ScmCaptureReviewDecisionPersistenceStatus::DuplicateNoop
            })
            .count(),
        blocked_decision_count: records
            .iter()
            .filter(|record| record.status == ScmCaptureReviewDecisionPersistenceStatus::Blocked)
            .count(),
        accepted_count: records
            .iter()
            .filter(|record| record.decision == ScmCaptureReviewDecision::Accept)
            .count(),
        rejected_count: records
            .iter()
            .filter(|record| matches!(record.decision, ScmCaptureReviewDecision::Reject(_)))
            .count(),
        needs_changes_count: records
            .iter()
            .filter(|record| matches!(record.decision, ScmCaptureReviewDecision::NeedsChanges(_)))
            .count(),
        abandoned_count: records
            .iter()
            .filter(|record| matches!(record.decision, ScmCaptureReviewDecision::Abandon(_)))
            .count(),
        blocker_count: records.iter().map(|record| record.blockers.len()).sum(),
        change_request_authority_granted: false,
        scm_mutation_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}

fn decision_record(
    input: ScmCaptureReviewDecisionPersistenceInput,
    decision_id: String,
    status: ScmCaptureReviewDecisionPersistenceStatus,
    blockers: Vec<ScmCaptureReviewDecisionPersistenceBlocker>,
    duplicate_decision_detected: bool,
) -> ScmCaptureReviewDecisionRecord {
    ScmCaptureReviewDecisionRecord {
        decision_id,
        readiness_id: input.readiness.readiness_id,
        workflow_id: input.readiness.workflow_id,
        task_id: input.readiness.task_id,
        work_item_id: input.readiness.work_item_id,
        completion_id: input.readiness.completion_id,
        repo_id: input.readiness.repo_id,
        operator_ref: input.readiness.operator_ref,
        decision: input.decision,
        evidence_refs: unique_sorted(input.readiness.evidence_refs),
        readiness_status: input.readiness.status,
        status,
        blockers,
        duplicate_decision_detected,
        change_request_authority_granted: false,
        scm_mutation_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}

fn blockers(
    input: &ScmCaptureReviewDecisionPersistenceInput,
) -> Vec<ScmCaptureReviewDecisionPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.readiness.operator_ref.trim().is_empty() {
        blockers.push(ScmCaptureReviewDecisionPersistenceBlocker::OperatorRefMissing);
    }
    if input.readiness.evidence_refs.is_empty() {
        blockers.push(ScmCaptureReviewDecisionPersistenceBlocker::MissingEvidenceRef);
    }
    if input
        .readiness
        .evidence_refs
        .iter()
        .any(|evidence_ref| evidence_ref.trim().is_empty())
    {
        blockers.push(ScmCaptureReviewDecisionPersistenceBlocker::EmptyEvidenceRef);
    }
    if input.decision == ScmCaptureReviewDecision::Accept && !input.readiness.review_ready {
        blockers.push(ScmCaptureReviewDecisionPersistenceBlocker::ReadinessNotReady);
    }
    if decision_reason_missing(&input.decision) {
        blockers.push(ScmCaptureReviewDecisionPersistenceBlocker::DecisionReasonMissing);
    }
    if input.raw_output_present || input.readiness.raw_output_retained {
        blockers.push(ScmCaptureReviewDecisionPersistenceBlocker::RawOutputPresent);
    }
    if input.change_request_requested || input.readiness.change_request_authority_granted {
        blockers.push(ScmCaptureReviewDecisionPersistenceBlocker::ChangeRequestRequested);
    }
    if input.scm_mutation_requested || input.readiness.scm_mutation_authority_granted {
        blockers.push(ScmCaptureReviewDecisionPersistenceBlocker::ScmMutationRequested);
    }
    if input.forge_effect_requested || input.readiness.forge_authority_granted {
        blockers.push(ScmCaptureReviewDecisionPersistenceBlocker::ForgeEffectRequested);
    }
    if input.provider_write_requested || input.readiness.provider_authority_granted {
        blockers.push(ScmCaptureReviewDecisionPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested || input.readiness.callback_authority_granted {
        blockers.push(ScmCaptureReviewDecisionPersistenceBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested || input.readiness.interruption_authority_granted {
        blockers.push(ScmCaptureReviewDecisionPersistenceBlocker::InterruptionRequested);
    }
    if input.recovery_requested || input.readiness.recovery_authority_granted {
        blockers.push(ScmCaptureReviewDecisionPersistenceBlocker::RecoveryRequested);
    }
    blockers
}

fn decision_reason_missing(decision: &ScmCaptureReviewDecision) -> bool {
    match decision {
        ScmCaptureReviewDecision::Accept => false,
        ScmCaptureReviewDecision::Reject(reason)
        | ScmCaptureReviewDecision::NeedsChanges(reason)
        | ScmCaptureReviewDecision::Abandon(reason) => reason.trim().is_empty(),
    }
}

fn decision_id(readiness: &ScmCaptureReviewReadinessRecord) -> String {
    format!(
        "{}{}:{}",
        SCM_CAPTURE_REVIEW_DECISION_PREFIX, readiness.workflow_id, readiness.readiness_id
    )
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
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

#[cfg(test)]
mod tests;
