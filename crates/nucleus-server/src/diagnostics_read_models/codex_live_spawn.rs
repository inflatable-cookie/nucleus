use serde::{Deserialize, Serialize};

use crate::{
    codex_receipt_from_live_spawn_smoke_evidence, CodexAppServerLiveSpawnSmokeEvidenceRecord,
    CodexAppServerLiveSpawnSmokeOutcome,
};

use super::helpers::{source_status, source_summary};

/// Client-safe diagnostics for Codex live spawn smoke attempts.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexLiveSpawnSmokeDiagnosticsDto {
    pub smoke_attempts: Vec<CodexLiveSpawnSmokeDiagnosticDto>,
    pub client_can_start_smoke: bool,
    pub client_can_mutate_tasks: bool,
    pub provider_turns_available: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

/// One live spawn smoke attempt visible to diagnostics clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexLiveSpawnSmokeDiagnosticDto {
    pub request_id: String,
    pub outcome: String,
    pub command_status: String,
    pub command_evidence_id: String,
    pub receipt_id: String,
    #[ts(as = "u32")]
    pub stdout_captured_bytes: usize,
    #[ts(as = "u32")]
    pub stderr_captured_bytes: usize,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub cleanup_required: bool,
    pub next_action: String,
    pub summary: String,
}

pub fn codex_live_spawn_smoke_diagnostics(
    records: &[CodexAppServerLiveSpawnSmokeEvidenceRecord],
) -> CodexLiveSpawnSmokeDiagnosticsDto {
    CodexLiveSpawnSmokeDiagnosticsDto {
        smoke_attempts: records
            .iter()
            .map(CodexLiveSpawnSmokeDiagnosticDto::from)
            .collect(),
        client_can_start_smoke: false,
        client_can_mutate_tasks: false,
        provider_turns_available: false,
        source_status: source_status(records.len()),
        source_summary: Some(source_summary(
            records.len(),
            "Codex live spawn smoke diagnostics have no evidence records yet",
            "Codex live spawn smoke diagnostics loaded from sanitized evidence",
        )),
    }
}

impl From<&CodexAppServerLiveSpawnSmokeEvidenceRecord> for CodexLiveSpawnSmokeDiagnosticDto {
    fn from(record: &CodexAppServerLiveSpawnSmokeEvidenceRecord) -> Self {
        let receipt = codex_receipt_from_live_spawn_smoke_evidence(record);

        Self {
            request_id: record.request_id.clone(),
            outcome: outcome_label(&record.outcome),
            command_status: format!("{:?}", record.command_status),
            command_evidence_id: record.command_evidence_id.clone(),
            receipt_id: receipt.receipt_id.0,
            stdout_captured_bytes: record.stdout_captured_bytes,
            stderr_captured_bytes: record.stderr_captured_bytes,
            stdout_truncated: record.stdout_truncated,
            stderr_truncated: record.stderr_truncated,
            cleanup_required: record.cleanup_required,
            next_action: next_action(&record.outcome),
            summary: record
                .summary
                .clone()
                .unwrap_or_else(|| "Codex live spawn smoke evidence has no summary".to_owned()),
        }
    }
}

fn outcome_label(outcome: &CodexAppServerLiveSpawnSmokeOutcome) -> String {
    match outcome {
        CodexAppServerLiveSpawnSmokeOutcome::Accepted => "accepted",
        CodexAppServerLiveSpawnSmokeOutcome::Blocked => "blocked",
        CodexAppServerLiveSpawnSmokeOutcome::Failed => "failed",
        CodexAppServerLiveSpawnSmokeOutcome::TimedOut => "timed_out",
        CodexAppServerLiveSpawnSmokeOutcome::CleanupRequired => "cleanup_required",
    }
    .to_owned()
}

fn next_action(outcome: &CodexAppServerLiveSpawnSmokeOutcome) -> String {
    match outcome {
        CodexAppServerLiveSpawnSmokeOutcome::Accepted => "none",
        CodexAppServerLiveSpawnSmokeOutcome::Blocked => "repair_spawn_gate",
        CodexAppServerLiveSpawnSmokeOutcome::Failed => "inspect_spawn_failure",
        CodexAppServerLiveSpawnSmokeOutcome::TimedOut => "review_timeout_or_limits",
        CodexAppServerLiveSpawnSmokeOutcome::CleanupRequired => "run_cleanup_or_repair_host",
    }
    .to_owned()
}
