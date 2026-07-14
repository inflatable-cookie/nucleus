use nucleus_local_store::LocalStoreBackend;
use serde::Serialize;

use crate::{
    selected_task_review_decision_records::read_selected_task_review_decisions,
    SelectedTaskReviewDecisionOutcome, SelectedTaskReviewDecisionPersistenceStatus,
    SelectedTaskReviewDecisionRecord, ServerStateService,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(super) struct TaskReviewContext {
    pub decision_ref: String,
    pub outcome: SelectedTaskReviewDecisionOutcome,
    pub reason: Option<String>,
    pub reviewed_work_item_refs: Vec<String>,
    pub reviewed_evidence_refs: Vec<String>,
    pub rework_ready: bool,
}

pub(super) fn current_task_review_context<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    task_id: &str,
) -> Result<Option<TaskReviewContext>, String>
where
    B: LocalStoreBackend,
{
    let records = read_selected_task_review_decisions(state)
        .map_err(|error| format!("task review context read failed: {error:?}"))?;
    Ok(current_context(records, project_id, task_id))
}

fn current_context(
    records: Vec<SelectedTaskReviewDecisionRecord>,
    project_id: &str,
    task_id: &str,
) -> Option<TaskReviewContext> {
    records
        .into_iter()
        .filter(|record| {
            record.project_id == project_id
                && record.task_id == task_id
                && record.status == SelectedTaskReviewDecisionPersistenceStatus::Persisted
                && record.blockers.is_empty()
        })
        .max_by(|left, right| left.decision_id.cmp(&right.decision_id))
        .map(|record| TaskReviewContext {
            decision_ref: record.decision_id,
            outcome: record.outcome,
            reason: record.reason_summary,
            reviewed_work_item_refs: record.work_item_refs,
            reviewed_evidence_refs: record.reviewed_evidence_refs,
            rework_ready: matches!(
                record.outcome,
                SelectedTaskReviewDecisionOutcome::Rejected
                    | SelectedTaskReviewDecisionOutcome::NeedsChanges
            ),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SelectedTaskReviewDecisionAction, SelectedTaskReviewDecisionPersistenceBlocker};

    #[test]
    fn selects_current_matching_persisted_review_with_rework_provenance() {
        let context = current_context(
            vec![
                record(
                    "decision:1",
                    "task:other",
                    SelectedTaskReviewDecisionOutcome::Accepted,
                ),
                record(
                    "decision:2",
                    "task:1",
                    SelectedTaskReviewDecisionOutcome::NeedsChanges,
                ),
            ],
            "project:1",
            "task:1",
        )
        .expect("review context");

        assert_eq!(context.decision_ref, "decision:2");
        assert_eq!(context.reason.as_deref(), Some("Fix the validation."));
        assert_eq!(context.reviewed_work_item_refs, vec!["work:1"]);
        assert_eq!(context.reviewed_evidence_refs, vec!["diff:1"]);
        assert!(context.rework_ready);
    }

    fn record(
        decision_id: &str,
        task_id: &str,
        outcome: SelectedTaskReviewDecisionOutcome,
    ) -> SelectedTaskReviewDecisionRecord {
        SelectedTaskReviewDecisionRecord {
            decision_id: decision_id.to_owned(),
            admission_id: format!("admission:{decision_id}"),
            project_id: "project:1".to_owned(),
            task_id: task_id.to_owned(),
            work_item_refs: vec!["work:1".to_owned()],
            action: SelectedTaskReviewDecisionAction::RequestChanges,
            outcome,
            operator_ref: "operator:1".to_owned(),
            expected_revision: "revision:1".to_owned(),
            reviewed_evidence_refs: vec!["diff:1".to_owned()],
            receipt_refs: Vec::new(),
            timeline_refs: Vec::new(),
            reason_summary: Some("Fix the validation.".to_owned()),
            idempotency_key: "review:1".to_owned(),
            status: SelectedTaskReviewDecisionPersistenceStatus::Persisted,
            blockers: Vec::<SelectedTaskReviewDecisionPersistenceBlocker>::new(),
            duplicate_decision_detected: false,
            review_mutation_performed: false,
            task_lifecycle_mutation_performed: false,
            provider_execution_performed: false,
            provider_write_performed: false,
            scm_or_forge_mutation_performed: false,
            accepted_memory_apply_performed: false,
            planning_apply_performed: false,
            projection_write_performed: false,
            agent_scheduling_performed: false,
            ui_effect_performed: false,
            raw_provider_material_retained: false,
            raw_command_output_retained: false,
        }
    }
}
