//! Codex turn-start outcome and receipt records.
//!
//! Outcome records summarize turn-start admission/envelope state. They do not
//! send provider messages, retain raw prompts, answer callbacks, or mutate task
//! state.

use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};

use super::turn_start_admission::{
    CodexAppServerTurnStartAdmission, CodexAppServerTurnStartAdmissionStatus,
};
use super::turn_start_envelope::CodexAppServerTurnStartEnvelopeRecord;

/// Stable id for one turn-start outcome record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTurnStartOutcomeId(pub String);

/// Sanitized turn-start outcome record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartOutcomeRecord {
    pub outcome_id: CodexAppServerTurnStartOutcomeId,
    pub request_id: String,
    pub admission_id: Option<String>,
    pub envelope_id: Option<String>,
    pub status: CodexAppServerTurnStartOutcomeStatus,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub task_mutation_permitted: bool,
    pub summary: String,
}

/// Turn-start outcome status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartOutcomeStatus {
    Accepted,
    Blocked(String),
    Failed(String),
    Unsupported(String),
}

/// Build a turn-start outcome from admission before envelope mapping.
pub fn codex_turn_start_outcome_from_admission(
    admission: &CodexAppServerTurnStartAdmission,
) -> CodexAppServerTurnStartOutcomeRecord {
    let status = match &admission.status {
        CodexAppServerTurnStartAdmissionStatus::Accepted => {
            CodexAppServerTurnStartOutcomeStatus::Accepted
        }
        CodexAppServerTurnStartAdmissionStatus::Blocked(reason) => {
            CodexAppServerTurnStartOutcomeStatus::Blocked(reason.clone())
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

/// Build a turn-start outcome from a sanitized envelope record.
pub fn codex_turn_start_outcome_from_envelope(
    envelope: &CodexAppServerTurnStartEnvelopeRecord,
) -> CodexAppServerTurnStartOutcomeRecord {
    outcome_record(
        &envelope.request_id,
        Some(envelope.admission_id.clone()),
        Some(envelope.envelope_id.0.clone()),
        CodexAppServerTurnStartOutcomeStatus::Accepted,
        envelope.evidence_refs.clone(),
    )
}

/// Convert a turn-start outcome into a runtime receipt.
pub fn codex_receipt_from_turn_start_outcome(
    outcome: &CodexAppServerTurnStartOutcomeRecord,
) -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:{}:turn-start",
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
    status: CodexAppServerTurnStartOutcomeStatus,
    evidence_refs: Vec<String>,
) -> CodexAppServerTurnStartOutcomeRecord {
    let label = status_label(&status);
    CodexAppServerTurnStartOutcomeRecord {
        outcome_id: CodexAppServerTurnStartOutcomeId(format!(
            "codex-turn-start-outcome:{request_id}:{label}"
        )),
        request_id: request_id.to_owned(),
        admission_id,
        envelope_id,
        summary: outcome_summary(&status),
        status,
        evidence_refs,
        raw_payload_retained: false,
        task_mutation_permitted: false,
    }
}

fn receipt_status(status: &CodexAppServerTurnStartOutcomeStatus) -> EngineRuntimeReceiptStatus {
    match status {
        CodexAppServerTurnStartOutcomeStatus::Accepted => EngineRuntimeReceiptStatus::Accepted,
        CodexAppServerTurnStartOutcomeStatus::Blocked(_) => EngineRuntimeReceiptStatus::Blocked,
        CodexAppServerTurnStartOutcomeStatus::Failed(_) => EngineRuntimeReceiptStatus::Failed,
        CodexAppServerTurnStartOutcomeStatus::Unsupported(_) => EngineRuntimeReceiptStatus::Blocked,
    }
}

fn status_label(status: &CodexAppServerTurnStartOutcomeStatus) -> &'static str {
    match status {
        CodexAppServerTurnStartOutcomeStatus::Accepted => "accepted",
        CodexAppServerTurnStartOutcomeStatus::Blocked(_) => "blocked",
        CodexAppServerTurnStartOutcomeStatus::Failed(_) => "failed",
        CodexAppServerTurnStartOutcomeStatus::Unsupported(_) => "unsupported",
    }
}

fn outcome_summary(status: &CodexAppServerTurnStartOutcomeStatus) -> String {
    match status {
        CodexAppServerTurnStartOutcomeStatus::Accepted => {
            "Codex turn-start accepted before provider send".to_owned()
        }
        CodexAppServerTurnStartOutcomeStatus::Blocked(reason) => {
            format!("Codex turn-start blocked: {reason}")
        }
        CodexAppServerTurnStartOutcomeStatus::Failed(reason) => {
            format!("Codex turn-start failed: {reason}")
        }
        CodexAppServerTurnStartOutcomeStatus::Unsupported(reason) => {
            format!("Codex turn-start unsupported: {reason}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_turn_start, codex_runtime_instance_from_supervision_request,
        codex_turn_start_envelope, codex_turn_start_request, CodexAppServerBinary,
        CodexAppServerPayloadRetentionPolicy, CodexAppServerRuntimeInstanceState,
        CodexAppServerSchemaEvidenceRef, CodexAppServerSupervisionLimits,
        CodexAppServerSupervisionRequest, CodexAppServerTurnStartAdmissionInput,
        CodexAppServerTurnStartDeferredPolicy, CodexAppServerTurnStartPromptRef,
        CodexAppServerTurnStartPromptRetentionPolicy,
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

    fn admission(ready: bool) -> crate::CodexAppServerTurnStartAdmission {
        admit_codex_turn_start(CodexAppServerTurnStartAdmissionInput {
            request: request(),
            runtime_ready_evidence_refs: if ready {
                vec!["evidence:live-spawn-smoke".to_owned()]
            } else {
                Vec::new()
            },
            task_work_ready: ready,
            assignment_ready: true,
            callback_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            cancellation_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            raw_payload_policy_confirmed: true,
        })
    }

    #[test]
    fn accepted_turn_start_envelope_maps_to_sanitized_receipt() {
        let request = request();
        let admission = admit_codex_turn_start(CodexAppServerTurnStartAdmissionInput {
            request: request.clone(),
            runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
            task_work_ready: true,
            assignment_ready: true,
            callback_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            cancellation_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            raw_payload_policy_confirmed: true,
        });
        let envelope = codex_turn_start_envelope(&request, &admission).expect("envelope");
        let outcome = codex_turn_start_outcome_from_envelope(&envelope);
        let receipt = codex_receipt_from_turn_start_outcome(&outcome);

        assert_eq!(
            outcome.status,
            CodexAppServerTurnStartOutcomeStatus::Accepted
        );
        assert!(!outcome.raw_payload_retained);
        assert!(!outcome.task_mutation_permitted);
        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::Accepted);
        assert!(receipt.artifact_refs.is_empty());
    }

    #[test]
    fn blocked_turn_start_admission_maps_to_blocked_receipt() {
        let admission = admission(false);
        let outcome = codex_turn_start_outcome_from_admission(&admission);
        let receipt = codex_receipt_from_turn_start_outcome(&outcome);

        assert!(matches!(
            outcome.status,
            CodexAppServerTurnStartOutcomeStatus::Blocked(_)
        ));
        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::Blocked);
        assert!(receipt
            .summary
            .as_deref()
            .unwrap_or_default()
            .contains("blocked"));
    }
}
