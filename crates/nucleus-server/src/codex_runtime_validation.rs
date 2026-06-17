//! Codex runtime supervision closeout validation.
//!
//! This module records the evidence needed before the first task-backed Codex
//! workflow lane starts. It does not open provider sessions or run recovery.

use nucleus_agent_protocol::{AgentSessionRecoveryState, CodexRecoveryFallback};
use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};

use crate::codex_supervision::{CodexAppServerLiveIngestion, CodexAppServerLiveIngestionStatus};
use crate::codex_wait_state::CodexWaitStateRouting;

/// Evidence needed to close the Codex live-runtime supervision lane.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRuntimeValidationEvidence {
    pub recovery_receipts: Vec<EngineRuntimeReceiptRecord>,
    pub live_ingestions: Vec<CodexAppServerLiveIngestion>,
    pub wait_routes: Vec<CodexWaitStateRouting>,
    pub task_backed_gate: CodexTaskBackedWorkGate,
}

/// Closeout report for Codex runtime supervision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRuntimeValidationReport {
    pub status: CodexRuntimeValidationStatus,
    pub blockers: Vec<CodexRuntimeValidationBlocker>,
    pub task_backed_gate: CodexTaskBackedWorkGate,
}

/// Runtime validation readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexRuntimeValidationStatus {
    ReadyForTaskBackedWork,
    Blocked,
}

/// Missing evidence that blocks the next lane.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexRuntimeValidationBlocker {
    MissingRecoveryState,
    MissingUnsupportedObservation,
    MissingInterruptionReceipt,
    MissingFailureReceipt,
    MissingWaitState,
    TaskBackedGateBlocked(String),
}

/// Gate into the first task-backed Codex work unit lane.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskBackedWorkGate {
    pub ready: bool,
    pub blockers: Vec<String>,
}

/// Build a recovery receipt from an explicit Codex resume fallback.
pub fn codex_recovery_receipt_from_fallback(
    fallback: &CodexRecoveryFallback,
    provider_instance_id: impl Into<String>,
) -> EngineRuntimeReceiptRecord {
    let provider_instance_id = provider_instance_id.into();
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:codex:recovery:{}",
            fallback.nucleus_session_id.0
        )),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: recovery_receipt_status(&fallback.recovery_state),
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(format!(
            "{}:{}",
            provider_instance_id, fallback.nucleus_session_id.0
        ))),
        evidence_refs: Vec::new(),
        artifact_refs: Vec::new(),
        summary: Some(format!("Codex recovery fallback: {}", fallback.reason)),
    }
}

/// Validate the evidence needed to move from live runtime supervision to tasks.
pub fn validate_codex_runtime_supervision(
    evidence: CodexRuntimeValidationEvidence,
) -> CodexRuntimeValidationReport {
    let mut blockers = Vec::new();

    if !evidence
        .recovery_receipts
        .iter()
        .any(is_explicit_recovery_receipt)
    {
        blockers.push(CodexRuntimeValidationBlocker::MissingRecoveryState);
    }

    if !evidence
        .live_ingestions
        .iter()
        .any(|ingestion| ingestion.status == CodexAppServerLiveIngestionStatus::Unsupported)
    {
        blockers.push(CodexRuntimeValidationBlocker::MissingUnsupportedObservation);
    }

    if !evidence
        .recovery_receipts
        .iter()
        .any(|receipt| receipt.status == EngineRuntimeReceiptStatus::Cancelled)
    {
        blockers.push(CodexRuntimeValidationBlocker::MissingInterruptionReceipt);
    }

    if !evidence
        .recovery_receipts
        .iter()
        .any(|receipt| receipt.status == EngineRuntimeReceiptStatus::Failed)
    {
        blockers.push(CodexRuntimeValidationBlocker::MissingFailureReceipt);
    }

    if !evidence
        .wait_routes
        .iter()
        .any(|route| route.wait_state.is_some() && route.runtime_receipt.is_some())
    {
        blockers.push(CodexRuntimeValidationBlocker::MissingWaitState);
    }

    blockers.extend(
        evidence
            .task_backed_gate
            .blockers
            .iter()
            .cloned()
            .map(CodexRuntimeValidationBlocker::TaskBackedGateBlocked),
    );
    if !evidence.task_backed_gate.ready && evidence.task_backed_gate.blockers.is_empty() {
        blockers.push(CodexRuntimeValidationBlocker::TaskBackedGateBlocked(
            "task-backed gate is not marked ready".to_owned(),
        ));
    }

    let status = if blockers.is_empty() {
        CodexRuntimeValidationStatus::ReadyForTaskBackedWork
    } else {
        CodexRuntimeValidationStatus::Blocked
    };

    CodexRuntimeValidationReport {
        status,
        blockers,
        task_backed_gate: evidence.task_backed_gate,
    }
}

fn recovery_receipt_status(state: &AgentSessionRecoveryState) -> EngineRuntimeReceiptStatus {
    match state {
        AgentSessionRecoveryState::NotNeeded | AgentSessionRecoveryState::Recoverable => {
            EngineRuntimeReceiptStatus::Recovered
        }
        AgentSessionRecoveryState::RecoveryRequired => EngineRuntimeReceiptStatus::RecoveryRequired,
        AgentSessionRecoveryState::RecoveryFailed(_) => EngineRuntimeReceiptStatus::Failed,
        AgentSessionRecoveryState::Unknown => EngineRuntimeReceiptStatus::Unknown,
    }
}

fn is_explicit_recovery_receipt(receipt: &EngineRuntimeReceiptRecord) -> bool {
    matches!(
        receipt.status,
        EngineRuntimeReceiptStatus::RecoveryRequired
            | EngineRuntimeReceiptStatus::Recovered
            | EngineRuntimeReceiptStatus::Failed
            | EngineRuntimeReceiptStatus::Unknown
    ) && receipt.receipt_id.0.starts_with("receipt:codex:recovery:")
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::{
        AgentSessionId, ApprovalScope, CodexAppServerEventFixture, CodexAppServerFixturePayload,
        CodexAppServerProviderRefs, CodexRecoveryFallback, CodexRuntimeReceiptFixture,
        CodexRuntimeReceiptStatus,
    };
    use nucleus_engine::runtime_receipt_from_codex_fixture;

    use crate::codex_supervision::{ingest_codex_app_server_live_frame, CodexAppServerLiveFrame};
    use crate::codex_wait_state::route_codex_wait_state_from_ingestion;

    fn provider_refs() -> CodexAppServerProviderRefs {
        CodexAppServerProviderRefs {
            thread_id: Some("thread:provider".to_owned()),
            session_id: Some("session:provider".to_owned()),
            turn_id: Some("turn:provider".to_owned()),
            item_id: Some("item:provider".to_owned()),
            request_id: Some("request:provider".to_owned()),
        }
    }

    fn frame(method: &str, payload: CodexAppServerFixturePayload) -> CodexAppServerLiveFrame {
        CodexAppServerLiveFrame {
            fixture: CodexAppServerEventFixture {
                method: method.to_owned(),
                provider_instance_id: "codex:local-default".to_owned(),
                nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
                provider_refs: provider_refs(),
                sequence: 23,
                payload,
                raw_payload: None,
            },
            transport_sequence: 42,
        }
    }

    fn receipt(status: CodexRuntimeReceiptStatus, summary: &str) -> EngineRuntimeReceiptRecord {
        runtime_receipt_from_codex_fixture(&CodexRuntimeReceiptFixture {
            receipt_id: format!("receipt:codex:{summary}"),
            provider_instance_id: "codex:local-default".to_owned(),
            nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
            provider_refs: provider_refs(),
            status,
            evidence_event_id: Some(format!("event:codex:{summary}")),
            summary: summary.to_owned(),
        })
    }

    #[test]
    fn recovery_fallback_receipt_records_explicit_recovery_state() {
        let fallback = CodexRecoveryFallback {
            nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
            requested_thread_id: Some("thread:old".to_owned()),
            replacement_thread_id: Some("thread:new".to_owned()),
            reason: "thread/resume failed; replacement thread required".to_owned(),
            recovery_state: AgentSessionRecoveryState::RecoveryRequired,
        };

        let receipt = codex_recovery_receipt_from_fallback(&fallback, "codex:local-default");

        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::RecoveryRequired);
        assert_eq!(
            receipt.summary.as_deref(),
            Some("Codex recovery fallback: thread/resume failed; replacement thread required")
        );
    }

    #[test]
    fn validation_report_allows_task_backed_gate_after_required_evidence() {
        let unsupported = ingest_codex_app_server_live_frame(frame(
            "item/fileChange/requestApproval",
            CodexAppServerFixturePayload::ApprovalRequest {
                prompt: "approve file change".to_owned(),
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned(), "deny".to_owned()],
            },
        ));
        let approval = ingest_codex_app_server_live_frame(frame(
            "item/commandExecution/requestApproval",
            CodexAppServerFixturePayload::ApprovalRequest {
                prompt: "run command?".to_owned(),
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned(), "deny".to_owned()],
            },
        ));
        let wait_route = route_codex_wait_state_from_ingestion(&approval);
        let recovery = codex_recovery_receipt_from_fallback(
            &CodexRecoveryFallback {
                nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
                requested_thread_id: Some("thread:old".to_owned()),
                replacement_thread_id: Some("thread:new".to_owned()),
                reason: "thread/resume failed; replacement thread required".to_owned(),
                recovery_state: AgentSessionRecoveryState::RecoveryRequired,
            },
            "codex:local-default",
        );

        let report = validate_codex_runtime_supervision(CodexRuntimeValidationEvidence {
            recovery_receipts: vec![
                recovery,
                receipt(CodexRuntimeReceiptStatus::Cancelled, "interrupted"),
                receipt(CodexRuntimeReceiptStatus::Failed, "failed"),
            ],
            live_ingestions: vec![unsupported, approval],
            wait_routes: vec![wait_route],
            task_backed_gate: CodexTaskBackedWorkGate {
                ready: true,
                blockers: Vec::new(),
            },
        });

        assert_eq!(
            report.status,
            CodexRuntimeValidationStatus::ReadyForTaskBackedWork
        );
        assert!(report.blockers.is_empty());
    }

    #[test]
    fn validation_report_blocks_when_failure_or_task_gate_evidence_is_missing() {
        let report = validate_codex_runtime_supervision(CodexRuntimeValidationEvidence {
            recovery_receipts: Vec::new(),
            live_ingestions: Vec::new(),
            wait_routes: Vec::new(),
            task_backed_gate: CodexTaskBackedWorkGate {
                ready: false,
                blockers: vec!["task attempt contract not wired".to_owned()],
            },
        });

        assert_eq!(report.status, CodexRuntimeValidationStatus::Blocked);
        assert!(report
            .blockers
            .contains(&CodexRuntimeValidationBlocker::MissingRecoveryState));
        assert!(report
            .blockers
            .contains(&CodexRuntimeValidationBlocker::MissingFailureReceipt));
        assert!(report
            .blockers
            .contains(&CodexRuntimeValidationBlocker::TaskBackedGateBlocked(
                "task attempt contract not wired".to_owned()
            )));
    }
}
