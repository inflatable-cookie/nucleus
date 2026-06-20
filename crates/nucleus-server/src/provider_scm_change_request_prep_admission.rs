//! Adapter-neutral change-request preparation admission from SCM capture review decisions.

use serde::{Deserialize, Serialize};

use crate::{
    ScmCaptureReviewDecision, ScmCaptureReviewDecisionPersistenceStatus,
    ScmCaptureReviewDecisionRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmChangeRequestPrepAdmissionInput {
    pub decision: ScmCaptureReviewDecisionRecord,
    pub adapter_label: String,
    pub workflow_label: String,
    pub branch_or_snapshot_requested: bool,
    pub commit_or_publish_requested: bool,
    pub push_or_remote_publish_requested: bool,
    pub forge_effect_requested: bool,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
    pub raw_output_present: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmChangeRequestPrepAdmissionRecord {
    pub admission_id: String,
    pub decision_id: String,
    pub readiness_id: String,
    pub workflow_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub repo_id: String,
    pub operator_ref: String,
    pub adapter_label: String,
    pub workflow_label: String,
    pub evidence_refs: Vec<String>,
    pub status: ScmChangeRequestPrepAdmissionStatus,
    pub blockers: Vec<ScmChangeRequestPrepAdmissionBlocker>,
    pub preparation_admitted: bool,
    pub branch_or_snapshot_authority_granted: bool,
    pub commit_or_publish_authority_granted: bool,
    pub push_or_remote_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmChangeRequestPrepAdmissionStatus {
    Admitted,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmChangeRequestPrepAdmissionBlocker {
    DecisionNotPersisted,
    DecisionNotAccepted,
    MissingEvidenceRef,
    AdapterLabelMissing,
    WorkflowLabelMissing,
    BranchOrSnapshotRequested,
    CommitOrPublishRequested,
    PushOrRemotePublishRequested,
    ForgeEffectRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
    RawOutputPresent,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmChangeRequestPrepDiagnosticsRecord {
    pub diagnostics_id: String,
    pub admission_count: usize,
    pub admitted_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub blocker_count: usize,
    pub adapter_neutral: bool,
    pub branch_or_snapshot_authority_granted: bool,
    pub commit_or_publish_authority_granted: bool,
    pub push_or_remote_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

pub fn scm_change_request_prep_admission(
    input: ScmChangeRequestPrepAdmissionInput,
) -> ScmChangeRequestPrepAdmissionRecord {
    let blockers = blockers(&input);
    let status = status(&blockers);
    let preparation_admitted = status == ScmChangeRequestPrepAdmissionStatus::Admitted;

    ScmChangeRequestPrepAdmissionRecord {
        admission_id: format!("scm-change-request-prep:{}", input.decision.decision_id),
        decision_id: input.decision.decision_id,
        readiness_id: input.decision.readiness_id,
        workflow_id: input.decision.workflow_id,
        task_id: input.decision.task_id,
        work_item_id: input.decision.work_item_id,
        completion_id: input.decision.completion_id,
        repo_id: input.decision.repo_id,
        operator_ref: input.decision.operator_ref,
        adapter_label: input.adapter_label,
        workflow_label: input.workflow_label,
        evidence_refs: unique_sorted(input.decision.evidence_refs),
        status,
        blockers,
        preparation_admitted,
        branch_or_snapshot_authority_granted: false,
        commit_or_publish_authority_granted: false,
        push_or_remote_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}

pub fn scm_change_request_prep_diagnostics(
    records: Vec<ScmChangeRequestPrepAdmissionRecord>,
) -> ScmChangeRequestPrepDiagnosticsRecord {
    ScmChangeRequestPrepDiagnosticsRecord {
        diagnostics_id: "scm-change-request-prep-diagnostics".to_owned(),
        admission_count: records.len(),
        admitted_count: records
            .iter()
            .filter(|record| record.status == ScmChangeRequestPrepAdmissionStatus::Admitted)
            .count(),
        blocked_count: records
            .iter()
            .filter(|record| record.status == ScmChangeRequestPrepAdmissionStatus::Blocked)
            .count(),
        repair_required_count: records
            .iter()
            .filter(|record| record.status == ScmChangeRequestPrepAdmissionStatus::RepairRequired)
            .count(),
        blocker_count: records.iter().map(|record| record.blockers.len()).sum(),
        adapter_neutral: true,
        branch_or_snapshot_authority_granted: false,
        commit_or_publish_authority_granted: false,
        push_or_remote_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}

fn blockers(
    input: &ScmChangeRequestPrepAdmissionInput,
) -> Vec<ScmChangeRequestPrepAdmissionBlocker> {
    let mut blockers = Vec::new();
    if input.decision.status != ScmCaptureReviewDecisionPersistenceStatus::Persisted {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::DecisionNotPersisted);
    }
    if input.decision.decision != ScmCaptureReviewDecision::Accept {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::DecisionNotAccepted);
    }
    if input.decision.evidence_refs.is_empty() {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::MissingEvidenceRef);
    }
    if input.adapter_label.trim().is_empty() {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::AdapterLabelMissing);
    }
    if input.workflow_label.trim().is_empty() {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::WorkflowLabelMissing);
    }
    if input.branch_or_snapshot_requested {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::BranchOrSnapshotRequested);
    }
    if input.commit_or_publish_requested {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::CommitOrPublishRequested);
    }
    if input.push_or_remote_publish_requested {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::PushOrRemotePublishRequested);
    }
    if input.forge_effect_requested {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::ForgeEffectRequested);
    }
    if input.provider_write_requested {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::RecoveryRequested);
    }
    if input.raw_output_present {
        blockers.push(ScmChangeRequestPrepAdmissionBlocker::RawOutputPresent);
    }
    blockers
}

fn status(
    blockers: &[ScmChangeRequestPrepAdmissionBlocker],
) -> ScmChangeRequestPrepAdmissionStatus {
    if blockers.is_empty() {
        ScmChangeRequestPrepAdmissionStatus::Admitted
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ScmChangeRequestPrepAdmissionBlocker::AdapterLabelMissing
                | ScmChangeRequestPrepAdmissionBlocker::WorkflowLabelMissing
                | ScmChangeRequestPrepAdmissionBlocker::MissingEvidenceRef
        )
    }) {
        ScmChangeRequestPrepAdmissionStatus::RepairRequired
    } else {
        ScmChangeRequestPrepAdmissionStatus::Blocked
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests;
