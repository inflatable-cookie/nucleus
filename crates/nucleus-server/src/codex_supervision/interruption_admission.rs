//! Codex interruption admission policy.
//!
//! Admission records gate interruption requests before provider send. They do
//! not build provider envelopes, interrupt Codex, recover sessions, or mutate
//! task state.

use super::interruption_request::CodexAppServerInterruptionRequest;

/// Stable id for one interruption admission decision.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerInterruptionAdmissionId(pub String);

/// Observed local state for the requested interruption target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionTargetState {
    Interruptible,
    AlreadyTerminal(String),
    Stale(String),
    Unknown,
    Unsupported(String),
}

/// Input used to admit or block a Codex interruption request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerInterruptionAdmissionInput {
    pub request: CodexAppServerInterruptionRequest,
    pub interruption_authority_confirmed: bool,
    pub runtime_ready_evidence_refs: Vec<String>,
    pub target_state: CodexAppServerInterruptionTargetState,
    pub duplicate_or_in_flight: bool,
    pub raw_payload_policy_confirmed: bool,
}

/// Admission record for a provider interruption request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerInterruptionAdmission {
    pub admission_id: CodexAppServerInterruptionAdmissionId,
    pub request_id: String,
    pub status: CodexAppServerInterruptionAdmissionStatus,
    pub blockers: Vec<CodexAppServerInterruptionAdmissionBlocker>,
    pub evidence_refs: Vec<String>,
    pub provider_send_started: bool,
    pub raw_provider_payload_retained: bool,
    pub recovery_implied: bool,
    pub task_mutation_permitted: bool,
}

/// Admission status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionAdmissionStatus {
    Accepted,
    Blocked(String),
    Unsupported(String),
}

/// Reason interruption admission is blocked or unsupported.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionAdmissionBlocker {
    MissingInterruptionAuthority,
    MissingRuntimeReadyEvidence,
    RawPayloadPolicyUnconfirmed,
    TargetAlreadyTerminal(String),
    TargetStale(String),
    TargetStateUnknown,
    DuplicateOrInFlight,
    ProviderInterruptionUnsupported(String),
}

/// Admit or block a Codex interruption request before provider send.
pub fn admit_codex_interruption(
    input: CodexAppServerInterruptionAdmissionInput,
) -> CodexAppServerInterruptionAdmission {
    let blockers = admission_blockers(&input);
    let unsupported = unsupported_blockers(&blockers);
    let status = if !unsupported.is_empty() {
        CodexAppServerInterruptionAdmissionStatus::Unsupported(blocker_summary(&unsupported))
    } else if blockers.is_empty() {
        CodexAppServerInterruptionAdmissionStatus::Accepted
    } else {
        CodexAppServerInterruptionAdmissionStatus::Blocked(blocker_summary(&blockers))
    };
    let request_id = input.request.request_id().0.clone();
    let mut evidence_refs = input.request.evidence_refs().to_vec();
    evidence_refs.extend(input.runtime_ready_evidence_refs);

    CodexAppServerInterruptionAdmission {
        admission_id: CodexAppServerInterruptionAdmissionId(format!(
            "codex-interruption-admission:{request_id}"
        )),
        request_id,
        status,
        blockers,
        evidence_refs,
        provider_send_started: false,
        raw_provider_payload_retained: false,
        recovery_implied: false,
        task_mutation_permitted: false,
    }
}

fn admission_blockers(
    input: &CodexAppServerInterruptionAdmissionInput,
) -> Vec<CodexAppServerInterruptionAdmissionBlocker> {
    let mut blockers = Vec::new();

    if !input.interruption_authority_confirmed {
        blockers.push(CodexAppServerInterruptionAdmissionBlocker::MissingInterruptionAuthority);
    }
    if input.runtime_ready_evidence_refs.is_empty() {
        blockers.push(CodexAppServerInterruptionAdmissionBlocker::MissingRuntimeReadyEvidence);
    }
    if !input.raw_payload_policy_confirmed {
        blockers.push(CodexAppServerInterruptionAdmissionBlocker::RawPayloadPolicyUnconfirmed);
    }
    match &input.target_state {
        CodexAppServerInterruptionTargetState::Interruptible => {}
        CodexAppServerInterruptionTargetState::AlreadyTerminal(reason) => blockers.push(
            CodexAppServerInterruptionAdmissionBlocker::TargetAlreadyTerminal(reason.clone()),
        ),
        CodexAppServerInterruptionTargetState::Stale(reason) => {
            blockers.push(CodexAppServerInterruptionAdmissionBlocker::TargetStale(
                reason.clone(),
            ));
        }
        CodexAppServerInterruptionTargetState::Unknown => {
            blockers.push(CodexAppServerInterruptionAdmissionBlocker::TargetStateUnknown);
        }
        CodexAppServerInterruptionTargetState::Unsupported(reason) => blockers.push(
            CodexAppServerInterruptionAdmissionBlocker::ProviderInterruptionUnsupported(
                reason.clone(),
            ),
        ),
    }
    if input.duplicate_or_in_flight {
        blockers.push(CodexAppServerInterruptionAdmissionBlocker::DuplicateOrInFlight);
    }

    blockers
}

fn unsupported_blockers(
    blockers: &[CodexAppServerInterruptionAdmissionBlocker],
) -> Vec<CodexAppServerInterruptionAdmissionBlocker> {
    blockers
        .iter()
        .filter(|blocker| {
            matches!(
                blocker,
                CodexAppServerInterruptionAdmissionBlocker::ProviderInterruptionUnsupported(_)
            )
        })
        .cloned()
        .collect()
}

fn blocker_summary(blockers: &[CodexAppServerInterruptionAdmissionBlocker]) -> String {
    blockers
        .iter()
        .map(|blocker| format!("{blocker:?}"))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        codex_interruption_request, codex_runtime_instance_from_supervision_request,
        CodexAppServerBinary, CodexAppServerInterruptionReasonRef,
        CodexAppServerInterruptionReasonRetentionPolicy, CodexAppServerInterruptionRequestRef,
        CodexAppServerInterruptionTarget, CodexAppServerPayloadRetentionPolicy,
        CodexAppServerRuntimeInstanceRecord, CodexAppServerRuntimeInstanceState,
        CodexAppServerSchemaEvidenceRef, CodexAppServerSupervisionLimits,
        CodexAppServerSupervisionRequest,
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

    fn request() -> crate::CodexAppServerInterruptionRequest {
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

    fn input() -> CodexAppServerInterruptionAdmissionInput {
        CodexAppServerInterruptionAdmissionInput {
            request: request(),
            interruption_authority_confirmed: true,
            runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
            target_state: CodexAppServerInterruptionTargetState::Interruptible,
            duplicate_or_in_flight: false,
            raw_payload_policy_confirmed: true,
        }
    }

    #[test]
    fn interruption_admission_accepts_authorized_interruptible_target_without_send() {
        let admission = admit_codex_interruption(input());

        assert_eq!(
            admission.status,
            CodexAppServerInterruptionAdmissionStatus::Accepted
        );
        assert!(admission
            .evidence_refs
            .contains(&"evidence:live-spawn-smoke".to_owned()));
        assert!(!admission.provider_send_started);
        assert!(!admission.raw_provider_payload_retained);
        assert!(!admission.recovery_implied);
        assert!(!admission.task_mutation_permitted);
    }

    #[test]
    fn interruption_admission_blocks_missing_authority_stale_or_duplicate_targets() {
        let mut input = input();
        input.interruption_authority_confirmed = false;
        input.runtime_ready_evidence_refs.clear();
        input.target_state =
            CodexAppServerInterruptionTargetState::Stale("provider turn changed".to_owned());
        input.duplicate_or_in_flight = true;

        let admission = admit_codex_interruption(input);

        assert!(matches!(
            admission.status,
            CodexAppServerInterruptionAdmissionStatus::Blocked(_)
        ));
        assert!(admission
            .blockers
            .contains(&CodexAppServerInterruptionAdmissionBlocker::MissingInterruptionAuthority));
        assert!(admission
            .blockers
            .contains(&CodexAppServerInterruptionAdmissionBlocker::MissingRuntimeReadyEvidence));
        assert!(admission.blockers.contains(
            &CodexAppServerInterruptionAdmissionBlocker::TargetStale(
                "provider turn changed".to_owned()
            )
        ));
        assert!(admission
            .blockers
            .contains(&CodexAppServerInterruptionAdmissionBlocker::DuplicateOrInFlight));
        assert!(!admission.provider_send_started);
        assert!(!admission.task_mutation_permitted);
    }

    #[test]
    fn interruption_admission_reports_unsupported_provider_interruption() {
        let mut input = input();
        input.target_state = CodexAppServerInterruptionTargetState::Unsupported(
            "provider lifecycle lacks turn/interrupt".to_owned(),
        );

        let admission = admit_codex_interruption(input);

        assert!(matches!(
            admission.status,
            CodexAppServerInterruptionAdmissionStatus::Unsupported(_)
        ));
        assert!(admission.blockers.contains(
            &CodexAppServerInterruptionAdmissionBlocker::ProviderInterruptionUnsupported(
                "provider lifecycle lacks turn/interrupt".to_owned()
            )
        ));
        assert!(!admission.provider_send_started);
    }
}
