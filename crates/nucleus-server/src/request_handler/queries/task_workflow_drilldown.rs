use nucleus_local_store::LocalStoreBackend;

use super::LocalControlRequestHandler;
use crate::control_api::{ServerControlError, ServerQueryResult, TaskWorkflowDrilldownQuery};
use crate::{task_workflow_drilldown, TaskWorkflowDrilldownInput};

mod next;
mod scm;
mod sources;
use next::{next_step, task_input};
use scm::selected_scm_handoff_refs;
use sources::{
    selected_readiness, selected_review_refs, selected_runtime_refs, selected_task,
    selected_task_completion_refs, selected_timeline_refs, selected_work_progress,
};

pub(crate) fn task_workflow_drilldown_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: TaskWorkflowDrilldownQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() || query.task_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "task workflow drilldown requires project and task ids".to_owned(),
        });
    }

    let task = selected_task(handler, &query)?;
    let input = if let Some(task) = task {
        let readiness = selected_readiness(handler, &query)?;
        let work_progress = selected_work_progress(handler, &query)?;
        let work_receipt_refs = work_progress
            .iter()
            .flat_map(|item| item.receipt_refs.iter().cloned())
            .collect::<Vec<_>>();
        let timeline_entry_refs = selected_timeline_refs(handler, &query, &work_progress)?;
        let (runtime_receipt_refs, command_evidence_refs) =
            selected_runtime_refs(handler, &work_receipt_refs)?;
        let task_completion_refs = selected_task_completion_refs(handler, &query)?;
        let review_refs = selected_review_refs(handler, &query, &work_progress)?;
        let scm_handoff_refs = selected_scm_handoff_refs(handler, &query)?;
        let next_step = next_step(
            &query,
            readiness.as_ref(),
            &runtime_receipt_refs,
            &task_completion_refs,
            &review_refs,
            &scm_handoff_refs,
        );

        TaskWorkflowDrilldownInput {
            project_id: query.project_id,
            task_id: query.task_id,
            task: Some(task_input(&task)),
            readiness,
            timeline_entry_refs,
            work_progress,
            runtime_receipt_refs,
            command_evidence_refs,
            task_completion_refs,
            review_refs,
            scm_handoff_refs,
            next_step,
        }
    } else {
        TaskWorkflowDrilldownInput {
            project_id: query.project_id,
            task_id: query.task_id,
            task: None,
            readiness: None,
            timeline_entry_refs: Vec::new(),
            work_progress: Vec::new(),
            runtime_receipt_refs: Vec::new(),
            command_evidence_refs: Vec::new(),
            task_completion_refs: Vec::new(),
            review_refs: Vec::new(),
            scm_handoff_refs: Vec::new(),
            next_step: None,
        }
    };

    Ok(ServerQueryResult::TaskWorkflowDrilldown(
        task_workflow_drilldown(input),
    ))
}

#[cfg(test)]
mod tests;
