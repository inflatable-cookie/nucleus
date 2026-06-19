//! Codex callback response outcome and receipt records.
//!
//! Outcome records summarize callback response admission/envelope state. They
//! do not send provider messages, retain raw payloads, cancel provider work, or
//! mutate task state.

use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};

use super::callback_request::CodexAppServerCallbackRequest;
use super::callback_response_admission::{
    CodexAppServerCallbackResponseAdmission, CodexAppServerCallbackResponseAdmissionStatus,
};
use super::callback_response_envelope::CodexAppServerCallbackResponseEnvelopeRecord;

/// Stable id for one callback response outcome record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerCallbackResponseOutcomeId(pub String);

/// Sanitized callback response outcome record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseOutcomeRecord {
    pub outcome_id: CodexAppServerCallbackResponseOutcomeId,
    pub request_id: String,
    pub admission_id: Option<String>,
    pub envelope_id: Option<String>,
    pub provider_callback_id: String,
    pub status: CodexAppServerCallbackResponseOutcomeStatus,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub cancellation_implied: bool,
    pub task_mutation_permitted: bool,
    pub summary: String,
}

/// Callback response outcome status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackResponseOutcomeStatus {
    Accepted,
    Blocked(String),
    Failed(String),
    Unsupported(String),
}

/// Build a callback response outcome from admission before envelope mapping.
pub fn codex_callback_response_outcome_from_admission(
    admission: &CodexAppServerCallbackResponseAdmission,
) -> CodexAppServerCallbackResponseOutcomeRecord {
    let status = match &admission.status {
        CodexAppServerCallbackResponseAdmissionStatus::Accepted => {
            CodexAppServerCallbackResponseOutcomeStatus::Accepted
        }
        CodexAppServerCallbackResponseAdmissionStatus::Blocked(reason) => {
            CodexAppServerCallbackResponseOutcomeStatus::Blocked(reason.clone())
        }
        CodexAppServerCallbackResponseAdmissionStatus::Unsupported(reason) => {
            CodexAppServerCallbackResponseOutcomeStatus::Unsupported(reason.clone())
        }
    };

    outcome_record(
        &admission.request_id,
        Some(admission.admission_id.0.clone()),
        None,
        admission.provider_callback_id.0.clone(),
        status,
        admission.evidence_refs.clone(),
    )
}

/// Build a callback response outcome from a sanitized envelope record.
pub fn codex_callback_response_outcome_from_envelope(
    envelope: &CodexAppServerCallbackResponseEnvelopeRecord,
) -> CodexAppServerCallbackResponseOutcomeRecord {
    outcome_record(
        &envelope.request_id,
        Some(envelope.admission_id.clone()),
        Some(envelope.envelope_id.0.clone()),
        envelope.provider_callback_id.clone(),
        CodexAppServerCallbackResponseOutcomeStatus::Accepted,
        envelope.evidence_refs.clone(),
    )
}

/// Build a failed callback response outcome without retaining provider payloads.
pub fn codex_callback_response_failed_outcome(
    request: &CodexAppServerCallbackRequest,
    reason: String,
    evidence_refs: Vec<String>,
) -> CodexAppServerCallbackResponseOutcomeRecord {
    outcome_record(
        &request.request_id().0,
        None,
        None,
        request.provider_callback_id().0.clone(),
        CodexAppServerCallbackResponseOutcomeStatus::Failed(reason),
        evidence_refs,
    )
}

/// Convert a callback response outcome into a runtime receipt.
pub fn codex_receipt_from_callback_response_outcome(
    outcome: &CodexAppServerCallbackResponseOutcomeRecord,
) -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:{}:callback-response",
            outcome.outcome_id.0
        )),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: receipt_status(&outcome.status),
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(outcome.request_id.clone())),
        evidence_refs: outcome
            .evidence_refs
            .iter()
            .map(|value| EngineRuntimeReceiptRef::Custom(value.clone()))
            .collect(),
        artifact_refs: Vec::new(),
        summary: Some(outcome.summary.clone()),
    }
}

fn outcome_record(
    request_id: &str,
    admission_id: Option<String>,
    envelope_id: Option<String>,
    provider_callback_id: String,
    status: CodexAppServerCallbackResponseOutcomeStatus,
    evidence_refs: Vec<String>,
) -> CodexAppServerCallbackResponseOutcomeRecord {
    let label = status_label(&status);
    CodexAppServerCallbackResponseOutcomeRecord {
        outcome_id: CodexAppServerCallbackResponseOutcomeId(format!(
            "codex-callback-response-outcome:{request_id}:{label}"
        )),
        request_id: request_id.to_owned(),
        admission_id,
        envelope_id,
        provider_callback_id,
        summary: outcome_summary(&status),
        status,
        evidence_refs,
        raw_payload_retained: false,
        cancellation_implied: false,
        task_mutation_permitted: false,
    }
}

fn receipt_status(
    status: &CodexAppServerCallbackResponseOutcomeStatus,
) -> EngineRuntimeReceiptStatus {
    match status {
        CodexAppServerCallbackResponseOutcomeStatus::Accepted => {
            EngineRuntimeReceiptStatus::Accepted
        }
        CodexAppServerCallbackResponseOutcomeStatus::Blocked(_) => {
            EngineRuntimeReceiptStatus::Blocked
        }
        CodexAppServerCallbackResponseOutcomeStatus::Failed(_) => {
            EngineRuntimeReceiptStatus::Failed
        }
        CodexAppServerCallbackResponseOutcomeStatus::Unsupported(_) => {
            EngineRuntimeReceiptStatus::Blocked
        }
    }
}

fn status_label(status: &CodexAppServerCallbackResponseOutcomeStatus) -> &'static str {
    match status {
        CodexAppServerCallbackResponseOutcomeStatus::Accepted => "accepted",
        CodexAppServerCallbackResponseOutcomeStatus::Blocked(_) => "blocked",
        CodexAppServerCallbackResponseOutcomeStatus::Failed(_) => "failed",
        CodexAppServerCallbackResponseOutcomeStatus::Unsupported(_) => "unsupported",
    }
}

fn outcome_summary(status: &CodexAppServerCallbackResponseOutcomeStatus) -> String {
    match status {
        CodexAppServerCallbackResponseOutcomeStatus::Accepted => {
            "Codex callback response accepted before provider send".to_owned()
        }
        CodexAppServerCallbackResponseOutcomeStatus::Blocked(reason) => {
            format!("Codex callback response blocked: {reason}")
        }
        CodexAppServerCallbackResponseOutcomeStatus::Failed(reason) => {
            format!("Codex callback response failed: {reason}")
        }
        CodexAppServerCallbackResponseOutcomeStatus::Unsupported(reason) => {
            format!("Codex callback response unsupported: {reason}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_callback_response, codex_callback_request, codex_callback_response_envelope,
        codex_runtime_instance_from_supervision_request, CodexAppServerBinary,
        CodexAppServerCallbackPromptRef, CodexAppServerCallbackPromptRetentionPolicy,
        CodexAppServerCallbackRequestKind, CodexAppServerCallbackResponse,
        CodexAppServerCallbackResponseAdmissionInput, CodexAppServerPayloadRetentionPolicy,
        CodexAppServerProviderCallbackId, CodexAppServerRuntimeInstanceRecord,
        CodexAppServerRuntimeInstanceState, CodexAppServerSchemaEvidenceRef,
        CodexAppServerSupervisionLimits, CodexAppServerSupervisionRequest,
    };
    use crate::host_authority::EngineHostId;
    use nucleus_agent_protocol::{
        AdapterIdentity, AgentSessionId, ApprovalScope, AuthenticationPreflight,
        ProviderDriverKind, TransportFamily, VersionDiscovery,
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

    fn request() -> CodexAppServerCallbackRequest {
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
            CodexAppServerCallbackPromptRef {
                prompt_ref: "callback-prompt:1".to_owned(),
                summary: "callback summary".to_owned(),
                retention: CodexAppServerCallbackPromptRetentionPolicy::SummaryAndRefOnly,
            },
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect("callback request")
    }

    #[test]
    fn callback_response_outcome_from_envelope_receipts_are_sanitized() {
        let request = request();
        let admission =
            admit_codex_callback_response(CodexAppServerCallbackResponseAdmissionInput {
                request: request.clone(),
                response: CodexAppServerCallbackResponse::Permission {
                    selected_option: "allow".to_owned(),
                },
                response_authority_confirmed: true,
                runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
                raw_payload_policy_confirmed: true,
            });
        let envelope = codex_callback_response_envelope(&request, &admission).expect("envelope");
        let outcome = codex_callback_response_outcome_from_envelope(&envelope);
        let receipt = codex_receipt_from_callback_response_outcome(&outcome);

        assert_eq!(
            outcome.status,
            CodexAppServerCallbackResponseOutcomeStatus::Accepted
        );
        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::Accepted);
        assert_eq!(outcome.provider_callback_id, "provider-callback:1");
        assert!(!outcome.raw_payload_retained);
        assert!(!outcome.cancellation_implied);
        assert!(!outcome.task_mutation_permitted);
        assert!(receipt.artifact_refs.is_empty());
    }

    #[test]
    fn callback_response_outcome_maps_blocked_unsupported_and_failed_states() {
        let request = request();
        let blocked = admit_codex_callback_response(CodexAppServerCallbackResponseAdmissionInput {
            request: request.clone(),
            response: CodexAppServerCallbackResponse::Permission {
                selected_option: "deny".to_owned(),
            },
            response_authority_confirmed: false,
            runtime_ready_evidence_refs: Vec::new(),
            raw_payload_policy_confirmed: true,
        });
        let blocked_outcome = codex_callback_response_outcome_from_admission(&blocked);
        let blocked_receipt = codex_receipt_from_callback_response_outcome(&blocked_outcome);
        assert_eq!(blocked_receipt.status, EngineRuntimeReceiptStatus::Blocked);

        let failed_outcome = codex_callback_response_failed_outcome(
            &request,
            "provider write failed".to_owned(),
            vec!["evidence:write".to_owned()],
        );
        let failed_receipt = codex_receipt_from_callback_response_outcome(&failed_outcome);
        assert_eq!(failed_receipt.status, EngineRuntimeReceiptStatus::Failed);
        assert!(!failed_outcome.raw_payload_retained);
    }
}
