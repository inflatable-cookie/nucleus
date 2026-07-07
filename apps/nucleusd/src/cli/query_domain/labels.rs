use super::QueryDomain;

pub(super) fn query_domain_label(domain: &QueryDomain) -> &'static str {
    match domain {
        QueryDomain::Projects => "projects",
        QueryDomain::Tasks => "tasks",
        QueryDomain::Workspaces => "workspaces",
        QueryDomain::CommandEvidence => "command-evidence",
        QueryDomain::ProviderReadIntent => "provider-read-intent",
        QueryDomain::ProviderReadinessOverview => "provider-readiness-overview",
        QueryDomain::ProviderLiveReadExecutor => "provider-live-read-executor",
        QueryDomain::ProviderLiveReadSmokeEvidence => "provider-live-read-smoke-evidence",
        QueryDomain::TaskTimeline { .. } => "task-timeline",
        QueryDomain::TaskReadiness { .. } => "task-readiness",
        QueryDomain::PlanningTaskSeeds { .. } => "planning-task-seeds",
        QueryDomain::PlanningSessions { .. } => "planning-sessions",
        QueryDomain::AcceptedMemory { .. } => "accepted-memory",
        QueryDomain::AcceptedMemoryProjection { .. } => "accepted-memory-projection",
        QueryDomain::AcceptedMemoryProjectionWrites { .. } => "accepted-memory-projection-writes",
        QueryDomain::AcceptedMemoryProjectionImport { .. } => "accepted-memory-projection-import",
        QueryDomain::AcceptedMemoryProjectionImportApply { .. } => {
            "accepted-memory-projection-import-apply"
        }
        QueryDomain::AcceptedMemoryImportApplyReviewDiagnostics { .. } => {
            "accepted-memory-import-apply-review-diagnostics"
        }
        QueryDomain::AcceptedMemoryReviewReceiptStorageDiagnostics { .. } => {
            "accepted-memory-review-receipt-storage-diagnostics"
        }
        QueryDomain::AcceptedMemoryActiveApplyDiagnostics { .. } => {
            "accepted-memory-active-apply-diagnostics"
        }
        QueryDomain::AcceptedMemoryReviewReadiness { .. } => "accepted-memory-review-readiness",
        QueryDomain::MemoryProposals { .. } => "memory-proposals",
        QueryDomain::MemoryProposalReviewDiagnostics { .. } => "memory-proposal-review-diagnostics",
        QueryDomain::ResearchRunBriefs { .. } => "research-run-briefs",
        QueryDomain::TaskSeedPromotionDiagnostics { .. } => "task-seed-promotion-diagnostics",
        QueryDomain::PlanningProjectionFileWriteDiagnostics { .. } => {
            "planning-projection-file-write-diagnostics"
        }
        QueryDomain::PlanningProjectionImportDiagnostics { .. } => {
            "planning-projection-import-diagnostics"
        }
        QueryDomain::PlanningProjectionImportApplyDiagnostics { .. } => {
            "planning-projection-import-apply-diagnostics"
        }
        QueryDomain::PlanningProjectionImportActiveApplyDiagnostics { .. } => {
            "planning-projection-import-active-apply-diagnostics"
        }
        QueryDomain::PlanningCapturePublicationDiagnostics { .. } => {
            "planning-capture-publication-diagnostics"
        }
        QueryDomain::ProductWorkflowSummary { .. } => "product-workflow-summary",
        QueryDomain::TaskWorkflowDrilldown { .. } => "task-workflow-drilldown",
        QueryDomain::SelectedTaskActionReadiness { .. } => "selected-task-action-readiness",
        QueryDomain::SelectedTaskOperatorActionGate { .. } => "selected-task-operator-action-gate",
        QueryDomain::SelectedTaskCommandAdmission { .. } => "selected-task-command-admission",
        QueryDomain::ProjectAuthorityMap { .. } => "project-authority-map",
    }
}
