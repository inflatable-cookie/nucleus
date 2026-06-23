use nucleus_local_store::LocalStoreBackend;

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{
    ProviderLiveReadSmokeEvidenceQuery, ServerControlError, ServerQueryResult,
};
use crate::query_provider_live_read_smoke_evidence_diagnostics;

pub(super) fn provider_live_read_smoke_evidence_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: ProviderLiveReadSmokeEvidenceQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    match query {
        ProviderLiveReadSmokeEvidenceQuery::Diagnostics => {
            query_provider_live_read_smoke_evidence_diagnostics(handler.state())
                .map(ServerQueryResult::ProviderLiveReadSmokeEvidenceDiagnostics)
                .map_err(storage_error)
        }
    }
}
