//! Persistence for SCM capture dry-run planning records.

mod diagnostics;
mod helpers;
mod record_builder;
mod store;
#[cfg(test)]
mod tests;
mod types;

pub use diagnostics::scm_capture_dry_run_diagnostics_from_persisted_records;
pub use store::{persist_scm_capture_dry_run_plan, read_scm_capture_dry_run_plans};
pub use types::{
    ScmCaptureDryRunPersistenceBlocker, ScmCaptureDryRunPersistenceInput,
    ScmCaptureDryRunPersistenceRecord, ScmCaptureDryRunPersistenceStatus,
};

const SCM_CAPTURE_DRY_RUN_PREFIX: &str = "scm-capture-dry-run:";
