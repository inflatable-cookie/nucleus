//! Server read model for explicit live evidence completion projections.

use serde::{Deserialize, Serialize};

use crate::{
    live_evidence_completion_progress_projection, live_evidence_completion_read_model_diagnostics,
    live_evidence_completion_timeline_projection, LiveEvidenceCompletionProgressProjectionInput,
    LiveEvidenceCompletionProgressProjectionRecord,
    LiveEvidenceCompletionReadModelDiagnosticsInput,
    LiveEvidenceCompletionReadModelDiagnosticsRecord,
    LiveEvidenceCompletionTimelineProjectionInput, LiveEvidenceCompletionTimelineProjectionRecord,
    LiveEvidenceTaskCompletionRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceCompletionReadModelInput {
    pub completions: Vec<LiveEvidenceTaskCompletionRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceCompletionReadModelRecord {
    pub read_model_id: String,
    pub source_completion_count: usize,
    pub timeline: LiveEvidenceCompletionTimelineProjectionRecord,
    pub progress: LiveEvidenceCompletionProgressProjectionRecord,
    pub diagnostics: LiveEvidenceCompletionReadModelDiagnosticsRecord,
    pub client_mutation_authority: bool,
    pub provider_authority_granted: bool,
    pub scm_authority_granted: bool,
    pub raw_provider_material_exposed: bool,
}

pub fn live_evidence_completion_read_model(
    input: LiveEvidenceCompletionReadModelInput,
) -> LiveEvidenceCompletionReadModelRecord {
    let source_completion_count = input.completions.len();
    let timeline = live_evidence_completion_timeline_projection(
        LiveEvidenceCompletionTimelineProjectionInput {
            completions: input.completions.clone(),
        },
    );
    let progress = live_evidence_completion_progress_projection(
        LiveEvidenceCompletionProgressProjectionInput {
            completions: input.completions,
        },
    );
    let diagnostics = live_evidence_completion_read_model_diagnostics(
        LiveEvidenceCompletionReadModelDiagnosticsInput {
            timeline: timeline.clone(),
            progress: progress.clone(),
        },
    );

    LiveEvidenceCompletionReadModelRecord {
        read_model_id: "live-evidence-completion-read-model".to_owned(),
        source_completion_count,
        timeline,
        progress,
        diagnostics,
        client_mutation_authority: false,
        provider_authority_granted: false,
        scm_authority_granted: false,
        raw_provider_material_exposed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        LiveEvidenceTaskCompletionPersistenceBlocker, LiveEvidenceTaskCompletionPersistenceStatus,
    };

    #[test]
    fn live_evidence_completion_read_model_composes_projection_state() {
        let read_model =
            live_evidence_completion_read_model(LiveEvidenceCompletionReadModelInput {
                completions: vec![
                    completion(
                        "completion:complete",
                        LiveEvidenceTaskCompletionPersistenceStatus::Persisted,
                        true,
                        vec!["evidence:completion".to_owned()],
                    ),
                    completion(
                        "completion:blocked",
                        LiveEvidenceTaskCompletionPersistenceStatus::Blocked,
                        false,
                        vec!["evidence:completion".to_owned()],
                    ),
                    completion(
                        "completion:repair",
                        LiveEvidenceTaskCompletionPersistenceStatus::Persisted,
                        true,
                        Vec::new(),
                    ),
                ],
            });

        assert_eq!(read_model.source_completion_count, 3);
        assert_eq!(read_model.timeline.entries.len(), 2);
        assert_eq!(read_model.progress.completed_work_items.len(), 1);
        assert_eq!(read_model.progress.repair_required_completion_ids.len(), 1);
        assert_eq!(read_model.diagnostics.completed_work_item_count, 1);
        assert!(!read_model.client_mutation_authority);
    }

    fn completion(
        completion_id: &str,
        status: LiveEvidenceTaskCompletionPersistenceStatus,
        task_completed: bool,
        evidence_refs: Vec<String>,
    ) -> LiveEvidenceTaskCompletionRecord {
        LiveEvidenceTaskCompletionRecord {
            completion_id: completion_id.to_owned(),
            admission_id: "completion-admission:1".to_owned(),
            review_decision_id: "review-decision:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs,
            status,
            blockers: Vec::<LiveEvidenceTaskCompletionPersistenceBlocker>::new(),
            duplicate_completion_detected: false,
            task_completed,
            provider_write_permitted: false,
            callback_response_permitted: false,
            cancellation_permitted: false,
            resume_permitted: false,
            scm_mutation_permitted: false,
            raw_provider_material_retained: false,
            raw_stream_retained: false,
        }
    }
}
