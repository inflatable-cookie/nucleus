use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_local_store::{LocalStoreBackend, LocalStoreResult, RevisionExpectation};

use crate::runtime_receipt_state::write_runtime_receipt;
use crate::state::ServerStateService;

mod receipts;
mod storage;
mod types;
mod validation;

pub use types::{
    PlanningProjectionImportMinimumApplyProofBlocker,
    PlanningProjectionImportMinimumApplyProofReceipt,
    PlanningProjectionImportMinimumApplyProofRequest,
    PlanningProjectionImportMinimumApplyProofStatus,
};

use receipts::{proof_receipt, runtime_receipt};
use storage::planning_artifact_record;
use validation::{single_operation, validate_document, validate_executor_plan, validate_target};

pub fn apply_minimum_planning_projection_import_proof<B>(
    state: &ServerStateService<B>,
    request: PlanningProjectionImportMinimumApplyProofRequest,
) -> LocalStoreResult<PlanningProjectionImportMinimumApplyProofReceipt>
where
    B: LocalStoreBackend,
{
    let mut blockers = Vec::new();
    let operation = single_operation(&request.executor_plan, &mut blockers);
    let previous_revision_id =
        operation.and_then(|operation| operation.observed_current_revision.clone());

    validate_executor_plan(&request, operation, &mut blockers);
    validate_document(&request, operation, &mut blockers);

    let existing = match operation {
        Some(operation) => state
            .planning()
            .get(&PersistenceRecordId(operation.record_id.clone()))?,
        None => None,
    };
    validate_target(existing.as_ref(), operation, &mut blockers);

    let mut receipt = proof_receipt(
        &request,
        operation,
        previous_revision_id,
        blockers,
        PlanningProjectionImportMinimumApplyProofStatus::Blocked,
    );

    if !receipt.blockers.is_empty() {
        write_proof_receipt(state, &receipt)?;
        return Ok(receipt);
    }

    let operation = operation.expect("validated operation exists");
    let record = planning_artifact_record(&request, operation)?;
    state.planning().put(
        record,
        RevisionExpectation::Exact(RevisionId(
            operation
                .expected_current_revision
                .clone()
                .expect("validated revision expectation"),
        )),
    )?;

    receipt.status = PlanningProjectionImportMinimumApplyProofStatus::Applied;
    receipt.active_planning_mutation_performed = true;
    write_proof_receipt(state, &receipt)?;
    Ok(receipt)
}

fn write_proof_receipt<B>(
    state: &ServerStateService<B>,
    receipt: &PlanningProjectionImportMinimumApplyProofReceipt,
) -> LocalStoreResult<()>
where
    B: LocalStoreBackend,
{
    write_runtime_receipt(
        state,
        &runtime_receipt(receipt),
        RevisionId(format!("rev:{}", receipt.receipt_id)),
        RevisionExpectation::Any,
    )
    .map(|_| ())
}
