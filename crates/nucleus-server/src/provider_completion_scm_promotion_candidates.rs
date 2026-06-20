//! Promotion candidates from completed task-state history to SCM readiness.

use serde::{Deserialize, Serialize};

use crate::LiveEvidenceTaskStateHistoryProjectionRecord;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionScmPromotionCandidatesInput {
    pub history: LiveEvidenceTaskStateHistoryProjectionRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmPromotionCandidatesRecord {
    pub projection_id: String,
    pub candidates: Vec<CompletionScmPromotionCandidate>,
    pub skipped_history_entry_ids: Vec<String>,
    pub scm_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmPromotionCandidate {
    pub candidate_id: String,
    pub history_entry_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub completion_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
}

pub fn completion_scm_promotion_candidates(
    input: CompletionScmPromotionCandidatesInput,
) -> CompletionScmPromotionCandidatesRecord {
    let mut candidates = Vec::new();
    let mut skipped_history_entry_ids = Vec::new();

    for entry in input.history.entries {
        if entry.task_state == "completed" {
            candidates.push(CompletionScmPromotionCandidate {
                candidate_id: format!("completion-scm-promotion:{}", entry.history_entry_id),
                history_entry_id: entry.history_entry_id,
                task_id: entry.task_id,
                work_item_id: entry.work_item_id,
                completion_id: entry.completion_id,
                operator_ref: entry.operator_ref,
                evidence_refs: unique_sorted(entry.evidence_refs),
            });
        } else {
            skipped_history_entry_ids.push(entry.history_entry_id);
        }
    }

    candidates.sort_by(|left, right| left.candidate_id.cmp(&right.candidate_id));
    skipped_history_entry_ids.extend(input.history.skipped_admission_ids);
    skipped_history_entry_ids.sort();
    skipped_history_entry_ids.dedup();

    CompletionScmPromotionCandidatesRecord {
        projection_id: "completion-scm-promotion-candidates".to_owned(),
        candidates,
        skipped_history_entry_ids,
        scm_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
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
    fn completion_scm_promotion_candidates_project_completed_history_entries() {
        let record = completion_scm_promotion_candidates(input("completed"));

        assert_eq!(record.candidates.len(), 1);
        assert_eq!(record.candidates[0].task_id, "task:1");
        assert_eq!(record.candidates[0].work_item_id, "work:1");
        assert_eq!(record.candidates[0].completion_id, "completion:1");
        assert_eq!(
            record.candidates[0].evidence_refs,
            vec!["evidence:a".to_owned(), "evidence:b".to_owned()]
        );
        assert!(!record.scm_authority_granted);
        assert!(!record.forge_authority_granted);
    }

    #[test]
    fn completion_scm_promotion_candidates_skip_non_completed_and_blocked_history() {
        let record = completion_scm_promotion_candidates(input("in_review"));

        assert!(record.candidates.is_empty());
        assert_eq!(
            record.skipped_history_entry_ids,
            vec!["admission:blocked".to_owned(), "history:1".to_owned()]
        );
    }

    fn input(task_state: &str) -> CompletionScmPromotionCandidatesInput {
        CompletionScmPromotionCandidatesInput {
            history: crate::LiveEvidenceTaskStateHistoryProjectionRecord {
                projection_id: "history".to_owned(),
                entries: vec![crate::LiveEvidenceTaskStateHistoryEntry {
                    history_entry_id: "history:1".to_owned(),
                    admission_id: "admission:1".to_owned(),
                    task_id: "task:1".to_owned(),
                    work_item_id: "work:1".to_owned(),
                    completion_id: "completion:1".to_owned(),
                    operator_ref: "operator:tom".to_owned(),
                    evidence_refs: vec![
                        "evidence:b".to_owned(),
                        "evidence:a".to_owned(),
                        "evidence:a".to_owned(),
                    ],
                    task_state: task_state.to_owned(),
                }],
                skipped_admission_ids: vec!["admission:blocked".to_owned()],
                provider_authority_granted: false,
                scm_authority_granted: false,
                raw_material_exposed: false,
            },
        }
    }
}
