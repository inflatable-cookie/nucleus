use std::path::PathBuf;
use std::time::Duration;

use nucleus_command_policy::{
    CommandArtifactPayloadClass, CommandArtifactRef, CommandCancellationPolicy,
    CommandCleanupFailurePolicy, CommandEnvironmentPolicy, CommandEvidenceRef, CommandInvocation,
    CommandOutputBoundPolicy, CommandOutputRetention, CommandPolicyDecisionRef,
    CommandProcessInterruptionContract, CommandProcessSupervisionReadiness,
    CommandProcessSupervisionReadinessStatus, CommandProcessSupervisionSurface, CommandRequestId,
    CommandSandboxEnforcement, CommandSandboxProfile, CommandTimeoutPolicy,
    CommandTimeoutStartPolicy,
};
use nucleus_projects::ProjectId;
use tempfile::tempdir;

use super::*;
use crate::{
    accept_process_supervision_request, evaluate_host_spawn_readiness_from_discovery,
    unsupported_local_host_runtime_discovery, EngineHostId, HostSpawnReadinessBlocker,
    HostSpawnReadinessStatus, ProcessControlBackendKind, ProcessEventTransportBackendKind,
    ProcessInterruptionHostContract, ProjectAuthorityAssignment, ProjectAuthorityDomain,
    ProjectAuthorityMap, SandboxBackendKind, ServerEventSequence,
};

fn host() -> EngineHostId {
    EngineHostId("host:local".to_owned())
}

fn project_id() -> ProjectId {
    ProjectId("project:nucleus".to_owned())
}

fn metadata_record(payload_class: CommandArtifactPayloadClass) -> LocalArtifactMetadataRecord {
    LocalArtifactMetadataRecord {
        id: LocalArtifactMetadataId("artifact:metadata:1".to_owned()),
        artifact_ref: CommandArtifactRef("artifact:summary:1".to_owned()),
        command_request_id: CommandRequestId("command:request:1".to_owned()),
        payload_class,
        declared_payload_bytes: 128,
        retention_evidence_ref: ArtifactStoreBackendEvidenceRef(
            "evidence:artifact:retention".to_owned(),
        ),
        redaction_evidence_ref: ArtifactStoreBackendEvidenceRef(
            "evidence:artifact:redaction".to_owned(),
        ),
        summary: Some("sanitized validation summary".to_owned()),
    }
}

fn authority_map() -> ProjectAuthorityMap {
    ProjectAuthorityMap {
        project_id: project_id(),
        assignments: vec![ProjectAuthorityAssignment {
            domain: ProjectAuthorityDomain::Execution,
            authoritative_host_id: host(),
            fallback_host_ids: Vec::new(),
            mutation_allowed: true,
            note: Some("local execution authority".to_owned()),
        }],
    }
}

fn invocation(command_request_id: CommandRequestId) -> CommandInvocation {
    CommandInvocation {
        command_request_id,
        executable: "rg".to_owned(),
        argv: vec!["TODO".to_owned()],
        working_directory: PathBuf::from("."),
        timeout: Duration::from_secs(5),
        stdout_limit_bytes: 16 * 1024,
        stderr_limit_bytes: 16 * 1024,
        environment_policy: CommandEnvironmentPolicy::MinimalInheritedSafe,
        sandbox: CommandSandboxProfile::NoFilesystemWrite,
        output_retention: CommandOutputRetention::SummaryOnly,
    }
}

fn accepted_supervisor_decision() -> crate::ProcessSupervisorAcceptanceDecision {
    let command_request_id = CommandRequestId("command:request:artifact-gate".to_owned());
    let readiness = CommandProcessSupervisionReadiness {
        command_request_id: command_request_id.clone(),
        invocation: Some(invocation(command_request_id)),
        status: CommandProcessSupervisionReadinessStatus::Ready,
        surfaces: vec![
            CommandProcessSupervisionSurface::StructuredInvocation,
            CommandProcessSupervisionSurface::SandboxEnforcement,
            CommandProcessSupervisionSurface::Timeout,
            CommandProcessSupervisionSurface::Cancellation,
            CommandProcessSupervisionSurface::OutputCapture,
        ],
        blockers: Vec::new(),
        timeout_policy: Some(CommandTimeoutPolicy::RequiredFinite),
        cancellation_policy: Some(CommandCancellationPolicy::Cooperative),
        output_bound_policy: Some(CommandOutputBoundPolicy::Truncate),
        sandbox_enforcement: Some(CommandSandboxEnforcement::Enforced),
        summary: Some("supervision ready".to_owned()),
    };

    accept_process_supervision_request(crate::ProcessSupervisorAcceptanceRequest {
        project_id: project_id(),
        execution_host_id: host(),
        authority_map: authority_map(),
        readiness,
        evidence_ref: Some(CommandEvidenceRef("evidence:artifact-gate".to_owned())),
        policy_decision_ref: Some(CommandPolicyDecisionRef("policy:accepted".to_owned())),
        first_sequence: ServerEventSequence(20),
        summary: Some("accepted for artifact gate composition".to_owned()),
    })
}

fn interruption_contract() -> ProcessInterruptionHostContract {
    ProcessInterruptionHostContract {
        execution_host_id: host(),
        contract: CommandProcessInterruptionContract {
            timeout_policy: CommandTimeoutPolicy::RequiredFinite,
            timeout_start_policy: CommandTimeoutStartPolicy::BeforeSpawnAttempt,
            cancellation_policy: CommandCancellationPolicy::Cooperative,
            cleanup_failure_policy: CommandCleanupFailurePolicy::EmitCleanupFailedEvent,
            finite_timeout_required: true,
            terminal_event_required: true,
            retry_classification_policy_aware: true,
            summary: Some("ready interruption contract".to_owned()),
        },
        implementation_ref: Some("process-control:future".to_owned()),
    }
}

#[test]
fn local_backend_reports_readiness_after_metadata_directory_exists() {
    let temp_dir = tempdir().expect("temp dir");
    let backend = LocalArtifactStoreBackend::new(host(), temp_dir.path());

    assert!(!backend
        .readiness()
        .supports_payload_class(&CommandArtifactPayloadClass::SanitizedSummary));

    backend.prepare_metadata_store().expect("prepare store");
    let readiness = backend.readiness();

    assert!(readiness.supports_payload_class(&CommandArtifactPayloadClass::SanitizedSummary));
    assert!(readiness.supports_payload_class(&CommandArtifactPayloadClass::ValidationReport));
    assert!(!readiness.supports_payload_class(&CommandArtifactPayloadClass::Stdout));
    assert!(!readiness.retention_evidence_refs.is_empty());
    assert!(!readiness.redaction_evidence_refs.is_empty());
}

#[test]
fn metadata_store_round_trips_sanitized_records_without_payload_bytes() {
    let temp_dir = tempdir().expect("temp dir");
    let backend = LocalArtifactStoreBackend::new(host(), temp_dir.path());
    let store = backend.prepare_metadata_store().expect("prepare store");
    let record = metadata_record(CommandArtifactPayloadClass::SanitizedSummary);

    let path = store.write_metadata(&record).expect("write metadata");
    let restored = store.read_metadata(&record.id).expect("read metadata");
    let json = std::fs::read_to_string(path).expect("metadata json");

    assert_eq!(restored, record);
    assert!(!json.contains("raw_stdout"));
    assert!(!json.contains("raw_stderr"));
    assert!(!json.contains("terminal_stream"));
    assert!(!json.contains("credential"));
    assert!(!json.contains("password"));
}

#[test]
fn metadata_store_rejects_raw_payload_classes_and_secret_markers() {
    let temp_dir = tempdir().expect("temp dir");
    let backend = LocalArtifactStoreBackend::new(host(), temp_dir.path());
    let store = backend.prepare_metadata_store().expect("prepare store");
    let raw = metadata_record(CommandArtifactPayloadClass::Stdout);
    let mut secret_summary = metadata_record(CommandArtifactPayloadClass::SanitizedSummary);
    secret_summary.summary = Some("contains api_key material".to_owned());

    assert_eq!(
        store.write_metadata(&raw).expect_err("raw class rejected"),
        LocalArtifactStoreError::UnsupportedPayloadClass(CommandArtifactPayloadClass::Stdout)
    );
    assert_eq!(
        store
            .write_metadata(&secret_summary)
            .expect_err("secret marker rejected"),
        LocalArtifactStoreError::SecretMaterialMarkerDetected("api_key".to_owned())
    );
}

#[test]
fn artifact_readiness_composes_with_runtime_discovery_without_enabling_spawn() {
    let temp_dir = tempdir().expect("temp dir");
    let backend = LocalArtifactStoreBackend::new(host(), temp_dir.path());
    backend.prepare_metadata_store().expect("prepare store");
    let discovery = with_local_artifact_store_readiness(
        unsupported_local_host_runtime_discovery(host()),
        backend.readiness(),
    )
    .expect("compose artifact readiness");

    assert_eq!(discovery.status, LocalHostRuntimeDiscoveryStatus::Degraded);
    assert!(discovery
        .artifact_store_backend
        .supports_payload_class(&CommandArtifactPayloadClass::SanitizedSummary));
    assert!(!discovery.findings.contains(
        &LocalHostRuntimeDiscoveryFinding::ArtifactStoreBackendUnsupported(
            ArtifactStoreBackendKind::None
        )
    ));

    let authority = authority_map().readiness_for(&host(), &ProjectAuthorityDomain::Execution);
    let gate =
        evaluate_host_spawn_readiness_from_discovery(crate::LocalHostRuntimeDiscoveryGateInput {
            discovery,
            project_id: project_id(),
            authority_readiness: authority,
            supervisor_decision: accepted_supervisor_decision(),
            requested_sandbox_profile: CommandSandboxProfile::NoFilesystemWrite,
            required_artifact_payload_classes: vec![CommandArtifactPayloadClass::SanitizedSummary],
            interruption_contract: Some(interruption_contract()),
            summary: Some("artifact-backed discovery gate".to_owned()),
        });

    assert_eq!(gate.status, HostSpawnReadinessStatus::Blocked);
    assert_eq!(
        gate.blockers,
        vec![
            HostSpawnReadinessBlocker::SandboxBackendNotReady(SandboxBackendKind::None),
            HostSpawnReadinessBlocker::EventTransportBackendNotReady(
                ProcessEventTransportBackendKind::None
            ),
            HostSpawnReadinessBlocker::ProcessControlBackendNotReady(
                ProcessControlBackendKind::None
            ),
        ]
    );
}

#[test]
fn artifact_readiness_composition_rejects_host_mismatch() {
    let temp_dir = tempdir().expect("temp dir");
    let backend =
        LocalArtifactStoreBackend::new(EngineHostId("host:other".to_owned()), temp_dir.path());

    assert_eq!(
        with_local_artifact_store_readiness(
            unsupported_local_host_runtime_discovery(host()),
            backend.readiness()
        )
        .expect_err("host mismatch"),
        LocalArtifactStoreError::HostMismatch {
            expected: host(),
            actual: EngineHostId("host:other".to_owned()),
        }
    );
}
