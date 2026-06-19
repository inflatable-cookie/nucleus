//! Codex interruption outcome and receipt records.
//!
//! Outcome records summarize interruption admission/envelope state. They do not
//! send provider messages, retain raw payloads, recover sessions, or mutate
//! task state.

use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};

use super::interruption_admission::{
    CodexAppServerInterruptionAdmission, CodexAppServerInterruptionAdmissionStatus,
};
use super::interruption_envelope::CodexAppServerInterruptionEnvelopeRecord;
use super::interruption_request::CodexAppServerInterruptionRequest;

/// Stable id for one interruption outcome record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerInterruptionOutcomeId(pub String);

/// Sanitized interruption outcome record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerInterruptionOutcomeRecord {
    pub outcome_id: CodexAppServerInterruptionOutcomeId,
    pub request_id: String,
    pub admission_id: Option<String>,
    pub envelope_id: Option<String>,
    pub status: CodexAppServerInterruptionOutcomeStatus,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub recovery_implied: bool,
    pub task_mutation_permitted: bool,
    pub summary: String,
}

/// Interruption outcome status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionOutcomeStatus {
    Accepted,
    Blocked(String),
    Failed(String),
    Unsupported(String),
}

/// Build an interruption outcome from admission before envelope mapping.
pub fn codex_interruption_outcome_from_admission(
    admission: &CodexAppServerInterruptionAdmission,
) -> CodexAppServerInterruptionOutcomeRecord {
    let status = match &admission.status {
        CodexAppServerInterruptionAdmissionStatus::Accepted => {
            CodexAppServerInterruptionOutcomeStatus::Accepted
        }
        CodexAppServerInterruptionAdmissionStatus::Blocked(reason) => {
            CodexAppServerInterruptionOutcomeStatus::Blocked(reason.clone())
        }
        CodexAppServerInterruptionAdmissionStatus::Unsupported(reason) => {
            CodexAppServerInterruptionOutcomeStatus::Unsupported(reason.clone())
        }
    };

    outcome_record(
        &admission.request_id,
        Some(admission.admission_id.0.clone()),
        None,
        status,
        admission.evidence_refs.clone(),
    )
}

/// Build an interruption outcome from a sanitized envelope record.
pub fn codex_interruption_outcome_from_envelope(
    envelope: &CodexAppServerInterruptionEnvelopeRecord,
) -> CodexAppServerInterruptionOutcomeRecord {
    outcome_record(
        &envelope.request_id,
        Some(envelope.admission_id.clone()),
        Some(envelope.envelope_id.0.clone()),
        CodexAppServerInterruptionOutcomeStatus::Accepted,
        envelope.evidence_refs.clone(),
    )
}

/// Build a failed interruption outcome without retaining provider payloads.
pub fn codex_interruption_failed_outcome(
    request: &CodexAppServerInterruptionRequest,
    reason: String,
    evidence_refs: Vec<String>,
) -> CodexAppServerInterruptionOutcomeRecord {
    outcome_record(
        &request.request_id().0,
        None,
        None,
        CodexAppServerInterruptionOutcomeStatus::Failed(reason),
        evidence_refs,
    )
}

/// Convert an interruption outcome into a runtime receipt.
pub fn codex_receipt_from_interruption_outcome(
    outcome: &CodexAppServerInterruptionOutcomeRecord,
) -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:{}:interruption",
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
    status: CodexAppServerInterruptionOutcomeStatus,
    evidence_refs: Vec<String>,
) -> CodexAppServerInterruptionOutcomeRecord {
    let label = status_label(&status);
    CodexAppServerInterruptionOutcomeRecord {
        outcome_id: CodexAppServerInterruptionOutcomeId(format!(
            "codex-interruption-outcome:{request_id}:{label}"
        )),
        request_id: request_id.to_owned(),
        admission_id,
        envelope_id,
        summary: outcome_summary(&status),
        status,
        evidence_refs,
        raw_payload_retained: false,
        recovery_implied: false,
        task_mutation_permitted: false,
    }
}

fn receipt_status(status: &CodexAppServerInterruptionOutcomeStatus) -> EngineRuntimeReceiptStatus {
    match status {
        CodexAppServerInterruptionOutcomeStatus::Accepted => EngineRuntimeReceiptStatus::Accepted,
        CodexAppServerInterruptionOutcomeStatus::Blocked(_) => EngineRuntimeReceiptStatus::Blocked,
        CodexAppServerInterruptionOutcomeStatus::Failed(_) => EngineRuntimeReceiptStatus::Failed,
        CodexAppServerInterruptionOutcomeStatus::Unsupported(_) => {
            EngineRuntimeReceiptStatus::Blocked
        }
    }
}

fn status_label(status: &CodexAppServerInterruptionOutcomeStatus) -> &'static str {
    match status {
        CodexAppServerInterruptionOutcomeStatus::Accepted => "accepted",
        CodexAppServerInterruptionOutcomeStatus::Blocked(_) => "blocked",
        CodexAppServerInterruptionOutcomeStatus::Failed(_) => "failed",
        CodexAppServerInterruptionOutcomeStatus::Unsupported(_) => "unsupported",
    }
}

fn outcome_summary(status: &CodexAppServerInterruptionOutcomeStatus) -> String {
    match status {
        CodexAppServerInterruptionOutcomeStatus::Accepted => {
            "Codex interruption accepted before provider send".to_owned()
        }
        CodexAppServerInterruptionOutcomeStatus::Blocked(reason) => {
            format!("Codex interruption blocked: {reason}")
        }
        CodexAppServerInterruptionOutcomeStatus::Failed(reason) => {
            format!("Codex interruption failed: {reason}")
        }
        CodexAppServerInterruptionOutcomeStatus::Unsupported(reason) => {
            format!("Codex interruption unsupported: {reason}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_interruption, codex_interruption_envelope, codex_interruption_request,
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
    fn interruption_outcome_from_envelope_receipts_are_sanitized() {
        let request = request();
        let admission = accepted_admission(request.clone());
        let envelope = codex_interruption_envelope(&request, &admission).expect("envelope");
        let outcome = codex_interruption_outcome_from_envelope(&envelope);
        let receipt = codex_receipt_from_interruption_outcome(&outcome);

        assert_eq!(
            outcome.status,
            CodexAppServerInterruptionOutcomeStatus::Accepted
        );
        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::Accepted);
        assert!(outcome.envelope_id.is_some());
        assert!(!outcome.raw_payload_retained);
        assert!(!outcome.recovery_implied);
        assert!(!outcome.task_mutation_permitted);
        assert!(receipt.artifact_refs.is_empty());
    }

    #[test]
    fn interruption_outcome_maps_blocked_unsupported_and_failed_states() {
        let request = request();
        let blocked = admit_codex_interruption(CodexAppServerInterruptionAdmissionInput {
            request: request.clone(),
            interruption_authority_confirmed: false,
            runtime_ready_evidence_refs: Vec::new(),
            target_state: CodexAppServerInterruptionTargetState::Interruptible,
            duplicate_or_in_flight: false,
            raw_payload_policy_confirmed: true,
        });
        let blocked_outcome = codex_interruption_outcome_from_admission(&blocked);
        let blocked_receipt = codex_receipt_from_interruption_outcome(&blocked_outcome);
        assert_eq!(blocked_receipt.status, EngineRuntimeReceiptStatus::Blocked);

        let unsupported = admit_codex_interruption(CodexAppServerInterruptionAdmissionInput {
            request: request.clone(),
            interruption_authority_confirmed: true,
            runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
            target_state: CodexAppServerInterruptionTargetState::Unsupported(
                "turn/interrupt unavailable".to_owned(),
            ),
            duplicate_or_in_flight: false,
            raw_payload_policy_confirmed: true,
        });
        let unsupported_outcome = codex_interruption_outcome_from_admission(&unsupported);
        assert!(matches!(
            unsupported_outcome.status,
            CodexAppServerInterruptionOutcomeStatus::Unsupported(_)
        ));

        let failed_outcome = codex_interruption_failed_outcome(
            &request,
            "provider write failed".to_owned(),
            vec!["evidence:write".to_owned()],
        );
        let failed_receipt = codex_receipt_from_interruption_outcome(&failed_outcome);
        assert_eq!(failed_receipt.status, EngineRuntimeReceiptStatus::Failed);
        assert!(!failed_outcome.raw_payload_retained);
    }
}
