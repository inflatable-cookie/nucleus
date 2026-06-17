//! Metadata-only SCM and forge driver registry.

use nucleus_command_policy::CommandScope;

use crate::capabilities::{ForgeCapability, ScmCapability};
use crate::forge::ForgeProviderKind;
use crate::observations::ForgeRefreshMode;
use crate::scm::{ScmProviderKind, ScmWorkflowPrimitive, ScmWorkflowSemantics};
use crate::traits::AdapterReadiness;

/// Stable SCM driver id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ScmDriverId(pub String);

/// Stable forge driver id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ForgeDriverId(pub String);

/// Current implementation depth for a driver descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DriverImplementationStatus {
    Planned,
    MetadataOnly,
    CommandBacked,
    NetworkBacked,
    Unsupported,
}

/// Static SCM driver descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmDriverDescriptor {
    pub id: ScmDriverId,
    pub provider_kind: ScmProviderKind,
    pub display_name: String,
    pub readiness: AdapterReadiness,
    pub implementation_status: DriverImplementationStatus,
    pub capabilities: Vec<ScmCapability>,
    pub workflow_semantics: ScmWorkflowSemantics,
    pub required_command_scopes: Vec<CommandScope>,
}

/// Static forge driver descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeDriverDescriptor {
    pub id: ForgeDriverId,
    pub provider_kind: ForgeProviderKind,
    pub display_name: String,
    pub readiness: AdapterReadiness,
    pub implementation_status: DriverImplementationStatus,
    pub capabilities: Vec<ForgeCapability>,
    pub supported_refresh_modes: Vec<ForgeRefreshMode>,
    pub required_command_scopes: Vec<CommandScope>,
}

/// In-memory descriptor registry.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ScmForgeDriverRegistry {
    scm_drivers: Vec<ScmDriverDescriptor>,
    forge_drivers: Vec<ForgeDriverDescriptor>,
}

impl ScmForgeDriverRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_scm_driver(mut self, descriptor: ScmDriverDescriptor) -> Self {
        self.scm_drivers.push(descriptor);
        self
    }

    pub fn with_forge_driver(mut self, descriptor: ForgeDriverDescriptor) -> Self {
        self.forge_drivers.push(descriptor);
        self
    }

    pub fn scm_drivers(&self) -> &[ScmDriverDescriptor] {
        &self.scm_drivers
    }

    pub fn forge_drivers(&self) -> &[ForgeDriverDescriptor] {
        &self.forge_drivers
    }

    pub fn scm_driver(&self, id: &ScmDriverId) -> Option<&ScmDriverDescriptor> {
        self.scm_drivers
            .iter()
            .find(|descriptor| descriptor.id == *id)
    }

    pub fn forge_driver(&self, id: &ForgeDriverId) -> Option<&ForgeDriverDescriptor> {
        self.forge_drivers
            .iter()
            .find(|descriptor| descriptor.id == *id)
    }
}

/// Static Git descriptor used to prove Git-like semantics.
pub fn git_scm_driver_descriptor() -> ScmDriverDescriptor {
    ScmDriverDescriptor {
        id: ScmDriverId("scm:git".to_owned()),
        provider_kind: ScmProviderKind::Git,
        display_name: "Git".to_owned(),
        readiness: AdapterReadiness::NeedsConfiguration,
        implementation_status: DriverImplementationStatus::MetadataOnly,
        capabilities: ScmCapability::git_like_profile(),
        workflow_semantics: ScmWorkflowSemantics {
            local_capture: ScmWorkflowPrimitive::Commit,
            shared_authority: ScmWorkflowPrimitive::Commit,
            review_boundary: Some(ScmWorkflowPrimitive::Branch),
        },
        required_command_scopes: vec![
            CommandScope::ReadOnlyInspection,
            CommandScope::ManagementStateWrite,
        ],
    }
}

/// Static Convergence descriptor used to prove non-Git semantics.
pub fn convergence_scm_driver_descriptor() -> ScmDriverDescriptor {
    ScmDriverDescriptor {
        id: ScmDriverId("scm:convergence".to_owned()),
        provider_kind: ScmProviderKind::Convergence,
        display_name: "Convergence".to_owned(),
        readiness: AdapterReadiness::Unknown,
        implementation_status: DriverImplementationStatus::MetadataOnly,
        capabilities: ScmCapability::convergence_like_profile(),
        workflow_semantics: ScmWorkflowSemantics {
            local_capture: ScmWorkflowPrimitive::Snapshot,
            shared_authority: ScmWorkflowPrimitive::Publication,
            review_boundary: Some(ScmWorkflowPrimitive::Gate),
        },
        required_command_scopes: vec![
            CommandScope::ReadOnlyInspection,
            CommandScope::ManagementStateWrite,
        ],
    }
}

/// Static GitHub descriptor used to keep forge concepts separate from SCM.
pub fn github_forge_driver_descriptor() -> ForgeDriverDescriptor {
    ForgeDriverDescriptor {
        id: ForgeDriverId("forge:github".to_owned()),
        provider_kind: ForgeProviderKind::GitHub,
        display_name: "GitHub".to_owned(),
        readiness: AdapterReadiness::NeedsConfiguration,
        implementation_status: DriverImplementationStatus::MetadataOnly,
        capabilities: vec![
            ForgeCapability::InspectRepository,
            ForgeCapability::InspectPullRequests,
            ForgeCapability::InspectIssues,
            ForgeCapability::InspectComments,
            ForgeCapability::CreatePullRequest,
            ForgeCapability::PostComment,
            ForgeCapability::UseCredentialReference,
            ForgeCapability::OpenReviewWorkflow,
            ForgeCapability::InspectReviewWorkflow,
            ForgeCapability::PollRefresh,
        ],
        supported_refresh_modes: vec![ForgeRefreshMode::Polling, ForgeRefreshMode::Webhook],
        required_command_scopes: vec![CommandScope::NetworkAccess],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lists_scm_and_forge_drivers_separately() {
        let registry = ScmForgeDriverRegistry::new()
            .with_scm_driver(git_scm_driver_descriptor())
            .with_scm_driver(convergence_scm_driver_descriptor())
            .with_forge_driver(github_forge_driver_descriptor());

        assert_eq!(registry.scm_drivers().len(), 2);
        assert_eq!(registry.forge_drivers().len(), 1);
        assert!(registry
            .forge_drivers()
            .iter()
            .all(|descriptor| !descriptor.display_name.is_empty()));
    }

    #[test]
    fn registry_resolves_git_and_convergence_with_distinct_semantics() {
        let registry = ScmForgeDriverRegistry::new()
            .with_scm_driver(git_scm_driver_descriptor())
            .with_scm_driver(convergence_scm_driver_descriptor());

        let git = registry
            .scm_driver(&ScmDriverId("scm:git".to_owned()))
            .expect("git descriptor");
        let convergence = registry
            .scm_driver(&ScmDriverId("scm:convergence".to_owned()))
            .expect("convergence descriptor");

        assert_eq!(git.provider_kind, ScmProviderKind::Git);
        assert_eq!(
            git.workflow_semantics.local_capture,
            ScmWorkflowPrimitive::Commit
        );
        assert_eq!(convergence.provider_kind, ScmProviderKind::Convergence);
        assert_eq!(
            convergence.workflow_semantics.local_capture,
            ScmWorkflowPrimitive::Snapshot
        );
        assert_eq!(
            convergence.workflow_semantics.shared_authority,
            ScmWorkflowPrimitive::Publication
        );
    }

    #[test]
    fn github_descriptor_is_forge_only() {
        let registry =
            ScmForgeDriverRegistry::new().with_forge_driver(github_forge_driver_descriptor());

        assert!(registry.scm_drivers().is_empty());
        assert!(registry
            .forge_driver(&ForgeDriverId("forge:github".to_owned()))
            .expect("github descriptor")
            .capabilities
            .contains(&ForgeCapability::CreatePullRequest));
    }
}
