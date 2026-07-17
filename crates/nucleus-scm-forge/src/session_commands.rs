//! Provider-neutral SCM working-session command records.
//!
//! These records describe requested session work and admission outcomes. They
//! do not execute provider commands, mutate working copies, create captures,
//! share captures, open reviews, integrate work, or clean up files.

use crate::{
    ScmCapability, ScmProviderKind, ScmRepositoryRefId, ScmRuntimeConstraint, ScmWorkSessionId,
    ScmWorkingCopySessionPlan,
};

/// Stable id for one SCM session command request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ScmSessionCommandId(pub String);

/// Sanitized evidence ref for a session command (shared core type).
pub use nucleus_core::EvidenceRef as ScmSessionCommandEvidenceRef;

/// Working-session command request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmSessionCommandRequest {
    pub id: ScmSessionCommandId,
    pub repository_id: ScmRepositoryRefId,
    pub provider_kind: ScmProviderKind,
    pub session_id: ScmWorkSessionId,
    pub kind: ScmSessionCommandKind,
    pub capability: ScmCapability,
    pub scope: ScmSessionCommandScope,
    pub plan: Option<ScmWorkingCopySessionPlan>,
    pub evidence_refs: Vec<ScmSessionCommandEvidenceRef>,
}

impl ScmSessionCommandRequest {
    pub fn from_plan(
        id: ScmSessionCommandId,
        kind: ScmSessionCommandKind,
        capability: ScmCapability,
        scope: ScmSessionCommandScope,
        plan: ScmWorkingCopySessionPlan,
    ) -> Self {
        Self {
            id,
            repository_id: plan.repository_id.clone(),
            provider_kind: plan.provider_kind.clone(),
            session_id: plan.id.clone(),
            kind,
            capability,
            scope,
            plan: Some(plan),
            evidence_refs: Vec::new(),
        }
    }

    pub fn implies_provider_mutation(&self) -> bool {
        false
    }

    pub fn supports_non_git_vocabulary(&self) -> bool {
        self.provider_kind == ScmProviderKind::Convergence
            || matches!(self.provider_kind, ScmProviderKind::Custom(_))
    }

    pub fn uses_sanitized_refs(&self) -> bool {
        self.evidence_refs
            .iter()
            .all(|evidence| !contains_forbidden_session_term(&evidence.0))
    }
}

/// SCM session command kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmSessionCommandKind {
    PrepareSession,
    InspectSession,
    IntegrateSession,
    CleanupSession,
}

/// Requested authority for a session command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmSessionCommandScope {
    ReadOnlyInspection,
    SessionPreparation,
    IntegrationPreparation,
    CleanupPreparation,
    Unsupported,
}

/// Admission result for a session command request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmSessionCommandAdmission {
    pub command_id: ScmSessionCommandId,
    pub status: ScmSessionCommandAdmissionStatus,
    pub required_capability: ScmCapability,
    pub evidence_refs: Vec<ScmSessionCommandEvidenceRef>,
}

impl ScmSessionCommandAdmission {
    pub fn from_supported_capabilities(
        command: &ScmSessionCommandRequest,
        supported: &[ScmCapability],
    ) -> Self {
        let status = if command.scope == ScmSessionCommandScope::Unsupported {
            ScmSessionCommandAdmissionStatus::Rejected("unsupported command scope".to_owned())
        } else if !supported.contains(&command.capability) {
            ScmSessionCommandAdmissionStatus::Unsupported
        } else if command
            .plan
            .as_ref()
            .map(|plan| {
                plan.runtime_constraints
                    .contains(&ScmRuntimeConstraint::Unknown)
            })
            .unwrap_or(false)
        {
            ScmSessionCommandAdmissionStatus::Blocked("unknown runtime constraint".to_owned())
        } else if matches!(
            command.scope,
            ScmSessionCommandScope::IntegrationPreparation
                | ScmSessionCommandScope::CleanupPreparation
        ) {
            ScmSessionCommandAdmissionStatus::RequiresApproval
        } else {
            ScmSessionCommandAdmissionStatus::Accepted
        };

        Self {
            command_id: command.id.clone(),
            status,
            required_capability: command.capability.clone(),
            evidence_refs: command.evidence_refs.clone(),
        }
    }

    pub fn executes_provider_command(&self) -> bool {
        false
    }
}

/// Session command admission state (shared core vocabulary).
pub use nucleus_core::AdmissionStatus as ScmSessionCommandAdmissionStatus;

fn contains_forbidden_session_term(value: &str) -> bool {
    [
        "raw_stdout",
        "raw_stderr",
        "terminal stream",
        "provider payload",
        "secret",
        "credential",
        "token",
    ]
    .iter()
    .any(|term| value.to_lowercase().contains(term))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        convergence_scm_driver_descriptor, git_scm_driver_descriptor, ScmBranchRef, ScmChangeKind,
        ScmChangeRef, ScmProviderRef, ScmWorkflowPrimitive,
    };

    fn repo_id() -> ScmRepositoryRefId {
        ScmRepositoryRefId("repo:nucleus".to_owned())
    }

    fn branch(name: &str) -> ScmBranchRef {
        ScmBranchRef {
            repository_id: repo_id(),
            name: name.to_owned(),
            provider_ref: Some(ScmProviderRef(format!("refs/heads/{name}"))),
        }
    }

    fn change_ref(kind: ScmChangeKind, provider_ref: &str) -> ScmChangeRef {
        ScmChangeRef {
            repository_id: repo_id(),
            kind,
            provider_ref: ScmProviderRef(provider_ref.to_owned()),
            summary: Some("captured change".to_owned()),
        }
    }

    #[test]
    fn scm_session_command_records_are_provider_neutral_and_non_mutating() {
        let plan = ScmWorkingCopySessionPlan::primary_tree_session(
            ScmWorkSessionId("session:primary".to_owned()),
            repo_id(),
            ScmProviderKind::Git,
            Some(branch("nucleus/task-1")),
            Some(change_ref(ScmChangeKind::Commit, "git:commit:base")),
            Some(branch("main")),
        );
        let command = ScmSessionCommandRequest::from_plan(
            ScmSessionCommandId("scm-command:inspect".to_owned()),
            ScmSessionCommandKind::InspectSession,
            ScmCapability::InspectWorkingCopy,
            ScmSessionCommandScope::ReadOnlyInspection,
            plan,
        );

        assert!(!command.implies_provider_mutation());
        assert_eq!(command.kind, ScmSessionCommandKind::InspectSession);
        assert!(command.uses_sanitized_refs());
    }

    #[test]
    fn git_session_admission_records_primary_and_isolated_constraints_without_execution() {
        let plan = ScmWorkingCopySessionPlan::isolated_location_session(
            ScmWorkSessionId("session:git:isolated".to_owned()),
            repo_id(),
            ScmProviderKind::Git,
            None,
            Some(branch("nucleus/task-1")),
            Some(change_ref(ScmChangeKind::Commit, "git:commit:base")),
            Some(branch("main")),
        );
        let command = ScmSessionCommandRequest::from_plan(
            ScmSessionCommandId("scm-command:prepare".to_owned()),
            ScmSessionCommandKind::PrepareSession,
            ScmCapability::StartIsolatedWorkingCopySession,
            ScmSessionCommandScope::SessionPreparation,
            plan,
        );
        let admission = ScmSessionCommandAdmission::from_supported_capabilities(
            &command,
            &git_scm_driver_descriptor().capabilities,
        );

        assert_eq!(admission.status, ScmSessionCommandAdmissionStatus::Accepted);
        assert!(!admission.executes_provider_command());
        assert_eq!(
            admission.required_capability,
            ScmCapability::StartIsolatedWorkingCopySession
        );
    }

    #[test]
    fn git_session_admission_can_block_or_report_unsupported_capabilities() {
        let mut plan = ScmWorkingCopySessionPlan::primary_tree_session(
            ScmWorkSessionId("session:git:blocked".to_owned()),
            repo_id(),
            ScmProviderKind::Git,
            Some(branch("nucleus/task-1")),
            Some(change_ref(ScmChangeKind::Commit, "git:commit:base")),
            Some(branch("main")),
        );
        plan.runtime_constraints = vec![ScmRuntimeConstraint::Unknown];
        let command = ScmSessionCommandRequest::from_plan(
            ScmSessionCommandId("scm-command:blocked".to_owned()),
            ScmSessionCommandKind::PrepareSession,
            ScmCapability::StartPrimaryWorkingCopySession,
            ScmSessionCommandScope::SessionPreparation,
            plan,
        );
        let blocked = ScmSessionCommandAdmission::from_supported_capabilities(
            &command,
            &git_scm_driver_descriptor().capabilities,
        );
        let unsupported = ScmSessionCommandAdmission::from_supported_capabilities(
            &command,
            &[ScmCapability::InspectRepository],
        );

        assert!(matches!(
            blocked.status,
            ScmSessionCommandAdmissionStatus::Blocked(_)
        ));
        assert_eq!(
            unsupported.status,
            ScmSessionCommandAdmissionStatus::Unsupported
        );
        assert!(!blocked.executes_provider_command());
        assert!(!unsupported.executes_provider_command());
    }

    #[test]
    fn convergence_session_commands_keep_snapshot_publication_and_gate_vocabulary() {
        let descriptor = convergence_scm_driver_descriptor();
        let plan = ScmWorkingCopySessionPlan::isolated_location_session(
            ScmWorkSessionId("session:convergence".to_owned()),
            repo_id(),
            ScmProviderKind::Convergence,
            None,
            None,
            Some(change_ref(
                ScmChangeKind::Snapshot,
                "convergence:snapshot:base",
            )),
            None,
        );
        let command = ScmSessionCommandRequest::from_plan(
            ScmSessionCommandId("scm-command:convergence".to_owned()),
            ScmSessionCommandKind::IntegrateSession,
            ScmCapability::IntegrateWorkSession,
            ScmSessionCommandScope::IntegrationPreparation,
            plan,
        );
        let admission = ScmSessionCommandAdmission::from_supported_capabilities(
            &command,
            &descriptor.capabilities,
        );

        assert!(command.supports_non_git_vocabulary());
        assert_eq!(
            descriptor.workflow_semantics.local_capture,
            ScmWorkflowPrimitive::Snapshot
        );
        assert_eq!(
            descriptor.workflow_semantics.shared_authority,
            ScmWorkflowPrimitive::Publication
        );
        assert_eq!(
            descriptor.workflow_semantics.review_boundary,
            Some(ScmWorkflowPrimitive::Gate)
        );
        assert_eq!(
            admission.status,
            ScmSessionCommandAdmissionStatus::RequiresApproval
        );
        assert!(!admission.executes_provider_command());
    }

    #[test]
    fn scm_session_command_rejects_raw_or_secret_refs() {
        let plan = ScmWorkingCopySessionPlan::primary_tree_session(
            ScmWorkSessionId("session:raw".to_owned()),
            repo_id(),
            ScmProviderKind::Git,
            None,
            None,
            None,
        );
        let mut command = ScmSessionCommandRequest::from_plan(
            ScmSessionCommandId("scm-command:raw".to_owned()),
            ScmSessionCommandKind::InspectSession,
            ScmCapability::InspectWorkingCopy,
            ScmSessionCommandScope::ReadOnlyInspection,
            plan,
        );
        command.evidence_refs = vec![ScmSessionCommandEvidenceRef("raw_stdout:full".to_owned())];

        assert!(!command.uses_sanitized_refs());
    }
}
