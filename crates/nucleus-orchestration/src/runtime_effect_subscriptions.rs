//! Compile-only runtime effect subscription vocabulary.
//!
//! These records describe live delivery handshake and lifecycle posture only.
//! They do not implement transport, an event bus, replay service, persistence,
//! delivery acknowledgements, client caching, scheduling, or runtime execution.

use crate::host_identity::ClientIdentity;
use crate::runtime_effect_replay::{
    RuntimeEffectClientOrderingToken, RuntimeEffectReplayStorageGeneration,
};
use crate::runtime_effect_retention::RuntimeEffectReplayDeploymentProfile;

/// Stable server-owned subscription id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RuntimeEffectSubscriptionId(pub String);

/// Subscription handshake request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectSubscriptionHandshake {
    pub subscription_id: RuntimeEffectSubscriptionId,
    pub client: ClientIdentity,
    pub client_token: Option<RuntimeEffectClientOrderingToken>,
    pub deployment_profile: RuntimeEffectReplayDeploymentProfile,
}

/// Server-owned subscription lifecycle state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectSubscriptionState {
    Requested,
    ReplayCatchUpRequired(RuntimeEffectReplayStorageGeneration),
    Accepted,
    Live,
    Backpressure(RuntimeEffectBackpressurePosture),
    Interrupted(RuntimeEffectDisconnectReason),
    ReconnectRequired(RuntimeEffectReconnectRequirement),
    Closed,
    Rejected(String),
    Unsupported(String),
}

/// Delivery acknowledgement posture. Acknowledgements are client-rendering
/// hints, not authority over durable state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectDeliveryAcknowledgement {
    Received(RuntimeEffectClientOrderingToken),
    Rendered(RuntimeEffectClientOrderingToken),
    DroppedByClient(RuntimeEffectClientOrderingToken),
    Unsupported,
}

/// Backpressure posture for live delivery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectBackpressurePosture {
    SlowDelivery,
    ReplayCatchUpRequired,
    CompactTransientEvents,
    ReconnectRequired,
    Custom(String),
}

/// Disconnect reason for a subscription.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEffectDisconnectReason {
    ClientClosed,
    ServerClosed,
    NetworkInterrupted,
    Backpressure,
    StorageGenerationMismatch,
    UnsupportedDeploymentProfile,
    Custom(String),
}

/// Reconnect requirement after interruption or backpressure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEffectReconnectRequirement {
    pub from_token: Option<RuntimeEffectClientOrderingToken>,
    pub requires_replay_query: bool,
    pub reason: RuntimeEffectDisconnectReason,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_identity::ClientKind;
    use crate::runtime_effect_events::ServerEventSequence;

    #[test]
    fn subscription_handshake_reuses_replay_ordering_token_without_transport() {
        let handshake = RuntimeEffectSubscriptionHandshake {
            subscription_id: RuntimeEffectSubscriptionId("subscription:1".to_owned()),
            client: ClientIdentity {
                id: crate::host_identity::ClientId("client:desktop".to_owned()),
                kind: ClientKind::Desktop,
                display_name: "desktop".to_owned(),
            },
            client_token: Some(RuntimeEffectClientOrderingToken {
                sequence: ServerEventSequence(12),
                storage_generation: RuntimeEffectReplayStorageGeneration::Current(
                    "generation:1".to_owned(),
                ),
            }),
            deployment_profile: RuntimeEffectReplayDeploymentProfile::LocalOnly,
        };

        assert_eq!(
            handshake.subscription_id,
            RuntimeEffectSubscriptionId("subscription:1".to_owned())
        );
        assert!(handshake.client_token.is_some());
    }

    #[test]
    fn acknowledgement_is_distinct_from_reconnect_requirement() {
        let token = RuntimeEffectClientOrderingToken {
            sequence: ServerEventSequence(33),
            storage_generation: RuntimeEffectReplayStorageGeneration::Current(
                "generation:1".to_owned(),
            ),
        };

        let acknowledgement = RuntimeEffectDeliveryAcknowledgement::Rendered(token.clone());
        let reconnect = RuntimeEffectReconnectRequirement {
            from_token: Some(token),
            requires_replay_query: true,
            reason: RuntimeEffectDisconnectReason::Backpressure,
        };

        assert!(matches!(
            acknowledgement,
            RuntimeEffectDeliveryAcknowledgement::Rendered(_)
        ));
        assert!(reconnect.requires_replay_query);
    }
}
