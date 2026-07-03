use nucleus_core::PersistenceRecordId;
use nucleus_local_store::LocalStoreBackend;

use super::{read_state_records, storage_error, LocalControlRequestHandler};
use crate::checkpoint_diff_state::{read_checkpoint_records, read_diff_summary_records};
use crate::control_api::{
    RuntimeMetadataQuery, ServerControlError, ServerQueryResult, StateRecordQueryScope,
};
use crate::runtime_readiness_diagnostics::local_host_runtime_readiness_diagnostics;
use crate::runtime_receipt_state::read_runtime_receipts;
use crate::task_agent_work_unit_state::read_task_agent_work_unit_source_records;
use crate::{task_agent_diagnostics, unsupported_local_host_runtime_discovery, EngineHostId};

pub(super) fn runtime_metadata_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: RuntimeMetadataQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    match query {
        RuntimeMetadataQuery::GetStoredEffect(record_id) => read_state_records(
            handler.state.runtime_effects(),
            StateRecordQueryScope::Get(PersistenceRecordId(record_id.0)),
        )
        .map(ServerQueryResult::RuntimeMetadata),
        RuntimeMetadataQuery::ListCommandEvidence => read_state_records(
            handler.state.command_evidence(),
            StateRecordQueryScope::List,
        )
        .map(ServerQueryResult::RuntimeMetadata),
        RuntimeMetadataQuery::ListRuntimeReceipts => read_runtime_receipts(handler.state())
            .map(ServerQueryResult::RuntimeReceipts)
            .map_err(storage_error),
        RuntimeMetadataQuery::ListCheckpointRecords => read_checkpoint_records(handler.state())
            .map(ServerQueryResult::CheckpointRecords)
            .map_err(storage_error),
        RuntimeMetadataQuery::ListDiffSummaryRecords => read_diff_summary_records(handler.state())
            .map(ServerQueryResult::DiffSummaryRecords)
            .map_err(storage_error),
        RuntimeMetadataQuery::ListTaskWorkProgress => {
            let records =
                read_task_agent_work_unit_source_records(handler.state()).map_err(storage_error)?;
            Ok(ServerQueryResult::TaskWorkProgress(
                task_agent_diagnostics(&records).work_units,
            ))
        }
        RuntimeMetadataQuery::ListArtifactMetadata => read_state_records(
            handler.state.artifact_metadata(),
            StateRecordQueryScope::List,
        )
        .map(ServerQueryResult::RuntimeMetadata),
        RuntimeMetadataQuery::GetLocalRuntimeReadiness => {
            let discovery =
                unsupported_local_host_runtime_discovery(EngineHostId("host:local".to_owned()));
            Ok(ServerQueryResult::RuntimeReadiness(vec![
                local_host_runtime_readiness_diagnostics(&discovery),
            ]))
        }
        RuntimeMetadataQuery::StoredEffects(_) | RuntimeMetadataQuery::ResolveRuntimeRef(_) => {
            Ok(ServerQueryResult::Unsupported {
                reason: "runtime metadata ref queries are not implemented".to_owned(),
            })
        }
    }
}
