use crate::ids::{ScmRepositoryRefId, ScmWorkSessionId};
use crate::scm::ScmRuntimeConstraint;

use super::session_plan::{
    ScmSessionCleanupPolicy, ScmWorkingCopyLocation, ScmWorkingCopySessionMode,
    ScmWorkingCopySessionPlan,
};

/// Pre-execution review record for a working-copy session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmWorkingSessionExecutionPrep {
    pub session_id: ScmWorkSessionId,
    pub repository_id: ScmRepositoryRefId,
    pub mode: ScmWorkingCopySessionMode,
    pub guard_checks: Vec<ScmSessionGuardCheck>,
    pub cleanup: ScmSessionCleanupPolicy,
    pub status: ScmWorkingSessionExecutionPrepStatus,
    pub provider_mutation_allowed: bool,
}

impl ScmWorkingSessionExecutionPrep {
    pub fn from_plan(plan: &ScmWorkingCopySessionPlan) -> Self {
        let mut guard_checks = vec![ScmSessionGuardCheck::RuntimeConstraintsKnown];
        match &plan.mode {
            ScmWorkingCopySessionMode::PrimaryTree { .. } => {
                guard_checks.push(ScmSessionGuardCheck::CleanOrRecoverablePrimaryTree);
                guard_checks.push(ScmSessionGuardCheck::TargetRefReviewed);
            }
            ScmWorkingCopySessionMode::IsolatedLocation { location, .. } => {
                guard_checks.push(ScmSessionGuardCheck::IsolatedLocationReviewed(
                    location.clone(),
                ));
                guard_checks.push(ScmSessionGuardCheck::CleanupPolicyReviewed);
            }
            ScmWorkingCopySessionMode::ExternalManaged { .. } => {
                guard_checks.push(ScmSessionGuardCheck::ProviderManagedSurfaceReviewed);
            }
            ScmWorkingCopySessionMode::Unsupported { reason } => {
                return Self {
                    session_id: plan.id.clone(),
                    repository_id: plan.repository_id.clone(),
                    mode: plan.mode.clone(),
                    guard_checks,
                    cleanup: plan.cleanup.clone(),
                    status: ScmWorkingSessionExecutionPrepStatus::Blocked(reason.clone()),
                    provider_mutation_allowed: false,
                };
            }
        }

        let status = if plan
            .runtime_constraints
            .contains(&ScmRuntimeConstraint::Unknown)
        {
            ScmWorkingSessionExecutionPrepStatus::Blocked(
                "runtime constraints must be known before execution".to_owned(),
            )
        } else {
            ScmWorkingSessionExecutionPrepStatus::ReadyForAdmission
        };

        Self {
            session_id: plan.id.clone(),
            repository_id: plan.repository_id.clone(),
            mode: plan.mode.clone(),
            guard_checks,
            cleanup: plan.cleanup.clone(),
            status,
            provider_mutation_allowed: false,
        }
    }
}

/// Guard check that must be reviewed before session execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmSessionGuardCheck {
    RuntimeConstraintsKnown,
    CleanOrRecoverablePrimaryTree,
    TargetRefReviewed,
    IsolatedLocationReviewed(ScmWorkingCopyLocation),
    CleanupPolicyReviewed,
    ProviderManagedSurfaceReviewed,
}

/// Working-session execution prep state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmWorkingSessionExecutionPrepStatus {
    ReadyForAdmission,
    Blocked(String),
}
