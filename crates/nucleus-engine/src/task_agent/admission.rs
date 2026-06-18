use nucleus_core::RevisionId;

use super::types::{
    EngineTaskAgentWorkUnitAdmissionRecord, EngineTaskAgentWorkUnitReviewStatus,
    EngineTaskAgentWorkUnitRuntimeStatus, EngineTaskAgentWorkUnitSourceCursor,
    EngineTaskAgentWorkUnitSourceId, EngineTaskAgentWorkUnitSourceRecord,
};
use crate::{
    EngineTaskWorkItemAssignment, EngineTaskWorkItemId, EngineTaskWorkItemRecord,
    EngineTaskWorkItemRefs, EngineTaskWorkItemReviewState, EngineTaskWorkItemRuntimeState,
};

/// Create a source admission record from an already validated task work item.
pub fn admit_task_agent_work_unit(
    command_id: &str,
    actor_ref: &str,
    idempotency_key: &str,
    task_revision: Option<RevisionId>,
    work_item: &EngineTaskWorkItemRecord,
) -> EngineTaskAgentWorkUnitAdmissionRecord {
    let (adapter_id, provider_instance_id) = match &work_item.assignment {
        EngineTaskWorkItemAssignment::AdapterInstance {
            adapter_id,
            provider_instance_id,
        } => (adapter_id.clone(), provider_instance_id.clone()),
        _ => (String::new(), String::new()),
    };
    let source_id = EngineTaskAgentWorkUnitSourceId(format!(
        "task-agent-source:{}:{}",
        work_item.work_item_id.0, idempotency_key
    ));

    EngineTaskAgentWorkUnitAdmissionRecord {
        source_record: EngineTaskAgentWorkUnitSourceRecord {
            source_cursor: EngineTaskAgentWorkUnitSourceCursor(source_id.0.clone()),
            source_id,
            work_item_id: EngineTaskWorkItemId(work_item.work_item_id.0.clone()),
            project_id: work_item.project_id.clone(),
            task_id: work_item.task_id.clone(),
            command_id: command_id.to_owned(),
            actor_ref: actor_ref.to_owned(),
            adapter_id,
            provider_instance_id,
            idempotency_key: idempotency_key.to_owned(),
            task_revision,
            runtime: runtime_status_from_work_item(&work_item.runtime),
            review: review_status_from_work_item(&work_item.review),
            refs: EngineTaskWorkItemRefs {
                session_id: work_item.refs.session_id.clone(),
                turn_ids: work_item.refs.turn_ids.clone(),
                receipt_ids: work_item.refs.receipt_ids.clone(),
                checkpoint_ids: work_item.refs.checkpoint_ids.clone(),
                diff_summary_ids: work_item.refs.diff_summary_ids.clone(),
                timeline_entry_ids: work_item.refs.timeline_entry_ids.clone(),
                validation_refs: work_item.refs.validation_refs.clone(),
                artifact_refs: work_item.refs.artifact_refs.clone(),
            },
            previous_source_id: None,
            summary: format!(
                "task work unit admitted by command {command_id}; provider execution deferred"
            ),
        },
        provider_execution_deferred: true,
    }
}

fn runtime_status_from_work_item(
    state: &EngineTaskWorkItemRuntimeState,
) -> EngineTaskAgentWorkUnitRuntimeStatus {
    match state {
        EngineTaskWorkItemRuntimeState::Draft => EngineTaskAgentWorkUnitRuntimeStatus::Draft,
        EngineTaskWorkItemRuntimeState::Ready => EngineTaskAgentWorkUnitRuntimeStatus::Ready,
        EngineTaskWorkItemRuntimeState::Scheduled => {
            EngineTaskAgentWorkUnitRuntimeStatus::Scheduled
        }
        EngineTaskWorkItemRuntimeState::Running => EngineTaskAgentWorkUnitRuntimeStatus::Running,
        EngineTaskWorkItemRuntimeState::WaitingForApproval => {
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval
        }
        EngineTaskWorkItemRuntimeState::WaitingForUserInput => {
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForUserInput
        }
        EngineTaskWorkItemRuntimeState::Completed => {
            EngineTaskAgentWorkUnitRuntimeStatus::Completed
        }
        EngineTaskWorkItemRuntimeState::Cancelled => {
            EngineTaskAgentWorkUnitRuntimeStatus::Cancelled
        }
        EngineTaskWorkItemRuntimeState::Failed(reason) => {
            EngineTaskAgentWorkUnitRuntimeStatus::Failed(reason.clone())
        }
        EngineTaskWorkItemRuntimeState::RecoveryRequired(reason) => {
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(reason.clone())
        }
    }
}

fn review_status_from_work_item(
    state: &EngineTaskWorkItemReviewState,
) -> EngineTaskAgentWorkUnitReviewStatus {
    match state {
        EngineTaskWorkItemReviewState::NotReady => EngineTaskAgentWorkUnitReviewStatus::NotReady,
        EngineTaskWorkItemReviewState::AwaitingReview => {
            EngineTaskAgentWorkUnitReviewStatus::AwaitingReview
        }
        EngineTaskWorkItemReviewState::Accepted => EngineTaskAgentWorkUnitReviewStatus::Accepted,
        EngineTaskWorkItemReviewState::Rejected(reason) => {
            EngineTaskAgentWorkUnitReviewStatus::Rejected(reason.clone())
        }
        EngineTaskWorkItemReviewState::NeedsChanges(reason) => {
            EngineTaskAgentWorkUnitReviewStatus::NeedsChanges(reason.clone())
        }
        EngineTaskWorkItemReviewState::Abandoned(reason) => {
            EngineTaskAgentWorkUnitReviewStatus::Abandoned(reason.clone())
        }
    }
}
