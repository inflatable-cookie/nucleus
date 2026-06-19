//! Engine-owned management projection sync runtime records.
//!
//! These records plan and route management projection sync work. They do not
//! import task state, overwrite meaning, create SCM captures, publish changes,
//! or call provider adapters.

mod apply;
mod assistance;
mod capture;
mod git_capture;
mod plans;
mod repairs;

pub use apply::{
    ManagementProjectionApplyCommand, ManagementProjectionApplyCommandId,
    ManagementProjectionApplyRecordTarget,
};
pub use assistance::{
    ManagementProjectionSyncAssistanceKind, ManagementProjectionSyncAssistanceRoute,
};
pub use capture::{
    ManagementProjectionCaptureAdmission, ManagementProjectionCaptureAdmissionStatus,
    ManagementProjectionCaptureCommand, ManagementProjectionCaptureCommandId,
    ManagementProjectionCaptureEvidence, ManagementProjectionCapturePolicyGate,
    ManagementProjectionCapturePrepId, ManagementProjectionCapturePrepRecord,
    ManagementProjectionCapturePrepStatus, ManagementProjectionCaptureReason,
    ManagementProjectionCaptureScope, ManagementProjectionCaptureShareReadiness,
};
pub use git_capture::{
    GitCaptureDryRunAdmission, GitCaptureDryRunAdmissionStatus, GitCaptureDryRunCheck,
    GitCaptureDryRunEnvelope, GitCaptureDryRunEnvelopeId, GitManagementCaptureDescriptor,
    GitManagementCaptureEvidence, GitManagementCapturePlan, GitManagementCapturePlanId,
    GitManagementCapturePlanStatus,
};
pub use plans::{
    ManagementProjectionSyncPlan, ManagementProjectionSyncPlanId, ManagementProjectionSyncPlanKind,
    ManagementProjectionSyncPlanStatus,
};
pub use repairs::{
    ManagementProjectionImportRepairKind, ManagementProjectionImportRepairProposal,
    ManagementProjectionImportRepairProposalId, ManagementProjectionImportRepairReview,
};

#[cfg(test)]
mod tests;
