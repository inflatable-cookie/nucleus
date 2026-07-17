use crate::personas::NativeActionApproval;

use super::records::NativeStewardCommandId;

/// Admission result for a steward command request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardCommandAdmission {
    pub command_id: NativeStewardCommandId,
    pub status: NativeStewardCommandAdmissionStatus,
    pub approval: NativeActionApproval,
    pub reason: Option<String>,
}

impl NativeStewardCommandAdmission {
    pub fn can_run_without_approval(&self) -> bool {
        self.status == NativeStewardCommandAdmissionStatus::Accepted
            && matches!(
                self.approval,
                NativeActionApproval::NotRequired | NativeActionApproval::AllowedByPolicy
            )
    }

    pub fn is_rejected_or_blocked(&self) -> bool {
        matches!(
            self.status,
            NativeStewardCommandAdmissionStatus::Rejected(_)
                | NativeStewardCommandAdmissionStatus::Blocked(_)
                | NativeStewardCommandAdmissionStatus::Unsupported
        )
    }
}

/// Admission status for a steward command request (shared core vocabulary).
pub use nucleus_core::AdmissionStatus as NativeStewardCommandAdmissionStatus;
