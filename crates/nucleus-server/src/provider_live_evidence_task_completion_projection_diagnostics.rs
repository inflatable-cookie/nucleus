//! Read-only diagnostics for live evidence completion projections.

use serde::{Deserialize, Serialize};

use crate::{
    LiveEvidenceCompletionProgressProjectionRecord, LiveEvidenceCompletionTimelineProjectionRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceCompletionReadModelDiagnosticsInput {
    pub timeline: LiveEvidenceCompletionTimelineProjectionRecord,
    pub progress: LiveEvidenceCompletionProgressProjectionRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceCompletionReadModelDiagnosticsRecord {
    pub diagnostics_id: String,
    pub timeline_entry_count: usize,
    pub timeline_skipped_completion_count: usize,
    pub completed_work_item_count: usize,
    pub progress_skipped_completion_count: usize,
    pub repair_required_completion_count: usize,
    pub client_mutation_authority: bool,
    pub provider_authority_granted: bool,
    pub scm_authority_granted: bool,
    pub raw_provider_material_exposed: bool,
}

pub fn live_evidence_completion_read_model_diagnostics(
    input: LiveEvidenceCompletionReadModelDiagnosticsInput,
) -> LiveEvidenceCompletionReadModelDiagnosticsRecord {
    LiveEvidenceCompletionReadModelDiagnosticsRecord {
        diagnostics_id: "live-evidence-completion-read-model-diagnostics".to_owned(),
        timeline_entry_count: input.timeline.entries.len(),
        timeline_skipped_completion_count: input.timeline.skipped_completion_ids.len(),
        completed_work_item_count: input.progress.completed_work_items.len(),
        progress_skipped_completion_count: input.progress.skipped_completion_ids.len(),
        repair_required_completion_count: input.progress.repair_required_completion_ids.len(),
        client_mutation_authority: false,
        provider_authority_granted: false,
        scm_authority_granted: false,
        raw_provider_material_exposed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_evidence_completion_read_model_diagnostics_summarize_projection_state() {
        let diagnostics = live_evidence_completion_read_model_diagnostics(input(1, 2, 1, 1, 1));

        assert_eq!(diagnostics.timeline_entry_count, 1);
        assert_eq!(diagnostics.timeline_skipped_completion_count, 2);
        assert_eq!(diagnostics.completed_work_item_count, 1);
        assert_eq!(diagnostics.progress_skipped_completion_count, 1);
        assert_eq!(diagnostics.repair_required_completion_count, 1);
        assert!(!diagnostics.client_mutation_authority);
        assert!(!diagnostics.raw_provider_material_exposed);
    }

    fn input(
        timeline_entries: usize,
        timeline_skipped: usize,
        completed_work_items: usize,
        progress_skipped: usize,
        repair_required: usize,
    ) -> LiveEvidenceCompletionReadModelDiagnosticsInput {
        LiveEvidenceCompletionReadModelDiagnosticsInput {
            timeline: LiveEvidenceCompletionTimelineProjectionRecord {
                projection_id: "timeline".to_owned(),
                entries: (0..timeline_entries)
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
                skipped_completion_ids: (0..timeline_skipped)
                    .map(|index| format!("timeline-skipped:{index}"))
                    .collect(),
                provider_authority_granted: false,
                scm_authority_granted: false,
                client_mutation_authority: false,
                raw_provider_material_exposed: false,
            },
            progress: LiveEvidenceCompletionProgressProjectionRecord {
                projection_id: "progress".to_owned(),
                completed_work_items: (0..completed_work_items)
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
                skipped_completion_ids: (0..progress_skipped)
                    .map(|index| format!("progress-skipped:{index}"))
                    .collect(),
                repair_required_completion_ids: (0..repair_required)
                    .map(|index| format!("repair:{index}"))
                    .collect(),
                client_mutation_authority: false,
                provider_authority_granted: false,
                scm_authority_granted: false,
                raw_provider_material_exposed: false,
            },
        }
    }
}
