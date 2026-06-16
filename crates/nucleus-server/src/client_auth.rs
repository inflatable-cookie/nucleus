//! Compile-only client auth and pairing vocabulary.
//!
//! These records describe server-owned client identity, pairing, session, and
//! revocation posture only. They do not implement auth, pairing flows, secret
//! storage, transport, command approval, provider credentials, or runtime
//! execution.

use crate::clients::{ClientIdentity, ClientKind};
use crate::deployment::DeploymentMode;

/// Stable auth record id for a client identity.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ClientAuthRecordId(pub String);

/// Stable pairing record id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ClientPairingId(pub String);

/// Stable client auth session id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ClientAuthSessionId(pub String);

/// Required auth posture for a client or deployment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientAuthPosture {
    UnpairedLocal,
    PairingRequired,
    LoginRequired,
    ManagedIdentityRequired,
    ServiceCredentialRefRequired,
    Revoked,
    Custom(String),
}

/// Pairing mode without choosing a concrete auth mechanism.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientPairingMode {
    LocalInteractive,
    LanPairing,
    RemoteLogin,
    ManagedInvite,
    ServiceBootstrap,
    Disabled,
    Custom(String),
}

/// Deployment-level auth and pairing policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientAuthDeploymentPolicy {
    pub deployment_mode: DeploymentMode,
    pub allowed_client_kinds: Vec<ClientKind>,
    pub default_posture: ClientAuthPosture,
    pub pairing_mode: ClientPairingMode,
    pub revocation_required: bool,
}

/// Durable non-secret pairing record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientPairingRecord {
    pub id: ClientPairingId,
    pub client: ClientIdentity,
    pub mode: ClientPairingMode,
    pub posture: ClientAuthPosture,
    pub credential_ref: Option<String>,
}

/// Durable non-secret auth session record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientAuthSessionRecord {
    pub id: ClientAuthSessionId,
    pub auth_record_id: ClientAuthRecordId,
    pub client: ClientIdentity,
    pub posture: ClientAuthPosture,
    pub revoked: bool,
}

/// Durable non-secret revocation evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientRevocationRecord {
    pub auth_record_id: ClientAuthRecordId,
    pub session_id: Option<ClientAuthSessionId>,
    pub reason: String,
    pub requires_subscription_disconnect: bool,
    pub invalidates_replay_tokens: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ClientId, ClientKind};

    fn desktop_client() -> ClientIdentity {
        ClientIdentity {
            id: ClientId("client:desktop".to_owned()),
            kind: ClientKind::Desktop,
            display_name: "desktop".to_owned(),
        }
    }

    #[test]
    fn deployment_policy_names_pairing_without_auth_mechanism() {
        let policy = ClientAuthDeploymentPolicy {
            deployment_mode: DeploymentMode::LocalNetwork,
            allowed_client_kinds: vec![ClientKind::Desktop, ClientKind::Mobile],
            default_posture: ClientAuthPosture::PairingRequired,
            pairing_mode: ClientPairingMode::LanPairing,
            revocation_required: true,
        };

        assert_eq!(policy.pairing_mode, ClientPairingMode::LanPairing);
        assert!(policy.revocation_required);
    }

    #[test]
    fn revocation_evidence_can_disconnect_subscriptions_without_secrets() {
        let session = ClientAuthSessionRecord {
            id: ClientAuthSessionId("session:1".to_owned()),
            auth_record_id: ClientAuthRecordId("auth:1".to_owned()),
            client: desktop_client(),
            posture: ClientAuthPosture::PairingRequired,
            revoked: false,
        };

        let revocation = ClientRevocationRecord {
            auth_record_id: session.auth_record_id.clone(),
            session_id: Some(session.id),
            reason: "operator revoked client".to_owned(),
            requires_subscription_disconnect: true,
            invalidates_replay_tokens: true,
        };

        assert!(revocation.requires_subscription_disconnect);
        assert!(revocation.invalidates_replay_tokens);
    }
}
