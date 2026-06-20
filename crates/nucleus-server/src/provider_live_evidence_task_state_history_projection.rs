//! Task history projection for admitted live evidence task-state transitions.

use serde::{Deserialize, Serialize};

use crate::{
    LiveEvidenceTaskStateTransitionAdmissionRecord, LiveEvidenceTaskStateTransitionAdmissionStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceTaskStateHistoryProjectionInput {
    pub admissions: Vec<LiveEvidenceTaskStateTransitionAdmissionRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceTaskStateHistoryProjectionRecord {
    pub projection_id: String,
    pub entries: Vec<LiveEvidenceTaskStateHistoryEntry>,
    pub skipped_admission_ids: Vec<String>,
    pub provider_authority_granted: bool,
    pub scm_authority_granted: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceTaskStateHistoryEntry {
    pub history_entry_id: String,
    pub admission_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub completion_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub task_state: String,
}

pub fn live_evidence_task_state_history_projection(
    input: LiveEvidenceTaskStateHistoryProjectionInput,
) -> LiveEvidenceTaskStateHistoryProjectionRecord {
    let mut entries = Vec::new();
    let mut skipped_admission_ids = Vec::new();

    for admission in input.admissions {
        if admission.status == LiveEvidenceTaskStateTransitionAdmissionStatus::Admitted
            && admission.task_state_transition_admitted
        {
            entries.push(history_entry(admission));
        } else {
            skipped_admission_ids.push(admission.admission_id);
        }
    }

    entries.sort_by(|left, right| left.history_entry_id.cmp(&right.history_entry_id));
    skipped_admission_ids.sort();

    LiveEvidenceTaskStateHistoryProjectionRecord {
        projection_id: "live-evidence-task-state-history-projection".to_owned(),
        entries,
        skipped_admission_ids,
        provider_authority_granted: false,
        scm_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn history_entry(
    admission: LiveEvidenceTaskStateTransitionAdmissionRecord,
) -> LiveEvidenceTaskStateHistoryEntry {
    LiveEvidenceTaskStateHistoryEntry {
        history_entry_id: format!(
            "task-history:live-evidence-completion:{}:{}",
            admission.task_id, admission.completion_id
        ),
        admission_id: admission.admission_id,
        task_id: admission.task_id,
        work_item_id: admission.work_item_id,
        completion_id: admission.completion_id,
        operator_ref: admission.operator_ref,
        evidence_refs: admission.evidence_refs,
        task_state: "completed".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LiveEvidenceTaskStateTransitionAdmissionBlocker;

    #[test]
    fn live_evidence_task_state_history_projection_projects_admitted_transition() {
        let projection = live_evidence_task_state_history_projection(
            LiveEvidenceTaskStateHistoryProjectionInput {
                admissions: vec![admission(
                    "admission:1",
                    LiveEvidenceTaskStateTransitionAdmissionStatus::Admitted,
                    true,
                )],
            },
        );

        assert_eq!(projection.entries.len(), 1);
        assert_eq!(projection.entries[0].task_state, "completed");
        assert!(!projection.provider_authority_granted);
        assert!(!projection.scm_authority_granted);
    }

    #[test]
    fn live_evidence_task_state_history_projection_skips_blocked_transitions() {
        let projection = live_evidence_task_state_history_projection(
            LiveEvidenceTaskStateHistoryProjectionInput {
                admissions: vec![admission(
                    "admission:blocked",
                    LiveEvidenceTaskStateTransitionAdmissionStatus::Blocked,
                    false,
                )],
            },
        );

        assert!(projection.entries.is_empty());
        assert_eq!(
            projection.skipped_admission_ids,
            vec!["admission:blocked".to_owned()]
        );
    }

    fn admission(
        admission_id: &str,
        status: LiveEvidenceTaskStateTransitionAdmissionStatus,
        task_state_transition_admitted: bool,
    ) -> LiveEvidenceTaskStateTransitionAdmissionRecord {
        LiveEvidenceTaskStateTransitionAdmissionRecord {
            admission_id: admission_id.to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            completion_id: "completion:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:task-state".to_owned()],
            status,
            blockers: Vec::<LiveEvidenceTaskStateTransitionAdmissionBlocker>::new(),
            task_state_transition_admitted,
            provider_authority_granted: false,
            callback_authority_granted: false,
            interruption_authority_granted: false,
            recovery_authority_granted: false,
            scm_authority_granted: false,
            raw_material_retained: false,
        }
    }
}
