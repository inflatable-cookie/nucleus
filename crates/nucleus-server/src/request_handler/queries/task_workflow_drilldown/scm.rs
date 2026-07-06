use nucleus_local_store::LocalStoreBackend;

use crate::control_api::{ServerControlError, TaskWorkflowDrilldownQuery};
use crate::request_handler::queries::storage_error;
use crate::request_handler::LocalControlRequestHandler;

pub(super) fn selected_scm_handoff_refs<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &TaskWorkflowDrilldownQuery,
) -> Result<Vec<String>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let task_id = query.task_id.0.as_str();
    let mut refs = Vec::new();
    refs.extend(
        crate::read_completion_scm_capture_admissions(handler.state())
            .map_err(storage_error)?
            .into_iter()
            .filter(|record| record.task_id == task_id)
            .map(|record| record.persisted_admission_id),
    );
    refs.extend(
        crate::read_completion_scm_capture_preparations(handler.state())
            .map_err(storage_error)?
            .into_iter()
            .filter(|record| record.task_id == task_id)
            .map(|record| record.persisted_preparation_id),
    );
    refs.extend(
        crate::read_scm_capture_dry_run_plans(handler.state())
            .map_err(storage_error)?
            .into_iter()
            .filter(|record| record.task_id == task_id)
            .map(|record| record.persisted_dry_run_plan_id),
    );
    refs.extend(
        crate::read_scm_capture_dry_run_execution_receipts(handler.state())
            .map_err(storage_error)?
            .into_iter()
            .filter(|record| record.task_id == task_id)
            .map(|record| record.persisted_execution_receipt_id),
    );
    refs.extend(
        crate::read_scm_capture_review_decisions(handler.state())
            .map_err(storage_error)?
            .into_iter()
            .filter(|record| record.task_id == task_id)
            .flat_map(|record| [record.readiness_id, record.decision_id]),
    );
    refs.extend(
        crate::read_scm_change_request_prep_records(handler.state())
            .map_err(storage_error)?
            .into_iter()
            .filter(|record| record.task_id == task_id)
            .map(|record| record.persisted_preparation_id),
    );
    Ok(refs)
}
