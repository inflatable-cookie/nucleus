//! Progress projection for explicit live evidence task completions.

use serde::{Deserialize, Serialize};

use crate::{LiveEvidenceTaskCompletionPersistenceStatus, LiveEvidenceTaskCompletionRecord};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceCompletionProgressProjectionInput {
    pub completions: Vec<LiveEvidenceTaskCompletionRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceCompletionProgressProjectionRecord {
    pub projection_id: String,
    pub completed_work_items: Vec<LiveEvidenceCompletedWorkItemRecord>,
    pub skipped_completion_ids: Vec<String>,
    pub repair_required_completion_ids: Vec<String>,
    pub client_mutation_authority: bool,
    pub provider_authority_granted: bool,
    pub scm_authority_granted: bool,
    pub raw_provider_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceCompletedWorkItemRecord {
    pub task_id: String,
    pub work_item_id: String,
    pub completion_id: String,
    pub review_decision_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub completed: bool,
}

pub fn live_evidence_completion_progress_projection(
    input: LiveEvidenceCompletionProgressProjectionInput,
) -> LiveEvidenceCompletionProgressProjectionRecord {
    let mut completed_work_items = Vec::new();
    let mut skipped_completion_ids = Vec::new();
    let mut repair_required_completion_ids = Vec::new();

    for completion in input.completions {
        if completion.status != LiveEvidenceTaskCompletionPersistenceStatus::Persisted
            || !completion.task_completed
        {
            skipped_completion_ids.push(completion.completion_id);
        } else if completion.evidence_refs.is_empty() {
            repair_required_completion_ids.push(completion.completion_id);
        } else {
            completed_work_items.push(completed_work_item(completion));
        }
    }

    completed_work_items.sort_by(|left, right| {
        left.task_id
            .cmp(&right.task_id)
            .then(left.work_item_id.cmp(&right.work_item_id))
            .then(left.completion_id.cmp(&right.completion_id))
    });
    skipped_completion_ids.sort();
    repair_required_completion_ids.sort();

    LiveEvidenceCompletionProgressProjectionRecord {
        projection_id: "live-evidence-completion-progress-projection".to_owned(),
        completed_work_items,
        skipped_completion_ids,
        repair_required_completion_ids,
        client_mutation_authority: false,
        provider_authority_granted: false,
        scm_authority_granted: false,
        raw_provider_material_exposed: false,
    }
}

fn completed_work_item(
    completion: LiveEvidenceTaskCompletionRecord,
) -> LiveEvidenceCompletedWorkItemRecord {
    LiveEvidenceCompletedWorkItemRecord {
        task_id: completion.task_id,
        work_item_id: completion.work_item_id,
        completion_id: completion.completion_id,
        review_decision_id: completion.review_decision_id,
        operator_ref: completion.operator_ref,
        evidence_refs: completion.evidence_refs,
        completed: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LiveEvidenceTaskCompletionPersistenceBlocker;

    #[test]
    fn live_evidence_completion_progress_projection_marks_persisted_completion_complete() {
        let projection = live_evidence_completion_progress_projection(
            LiveEvidenceCompletionProgressProjectionInput {
                completions: vec![completion(
                    "completion:1",
                    LiveEvidenceTaskCompletionPersistenceStatus::Persisted,
                    true,
                    vec!["evidence:completion".to_owned()],
                )],
            },
        );

        assert_eq!(projection.completed_work_items.len(), 1);
        assert!(projection.completed_work_items[0].completed);
        assert!(!projection.client_mutation_authority);
    }

    #[test]
    fn live_evidence_completion_progress_projection_skips_blocked_and_duplicate_completions() {
        let projection = live_evidence_completion_progress_projection(
            LiveEvidenceCompletionProgressProjectionInput {
                completions: vec![
                    completion(
                        "completion:blocked",
                        LiveEvidenceTaskCompletionPersistenceStatus::Blocked,
                        false,
                        vec!["evidence:completion".to_owned()],
                    ),
                    completion(
                        "completion:duplicate",
                        LiveEvidenceTaskCompletionPersistenceStatus::DuplicateNoop,
                        false,
                        vec!["evidence:completion".to_owned()],
                    ),
                ],
            },
        );

        assert!(projection.completed_work_items.is_empty());
        assert_eq!(projection.skipped_completion_ids.len(), 2);
    }

    #[test]
    fn live_evidence_completion_progress_projection_surfaces_missing_evidence_as_repair() {
        let projection = live_evidence_completion_progress_projection(
            LiveEvidenceCompletionProgressProjectionInput {
                completions: vec![completion(
                    "completion:repair",
                    LiveEvidenceTaskCompletionPersistenceStatus::Persisted,
                    true,
                    Vec::new(),
                )],
            },
        );

        assert!(projection.completed_work_items.is_empty());
        assert_eq!(
            projection.repair_required_completion_ids,
            vec!["completion:repair".to_owned()]
        );
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
