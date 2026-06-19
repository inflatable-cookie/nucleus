//! Server-owned provider service runtime records.
//!
//! These records describe ownership of provider command and event lanes. They
//! do not start providers, send commands, mutate tasks, or store credentials.

use nucleus_agent_protocol::{
    AdapterCommandStreamState, AdapterEventStreamState, AdapterIdentity,
    AdapterRuntimeOwnershipMode, AgentSessionId, RuntimeProcessOwner,
};
use nucleus_projects::ProjectId;

use crate::host_authority::EngineHostId;

/// Stable id for a server-side provider service.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderServiceId(pub String);

/// Stable id for a provider command lane owned by a service.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderCommandLaneId(pub String);

/// Stable id for a provider event stream owned by a service.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderRuntimeStreamId(pub String);

/// Stable id for a provider reactor readiness record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderReactorId(pub String);

/// Service-owned runtime boundary for one configured provider instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderServiceOwnershipRecord {
    pub service_id: ProviderServiceId,
    pub project_id: Option<ProjectId>,
    pub execution_host_id: EngineHostId,
    pub adapter: AdapterIdentity,
    pub ownership_mode: AdapterRuntimeOwnershipMode,
    pub process_owner: RuntimeProcessOwner,
    pub command_lane: ProviderCommandLaneRecord,
    pub event_streams: Vec<ProviderRuntimeStreamOwnershipRecord>,
    pub reactor: ProviderReactorReadinessRecord,
    pub client_command_authority: bool,
    pub task_mutation_authority: bool,
    pub evidence_refs: Vec<String>,
}

/// Command lane that a provider service owns.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCommandLaneRecord {
    pub lane_id: ProviderCommandLaneId,
    pub service_id: ProviderServiceId,
    pub state: AdapterCommandStreamState,
    pub accepted_families: Vec<ProviderCommandFamily>,
    pub pending_commands: u32,
    pub backpressure_summary: Option<String>,
}

/// Coarse command families a provider service may route later.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandFamily {
    StartSession,
    ResumeSession,
    StartTurn,
    InterruptTurn,
    RespondToProviderCallback,
    RecoverSession,
    ProviderSpecific(String),
}

/// Ownership record for a provider runtime stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRuntimeStreamOwnershipRecord {
    pub stream_id: ProviderRuntimeStreamId,
    pub service_id: ProviderServiceId,
    pub session_id: Option<AgentSessionId>,
    pub kind: ProviderRuntimeStreamKind,
    pub state: AdapterEventStreamState,
    pub owner: ProviderRuntimeStreamOwner,
    pub ordering_scope: ProviderRuntimeOrderingScope,
    pub recovery_required: bool,
}

/// Runtime stream kind owned by a provider service.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderRuntimeStreamKind {
    ProviderEvents,
    ProviderCallbacks,
    Diagnostics,
    TerminalFallback,
    ProviderSpecific(String),
}

/// Local owner of a provider runtime stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderRuntimeStreamOwner {
    ProviderService,
    ExternalHarness,
    ClientTerminalView,
    Unknown,
}

/// Ordering scope claimed for a runtime stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderRuntimeOrderingScope {
    TotalPerSession,
    TotalPerRuntimeProcess,
    PartialProviderOrder,
    ProjectionOnly,
    Unknown,
}

/// Reactor readiness for a provider service.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderReactorReadinessRecord {
    pub reactor_id: ProviderReactorId,
    pub service_id: ProviderServiceId,
    pub state: ProviderReactorReadinessState,
    pub blockers: Vec<ProviderReactorBlocker>,
    pub can_start_provider: bool,
    pub can_mutate_tasks: bool,
}

/// Provider reactor readiness state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderReactorReadinessState {
    Planned,
    ReadyForCommands,
    Blocked,
    Draining,
    Stopped,
}

/// Why a provider reactor is not ready.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderReactorBlocker {
    MissingRuntimeInstance,
    MissingAuth,
    MissingExecutionAuthority,
    TransportUnavailable,
    ProcessControlUnavailable,
    RuntimeStreamUnavailable,
    ProviderCapabilityUnsupported(String),
}

/// Build a service-owned runtime record from explicit ownership inputs.
pub fn provider_service_ownership_record(
    input: ProviderServiceOwnershipInput,
) -> ProviderServiceOwnershipRecord {
    let ProviderServiceOwnershipInput {
        service_id,
        project_id,
        execution_host_id,
        adapter,
        ownership_mode,
        process_owner,
        command_state,
        event_state,
        reactor_state,
        reactor_blockers,
        evidence_refs,
    } = input;

    let command_lane = ProviderCommandLaneRecord {
        lane_id: ProviderCommandLaneId(format!("provider-command-lane:{}", service_id.0)),
        service_id: service_id.clone(),
        state: command_state,
        accepted_families: Vec::new(),
        pending_commands: 0,
        backpressure_summary: None,
    };
    let event_stream = ProviderRuntimeStreamOwnershipRecord {
        stream_id: ProviderRuntimeStreamId(format!("provider-event-stream:{}", service_id.0)),
        service_id: service_id.clone(),
        session_id: None,
        kind: ProviderRuntimeStreamKind::ProviderEvents,
        state: event_state,
        owner: ProviderRuntimeStreamOwner::ProviderService,
        ordering_scope: ProviderRuntimeOrderingScope::TotalPerSession,
        recovery_required: false,
    };
    let reactor = ProviderReactorReadinessRecord {
        reactor_id: ProviderReactorId(format!("provider-reactor:{}", service_id.0)),
        service_id: service_id.clone(),
        can_start_provider: matches!(
            reactor_state,
            ProviderReactorReadinessState::ReadyForCommands
        ) && reactor_blockers.is_empty(),
        can_mutate_tasks: false,
        state: reactor_state,
        blockers: reactor_blockers,
    };

    ProviderServiceOwnershipRecord {
        service_id,
        project_id,
        execution_host_id,
        adapter,
        ownership_mode,
        process_owner,
        command_lane,
        event_streams: vec![event_stream],
        reactor,
        client_command_authority: false,
        task_mutation_authority: false,
        evidence_refs,
    }
}

/// Inputs for a provider service ownership record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderServiceOwnershipInput {
    pub service_id: ProviderServiceId,
    pub project_id: Option<ProjectId>,
    pub execution_host_id: EngineHostId,
    pub adapter: AdapterIdentity,
    pub ownership_mode: AdapterRuntimeOwnershipMode,
    pub process_owner: RuntimeProcessOwner,
    pub command_state: AdapterCommandStreamState,
    pub event_state: AdapterEventStreamState,
    pub reactor_state: ProviderReactorReadinessState,
    pub reactor_blockers: Vec<ProviderReactorBlocker>,
    pub evidence_refs: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::{
        AuthenticationPreflight, ProviderDriverKind, TransportFamily, VersionDiscovery,
    };

    #[test]
    fn provider_service_ownership_is_separate_from_client_authority() {
        let record = provider_service_ownership_record(ProviderServiceOwnershipInput {
            service_id: ProviderServiceId("provider-service:codex:local".to_owned()),
            project_id: Some(ProjectId("project:1".to_owned())),
            execution_host_id: EngineHostId("host:local".to_owned()),
            adapter: codex_adapter(),
            ownership_mode: AdapterRuntimeOwnershipMode::NucleusOwnedLocalServer,
            process_owner: RuntimeProcessOwner::Nucleus,
            command_state: AdapterCommandStreamState::Accepting,
            event_state: AdapterEventStreamState::Open,
            reactor_state: ProviderReactorReadinessState::ReadyForCommands,
            reactor_blockers: Vec::new(),
            evidence_refs: vec!["evidence:codex-schema".to_owned()],
        });

        assert_eq!(
            record.adapter.provider_instance_id,
            "codex:local-default".to_owned()
        );
        assert_eq!(
            record.ownership_mode,
            AdapterRuntimeOwnershipMode::NucleusOwnedLocalServer
        );
        assert_eq!(record.process_owner, RuntimeProcessOwner::Nucleus);
        assert!(record.reactor.can_start_provider);
        assert!(!record.client_command_authority);
        assert!(!record.task_mutation_authority);
        assert!(!record.reactor.can_mutate_tasks);
    }

    #[test]
    fn stream_ownership_and_reactor_blockers_are_explicit() {
        let record = provider_service_ownership_record(ProviderServiceOwnershipInput {
            service_id: ProviderServiceId("provider-service:codex:blocked".to_owned()),
            project_id: None,
            execution_host_id: EngineHostId("host:local".to_owned()),
            adapter: codex_adapter(),
            ownership_mode: AdapterRuntimeOwnershipMode::NucleusOwnedLocalServer,
            process_owner: RuntimeProcessOwner::Nucleus,
            command_state: AdapterCommandStreamState::Closed,
            event_state: AdapterEventStreamState::NotStarted,
            reactor_state: ProviderReactorReadinessState::Blocked,
            reactor_blockers: vec![
                ProviderReactorBlocker::MissingAuth,
                ProviderReactorBlocker::TransportUnavailable,
            ],
            evidence_refs: Vec::new(),
        });

        assert_eq!(
            record.command_lane.lane_id,
            ProviderCommandLaneId(
                "provider-command-lane:provider-service:codex:blocked".to_owned()
            )
        );
        assert_eq!(record.event_streams.len(), 1);
        assert_eq!(
            record.event_streams[0].owner,
            ProviderRuntimeStreamOwner::ProviderService
        );
        assert_eq!(
            record.event_streams[0].ordering_scope,
            ProviderRuntimeOrderingScope::TotalPerSession
        );
        assert!(!record.reactor.can_start_provider);
        assert_eq!(record.reactor.blockers.len(), 2);
    }

    fn codex_adapter() -> AdapterIdentity {
        AdapterIdentity {
            adapter_id: "codex-app-server".to_owned(),
            provider_driver_kind: ProviderDriverKind::Codex,
            provider_instance_id: "codex:local-default".to_owned(),
            provider_name: "OpenAI Codex".to_owned(),
            harness_name: "Codex app-server".to_owned(),
            transport_family: TransportFamily::StructuredAppServerRuntime,
            version_discovery: VersionDiscovery::Command("codex --version".to_owned()),
            authentication_preflight: AuthenticationPreflight::Command(
                "codex doctor --json".to_owned(),
            ),
        }
    }
}
