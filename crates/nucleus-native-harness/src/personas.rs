//! Native harness persona records.

use crate::backends::NativeModelBackend;

/// Stable native persona id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativePersonaId(pub String);

/// Nucleus-owned persona record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativePersona {
    pub id: NativePersonaId,
    pub role: NativePersonaRole,
    pub display_name: String,
    pub capabilities: Vec<NativePersonaCapability>,
    pub policy: NativePersonaPolicy,
}

/// Built-in native persona role.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativePersonaRole {
    ProjectSteward,
    TaskTriage,
    DocumentationMaintainer,
    SyncConflictAssistant,
    ValidationSummarizer,
    ResearchLibrarian,
    LightweightLocalHelper,
    Custom(String),
}

/// Capability exposed by a native persona.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativePersonaCapability {
    InspectProjectState,
    InspectTaskState,
    NormalizeTaskMetadata,
    PrepareManagementCapture,
    CreateManagementCapture,
    ShareManagementCapture,
    ReconcileMechanicalConflict,
    ProposeSemanticConflictResolution,
    DeleteTask,
    RewriteTaskHistory,
    SummarizeTaskHistory,
    SummarizeValidation,
    UpdateDocsIndexes,
    LinkForgeObjects,
    RequestHumanDecision,
    Custom(String),
}

/// Policy limits for a native persona.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativePersonaPolicy {
    pub sync_authority: NativeSyncAuthority,
    pub local_model_allowed: bool,
    pub cloud_model_allowed: bool,
    pub approval_required_for_privileged_actions: bool,
    pub may_commit_management_state: bool,
    pub may_push_management_state: bool,
    pub may_modify_code: bool,
}

impl NativePersonaPolicy {
    /// Default policy shape for the project steward.
    pub fn project_steward(
        sync_authority: NativeSyncAuthority,
        local_model_allowed: bool,
        cloud_model_allowed: bool,
    ) -> Self {
        Self {
            may_commit_management_state: sync_authority.can_create_management_capture(),
            may_push_management_state: sync_authority.can_share_management_capture(),
            sync_authority,
            local_model_allowed,
            cloud_model_allowed,
            approval_required_for_privileged_actions: true,
            may_modify_code: false,
        }
    }

    /// True when this policy cannot be used to mutate source code.
    pub fn is_management_state_only(&self) -> bool {
        !self.may_modify_code
    }

    /// True when the policy can propose management-state edits without
    /// creating local captures or shared authority updates.
    pub fn can_propose_management_state(&self) -> bool {
        self.sync_authority != NativeSyncAuthority::None
    }

    /// True when the policy can prepare a local management-state capture.
    pub fn can_prepare_management_capture(&self) -> bool {
        self.sync_authority.can_prepare_management_capture()
    }

    /// True when the policy can create a local management-state capture.
    pub fn can_create_management_capture(&self) -> bool {
        self.may_commit_management_state
            && self.sync_authority.can_create_management_capture()
            && !self.may_modify_code
    }

    /// True when the policy can share a management-state capture.
    pub fn can_share_management_capture(&self) -> bool {
        self.may_push_management_state
            && self.sync_authority.can_share_management_capture()
            && !self.may_modify_code
    }

    /// Returns the approval policy for a steward-sensitive action.
    pub fn approval_for_action(&self, action: NativePrivilegedAction) -> NativeActionApproval {
        if !self.approval_required_for_privileged_actions {
            return NativeActionApproval::AllowedByPolicy;
        }

        match action {
            NativePrivilegedAction::ReadOnlyInspection => NativeActionApproval::NotRequired,
            NativePrivilegedAction::ProposeManagementStateEdit => {
                if self.can_propose_management_state() {
                    NativeActionApproval::NotRequired
                } else {
                    NativeActionApproval::BlockedByPolicy
                }
            }
            NativePrivilegedAction::PrepareManagementCapture => {
                if self.can_prepare_management_capture() {
                    NativeActionApproval::Required
                } else {
                    NativeActionApproval::BlockedByPolicy
                }
            }
            NativePrivilegedAction::CreateManagementCapture => {
                if self.can_create_management_capture() {
                    NativeActionApproval::Required
                } else {
                    NativeActionApproval::BlockedByPolicy
                }
            }
            NativePrivilegedAction::ShareManagementCapture => {
                if self.can_share_management_capture() {
                    NativeActionApproval::Required
                } else {
                    NativeActionApproval::BlockedByPolicy
                }
            }
            NativePrivilegedAction::MutateSourceCode => NativeActionApproval::BlockedByPolicy,
            NativePrivilegedAction::DeleteTask | NativePrivilegedAction::RewriteTaskHistory => {
                NativeActionApproval::Required
            }
            NativePrivilegedAction::ChangeSyncPolicy => NativeActionApproval::Required,
        }
    }

    /// Model backend choice must not alter authority.
    pub fn authority_is_unchanged_by_backend(&self, _backend: &NativeModelBackend) -> bool {
        true
    }
}

/// Sync authority granted to a native persona.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeSyncAuthority {
    None,
    ProposeOnly,
    PrepareManagementCapture,
    CreateManagementCapture,
    ShareManagementCapture,
}

impl NativeSyncAuthority {
    pub fn can_prepare_management_capture(&self) -> bool {
        matches!(
            self,
            Self::PrepareManagementCapture
                | Self::CreateManagementCapture
                | Self::ShareManagementCapture
        )
    }

    pub fn can_create_management_capture(&self) -> bool {
        matches!(
            self,
            Self::CreateManagementCapture | Self::ShareManagementCapture
        )
    }

    pub fn can_share_management_capture(&self) -> bool {
        matches!(self, Self::ShareManagementCapture)
    }
}

/// Steward-sensitive action class.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativePrivilegedAction {
    ReadOnlyInspection,
    ProposeManagementStateEdit,
    PrepareManagementCapture,
    CreateManagementCapture,
    ShareManagementCapture,
    MutateSourceCode,
    DeleteTask,
    RewriteTaskHistory,
    ChangeSyncPolicy,
}

/// Approval outcome for a native privileged action.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeActionApproval {
    NotRequired,
    Required,
    AllowedByPolicy,
    BlockedByPolicy,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backends::{
        NativeModelBackend, NativeModelBackendDeployment, NativeModelBackendId,
        NativeModelBackendKind, NativeModelBackendStatus, NativeModelBackendSuitability,
    };

    fn backend(id: &str, kind: NativeModelBackendKind, local: bool) -> NativeModelBackend {
        NativeModelBackend {
            id: NativeModelBackendId(id.to_owned()),
            kind,
            display_name: id.to_owned(),
            local,
            deployment: if local {
                NativeModelBackendDeployment::LocalOnly
            } else {
                NativeModelBackendDeployment::CloudOnly
            },
            suitability: NativeModelBackendSuitability::lightweight_assistant(),
            status: NativeModelBackendStatus::Available,
        }
    }

    #[test]
    fn steward_policy_represents_management_capture_authority_tiers() {
        let propose =
            NativePersonaPolicy::project_steward(NativeSyncAuthority::ProposeOnly, true, false);
        let prepare = NativePersonaPolicy::project_steward(
            NativeSyncAuthority::PrepareManagementCapture,
            true,
            false,
        );
        let create = NativePersonaPolicy::project_steward(
            NativeSyncAuthority::CreateManagementCapture,
            true,
            false,
        );
        let share = NativePersonaPolicy::project_steward(
            NativeSyncAuthority::ShareManagementCapture,
            true,
            false,
        );

        assert!(propose.can_propose_management_state());
        assert!(!propose.can_prepare_management_capture());
        assert!(prepare.can_prepare_management_capture());
        assert!(!prepare.can_create_management_capture());
        assert!(create.can_create_management_capture());
        assert!(!create.can_share_management_capture());
        assert!(share.can_share_management_capture());
    }

    #[test]
    fn steward_policy_keeps_management_state_separate_from_code_mutation() {
        let policy = NativePersonaPolicy::project_steward(
            NativeSyncAuthority::ShareManagementCapture,
            true,
            true,
        );

        assert!(policy.is_management_state_only());
        assert!(!policy.may_modify_code);
        assert_eq!(
            policy.approval_for_action(NativePrivilegedAction::MutateSourceCode),
            NativeActionApproval::BlockedByPolicy
        );
        assert_eq!(
            policy.approval_for_action(NativePrivilegedAction::ShareManagementCapture),
            NativeActionApproval::Required
        );
    }

    #[test]
    fn privileged_steward_actions_require_approval_or_policy_support() {
        let policy = NativePersonaPolicy::project_steward(
            NativeSyncAuthority::PrepareManagementCapture,
            true,
            false,
        );

        assert_eq!(
            policy.approval_for_action(NativePrivilegedAction::ReadOnlyInspection),
            NativeActionApproval::NotRequired
        );
        assert_eq!(
            policy.approval_for_action(NativePrivilegedAction::PrepareManagementCapture),
            NativeActionApproval::Required
        );
        assert_eq!(
            policy.approval_for_action(NativePrivilegedAction::ShareManagementCapture),
            NativeActionApproval::BlockedByPolicy
        );
        assert_eq!(
            policy.approval_for_action(NativePrivilegedAction::DeleteTask),
            NativeActionApproval::Required
        );
    }

    #[test]
    fn local_and_cloud_model_backends_do_not_increase_steward_authority() {
        let policy =
            NativePersonaPolicy::project_steward(NativeSyncAuthority::ProposeOnly, true, true);
        let local = backend("local", NativeModelBackendKind::LocalInferenceServer, true);
        let cloud = backend(
            "cloud",
            NativeModelBackendKind::CloudModelRoute("test".to_owned()),
            false,
        );

        assert!(policy.authority_is_unchanged_by_backend(&local));
        assert!(policy.authority_is_unchanged_by_backend(&cloud));
        assert!(!policy.can_prepare_management_capture());
        assert!(!policy.can_create_management_capture());
        assert!(!policy.can_share_management_capture());
        assert_eq!(
            policy.approval_for_action(NativePrivilegedAction::MutateSourceCode),
            NativeActionApproval::BlockedByPolicy
        );
    }
}
