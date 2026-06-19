//! Codex recovery admission policy.
//!
//! Admission records gate recovery/resume attempts before provider send. They
//! do not build provider envelopes, resume Codex, or mutate task state.

use nucleus_agent_protocol::AgentSessionRecoveryState;

use super::recovery_need::{CodexAppServerRecoveryNeedRecord, CodexAppServerRecoveryTrigger};

/// Stable id for one recovery admission decision.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerRecoveryAdmissionId(pub String);

/// Provider/runtime capability available for this recovery need.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryCapability {
    ThreadResumeSupported,
    RepairOnly(String),
    Unsupported(String),
}

/// Input used to admit or block a Codex recovery attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoveryAdmissionInput {
    pub need: CodexAppServerRecoveryNeedRecord,
    pub recovery_authority_confirmed: bool,
    pub runtime_ready_evidence_refs: Vec<String>,
    pub provider_identity_evidence_refs: Vec<String>,
    pub resume_capability: CodexAppServerRecoveryCapability,
    pub replacement_thread_observed: bool,
    pub raw_payload_policy_confirmed: bool,
}

/// Admission record for a future Codex resume or repair attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoveryAdmission {
    pub admission_id: CodexAppServerRecoveryAdmissionId,
    pub need_id: String,
    pub session_id: String,
    pub provider_thread_id: Option<String>,
    pub provider_turn_id: Option<String>,
    pub status: CodexAppServerRecoveryAdmissionStatus,
    pub blockers: Vec<CodexAppServerRecoveryAdmissionBlocker>,
    pub evidence_refs: Vec<String>,
    pub provider_send_started: bool,
    pub raw_provider_payload_retained: bool,
    pub task_mutation_permitted: bool,
}

/// Admission status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryAdmissionStatus {
    Accepted,
    Blocked(String),
    Unsupported(String),
}

/// Reason recovery admission is blocked or unsupported.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryAdmissionBlocker {
    MissingRecoveryAuthority,
    MissingRuntimeReadyEvidence,
    MissingProviderIdentityEvidence,
    MissingProviderThreadId,
    ReplacementThreadUnsafe(String),
    RecoveryNotRequired,
    RawPayloadPolicyUnconfirmed,
    RepairOnly(String),
    ProviderResumeUnsupported(String),
}

/// Admit or block a Codex recovery attempt before provider send.
pub fn admit_codex_recovery(
    input: CodexAppServerRecoveryAdmissionInput,
) -> CodexAppServerRecoveryAdmission {
    let blockers = admission_blockers(&input);
    let unsupported = unsupported_blockers(&blockers);
    let status = if !unsupported.is_empty() {
        CodexAppServerRecoveryAdmissionStatus::Unsupported(blocker_summary(&unsupported))
    } else if blockers.is_empty() {
        CodexAppServerRecoveryAdmissionStatus::Accepted
    } else {
        CodexAppServerRecoveryAdmissionStatus::Blocked(blocker_summary(&blockers))
    };
    let need_id = input.need.need_id.0.clone();
    let mut evidence_refs = input.need.evidence_refs.clone();
    evidence_refs.extend(input.runtime_ready_evidence_refs);
    evidence_refs.extend(input.provider_identity_evidence_refs);

    CodexAppServerRecoveryAdmission {
        admission_id: CodexAppServerRecoveryAdmissionId(format!(
            "codex-recovery-admission:{need_id}"
        )),
        need_id,
        session_id: input.need.session_id.0,
        provider_thread_id: input.need.provider_thread_id,
        provider_turn_id: input.need.provider_turn_id,
        status,
        blockers,
        evidence_refs,
        provider_send_started: false,
        raw_provider_payload_retained: false,
        task_mutation_permitted: false,
    }
}

fn admission_blockers(
    input: &CodexAppServerRecoveryAdmissionInput,
) -> Vec<CodexAppServerRecoveryAdmissionBlocker> {
    let mut blockers = Vec::new();

    if !input.recovery_authority_confirmed {
        blockers.push(CodexAppServerRecoveryAdmissionBlocker::MissingRecoveryAuthority);
    }
    if input.runtime_ready_evidence_refs.is_empty() {
        blockers.push(CodexAppServerRecoveryAdmissionBlocker::MissingRuntimeReadyEvidence);
    }
    if input.provider_identity_evidence_refs.is_empty() {
        blockers.push(CodexAppServerRecoveryAdmissionBlocker::MissingProviderIdentityEvidence);
    }
    if input.need.provider_thread_id.is_none() {
        blockers.push(CodexAppServerRecoveryAdmissionBlocker::MissingProviderThreadId);
    }
    if input.need.recovery_state != AgentSessionRecoveryState::RecoveryRequired {
        blockers.push(CodexAppServerRecoveryAdmissionBlocker::RecoveryNotRequired);
    }
    if !input.raw_payload_policy_confirmed {
        blockers.push(CodexAppServerRecoveryAdmissionBlocker::RawPayloadPolicyUnconfirmed);
    }
    blockers.extend(capability_blockers(&input.resume_capability));
    blockers.extend(replacement_thread_blockers(input));

    blockers
}

fn capability_blockers(
    capability: &CodexAppServerRecoveryCapability,
) -> Vec<CodexAppServerRecoveryAdmissionBlocker> {
    match capability {
        CodexAppServerRecoveryCapability::ThreadResumeSupported => Vec::new(),
        CodexAppServerRecoveryCapability::RepairOnly(reason) => {
            vec![CodexAppServerRecoveryAdmissionBlocker::RepairOnly(
                reason.clone(),
            )]
        }
        CodexAppServerRecoveryCapability::Unsupported(reason) => {
            vec![CodexAppServerRecoveryAdmissionBlocker::ProviderResumeUnsupported(reason.clone())]
        }
    }
}

fn replacement_thread_blockers(
    input: &CodexAppServerRecoveryAdmissionInput,
) -> Vec<CodexAppServerRecoveryAdmissionBlocker> {
    let mut blockers = Vec::new();

    if input.replacement_thread_observed {
        blockers.push(
            CodexAppServerRecoveryAdmissionBlocker::ReplacementThreadUnsafe(
                "replacement thread already observed before resume admission".to_owned(),
            ),
        );
    }
    if let CodexAppServerRecoveryTrigger::ProviderIdentityMismatch {
        expected_thread_id,
        observed_thread_id,
    } = &input.need.trigger
    {
        blockers.push(
            CodexAppServerRecoveryAdmissionBlocker::ReplacementThreadUnsafe(format!(
                "provider identity mismatch expected={:?} observed={:?}",
                expected_thread_id, observed_thread_id
            )),
        );
    }

    blockers
}

fn unsupported_blockers(
    blockers: &[CodexAppServerRecoveryAdmissionBlocker],
) -> Vec<CodexAppServerRecoveryAdmissionBlocker> {
    blockers
        .iter()
        .filter(|blocker| {
            matches!(
                blocker,
                CodexAppServerRecoveryAdmissionBlocker::ProviderResumeUnsupported(_)
                    | CodexAppServerRecoveryAdmissionBlocker::RepairOnly(_)
            )
        })
        .cloned()
        .collect()
}

fn blocker_summary(blockers: &[CodexAppServerRecoveryAdmissionBlocker]) -> String {
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
        codex_recovery_need_record,
        test_support::{metadata_only, runtime, session_binding, task_id, work_item_id},
        CodexAppServerRecoverySummaryRef,
    };

    fn summary_ref() -> CodexAppServerRecoverySummaryRef {
        CodexAppServerRecoverySummaryRef {
            summary_ref: "recovery-summary:1".to_owned(),
            summary: "Codex process exited while a task-backed turn was active".to_owned(),
        }
    }

    fn need(trigger: CodexAppServerRecoveryTrigger) -> CodexAppServerRecoveryNeedRecord {
        codex_recovery_need_record(
            &runtime(),
            &session_binding(),
            Some("turn:provider:1".to_owned()),
            Some("request:provider:1".to_owned()),
            task_id(),
            work_item_id(),
            trigger,
            summary_ref(),
            metadata_only(),
        )
        .expect("recovery need")
    }

    fn input() -> CodexAppServerRecoveryAdmissionInput {
        CodexAppServerRecoveryAdmissionInput {
            need: need(CodexAppServerRecoveryTrigger::ProcessExit {
                exit_summary: "process exited before terminal turn event".to_owned(),
            }),
            recovery_authority_confirmed: true,
            runtime_ready_evidence_refs: vec!["evidence:runtime-ready".to_owned()],
            provider_identity_evidence_refs: vec!["evidence:provider-thread".to_owned()],
            resume_capability: CodexAppServerRecoveryCapability::ThreadResumeSupported,
            replacement_thread_observed: false,
            raw_payload_policy_confirmed: true,
        }
    }

    #[test]
    fn recovery_admission_accepts_authorized_resume_without_provider_send() {
        let admission = admit_codex_recovery(input());

        assert_eq!(
            admission.status,
            CodexAppServerRecoveryAdmissionStatus::Accepted
        );
        assert!(admission.need_id.contains("process-exit"));
        assert_eq!(admission.session_id, "session:1");
        assert_eq!(
            admission.provider_thread_id,
            Some("thread:provider:1".to_owned())
        );
        assert_eq!(
            admission.provider_turn_id,
            Some("turn:provider:1".to_owned())
        );
        assert!(admission
            .evidence_refs
            .contains(&"evidence:runtime-ready".to_owned()));
        assert!(admission
            .evidence_refs
            .contains(&"evidence:provider-thread".to_owned()));
        assert!(!admission.provider_send_started);
        assert!(!admission.raw_provider_payload_retained);
        assert!(!admission.task_mutation_permitted);
    }

    #[test]
    fn recovery_admission_blocks_missing_authority_or_identity_evidence() {
        let mut input = input();
        input.recovery_authority_confirmed = false;
        input.runtime_ready_evidence_refs.clear();
        input.provider_identity_evidence_refs.clear();
        input.raw_payload_policy_confirmed = false;

        let admission = admit_codex_recovery(input);

        assert!(matches!(
            admission.status,
            CodexAppServerRecoveryAdmissionStatus::Blocked(_)
        ));
        assert!(admission
            .blockers
            .contains(&CodexAppServerRecoveryAdmissionBlocker::MissingRecoveryAuthority));
        assert!(admission
            .blockers
            .contains(&CodexAppServerRecoveryAdmissionBlocker::MissingRuntimeReadyEvidence));
        assert!(admission
            .blockers
            .contains(&CodexAppServerRecoveryAdmissionBlocker::MissingProviderIdentityEvidence));
        assert!(admission
            .blockers
            .contains(&CodexAppServerRecoveryAdmissionBlocker::RawPayloadPolicyUnconfirmed));
        assert!(!admission.provider_send_started);
        assert!(!admission.task_mutation_permitted);
    }

    #[test]
    fn recovery_admission_blocks_replacement_or_missing_thread_cases() {
        let mut input = input();
        input.replacement_thread_observed = true;
        input.need.provider_thread_id = None;

        let admission = admit_codex_recovery(input);

        assert!(matches!(
            admission.status,
            CodexAppServerRecoveryAdmissionStatus::Blocked(_)
        ));
        assert!(admission
            .blockers
            .contains(&CodexAppServerRecoveryAdmissionBlocker::MissingProviderThreadId));
        assert!(admission.blockers.iter().any(|blocker| matches!(
            blocker,
            CodexAppServerRecoveryAdmissionBlocker::ReplacementThreadUnsafe(_)
        )));
        assert!(!admission.provider_send_started);
    }

    #[test]
    fn recovery_admission_reports_unsupported_resume_capability() {
        let mut input = input();
        input.resume_capability = CodexAppServerRecoveryCapability::Unsupported(
            "provider does not support thread resume".to_owned(),
        );

        let admission = admit_codex_recovery(input);

        assert!(matches!(
            admission.status,
            CodexAppServerRecoveryAdmissionStatus::Unsupported(_)
        ));
        assert!(admission.blockers.contains(
            &CodexAppServerRecoveryAdmissionBlocker::ProviderResumeUnsupported(
                "provider does not support thread resume".to_owned()
            )
        ));
        assert!(!admission.provider_send_started);
    }

    #[test]
    fn recovery_admission_blocks_identity_mismatch_as_unsafe_replacement() {
        let input = CodexAppServerRecoveryAdmissionInput {
            need: need(CodexAppServerRecoveryTrigger::ProviderIdentityMismatch {
                expected_thread_id: Some("thread:expected".to_owned()),
                observed_thread_id: Some("thread:observed".to_owned()),
            }),
            ..input()
        };

        let admission = admit_codex_recovery(input);

        assert!(matches!(
            admission.status,
            CodexAppServerRecoveryAdmissionStatus::Blocked(_)
        ));
        assert!(admission.blockers.iter().any(|blocker| matches!(
            blocker,
            CodexAppServerRecoveryAdmissionBlocker::ReplacementThreadUnsafe(_)
        )));
        assert!(!admission.task_mutation_permitted);
    }
}
