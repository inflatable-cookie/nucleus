//! Durable Codex live provider-write evidence capture.
//!
//! This layer turns an invocation-ready gate plus sanitized live outcome facts
//! into durable smoke evidence. It does not retain raw provider material,
//! replay writes, mutate tasks, or accept reviews.

use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

use crate::{
    persist_durable_codex_live_smoke_evidence, CodexAppServerLiveExecutorCleanupStatus,
    CodexAppServerLiveExecutorMethod, CodexAppServerLiveExecutorOutcomeInput,
    CodexAppServerLiveExecutorOutcomeStatus, DurableCodexLiveProviderWriteInvocationGateRecord,
    DurableCodexLiveProviderWriteInvocationGateStatus, DurableCodexLiveSmokeDispatchRunRecord,
    DurableCodexLiveSmokeEvidencePersistenceInput, DurableCodexLiveSmokeEvidenceRecord,
    ServerStateService,
};

/// Input for durable live provider-write evidence capture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableCodexLiveProviderWriteEvidenceInput {
    pub run: DurableCodexLiveSmokeDispatchRunRecord,
    pub gate: DurableCodexLiveProviderWriteInvocationGateRecord,
    pub existing_write_attempt_ids: Vec<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub final_turn_status: Option<String>,
    pub status: CodexAppServerLiveExecutorOutcomeStatus,
    pub method_sequence: Vec<CodexAppServerLiveExecutorMethod>,
    pub notification_count: usize,
    pub server_request_count: usize,
    pub cleanup_status: CodexAppServerLiveExecutorCleanupStatus,
    pub evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub raw_provider_material_present: bool,
    pub raw_stream_present: bool,
    pub secret_material_present: bool,
    pub credential_material_present: bool,
    pub unbounded_local_path_present: bool,
}

/// Persist durable live provider-write evidence through the durable smoke lane.
pub fn persist_durable_live_provider_write_evidence<B>(
    state: &ServerStateService<B>,
    input: DurableCodexLiveProviderWriteEvidenceInput,
) -> LocalStoreResult<DurableCodexLiveSmokeEvidenceRecord>
where
    B: LocalStoreBackend,
{
    let live_outcome = live_outcome(&input);
    let evidence_refs = evidence_refs(&input);
    let persistence = DurableCodexLiveSmokeEvidencePersistenceInput {
        run: input.run,
        live_outcome: Some(live_outcome),
        existing_write_attempt_ids: input.existing_write_attempt_ids,
        persistence_evidence_refs: evidence_refs,
        artifact_refs: input.artifact_refs,
        raw_provider_material_present: input.raw_provider_material_present,
        raw_stream_present: input.raw_stream_present,
        secret_material_present: input.secret_material_present,
        credential_material_present: input.credential_material_present,
        unbounded_local_path_present: input.unbounded_local_path_present,
    };

    persist_durable_codex_live_smoke_evidence(state, persistence)
}

fn live_outcome(
    input: &DurableCodexLiveProviderWriteEvidenceInput,
) -> CodexAppServerLiveExecutorOutcomeInput {
    CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: input.gate.provider_instance_id.clone(),
        write_attempt_id: input.gate.write_attempt_id.clone(),
        receipt_refs: vec![format!(
            "receipt:durable-live-provider-write:{}",
            input.gate.write_attempt_id
        )],
        thread_id: input.thread_id.clone(),
        turn_id: input.turn_id.clone(),
        final_turn_status: input.final_turn_status.clone(),
        status: input.status.clone(),
        method_sequence: input.method_sequence.clone(),
        notification_count: input.notification_count,
        server_request_count: input.server_request_count,
        cleanup_status: input.cleanup_status.clone(),
        evidence_refs: evidence_refs(input),
        provider_write_executed: provider_write_executed(input),
    }
}

fn provider_write_executed(input: &DurableCodexLiveProviderWriteEvidenceInput) -> bool {
    input.gate.status
        == DurableCodexLiveProviderWriteInvocationGateStatus::ReadyForExplicitInvocation
        && input.gate.provider_write_ready
        && matches!(
            input.status,
            CodexAppServerLiveExecutorOutcomeStatus::Completed
                | CodexAppServerLiveExecutorOutcomeStatus::Failed(_)
                | CodexAppServerLiveExecutorOutcomeStatus::TimedOut
                | CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(_)
        )
}

fn evidence_refs(input: &DurableCodexLiveProviderWriteEvidenceInput) -> Vec<String> {
    let mut refs = input.gate.evidence_refs.clone();
    refs.extend(input.evidence_refs.clone());
    refs.sort();
    refs.dedup();
    refs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        durable_codex_live_provider_write_invocation_gate, durable_codex_live_smoke_dispatch_run,
        read_codex_live_executor_outcome_records, read_durable_codex_live_smoke_evidence_records,
        DurableCodexLiveProviderWriteInvocationGateInput, DurableCodexLiveSmokeDispatchRunInput,
        DurableCodexLiveSmokeEvidenceStatus, DurableCodexLiveSmokeIntent, ServerStateService,
    };
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn durable_live_provider_write_evidence_persists_success() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

        let record = persist_durable_live_provider_write_evidence(
            &state,
            input(
                "success",
                CodexAppServerLiveExecutorOutcomeStatus::Completed,
            ),
        )
        .expect("persist success evidence");
        let records =
            read_durable_codex_live_smoke_evidence_records(&state).expect("read evidence");
        let outcomes = read_codex_live_executor_outcome_records(&state).expect("read outcomes");

        assert_eq!(records, vec![record]);
        assert_eq!(outcomes.len(), 1);
        assert_eq!(
            records[0].status,
            DurableCodexLiveSmokeEvidenceStatus::Persisted
        );
        assert!(records[0].provider_write_executed);
        assert_eq!(records[0].thread_id.as_deref(), Some("thread:success"));
        assert_eq!(records[0].turn_id.as_deref(), Some("turn:success"));
        assert_eq!(records[0].method_sequence_count, completed_methods().len());
        assert_eq!(records[0].notification_count, 3);
        assert_eq!(records[0].server_request_count, 1);
        assert!(!records[0].raw_provider_material_retained);
        assert!(!records[0].task_mutation_permitted);
    }

    #[test]
    fn durable_live_provider_write_evidence_keeps_terminal_outcomes_inspectable() {
        for (run_id, status) in [
            (
                "failed",
                CodexAppServerLiveExecutorOutcomeStatus::Failed("provider write failed".to_owned()),
            ),
            (
                "timed-out",
                CodexAppServerLiveExecutorOutcomeStatus::TimedOut,
            ),
            (
                "blocked",
                CodexAppServerLiveExecutorOutcomeStatus::Blocked("preflight blocked".to_owned()),
            ),
            (
                "cleanup",
                CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(
                    "cleanup required".to_owned(),
                ),
            ),
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let state =
                ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

            let record =
                persist_durable_live_provider_write_evidence(&state, input(run_id, status))
                    .expect("persist terminal evidence");

            assert_eq!(
                record.status,
                DurableCodexLiveSmokeEvidenceStatus::Persisted
            );
            assert!(record.live_executor_outcome_id.is_some());
            assert!(record.runtime_receipt_id.is_some());
            assert!(!record.raw_provider_material_retained);
        }
    }

    #[test]
    fn durable_live_provider_write_evidence_rejects_raw_material() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input("raw", CodexAppServerLiveExecutorOutcomeStatus::Completed);
        input.raw_provider_material_present = true;
        input.raw_stream_present = true;

        let record = persist_durable_live_provider_write_evidence(&state, input)
            .expect("raw material is represented as blocked evidence");

        assert!(matches!(
            record.status,
            DurableCodexLiveSmokeEvidenceStatus::Blocked(_)
        ));
        assert!(record.runtime_receipt_id.is_none());
        assert!(!record.raw_provider_material_retained);
        assert!(!record.raw_stream_retained);
    }

    #[test]
    fn durable_live_provider_write_evidence_duplicate_write_attempt_is_noop() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input(
            "duplicate",
            CodexAppServerLiveExecutorOutcomeStatus::Completed,
        );
        input
            .existing_write_attempt_ids
            .push(input.gate.write_attempt_id.clone());

        let record =
            persist_durable_live_provider_write_evidence(&state, input).expect("duplicate noop");

        assert_eq!(
            record.status,
            DurableCodexLiveSmokeEvidenceStatus::DuplicateWriteAttemptNoop
        );
        assert!(record.duplicate_write_attempt_detected);
        assert!(!record.provider_write_executed);
    }

    fn input(
        run_id: &str,
        status: CodexAppServerLiveExecutorOutcomeStatus,
    ) -> DurableCodexLiveProviderWriteEvidenceInput {
        let run = durable_codex_live_smoke_dispatch_run(DurableCodexLiveSmokeDispatchRunInput {
            intent: DurableCodexLiveSmokeIntent::ConfirmedRealWriteWithEffect {
                confirmation_ref: format!("evidence:{run_id}:confirm"),
                effect_ref: format!("evidence:{run_id}:effect"),
            },
            run_id: run_id.to_owned(),
            provider_instance_id: format!("codex:{run_id}"),
            runtime_session_ref: format!("runtime-session:{run_id}"),
            task_id: format!("task:{run_id}"),
            work_item_id: format!("work:{run_id}"),
            operator_confirmation_ref: format!("operator-confirmation:{run_id}"),
            evidence_refs: vec![format!("evidence:{run_id}:command")],
        });
        let gate = durable_codex_live_provider_write_invocation_gate(
            DurableCodexLiveProviderWriteInvocationGateInput {
                boundary: run.boundary.clone(),
                invocation_evidence_refs: vec![format!("evidence:{run_id}:gate")],
                executor_invocation_requested: false,
                provider_write_requested: false,
                raw_provider_material_requested: false,
                raw_stream_requested: false,
                task_mutation_requested: false,
                review_acceptance_requested: false,
                callback_answer_requested: false,
                cancellation_requested: false,
                resume_requested: false,
                scm_mutation_requested: false,
            },
        );

        DurableCodexLiveProviderWriteEvidenceInput {
            run,
            gate,
            existing_write_attempt_ids: Vec::new(),
            thread_id: Some(format!("thread:{run_id}")),
            turn_id: Some(format!("turn:{run_id}")),
            final_turn_status: Some("completed".to_owned()),
            status,
            method_sequence: completed_methods(),
            notification_count: 3,
            server_request_count: 1,
            cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
            evidence_refs: vec![format!("evidence:{run_id}:live")],
            artifact_refs: vec![format!("artifact:{run_id}:summary")],
            raw_provider_material_present: false,
            raw_stream_present: false,
            secret_material_present: false,
            credential_material_present: false,
            unbounded_local_path_present: false,
        }
    }

    fn completed_methods() -> Vec<CodexAppServerLiveExecutorMethod> {
        vec![
            CodexAppServerLiveExecutorMethod::Initialize,
            CodexAppServerLiveExecutorMethod::InitializedNotification,
            CodexAppServerLiveExecutorMethod::ThreadStart,
            CodexAppServerLiveExecutorMethod::TurnStart,
            CodexAppServerLiveExecutorMethod::TurnCompleted,
            CodexAppServerLiveExecutorMethod::Cleanup,
        ]
    }
}
