//! Codex turn-start admission policy.
//!
//! Admission records gate a turn-start request before provider send. They do
//! not build provider envelopes, send turns, answer callbacks, cancel provider
//! work, or mutate task state.

use super::turn_start_request::CodexAppServerTurnStartRequest;

/// Stable id for one turn-start admission decision.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTurnStartAdmissionId(pub String);

/// Explicit posture for behavior deferred to later gates.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartDeferredPolicy {
    ExplicitlyDeferred,
    Unspecified,
}

/// Input used to admit or block a Codex turn-start request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartAdmissionInput {
    pub request: CodexAppServerTurnStartRequest,
    pub runtime_ready_evidence_refs: Vec<String>,
    pub task_work_ready: bool,
    pub assignment_ready: bool,
    pub callback_policy: CodexAppServerTurnStartDeferredPolicy,
    pub cancellation_policy: CodexAppServerTurnStartDeferredPolicy,
    pub raw_payload_policy_confirmed: bool,
}

/// Admission record for a turn-start request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartAdmission {
    pub admission_id: CodexAppServerTurnStartAdmissionId,
    pub request_id: String,
    pub status: CodexAppServerTurnStartAdmissionStatus,
    pub blockers: Vec<CodexAppServerTurnStartAdmissionBlocker>,
    pub evidence_refs: Vec<String>,
    pub provider_send_started: bool,
    pub task_mutation_permitted: bool,
}

/// Admission status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartAdmissionStatus {
    Accepted,
    Blocked(String),
}

/// Reason turn-start admission is blocked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartAdmissionBlocker {
    MissingRuntimeReadyEvidence,
    TaskWorkNotReady,
    AssignmentNotReady,
    CallbackPolicyUnspecified,
    CancellationPolicyUnspecified,
    RawPayloadPolicyUnconfirmed,
}

/// Admit or block a Codex turn-start request before provider send.
pub fn admit_codex_turn_start(
    input: CodexAppServerTurnStartAdmissionInput,
) -> CodexAppServerTurnStartAdmission {
    let blockers = admission_blockers(&input);
    let status = if blockers.is_empty() {
        CodexAppServerTurnStartAdmissionStatus::Accepted
    } else {
        CodexAppServerTurnStartAdmissionStatus::Blocked(blocker_summary(&blockers))
    };
    let request_id = input.request.request_id().0.clone();
    let mut evidence_refs = input.request.evidence_refs().to_vec();
    evidence_refs.extend(input.runtime_ready_evidence_refs);

    CodexAppServerTurnStartAdmission {
        admission_id: CodexAppServerTurnStartAdmissionId(format!(
            "codex-turn-start-admission:{request_id}"
        )),
        request_id,
        status,
        blockers,
        evidence_refs,
        provider_send_started: false,
        task_mutation_permitted: false,
    }
}

fn admission_blockers(
    input: &CodexAppServerTurnStartAdmissionInput,
) -> Vec<CodexAppServerTurnStartAdmissionBlocker> {
    let mut blockers = Vec::new();

    if input.runtime_ready_evidence_refs.is_empty() {
        blockers.push(CodexAppServerTurnStartAdmissionBlocker::MissingRuntimeReadyEvidence);
    }
    if !input.task_work_ready {
        blockers.push(CodexAppServerTurnStartAdmissionBlocker::TaskWorkNotReady);
    }
    if !input.assignment_ready {
        blockers.push(CodexAppServerTurnStartAdmissionBlocker::AssignmentNotReady);
    }
    if input.callback_policy != CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred {
        blockers.push(CodexAppServerTurnStartAdmissionBlocker::CallbackPolicyUnspecified);
    }
    if input.cancellation_policy != CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred {
        blockers.push(CodexAppServerTurnStartAdmissionBlocker::CancellationPolicyUnspecified);
    }
    if !input.raw_payload_policy_confirmed {
        blockers.push(CodexAppServerTurnStartAdmissionBlocker::RawPayloadPolicyUnconfirmed);
    }

    blockers
}

fn blocker_summary(blockers: &[CodexAppServerTurnStartAdmissionBlocker]) -> String {
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
        codex_runtime_instance_from_supervision_request, codex_turn_start_request,
        CodexAppServerBinary, CodexAppServerPayloadRetentionPolicy,
        CodexAppServerRuntimeInstanceState, CodexAppServerSchemaEvidenceRef,
        CodexAppServerSupervisionLimits, CodexAppServerSupervisionRequest,
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

    fn input() -> CodexAppServerTurnStartAdmissionInput {
        CodexAppServerTurnStartAdmissionInput {
            request: request(),
            runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
            task_work_ready: true,
            assignment_ready: true,
            callback_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            cancellation_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            raw_payload_policy_confirmed: true,
        }
    }

    #[test]
    fn turn_start_admission_accepts_ready_request_without_provider_send() {
        let admission = admit_codex_turn_start(input());

        assert_eq!(
            admission.status,
            CodexAppServerTurnStartAdmissionStatus::Accepted
        );
        assert!(!admission.provider_send_started);
        assert!(!admission.task_mutation_permitted);
        assert!(admission
            .evidence_refs
            .contains(&"evidence:live-spawn-smoke".to_owned()));
    }

    #[test]
    fn turn_start_admission_blocks_missing_runtime_or_task_readiness() {
        let mut input = input();
        input.runtime_ready_evidence_refs.clear();
        input.task_work_ready = false;

        let admission = admit_codex_turn_start(input);

        assert!(matches!(
            admission.status,
            CodexAppServerTurnStartAdmissionStatus::Blocked(_)
        ));
        assert!(admission
            .blockers
            .contains(&CodexAppServerTurnStartAdmissionBlocker::MissingRuntimeReadyEvidence));
        assert!(admission
            .blockers
            .contains(&CodexAppServerTurnStartAdmissionBlocker::TaskWorkNotReady));
        assert!(!admission.provider_send_started);
    }

    #[test]
    fn turn_start_admission_requires_explicit_deferred_policies() {
        let mut input = input();
        input.callback_policy = CodexAppServerTurnStartDeferredPolicy::Unspecified;
        input.cancellation_policy = CodexAppServerTurnStartDeferredPolicy::Unspecified;
        input.raw_payload_policy_confirmed = false;

        let admission = admit_codex_turn_start(input);

        assert!(admission
            .blockers
            .contains(&CodexAppServerTurnStartAdmissionBlocker::CallbackPolicyUnspecified));
        assert!(admission
            .blockers
            .contains(&CodexAppServerTurnStartAdmissionBlocker::CancellationPolicyUnspecified));
        assert!(admission
            .blockers
            .contains(&CodexAppServerTurnStartAdmissionBlocker::RawPayloadPolicyUnconfirmed));
    }
}
