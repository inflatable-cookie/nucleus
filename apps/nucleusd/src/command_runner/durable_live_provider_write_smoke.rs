use crate::cli::CliDurableLiveProviderWriteSmoke;

use super::codex_smoke::{self, live};

use nucleus_local_store::SqliteBackend;
use nucleus_server::{
    durable_codex_live_provider_write_invocation_gate, durable_codex_live_smoke_dispatch_run,
    durable_live_provider_write_replay, persist_durable_live_provider_write_evidence,
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorOutcomeStatus,
    DurableCodexLiveProviderWriteInvocationGateInput,
    DurableCodexLiveProviderWriteInvocationGateRecord,
    DurableCodexLiveProviderWriteInvocationGateStatus, DurableCodexLiveSmokeDispatchRunRecord,
    LocalControlRequestHandler,
};

mod dispatch;
mod evidence;
mod labels;
#[cfg(test)]
mod test_support;

#[cfg(test)]
use super::codex_smoke::live::LiveCodexSmokeOutcome;
use dispatch::dispatch_input;
use evidence::{
    durable_live_provider_write_evidence_input_from_outcome,
    durable_live_provider_write_terminal_evidence_input,
};
use labels::{boundary_status_label, gate_blocker_label, gate_status_label};
#[cfg(test)]
use nucleus_server::DurableCodexLiveSmokeBoundaryStatus;
#[cfg(test)]
use test_support::test_gate_and_run;

pub(crate) fn print_durable_live_provider_write_smoke(
    handler: &mut LocalControlRequestHandler<SqliteBackend>,
    command: CliDurableLiveProviderWriteSmoke,
) -> Result<(), String> {
    let run = durable_codex_live_smoke_dispatch_run(dispatch_input(&command));
    let gate = durable_codex_live_provider_write_invocation_gate(
        DurableCodexLiveProviderWriteInvocationGateInput {
            boundary: run.boundary.clone(),
            invocation_evidence_refs: vec![
                "evidence:nucleusd-durable-live-provider-write-gate".to_owned()
            ],
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

    println!("durable_live_provider_write_smoke=invocation_gate");
    println!("confirm_real_write={}", command.confirm_real_write);
    println!("confirm_real_effect={}", command.confirm_real_effect);
    println!("execute_provider_write={}", command.execute_provider_write);
    println!(
        "boundary_status={}",
        boundary_status_label(&run.boundary.status)
    );
    println!("gate_status={}", gate_status_label(&gate.status));
    println!("blockers={}", gate.blockers.len());
    for blocker in &gate.blockers {
        println!("blocker={}", gate_blocker_label(blocker));
    }
    println!("gate_id={}", gate.gate_id.0);
    println!("boundary_id={}", gate.boundary_id);
    println!("write_attempt_id={}", gate.write_attempt_id);
    println!("idempotency_key={}", gate.idempotency_key);
    println!("provider_instance_id={}", gate.provider_instance_id);
    println!("runtime_session_ref={}", gate.runtime_session_ref);
    println!("evidence_refs={}", gate.evidence_refs.len());
    println!(
        "executor_invocation_ready={}",
        gate.executor_invocation_ready
    );
    println!("provider_write_ready={}", gate.provider_write_ready);
    println!("provider_write_executed={}", gate.provider_write_executed);
    println!("executor_invoked={}", gate.executor_invoked);
    println!(
        "raw_provider_material_retained={}",
        gate.raw_provider_material_retained
    );
    println!("raw_stream_retained={}", gate.raw_stream_retained);
    println!("task_mutation_permitted={}", gate.task_mutation_permitted);
    println!(
        "review_acceptance_permitted={}",
        gate.review_acceptance_permitted
    );

    if command.execute_provider_write {
        execute_durable_live_provider_write_smoke(handler, run, gate)?;
    } else {
        println!("execute_provider_write=false");
        println!("live_smoke_status=not_requested");
    }

    Ok(())
}

fn execute_durable_live_provider_write_smoke(
    handler: &mut LocalControlRequestHandler<SqliteBackend>,
    run: DurableCodexLiveSmokeDispatchRunRecord,
    gate: DurableCodexLiveProviderWriteInvocationGateRecord,
) -> Result<(), String> {
    println!("execute_provider_write=true");
    if gate.status != DurableCodexLiveProviderWriteInvocationGateStatus::ReadyForExplicitInvocation
        || !gate.provider_write_ready
    {
        println!("live_smoke_status=blocked");
        println!("provider_write_executed=false");
        return Ok(());
    }

    let boundary = codex_smoke::build_codex_turn_start_real_write_smoke_boundary(true);
    let (live_status, provider_write_executed, evidence_input) =
        match live::run_live_codex_turn_start_smoke(&boundary) {
            Ok(outcome) => {
                let live_status = outcome.status_label();
                let provider_write_executed = outcome.provider_write_executed;
                (
                    live_status,
                    provider_write_executed,
                    durable_live_provider_write_evidence_input_from_outcome(run, gate, outcome),
                )
            }
            Err(_) => (
                "failed",
                false,
                durable_live_provider_write_terminal_evidence_input(
                    run,
                    gate,
                    CodexAppServerLiveExecutorOutcomeStatus::Failed(
                        "live Codex smoke failed".to_owned(),
                    ),
                    CodexAppServerLiveExecutorCleanupStatus::Unknown,
                ),
            ),
        };
    let evidence = persist_durable_live_provider_write_evidence(handler.state(), evidence_input)
        .map_err(|error| {
            format!("failed to persist durable live provider-write evidence: {error:?}")
        })?;
    let replay = durable_live_provider_write_replay(&evidence);

    println!("live_smoke_status={live_status}");
    println!("provider_write_executed={provider_write_executed}");
    println!("evidence_id={}", evidence.evidence_id);
    println!(
        "live_executor_outcome_id={}",
        evidence
            .live_executor_outcome_id
            .as_deref()
            .unwrap_or("none")
    );
    println!(
        "runtime_receipt_id={}",
        evidence.runtime_receipt_id.as_deref().unwrap_or("none")
    );
    println!("replay_status={:?}", replay.status);
    println!("task_completion_promoted=false");
    println!("review_acceptance_promoted=false");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_server::{read_durable_codex_live_smoke_evidence_records, ServerStateService};

    #[test]
    fn durable_live_provider_write_smoke_default_is_blocked_dry_run() {
        let run = durable_codex_live_smoke_dispatch_run(dispatch_input(
            &CliDurableLiveProviderWriteSmoke::default(),
        ));

        assert_eq!(
            run.boundary.status,
            DurableCodexLiveSmokeBoundaryStatus::DryRunEligible
        );
        assert!(!run.boundary.provider_write_executed);
    }

    #[test]
    fn durable_live_provider_write_smoke_confirm_and_effect_reaches_gate_readiness() {
        let run = durable_codex_live_smoke_dispatch_run(dispatch_input(
            &CliDurableLiveProviderWriteSmoke {
                confirm_real_write: true,
                confirm_real_effect: true,
                execute_provider_write: false,
            },
        ));
        let gate = durable_codex_live_provider_write_invocation_gate(
            DurableCodexLiveProviderWriteInvocationGateInput {
                boundary: run.boundary,
                invocation_evidence_refs: vec!["evidence:test".to_owned()],
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

        assert_eq!(
            gate.status,
            DurableCodexLiveProviderWriteInvocationGateStatus::ReadyForExplicitInvocation
        );
        assert!(gate.provider_write_ready);
        assert!(!gate.provider_write_executed);
    }

    #[test]
    fn durable_live_provider_write_runner_bridge_maps_executed_outcome_to_evidence_input() {
        let (run, gate) = test_gate_and_run("runner-bridge");

        let input = durable_live_provider_write_evidence_input_from_outcome(
            run,
            gate,
            LiveCodexSmokeOutcome::executed_for_test("runner-bridge"),
        );

        assert_eq!(
            input.status,
            CodexAppServerLiveExecutorOutcomeStatus::Completed
        );
        assert_eq!(input.thread_id.as_deref(), Some("thread:runner-bridge"));
        assert_eq!(input.turn_id.as_deref(), Some("turn:runner-bridge"));
        assert_eq!(input.method_sequence, live::completed_method_sequence());
        assert_eq!(input.notification_count, 3);
        assert_eq!(input.server_request_count, 1);
        assert!(!input.raw_provider_material_present);
        assert!(!input.raw_stream_present);
    }

    #[test]
    fn durable_live_provider_write_runner_bridge_maps_blocked_outcome_without_io() {
        let (run, gate) = test_gate_and_run("runner-bridge-blocked");

        let input = durable_live_provider_write_evidence_input_from_outcome(
            run,
            gate,
            LiveCodexSmokeOutcome::blocked_for_test(),
        );

        assert!(matches!(
            input.status,
            CodexAppServerLiveExecutorOutcomeStatus::Blocked(_)
        ));
        assert!(input.method_sequence.is_empty());
        assert!(input.thread_id.is_none());
        assert!(input.turn_id.is_none());
        assert_eq!(
            input.cleanup_status,
            CodexAppServerLiveExecutorCleanupStatus::NotRequired
        );
    }

    #[test]
    fn durable_live_provider_write_runner_bridge_preserves_refs_and_cleanup_uncertainty() {
        let (run, gate) = test_gate_and_run("runner-bridge-cleanup");

        let input = durable_live_provider_write_evidence_input_from_outcome(
            run,
            gate,
            LiveCodexSmokeOutcome::cleanup_required_for_test("runner-bridge-cleanup"),
        );

        assert!(matches!(
            input.status,
            CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(_)
        ));
        assert!(matches!(
            input.cleanup_status,
            CodexAppServerLiveExecutorCleanupStatus::Failed(_)
        ));
        assert_eq!(
            input.thread_id.as_deref(),
            Some("thread:runner-bridge-cleanup")
        );
        assert_eq!(input.turn_id.as_deref(), Some("turn:runner-bridge-cleanup"));
        assert!(input
            .method_sequence
            .contains(&nucleus_server::CodexAppServerLiveExecutorMethod::TurnCompleted));
    }

    #[test]
    fn durable_live_provider_write_result_persistence_survives_reopen_and_reconciles() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));
        let (run, gate) = test_gate_and_run("result-persistence");
        let input = durable_live_provider_write_evidence_input_from_outcome(
            run,
            gate,
            LiveCodexSmokeOutcome::executed_for_test("result-persistence"),
        );

        let record =
            persist_durable_live_provider_write_evidence(&state, input).expect("persist result");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records =
            read_durable_codex_live_smoke_evidence_records(&reopened).expect("read evidence");
        let replay = durable_live_provider_write_replay(&records[0]);

        assert_eq!(records, vec![record]);
        assert!(records[0].provider_write_executed);
        assert!(records[0].runtime_receipt_id.is_some());
        assert!(records[0].live_executor_outcome_id.is_some());
        assert_eq!(
            records[0].thread_id.as_deref(),
            Some("thread:result-persistence")
        );
        assert_eq!(
            records[0].turn_id.as_deref(),
            Some("turn:result-persistence")
        );
        assert!(replay.replay_reconciled);
        assert!(!replay.task_completion_promoted);
        assert!(!replay.review_acceptance_promoted);
    }

    #[test]
    fn durable_live_provider_write_terminal_outcomes_persist_sanitized_status() {
        for (label, status, cleanup_status) in [
            (
                "terminal-failed",
                CodexAppServerLiveExecutorOutcomeStatus::Failed(
                    "live Codex smoke failed".to_owned(),
                ),
                CodexAppServerLiveExecutorCleanupStatus::Unknown,
            ),
            (
                "terminal-timed-out",
                CodexAppServerLiveExecutorOutcomeStatus::TimedOut,
                CodexAppServerLiveExecutorCleanupStatus::Unknown,
            ),
            (
                "terminal-blocked",
                CodexAppServerLiveExecutorOutcomeStatus::Blocked("gate blocked".to_owned()),
                CodexAppServerLiveExecutorCleanupStatus::NotRequired,
            ),
            (
                "terminal-cleanup",
                CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(
                    "cleanup required".to_owned(),
                ),
                CodexAppServerLiveExecutorCleanupStatus::Failed("cleanup failed".to_owned()),
            ),
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let state =
                ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
            let (run, gate) = test_gate_and_run(label);
            let input = durable_live_provider_write_terminal_evidence_input(
                run,
                gate,
                status,
                cleanup_status,
            );

            let record = persist_durable_live_provider_write_evidence(&state, input)
                .expect("persist terminal outcome");

            assert!(record.live_executor_outcome_id.is_some());
            assert!(record.runtime_receipt_id.is_some());
            assert!(!record.raw_provider_material_retained);
            assert!(!record.raw_stream_retained);
            assert!(!record.task_mutation_permitted);
        }
    }

    #[test]
    fn durable_live_provider_write_terminal_outcomes_duplicate_write_attempt_is_noop() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let (run, gate) = test_gate_and_run("terminal-duplicate");
        let mut input = durable_live_provider_write_terminal_evidence_input(
            run,
            gate,
            CodexAppServerLiveExecutorOutcomeStatus::TimedOut,
            CodexAppServerLiveExecutorCleanupStatus::Unknown,
        );
        input
            .existing_write_attempt_ids
            .push(input.gate.write_attempt_id.clone());

        let record =
            persist_durable_live_provider_write_evidence(&state, input).expect("duplicate noop");

        assert_eq!(
            record.status,
            nucleus_server::DurableCodexLiveSmokeEvidenceStatus::DuplicateWriteAttemptNoop
        );
        assert!(record.duplicate_write_attempt_detected);
        assert!(!record.provider_write_executed);
    }
}
