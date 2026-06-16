//! Static command authority trait skeleton.
//!
//! This trait exposes policy inspection only. It does not spawn processes,
//! open terminals, implement sandboxes, stream output, retain artifacts, or
//! execute commands.

use crate::ids::CommandPolicyId;
use crate::policy::{
    CommandApprovalPolicy, CommandAuthorityArea, CommandRisk, CommandSandboxProfile, CommandScope,
};

/// Static readiness for the server-owned command authority surface.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandAuthorityReadiness {
    Ready,
    NeedsPolicy,
    NeedsApprovalProvider,
    Unsupported,
    Unknown,
}

/// Static server-owned command authority policy surface.
pub trait CommandAuthorityPolicySurface {
    fn policy_id(&self) -> Option<&CommandPolicyId>;
    fn readiness(&self) -> CommandAuthorityReadiness;
    fn supported_scopes(&self) -> Vec<CommandScope>;
    fn default_sandbox_for(&self, scope: &CommandScope) -> Option<CommandSandboxProfile>;
    fn approval_for(
        &self,
        area: &CommandAuthorityArea,
        scope: &CommandScope,
        risk: &CommandRisk,
    ) -> CommandApprovalPolicy;
}

#[cfg(test)]
mod tests {
    use super::{CommandAuthorityPolicySurface, CommandAuthorityReadiness};
    use crate::ids::CommandPolicyId;
    use crate::policy::{
        CommandApprovalPolicy, CommandAuthorityArea, CommandRisk, CommandSandboxProfile,
        CommandScope,
    };

    struct StaticCommandAuthority {
        policy_id: CommandPolicyId,
    }

    impl CommandAuthorityPolicySurface for StaticCommandAuthority {
        fn policy_id(&self) -> Option<&CommandPolicyId> {
            Some(&self.policy_id)
        }

        fn readiness(&self) -> CommandAuthorityReadiness {
            CommandAuthorityReadiness::Ready
        }

        fn supported_scopes(&self) -> Vec<CommandScope> {
            vec![
                CommandScope::ReadOnlyInspection,
                CommandScope::ManagementStateWrite,
                CommandScope::NetworkAccess,
                CommandScope::Destructive,
            ]
        }

        fn default_sandbox_for(&self, scope: &CommandScope) -> Option<CommandSandboxProfile> {
            match scope {
                CommandScope::ReadOnlyInspection => Some(CommandSandboxProfile::NoFilesystemWrite),
                CommandScope::NetworkAccess => Some(CommandSandboxProfile::NetworkAllowed),
                CommandScope::Destructive => Some(CommandSandboxProfile::ProjectRestricted),
                _ => Some(CommandSandboxProfile::ProjectRestricted),
            }
        }

        fn approval_for(
            &self,
            _area: &CommandAuthorityArea,
            scope: &CommandScope,
            risk: &CommandRisk,
        ) -> CommandApprovalPolicy {
            match (scope, risk) {
                (CommandScope::ReadOnlyInspection, CommandRisk::Low) => {
                    CommandApprovalPolicy::AutoAllowed
                }
                (CommandScope::Destructive, _) => CommandApprovalPolicy::Denied,
                (_, CommandRisk::Critical) => CommandApprovalPolicy::ApprovalRequiredEveryTime,
                _ => CommandApprovalPolicy::ApprovalRequiredOnce,
            }
        }
    }

    #[test]
    fn command_authority_trait_can_inspect_policy_without_execution() {
        let authority = StaticCommandAuthority {
            policy_id: CommandPolicyId("test-policy".to_owned()),
        };

        assert_eq!(
            authority.policy_id().map(|id| id.0.as_str()),
            Some("test-policy")
        );
        assert_eq!(authority.readiness(), CommandAuthorityReadiness::Ready);
        assert!(
            authority
                .supported_scopes()
                .contains(&CommandScope::ManagementStateWrite)
        );
        assert_eq!(
            authority.default_sandbox_for(&CommandScope::ReadOnlyInspection),
            Some(CommandSandboxProfile::NoFilesystemWrite)
        );
        assert_eq!(
            authority.approval_for(
                &CommandAuthorityArea::ScmAdapter,
                &CommandScope::ReadOnlyInspection,
                &CommandRisk::Low,
            ),
            CommandApprovalPolicy::AutoAllowed
        );
        assert_eq!(
            authority.approval_for(
                &CommandAuthorityArea::UserTerminal,
                &CommandScope::Destructive,
                &CommandRisk::Critical,
            ),
            CommandApprovalPolicy::Denied
        );
    }
}
