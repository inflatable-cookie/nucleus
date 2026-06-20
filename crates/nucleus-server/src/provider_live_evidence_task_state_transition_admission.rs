//! Admission for explicit task-state completion transitions.

use serde::{Deserialize, Serialize};

use crate::LiveEvidenceCompletionReadModelRecord;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceTaskStateTransitionAdmissionInput {
    pub read_model: LiveEvidenceCompletionReadModelRecord,
    pub task_id: String,
    pub work_item_id: String,
    pub completion_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
    pub scm_mutation_requested: bool,
    pub raw_material_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceTaskStateTransitionAdmissionRecord {
    pub admission_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub completion_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub status: LiveEvidenceTaskStateTransitionAdmissionStatus,
    pub blockers: Vec<LiveEvidenceTaskStateTransitionAdmissionBlocker>,
    pub task_state_transition_admitted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub scm_authority_granted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceTaskStateTransitionAdmissionStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceTaskStateTransitionAdmissionBlocker {
    CompletionRefMissing,
    CompletionRefSkipped,
    CompletionRefRepairRequired,
    TaskIdentityMismatch,
    WorkItemIdentityMismatch,
    OperatorRefMissing,
    EvidenceRefsMissing,
    EmptyEvidenceRef,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
    ScmMutationRequested,
    RawMaterialRequested,
}

pub fn live_evidence_task_state_transition_admission(
    input: LiveEvidenceTaskStateTransitionAdmissionInput,
) -> LiveEvidenceTaskStateTransitionAdmissionRecord {
    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        LiveEvidenceTaskStateTransitionAdmissionStatus::Admitted
    } else {
        LiveEvidenceTaskStateTransitionAdmissionStatus::Blocked
    };
    let task_state_transition_admitted =
        status == LiveEvidenceTaskStateTransitionAdmissionStatus::Admitted;

    LiveEvidenceTaskStateTransitionAdmissionRecord {
        admission_id: format!(
            "live-evidence-task-state-transition-admission:{}:{}",
            input.task_id, input.completion_id
        ),
        task_id: input.task_id,
        work_item_id: input.work_item_id,
        completion_id: input.completion_id,
        operator_ref: input.operator_ref,
        evidence_refs: unique_sorted(input.evidence_refs),
        status,
        blockers,
        task_state_transition_admitted,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        scm_authority_granted: false,
        raw_material_retained: false,
    }
}

fn blockers(
    input: &LiveEvidenceTaskStateTransitionAdmissionInput,
) -> Vec<LiveEvidenceTaskStateTransitionAdmissionBlocker> {
    let mut blockers = Vec::new();
    let completion = input
        .read_model
        .progress
        .completed_work_items
        .iter()
        .find(|item| item.completion_id == input.completion_id);

    if completion.is_none() {
        blockers.push(LiveEvidenceTaskStateTransitionAdmissionBlocker::CompletionRefMissing);
    }
    if input
        .read_model
        .progress
        .skipped_completion_ids
        .contains(&input.completion_id)
    {
        blockers.push(LiveEvidenceTaskStateTransitionAdmissionBlocker::CompletionRefSkipped);
    }
    if input
        .read_model
        .progress
        .repair_required_completion_ids
        .contains(&input.completion_id)
    {
        blockers.push(LiveEvidenceTaskStateTransitionAdmissionBlocker::CompletionRefRepairRequired);
    }
    if let Some(completion) = completion {
        if completion.task_id != input.task_id {
            blockers.push(LiveEvidenceTaskStateTransitionAdmissionBlocker::TaskIdentityMismatch);
        }
        if completion.work_item_id != input.work_item_id {
            blockers
                .push(LiveEvidenceTaskStateTransitionAdmissionBlocker::WorkItemIdentityMismatch);
        }
    }
    if input.operator_ref.trim().is_empty() {
        blockers.push(LiveEvidenceTaskStateTransitionAdmissionBlocker::OperatorRefMissing);
    }
    if input.evidence_refs.is_empty() {
        blockers.push(LiveEvidenceTaskStateTransitionAdmissionBlocker::EvidenceRefsMissing);
    }
    if input
        .evidence_refs
        .iter()
        .any(|evidence_ref| evidence_ref.trim().is_empty())
    {
        blockers.push(LiveEvidenceTaskStateTransitionAdmissionBlocker::EmptyEvidenceRef);
    }
    if input.provider_write_requested {
        blockers.push(LiveEvidenceTaskStateTransitionAdmissionBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(LiveEvidenceTaskStateTransitionAdmissionBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(LiveEvidenceTaskStateTransitionAdmissionBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(LiveEvidenceTaskStateTransitionAdmissionBlocker::RecoveryRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(LiveEvidenceTaskStateTransitionAdmissionBlocker::ScmMutationRequested);
    }
    if input.raw_material_requested {
        blockers.push(LiveEvidenceTaskStateTransitionAdmissionBlocker::RawMaterialRequested);
    }
    blockers
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_evidence_task_state_transition_admission_accepts_valid_completion_ref() {
        let record = live_evidence_task_state_transition_admission(input("completion:1"));

        assert_eq!(
            record.status,
            LiveEvidenceTaskStateTransitionAdmissionStatus::Admitted
        );
        assert!(record.task_state_transition_admitted);
        assert!(!record.provider_authority_granted);
        assert!(!record.scm_authority_granted);
    }

    #[test]
    fn live_evidence_task_state_repair_duplicate_blocks_bad_refs() {
        for completion_id in [
            "completion:missing",
            "completion:skipped",
            "completion:repair",
        ] {
            let record = live_evidence_task_state_transition_admission(input(completion_id));
            assert_eq!(
                record.status,
                LiveEvidenceTaskStateTransitionAdmissionStatus::Blocked
            );
            assert!(!record.task_state_transition_admitted);
        }
    }

    #[test]
    fn live_evidence_task_state_authority_blocks_provider_scm_and_raw_requests() {
        let mut input = input("completion:1");
        input.provider_write_requested = true;
        input.callback_response_requested = true;
        input.interruption_requested = true;
        input.recovery_requested = true;
        input.scm_mutation_requested = true;
        input.raw_material_requested = true;

        let record = live_evidence_task_state_transition_admission(input);

        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskStateTransitionAdmissionBlocker::ProviderWriteRequested));
        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskStateTransitionAdmissionBlocker::ScmMutationRequested));
        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskStateTransitionAdmissionBlocker::RawMaterialRequested));
        assert!(!record.provider_authority_granted);
        assert!(!record.raw_material_retained);
    }

    fn input(completion_id: &str) -> LiveEvidenceTaskStateTransitionAdmissionInput {
        LiveEvidenceTaskStateTransitionAdmissionInput {
            read_model: read_model(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            completion_id: completion_id.to_owned(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:task-state".to_owned()],
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            scm_mutation_requested: false,
            raw_material_requested: false,
        }
    }

    fn read_model() -> LiveEvidenceCompletionReadModelRecord {
        crate::LiveEvidenceCompletionReadModelRecord {
            read_model_id: "read-model:1".to_owned(),
            source_completion_count: 3,
            timeline: crate::LiveEvidenceCompletionTimelineProjectionRecord {
                projection_id: "timeline".to_owned(),
                entries: Vec::new(),
                skipped_completion_ids: vec!["completion:skipped".to_owned()],
                provider_authority_granted: false,
                scm_authority_granted: false,
                client_mutation_authority: false,
                raw_provider_material_exposed: false,
            },
            progress: crate::LiveEvidenceCompletionProgressProjectionRecord {
                projection_id: "progress".to_owned(),
                completed_work_items: vec![crate::LiveEvidenceCompletedWorkItemRecord {
                    task_id: "task:1".to_owned(),
                    work_item_id: "work:1".to_owned(),
                    completion_id: "completion:1".to_owned(),
                    review_decision_id: "review:1".to_owned(),
                    operator_ref: "operator:tom".to_owned(),
                    evidence_refs: vec!["evidence:completion".to_owned()],
                    completed: true,
                }],
                skipped_completion_ids: vec!["completion:skipped".to_owned()],
                repair_required_completion_ids: vec!["completion:repair".to_owned()],
                client_mutation_authority: false,
                provider_authority_granted: false,
                scm_authority_granted: false,
                raw_provider_material_exposed: false,
            },
            diagnostics: crate::LiveEvidenceCompletionReadModelDiagnosticsRecord {
                diagnostics_id: "diagnostics:1".to_owned(),
                timeline_entry_count: 0,
                timeline_skipped_completion_count: 1,
                completed_work_item_count: 1,
                progress_skipped_completion_count: 1,
                repair_required_completion_count: 1,
                client_mutation_authority: false,
                provider_authority_granted: false,
                scm_authority_granted: false,
                raw_provider_material_exposed: false,
            },
            client_mutation_authority: false,
            provider_authority_granted: false,
            scm_authority_granted: false,
            raw_provider_material_exposed: false,
        }
    }
}
