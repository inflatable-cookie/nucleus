//! Codex callback response provider envelope records.
//!
//! Envelope records describe what would be sent after admission. They do not
//! write to stdio, retain raw payloads, cancel provider work, or mutate task
//! state.

use super::callback_request::{CodexAppServerCallbackRequest, CodexAppServerCallbackRequestKind};
use super::callback_response_admission::{
    CodexAppServerCallbackResponse, CodexAppServerCallbackResponseAdmission,
    CodexAppServerCallbackResponseAdmissionStatus,
};
use super::runtime_instance::CodexAppServerPayloadRetentionPolicy;

/// Stable id for one callback response provider envelope record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerCallbackResponseEnvelopeId(pub String);

/// Sanitized provider envelope record for a future callback response send.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseEnvelopeRecord {
    pub envelope_id: CodexAppServerCallbackResponseEnvelopeId,
    pub admission_id: String,
    pub request_id: String,
    pub provider_callback_id: String,
    pub method: String,
    pub runtime_instance_id: String,
    pub session_id: String,
    pub provider_turn_id: Option<String>,
    pub provider_item_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub callback_kind: CodexAppServerCallbackRequestKind,
    pub response: CodexAppServerCallbackResponse,
    pub payload_retention: CodexAppServerPayloadRetentionPolicy,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub provider_send_started: bool,
    pub cancellation_implied: bool,
    pub task_mutation_permitted: bool,
}

/// Rejection before an envelope record can exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackResponseEnvelopeRejection {
    AdmissionNotAccepted(String),
    AdmissionRequestMismatch {
        request_id: String,
        admission_request_id: String,
    },
}

/// Build a sanitized provider envelope record for an accepted callback admission.
pub fn codex_callback_response_envelope(
    request: &CodexAppServerCallbackRequest,
    admission: &CodexAppServerCallbackResponseAdmission,
) -> Result<
    CodexAppServerCallbackResponseEnvelopeRecord,
    CodexAppServerCallbackResponseEnvelopeRejection,
> {
    if request.request_id().0 != admission.request_id {
        return Err(
            CodexAppServerCallbackResponseEnvelopeRejection::AdmissionRequestMismatch {
                request_id: request.request_id().0.clone(),
                admission_request_id: admission.request_id.clone(),
            },
        );
    }

    match &admission.status {
        CodexAppServerCallbackResponseAdmissionStatus::Accepted => {}
        CodexAppServerCallbackResponseAdmissionStatus::Blocked(reason)
        | CodexAppServerCallbackResponseAdmissionStatus::Unsupported(reason) => {
            return Err(
                CodexAppServerCallbackResponseEnvelopeRejection::AdmissionNotAccepted(
                    reason.clone(),
                ),
            );
        }
    }

    Ok(CodexAppServerCallbackResponseEnvelopeRecord {
        envelope_id: CodexAppServerCallbackResponseEnvelopeId(format!(
            "codex-callback-response-envelope:{}",
            request.request_id().0
        )),
        admission_id: admission.admission_id.0.clone(),
        request_id: request.request_id().0.clone(),
        provider_callback_id: request.provider_callback_id().0.clone(),
        method: "serverRequest/resolved".to_owned(),
        runtime_instance_id: request.runtime_instance_id().to_owned(),
        session_id: request.session_id().0.clone(),
        provider_turn_id: request.provider_turn_id().map(ToOwned::to_owned),
        provider_item_id: request.provider_item_id().map(ToOwned::to_owned),
        task_id: request.task_id().0.clone(),
        work_item_id: request.work_item_id().0.clone(),
        callback_kind: request.kind().clone(),
        response: admission.response.clone(),
        payload_retention: request.payload_retention().clone(),
        evidence_refs: admission.evidence_refs.clone(),
        raw_payload_retained: false,
        provider_send_started: false,
        cancellation_implied: false,
        task_mutation_permitted: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_callback_response, codex_callback_request,
        codex_runtime_instance_from_supervision_request, CodexAppServerBinary,
        CodexAppServerCallbackPromptRef, CodexAppServerCallbackPromptRetentionPolicy,
        CodexAppServerCallbackResponseAdmissionInput, CodexAppServerPayloadRetentionPolicy,
        CodexAppServerProviderCallbackId, CodexAppServerRuntimeInstanceRecord,
        CodexAppServerRuntimeInstanceState, CodexAppServerSchemaEvidenceRef,
        CodexAppServerSupervisionLimits, CodexAppServerSupervisionRequest,
    };
    use crate::host_authority::EngineHostId;
    use nucleus_agent_protocol::{
        AdapterIdentity, AgentSessionId, ApprovalScope, AuthenticationPreflight,
        ProviderDriverKind, TransportFamily, UserInputPromptKind, VersionDiscovery,
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

    fn prompt_ref() -> CodexAppServerCallbackPromptRef {
        CodexAppServerCallbackPromptRef {
            prompt_ref: "callback-prompt:1".to_owned(),
            summary: "callback summary".to_owned(),
            retention: CodexAppServerCallbackPromptRetentionPolicy::SummaryAndRefOnly,
        }
    }

    fn permission_request() -> CodexAppServerCallbackRequest {
        codex_callback_request(
            &runtime(),
            CodexAppServerProviderCallbackId("provider-callback:1".to_owned()),
            AgentSessionId("session:1".to_owned()),
            Some("turn:provider:1".to_owned()),
            Some("item:provider:1".to_owned()),
            TaskId("task:1".to_owned()),
            EngineTaskWorkItemId("work:1".to_owned()),
            CodexAppServerCallbackRequestKind::Permission {
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned(), "deny".to_owned()],
            },
            prompt_ref(),
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect("callback request")
    }

    fn user_input_request() -> CodexAppServerCallbackRequest {
        codex_callback_request(
            &runtime(),
            CodexAppServerProviderCallbackId("provider-callback:input".to_owned()),
            AgentSessionId("session:1".to_owned()),
            Some("turn:provider:1".to_owned()),
            Some("item:provider:input".to_owned()),
            TaskId("task:1".to_owned()),
            EngineTaskWorkItemId("work:1".to_owned()),
            CodexAppServerCallbackRequestKind::UserInput {
                kind: UserInputPromptKind::SelectOne,
                options: vec!["first".to_owned(), "second".to_owned()],
            },
            prompt_ref(),
            CodexAppServerPayloadRetentionPolicy::EvidenceRefsOnly,
        )
        .expect("callback request")
    }

    fn accepted_admission(
        request: CodexAppServerCallbackRequest,
        response: CodexAppServerCallbackResponse,
    ) -> CodexAppServerCallbackResponseAdmission {
        admit_codex_callback_response(CodexAppServerCallbackResponseAdmissionInput {
            request,
            response,
            response_authority_confirmed: true,
            runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
            raw_payload_policy_confirmed: true,
        })
    }

    #[test]
    fn callback_response_envelope_maps_accepted_permission_admission_without_send() {
        let request = permission_request();
        let admission = accepted_admission(
            request.clone(),
            CodexAppServerCallbackResponse::Permission {
                selected_option: "allow".to_owned(),
            },
        );
        let envelope =
            codex_callback_response_envelope(&request, &admission).expect("callback envelope");

        assert_eq!(envelope.method, "serverRequest/resolved");
        assert_eq!(envelope.request_id, request.request_id().0);
        assert_eq!(envelope.admission_id, admission.admission_id.0);
        assert_eq!(envelope.provider_callback_id, "provider-callback:1");
        assert_eq!(envelope.session_id, "session:1");
        assert_eq!(
            envelope.provider_turn_id.as_deref(),
            Some("turn:provider:1")
        );
        assert_eq!(
            envelope.provider_item_id.as_deref(),
            Some("item:provider:1")
        );
        assert_eq!(envelope.task_id, "task:1");
        assert_eq!(envelope.work_item_id, "work:1");
        assert_eq!(
            envelope.response,
            CodexAppServerCallbackResponse::Permission {
                selected_option: "allow".to_owned()
            }
        );
        assert_eq!(
            envelope.payload_retention,
            CodexAppServerPayloadRetentionPolicy::MetadataOnly
        );
        assert!(!envelope.raw_payload_retained);
        assert!(!envelope.provider_send_started);
        assert!(!envelope.cancellation_implied);
        assert!(!envelope.task_mutation_permitted);
    }

    #[test]
    fn callback_response_envelope_maps_user_input_without_raw_payload() {
        let request = user_input_request();
        let admission = accepted_admission(
            request.clone(),
            CodexAppServerCallbackResponse::UserInput {
                values: vec!["first".to_owned()],
            },
        );
        let envelope =
            codex_callback_response_envelope(&request, &admission).expect("callback envelope");

        assert!(matches!(
            envelope.callback_kind,
            CodexAppServerCallbackRequestKind::UserInput {
                kind: UserInputPromptKind::SelectOne,
                ..
            }
        ));
        assert_eq!(
            envelope.payload_retention,
            CodexAppServerPayloadRetentionPolicy::EvidenceRefsOnly
        );
        assert!(!envelope.raw_payload_retained);
        assert!(!envelope.provider_send_started);
    }

    #[test]
    fn callback_response_envelope_rejects_blocked_or_mismatched_admission() {
        let request = permission_request();
        let blocked = admit_codex_callback_response(CodexAppServerCallbackResponseAdmissionInput {
            request: request.clone(),
            response: CodexAppServerCallbackResponse::Permission {
                selected_option: "allow".to_owned(),
            },
            response_authority_confirmed: false,
            runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
            raw_payload_policy_confirmed: true,
        });

        let rejection =
            codex_callback_response_envelope(&request, &blocked).expect_err("blocked admission");
        assert!(matches!(
            rejection,
            CodexAppServerCallbackResponseEnvelopeRejection::AdmissionNotAccepted(_)
        ));

        let other_request = user_input_request();
        let accepted = accepted_admission(
            other_request,
            CodexAppServerCallbackResponse::UserInput {
                values: vec!["first".to_owned()],
            },
        );
        let rejection =
            codex_callback_response_envelope(&request, &accepted).expect_err("mismatch");
        assert!(matches!(
            rejection,
            CodexAppServerCallbackResponseEnvelopeRejection::AdmissionRequestMismatch { .. }
        ));
    }
}
