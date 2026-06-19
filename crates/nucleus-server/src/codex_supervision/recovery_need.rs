//! Codex session recovery need records.
//!
//! These records describe why a Codex session may need resume or repair. They
//! do not issue provider commands, replay raw payloads, or mutate task state.

use nucleus_agent_protocol::{AgentSessionId, AgentSessionRecoveryState};
use nucleus_engine::EngineTaskWorkItemId;
use nucleus_tasks::TaskId;

use super::runtime_instance::{
    CodexAppServerPayloadRetentionPolicy, CodexAppServerRuntimeInstanceRecord,
};
use super::session_binding::CodexAppServerSessionBindingRecord;

/// Stable id for one recovery need.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerRecoveryNeedId(pub String);

/// Summary/evidence ref for recovery context without raw provider payloads.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoverySummaryRef {
    pub summary_ref: String,
    pub summary: String,
}

/// Trigger that caused recovery to be required or reviewed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryTrigger {
    ProcessExit {
        exit_summary: String,
    },
    Reconnect {
        reconnect_summary: String,
    },
    ServerRestart {
        restart_summary: String,
    },
    ProviderIdentityMismatch {
        expected_thread_id: Option<String>,
        observed_thread_id: Option<String>,
    },
}

/// Record that a Codex session needs resume or repair.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoveryNeedRecord {
    pub need_id: CodexAppServerRecoveryNeedId,
    pub runtime_instance_id: String,
    pub session_id: AgentSessionId,
    pub provider_thread_id: Option<String>,
    pub provider_session_id: Option<String>,
    pub provider_turn_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub trigger: CodexAppServerRecoveryTrigger,
    pub recovery_state: AgentSessionRecoveryState,
    pub summary_ref: CodexAppServerRecoverySummaryRef,
    pub evidence_refs: Vec<String>,
    pub resume_command_issued: bool,
    pub raw_provider_payload_retained: bool,
    pub task_mutation_permitted: bool,
}

/// Rejection before a recovery need can be recorded.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryNeedRejection {
    EmptyRuntimeInstanceId,
    EmptySessionId,
    EmptyTaskId,
    EmptyWorkItemId,
    EmptySummaryRef,
    EmptySummary,
    EmptyTriggerSummary,
    EmptyProviderIdentityMismatch,
    RawProviderPayloadRetentionNotAllowed,
}

/// Build a recovery need record from a known session binding.
pub fn codex_recovery_need_record(
    runtime: &CodexAppServerRuntimeInstanceRecord,
    binding: &CodexAppServerSessionBindingRecord,
    provider_turn_id: Option<String>,
    provider_request_id: Option<String>,
    task_id: TaskId,
    work_item_id: EngineTaskWorkItemId,
    trigger: CodexAppServerRecoveryTrigger,
    summary_ref: CodexAppServerRecoverySummaryRef,
    payload_retention: CodexAppServerPayloadRetentionPolicy,
) -> Result<CodexAppServerRecoveryNeedRecord, CodexAppServerRecoveryNeedRejection> {
    validate_recovery_need(
        runtime,
        binding,
        &task_id,
        &work_item_id,
        &trigger,
        &summary_ref,
        &payload_retention,
    )?;

    Ok(CodexAppServerRecoveryNeedRecord {
        need_id: CodexAppServerRecoveryNeedId(format!(
            "codex-recovery:{}:{}:{}",
            runtime.runtime_instance_id.0,
            binding.nucleus_session_id.0,
            trigger_key(&trigger)
        )),
        runtime_instance_id: runtime.runtime_instance_id.0.clone(),
        session_id: binding.nucleus_session_id.clone(),
        provider_thread_id: binding.provider_refs.thread_id.clone(),
        provider_session_id: binding.provider_refs.session_id.clone(),
        provider_turn_id,
        provider_request_id,
        task_id,
        work_item_id,
        trigger,
        recovery_state: AgentSessionRecoveryState::RecoveryRequired,
        evidence_refs: evidence_refs(runtime, binding, &summary_ref),
        summary_ref,
        resume_command_issued: false,
        raw_provider_payload_retained: false,
        task_mutation_permitted: false,
    })
}

fn validate_recovery_need(
    runtime: &CodexAppServerRuntimeInstanceRecord,
    binding: &CodexAppServerSessionBindingRecord,
    task_id: &TaskId,
    work_item_id: &EngineTaskWorkItemId,
    trigger: &CodexAppServerRecoveryTrigger,
    summary_ref: &CodexAppServerRecoverySummaryRef,
    payload_retention: &CodexAppServerPayloadRetentionPolicy,
) -> Result<(), CodexAppServerRecoveryNeedRejection> {
    if runtime.runtime_instance_id.0.is_empty() {
        return Err(CodexAppServerRecoveryNeedRejection::EmptyRuntimeInstanceId);
    }
    if binding.nucleus_session_id.0.is_empty() {
        return Err(CodexAppServerRecoveryNeedRejection::EmptySessionId);
    }
    if task_id.0.is_empty() {
        return Err(CodexAppServerRecoveryNeedRejection::EmptyTaskId);
    }
    if work_item_id.0.is_empty() {
        return Err(CodexAppServerRecoveryNeedRejection::EmptyWorkItemId);
    }
    if summary_ref.summary_ref.is_empty() {
        return Err(CodexAppServerRecoveryNeedRejection::EmptySummaryRef);
    }
    if summary_ref.summary.is_empty() {
        return Err(CodexAppServerRecoveryNeedRejection::EmptySummary);
    }
    validate_trigger(trigger)?;
    if payload_retention == &CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed {
        return Err(CodexAppServerRecoveryNeedRejection::RawProviderPayloadRetentionNotAllowed);
    }

    Ok(())
}

fn validate_trigger(
    trigger: &CodexAppServerRecoveryTrigger,
) -> Result<(), CodexAppServerRecoveryNeedRejection> {
    match trigger {
        CodexAppServerRecoveryTrigger::ProcessExit { exit_summary }
        | CodexAppServerRecoveryTrigger::Reconnect {
            reconnect_summary: exit_summary,
        }
        | CodexAppServerRecoveryTrigger::ServerRestart {
            restart_summary: exit_summary,
        } if exit_summary.is_empty() => {
            Err(CodexAppServerRecoveryNeedRejection::EmptyTriggerSummary)
        }
        CodexAppServerRecoveryTrigger::ProviderIdentityMismatch {
            expected_thread_id,
            observed_thread_id,
        } if expected_thread_id.as_deref().unwrap_or_default().is_empty()
            && observed_thread_id.as_deref().unwrap_or_default().is_empty() =>
        {
            Err(CodexAppServerRecoveryNeedRejection::EmptyProviderIdentityMismatch)
        }
        _ => Ok(()),
    }
}

fn evidence_refs(
    runtime: &CodexAppServerRuntimeInstanceRecord,
    binding: &CodexAppServerSessionBindingRecord,
    summary_ref: &CodexAppServerRecoverySummaryRef,
) -> Vec<String> {
    let mut refs = runtime.evidence_refs.clone();
    refs.push(binding.evidence_ref.clone());
    refs.push(summary_ref.summary_ref.clone());
    refs
}

fn trigger_key(trigger: &CodexAppServerRecoveryTrigger) -> &'static str {
    match trigger {
        CodexAppServerRecoveryTrigger::ProcessExit { .. } => "process-exit",
        CodexAppServerRecoveryTrigger::Reconnect { .. } => "reconnect",
        CodexAppServerRecoveryTrigger::ServerRestart { .. } => "server-restart",
        CodexAppServerRecoveryTrigger::ProviderIdentityMismatch { .. } => "identity-mismatch",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::test_support::{
        metadata_only, runtime, session_binding, task_id, work_item_id,
    };

    fn summary_ref() -> CodexAppServerRecoverySummaryRef {
        CodexAppServerRecoverySummaryRef {
            summary_ref: "recovery-summary:1".to_owned(),
            summary: "Codex process exited while a task-backed turn was active".to_owned(),
        }
    }

    #[test]
    fn recovery_need_preserves_runtime_session_provider_and_task_identity() {
        let need = codex_recovery_need_record(
            &runtime(),
            &session_binding(),
            Some("turn:provider:1".to_owned()),
            Some("request:provider:1".to_owned()),
            task_id(),
            work_item_id(),
            CodexAppServerRecoveryTrigger::ProcessExit {
                exit_summary: "process exited before terminal turn event".to_owned(),
            },
            summary_ref(),
            metadata_only(),
        )
        .expect("recovery need");

        assert!(need.need_id.0.contains("process-exit"));
        assert_eq!(need.session_id, AgentSessionId("session:1".to_owned()));
        assert_eq!(
            need.provider_thread_id,
            Some("thread:provider:1".to_owned())
        );
        assert_eq!(need.provider_turn_id, Some("turn:provider:1".to_owned()));
        assert_eq!(need.task_id, task_id());
        assert_eq!(need.work_item_id, work_item_id());
        assert_eq!(
            need.recovery_state,
            AgentSessionRecoveryState::RecoveryRequired
        );
        assert!(need
            .evidence_refs
            .contains(&"evidence:codex-schema".to_owned()));
        assert!(need.evidence_refs.contains(&"evidence:binding".to_owned()));
        assert!(need
            .evidence_refs
            .contains(&"recovery-summary:1".to_owned()));
        assert!(!need.resume_command_issued);
        assert!(!need.raw_provider_payload_retained);
        assert!(!need.task_mutation_permitted);
    }

    #[test]
    fn recovery_need_accepts_identity_mismatch_with_explicit_provider_refs() {
        let need = codex_recovery_need_record(
            &runtime(),
            &session_binding(),
            None,
            None,
            task_id(),
            work_item_id(),
            CodexAppServerRecoveryTrigger::ProviderIdentityMismatch {
                expected_thread_id: Some("thread:expected".to_owned()),
                observed_thread_id: Some("thread:observed".to_owned()),
            },
            summary_ref(),
            metadata_only(),
        )
        .expect("recovery need");

        assert!(matches!(
            need.trigger,
            CodexAppServerRecoveryTrigger::ProviderIdentityMismatch { .. }
        ));
        assert!(!need.resume_command_issued);
        assert!(!need.task_mutation_permitted);
    }

    #[test]
    fn recovery_need_rejects_raw_payload_retention_or_empty_trigger() {
        let rejection = codex_recovery_need_record(
            &runtime(),
            &session_binding(),
            None,
            None,
            task_id(),
            work_item_id(),
            CodexAppServerRecoveryTrigger::ServerRestart {
                restart_summary: String::new(),
            },
            summary_ref(),
            metadata_only(),
        )
        .expect_err("empty trigger summary");

        assert_eq!(
            rejection,
            CodexAppServerRecoveryNeedRejection::EmptyTriggerSummary
        );

        let rejection = codex_recovery_need_record(
            &runtime(),
            &session_binding(),
            None,
            None,
            task_id(),
            work_item_id(),
            CodexAppServerRecoveryTrigger::Reconnect {
                reconnect_summary: "transport reconnected without matching thread".to_owned(),
            },
            summary_ref(),
            CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed,
        )
        .expect_err("raw provider payload retention");

        assert_eq!(
            rejection,
            CodexAppServerRecoveryNeedRejection::RawProviderPayloadRetentionNotAllowed
        );
    }
}
