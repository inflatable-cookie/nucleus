//! Timeline projection for explicit live evidence task completions.

use serde::{Deserialize, Serialize};

use crate::{LiveEvidenceTaskCompletionPersistenceStatus, LiveEvidenceTaskCompletionRecord};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceCompletionTimelineProjectionInput {
    pub completions: Vec<LiveEvidenceTaskCompletionRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceCompletionTimelineProjectionRecord {
    pub projection_id: String,
    pub entries: Vec<LiveEvidenceCompletionTimelineEntry>,
    pub skipped_completion_ids: Vec<String>,
    pub provider_authority_granted: bool,
    pub scm_authority_granted: bool,
    pub client_mutation_authority: bool,
    pub raw_provider_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceCompletionTimelineEntry {
    pub timeline_entry_id: String,
    pub completion_id: String,
    pub admission_id: String,
    pub review_decision_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub task_completed: bool,
}

pub fn live_evidence_completion_timeline_projection(
    input: LiveEvidenceCompletionTimelineProjectionInput,
) -> LiveEvidenceCompletionTimelineProjectionRecord {
    let mut entries = Vec::new();
    let mut skipped_completion_ids = Vec::new();

    for completion in input.completions {
        if completion.status == LiveEvidenceTaskCompletionPersistenceStatus::Persisted
            && completion.task_completed
        {
            entries.push(timeline_entry(completion));
        } else {
            skipped_completion_ids.push(completion.completion_id);
        }
    }

    entries.sort_by(|left, right| left.timeline_entry_id.cmp(&right.timeline_entry_id));
    skipped_completion_ids.sort();

    LiveEvidenceCompletionTimelineProjectionRecord {
        projection_id: "live-evidence-completion-timeline-projection".to_owned(),
        entries,
        skipped_completion_ids,
        provider_authority_granted: false,
        scm_authority_granted: false,
        client_mutation_authority: false,
        raw_provider_material_exposed: false,
    }
}

fn timeline_entry(
    completion: LiveEvidenceTaskCompletionRecord,
) -> LiveEvidenceCompletionTimelineEntry {
    LiveEvidenceCompletionTimelineEntry {
        timeline_entry_id: format!(
            "task-timeline:live-evidence-completion:{}:{}",
            completion.task_id, completion.completion_id
        ),
        completion_id: completion.completion_id,
        admission_id: completion.admission_id,
        review_decision_id: completion.review_decision_id,
        task_id: completion.task_id,
        work_item_id: completion.work_item_id,
        operator_ref: completion.operator_ref,
        evidence_refs: completion.evidence_refs,
        task_completed: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LiveEvidenceTaskCompletionPersistenceBlocker;

    #[test]
    fn live_evidence_completion_timeline_projection_creates_deterministic_entry() {
        let projection = live_evidence_completion_timeline_projection(
            LiveEvidenceCompletionTimelineProjectionInput {
                completions: vec![completion(
                    "completion:2",
                    LiveEvidenceTaskCompletionPersistenceStatus::Persisted,
                    true,
                )],
            },
        );

        assert_eq!(projection.entries.len(), 1);
        assert_eq!(
            projection.entries[0].timeline_entry_id,
            "task-timeline:live-evidence-completion:task:1:completion:2"
        );
        assert!(projection.entries[0].task_completed);
        assert!(!projection.provider_authority_granted);
        assert!(!projection.client_mutation_authority);
    }

    #[test]
    fn live_evidence_completion_timeline_projection_skips_blocked_and_duplicate_completions() {
        let projection = live_evidence_completion_timeline_projection(
            LiveEvidenceCompletionTimelineProjectionInput {
                completions: vec![
                    completion(
                        "completion:blocked",
                        LiveEvidenceTaskCompletionPersistenceStatus::Blocked,
                        false,
                    ),
                    completion(
                        "completion:duplicate",
                        LiveEvidenceTaskCompletionPersistenceStatus::DuplicateNoop,
                        false,
                    ),
                ],
            },
        );

        assert!(projection.entries.is_empty());
        assert_eq!(
            projection.skipped_completion_ids,
            vec![
                "completion:blocked".to_owned(),
                "completion:duplicate".to_owned()
            ]
        );
    }

    fn completion(
        completion_id: &str,
        status: LiveEvidenceTaskCompletionPersistenceStatus,
        task_completed: bool,
    ) -> LiveEvidenceTaskCompletionRecord {
        LiveEvidenceTaskCompletionRecord {
            completion_id: completion_id.to_owned(),
            admission_id: "completion-admission:1".to_owned(),
            review_decision_id: "review-decision:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:completion".to_owned()],
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
