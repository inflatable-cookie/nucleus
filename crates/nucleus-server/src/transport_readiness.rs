//! Local transport readiness vocabulary.
//!
//! These types describe bootstrap posture for local clients. They do not
//! implement HTTP, WebSocket, local sockets, named pipes, Tauri IPC, remote
//! pairing, request routing, or listener lifecycle.

use crate::client_auth::ClientAuthReadinessStatus;

/// Candidate local transport between a client and the server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalTransportCandidate {
    InProcess,
    TauriIpc,
    UnixDomainSocket,
    WindowsNamedPipe,
    LoopbackHttp,
    Custom(String),
}

/// Readiness result for one candidate transport.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalTransportReadiness {
    pub candidate: LocalTransportCandidate,
    pub status: LocalTransportReadinessStatus,
    pub blockers: Vec<LocalTransportReadinessBlocker>,
}

/// Coarse readiness status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalTransportReadinessStatus {
    Ready,
    Blocked,
    Deferred,
}

/// Reason a local transport is not ready.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalTransportReadinessBlocker {
    RequestHandlerMissing,
    StateQueriesMissing,
    CommandReceiptsMissing,
    AuthReadinessBlocked(ClientAuthReadinessStatus),
    PlatformUnsupported { reason: String },
    TransportImplementationDeferred,
    RemotePairingDeferred,
    Custom(String),
}

/// Desktop bootstrap profile before the Tauri app is scaffolded.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalClientBootstrapProfile {
    pub preferred_transport: LocalTransportCandidate,
    pub fallback_transports: Vec<LocalTransportCandidate>,
    pub requirements: Vec<DesktopBootstrapRequirement>,
}

impl LocalClientBootstrapProfile {
    /// Decide whether the desktop can bootstrap from the current transport
    /// readiness set.
    pub fn desktop_status(&self, readiness: &[LocalTransportReadiness]) -> DesktopBootstrapStatus {
        let preferred_ready = readiness.iter().any(|item| {
            item.candidate == self.preferred_transport
                && item.status == LocalTransportReadinessStatus::Ready
        });
        let fallback_ready = readiness.iter().any(|item| {
            self.fallback_transports.contains(&item.candidate)
                && item.status == LocalTransportReadinessStatus::Ready
        });

        if preferred_ready {
            DesktopBootstrapStatus::ReadyWithPreferredTransport
        } else if fallback_ready {
            DesktopBootstrapStatus::ReadyWithFallbackTransport
        } else if readiness
            .iter()
            .any(|item| item.status == LocalTransportReadinessStatus::Deferred)
        {
            DesktopBootstrapStatus::Deferred
        } else {
            DesktopBootstrapStatus::Blocked
        }
    }
}

/// Requirement the desktop shell needs before bootstrap.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DesktopBootstrapRequirement {
    LocalControlRequestHandler,
    ReadOnlyStateQueries,
    CommandReceipts,
    LocalAuthReadiness,
    EventReplayMetadata,
    TransportImplementation(LocalTransportCandidate),
    Custom(String),
}

/// Desktop bootstrap status derived from transport readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DesktopBootstrapStatus {
    ReadyWithPreferredTransport,
    ReadyWithFallbackTransport,
    Deferred,
    Blocked,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> LocalClientBootstrapProfile {
        LocalClientBootstrapProfile {
            preferred_transport: LocalTransportCandidate::TauriIpc,
            fallback_transports: vec![LocalTransportCandidate::InProcess],
            requirements: vec![
                DesktopBootstrapRequirement::LocalControlRequestHandler,
                DesktopBootstrapRequirement::ReadOnlyStateQueries,
                DesktopBootstrapRequirement::CommandReceipts,
                DesktopBootstrapRequirement::LocalAuthReadiness,
                DesktopBootstrapRequirement::EventReplayMetadata,
                DesktopBootstrapRequirement::TransportImplementation(
                    LocalTransportCandidate::TauriIpc,
                ),
            ],
        }
    }

    #[test]
    fn desktop_profile_prefers_tauri_ipc_when_ready() {
        let profile = profile();
        let readiness = [LocalTransportReadiness {
            candidate: LocalTransportCandidate::TauriIpc,
            status: LocalTransportReadinessStatus::Ready,
            blockers: Vec::new(),
        }];

        assert_eq!(
            profile.desktop_status(&readiness),
            DesktopBootstrapStatus::ReadyWithPreferredTransport
        );
    }

    #[test]
    fn desktop_profile_can_use_in_process_fallback_before_ipc() {
        let profile = profile();
        let readiness = [
            LocalTransportReadiness {
                candidate: LocalTransportCandidate::TauriIpc,
                status: LocalTransportReadinessStatus::Deferred,
                blockers: vec![LocalTransportReadinessBlocker::TransportImplementationDeferred],
            },
            LocalTransportReadiness {
                candidate: LocalTransportCandidate::InProcess,
                status: LocalTransportReadinessStatus::Ready,
                blockers: Vec::new(),
            },
        ];

        assert_eq!(
            profile.desktop_status(&readiness),
            DesktopBootstrapStatus::ReadyWithFallbackTransport
        );
    }

    #[test]
    fn desktop_profile_blocks_when_no_transport_is_ready() {
        let profile = profile();
        let readiness = [LocalTransportReadiness {
            candidate: LocalTransportCandidate::TauriIpc,
            status: LocalTransportReadinessStatus::Blocked,
            blockers: vec![LocalTransportReadinessBlocker::RequestHandlerMissing],
        }];

        assert_eq!(
            profile.desktop_status(&readiness),
            DesktopBootstrapStatus::Blocked
        );
    }
}
