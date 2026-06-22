use nucleus_local_store::LocalStoreBackend;

use super::LocalControlRequestHandler;
use crate::control_api::{
    ProviderLiveReadSmokeEvidenceQuery, ServerControlError, ServerQueryResult,
};
use crate::query_provider_live_read_smoke_evidence_diagnostics;

pub(super) fn provider_live_read_smoke_evidence_query<B>(
    _handler: &LocalControlRequestHandler<B>,
    query: ProviderLiveReadSmokeEvidenceQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    match query {
        ProviderLiveReadSmokeEvidenceQuery::Diagnostics => {
            Ok(ServerQueryResult::ProviderLiveReadSmokeEvidenceDiagnostics(
                query_provider_live_read_smoke_evidence_diagnostics(),
            ))
        }
    }
}
