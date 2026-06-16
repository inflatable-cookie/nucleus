//! Static production adapter trait skeletons.
//!
//! These traits expose identity, capability, readiness, workflow, and required
//! command-scope information only. They do not refresh provider state, stream
//! events, execute commands, call networks, or integrate with a runtime
//! registry.

use nucleus_command_policy::CommandScope;

use crate::capabilities::{ForgeCapability, ScmCapability};
use crate::forge::ForgeProviderKind;
use crate::ids::{ForgeAdapterInstanceId, ScmAdapterInstanceId};
use crate::observations::{ForgeRefreshMode, ObservationEffect};
use crate::scm::{ScmProviderKind, ScmWorkflowSemantics};

/// Static readiness for an adapter surface.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterReadiness {
    Ready,
    NeedsConfiguration,
    MissingCredential,
    Unsupported,
    Unknown,
}

/// Static SCM adapter surface.
pub trait ScmAdapterSurface {
    fn adapter_instance_id(&self) -> &ScmAdapterInstanceId;
    fn provider_kind(&self) -> &ScmProviderKind;
    fn capabilities(&self) -> Vec<ScmCapability>;
    fn workflow_semantics(&self) -> &ScmWorkflowSemantics;
    fn readiness(&self) -> AdapterReadiness;
    fn required_command_scopes(&self) -> Vec<CommandScope>;
}

/// Static forge adapter surface.
pub trait ForgeAdapterSurface {
    fn adapter_instance_id(&self) -> &ForgeAdapterInstanceId;
    fn provider_kind(&self) -> &ForgeProviderKind;
    fn capabilities(&self) -> Vec<ForgeCapability>;
    fn readiness(&self) -> AdapterReadiness;
    fn required_command_scopes(&self) -> Vec<CommandScope>;
    fn supported_refresh_modes(&self) -> Vec<ForgeRefreshMode>;
}

/// Static observation source surface.
pub trait ObservationSourceSurface {
    fn observation_source_label(&self) -> &str;
    fn supported_observation_effects(&self) -> Vec<ObservationEffect>;
}

#[cfg(test)]
mod tests {
    use super::{
        AdapterReadiness, ForgeAdapterSurface, ObservationSourceSurface, ScmAdapterSurface,
    };
    use nucleus_command_policy::CommandScope;

    use crate::capabilities::{ForgeCapability, ScmCapability};
    use crate::forge::ForgeProviderKind;
    use crate::ids::{ForgeAdapterInstanceId, ScmAdapterInstanceId};
    use crate::observations::{ForgeRefreshMode, ObservationEffect};
    use crate::scm::{ScmProviderKind, ScmWorkflowPrimitive, ScmWorkflowSemantics};

    struct StaticScmAdapter {
        id: ScmAdapterInstanceId,
        provider_kind: ScmProviderKind,
        workflow: ScmWorkflowSemantics,
    }

    impl ScmAdapterSurface for StaticScmAdapter {
        fn adapter_instance_id(&self) -> &ScmAdapterInstanceId {
            &self.id
        }

        fn provider_kind(&self) -> &ScmProviderKind {
            &self.provider_kind
        }

        fn capabilities(&self) -> Vec<ScmCapability> {
            vec![
                ScmCapability::InspectRepository,
                ScmCapability::ClassifyConflicts,
            ]
        }

        fn workflow_semantics(&self) -> &ScmWorkflowSemantics {
            &self.workflow
        }

        fn readiness(&self) -> AdapterReadiness {
            AdapterReadiness::Ready
        }

        fn required_command_scopes(&self) -> Vec<CommandScope> {
            vec![
                CommandScope::ReadOnlyInspection,
                CommandScope::ManagementStateWrite,
            ]
        }
    }

    struct StaticForgeAdapter {
        id: ForgeAdapterInstanceId,
        provider_kind: ForgeProviderKind,
    }

    impl ForgeAdapterSurface for StaticForgeAdapter {
        fn adapter_instance_id(&self) -> &ForgeAdapterInstanceId {
            &self.id
        }

        fn provider_kind(&self) -> &ForgeProviderKind {
            &self.provider_kind
        }

        fn capabilities(&self) -> Vec<ForgeCapability> {
            vec![
                ForgeCapability::InspectPullRequests,
                ForgeCapability::VerifyWebhook,
            ]
        }

        fn readiness(&self) -> AdapterReadiness {
            AdapterReadiness::NeedsConfiguration
        }

        fn required_command_scopes(&self) -> Vec<CommandScope> {
            vec![CommandScope::NetworkAccess]
        }

        fn supported_refresh_modes(&self) -> Vec<ForgeRefreshMode> {
            vec![ForgeRefreshMode::Polling, ForgeRefreshMode::Webhook]
        }
    }

    struct StaticObservationSource;

    impl ObservationSourceSurface for StaticObservationSource {
        fn observation_source_label(&self) -> &str {
            "static-test-observation-source"
        }

        fn supported_observation_effects(&self) -> Vec<ObservationEffect> {
            vec![
                ObservationEffect::Informational,
                ObservationEffect::RequiresHumanReview,
            ]
        }
    }

    #[test]
    fn scm_trait_can_describe_non_git_workflow_without_effects() {
        let adapter = StaticScmAdapter {
            id: ScmAdapterInstanceId("test-scm".to_owned()),
            provider_kind: ScmProviderKind::Convergence,
            workflow: ScmWorkflowSemantics {
                local_capture: ScmWorkflowPrimitive::Snapshot,
                shared_authority: ScmWorkflowPrimitive::Publication,
                review_boundary: Some(ScmWorkflowPrimitive::Gate),
            },
        };

        assert_eq!(adapter.adapter_instance_id().0, "test-scm");
        assert_eq!(adapter.provider_kind(), &ScmProviderKind::Convergence);
        assert_eq!(
            adapter.workflow_semantics().local_capture,
            ScmWorkflowPrimitive::Snapshot
        );
        assert_eq!(adapter.readiness(), AdapterReadiness::Ready);
        assert!(adapter
            .required_command_scopes()
            .contains(&CommandScope::ManagementStateWrite));
    }

    #[test]
    fn forge_trait_can_describe_static_refresh_and_command_needs() {
        let adapter = StaticForgeAdapter {
            id: ForgeAdapterInstanceId("test-forge".to_owned()),
            provider_kind: ForgeProviderKind::Custom("test-forge".to_owned()),
        };

        assert_eq!(adapter.adapter_instance_id().0, "test-forge");
        assert_eq!(adapter.readiness(), AdapterReadiness::NeedsConfiguration);
        assert!(adapter
            .capabilities()
            .contains(&ForgeCapability::VerifyWebhook));
        assert!(adapter
            .required_command_scopes()
            .contains(&CommandScope::NetworkAccess));
        assert!(adapter
            .supported_refresh_modes()
            .contains(&ForgeRefreshMode::Webhook));
    }

    #[test]
    fn observation_source_trait_can_describe_effect_support() {
        let source = StaticObservationSource;

        assert_eq!(
            source.observation_source_label(),
            "static-test-observation-source"
        );
        assert!(source
            .supported_observation_effects()
            .contains(&ObservationEffect::RequiresHumanReview));
    }
}
