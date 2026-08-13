//! Run-record lookup from chat operation truth.
//!
//! A dispatched run's worker conversation has the deterministic id
//! `conversation:run:<run_id>`; the chat turn hooks need the run record to
//! decide whether an observed turn start/failure should drive a run
//! transition. This module scans the orchestration runs domain for the
//! conversation binding — small phase-1 scale, no projection needed.

use nucleus_engine::{
    decode_run_storage_record, EngineRunLifecycleState, EngineRunStorageRecord,
};
use nucleus_local_store::LocalStoreBackend;

use crate::ServerStateService;

/// The deterministic worker conversation id for one run dispatch.
pub(crate) fn run_conversation_id(run_id: &str) -> String {
    format!("conversation:run:{run_id}")
}

/// Find the run record bound to a conversation id, if any.
pub(crate) fn find_run_by_conversation<B>(
    state: &ServerStateService<B>,
    conversation_id: &str,
) -> Result<Option<EngineRunStorageRecord>, String>
where
    B: LocalStoreBackend,
{
    let records = state
        .orchestration_runs()
        .list()
        .map_err(|error| format!("run record lookup failed: {error:?}"))?;
    for record in records {
        let run = decode_run_storage_record(&record.payload.bytes)
            .map_err(|error| format!("run record decode failed: {error:?}"))?;
        if run.conversation_id.as_deref() == Some(conversation_id) {
            return Ok(Some(run));
        }
    }
    Ok(None)
}

/// Whether a run failure is still meaningful: only pre-delivery states can
/// transition to `failed` (delivered/accepted/rejected are terminal).
pub(crate) fn failure_can_transition(state: EngineRunLifecycleState) -> bool {
    matches!(
        state,
        EngineRunLifecycleState::Proposed
            | EngineRunLifecycleState::Dispatched
            | EngineRunLifecycleState::Running
    )
}

/// Turn-start hook: when the first observed activity of a dispatched run's
/// conversation arrives, the operation has actually started — transition
/// `dispatched -> running` and bind the provider-minted operation identity.
/// Returns whether a transition fired.
pub(crate) fn mark_run_running_on_first_activity<B>(
    state: &ServerStateService<B>,
    conversation_id: &str,
    turn_id: &str,
    operation_id: &str,
) -> Result<bool, String>
where
    B: LocalStoreBackend,
{
    let Some(run) = find_run_by_conversation(state, conversation_id)? else {
        return Ok(false);
    };
    if run.state != EngineRunLifecycleState::Dispatched {
        return Ok(false);
    }
    let command_id = format!("command:run:hook:{conversation_id}:{turn_id}:running");
    crate::request_handler::run_commands::run_transition_from_operation_truth(
        state,
        &command_id,
        &run.run_id,
        Some(operation_id.to_owned()),
        EngineRunLifecycleState::Running,
        None,
    )
    .map_err(|error| format!("run mark-running from operation truth failed: {error:?}"))?;
    Ok(true)
}

/// Turn-failure hook: a failed turn of a pre-delivery run's conversation
/// fails the run with the turn failure as the reason. Best effort — the turn
/// failure is the primary outcome and must not be masked by a secondary
/// transition error.
pub(crate) fn fail_run_on_turn_failure<B>(
    state: &ServerStateService<B>,
    conversation_id: &str,
    turn_id: &str,
    reason: &str,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let Some(run) = find_run_by_conversation(state, conversation_id)? else {
        return Ok(());
    };
    if !failure_can_transition(run.state) {
        return Ok(());
    }
    let command_id = format!("command:run:hook:{conversation_id}:{turn_id}:fail");
    let _ = crate::request_handler::run_commands::run_transition_from_operation_truth(
        state,
        &command_id,
        &run.run_id,
        None,
        EngineRunLifecycleState::Failed,
        Some(reason.to_owned()),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use nucleus_engine::{
        EngineRunBudgetEnvelope, EngineRunId, EngineRunLifecycleState, EngineRunObjective,
        EngineRunStorageRecord, EngineRunTransitionRecord,
    };
    use nucleus_local_store::SqliteBackend;

    use super::*;

    fn run_record(conversation_id: Option<String>) -> EngineRunStorageRecord {
        EngineRunStorageRecord {
            run_id: EngineRunId("run:1".to_owned()),
            project_id: "project:1".to_owned(),
            objective: EngineRunObjective {
                scope: "scope".to_owned(),
                acceptance: vec!["accept".to_owned()],
                stop_conditions: vec!["stop".to_owned()],
            },
            worktree_ref: Some("worktree:1".to_owned()),
            provider_instance: "provider:codex".to_owned(),
            provider_model: "codex-mini".to_owned(),
            orchestrator_designation: None,
            operation_id: None,
            conversation_id,
            state: EngineRunLifecycleState::Dispatched,
            budget: EngineRunBudgetEnvelope::default(),
            closeout: None,
            transitions: vec![EngineRunTransitionRecord {
                command_id: "command:run:propose:1".to_owned(),
                from: None,
                to: EngineRunLifecycleState::Proposed,
                at: 1,
            }],
            created_at: 1,
            updated_at: 1,
        }
    }

    fn persist(state: &ServerStateService<SqliteBackend>, run: &EngineRunStorageRecord) {
        let payload = nucleus_engine::encode_run_storage_payload(run).expect("encode");
        state
            .orchestration_runs()
            .put(
                nucleus_local_store::LocalStoreRecord {
                    id: nucleus_core::PersistenceRecordId(run.run_id.0.clone()),
                    domain: nucleus_core::PersistenceDomain::OrchestrationRuns,
                    kind: nucleus_core::PersistenceRecordKind::OrchestrationRun,
                    revision_id: nucleus_core::RevisionId("rev:run:fixture".to_owned()),
                    payload: nucleus_local_store::LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: payload,
                    },
                },
                nucleus_local_store::RevisionExpectation::MustNotExist,
            )
            .expect("persist");
    }

    #[test]
    fn finds_run_by_deterministic_conversation_id() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("state.sqlite")));
        persist(&state, &run_record(Some(run_conversation_id("run:1"))));

        let found = find_run_by_conversation(&state, &run_conversation_id("run:1"))
            .expect("lookup")
            .expect("run found");
        assert_eq!(found.run_id.0, "run:1");
        assert_eq!(found.state, EngineRunLifecycleState::Dispatched);

        let missing = find_run_by_conversation(&state, "conversation:other").expect("lookup");
        assert!(missing.is_none());
    }

    #[test]
    fn unbound_conversations_are_not_runs() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("state.sqlite")));
        persist(&state, &run_record(None));

        let found = find_run_by_conversation(&state, "conversation:run:run:1").expect("lookup");
        assert!(found.is_none());
    }

    #[test]
    fn first_activity_transitions_dispatched_run_to_running_with_operation_id() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("state.sqlite")));
        persist(&state, &run_record(Some(run_conversation_id("run:1"))));

        let fired = mark_run_running_on_first_activity(
            &state,
            &run_conversation_id("run:1"),
            "turn:1",
            "run:runtime:run:1",
        )
        .expect("mark running");
        assert!(fired);

        let run = find_run_by_conversation(&state, &run_conversation_id("run:1"))
            .expect("lookup")
            .expect("run");
        assert_eq!(run.state, EngineRunLifecycleState::Running);
        assert_eq!(run.operation_id.as_deref(), Some("run:runtime:run:1"));
        assert_eq!(run.transitions.len(), 2);

        // A second hook call (later activity) does not re-fire.
        let fired = mark_run_running_on_first_activity(
            &state,
            &run_conversation_id("run:1"),
            "turn:2",
            "run:runtime:run:1:other",
        )
        .expect("no re-fire");
        assert!(!fired);
        let run = find_run_by_conversation(&state, &run_conversation_id("run:1"))
            .expect("lookup")
            .expect("run");
        assert_eq!(run.operation_id.as_deref(), Some("run:runtime:run:1"));

        // The spine event and the transition receipt exist (command path).
        let events = state
            .event_journal()
            .list_in_insertion_order()
            .expect("events");
        assert!(events.iter().any(|event| {
            let event =
                nucleus_orchestration::decode_orchestration_event_store_record(
                    &event.payload.bytes,
                )
                .expect("decode event");
            let event = event.into_payload();
            event.family == nucleus_orchestration::OrchestrationCommandFamily::Run
                && event.target_ref.as_deref() == Some("run:1")
        }));
        let receipts = crate::runtime_receipt_state::read_runtime_receipts(&state).expect("receipts");
        assert!(receipts.iter().any(|receipt| receipt
            .command_ref
            .as_ref()
            .is_some_and(|reference| reference
                == &nucleus_engine::EngineRuntimeReceiptRef::CommandId(
                    "command:run:hook:conversation:run:run:1:turn:1:running".to_owned()
                ))));
    }

    #[test]
    fn turn_failure_fails_a_running_run_with_reason() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("state.sqlite")));
        let mut run = run_record(Some(run_conversation_id("run:1")));
        run.state = EngineRunLifecycleState::Running;
        run.transitions.push(EngineRunTransitionRecord {
            command_id: "command:run:running:1".to_owned(),
            from: Some(EngineRunLifecycleState::Dispatched),
            to: EngineRunLifecycleState::Running,
            at: 2,
        });
        persist(&state, &run);

        fail_run_on_turn_failure(&state, &run_conversation_id("run:1"), "turn:9", "provider boom")
            .expect("fail run");

        let run = find_run_by_conversation(&state, &run_conversation_id("run:1"))
            .expect("lookup")
            .expect("run");
        assert_eq!(run.state, EngineRunLifecycleState::Failed);
        assert_eq!(run.transitions.len(), 3);
        assert_eq!(run.transitions[2].to, EngineRunLifecycleState::Failed);
        assert_eq!(run.transitions[2].command_id, "command:run:hook:conversation:run:run:1:turn:9:fail");

        // A later failure of a terminal run is ignored (no transition).
        fail_run_on_turn_failure(&state, &run_conversation_id("run:1"), "turn:10", "again")
            .expect("ignored");
        let run = find_run_by_conversation(&state, &run_conversation_id("run:1"))
            .expect("lookup")
            .expect("run");
        assert_eq!(run.state, EngineRunLifecycleState::Failed);
        assert_eq!(run.transitions.len(), 3);
    }
}
