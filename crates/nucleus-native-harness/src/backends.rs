//! Native harness model backend records.

/// Stable native model backend id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeModelBackendId(pub String);

/// Model backend available to native personas.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeModelBackend {
    pub id: NativeModelBackendId,
    pub kind: NativeModelBackendKind,
    pub display_name: String,
    pub local: bool,
    pub deployment: NativeModelBackendDeployment,
    pub suitability: NativeModelBackendSuitability,
    pub status: NativeModelBackendStatus,
}

impl NativeModelBackend {
    /// Backend selection is descriptive. Authority comes from persona policy.
    pub fn authority_neutral(&self) -> bool {
        true
    }

    pub fn supports_local_only_policy(&self) -> bool {
        matches!(
            self.deployment,
            NativeModelBackendDeployment::LocalOnly | NativeModelBackendDeployment::Either
        )
    }

    pub fn supports_cloud_policy(&self) -> bool {
        matches!(
            self.deployment,
            NativeModelBackendDeployment::CloudOnly | NativeModelBackendDeployment::Either
        )
    }

    pub fn can_draft_proposals(&self) -> bool {
        self.status == NativeModelBackendStatus::Available
            && self.suitability.proposal_drafting != NativeModelBackendUse::Unsupported
    }
}

/// Native model backend kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeModelBackendKind {
    LocalInferenceServer,
    RustInferenceLibrary,
    CloudModelRoute(String),
    Sidecar(String),
    NoneDeterministicOnly,
    Unknown,
}

/// Deployment posture for model use.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeModelBackendDeployment {
    LocalOnly,
    CloudOnly,
    Either,
    Disabled,
    Unknown,
}

/// Suitability by native persona work type.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeModelBackendSuitability {
    pub deterministic_tools: NativeModelBackendUse,
    pub summarization: NativeModelBackendUse,
    pub classification: NativeModelBackendUse,
    pub proposal_drafting: NativeModelBackendUse,
}

impl NativeModelBackendSuitability {
    pub fn deterministic_only() -> Self {
        Self {
            deterministic_tools: NativeModelBackendUse::Preferred,
            summarization: NativeModelBackendUse::Unsupported,
            classification: NativeModelBackendUse::Unsupported,
            proposal_drafting: NativeModelBackendUse::Unsupported,
        }
    }

    pub fn lightweight_assistant() -> Self {
        Self {
            deterministic_tools: NativeModelBackendUse::Supported,
            summarization: NativeModelBackendUse::Supported,
            classification: NativeModelBackendUse::Preferred,
            proposal_drafting: NativeModelBackendUse::Supported,
        }
    }
}

/// Suitability level for a backend use.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeModelBackendUse {
    Preferred,
    Supported,
    Discouraged,
    Unsupported,
    Unknown,
}

/// Availability state for a backend descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeModelBackendStatus {
    Available,
    Disabled,
    Unconfigured,
    Unhealthy,
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backend(
        kind: NativeModelBackendKind,
        deployment: NativeModelBackendDeployment,
        status: NativeModelBackendStatus,
    ) -> NativeModelBackend {
        NativeModelBackend {
            id: NativeModelBackendId("backend:test".to_owned()),
            kind,
            display_name: "test backend".to_owned(),
            local: matches!(deployment, NativeModelBackendDeployment::LocalOnly),
            deployment,
            suitability: NativeModelBackendSuitability::lightweight_assistant(),
            status,
        }
    }

    #[test]
    fn backend_records_represent_deployment_posture() {
        let local = backend(
            NativeModelBackendKind::LocalInferenceServer,
            NativeModelBackendDeployment::LocalOnly,
            NativeModelBackendStatus::Available,
        );
        let cloud = backend(
            NativeModelBackendKind::CloudModelRoute("provider:policy-route".to_owned()),
            NativeModelBackendDeployment::CloudOnly,
            NativeModelBackendStatus::Available,
        );
        let either = backend(
            NativeModelBackendKind::Sidecar("policy-sidecar".to_owned()),
            NativeModelBackendDeployment::Either,
            NativeModelBackendStatus::Available,
        );
        let disabled = backend(
            NativeModelBackendKind::NoneDeterministicOnly,
            NativeModelBackendDeployment::Disabled,
            NativeModelBackendStatus::Disabled,
        );

        assert!(local.supports_local_only_policy());
        assert!(!local.supports_cloud_policy());
        assert!(cloud.supports_cloud_policy());
        assert!(!cloud.supports_local_only_policy());
        assert!(either.supports_local_only_policy());
        assert!(either.supports_cloud_policy());
        assert!(!disabled.can_draft_proposals());
    }

    #[test]
    fn backend_suitability_supports_later_small_model_experiments() {
        let mut local = backend(
            NativeModelBackendKind::RustInferenceLibrary,
            NativeModelBackendDeployment::LocalOnly,
            NativeModelBackendStatus::Available,
        );
        local.suitability = NativeModelBackendSuitability::lightweight_assistant();

        assert_eq!(
            local.suitability.classification,
            NativeModelBackendUse::Preferred
        );
        assert_eq!(
            local.suitability.proposal_drafting,
            NativeModelBackendUse::Supported
        );
        assert!(local.can_draft_proposals());
    }

    #[test]
    fn deterministic_only_backend_does_not_draft_proposals() {
        let mut backend = backend(
            NativeModelBackendKind::NoneDeterministicOnly,
            NativeModelBackendDeployment::Disabled,
            NativeModelBackendStatus::Available,
        );
        backend.suitability = NativeModelBackendSuitability::deterministic_only();

        assert_eq!(
            backend.suitability.deterministic_tools,
            NativeModelBackendUse::Preferred
        );
        assert!(!backend.can_draft_proposals());
        assert!(backend.authority_neutral());
    }
}
