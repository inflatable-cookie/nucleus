//! Client-safe diagnostics read models.
//!
//! These DTOs expose steward, Effigy, management sync, and SCM session state to
//! clients without granting command authority or copying raw provider output.

mod effigy;
mod helpers;
mod scm;
mod steward;
mod sync;

pub use effigy::{effigy_diagnostics, EffigyDiagnosticsDto};
pub use scm::{
    scm_session_diagnostics, ScmCommandAdmissionDiagnosticDto, ScmSessionDiagnosticsDto,
    ScmSessionPlanDiagnosticDto, ScmWorkItemLinkDiagnosticDto,
};
pub use steward::{
    steward_diagnostics, StewardCommandAdmissionDiagnosticDto,
    StewardCommandOutcomeDiagnosticDto, StewardDiagnosticsDto, StewardProposalDiagnosticDto,
};
pub use sync::{
    sync_diagnostics, SyncAssistanceDiagnosticDto, SyncCapturePrepDiagnosticDto,
    SyncDiagnosticsDto, SyncPlanDiagnosticDto, SyncRepairDiagnosticDto,
};

#[cfg(test)]
mod tests;
