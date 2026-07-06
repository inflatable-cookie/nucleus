use nucleus_core::PersistenceRecordKind;
use nucleus_local_store::LocalStoreBackend;
use nucleus_memory::{
    decode_accepted_memory_storage_record, decode_memory_proposal_storage_record,
};

use crate::accepted_memory_projection::{AcceptedMemoryProjection, AcceptedMemoryProjectionRecord};
use crate::control_api::{ProductWorkflowSummaryQuery, ServerControlError};
use crate::memory_proposals_projection::MemoryProposalsProjection;
use crate::request_handler::queries::storage_error;
use crate::request_handler::LocalControlRequestHandler;
use crate::research_run_briefs_projection::ResearchRunBriefsProjection;

#[derive(Debug, Default, Eq, PartialEq)]
pub(super) struct ProductWorkflowContextRefs {
    pub(super) memory_proposal_refs: Vec<String>,
    pub(super) accepted_memory_refs: Vec<String>,
    pub(super) research_run_refs: Vec<String>,
}

pub(super) fn context_refs<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &ProductWorkflowSummaryQuery,
) -> Result<ProductWorkflowContextRefs, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let memory = memory_refs(handler, query)?;
    let research = research_refs(handler, query)?;

    Ok(ProductWorkflowContextRefs {
        memory_proposal_refs: memory.memory_proposal_refs,
        accepted_memory_refs: memory.accepted_memory_refs,
        research_run_refs: research,
    })
}

#[derive(Debug, Default, Eq, PartialEq)]
struct MemoryRefs {
    memory_proposal_refs: Vec<String>,
    accepted_memory_refs: Vec<String>,
}

fn memory_refs<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &ProductWorkflowSummaryQuery,
) -> Result<MemoryRefs, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut proposals = Vec::new();
    let mut accepted_records = Vec::new();

    for record in handler
        .state()
        .shared_memory()
        .list()
        .map_err(storage_error)?
    {
        if record.kind != PersistenceRecordKind::SharedMemoryRecord {
            continue;
        }

        if let Ok(proposal) = decode_memory_proposal_storage_record(&record.payload.bytes) {
            proposals.push(proposal);
            continue;
        }
        if let Ok(accepted) = decode_accepted_memory_storage_record(&record.payload.bytes) {
            accepted_records.push(AcceptedMemoryProjectionRecord::Accepted(accepted));
            continue;
        }

        return Err(ServerControlError::StorageUnavailable {
            reason: format!("memory context decode failed for {}", record.id.0),
        });
    }

    let proposals =
        MemoryProposalsProjection::from_storage_records(query.project_id.clone(), proposals);
    let accepted = AcceptedMemoryProjection::from_projection_records(
        query.project_id.clone(),
        accepted_records,
    );

    Ok(MemoryRefs {
        memory_proposal_refs: proposals
            .proposals
            .into_iter()
            .map(|proposal| proposal.proposal_id)
            .collect(),
        accepted_memory_refs: accepted
            .memories
            .into_iter()
            .map(|memory| memory.memory_id)
            .collect(),
    })
}

fn research_refs<B>(
    handler: &LocalControlRequestHandler<B>,
    query: &ProductWorkflowSummaryQuery,
) -> Result<Vec<String>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut records = Vec::new();
    for record in handler
        .state()
        .deep_research()
        .list()
        .map_err(storage_error)?
    {
        if record.kind != PersistenceRecordKind::ResearchRun {
            continue;
        }
        records.push(
            nucleus_research::decode_research_run_brief_storage_record(&record.payload.bytes)
                .map_err(|error| ServerControlError::StorageUnavailable {
                    reason: format!("research run brief decode failed: {}", error.reason),
                })?,
        );
    }

    Ok(
        ResearchRunBriefsProjection::from_storage_records(query.project_id.clone(), records)
            .runs
            .into_iter()
            .map(|run| run.run_id)
            .collect(),
    )
}
