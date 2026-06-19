//! Codex live spawn smoke request records.
//!
//! These records gate the first live Codex process smoke path. They do not
//! spawn Codex, send provider turns, answer callbacks, or mutate task state.

use std::time::Duration;

use super::runtime_instance::{
    CodexAppServerPayloadRetentionPolicy, CodexAppServerRuntimeInstanceRecord,
};
use super::spawn_intent::{
    CodexAppServerSpawnIntentAdmission, CodexAppServerSpawnIntentAdmissionStatus,
};

/// Stable id for one Codex live spawn smoke request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerLiveSpawnSmokeRequestId(pub String);

/// Explicit cleanup behavior for the smoke request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveSpawnSmokeCleanupPolicy {
    TerminateAfterStartupProbe,
    TerminateOnTimeout,
}

/// Required limits for the smoke request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveSpawnSmokeLimits {
    pub timeout: Duration,
    pub stdout_limit_bytes: usize,
    pub stderr_limit_bytes: usize,
    pub cleanup_policy: CodexAppServerLiveSpawnSmokeCleanupPolicy,
    pub payload_retention: CodexAppServerPayloadRetentionPolicy,
}

/// Constrained request for a live Codex spawn smoke attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveSpawnSmokeRequest {
    request_id: CodexAppServerLiveSpawnSmokeRequestId,
    runtime_instance_id: String,
    spawn_intent_id: String,
    binary_command: String,
    argv: Vec<String>,
    endpoint_label: String,
    limits: CodexAppServerLiveSpawnSmokeLimits,
    evidence_refs: Vec<String>,
}

/// Rejection before a smoke request can exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveSpawnSmokeRequestRejection {
    SpawnIntentNotAccepted(String),
    RuntimeMismatch {
        runtime_instance_id: String,
        admission_runtime_instance_id: String,
    },
    MissingTimeout,
    UnboundedStdout,
    UnboundedStderr,
    RawPayloadRetentionNotAllowed,
}

/// Build a live spawn smoke request from accepted spawn intent and explicit
/// bounded limits.
pub fn codex_live_spawn_smoke_request(
    runtime: &CodexAppServerRuntimeInstanceRecord,
    admission: &CodexAppServerSpawnIntentAdmission,
    limits: CodexAppServerLiveSpawnSmokeLimits,
) -> Result<CodexAppServerLiveSpawnSmokeRequest, CodexAppServerLiveSpawnSmokeRequestRejection> {
    validate_smoke_request(runtime, admission, &limits)?;

    Ok(CodexAppServerLiveSpawnSmokeRequest {
        request_id: CodexAppServerLiveSpawnSmokeRequestId(format!(
            "codex-live-spawn-smoke:{}",
            admission.intent_id.0
        )),
        runtime_instance_id: runtime.runtime_instance_id.0.clone(),
        spawn_intent_id: admission.intent_id.0.clone(),
        binary_command: runtime.binary.command.clone(),
        argv: vec!["app-server".to_owned()],
        endpoint_label: runtime.endpoint_label.clone(),
        limits,
        evidence_refs: admission.evidence_refs.clone(),
    })
}

impl CodexAppServerLiveSpawnSmokeRequest {
    pub fn request_id(&self) -> &CodexAppServerLiveSpawnSmokeRequestId {
        &self.request_id
    }

    pub fn runtime_instance_id(&self) -> &str {
        &self.runtime_instance_id
    }

    pub fn spawn_intent_id(&self) -> &str {
        &self.spawn_intent_id
    }

    pub fn binary_command(&self) -> &str {
        &self.binary_command
    }

    pub fn argv(&self) -> &[String] {
        &self.argv
    }

    pub fn endpoint_label(&self) -> &str {
        &self.endpoint_label
    }

    pub fn limits(&self) -> &CodexAppServerLiveSpawnSmokeLimits {
        &self.limits
    }

    pub fn evidence_refs(&self) -> &[String] {
        &self.evidence_refs
    }
}

fn validate_smoke_request(
    runtime: &CodexAppServerRuntimeInstanceRecord,
    admission: &CodexAppServerSpawnIntentAdmission,
    limits: &CodexAppServerLiveSpawnSmokeLimits,
) -> Result<(), CodexAppServerLiveSpawnSmokeRequestRejection> {
    if runtime.runtime_instance_id.0 != admission.runtime_instance_id {
        return Err(
            CodexAppServerLiveSpawnSmokeRequestRejection::RuntimeMismatch {
                runtime_instance_id: runtime.runtime_instance_id.0.clone(),
                admission_runtime_instance_id: admission.runtime_instance_id.clone(),
            },
        );
    }

    if let CodexAppServerSpawnIntentAdmissionStatus::Blocked(reason) = &admission.status {
        return Err(
            CodexAppServerLiveSpawnSmokeRequestRejection::SpawnIntentNotAccepted(reason.clone()),
        );
    }

    if limits.timeout.is_zero() {
        return Err(CodexAppServerLiveSpawnSmokeRequestRejection::MissingTimeout);
    }

    if limits.stdout_limit_bytes == 0 {
        return Err(CodexAppServerLiveSpawnSmokeRequestRejection::UnboundedStdout);
    }

    if limits.stderr_limit_bytes == 0 {
        return Err(CodexAppServerLiveSpawnSmokeRequestRejection::UnboundedStderr);
    }

    if limits.payload_retention == CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed
    {
        return Err(CodexAppServerLiveSpawnSmokeRequestRejection::RawPayloadRetentionNotAllowed);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_spawn_intent, codex_runtime_instance_from_supervision_request,
        CodexAppServerBinary, CodexAppServerRuntimeInstanceState, CodexAppServerSchemaEvidenceRef,
        CodexAppServerSupervisionLimits, CodexAppServerSupervisionReadiness,
        CodexAppServerSupervisionReadinessStatus, CodexAppServerSupervisionRequest,
    };
    use crate::host_authority::EngineHostId;
    use nucleus_agent_protocol::{
        AdapterIdentity, AuthenticationPreflight, ProviderDriverKind, TransportFamily,
        VersionDiscovery,
    };
    use nucleus_projects::ProjectId;

    fn runtime() -> CodexAppServerRuntimeInstanceRecord {
        codex_runtime_instance_from_supervision_request(
            &request(false),
            CodexAppServerRuntimeInstanceState::ReadyForSpawn,
        )
    }

    fn request(allow_raw_payloads: bool) -> CodexAppServerSupervisionRequest {
        CodexAppServerSupervisionRequest {
            project_id: ProjectId("project:1".to_owned()),
            execution_host_id: EngineHostId("host:local".to_owned()),
            adapter: AdapterIdentity {
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
            },
            binary: CodexAppServerBinary {
                command: "codex".to_owned(),
                version_label: Some("codex-cli 0.140.0".to_owned()),
                available: true,
            },
            schema_evidence: CodexAppServerSchemaEvidenceRef {
                evidence_ref: "evidence:codex-schema".to_owned(),
                codex_version: "codex-cli 0.140.0".to_owned(),
                generated_json_schema: true,
                generated_ts_bindings: true,
            },
            supervision_limits: CodexAppServerSupervisionLimits {
                max_sessions: 1,
                allow_raw_provider_payload_storage: allow_raw_payloads,
                allow_live_spawn: true,
            },
        }
    }

    fn readiness() -> CodexAppServerSupervisionReadiness {
        CodexAppServerSupervisionReadiness {
            request: request(false),
            status: CodexAppServerSupervisionReadinessStatus::Ready,
            blockers: Vec::new(),
        }
    }

    fn limits() -> CodexAppServerLiveSpawnSmokeLimits {
        CodexAppServerLiveSpawnSmokeLimits {
            timeout: Duration::from_secs(2),
            stdout_limit_bytes: 1024,
            stderr_limit_bytes: 1024,
            cleanup_policy: CodexAppServerLiveSpawnSmokeCleanupPolicy::TerminateAfterStartupProbe,
            payload_retention: CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        }
    }

    #[test]
    fn smoke_request_requires_accepted_spawn_intent_and_explicit_limits() {
        let runtime = runtime();
        let admission = admit_codex_spawn_intent(&runtime, &readiness());
        let request =
            codex_live_spawn_smoke_request(&runtime, &admission, limits()).expect("smoke request");

        assert!(request.request_id().0.contains(&admission.intent_id.0));
        assert_eq!(
            request.runtime_instance_id(),
            runtime.runtime_instance_id.0.as_str()
        );
        assert_eq!(request.spawn_intent_id(), admission.intent_id.0.as_str());
        assert_eq!(request.binary_command(), "codex");
        assert_eq!(request.argv(), &["app-server".to_owned()]);
        assert_eq!(request.endpoint_label(), "stdio://codex-app-server");
        assert_eq!(
            request.evidence_refs(),
            &["evidence:codex-schema".to_owned()]
        );
        assert_eq!(request.limits().stdout_limit_bytes, 1024);
    }

    #[test]
    fn smoke_request_rejects_blocked_spawn_intent() {
        let runtime = codex_runtime_instance_from_supervision_request(
            &request(false),
            CodexAppServerRuntimeInstanceState::Planned,
        );
        let admission = admit_codex_spawn_intent(&runtime, &readiness());
        let rejection =
            codex_live_spawn_smoke_request(&runtime, &admission, limits()).expect_err("rejected");

        assert!(matches!(
            rejection,
            CodexAppServerLiveSpawnSmokeRequestRejection::SpawnIntentNotAccepted(_)
        ));
    }

    #[test]
    fn smoke_request_rejects_unbounded_or_raw_payload_limits() {
        let runtime = runtime();
        let admission = admit_codex_spawn_intent(&runtime, &readiness());

        let mut unbounded = limits();
        unbounded.stdout_limit_bytes = 0;
        assert_eq!(
            codex_live_spawn_smoke_request(&runtime, &admission, unbounded).expect_err("rejected"),
            CodexAppServerLiveSpawnSmokeRequestRejection::UnboundedStdout
        );

        let mut raw_payloads = limits();
        raw_payloads.payload_retention =
            CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed;
        assert_eq!(
            codex_live_spawn_smoke_request(&runtime, &admission, raw_payloads)
                .expect_err("rejected"),
            CodexAppServerLiveSpawnSmokeRequestRejection::RawPayloadRetentionNotAllowed
        );
    }
}
