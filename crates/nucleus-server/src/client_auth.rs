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

impl ClientAuthDeploymentPolicy {
    /// Evaluate whether a local client is allowed to use the server boundary.
    ///
    /// This is a readiness gate only. It does not authenticate credentials,
    /// create pairing records, open transports, or grant command approval.
    pub fn evaluate_local_client(
        &self,
        client: ClientIdentity,
        observed_posture: ClientAuthPosture,
    ) -> ClientAuthReadiness {
        let mut blockers = Vec::new();

        if !self.allowed_client_kinds.contains(&client.kind) {
            blockers.push(ClientAuthReadinessBlocker::UnsupportedClientKind {
                kind: client.kind.clone(),
            });
        }

        match observed_posture {
            ClientAuthPosture::UnpairedLocal => {
                if self.deployment_mode != DeploymentMode::LocalOnly {
                    blockers.push(ClientAuthReadinessBlocker::PairingRequired {
                        deployment_mode: self.deployment_mode.clone(),
                    });
                }
            }
            ClientAuthPosture::PairingRequired => {
                blockers.push(ClientAuthReadinessBlocker::PairingNotCompleted {
                    mode: self.pairing_mode.clone(),
                });
            }
            ClientAuthPosture::LoginRequired => {
                blockers.push(ClientAuthReadinessBlocker::RemoteAuthDeferred);
            }
            ClientAuthPosture::ManagedIdentityRequired => {
                blockers.push(ClientAuthReadinessBlocker::ManagedIdentityDeferred);
            }
            ClientAuthPosture::ServiceCredentialRefRequired => {
                blockers.push(ClientAuthReadinessBlocker::ServiceCredentialDeferred);
            }
            ClientAuthPosture::Revoked => {
                blockers.push(ClientAuthReadinessBlocker::Revoked);
            }
            ClientAuthPosture::Custom(ref reason) => {
                blockers.push(ClientAuthReadinessBlocker::Custom(reason.clone()));
            }
        }

        let status = if blockers.is_empty() {
            ClientAuthReadinessStatus::Ready
        } else if blockers.iter().any(ClientAuthReadinessBlocker::is_deferred) {
            ClientAuthReadinessStatus::Deferred
        } else {
            ClientAuthReadinessStatus::Denied
        };

        ClientAuthReadiness {
            client,
            observed_posture,
            status,
            blockers,
        }
    }
}

/// Local client auth readiness result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientAuthReadiness {
    pub client: ClientIdentity,
    pub observed_posture: ClientAuthPosture,
    pub status: ClientAuthReadinessStatus,
    pub blockers: Vec<ClientAuthReadinessBlocker>,
}

/// Readiness status for a client against the current deployment policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientAuthReadinessStatus {
    Ready,
    Denied,
    Deferred,
}

/// Reason a client cannot yet use the server boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientAuthReadinessBlocker {
    UnsupportedClientKind { kind: ClientKind },
    PairingRequired { deployment_mode: DeploymentMode },
    PairingNotCompleted { mode: ClientPairingMode },
    RemoteAuthDeferred,
    ManagedIdentityDeferred,
    ServiceCredentialDeferred,
    Revoked,
    Custom(String),
}

impl ClientAuthReadinessBlocker {
    fn is_deferred(&self) -> bool {
        matches!(
            self,
            Self::RemoteAuthDeferred
                | Self::ManagedIdentityDeferred
                | Self::ServiceCredentialDeferred
        )
    }
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
    fn local_only_policy_allows_unpaired_desktop_when_explicit() {
        let policy = ClientAuthDeploymentPolicy {
            deployment_mode: DeploymentMode::LocalOnly,
            allowed_client_kinds: vec![ClientKind::Desktop, ClientKind::Cli],
            default_posture: ClientAuthPosture::UnpairedLocal,
            pairing_mode: ClientPairingMode::Disabled,
            revocation_required: false,
        };

        let readiness =
            policy.evaluate_local_client(desktop_client(), ClientAuthPosture::UnpairedLocal);

        assert_eq!(readiness.status, ClientAuthReadinessStatus::Ready);
        assert!(readiness.blockers.is_empty());
    }

    #[test]
    fn local_gate_denies_unsupported_client_kind() {
        let policy = ClientAuthDeploymentPolicy {
            deployment_mode: DeploymentMode::LocalOnly,
            allowed_client_kinds: vec![ClientKind::Desktop],
            default_posture: ClientAuthPosture::UnpairedLocal,
            pairing_mode: ClientPairingMode::Disabled,
            revocation_required: false,
        };
        let client = ClientIdentity {
            id: ClientId("client:mobile".to_owned()),
            kind: ClientKind::Mobile,
            display_name: "mobile".to_owned(),
        };

        let readiness = policy.evaluate_local_client(client, ClientAuthPosture::UnpairedLocal);

        assert_eq!(readiness.status, ClientAuthReadinessStatus::Denied);
        assert!(matches!(
            readiness.blockers.first(),
            Some(ClientAuthReadinessBlocker::UnsupportedClientKind { .. })
        ));
    }

    #[test]
    fn local_gate_defers_remote_login_instead_of_implementing_it() {
        let policy = ClientAuthDeploymentPolicy {
            deployment_mode: DeploymentMode::InternetReachable,
            allowed_client_kinds: vec![ClientKind::Desktop],
            default_posture: ClientAuthPosture::LoginRequired,
            pairing_mode: ClientPairingMode::RemoteLogin,
            revocation_required: true,
        };

        let readiness =
            policy.evaluate_local_client(desktop_client(), ClientAuthPosture::LoginRequired);

        assert_eq!(readiness.status, ClientAuthReadinessStatus::Deferred);
        assert!(readiness
            .blockers
            .contains(&ClientAuthReadinessBlocker::RemoteAuthDeferred));
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
