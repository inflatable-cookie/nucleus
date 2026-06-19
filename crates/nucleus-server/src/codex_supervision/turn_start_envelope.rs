//! Codex turn-start provider envelope records.
//!
//! Envelope records describe what would be sent after admission. They do not
//! write to stdio, retain raw prompts, answer callbacks, or mutate task state.

use super::runtime_instance::CodexAppServerPayloadRetentionPolicy;
use super::turn_start_admission::{
    CodexAppServerTurnStartAdmission, CodexAppServerTurnStartAdmissionStatus,
};
use super::turn_start_request::{CodexAppServerTurnStartPromptRef, CodexAppServerTurnStartRequest};

/// Stable id for one turn-start provider envelope record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTurnStartEnvelopeId(pub String);

/// Sanitized provider envelope record for a future Codex turn-start send.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartEnvelopeRecord {
    pub envelope_id: CodexAppServerTurnStartEnvelopeId,
    pub admission_id: String,
    pub request_id: String,
    pub method: String,
    pub runtime_instance_id: String,
    pub session_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub prompt_ref: CodexAppServerTurnStartPromptRef,
    pub payload_retention: CodexAppServerPayloadRetentionPolicy,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub provider_send_started: bool,
}

/// Rejection before an envelope record can exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartEnvelopeRejection {
    AdmissionNotAccepted(String),
    AdmissionRequestMismatch {
        request_id: String,
        admission_request_id: String,
    },
}

/// Build a sanitized provider envelope record for an accepted admission.
pub fn codex_turn_start_envelope(
    request: &CodexAppServerTurnStartRequest,
    admission: &CodexAppServerTurnStartAdmission,
) -> Result<CodexAppServerTurnStartEnvelopeRecord, CodexAppServerTurnStartEnvelopeRejection> {
    if request.request_id().0 != admission.request_id {
        return Err(
            CodexAppServerTurnStartEnvelopeRejection::AdmissionRequestMismatch {
                request_id: request.request_id().0.clone(),
                admission_request_id: admission.request_id.clone(),
            },
        );
    }

    if let CodexAppServerTurnStartAdmissionStatus::Blocked(reason) = &admission.status {
        return Err(CodexAppServerTurnStartEnvelopeRejection::AdmissionNotAccepted(reason.clone()));
    }

    Ok(CodexAppServerTurnStartEnvelopeRecord {
        envelope_id: CodexAppServerTurnStartEnvelopeId(format!(
            "codex-turn-start-envelope:{}",
            request.request_id().0
        )),
        admission_id: admission.admission_id.0.clone(),
        request_id: request.request_id().0.clone(),
        method: "turn/start".to_owned(),
        runtime_instance_id: request.runtime_instance_id().to_owned(),
        session_id: request.session_id().0.clone(),
        task_id: request.task_id().0.clone(),
        work_item_id: request.work_item_id().0.clone(),
        prompt_ref: request.prompt_ref().clone(),
        payload_retention: request.payload_retention().clone(),
        evidence_refs: admission.evidence_refs.clone(),
        raw_payload_retained: false,
        provider_send_started: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_turn_start, codex_runtime_instance_from_supervision_request,
        codex_turn_start_request, CodexAppServerBinary, CodexAppServerPayloadRetentionPolicy,
        CodexAppServerRuntimeInstanceState, CodexAppServerSchemaEvidenceRef,
        CodexAppServerSupervisionLimits, CodexAppServerSupervisionRequest,
        CodexAppServerTurnStartAdmissionInput, CodexAppServerTurnStartDeferredPolicy,
        CodexAppServerTurnStartPromptRef, CodexAppServerTurnStartPromptRetentionPolicy,
    };
    use crate::host_authority::EngineHostId;
    use nucleus_agent_protocol::{
        AdapterIdentity, AgentSessionId, AuthenticationPreflight, ProviderDriverKind,
        TransportFamily, VersionDiscovery,
    };
    use nucleus_engine::EngineTaskWorkItemId;
    use nucleus_projects::ProjectId;
    use nucleus_tasks::TaskId;

    fn request() -> crate::CodexAppServerTurnStartRequest {
        let runtime = codex_runtime_instance_from_supervision_request(
            &CodexAppServerSupervisionRequest {
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
                    allow_raw_provider_payload_storage: false,
                    allow_live_spawn: true,
                },
            },
            CodexAppServerRuntimeInstanceState::ReadyForSpawn,
        );

        codex_turn_start_request(
            &runtime,
            AgentSessionId("session:1".to_owned()),
            TaskId("task:1".to_owned()),
            EngineTaskWorkItemId("work:1".to_owned()),
            CodexAppServerTurnStartPromptRef {
                prompt_ref: "prompt:1".to_owned(),
                summary: "turn prompt summary".to_owned(),
                retention: CodexAppServerTurnStartPromptRetentionPolicy::SummaryAndRefOnly,
            },
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect("turn request")
    }

    fn accepted_admission(
        request: crate::CodexAppServerTurnStartRequest,
    ) -> crate::CodexAppServerTurnStartAdmission {
        admit_codex_turn_start(CodexAppServerTurnStartAdmissionInput {
            request,
            runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
            task_work_ready: true,
            assignment_ready: true,
            callback_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            cancellation_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            raw_payload_policy_confirmed: true,
        })
    }

    #[test]
    fn turn_start_envelope_maps_accepted_admission_without_provider_send() {
        let request = request();
        let admission = accepted_admission(request.clone());
        let envelope = codex_turn_start_envelope(&request, &admission).expect("envelope");

        assert_eq!(envelope.method, "turn/start");
        assert_eq!(envelope.request_id, request.request_id().0);
        assert_eq!(envelope.admission_id, admission.admission_id.0);
        assert_eq!(envelope.session_id, "session:1");
        assert_eq!(envelope.task_id, "task:1");
        assert_eq!(envelope.work_item_id, "work:1");
        assert!(!envelope.raw_payload_retained);
        assert!(!envelope.provider_send_started);
        assert!(envelope
            .evidence_refs
            .contains(&"evidence:live-spawn-smoke".to_owned()));
    }

    #[test]
    fn turn_start_envelope_rejects_blocked_admission() {
        let request = request();
        let admission = admit_codex_turn_start(CodexAppServerTurnStartAdmissionInput {
            request: request.clone(),
            runtime_ready_evidence_refs: Vec::new(),
            task_work_ready: false,
            assignment_ready: true,
            callback_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            cancellation_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            raw_payload_policy_confirmed: true,
        });

        let rejection = codex_turn_start_envelope(&request, &admission).expect_err("blocked");

        assert!(matches!(
            rejection,
            CodexAppServerTurnStartEnvelopeRejection::AdmissionNotAccepted(_)
        ));
    }
}
