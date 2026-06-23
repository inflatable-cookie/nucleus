//! Read-only query composition for provider readiness overview.

use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

use crate::{
    forge_readiness_overview, query_forge_read_intent_projection,
    read_provider_live_read_approved_smoke_evidence_records, ForgeReadinessOverview,
    ForgeReadinessOverviewInput, ServerStateService,
};

pub fn query_forge_readiness_overview<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<ForgeReadinessOverview>
where
    B: LocalStoreBackend,
{
    let read_intent = query_forge_read_intent_projection(state)?;
    let approved_live_read_smoke_evidence_count =
        read_provider_live_read_approved_smoke_evidence_records(state)?.len();

    Ok(forge_readiness_overview(ForgeReadinessOverviewInput {
        overview_id: "forge-readiness-overview".to_owned(),
        project_ref: None,
        repo_ref: None,
        authority_host_ref: Some("host:local".to_owned()),
        projection: read_intent.projection,
        approved_live_read_smoke_evidence_count,
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
        assert_eq!(overview.missing_evidence_family_count, 4);
        assert_eq!(overview.approved_live_read_smoke_evidence_count, 0);
        assert!(!overview.provider_network_call_performed);
        assert!(!overview.credential_resolution_performed);
        assert!(!overview.raw_provider_payload_retained);
    }

    #[test]
    fn readiness_overview_query_counts_approved_smoke_evidence_without_changing_status() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        crate::replay_approved_provider_live_read_smoke_evidence(&state).expect("replay smoke");

        let overview = query_forge_readiness_overview(&state).expect("query overview");

        assert_eq!(overview.status, ForgeReadinessOverviewStatus::Unknown);
        assert_eq!(overview.total_read_intent_count, 0);
        assert_eq!(overview.approved_live_read_smoke_evidence_count, 1);
        assert!(!overview.provider_network_call_performed);
        assert!(!overview.raw_provider_payload_retained);
    }
}
