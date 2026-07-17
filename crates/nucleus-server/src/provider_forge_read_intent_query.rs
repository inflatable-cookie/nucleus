//! Read-only query composition for provider read-intent projections.

use crate::provider_no_effects::ProviderRuntimeNoEffects;
use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

mod types;

pub use types::{
    ForgeReadIntentQueryControlDto, ForgeReadIntentQueryResult, ForgeReadIntentQuerySourceCounts,
};

use crate::{
    forge_read_intent_projection, forge_read_intent_projection_control_dto,
    read_forge_credential_status_refreshes, read_forge_pull_request_refreshes,
    read_forge_repository_metadata_refreshes, read_forge_status_check_refreshes,
    ForgeReadIntentProjectionInput, ServerStateService,
};

pub fn query_forge_read_intent_projection<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<ForgeReadIntentQueryResult>
where
    B: LocalStoreBackend,
{
    let credential_status_records = read_forge_credential_status_refreshes(state)?;
    let repository_metadata_records = read_forge_repository_metadata_refreshes(state)?;
    let pull_request_records = read_forge_pull_request_refreshes(state)?;
    let status_check_records = read_forge_status_check_refreshes(state)?;
    let source_counts = ForgeReadIntentQuerySourceCounts {
        credential_status_records: credential_status_records.len(),
        repository_metadata_records: repository_metadata_records.len(),
        pull_request_records: pull_request_records.len(),
        status_check_records: status_check_records.len(),
    };
    let projection = forge_read_intent_projection(ForgeReadIntentProjectionInput {
        credential_status_records,
        repository_metadata_records,
        pull_request_records,
        status_check_records,
    });
    let control = forge_read_intent_projection_control_dto(&projection);

    Ok(ForgeReadIntentQueryResult {
        query_id: "forge-read-intent-query".to_owned(),
        projection,
        source_counts,
        no_effects: ProviderRuntimeNoEffects::none(),
        control: ForgeReadIntentQueryControlDto {
            dto_id: "forge-read-intent-query-control-dto".to_owned(),
            projection_control: control,
            source_counts,
        no_effects: ProviderRuntimeNoEffects::none(),
        },
    })
}

#[cfg(test)]
mod tests;
