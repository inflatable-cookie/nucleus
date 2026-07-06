use std::collections::HashSet;

use nucleus_command_policy::{
    command_evidence_from_storage_record, decode_command_evidence_storage_record,
};
use nucleus_core::PersistenceRecordKind;
use nucleus_local_store::LocalStoreBackend;

use crate::control_api::ServerControlError;
use crate::request_handler::queries::storage_error;
use crate::request_handler::LocalControlRequestHandler;
use crate::runtime_receipt_state::read_runtime_receipts;
use crate::{
    read_live_evidence_review_decisions, read_live_evidence_task_completions,
    ProductWorkflowTaskCandidateInput,
};

#[derive(Debug, Default, Eq, PartialEq)]
pub(super) struct ProductWorkflowRuntimeReviewRefs {
    pub(super) runtime_evidence_refs: Vec<String>,
    pub(super) command_evidence_refs: Vec<String>,
    pub(super) review_refs: Vec<String>,
}

pub(super) fn runtime_review_refs<B>(
    handler: &LocalControlRequestHandler<B>,
    task_candidates: &[ProductWorkflowTaskCandidateInput],
) -> Result<ProductWorkflowRuntimeReviewRefs, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let task_ids = task_candidates
        .iter()
        .map(|candidate| candidate.task_ref.as_str())
        .collect::<HashSet<_>>();

    let mut runtime_evidence_refs = runtime_receipt_refs(handler)?;
    runtime_evidence_refs.extend(task_completion_refs(handler, &task_ids)?);
    runtime_evidence_refs.sort();
    runtime_evidence_refs.dedup();

    Ok(ProductWorkflowRuntimeReviewRefs {
        runtime_evidence_refs,
        command_evidence_refs: command_evidence_refs(handler)?,
        review_refs: review_refs(handler, &task_ids)?,
    })
}

fn runtime_receipt_refs<B>(
    handler: &LocalControlRequestHandler<B>,
) -> Result<Vec<String>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    Ok(read_runtime_receipts(handler.state())
        .map_err(storage_error)?
        .into_iter()
        .map(|receipt| receipt.receipt_id.0)
        .collect())
}

fn command_evidence_refs<B>(
    handler: &LocalControlRequestHandler<B>,
) -> Result<Vec<String>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut refs = Vec::new();
    for record in handler
        .state()
        .command_evidence()
        .list()
        .map_err(storage_error)?
    {
        if record.kind != PersistenceRecordKind::CommandEvidence {
            continue;
        }
        let decoded =
            decode_command_evidence_storage_record(&record.payload.bytes).map_err(|error| {
                ServerControlError::StorageUnavailable {
                    reason: format!("command evidence decode failed: {}", error.reason),
                }
            })?;
        refs.push(command_evidence_from_storage_record(&decoded).id.0);
    }
    refs.sort();
    refs.dedup();
    Ok(refs)
}

fn task_completion_refs<B>(
    handler: &LocalControlRequestHandler<B>,
    task_ids: &HashSet<&str>,
) -> Result<Vec<String>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    Ok(read_live_evidence_task_completions(handler.state())
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| task_ids.contains(record.task_id.as_str()))
        .map(|record| record.completion_id)
        .collect())
}

fn review_refs<B>(
    handler: &LocalControlRequestHandler<B>,
    task_ids: &HashSet<&str>,
) -> Result<Vec<String>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    Ok(read_live_evidence_review_decisions(handler.state())
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| task_ids.contains(record.task_id.as_str()))
        .map(|record| record.decision_id)
        .collect())
}
