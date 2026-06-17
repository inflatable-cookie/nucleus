//! Compile-only Codex app-server supervision boundary.
//!
//! These records describe whether Nucleus may consider starting a Codex
//! app-server process. They do not spawn Codex, open stdio, probe auth, read
//! provider payloads, or ingest live events.

use nucleus_agent_protocol::{
    project_codex_app_server_fixture, AdapterIdentity, AdapterRuntimeEvent,
    CodexAppServerEventFixture, CodexAppServerFixtureProjection, CodexFixtureMappingError,
    CodexRuntimeReceiptFixture,
};
use nucleus_projects::ProjectId;

use crate::client_auth_posture::ClientAuthDisposition;
use crate::client_protocol::{ClientProtocolProfile, CLIENT_PROTOCOL_VERSION_V1};
use crate::host_authority::{EngineHostId, ProjectAuthorityDomain, ProjectAuthorityMap};
use crate::process_control_backend::ProcessControlBackendReadiness;
use crate::transport_readiness::{LocalTransportReadiness, LocalTransportReadinessStatus};

/// Request to prepare a Nucleus-owned Codex app-server process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSupervisionRequest {
    pub project_id: ProjectId,
    pub execution_host_id: EngineHostId,
    pub adapter: AdapterIdentity,
    pub binary: CodexAppServerBinary,
    pub schema_evidence: CodexAppServerSchemaEvidenceRef,
    pub supervision_limits: CodexAppServerSupervisionLimits,
}

/// Codex binary descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerBinary {
    pub command: String,
    pub version_label: Option<String>,
    pub available: bool,
}

/// Non-payload evidence ref for schema/probe evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSchemaEvidenceRef {
    pub evidence_ref: String,
    pub codex_version: String,
    pub generated_json_schema: bool,
    pub generated_ts_bindings: bool,
}

/// Supervision limits before live process support exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSupervisionLimits {
    pub max_sessions: u16,
    pub allow_raw_provider_payload_storage: bool,
    pub allow_live_spawn: bool,
}

/// Input used to assess Codex app-server supervision readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSupervisionReadinessInput {
    pub request: CodexAppServerSupervisionRequest,
    pub authority_map: ProjectAuthorityMap,
    pub auth_disposition: ClientAuthDisposition,
    pub protocol_profile: ClientProtocolProfile,
    pub local_transport: LocalTransportReadiness,
    pub process_control: ProcessControlBackendReadiness,
}

/// Readiness result for Codex app-server supervision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSupervisionReadiness {
    pub request: CodexAppServerSupervisionRequest,
    pub status: CodexAppServerSupervisionReadinessStatus,
    pub blockers: Vec<CodexAppServerSupervisionBlocker>,
}

/// Coarse Codex supervision readiness status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerSupervisionReadinessStatus {
    Ready,
    Blocked,
}

/// Reason Codex app-server supervision is not ready.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerSupervisionBlocker {
    MissingBinary,
    MissingAuth,
    MissingExecutionAuthority,
    UnsupportedProtocol,
    TransportNotReady,
    ProcessControlNotReady,
    RawProviderPayloadStorageRequested,
    LiveSpawnNotEnabled,
}

/// Static Codex app-server handshake expectation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerHandshakeExpectation {
    pub minimum_version_label: String,
    pub required_client_requests: Vec<String>,
    pub required_server_notifications: Vec<String>,
    pub required_server_requests: Vec<String>,
    pub allow_experimental_user_input: bool,
}

impl CodexAppServerHandshakeExpectation {
    /// First supported method subset from the 2026-06-17 schema evidence.
    pub fn first_supported_subset() -> Self {
        Self {
            minimum_version_label: "codex-cli 0.140.0".to_owned(),
            required_client_requests: vec![
                "initialize".to_owned(),
                "thread/start".to_owned(),
                "thread/resume".to_owned(),
                "turn/start".to_owned(),
                "turn/interrupt".to_owned(),
            ],
            required_server_notifications: vec![
                "thread/started".to_owned(),
                "turn/started".to_owned(),
                "turn/completed".to_owned(),
                "item/started".to_owned(),
                "item/completed".to_owned(),
                "item/agentMessage/delta".to_owned(),
            ],
            required_server_requests: vec![
                "item/commandExecution/requestApproval".to_owned(),
                "item/fileChange/requestApproval".to_owned(),
                "item/permissions/requestApproval".to_owned(),
            ],
            allow_experimental_user_input: true,
        }
    }
}

/// Observed handshake/probe evidence before live work is admitted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerHandshakeObservation {
    pub version_label: Option<String>,
    pub auth_ready: bool,
    pub generated_json_schema: bool,
    pub generated_ts_bindings: bool,
    pub client_requests: Vec<String>,
    pub server_notifications: Vec<String>,
    pub server_requests: Vec<String>,
    pub experimental_server_requests: Vec<String>,
}

/// Handshake preflight outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerHandshakePreflight {
    pub status: CodexAppServerHandshakePreflightStatus,
    pub blockers: Vec<CodexAppServerHandshakeBlocker>,
}

/// Coarse handshake preflight status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerHandshakePreflightStatus {
    Ready,
    Blocked,
}

/// Reason handshake preflight is not ready.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerHandshakeBlocker {
    VersionUnknown,
    UnsupportedVersion { expected: String, observed: String },
    AuthNotReady,
    JsonSchemaMissing,
    TsBindingsMissing,
    RequiredMethodMissing { method: String },
    ExperimentalUserInputNotAllowed,
}

/// One live Codex app-server frame after protocol decoding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveFrame {
    pub fixture: CodexAppServerEventFixture,
    pub transport_sequence: u64,
}

/// Result of ingesting one live Codex frame.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveIngestion {
    pub sequence: u64,
    pub status: CodexAppServerLiveIngestionStatus,
    pub projection: Option<CodexAppServerLiveProjection>,
    pub unsupported: Option<CodexAppServerUnsupportedObservation>,
}

/// Live ingestion status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveIngestionStatus {
    Accepted,
    Unsupported,
}

/// Live projection into Nucleus-owned runtime surfaces.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveProjection {
    Event(AdapterRuntimeEvent),
    RuntimeReceipt(CodexRuntimeReceiptFixture),
}

/// Unsupported provider event observation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerUnsupportedObservation {
    pub method: String,
    pub provider_instance_id: String,
    pub sequence: u64,
    pub reason: String,
    pub raw_payload_policy: CodexRawPayloadPolicy,
}

/// Raw payload retention posture for live Codex ingestion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexRawPayloadPolicy {
    MetadataOnly,
    EvidenceRefOnly,
}

/// Ingest one decoded Codex app-server frame through the existing mapper.
pub fn ingest_codex_app_server_live_frame(
    frame: CodexAppServerLiveFrame,
) -> CodexAppServerLiveIngestion {
    let sequence = frame.transport_sequence;
    let provider_instance_id = frame.fixture.provider_instance_id.clone();
    let method = frame.fixture.method.clone();

    match project_codex_app_server_fixture(frame.fixture) {
        Ok(CodexAppServerFixtureProjection::Event(event)) => CodexAppServerLiveIngestion {
            sequence,
            status: CodexAppServerLiveIngestionStatus::Accepted,
            projection: Some(CodexAppServerLiveProjection::Event(event)),
            unsupported: None,
        },
        Ok(CodexAppServerFixtureProjection::RuntimeReceipt(receipt)) => {
            CodexAppServerLiveIngestion {
                sequence,
                status: CodexAppServerLiveIngestionStatus::Accepted,
                projection: Some(CodexAppServerLiveProjection::RuntimeReceipt(receipt)),
                unsupported: None,
            }
        }
        Err(CodexFixtureMappingError { reason, .. }) => CodexAppServerLiveIngestion {
            sequence,
            status: CodexAppServerLiveIngestionStatus::Unsupported,
            projection: None,
            unsupported: Some(CodexAppServerUnsupportedObservation {
                method,
                provider_instance_id,
                sequence,
                reason,
                raw_payload_policy: CodexRawPayloadPolicy::MetadataOnly,
            }),
        },
    }
}

/// Assess static handshake preflight evidence without opening stdio.
pub fn assess_codex_app_server_handshake(
    expectation: &CodexAppServerHandshakeExpectation,
    observation: &CodexAppServerHandshakeObservation,
) -> CodexAppServerHandshakePreflight {
    let mut blockers = Vec::new();

    match &observation.version_label {
        None => blockers.push(CodexAppServerHandshakeBlocker::VersionUnknown),
        Some(version) if version != &expectation.minimum_version_label => {
            blockers.push(CodexAppServerHandshakeBlocker::UnsupportedVersion {
                expected: expectation.minimum_version_label.clone(),
                observed: version.clone(),
            });
        }
        Some(_) => {}
    }

    if !observation.auth_ready {
        blockers.push(CodexAppServerHandshakeBlocker::AuthNotReady);
    }
    if !observation.generated_json_schema {
        blockers.push(CodexAppServerHandshakeBlocker::JsonSchemaMissing);
    }
    if !observation.generated_ts_bindings {
        blockers.push(CodexAppServerHandshakeBlocker::TsBindingsMissing);
    }

    missing_methods(
        &expectation.required_client_requests,
        &observation.client_requests,
        &mut blockers,
    );
    missing_methods(
        &expectation.required_server_notifications,
        &observation.server_notifications,
        &mut blockers,
    );
    missing_methods(
        &expectation.required_server_requests,
        &observation.server_requests,
        &mut blockers,
    );

    if observation
        .experimental_server_requests
        .iter()
        .any(|method| method == "item/tool/requestUserInput")
        && !expectation.allow_experimental_user_input
    {
        blockers.push(CodexAppServerHandshakeBlocker::ExperimentalUserInputNotAllowed);
    }

    let status = if blockers.is_empty() {
        CodexAppServerHandshakePreflightStatus::Ready
    } else {
        CodexAppServerHandshakePreflightStatus::Blocked
    };

    CodexAppServerHandshakePreflight { status, blockers }
}

fn missing_methods(
    required: &[String],
    observed: &[String],
    blockers: &mut Vec<CodexAppServerHandshakeBlocker>,
) {
    for method in required {
        if !observed.contains(method) {
            blockers.push(CodexAppServerHandshakeBlocker::RequiredMethodMissing {
                method: method.clone(),
            });
        }
    }
}

/// Assess Codex app-server supervision readiness without spawning.
pub fn assess_codex_app_server_supervision(
    input: CodexAppServerSupervisionReadinessInput,
) -> CodexAppServerSupervisionReadiness {
    let mut blockers = Vec::new();

    if !input.request.binary.available {
        blockers.push(CodexAppServerSupervisionBlocker::MissingBinary);
    }

    if input.auth_disposition != ClientAuthDisposition::Allowed {
        blockers.push(CodexAppServerSupervisionBlocker::MissingAuth);
    }

    let authority = input.authority_map.readiness_for(
        &input.request.execution_host_id,
        &ProjectAuthorityDomain::Execution,
    );
    if !authority.is_ready() {
        blockers.push(CodexAppServerSupervisionBlocker::MissingExecutionAuthority);
    }

    if input.protocol_profile.version != CLIENT_PROTOCOL_VERSION_V1
        || !input
            .protocol_profile
            .supports_message(crate::ClientProtocolMessageKind::ServerEvent)
    {
        blockers.push(CodexAppServerSupervisionBlocker::UnsupportedProtocol);
    }

    if input.local_transport.status != LocalTransportReadinessStatus::Ready {
        blockers.push(CodexAppServerSupervisionBlocker::TransportNotReady);
    }

    if !input.process_control.supports_future_spawn() {
        blockers.push(CodexAppServerSupervisionBlocker::ProcessControlNotReady);
    }

    if input
        .request
        .supervision_limits
        .allow_raw_provider_payload_storage
    {
        blockers.push(CodexAppServerSupervisionBlocker::RawProviderPayloadStorageRequested);
    }

    if !input.request.supervision_limits.allow_live_spawn {
        blockers.push(CodexAppServerSupervisionBlocker::LiveSpawnNotEnabled);
    }

    let status = if blockers.is_empty() {
        CodexAppServerSupervisionReadinessStatus::Ready
    } else {
        CodexAppServerSupervisionReadinessStatus::Blocked
    };

    CodexAppServerSupervisionReadiness {
        request: input.request,
        status,
        blockers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::{ProviderDriverKind, TransportFamily, VersionDiscovery};

    use nucleus_agent_protocol::{
        AgentSessionId, ApprovalScope, CodexAppServerFixturePayload, CodexAppServerProviderRefs,
    };

    use crate::process_control_backend::{
        ProcessControlBackendEvidenceRef, ProcessControlBackendKind,
    };
    use crate::transport_readiness::LocalTransportCandidate;

    fn host() -> EngineHostId {
        EngineHostId("host:local".to_owned())
    }

    fn request(allow_live_spawn: bool) -> CodexAppServerSupervisionRequest {
        CodexAppServerSupervisionRequest {
            project_id: ProjectId("project:nucleus".to_owned()),
            execution_host_id: host(),
            adapter: AdapterIdentity {
                adapter_id: "codex-app-server".to_owned(),
                provider_driver_kind: ProviderDriverKind::Codex,
                provider_instance_id: "codex:local-default".to_owned(),
                provider_name: "OpenAI Codex".to_owned(),
                harness_name: "Codex app-server".to_owned(),
                transport_family: TransportFamily::StructuredAppServerRuntime,
                version_discovery: VersionDiscovery::Command("codex --version".to_owned()),
                authentication_preflight: nucleus_agent_protocol::AuthenticationPreflight::Command(
                    "codex doctor --json".to_owned(),
                ),
            },
            binary: CodexAppServerBinary {
                command: "codex".to_owned(),
                version_label: Some("codex-cli 0.140.0".to_owned()),
                available: true,
            },
            schema_evidence: CodexAppServerSchemaEvidenceRef {
                evidence_ref: "evidence:codex-schema:2026-06-17".to_owned(),
                codex_version: "codex-cli 0.140.0".to_owned(),
                generated_json_schema: true,
                generated_ts_bindings: true,
            },
            supervision_limits: CodexAppServerSupervisionLimits {
                max_sessions: 1,
                allow_raw_provider_payload_storage: false,
                allow_live_spawn,
            },
        }
    }

    fn authority_map() -> ProjectAuthorityMap {
        ProjectAuthorityMap {
            project_id: ProjectId("project:nucleus".to_owned()),
            assignments: vec![crate::ProjectAuthorityAssignment {
                domain: ProjectAuthorityDomain::Execution,
                authoritative_host_id: host(),
                fallback_host_ids: Vec::new(),
                mutation_allowed: true,
                note: None,
            }],
        }
    }

    fn process_control() -> ProcessControlBackendReadiness {
        ProcessControlBackendReadiness {
            execution_host_id: host(),
            backend_kind: ProcessControlBackendKind::StdProcess,
            spawn_ready: true,
            timeout_ready: true,
            cancellation_ready: true,
            cleanup_ready: true,
            implementation_evidence_refs: vec![ProcessControlBackendEvidenceRef(
                "evidence:process-control".to_owned(),
            )],
            summary: Some("process control ready".to_owned()),
        }
    }

    fn transport() -> LocalTransportReadiness {
        LocalTransportReadiness {
            candidate: LocalTransportCandidate::InProcess,
            status: LocalTransportReadinessStatus::Ready,
            blockers: Vec::new(),
        }
    }

    fn provider_refs() -> CodexAppServerProviderRefs {
        CodexAppServerProviderRefs {
            thread_id: Some("codex-thread:1".to_owned()),
            session_id: None,
            turn_id: Some("codex-turn:1".to_owned()),
            item_id: Some("codex-item:1".to_owned()),
            request_id: Some("codex-request:1".to_owned()),
        }
    }

    fn frame(method: &str, payload: CodexAppServerFixturePayload) -> CodexAppServerLiveFrame {
        CodexAppServerLiveFrame {
            fixture: CodexAppServerEventFixture {
                method: method.to_owned(),
                provider_instance_id: "codex:local-default".to_owned(),
                nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
                provider_refs: provider_refs(),
                sequence: 7,
                payload,
                raw_payload: Some("raw payload omitted from live ingestion".to_owned()),
            },
            transport_sequence: 99,
        }
    }

    #[test]
    fn codex_live_ingestion_projects_supported_event_without_identity_collision() {
        let ingestion = ingest_codex_app_server_live_frame(frame(
            "item/agentMessage/delta",
            CodexAppServerFixturePayload::AgentMessageDelta {
                delta: "hello".to_owned(),
                accumulated: Some("hello".to_owned()),
            },
        ));

        assert_eq!(
            ingestion.status,
            CodexAppServerLiveIngestionStatus::Accepted
        );
        assert!(matches!(
            ingestion.projection,
            Some(CodexAppServerLiveProjection::Event(event))
                if event.identity.nucleus_event_id.contains("session:nucleus")
                    && event.identity.nucleus_session_id == "session:nucleus"
                    && event.identity.provider_turn_id.as_deref() == Some("codex-turn:1")
                    && event.identity.provider_item_id.as_deref() == Some("codex-item:1")
        ));
    }

    #[test]
    fn codex_live_ingestion_projects_runtime_receipt() {
        let ingestion = ingest_codex_app_server_live_frame(frame(
            "turn/interrupt",
            CodexAppServerFixturePayload::InterruptionReceipt {
                summary: "operator interrupted".to_owned(),
            },
        ));

        assert_eq!(
            ingestion.status,
            CodexAppServerLiveIngestionStatus::Accepted
        );
        assert!(matches!(
            ingestion.projection,
            Some(CodexAppServerLiveProjection::RuntimeReceipt(receipt))
                if receipt.summary == "operator interrupted"
        ));
    }

    #[test]
    fn codex_live_ingestion_records_unsupported_observation_without_raw_payload() {
        let ingestion = ingest_codex_app_server_live_frame(frame(
            "item/fileChange/requestApproval",
            CodexAppServerFixturePayload::ApprovalRequest {
                prompt: "approve file change".to_owned(),
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned(), "deny".to_owned()],
            },
        ));

        assert_eq!(
            ingestion.status,
            CodexAppServerLiveIngestionStatus::Unsupported
        );
        assert!(ingestion.projection.is_none());
        assert!(matches!(
            ingestion.unsupported,
            Some(CodexAppServerUnsupportedObservation {
                raw_payload_policy: CodexRawPayloadPolicy::MetadataOnly,
                ..
            })
        ));
    }

    fn handshake_observation() -> CodexAppServerHandshakeObservation {
        let expectation = CodexAppServerHandshakeExpectation::first_supported_subset();
        CodexAppServerHandshakeObservation {
            version_label: Some("codex-cli 0.140.0".to_owned()),
            auth_ready: true,
            generated_json_schema: true,
            generated_ts_bindings: true,
            client_requests: expectation.required_client_requests,
            server_notifications: expectation.required_server_notifications,
            server_requests: expectation.required_server_requests,
            experimental_server_requests: vec!["item/tool/requestUserInput".to_owned()],
        }
    }

    #[test]
    fn codex_handshake_preflight_accepts_known_schema_subset() {
        let expectation = CodexAppServerHandshakeExpectation::first_supported_subset();
        let observation = handshake_observation();

        let preflight = assess_codex_app_server_handshake(&expectation, &observation);

        assert_eq!(
            preflight.status,
            CodexAppServerHandshakePreflightStatus::Ready
        );
        assert!(preflight.blockers.is_empty());
    }

    #[test]
    fn codex_handshake_preflight_blocks_unknown_auth_or_version() {
        let expectation = CodexAppServerHandshakeExpectation::first_supported_subset();
        let mut observation = handshake_observation();
        observation.version_label = Some("codex-cli 0.999.0".to_owned());
        observation.auth_ready = false;

        let preflight = assess_codex_app_server_handshake(&expectation, &observation);

        assert_eq!(
            preflight.status,
            CodexAppServerHandshakePreflightStatus::Blocked
        );
        assert!(preflight
            .blockers
            .contains(&CodexAppServerHandshakeBlocker::AuthNotReady));
        assert!(preflight
            .blockers
            .contains(&CodexAppServerHandshakeBlocker::UnsupportedVersion {
                expected: "codex-cli 0.140.0".to_owned(),
                observed: "codex-cli 0.999.0".to_owned(),
            }));
    }

    #[test]
    fn codex_handshake_preflight_blocks_missing_required_methods() {
        let expectation = CodexAppServerHandshakeExpectation::first_supported_subset();
        let mut observation = handshake_observation();
        observation
            .client_requests
            .retain(|method| method != "turn/start");
        observation.server_requests.clear();

        let preflight = assess_codex_app_server_handshake(&expectation, &observation);

        assert_eq!(
            preflight.status,
            CodexAppServerHandshakePreflightStatus::Blocked
        );
        assert!(preflight.blockers.contains(
            &CodexAppServerHandshakeBlocker::RequiredMethodMissing {
                method: "turn/start".to_owned(),
            }
        ));
        assert!(preflight.blockers.contains(
            &CodexAppServerHandshakeBlocker::RequiredMethodMissing {
                method: "item/commandExecution/requestApproval".to_owned(),
            }
        ));
    }

    #[test]
    fn codex_supervision_readiness_can_be_ready_without_spawning() {
        let readiness =
            assess_codex_app_server_supervision(CodexAppServerSupervisionReadinessInput {
                request: request(true),
                authority_map: authority_map(),
                auth_disposition: ClientAuthDisposition::Allowed,
                protocol_profile: ClientProtocolProfile::v1_control_and_events(),
                local_transport: transport(),
                process_control: process_control(),
            });

        assert_eq!(
            readiness.status,
            CodexAppServerSupervisionReadinessStatus::Ready
        );
        assert!(readiness.blockers.is_empty());
        assert!(
            !readiness
                .request
                .supervision_limits
                .allow_raw_provider_payload_storage
        );
    }

    #[test]
    fn codex_supervision_blocks_missing_binary_auth_and_authority() {
        let mut request = request(true);
        request.binary.available = false;
        let readiness =
            assess_codex_app_server_supervision(CodexAppServerSupervisionReadinessInput {
                request,
                authority_map: ProjectAuthorityMap {
                    project_id: ProjectId("project:nucleus".to_owned()),
                    assignments: Vec::new(),
                },
                auth_disposition: ClientAuthDisposition::Deferred,
                protocol_profile: ClientProtocolProfile::v1_control_and_events(),
                local_transport: transport(),
                process_control: process_control(),
            });

        assert_eq!(
            readiness.status,
            CodexAppServerSupervisionReadinessStatus::Blocked
        );
        assert!(readiness
            .blockers
            .contains(&CodexAppServerSupervisionBlocker::MissingBinary));
        assert!(readiness
            .blockers
            .contains(&CodexAppServerSupervisionBlocker::MissingAuth));
        assert!(readiness
            .blockers
            .contains(&CodexAppServerSupervisionBlocker::MissingExecutionAuthority));
    }

    #[test]
    fn codex_supervision_blocks_transport_process_and_raw_payload_storage() {
        let mut request = request(false);
        request
            .supervision_limits
            .allow_raw_provider_payload_storage = true;
        let mut process_control = process_control();
        process_control.cancellation_ready = false;
        let readiness =
            assess_codex_app_server_supervision(CodexAppServerSupervisionReadinessInput {
                request,
                authority_map: authority_map(),
                auth_disposition: ClientAuthDisposition::Allowed,
                protocol_profile: ClientProtocolProfile::v1_control_and_events(),
                local_transport: LocalTransportReadiness {
                    candidate: LocalTransportCandidate::TauriIpc,
                    status: LocalTransportReadinessStatus::Deferred,
                    blockers: Vec::new(),
                },
                process_control,
            });

        assert!(readiness
            .blockers
            .contains(&CodexAppServerSupervisionBlocker::TransportNotReady));
        assert!(readiness
            .blockers
            .contains(&CodexAppServerSupervisionBlocker::ProcessControlNotReady));
        assert!(readiness
            .blockers
            .contains(&CodexAppServerSupervisionBlocker::RawProviderPayloadStorageRequested));
        assert!(readiness
            .blockers
            .contains(&CodexAppServerSupervisionBlocker::LiveSpawnNotEnabled));
    }
}
