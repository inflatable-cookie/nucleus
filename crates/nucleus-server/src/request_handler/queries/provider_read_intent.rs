use nucleus_local_store::LocalStoreBackend;

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{ProviderReadIntentQuery, ServerControlError, ServerQueryResult};
use crate::query_forge_read_intent_projection;

pub(super) fn provider_read_intent_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: ProviderReadIntentQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    match query {
        ProviderReadIntentQuery::Projection => query_forge_read_intent_projection(handler.state())
            .map(ServerQueryResult::ProviderReadIntent)
            .map_err(storage_error),
    }
}
