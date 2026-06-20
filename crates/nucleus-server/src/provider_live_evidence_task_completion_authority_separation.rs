//! Authority separation proof for live evidence completion projections.

use serde::{Deserialize, Serialize};

use crate::{
    LiveEvidenceCompletionProgressProjectionRecord, LiveEvidenceCompletionTimelineProjectionRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceCompletionAuthoritySeparationInput {
    pub timeline: LiveEvidenceCompletionTimelineProjectionRecord,
    pub progress: LiveEvidenceCompletionProgressProjectionRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceCompletionAuthoritySeparationRecord {
    pub separation_id: String,
    pub timeline_entry_count: usize,
    pub completed_work_item_count: usize,
    pub scm_capture_started: bool,
    pub change_request_started: bool,
    pub provider_write_started: bool,
    pub callback_response_started: bool,
    pub interruption_started: bool,
    pub recovery_started: bool,
    pub client_mutation_authority: bool,
    pub future_scm_lane: String,
}

pub fn live_evidence_completion_authority_separation(
    input: LiveEvidenceCompletionAuthoritySeparationInput,
) -> LiveEvidenceCompletionAuthoritySeparationRecord {
    LiveEvidenceCompletionAuthoritySeparationRecord {
        separation_id: "live-evidence-completion-authority-separation".to_owned(),
        timeline_entry_count: input.timeline.entries.len(),
        completed_work_item_count: input.progress.completed_work_items.len(),
        scm_capture_started: false,
        change_request_started: false,
        provider_write_started: false,
        callback_response_started: false,
        interruption_started: false,
        recovery_started: false,
        client_mutation_authority: false,
        future_scm_lane: "completion-to-scm-change-request-promotion".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_evidence_completion_authority_separation_does_not_start_scm_or_provider_work() {
        let record = live_evidence_completion_authority_separation(input(1, 1));

        assert_eq!(record.timeline_entry_count, 1);
        assert_eq!(record.completed_work_item_count, 1);
        assert!(!record.scm_capture_started);
        assert!(!record.change_request_started);
        assert!(!record.provider_write_started);
        assert!(!record.callback_response_started);
        assert!(!record.interruption_started);
        assert!(!record.recovery_started);
        assert!(!record.client_mutation_authority);
    }

    fn input(
        timeline_entry_count: usize,
        completed_work_item_count: usize,
    ) -> LiveEvidenceCompletionAuthoritySeparationInput {
        LiveEvidenceCompletionAuthoritySeparationInput {
            timeline: LiveEvidenceCompletionTimelineProjectionRecord {
                projection_id: "timeline".to_owned(),
                entries: (0..timeline_entry_count)
                    .map(|index| crate::LiveEvidenceCompletionTimelineEntry {
                        timeline_entry_id: format!("timeline:{index}"),
                        completion_id: format!("completion:{index}"),
                        admission_id: format!("admission:{index}"),
                        review_decision_id: format!("review:{index}"),
                        task_id: "task:1".to_owned(),
                        work_item_id: format!("work:{index}"),
                        operator_ref: "operator:tom".to_owned(),
                        evidence_refs: vec!["evidence:completion".to_owned()],
                        task_completed: true,
                    })
                    .collect(),
                skipped_completion_ids: Vec::new(),
                provider_authority_granted: false,
                scm_authority_granted: false,
                client_mutation_authority: false,
                raw_provider_material_exposed: false,
            },
            progress: LiveEvidenceCompletionProgressProjectionRecord {
                projection_id: "progress".to_owned(),
                completed_work_items: (0..completed_work_item_count)
                    .map(|index| crate::LiveEvidenceCompletedWorkItemRecord {
                        task_id: "task:1".to_owned(),
                        work_item_id: format!("work:{index}"),
                        completion_id: format!("completion:{index}"),
                        review_decision_id: format!("review:{index}"),
                        operator_ref: "operator:tom".to_owned(),
                        evidence_refs: vec!["evidence:completion".to_owned()],
                        completed: true,
                    })
                    .collect(),
                skipped_completion_ids: Vec::new(),
                repair_required_completion_ids: Vec::new(),
                client_mutation_authority: false,
                provider_authority_granted: false,
                scm_authority_granted: false,
                raw_provider_material_exposed: false,
            },
        }
    }
}
