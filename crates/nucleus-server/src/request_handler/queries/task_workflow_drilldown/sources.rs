use std::collections::HashSet;

use nucleus_engine::{
    EngineRuntimeReceiptRef, EngineTaskReadinessInput, EngineTaskReadinessProjection,
};
use nucleus_local_store::LocalStoreBackend;
use nucleus_orchestration::{OrchestrationEventRecord, OrchestrationEventStoreRepository};
use nucleus_tasks::{decode_task_storage_record, task_from_storage_record, Task};

use super::next::readiness_label;
use crate::control_api::{ServerControlError, TaskWorkflowDrilldownQuery};
use crate::diagnostics_read_models::{task_agent_diagnostics, TaskAgentWorkUnitDiagnosticDto};
use crate::request_handler::event_store::ServerOrchestrationEventStore;
use crate::request_handler::queries::storage_error;
use crate::request_handler::LocalControlRequestHandler;
use crate::runtime_receipt_state::read_runtime_receipts;
use crate::task_agent_work_unit_state::read_task_agent_work_unit_source_records;
use crate::TaskWorkflowReadinessInput;
use crate::TaskWorkflowWorkProgressInput;
use crate::{read_live_evidence_review_decisions, read_live_evidence_task_completions};

pub(super) fn selected_task<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &TaskWorkflowDrilldownQuery,
) -> Result<Option<Task>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    for record in handler.state().tasks().list().map_err(storage_error)? {
        let storage_record =
            decode_task_storage_record(&record.payload.bytes).map_err(|error| {
                ServerControlError::StorageUnavailable {
                    reason: format!("task record decode failed: {}", error.reason),
                }
            })?;
        let task = task_from_storage_record(&storage_record);
        if task.id == query.task_id && task.project_id == query.project_id {
            return Ok(Some(task));
        }
    }
    Ok(None)
}

pub(super) fn selected_readiness<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &TaskWorkflowDrilldownQuery,
) -> Result<Option<TaskWorkflowReadinessInput>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut tasks = Vec::new();
    for record in handler.state().tasks().list().map_err(storage_error)? {
        let storage_record =
            decode_task_storage_record(&record.payload.bytes).map_err(|error| {
                ServerControlError::StorageUnavailable {
                    reason: format!("task record decode failed: {}", error.reason),
                }
            })?;
        tasks.push(EngineTaskReadinessInput::from(&task_from_storage_record(
            &storage_record,
        )));
    }

    Ok(
        EngineTaskReadinessProjection::from_tasks(query.project_id.clone(), tasks)
            .candidates
            .into_iter()
            .find(|candidate| candidate.task_id == query.task_id)
            .map(|candidate| TaskWorkflowReadinessInput {
                lane: readiness_label(&candidate.readiness).to_owned(),
                rationale_refs: candidate
                    .blocker_refs
                    .into_iter()
                    .chain(candidate.evidence_refs)
                    .chain(candidate.validation_commands)
                    .collect(),
            }),
    )
}

pub(super) fn selected_timeline_refs<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &TaskWorkflowDrilldownQuery,
    work_progress: &[TaskWorkflowWorkProgressInput],
) -> Result<Vec<String>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let events = ServerOrchestrationEventStore::new(handler.state())
        .list_events()
        .map_err(storage_error)?
        .into_iter()
        .map(|event_store_record| event_store_record.into_payload())
        .collect::<Vec<OrchestrationEventRecord>>();
    let projection =
        nucleus_engine::EngineTaskTimelineProjection::rebuild(query.task_id.clone(), &events);
    let mut refs = projection
        .entries
        .into_iter()
        .map(|entry| entry.entry_id.0)
        .collect::<Vec<_>>();
    refs.extend(
        work_progress
            .iter()
            .flat_map(|item| item.timeline_entry_refs.iter().cloned()),
    );
    Ok(refs)
}

pub(super) fn selected_work_progress<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &TaskWorkflowDrilldownQuery,
) -> Result<Vec<TaskWorkflowWorkProgressInput>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let records =
        read_task_agent_work_unit_source_records(handler.state()).map_err(storage_error)?;
    Ok(task_agent_diagnostics(&records)
        .work_units
        .into_iter()
        .filter(|work| work.project_id == query.project_id.0 && work.task_id == query.task_id.0)
        .map(work_progress_input)
        .collect())
}

pub(super) fn selected_runtime_refs<B>(
    handler: &LocalControlRequestHandler<B>,
    work_receipt_refs: &[String],
) -> Result<(Vec<String>, Vec<String>), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let selected_receipts = work_receipt_refs
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut runtime_refs = Vec::new();
    let mut command_evidence_refs = Vec::new();

    for receipt in read_runtime_receipts(handler.state()).map_err(storage_error)? {
        if !selected_receipts.contains(receipt.receipt_id.0.as_str()) {
            continue;
        }
        runtime_refs.push(receipt.receipt_id.0);
        command_evidence_refs.extend(receipt.evidence_refs.into_iter().filter_map(|reference| {
            match reference {
                EngineRuntimeReceiptRef::CommandEvidenceId(id) => Some(id),
                _ => None,
            }
        }));
    }

    Ok((runtime_refs, command_evidence_refs))
}

pub(super) fn selected_task_completion_refs<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &TaskWorkflowDrilldownQuery,
) -> Result<Vec<String>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    Ok(read_live_evidence_task_completions(handler.state())
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.task_id == query.task_id.0)
        .map(|record| record.completion_id)
        .collect())
}

pub(super) fn selected_review_refs<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &TaskWorkflowDrilldownQuery,
    work_progress: &[TaskWorkflowWorkProgressInput],
) -> Result<Vec<String>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut refs = read_live_evidence_review_decisions(handler.state())
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.task_id == query.task_id.0)
        .map(|record| record.decision_id)
        .collect::<Vec<_>>();
    refs.extend(
        work_progress
            .iter()
            .filter(|work| work.review_status != "not_ready")
            .map(|work| format!("{}:review:{}", work.work_item_ref, work.review_status)),
    );
    Ok(refs)
}

fn work_progress_input(work: TaskAgentWorkUnitDiagnosticDto) -> TaskWorkflowWorkProgressInput {
    TaskWorkflowWorkProgressInput {
        work_item_ref: work.work_item_id.clone(),
        runtime_status: work.runtime,
        review_status: work.review,
        source_ref: work.last_source_id,
        source_count: work.source_count,
        session_ref: work.session_id,
        turn_refs: work.turn_ids,
        receipt_refs: work.receipt_ids,
        checkpoint_refs: work.checkpoint_ids,
        diff_summary_refs: work.diff_summary_ids,
        timeline_entry_refs: work.timeline_entry_ids,
        validation_refs: work.validation_refs,
        artifact_refs: work.artifact_refs,
        issue_refs: work
            .issues
            .into_iter()
            .map(|issue| format!("{}:{}:{}", work.work_item_id, "issue", issue.code))
            .collect(),
    }
}
