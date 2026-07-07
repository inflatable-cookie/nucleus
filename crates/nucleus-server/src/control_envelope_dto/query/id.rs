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
            | Self::AcceptedMemory { query_id, .. }
            | Self::AcceptedMemoryProjectionDiagnostics { query_id, .. }
            | Self::AcceptedMemoryProjectionWriteDiagnostics { query_id, .. }
            | Self::AcceptedMemoryProjectionImportDiagnostics { query_id, .. }
            | Self::AcceptedMemoryProjectionImportApplyDiagnostics { query_id, .. }
            | Self::AcceptedMemoryImportApplyReviewDiagnostics { query_id, .. }
            | Self::AcceptedMemoryReviewReceiptStorageDiagnostics { query_id, .. }
            | Self::AcceptedMemoryActiveApplyDiagnostics { query_id, .. }
            | Self::AcceptedMemoryReviewReadiness { query_id, .. }
            | Self::MemoryProposalReviewDiagnostics { query_id, .. }
            | Self::ResearchRunBriefs { query_id, .. }
            | Self::TaskSeedPromotionDiagnostics { query_id, .. }
            | Self::PlanningProjectionFileWriteDiagnostics { query_id, .. }
            | Self::PlanningProjectionImportDiagnostics { query_id, .. }
            | Self::PlanningProjectionImportApplyDiagnostics { query_id, .. }
            | Self::PlanningProjectionImportActiveApplyDiagnostics { query_id, .. }
            | Self::PlanningCapturePublicationDiagnostics { query_id, .. }
            | Self::ProductWorkflowSummary { query_id, .. }
            | Self::TaskWorkflowDrilldown { query_id, .. }
            | Self::SelectedTaskActionReadiness { query_id, .. }
            | Self::SelectedTaskOperatorActionGate { query_id, .. }
            | Self::SelectedTaskReviewNext { query_id, .. }
            | Self::SelectedTaskReviewOutcomeRoute { query_id, .. }
            | Self::SelectedTaskRouteAdmission { query_id, .. }
            | Self::SelectedTaskScmHandoff { query_id, .. }
            | Self::SelectedTaskCommandAdmission { query_id, .. }
            | Self::SelectedTaskReviewDecisionAdmission { query_id, .. }
            | Self::SelectedTaskReviewDecisionApply { query_id, .. }
            | Self::ProjectAuthorityMap { query_id, .. } => query_id.clone(),
        }
    }
}
