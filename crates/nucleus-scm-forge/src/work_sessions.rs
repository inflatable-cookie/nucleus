//! Provider-neutral working-copy session planning records.
//!
//! These records describe the session shape Nucleus intends to use. They do
//! not create branches, create worktrees, switch refs, delete directories,
//! merge changes, or call a provider.

mod execution_prep;
mod recovery;
mod session_plan;

pub use execution_prep::{
    ScmSessionGuardCheck, ScmWorkingSessionExecutionPrep, ScmWorkingSessionExecutionPrepStatus,
};
pub use recovery::{ScmSessionRecoveryRecord, ScmSessionRecoveryRecordId, ScmSessionRecoveryState};
pub use session_plan::{
    ScmIsolationSurface, ScmSessionCleanupPolicy, ScmSessionTestLocation, ScmSessionTestability,
    ScmWorkingCopyLocation, ScmWorkingCopySessionMode, ScmWorkingCopySessionPlan,
};

#[cfg(test)]
mod tests;
