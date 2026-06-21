use super::live::LiveCodexSmokeOutcome;

use nucleus_server::{
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeStatus, DurableCodexLiveProviderWriteEvidenceInput,
    DurableCodexLiveProviderWriteInvocationGateRecord, DurableCodexLiveSmokeDispatchRunRecord,
};

pub(super) fn durable_live_provider_write_evidence_input_from_outcome(
    run: DurableCodexLiveSmokeDispatchRunRecord,
    gate: DurableCodexLiveProviderWriteInvocationGateRecord,
    outcome: LiveCodexSmokeOutcome,
) -> DurableCodexLiveProviderWriteEvidenceInput {
    DurableCodexLiveProviderWriteEvidenceInput {
        run,
        gate,
        existing_write_attempt_ids: Vec::new(),
        thread_id: outcome.thread_id,
        turn_id: outcome.turn_id,
        final_turn_status: outcome.turn_status,
        status: if outcome.provider_write_executed {
            CodexAppServerLiveExecutorOutcomeStatus::Completed
        } else {
            CodexAppServerLiveExecutorOutcomeStatus::Blocked(
                "durable live provider-write gate blocked".to_owned(),
            )
        },
        method_sequence: if outcome.provider_write_executed {
            LiveCodexSmokeOutcome::completed_method_sequence()
        } else {
            Vec::new()
        },
        notification_count: outcome.notifications_seen,
        server_request_count: outcome.server_requests_seen,
        cleanup_status: if outcome.provider_write_executed {
            CodexAppServerLiveExecutorCleanupStatus::Completed
        } else {
            CodexAppServerLiveExecutorCleanupStatus::NotRequired
        },
        evidence_refs: vec!["evidence:nucleusd-durable-live-provider-write-outcome".to_owned()],
        artifact_refs: vec!["artifact:nucleusd-durable-live-provider-write-summary".to_owned()],
        raw_provider_material_present: false,
        raw_stream_present: false,
        secret_material_present: false,
        credential_material_present: false,
        unbounded_local_path_present: false,
    }
}

pub(super) fn durable_live_provider_write_terminal_evidence_input(
    run: DurableCodexLiveSmokeDispatchRunRecord,
    gate: DurableCodexLiveProviderWriteInvocationGateRecord,
    status: CodexAppServerLiveExecutorOutcomeStatus,
    cleanup_status: CodexAppServerLiveExecutorCleanupStatus,
) -> DurableCodexLiveProviderWriteEvidenceInput {
    DurableCodexLiveProviderWriteEvidenceInput {
        run,
        gate,
        existing_write_attempt_ids: Vec::new(),
        thread_id: None,
        turn_id: None,
        final_turn_status: None,
        status,
        method_sequence: vec![CodexAppServerLiveExecutorMethod::Initialize],
        notification_count: 0,
        server_request_count: 0,
        cleanup_status,
        evidence_refs: vec![
            "evidence:nucleusd-durable-live-provider-write-terminal-outcome".to_owned(),
        ],
        artifact_refs: vec![
            "artifact:nucleusd-durable-live-provider-write-terminal-summary".to_owned(),
        ],
        raw_provider_material_present: false,
        raw_stream_present: false,
        secret_material_present: false,
        credential_material_present: false,
        unbounded_local_path_present: false,
    }
}
