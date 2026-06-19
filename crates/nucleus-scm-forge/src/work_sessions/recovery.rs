use crate::ids::ScmWorkSessionId;

use super::session_plan::{ScmSessionCleanupPolicy, ScmWorkingCopySessionPlan};

/// Stable id for a working-session cleanup or repair record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ScmSessionRecoveryRecordId(pub String);

/// Cleanup or repair record for interrupted working sessions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmSessionRecoveryRecord {
    pub id: ScmSessionRecoveryRecordId,
    pub session_id: ScmWorkSessionId,
    pub state: ScmSessionRecoveryState,
    pub cleanup: ScmSessionCleanupPolicy,
    pub evidence_refs: Vec<String>,
    pub requires_human_approval: bool,
    pub provider_mutation_allowed: bool,
}

impl ScmSessionRecoveryRecord {
    pub fn cleanup_ready(
        id: ScmSessionRecoveryRecordId,
        plan: &ScmWorkingCopySessionPlan,
        evidence_refs: Vec<String>,
    ) -> Self {
        Self {
            id,
            session_id: plan.id.clone(),
            state: ScmSessionRecoveryState::CleanupReady,
            cleanup: plan.cleanup.clone(),
            evidence_refs,
            requires_human_approval: plan.cleanup.requires_human_approval(),
            provider_mutation_allowed: false,
        }
    }

    pub fn repair_required(
        id: ScmSessionRecoveryRecordId,
        plan: &ScmWorkingCopySessionPlan,
        reason: String,
        evidence_refs: Vec<String>,
    ) -> Self {
        Self {
            id,
            session_id: plan.id.clone(),
            state: ScmSessionRecoveryState::RepairRequired(reason),
            cleanup: plan.cleanup.clone(),
            evidence_refs,
            requires_human_approval: true,
            provider_mutation_allowed: false,
        }
    }
}

/// Recovery state for interrupted working sessions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmSessionRecoveryState {
    Abandoned,
    Blocked(String),
    RepairRequired(String),
    CleanupReady,
}
