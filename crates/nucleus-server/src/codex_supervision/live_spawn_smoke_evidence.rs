//! Codex live spawn smoke evidence records.
//!
//! Evidence records summarize runner results with refs and byte counts only.
//! They do not retain raw stdout, stderr, provider payloads, or callback data.

use nucleus_command_policy::CommandExecutionStatus;
use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};

use super::live_spawn_smoke_runner::{
    CodexAppServerLiveSpawnSmokeOutcome, CodexAppServerLiveSpawnSmokeRunnerResult,
};

/// Stable id for one live spawn smoke evidence record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerLiveSpawnSmokeEvidenceRecordId(pub String);

/// Sanitized live spawn smoke evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveSpawnSmokeEvidenceRecord {
    pub evidence_id: CodexAppServerLiveSpawnSmokeEvidenceRecordId,
    pub request_id: String,
    pub outcome: CodexAppServerLiveSpawnSmokeOutcome,
    pub command_evidence_id: String,
    pub command_status: CommandExecutionStatus,
    pub stdout_captured_bytes: usize,
    pub stderr_captured_bytes: usize,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub cleanup_required: bool,
    pub summary: Option<String>,
}

/// Build sanitized smoke evidence from a runner result.
pub fn codex_live_spawn_smoke_evidence(
    result: &CodexAppServerLiveSpawnSmokeRunnerResult,
) -> CodexAppServerLiveSpawnSmokeEvidenceRecord {
    CodexAppServerLiveSpawnSmokeEvidenceRecord {
        evidence_id: CodexAppServerLiveSpawnSmokeEvidenceRecordId(format!(
            "evidence:{}:live-spawn-smoke",
            result.request_id
        )),
        request_id: result.request_id.clone(),
        outcome: result.outcome.clone(),
        command_evidence_id: result.spawn.evidence.id.0.clone(),
        command_status: result.spawn.evidence.status.clone(),
        stdout_captured_bytes: result.spawn.output.stdout_captured_bytes,
        stderr_captured_bytes: result.spawn.output.stderr_captured_bytes,
        stdout_truncated: result.spawn.output.stdout_truncated,
        stderr_truncated: result.spawn.output.stderr_truncated,
        cleanup_required: result.outcome == CodexAppServerLiveSpawnSmokeOutcome::CleanupRequired,
        summary: result.spawn.evidence.summary.clone(),
    }
}

/// Convert smoke evidence into a sanitized runtime receipt.
pub fn codex_receipt_from_live_spawn_smoke_evidence(
    evidence: &CodexAppServerLiveSpawnSmokeEvidenceRecord,
) -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:{}:live-spawn-smoke",
            evidence.request_id
        )),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: receipt_status(&evidence.outcome, &evidence.command_status),
        command_ref: Some(EngineRuntimeReceiptRef::CommandEvidenceId(
            evidence.command_evidence_id.clone(),
        )),
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(evidence.request_id.clone())),
        evidence_refs: vec![EngineRuntimeReceiptRef::Custom(
            evidence.evidence_id.0.clone(),
        )],
        artifact_refs: Vec::new(),
        summary: Some(receipt_summary(evidence)),
    }
}

fn receipt_status(
    outcome: &CodexAppServerLiveSpawnSmokeOutcome,
    command_status: &CommandExecutionStatus,
) -> EngineRuntimeReceiptStatus {
    match outcome {
        CodexAppServerLiveSpawnSmokeOutcome::Accepted => match command_status {
            CommandExecutionStatus::TimedOut => EngineRuntimeReceiptStatus::TimedOut,
            CommandExecutionStatus::Failed => EngineRuntimeReceiptStatus::Failed,
            CommandExecutionStatus::BlockedByPolicy => EngineRuntimeReceiptStatus::Blocked,
            _ => EngineRuntimeReceiptStatus::Completed,
        },
        CodexAppServerLiveSpawnSmokeOutcome::Blocked => EngineRuntimeReceiptStatus::Blocked,
        CodexAppServerLiveSpawnSmokeOutcome::Failed => EngineRuntimeReceiptStatus::Failed,
        CodexAppServerLiveSpawnSmokeOutcome::TimedOut => EngineRuntimeReceiptStatus::TimedOut,
        CodexAppServerLiveSpawnSmokeOutcome::CleanupRequired => {
            EngineRuntimeReceiptStatus::RecoveryRequired
        }
    }
}

fn receipt_summary(evidence: &CodexAppServerLiveSpawnSmokeEvidenceRecord) -> String {
    format!(
        "Codex live spawn smoke {:?}: status={:?}, stdout_captured_bytes={}, stderr_captured_bytes={}, stdout_truncated={}, stderr_truncated={}, cleanup_required={}",
        evidence.outcome,
        evidence.command_status,
        evidence.stdout_captured_bytes,
        evidence.stderr_captured_bytes,
        evidence.stdout_truncated,
        evidence.stderr_truncated,
        evidence.cleanup_required
    )
}

#[cfg(test)]
mod tests {
    use nucleus_command_policy::{
        CommandEvidence, CommandEvidenceId, CommandExecutionStatus, CommandOutputRetention,
        CommandRequestId,
    };

    use super::*;
    use crate::local_read_only_spawn::{
        LocalReadOnlySpawnOutcome, LocalReadOnlySpawnOutputSummary, LocalReadOnlySpawnResult,
    };

    fn result(
        outcome: CodexAppServerLiveSpawnSmokeOutcome,
        command_status: CommandExecutionStatus,
    ) -> CodexAppServerLiveSpawnSmokeRunnerResult {
        CodexAppServerLiveSpawnSmokeRunnerResult {
            request_id: "codex-live-spawn-smoke:intent:1".to_owned(),
            outcome,
            spawn: LocalReadOnlySpawnResult {
                outcome: LocalReadOnlySpawnOutcome::Finished,
                evidence: CommandEvidence {
                    id: CommandEvidenceId("command:evidence:1".to_owned()),
                    request_id: CommandRequestId("command:request:1".to_owned()),
                    status: command_status,
                    exit_status: Some(0),
                    retention: CommandOutputRetention::SummaryOnly,
                    summary: Some("bounded process summary".to_owned()),
                    stdout_artifact_ref: None,
                    stderr_artifact_ref: None,
                },
                events: Vec::new(),
                output: LocalReadOnlySpawnOutputSummary {
                    stdout_captured_bytes: 16,
                    stderr_captured_bytes: 0,
                    stdout_truncated: true,
                    stderr_truncated: false,
                },
                rejection: None,
            },
        }
    }

    #[test]
    fn live_spawn_smoke_evidence_keeps_only_counts_and_refs() {
        let evidence = codex_live_spawn_smoke_evidence(&result(
            CodexAppServerLiveSpawnSmokeOutcome::Accepted,
            CommandExecutionStatus::Succeeded,
        ));

        assert_eq!(evidence.command_evidence_id, "command:evidence:1");
        assert_eq!(evidence.stdout_captured_bytes, 16);
        assert!(evidence.stdout_truncated);
        assert!(!evidence.cleanup_required);
        assert!(evidence
            .summary
            .as_deref()
            .unwrap_or_default()
            .contains("summary"));
    }

    #[test]
    fn live_spawn_smoke_evidence_maps_cleanup_required_to_recovery_receipt() {
        let evidence = codex_live_spawn_smoke_evidence(&result(
            CodexAppServerLiveSpawnSmokeOutcome::CleanupRequired,
            CommandExecutionStatus::Failed,
        ));
        let receipt = codex_receipt_from_live_spawn_smoke_evidence(&evidence);

        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::RecoveryRequired);
        assert!(receipt.artifact_refs.is_empty());
        assert!(receipt
            .summary
            .as_deref()
            .unwrap_or_default()
            .contains("cleanup_required=true"));
    }
}
