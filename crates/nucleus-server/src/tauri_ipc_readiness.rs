//! Tauri IPC schema readiness vocabulary.
//!
//! These types name the IPC command schema expected by the future desktop
//! shell. They do not implement Tauri commands, IPC serialization, a desktop
//! app, or a transport listener.

use crate::control_serialization_readiness::{
    ControlApiSerializationReadiness, ControlApiSerializationReadinessStatus,
};
use crate::transport_readiness::{
    LocalTransportCandidate, LocalTransportReadiness, LocalTransportReadinessStatus,
};

/// Expected command shape for future Tauri IPC.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TauriIpcCommandSchema {
    pub commands: Vec<TauriIpcCommandShape>,
    pub uses_control_request_envelope: bool,
    pub uses_control_response_envelope: bool,
}

impl TauriIpcCommandSchema {
    /// First schema needed by the desktop shell.
    pub fn first_desktop_schema() -> Self {
        Self {
            commands: vec![
                TauriIpcCommandShape::SubmitControlRequest,
                TauriIpcCommandShape::GetBootstrapProfile,
                TauriIpcCommandShape::GetTransportReadiness,
            ],
            uses_control_request_envelope: true,
            uses_control_response_envelope: true,
        }
    }

    /// Assess whether the schema is ready against local transport readiness.
    pub fn assess(
        &self,
        transport: &LocalTransportReadiness,
        command_implementation_exists: bool,
        serialization_defined: bool,
    ) -> TauriIpcSchemaReadiness {
        let serialization = ControlApiSerializationReadiness {
            status: if serialization_defined {
                ControlApiSerializationReadinessStatus::Ready
            } else {
                ControlApiSerializationReadinessStatus::Deferred
            },
            blockers: Vec::new(),
        };
        self.assess_with_serialization(transport, command_implementation_exists, &serialization)
    }

    /// Assess schema readiness against explicit serialization readiness.
    pub fn assess_with_serialization(
        &self,
        transport: &LocalTransportReadiness,
        command_implementation_exists: bool,
        serialization: &ControlApiSerializationReadiness,
    ) -> TauriIpcSchemaReadiness {
        let mut blockers = Vec::new();

        if transport.candidate != LocalTransportCandidate::TauriIpc {
            blockers.push(TauriIpcSchemaReadinessBlocker::TransportMismatch {
                candidate: transport.candidate.clone(),
            });
        }
        if transport.status != LocalTransportReadinessStatus::Ready {
            blockers.push(TauriIpcSchemaReadinessBlocker::TransportNotReady);
        }
        if !self.uses_control_request_envelope || !self.uses_control_response_envelope {
            blockers.push(TauriIpcSchemaReadinessBlocker::ControlEnvelopeMissing);
        }
        if !self
            .commands
            .contains(&TauriIpcCommandShape::SubmitControlRequest)
        {
            blockers.push(TauriIpcSchemaReadinessBlocker::SubmitCommandMissing);
        }
        if !command_implementation_exists {
            blockers.push(TauriIpcSchemaReadinessBlocker::CommandImplementationDeferred);
        }
        if serialization.status != ControlApiSerializationReadinessStatus::Ready {
            blockers.push(TauriIpcSchemaReadinessBlocker::SerializationDeferred);
        }

        let status = if blockers.is_empty() {
            TauriIpcSchemaReadinessStatus::Ready
        } else if blockers
            .iter()
            .any(TauriIpcSchemaReadinessBlocker::is_deferred)
        {
            TauriIpcSchemaReadinessStatus::Deferred
        } else {
            TauriIpcSchemaReadinessStatus::Blocked
        };

        TauriIpcSchemaReadiness { status, blockers }
    }
}

/// Expected future Tauri command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TauriIpcCommandShape {
    SubmitControlRequest,
    GetBootstrapProfile,
    GetTransportReadiness,
    SubscribeRuntimeEvents,
    Custom(String),
}

/// Tauri IPC schema readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TauriIpcSchemaReadiness {
    pub status: TauriIpcSchemaReadinessStatus,
    pub blockers: Vec<TauriIpcSchemaReadinessBlocker>,
}

/// Tauri IPC schema readiness status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TauriIpcSchemaReadinessStatus {
    Ready,
    Blocked,
    Deferred,
}

/// Reason Tauri IPC schema is not ready.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TauriIpcSchemaReadinessBlocker {
    TransportMismatch { candidate: LocalTransportCandidate },
    TransportNotReady,
    ControlEnvelopeMissing,
    SubmitCommandMissing,
    CommandImplementationDeferred,
    SerializationDeferred,
    DesktopAppNotScaffolded,
    Custom(String),
}

impl TauriIpcSchemaReadinessBlocker {
    fn is_deferred(&self) -> bool {
        matches!(
            self,
            Self::CommandImplementationDeferred
                | Self::SerializationDeferred
                | Self::DesktopAppNotScaffolded
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_serialization_readiness::ControlApiSerializationReadinessPlan;
    use crate::transport_readiness::{
        LocalTransportReadinessBlocker, LocalTransportReadinessStatus,
    };

    #[test]
    fn first_desktop_schema_requires_control_request_and_response_envelopes() {
        let schema = TauriIpcCommandSchema::first_desktop_schema();

        assert!(schema.uses_control_request_envelope);
        assert!(schema.uses_control_response_envelope);
        assert!(schema
            .commands
            .contains(&TauriIpcCommandShape::SubmitControlRequest));
    }

    #[test]
    fn schema_readiness_is_deferred_until_ipc_implementation_and_serialization_exist() {
        let schema = TauriIpcCommandSchema::first_desktop_schema();
        let transport = LocalTransportReadiness {
            candidate: LocalTransportCandidate::TauriIpc,
            status: LocalTransportReadinessStatus::Ready,
            blockers: Vec::new(),
        };

        let readiness = schema.assess(&transport, false, false);

        assert_eq!(readiness.status, TauriIpcSchemaReadinessStatus::Deferred);
        assert!(readiness
            .blockers
            .contains(&TauriIpcSchemaReadinessBlocker::CommandImplementationDeferred));
        assert!(readiness
            .blockers
            .contains(&TauriIpcSchemaReadinessBlocker::SerializationDeferred));
    }

    #[test]
    fn schema_readiness_blocks_when_candidate_is_not_tauri_ipc() {
        let schema = TauriIpcCommandSchema::first_desktop_schema();
        let transport = LocalTransportReadiness {
            candidate: LocalTransportCandidate::InProcess,
            status: LocalTransportReadinessStatus::Ready,
            blockers: Vec::new(),
        };

        let readiness = schema.assess(&transport, true, true);

        assert_eq!(readiness.status, TauriIpcSchemaReadinessStatus::Blocked);
        assert!(matches!(
            readiness.blockers.first(),
            Some(TauriIpcSchemaReadinessBlocker::TransportMismatch { .. })
        ));
    }

    #[test]
    fn schema_readiness_includes_transport_not_ready_blocker() {
        let schema = TauriIpcCommandSchema::first_desktop_schema();
        let transport = LocalTransportReadiness {
            candidate: LocalTransportCandidate::TauriIpc,
            status: LocalTransportReadinessStatus::Blocked,
            blockers: vec![LocalTransportReadinessBlocker::TransportImplementationDeferred],
        };

        let readiness = schema.assess(&transport, true, true);

        assert!(readiness
            .blockers
            .contains(&TauriIpcSchemaReadinessBlocker::TransportNotReady));
    }

    #[test]
    fn schema_readiness_uses_control_api_serialization_readiness() {
        let schema = TauriIpcCommandSchema::first_desktop_schema();
        let transport = LocalTransportReadiness {
            candidate: LocalTransportCandidate::TauriIpc,
            status: LocalTransportReadinessStatus::Ready,
            blockers: Vec::new(),
        };
        let serialization = ControlApiSerializationReadinessPlan::first_tauri_ipc_plan()
            .assess(true, true, true, true, false);

        let readiness = schema.assess_with_serialization(&transport, true, &serialization);

        assert_eq!(readiness.status, TauriIpcSchemaReadinessStatus::Deferred);
        assert!(readiness
            .blockers
            .contains(&TauriIpcSchemaReadinessBlocker::SerializationDeferred));
    }
}
