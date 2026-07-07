use nucleus_server::ServerStateDomain;

use super::QueryDomain;

pub(super) fn query_domain_state_domain(domain: &QueryDomain) -> Option<ServerStateDomain> {
    match domain {
        QueryDomain::Projects => Some(ServerStateDomain::Projects),
        QueryDomain::Tasks => Some(ServerStateDomain::Tasks),
        QueryDomain::Workspaces => Some(ServerStateDomain::Workspaces),
        QueryDomain::CommandEvidence => Some(ServerStateDomain::CommandEvidence),
        QueryDomain::ProviderReadIntent
        | QueryDomain::ProviderReadinessOverview
        | QueryDomain::ProviderLiveReadExecutor
        | QueryDomain::ProviderLiveReadSmokeEvidence
        | QueryDomain::TaskTimeline { .. }
        | QueryDomain::TaskReadiness { .. }
        | QueryDomain::PlanningTaskSeeds { .. }
        | QueryDomain::PlanningSessions { .. }
        | QueryDomain::AcceptedMemory { .. }
        | QueryDomain::AcceptedMemoryProjection { .. }
        | QueryDomain::AcceptedMemoryProjectionWrites { .. }
        | QueryDomain::AcceptedMemoryProjectionImport { .. }
        | QueryDomain::AcceptedMemoryProjectionImportApply { .. }
        | QueryDomain::AcceptedMemoryImportApplyReviewDiagnostics { .. }
        | QueryDomain::AcceptedMemoryReviewReceiptStorageDiagnostics { .. }
        | QueryDomain::AcceptedMemoryActiveApplyDiagnostics { .. }
        | QueryDomain::AcceptedMemoryReviewReadiness { .. }
        | QueryDomain::MemoryProposals { .. }
        | QueryDomain::MemoryProposalReviewDiagnostics { .. }
        | QueryDomain::ResearchRunBriefs { .. }
        | QueryDomain::TaskSeedPromotionDiagnostics { .. }
        | QueryDomain::PlanningProjectionFileWriteDiagnostics { .. }
        | QueryDomain::PlanningProjectionImportDiagnostics { .. }
        | QueryDomain::PlanningProjectionImportApplyDiagnostics { .. }
        | QueryDomain::PlanningProjectionImportActiveApplyDiagnostics { .. }
        | QueryDomain::PlanningCapturePublicationDiagnostics { .. }
        | QueryDomain::ProductWorkflowSummary { .. }
        | QueryDomain::TaskWorkflowDrilldown { .. }
        | QueryDomain::SelectedTaskActionReadiness { .. }
        | QueryDomain::SelectedTaskOperatorActionGate { .. }
        | QueryDomain::SelectedTaskCommandAdmission { .. }
        | QueryDomain::ProjectAuthorityMap { .. } => None,
    }
}
