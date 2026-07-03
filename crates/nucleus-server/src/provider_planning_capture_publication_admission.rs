//! Adapter-neutral admission for planning projection capture publication.
//!
//! These records can admit creation of a stopped publication/share request.
//! They do not commit, snapshot, publish, push, call a forge, import
//! projections, promote tasks, or execute providers.

use serde::{Deserialize, Serialize};

use crate::{
    CompletionScmCapturePlanStatus, CompletionScmCapturePreparationPersistenceRecord,
    CompletionScmCapturePreparationPersistenceStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningCapturePublicationAdmissionInput {
    pub preparations: Vec<CompletionScmCapturePreparationPersistenceRecord>,
    pub target: PlanningCapturePublicationTarget,
    pub approval_ref: Option<String>,
    pub existing_admission_ids: Vec<String>,
    pub raw_payload_present: bool,
    pub scm_or_snapshot_mutation_requested: bool,
    pub remote_share_requested: bool,
    pub forge_mutation_requested: bool,
    pub provider_write_requested: bool,
    pub projection_import_requested: bool,
    pub task_promotion_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningCapturePublicationTarget {
    pub adapter_family: PlanningCapturePublicationAdapterFamily,
    pub operation: PlanningCapturePublicationOperation,
    pub adapter_label: String,
    pub workflow_label: String,
    pub management_file_refs: Vec<String>,
    pub adapter_supported: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningCapturePublicationAdapterFamily {
    GitLike,
    SnapshotPublicationLike,
    ForgeReviewLike,
    Manual,
    Custom(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningCapturePublicationOperation {
    Commit,
    Snapshot,
    Publish,
    Push,
    ForgeShare,
    ManualShare,
    Custom(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningCapturePublicationAdmissionSet {
    pub admission_set_id: String,
    pub admissions: Vec<PlanningCapturePublicationAdmissionRecord>,
    pub skipped_preparation_ids: Vec<String>,
    pub stopped_request_admitted_count: usize,
    pub commit_permitted: bool,
    pub snapshot_permitted: bool,
    pub publish_permitted: bool,
    pub push_permitted: bool,
    pub forge_share_permitted: bool,
    pub provider_write_permitted: bool,
    pub projection_import_permitted: bool,
    pub task_promotion_permitted: bool,
    pub callback_response_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningCapturePublicationAdmissionRecord {
    pub admission_id: String,
    pub preparation_id: String,
    pub plan_item_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub approval_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub adapter_family: PlanningCapturePublicationAdapterFamily,
    pub operation: PlanningCapturePublicationOperation,
    pub adapter_label: String,
    pub workflow_label: String,
    pub management_file_refs: Vec<String>,
    pub status: PlanningCapturePublicationAdmissionStatus,
    pub blockers: Vec<PlanningCapturePublicationAdmissionBlocker>,
    pub duplicate_admission_detected: bool,
    pub stopped_request_admitted: bool,
    pub commit_permitted: bool,
    pub snapshot_permitted: bool,
    pub publish_permitted: bool,
    pub push_permitted: bool,
    pub forge_share_permitted: bool,
    pub provider_write_permitted: bool,
    pub projection_import_permitted: bool,
    pub task_promotion_permitted: bool,
    pub callback_response_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningCapturePublicationAdmissionStatus {
    Admitted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningCapturePublicationAdmissionBlocker {
    PreparationNotPersisted,
    PreparationPlanNotReady,
    PreparationHasBlockers,
    MissingEvidenceRef,
    MissingApprovalRef,
    AdapterUnsupported,
    AdapterLabelMissing,
    WorkflowLabelMissing,
    UnsafeManagementFileRef,
    NonPlanningManagementFileRef,
    RawPayloadPresent,
    ScmOrSnapshotMutationRequested,
    RemoteShareRequested,
    ForgeMutationRequested,
    ProviderWriteRequested,
    ProjectionImportRequested,
    TaskPromotionRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}

pub fn planning_capture_publication_admission(
    input: PlanningCapturePublicationAdmissionInput,
) -> PlanningCapturePublicationAdmissionSet {
    let target = input.target.clone();
    let approval_ref = input.approval_ref.clone();
    let existing_admission_ids = input.existing_admission_ids.clone();
    let mut admissions = input
        .preparations
        .clone()
        .into_iter()
        .map(|preparation| {
            admission_record(
                &input,
                &target,
                approval_ref.clone(),
                &existing_admission_ids,
                preparation,
            )
        })
        .collect::<Vec<_>>();
    admissions.sort_by(|left, right| left.admission_id.cmp(&right.admission_id));

    PlanningCapturePublicationAdmissionSet {
        admission_set_id: "planning-capture-publication-admission".to_owned(),
        skipped_preparation_ids: admissions
            .iter()
            .filter(|record| record.status != PlanningCapturePublicationAdmissionStatus::Admitted)
            .map(|record| record.preparation_id.clone())
            .collect(),
        stopped_request_admitted_count: admissions
            .iter()
            .filter(|record| record.stopped_request_admitted)
            .count(),
        admissions,
        commit_permitted: false,
        snapshot_permitted: false,
        publish_permitted: false,
        push_permitted: false,
        forge_share_permitted: false,
        provider_write_permitted: false,
        projection_import_permitted: false,
        task_promotion_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_payload_retained: false,
    }
}

fn admission_record(
    input: &PlanningCapturePublicationAdmissionInput,
    target: &PlanningCapturePublicationTarget,
    approval_ref: Option<String>,
    existing_admission_ids: &[String],
    preparation: CompletionScmCapturePreparationPersistenceRecord,
) -> PlanningCapturePublicationAdmissionRecord {
    let admission_id = format!(
        "planning-capture-publication-admission:{}:{}",
        operation_slug(&target.operation),
        preparation.persisted_preparation_id
    );
    let duplicate_admission_detected = existing_admission_ids.contains(&admission_id);
    let blockers = if duplicate_admission_detected {
        Vec::new()
    } else {
        blockers(input, target, approval_ref.as_deref(), &preparation)
    };
    let status = if duplicate_admission_detected {
        PlanningCapturePublicationAdmissionStatus::DuplicateNoop
    } else if blockers.is_empty() {
        PlanningCapturePublicationAdmissionStatus::Admitted
    } else {
        PlanningCapturePublicationAdmissionStatus::Blocked
    };
    let stopped_request_admitted = status == PlanningCapturePublicationAdmissionStatus::Admitted;

    PlanningCapturePublicationAdmissionRecord {
        admission_id,
        preparation_id: preparation.persisted_preparation_id,
        plan_item_id: preparation.plan_item_id,
        task_id: preparation.task_id,
        work_item_id: preparation.work_item_id,
        completion_id: preparation.completion_id,
        operator_ref: preparation.operator_ref,
        approval_ref,
        evidence_refs: unique_sorted(preparation.evidence_refs),
        adapter_family: target.adapter_family.clone(),
        operation: target.operation.clone(),
        adapter_label: target.adapter_label.clone(),
        workflow_label: target.workflow_label.clone(),
        management_file_refs: unique_sorted(target.management_file_refs.clone()),
        status,
        blockers,
        duplicate_admission_detected,
        stopped_request_admitted,
        commit_permitted: false,
        snapshot_permitted: false,
        publish_permitted: false,
        push_permitted: false,
        forge_share_permitted: false,
        provider_write_permitted: false,
        projection_import_permitted: false,
        task_promotion_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_payload_retained: false,
    }
}

fn blockers(
    input: &PlanningCapturePublicationAdmissionInput,
    target: &PlanningCapturePublicationTarget,
    approval_ref: Option<&str>,
    preparation: &CompletionScmCapturePreparationPersistenceRecord,
) -> Vec<PlanningCapturePublicationAdmissionBlocker> {
    let mut blockers = Vec::new();
    if preparation.status != CompletionScmCapturePreparationPersistenceStatus::Persisted {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::PreparationNotPersisted);
    }
    if preparation.plan_status != CompletionScmCapturePlanStatus::Ready {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::PreparationPlanNotReady);
    }
    if !preparation.plan_blockers.is_empty() || !preparation.blockers.is_empty() {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::PreparationHasBlockers);
    }
    if preparation
        .evidence_refs
        .iter()
        .all(|value| value.trim().is_empty())
    {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::MissingEvidenceRef);
    }
    if approval_ref.is_none_or(|value| value.trim().is_empty()) {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::MissingApprovalRef);
    }
    if !target.adapter_supported {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::AdapterUnsupported);
    }
    if target.adapter_label.trim().is_empty() {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::AdapterLabelMissing);
    }
    if target.workflow_label.trim().is_empty() {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::WorkflowLabelMissing);
    }
    for file_ref in &target.management_file_refs {
        if !is_safe_relative_ref(file_ref) {
            blockers.push(PlanningCapturePublicationAdmissionBlocker::UnsafeManagementFileRef);
        } else if !is_planning_management_ref(file_ref) {
            blockers.push(PlanningCapturePublicationAdmissionBlocker::NonPlanningManagementFileRef);
        }
    }
    if input.raw_payload_present {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::RawPayloadPresent);
    }
    if input.scm_or_snapshot_mutation_requested {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::ScmOrSnapshotMutationRequested);
    }
    if input.remote_share_requested {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::RemoteShareRequested);
    }
    if input.forge_mutation_requested {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::ForgeMutationRequested);
    }
    if input.provider_write_requested {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::ProviderWriteRequested);
    }
    if input.projection_import_requested {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::ProjectionImportRequested);
    }
    if input.task_promotion_requested {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::TaskPromotionRequested);
    }
    if input.callback_response_requested {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(PlanningCapturePublicationAdmissionBlocker::RecoveryRequested);
    }
    blockers
}

fn is_safe_relative_ref(value: &str) -> bool {
    !value.starts_with('/')
        && !value.contains('\\')
        && !value
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
}

fn is_planning_management_ref(value: &str) -> bool {
    value.starts_with("nucleus/planning/")
}

fn operation_slug(operation: &PlanningCapturePublicationOperation) -> String {
    match operation {
        PlanningCapturePublicationOperation::Commit => "commit".to_owned(),
        PlanningCapturePublicationOperation::Snapshot => "snapshot".to_owned(),
        PlanningCapturePublicationOperation::Publish => "publish".to_owned(),
        PlanningCapturePublicationOperation::Push => "push".to_owned(),
        PlanningCapturePublicationOperation::ForgeShare => "forge-share".to_owned(),
        PlanningCapturePublicationOperation::ManualShare => "manual-share".to_owned(),
        PlanningCapturePublicationOperation::Custom(value) => {
            format!("custom-{}", value.trim().replace([':', '/', ' '], "-"))
        }
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
#[path = "provider_planning_capture_publication_admission/tests.rs"]
mod tests;
