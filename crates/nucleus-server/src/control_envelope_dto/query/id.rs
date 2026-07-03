use super::ControlQueryDto;

impl ControlQueryDto {
    pub(in crate::control_envelope_dto) fn query_id(&self) -> String {
        match self {
            Self::State { query_id, .. }
            | Self::RuntimeMetadata { query_id, .. }
            | Self::Diagnostics { query_id, .. }
            | Self::ProviderReadIntent { query_id, .. }
            | Self::ProviderReadinessOverview { query_id, .. }
            | Self::ProviderLiveReadExecutor { query_id, .. }
            | Self::ProviderLiveReadSmokeEvidence { query_id, .. }
            | Self::TaskTimeline { query_id, .. }
            | Self::TaskReadiness { query_id, .. }
            | Self::PlanningTaskSeeds { query_id, .. }
            | Self::PlanningSessions { query_id, .. }
            | Self::MemoryProposals { query_id, .. }
            | Self::TaskSeedPromotionDiagnostics { query_id, .. }
            | Self::PlanningProjectionFileWriteDiagnostics { query_id, .. }
            | Self::PlanningProjectionImportDiagnostics { query_id, .. }
            | Self::PlanningCapturePublicationDiagnostics { query_id, .. }
            | Self::ProjectAuthorityMap { query_id, .. } => query_id.clone(),
        }
    }
}
