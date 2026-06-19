//! Client-safe diagnostics read models.
//!
//! These DTOs expose steward, Effigy, management sync, and SCM session state to
//! clients without granting command authority or copying raw provider output.

mod effigy;
mod helpers;
mod scm;
mod steward;
mod sync;
mod sync_capture;
mod sync_review;
mod task_agent;

pub use effigy::{effigy_diagnostics, EffigyDiagnosticsDto};
pub use scm::{
    scm_session_diagnostics, ScmCommandAdmissionDiagnosticDto, ScmSessionDiagnosticsDto,
    ScmSessionPlanDiagnosticDto, ScmWorkItemLinkDiagnosticDto,
};
pub use steward::{
    steward_diagnostics, StewardCommandAdmissionDiagnosticDto, StewardCommandOutcomeDiagnosticDto,
    StewardDiagnosticsDto, StewardProposalDiagnosticDto, steward_sync_diagnostics,
    StewardSyncDecisionDiagnosticDto, StewardSyncDiagnosticsDto,
};
pub use sync::{
    sync_diagnostics, SyncAssistanceDiagnosticDto, SyncCapturePrepDiagnosticDto,
    SyncDiagnosticsDto, SyncPlanDiagnosticDto, SyncRepairDiagnosticDto,
};
pub use sync_capture::{
    management_capture_review_model, SyncCaptureAdmissionReviewDto, SyncCapturePrepReviewDto,
    SyncCaptureReviewModelDto,
};
pub use sync_review::{
    management_sync_review_model, SyncAppliedRecordReviewDto, SyncApplyBlockReviewDto,
    SyncConflictReviewDto, SyncReceiptReviewDto, SyncReviewModelDto, SyncStagedRecordReviewDto,
};
pub use task_agent::{
    task_agent_diagnostics, TaskAgentDiagnosticsDto, TaskAgentWorkUnitDiagnosticDto,
    TaskAgentWorkUnitIssueDto,
};

#[cfg(test)]
mod tests;
