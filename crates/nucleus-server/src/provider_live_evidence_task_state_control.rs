//! Control integration records for live evidence task-state transitions.

use serde::{Deserialize, Serialize};

use crate::{
    live_evidence_task_state_history_projection, live_evidence_task_state_transition_admission,
    LiveEvidenceCompletionReadModelRecord, LiveEvidenceTaskStateHistoryProjectionInput,
    LiveEvidenceTaskStateHistoryProjectionRecord, LiveEvidenceTaskStateTransitionAdmissionInput,
    LiveEvidenceTaskStateTransitionAdmissionRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceTaskStateControlRequest {
    pub request_id: String,
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
pub struct LiveEvidenceTaskStateControlRecord {
    pub control_id: String,
    pub request_id: String,
    pub admission: LiveEvidenceTaskStateTransitionAdmissionRecord,
    pub history: LiveEvidenceTaskStateHistoryProjectionRecord,
    pub task_state_mutation_requested: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub scm_authority_granted: bool,
    pub raw_material_exposed: bool,
}

pub fn live_evidence_task_state_control(
    read_model: LiveEvidenceCompletionReadModelRecord,
    request: LiveEvidenceTaskStateControlRequest,
) -> LiveEvidenceTaskStateControlRecord {
    let admission = live_evidence_task_state_transition_admission(
        LiveEvidenceTaskStateTransitionAdmissionInput {
            read_model,
            task_id: request.task_id,
            work_item_id: request.work_item_id,
            completion_id: request.completion_id,
            operator_ref: request.operator_ref,
            evidence_refs: request.evidence_refs,
            provider_write_requested: request.provider_write_requested,
            callback_response_requested: request.callback_response_requested,
            interruption_requested: request.interruption_requested,
            recovery_requested: request.recovery_requested,
            scm_mutation_requested: request.scm_mutation_requested,
            raw_material_requested: request.raw_material_requested,
        },
    );
    let history =
        live_evidence_task_state_history_projection(LiveEvidenceTaskStateHistoryProjectionInput {
            admissions: vec![admission.clone()],
        });

    LiveEvidenceTaskStateControlRecord {
        control_id: format!("live-evidence-task-state-control:{}", request.request_id),
        request_id: request.request_id,
        admission,
        history,
        task_state_mutation_requested: true,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        scm_authority_granted: false,
        raw_material_exposed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_evidence_task_state_control_vocabulary_names_explicit_transition_refs() {
        let request = request("completion:1");

        assert_eq!(request.task_id, "task:1");
        assert_eq!(request.work_item_id, "work:1");
        assert_eq!(request.completion_id, "completion:1");
        assert!(!request.provider_write_requested);
        assert!(!request.scm_mutation_requested);
    }

    #[test]
    fn live_evidence_task_state_handler_admission_composes_admitted_history_response() {
        let record = live_evidence_task_state_control(read_model(), request("completion:1"));

        assert!(record.admission.task_state_transition_admitted);
        assert_eq!(record.history.entries.len(), 1);
        assert_eq!(record.history.entries[0].task_state, "completed");
        assert!(!record.provider_authority_granted);
    }

    #[test]
    fn live_evidence_task_state_history_response_skips_blocked_admission() {
        let record = live_evidence_task_state_control(read_model(), request("completion:missing"));

        assert!(!record.admission.task_state_transition_admitted);
        assert!(record.history.entries.is_empty());
        assert_eq!(record.history.skipped_admission_ids.len(), 1);
    }

    #[test]
    fn live_evidence_task_state_control_authority_blocks_external_effects() {
        let mut request = request("completion:1");
        request.provider_write_requested = true;
        request.callback_response_requested = true;
        request.interruption_requested = true;
        request.recovery_requested = true;
        request.scm_mutation_requested = true;
        request.raw_material_requested = true;

        let record = live_evidence_task_state_control(read_model(), request);

        assert!(!record.admission.task_state_transition_admitted);
        assert!(!record.provider_authority_granted);
        assert!(!record.callback_authority_granted);
        assert!(!record.interruption_authority_granted);
        assert!(!record.recovery_authority_granted);
        assert!(!record.scm_authority_granted);
        assert!(!record.raw_material_exposed);
    }

    fn request(completion_id: &str) -> LiveEvidenceTaskStateControlRequest {
        LiveEvidenceTaskStateControlRequest {
            request_id: "request:task-state".to_owned(),
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
            source_completion_count: 1,
            timeline: crate::LiveEvidenceCompletionTimelineProjectionRecord {
                projection_id: "timeline".to_owned(),
                entries: Vec::new(),
                skipped_completion_ids: Vec::new(),
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
                skipped_completion_ids: Vec::new(),
                repair_required_completion_ids: Vec::new(),
                client_mutation_authority: false,
                provider_authority_granted: false,
                scm_authority_granted: false,
                raw_provider_material_exposed: false,
            },
            diagnostics: crate::LiveEvidenceCompletionReadModelDiagnosticsRecord {
                diagnostics_id: "diagnostics:1".to_owned(),
                timeline_entry_count: 0,
                timeline_skipped_completion_count: 0,
                completed_work_item_count: 1,
                progress_skipped_completion_count: 0,
                repair_required_completion_count: 0,
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
