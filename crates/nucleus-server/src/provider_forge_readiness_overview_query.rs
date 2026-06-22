//! Read-only query composition for provider readiness overview.

use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

use crate::{
    forge_readiness_overview, query_forge_read_intent_projection, ForgeReadinessOverview,
    ForgeReadinessOverviewInput, ServerStateService,
};

pub fn query_forge_readiness_overview<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<ForgeReadinessOverview>
where
    B: LocalStoreBackend,
{
    let read_intent = query_forge_read_intent_projection(state)?;

    Ok(forge_readiness_overview(ForgeReadinessOverviewInput {
        overview_id: "forge-readiness-overview".to_owned(),
        project_ref: None,
        repo_ref: None,
        authority_host_ref: Some("host:local".to_owned()),
        projection: read_intent.projection,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ForgeReadinessOverviewStatus;
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn readiness_overview_query_composes_empty_store_without_provider_effects() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

        let overview = query_forge_readiness_overview(&state).expect("query overview");

        assert_eq!(overview.status, ForgeReadinessOverviewStatus::Unknown);
        assert_eq!(overview.total_read_intent_count, 0);
        assert_eq!(overview.missing_evidence_family_count, 3);
        assert!(!overview.provider_network_call_performed);
        assert!(!overview.credential_resolution_performed);
        assert!(!overview.raw_provider_payload_retained);
    }
}
