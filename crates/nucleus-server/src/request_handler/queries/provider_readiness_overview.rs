use nucleus_local_store::LocalStoreBackend;

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{ProviderReadinessOverviewQuery, ServerControlError, ServerQueryResult};
use crate::query_forge_readiness_overview;

pub(super) fn provider_readiness_overview_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: ProviderReadinessOverviewQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    match query {
        ProviderReadinessOverviewQuery::Overview => query_forge_readiness_overview(handler.state())
            .map(ServerQueryResult::ProviderReadinessOverview)
            .map_err(storage_error),
    }
}
