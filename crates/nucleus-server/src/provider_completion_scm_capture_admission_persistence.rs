//! Persistence for completion SCM capture-admission records.

mod diagnostics;
mod helpers;
mod record_builder;
mod store;
#[cfg(test)]
mod tests;
mod types;

pub use diagnostics::completion_scm_capture_diagnostics_from_persisted_admissions;
pub use store::{persist_completion_scm_capture_admission, read_completion_scm_capture_admissions};
pub use types::{
    CompletionScmCaptureAdmissionPersistenceBlocker, CompletionScmCaptureAdmissionPersistenceInput,
    CompletionScmCaptureAdmissionPersistenceRecord, CompletionScmCaptureAdmissionPersistenceStatus,
};

const COMPLETION_SCM_CAPTURE_ADMISSION_PREFIX: &str = "completion-scm-capture-admission:";
