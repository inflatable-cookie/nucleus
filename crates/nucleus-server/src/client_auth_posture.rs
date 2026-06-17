//! Client-visible auth posture projection records.
//!
//! These records explain access posture to clients. They do not implement
//! credential exchange, pairing flows, command approval, provider credential
//! access, or secret material storage.

use crate::client_auth::{
    ClientAuthPosture, ClientAuthReadiness, ClientAuthReadinessBlocker, ClientAuthReadinessStatus,
    ClientAuthSessionId, ClientPairingMode,
};
use crate::clients::ClientIdentity;

/// Client-visible auth posture record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientAuthPostureRecord {
    pub client: ClientIdentity,
    pub posture: ClientAuthPosture,
    pub disposition: ClientAuthDisposition,
    pub pairing_mode: ClientPairingMode,
    pub session: ClientAuthSessionPublication,
    pub credential_ref: Option<ClientCredentialReference>,
    pub command_approval: ClientCommandApprovalBoundary,
    pub provider_credentials: ProviderCredentialBoundary,
    pub reasons: Vec<ClientAuthPostureReason>,
}

impl ClientAuthPostureRecord {
    /// Build a client-visible record from an auth readiness result.
    pub fn from_readiness(
        readiness: ClientAuthReadiness,
        pairing_mode: ClientPairingMode,
        session: ClientAuthSessionPublication,
        credential_ref: Option<ClientCredentialReference>,
    ) -> Self {
        let disposition = ClientAuthDisposition::from_readiness(&readiness);
        let reasons = readiness
            .blockers
            .iter()
            .map(ClientAuthPostureReason::from)
            .collect();

        Self {
            client: readiness.client,
            posture: readiness.observed_posture,
            disposition,
            pairing_mode,
            session,
            credential_ref,
            command_approval: ClientCommandApprovalBoundary::SeparateApprovalRequired,
            provider_credentials: ProviderCredentialBoundary::SeparateCredentialBoundary,
            reasons,
        }
    }
}

/// Client-facing access disposition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientAuthDisposition {
    Allowed,
    Blocked,
    Deferred,
    Revoked,
}

impl ClientAuthDisposition {
    fn from_readiness(readiness: &ClientAuthReadiness) -> Self {
        if readiness.observed_posture == ClientAuthPosture::Revoked
            || readiness
                .blockers
                .contains(&ClientAuthReadinessBlocker::Revoked)
        {
            return Self::Revoked;
        }

        match readiness.status {
            ClientAuthReadinessStatus::Ready => Self::Allowed,
            ClientAuthReadinessStatus::Denied => Self::Blocked,
            ClientAuthReadinessStatus::Deferred => Self::Deferred,
        }
    }
}

/// Client-visible session publication.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientAuthSessionPublication {
    Active {
        session_id: ClientAuthSessionId,
    },
    Missing,
    Deferred {
        reason: String,
    },
    Revoked {
        session_id: Option<ClientAuthSessionId>,
    },
}

/// Non-secret credential reference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientCredentialReference {
    pub reference: String,
    pub scope: ClientCredentialReferenceScope,
}

/// Scope of a non-secret credential reference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientCredentialReferenceScope {
    ClientAuth,
    ServiceBootstrap,
    ManagedIdentity,
    Custom(String),
}

/// Command approval remains separate from client authentication.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientCommandApprovalBoundary {
    SeparateApprovalRequired,
}

/// Provider credential access remains separate from client authentication.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCredentialBoundary {
    SeparateCredentialBoundary,
}

/// Client-visible reason for a posture disposition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientAuthPostureReason {
    UnsupportedClientKind,
    PairingRequired,
    PairingNotCompleted,
    RemoteAuthDeferred,
    ManagedIdentityDeferred,
    ServiceCredentialDeferred,
    Revoked,
    Custom(String),
}

impl From<&ClientAuthReadinessBlocker> for ClientAuthPostureReason {
    fn from(blocker: &ClientAuthReadinessBlocker) -> Self {
        match blocker {
            ClientAuthReadinessBlocker::UnsupportedClientKind { .. } => Self::UnsupportedClientKind,
            ClientAuthReadinessBlocker::PairingRequired { .. } => Self::PairingRequired,
            ClientAuthReadinessBlocker::PairingNotCompleted { .. } => Self::PairingNotCompleted,
            ClientAuthReadinessBlocker::RemoteAuthDeferred => Self::RemoteAuthDeferred,
            ClientAuthReadinessBlocker::ManagedIdentityDeferred => Self::ManagedIdentityDeferred,
            ClientAuthReadinessBlocker::ServiceCredentialDeferred => {
                Self::ServiceCredentialDeferred
            }
            ClientAuthReadinessBlocker::Revoked => Self::Revoked,
            ClientAuthReadinessBlocker::Custom(reason) => Self::Custom(reason.clone()),
        }
    }
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
    fn client_auth_posture_record_can_render_allowed_local_access() {
        let readiness = ClientAuthReadiness {
            client: desktop_client(),
            observed_posture: ClientAuthPosture::UnpairedLocal,
            status: ClientAuthReadinessStatus::Ready,
            blockers: Vec::new(),
        };

        let record = ClientAuthPostureRecord::from_readiness(
            readiness,
            ClientPairingMode::Disabled,
            ClientAuthSessionPublication::Missing,
            None,
        );

        assert_eq!(record.disposition, ClientAuthDisposition::Allowed);
        assert_eq!(
            record.command_approval,
            ClientCommandApprovalBoundary::SeparateApprovalRequired
        );
        assert_eq!(
            record.provider_credentials,
            ProviderCredentialBoundary::SeparateCredentialBoundary
        );
        assert!(record.credential_ref.is_none());
    }

    #[test]
    fn client_auth_posture_record_can_render_deferred_remote_login() {
        let readiness = ClientAuthReadiness {
            client: desktop_client(),
            observed_posture: ClientAuthPosture::LoginRequired,
            status: ClientAuthReadinessStatus::Deferred,
            blockers: vec![ClientAuthReadinessBlocker::RemoteAuthDeferred],
        };

        let record = ClientAuthPostureRecord::from_readiness(
            readiness,
            ClientPairingMode::RemoteLogin,
            ClientAuthSessionPublication::Deferred {
                reason: "remote login not implemented".to_owned(),
            },
            None,
        );

        assert_eq!(record.disposition, ClientAuthDisposition::Deferred);
        assert!(record
            .reasons
            .contains(&ClientAuthPostureReason::RemoteAuthDeferred));
    }

    #[test]
    fn client_auth_posture_record_keeps_credential_material_out_of_state() {
        let readiness = ClientAuthReadiness {
            client: desktop_client(),
            observed_posture: ClientAuthPosture::ServiceCredentialRefRequired,
            status: ClientAuthReadinessStatus::Deferred,
            blockers: vec![ClientAuthReadinessBlocker::ServiceCredentialDeferred],
        };

        let record = ClientAuthPostureRecord::from_readiness(
            readiness,
            ClientPairingMode::ServiceBootstrap,
            ClientAuthSessionPublication::Missing,
            Some(ClientCredentialReference {
                reference: "credential-ref:service-bootstrap".to_owned(),
                scope: ClientCredentialReferenceScope::ServiceBootstrap,
            }),
        );

        assert_eq!(record.disposition, ClientAuthDisposition::Deferred);
        assert_eq!(
            record.credential_ref.as_ref().map(|item| &item.reference),
            Some(&"credential-ref:service-bootstrap".to_owned())
        );
    }

    #[test]
    fn client_auth_posture_record_can_render_revocation() {
        let session_id = ClientAuthSessionId("session:1".to_owned());
        let readiness = ClientAuthReadiness {
            client: desktop_client(),
            observed_posture: ClientAuthPosture::Revoked,
            status: ClientAuthReadinessStatus::Denied,
            blockers: vec![ClientAuthReadinessBlocker::Revoked],
        };

        let record = ClientAuthPostureRecord::from_readiness(
            readiness,
            ClientPairingMode::Disabled,
            ClientAuthSessionPublication::Revoked {
                session_id: Some(session_id),
            },
            None,
        );

        assert_eq!(record.disposition, ClientAuthDisposition::Revoked);
        assert!(record.reasons.contains(&ClientAuthPostureReason::Revoked));
    }
}
