use super::*;
use nucleus_agent_protocol::{
    AdapterIdentity, CodexAppServerEventFixture, ProviderDriverKind, TransportFamily,
    VersionDiscovery,
};

use nucleus_agent_protocol::{
    AgentSessionId, ApprovalScope, CodexAppServerFixturePayload, CodexAppServerProviderRefs,
};
use nucleus_projects::ProjectId;

use crate::client_auth_posture::ClientAuthDisposition;
use crate::client_protocol::ClientProtocolProfile;
use crate::host_authority::{EngineHostId, ProjectAuthorityDomain, ProjectAuthorityMap};
use crate::process_control_backend::{
    ProcessControlBackendEvidenceRef, ProcessControlBackendKind, ProcessControlBackendReadiness,
};
use crate::transport_readiness::{
    LocalTransportCandidate, LocalTransportReadiness, LocalTransportReadinessStatus,
};

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
