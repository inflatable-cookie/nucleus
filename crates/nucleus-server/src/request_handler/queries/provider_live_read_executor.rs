use nucleus_local_store::LocalStoreBackend;

use super::LocalControlRequestHandler;
use crate::control_api::{ProviderLiveReadExecutorQuery, ServerControlError, ServerQueryResult};
use crate::query_provider_live_read_executor_diagnostics;

pub(super) fn provider_live_read_executor_query<B>(
    _handler: &LocalControlRequestHandler<B>,
    query: ProviderLiveReadExecutorQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    match query {
        ProviderLiveReadExecutorQuery::Diagnostics => {
            Ok(ServerQueryResult::ProviderLiveReadExecutorDiagnostics(
                query_provider_live_read_executor_diagnostics(),
            ))
        }
    }
}
