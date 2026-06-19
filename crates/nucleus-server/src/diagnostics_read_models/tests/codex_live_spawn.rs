use super::*;
use crate::{
    CodexAppServerLiveSpawnSmokeEvidenceRecord, CodexAppServerLiveSpawnSmokeEvidenceRecordId,
    CodexAppServerLiveSpawnSmokeOutcome,
};
use nucleus_command_policy::CommandExecutionStatus;

#[test]
fn codex_live_spawn_smoke_diagnostics_are_read_only_and_sanitized() {
    let diagnostics = codex_live_spawn_smoke_diagnostics(&[
        CodexAppServerLiveSpawnSmokeEvidenceRecord {
            evidence_id: CodexAppServerLiveSpawnSmokeEvidenceRecordId(
                "evidence:smoke:accepted".to_owned(),
            ),
            request_id: "codex-live-spawn-smoke:intent:accepted".to_owned(),
            outcome: CodexAppServerLiveSpawnSmokeOutcome::Accepted,
            command_evidence_id: "command:evidence:accepted".to_owned(),
            command_status: CommandExecutionStatus::Succeeded,
            stdout_captured_bytes: 16,
            stderr_captured_bytes: 0,
            stdout_truncated: true,
            stderr_truncated: false,
            cleanup_required: false,
            summary: Some("bounded startup summary".to_owned()),
        },
        CodexAppServerLiveSpawnSmokeEvidenceRecord {
            evidence_id: CodexAppServerLiveSpawnSmokeEvidenceRecordId(
                "evidence:smoke:cleanup".to_owned(),
            ),
            request_id: "codex-live-spawn-smoke:intent:cleanup".to_owned(),
            outcome: CodexAppServerLiveSpawnSmokeOutcome::CleanupRequired,
            command_evidence_id: "command:evidence:cleanup".to_owned(),
            command_status: CommandExecutionStatus::Failed,
            stdout_captured_bytes: 0,
            stderr_captured_bytes: 0,
            stdout_truncated: false,
            stderr_truncated: false,
            cleanup_required: true,
            summary: Some("cleanup required".to_owned()),
        },
    ]);
    let json = serde_json::to_string(&diagnostics).expect("serialize diagnostics");

    assert_eq!(diagnostics.source_status, "records");
    assert!(!diagnostics.client_can_start_smoke);
    assert!(!diagnostics.client_can_mutate_tasks);
    assert!(!diagnostics.provider_turns_available);
    assert_eq!(diagnostics.smoke_attempts[0].outcome, "accepted");
    assert_eq!(diagnostics.smoke_attempts[0].next_action, "none");
    assert_eq!(
        diagnostics.smoke_attempts[1].next_action,
        "run_cleanup_or_repair_host"
    );
    assert!(diagnostics.smoke_attempts[1].cleanup_required);
    assert!(!json.contains("raw_stdout"));
    assert!(!json.contains("raw_stderr"));
    assert!(!json.contains("raw_provider_payload"));
    assert!(!json.contains("terminal_stream"));
}
