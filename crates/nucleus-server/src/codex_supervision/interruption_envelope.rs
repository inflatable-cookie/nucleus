//! Codex interruption provider envelope records.
//!
//! Envelope records describe what would be sent after admission. They do not
//! write to stdio, interrupt Codex, retain raw payloads, recover sessions, or
//! mutate task state.

use super::interruption_admission::{
    CodexAppServerInterruptionAdmission, CodexAppServerInterruptionAdmissionStatus,
};
use super::interruption_request::{
    CodexAppServerInterruptionReasonRef, CodexAppServerInterruptionRequest,
    CodexAppServerInterruptionTarget,
};
use super::runtime_instance::CodexAppServerPayloadRetentionPolicy;

/// Stable id for one interruption provider envelope record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerInterruptionEnvelopeId(pub String);

/// Sanitized provider envelope record for a future Codex interruption send.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerInterruptionEnvelopeRecord {
    pub envelope_id: CodexAppServerInterruptionEnvelopeId,
    pub admission_id: String,
    pub request_id: String,
    pub method: String,
    pub runtime_instance_id: String,
    pub session_id: String,
    pub provider_turn_id: String,
    pub provider_request_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub reason_ref: CodexAppServerInterruptionReasonRef,
    pub payload_retention: CodexAppServerPayloadRetentionPolicy,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub provider_send_started: bool,
    pub recovery_implied: bool,
    pub task_mutation_permitted: bool,
}

/// Rejection before an envelope record can exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionEnvelopeRejection {
    AdmissionNotAccepted(String),
    AdmissionRequestMismatch {
        request_id: String,
        admission_request_id: String,
    },
}

/// Build a sanitized provider envelope record for an accepted admission.
pub fn codex_interruption_envelope(
    request: &CodexAppServerInterruptionRequest,
    admission: &CodexAppServerInterruptionAdmission,
) -> Result<CodexAppServerInterruptionEnvelopeRecord, CodexAppServerInterruptionEnvelopeRejection> {
    if request.request_id().0 != admission.request_id {
        return Err(
            CodexAppServerInterruptionEnvelopeRejection::AdmissionRequestMismatch {
                request_id: request.request_id().0.clone(),
                admission_request_id: admission.request_id.clone(),
            },
        );
    }

    match &admission.status {
        CodexAppServerInterruptionAdmissionStatus::Accepted => {}
        CodexAppServerInterruptionAdmissionStatus::Blocked(reason)
        | CodexAppServerInterruptionAdmissionStatus::Unsupported(reason) => {
            return Err(
                CodexAppServerInterruptionEnvelopeRejection::AdmissionNotAccepted(reason.clone()),
            );
        }
    }

    let CodexAppServerInterruptionTarget::ActiveTurn {
        provider_turn_id,
        provider_request_id,
    } = request.target();

    Ok(CodexAppServerInterruptionEnvelopeRecord {
        envelope_id: CodexAppServerInterruptionEnvelopeId(format!(
            "codex-interruption-envelope:{}",
            request.request_id().0
        )),
        admission_id: admission.admission_id.0.clone(),
        request_id: request.request_id().0.clone(),
        method: "turn/interrupt".to_owned(),
        runtime_instance_id: request.runtime_instance_id().to_owned(),
        session_id: request.session_id().0.clone(),
        provider_turn_id: provider_turn_id.clone(),
        provider_request_id: provider_request_id.clone(),
        task_id: request.task_id().0.clone(),
        work_item_id: request.work_item_id().0.clone(),
        reason_ref: request.reason_ref().clone(),
        payload_retention: request.payload_retention().clone(),
        evidence_refs: admission.evidence_refs.clone(),
        raw_payload_retained: false,
        provider_send_started: false,
        recovery_implied: false,
        task_mutation_permitted: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_interruption, codex_interruption_request,
        codex_runtime_instance_from_supervision_request, CodexAppServerBinary,
        CodexAppServerInterruptionAdmissionInput, CodexAppServerInterruptionReasonRef,
        CodexAppServerInterruptionReasonRetentionPolicy, CodexAppServerInterruptionRequestRef,
        CodexAppServerInterruptionTarget, CodexAppServerInterruptionTargetState,
        CodexAppServerPayloadRetentionPolicy, CodexAppServerRuntimeInstanceRecord,
        CodexAppServerRuntimeInstanceState, CodexAppServerSchemaEvidenceRef,
        CodexAppServerSupervisionLimits, CodexAppServerSupervisionRequest,
    };
    use crate::host_authority::EngineHostId;
    use nucleus_agent_protocol::{
        AdapterIdentity, AgentSessionId, AuthenticationPreflight, ProviderDriverKind,
        TransportFamily, VersionDiscovery,
    };
    use nucleus_engine::EngineTaskWorkItemId;
    use nucleus_projects::ProjectId;
    use nucleus_tasks::TaskId;

    fn runtime() -> CodexAppServerRuntimeInstanceRecord {
        codex_runtime_instance_from_supervision_request(
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
        )
    }

    fn request() -> CodexAppServerInterruptionRequest {
        codex_interruption_request(
            &runtime(),
            CodexAppServerInterruptionRequestRef("interrupt:1".to_owned()),
            AgentSessionId("session:1".to_owned()),
            CodexAppServerInterruptionTarget::ActiveTurn {
                provider_turn_id: "turn:provider:1".to_owned(),
                provider_request_id: Some("request:provider:1".to_owned()),
            },
            TaskId("task:1".to_owned()),
            EngineTaskWorkItemId("work:1".to_owned()),
            CodexAppServerInterruptionReasonRef {
                reason_ref: "interruption-reason:1".to_owned(),
                summary: "operator stopped the active turn".to_owned(),
                retention: CodexAppServerInterruptionReasonRetentionPolicy::SummaryAndRefOnly,
            },
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect("interruption request")
    }

    fn accepted_admission(
        request: CodexAppServerInterruptionRequest,
    ) -> CodexAppServerInterruptionAdmission {
        admit_codex_interruption(CodexAppServerInterruptionAdmissionInput {
            request,
            interruption_authority_confirmed: true,
            runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
            target_state: CodexAppServerInterruptionTargetState::Interruptible,
            duplicate_or_in_flight: false,
            raw_payload_policy_confirmed: true,
        })
    }

    #[test]
    fn interruption_envelope_maps_accepted_admission_without_provider_send() {
        let request = request();
        let admission = accepted_admission(request.clone());
        let envelope = codex_interruption_envelope(&request, &admission).expect("envelope");

        assert_eq!(envelope.method, "turn/interrupt");
        assert_eq!(envelope.request_id, request.request_id().0);
        assert_eq!(envelope.admission_id, admission.admission_id.0);
        assert_eq!(envelope.session_id, "session:1");
        assert_eq!(envelope.provider_turn_id, "turn:provider:1");
        assert_eq!(
            envelope.provider_request_id.as_deref(),
            Some("request:provider:1")
        );
        assert_eq!(envelope.task_id, "task:1");
        assert_eq!(envelope.work_item_id, "work:1");
        assert!(!envelope.raw_payload_retained);
        assert!(!envelope.provider_send_started);
        assert!(!envelope.recovery_implied);
        assert!(!envelope.task_mutation_permitted);
    }

    #[test]
    fn interruption_envelope_rejects_blocked_or_mismatched_admission() {
        let request = request();
        let blocked = admit_codex_interruption(CodexAppServerInterruptionAdmissionInput {
            request: request.clone(),
            interruption_authority_confirmed: false,
            runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
            target_state: CodexAppServerInterruptionTargetState::Interruptible,
            duplicate_or_in_flight: false,
            raw_payload_policy_confirmed: true,
        });

        let rejection = codex_interruption_envelope(&request, &blocked).expect_err("blocked");
        assert!(matches!(
            rejection,
            CodexAppServerInterruptionEnvelopeRejection::AdmissionNotAccepted(_)
        ));

        let other_request = codex_interruption_request(
            &runtime(),
            CodexAppServerInterruptionRequestRef("interrupt:2".to_owned()),
            AgentSessionId("session:1".to_owned()),
            CodexAppServerInterruptionTarget::ActiveTurn {
                provider_turn_id: "turn:provider:2".to_owned(),
                provider_request_id: None,
            },
            TaskId("task:1".to_owned()),
            EngineTaskWorkItemId("work:2".to_owned()),
            CodexAppServerInterruptionReasonRef {
                reason_ref: "interruption-reason:2".to_owned(),
                summary: "operator stopped another turn".to_owned(),
                retention: CodexAppServerInterruptionReasonRetentionPolicy::SummaryAndRefOnly,
            },
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect("other request");
        let accepted = accepted_admission(other_request);
        let rejection = codex_interruption_envelope(&request, &accepted).expect_err("mismatch");
        assert!(matches!(
            rejection,
            CodexAppServerInterruptionEnvelopeRejection::AdmissionRequestMismatch { .. }
        ));
    }
}
