//! Compile-only runtime effect transport selection vocabulary.
//!
//! These records describe transport families, selection criteria, capabilities,
//! and boundary guarantees only. They do not implement networking, an event
//! bus, auth, pairing, replay, subscription delivery, or runtime execution.

use crate::clients::ClientKind;
use crate::runtime_effect_retention::RuntimeEffectReplayDeploymentProfile;

/// Transport family that may carry replay and subscription traffic later.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectTransportFamily {
    LocalSocket,
    LoopbackHttp,
    LanHttp,
    RemoteHttp,
    Stream,
    Polling,
    Custom(String),
}

/// Descriptive transport profile. This is not an implementation binding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectTransportProfile {
    pub family: RuntimeEffectTransportFamily,
    pub deployment_profile: RuntimeEffectReplayDeploymentProfile,
    pub capabilities: Vec<RuntimeEffectTransportCapability>,
    pub guarantees: Vec<RuntimeEffectTransportBoundaryGuarantee>,
    pub auth_blockers: Vec<RuntimeEffectTransportAuthBlocker>,
}

/// Capability the transport family can support.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectTransportCapability {
    ReplayQueries,
    SubscriptionHandshake,
    LiveEvents,
    DeliveryAcknowledgements,
    ReconnectRequirements,
    BackpressureNotices,
    SanitizedWarnings,
    Custom(String),
}

/// Boundary guarantee a transport must preserve.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectTransportBoundaryGuarantee {
    PreserveServerEventIds,
    PreserveServerOrderingTokens,
    PreserveStorageGenerationPosture,
    PreserveReplayCatchUpRequirements,
    PreserveSubscriptionLifecycle,
    PreserveRetainedRefs,
    PreserveSanitizedSummaries,
    PreserveClientIdentity,
    PreserveDeploymentProfileLimits,
}

/// Criteria for choosing a transport later.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectTransportSelectionCriteria {
    pub deployment_profile: RuntimeEffectReplayDeploymentProfile,
    pub client_kind: ClientKind,
    pub needs_live_subscriptions: bool,
    pub supports_replay_only_mode: bool,
    pub auth_blockers: Vec<RuntimeEffectTransportAuthBlocker>,
}

/// Auth and pairing blockers that must be solved outside transport selection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectTransportAuthBlocker {
    LocalPairingUndefined,
    LanPairingUndefined,
    RemoteAuthUndefined,
    CredentialStorageUndefined,
    RevocationUndefined,
    ClientIdentityPolicyUndefined,
    Custom(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_profile_names_capabilities_without_networking() {
        let profile = RuntimeEffectTransportProfile {
            family: RuntimeEffectTransportFamily::LocalSocket,
            deployment_profile: RuntimeEffectReplayDeploymentProfile::LocalOnly,
            capabilities: vec![
                RuntimeEffectTransportCapability::ReplayQueries,
                RuntimeEffectTransportCapability::LiveEvents,
            ],
            guarantees: vec![
                RuntimeEffectTransportBoundaryGuarantee::PreserveServerEventIds,
                RuntimeEffectTransportBoundaryGuarantee::PreserveServerOrderingTokens,
            ],
            auth_blockers: vec![RuntimeEffectTransportAuthBlocker::LocalPairingUndefined],
        };

        assert_eq!(profile.family, RuntimeEffectTransportFamily::LocalSocket);
        assert_eq!(profile.capabilities.len(), 2);
    }

    #[test]
    fn selection_criteria_keeps_auth_blockers_separate() {
        let criteria = RuntimeEffectTransportSelectionCriteria {
            deployment_profile: RuntimeEffectReplayDeploymentProfile::InternetReachable,
            client_kind: ClientKind::Web,
            needs_live_subscriptions: true,
            supports_replay_only_mode: true,
            auth_blockers: vec![
                RuntimeEffectTransportAuthBlocker::RemoteAuthUndefined,
                RuntimeEffectTransportAuthBlocker::RevocationUndefined,
            ],
        };

        assert!(criteria.needs_live_subscriptions);
        assert_eq!(criteria.auth_blockers.len(), 2);
    }
}
