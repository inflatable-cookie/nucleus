//! Split from the local_codex_chat persistence god file; behavior unchanged.

use super::*;

use nucleus_local_store::SqliteBackend;

use super::super::LocalCodexChatHarnessMode;
use crate::local_codex_chat::{LocalCodexChatPlanDecisionKind, LocalCodexChatPlanDecisionRequest};

#[test]
fn restart_abandons_pending_questions_and_fails_the_interrupted_turn() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let path = temp_dir.path().join("db.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(path.clone()));
    let session = StoredChatSession {
        conversation_id: "conversation:restart".to_owned(),
        project_id: "project:restart".to_owned(),
        resource_id: None,
        session_id: "session:restart".to_owned(),
        provider_thread_id: "thread:restart".to_owned(),
        model: "gpt-5.4-mini".to_owned(),
        reasoning_effort: Some("low".to_owned()),
        harness_mode: LocalCodexChatHarnessMode::Normal,
        adapter_id: "codex-app-server".to_owned(),
        provider_instance_id: "codex:local-default".to_owned(),
        provider_instance_revision: "1".to_owned(),
        protocol_facade_id: "codex-app-server-v2".to_owned(),
        provider_id: None,
        turn_count: 1,
        task_toolset_version: 5,
    };
    persist_turn_start(&state, session, "turn:restart", "Ask a question", None).expect("turn");
    persist_question_pending(
        &state,
        &StoredChatQuestionExchange {
            conversation_id: "conversation:restart".to_owned(),
            turn_id: "turn:restart".to_owned(),
            callback_id: "callback:restart".to_owned(),
            runtime_operation_id: "turn:runtime:restart".to_owned(),
            event_sequence: 3,
            provider_request_ref: None,
            deadline_ticks: None,
            auto_resolution_ms: None,
            status: "pending".to_owned(),
            questions: vec![StoredChatQuestion {
                question_id: "question:restart".to_owned(),
                header: "Continue".to_owned(),
                prompt: "Continue?".to_owned(),
                kind: "single_choice".to_owned(),
                allow_other: false,
                options: vec![StoredChatQuestionOption {
                    value: "yes".to_owned(),
                    label: "Yes".to_owned(),
                    description: None,
                }],
            }],
            answers: Vec::new(),
        },
    )
    .expect("question");
    drop(state);

    let reopened = ServerStateService::new(SqliteBackend::new(path));
    recover_interrupted_chat_state(&reopened).expect("recover");
    let history =
        read_history(&reopened, "project:restart", "conversation:restart").expect("history");
    assert_eq!(history.turns[0].status, "failed");
    assert_eq!(history.questions[0].status, "abandoned");
}

fn pending_plan(turn_id: &str) -> StoredChatPlanDecision {
    StoredChatPlanDecision {
        conversation_id: "conversation:plan".to_owned(),
        project_id: "project:plan".to_owned(),
        turn_id: turn_id.to_owned(),
        turn_ordinal: 1,
        runtime_operation_id: "turn:runtime:plan".to_owned(),
        activity_id: "activity:plan".to_owned(),
        plan: "# Plan\n\n1. Do the work".to_owned(),
        status: "pending".to_owned(),
        decided_at_unix_ms: None,
        accept_turn_id: None,
    }
}

fn plan_decision_request(
    decision: LocalCodexChatPlanDecisionKind,
) -> LocalCodexChatPlanDecisionRequest {
    LocalCodexChatPlanDecisionRequest {
        project_id: "project:plan".to_owned(),
        conversation_id: "conversation:plan".to_owned(),
        turn_id: "turn:plan".to_owned(),
        runtime_operation_id: "turn:runtime:plan".to_owned(),
        activity_id: "activity:plan".to_owned(),
        decision,
    }
}

#[test]
fn pending_plan_decision_round_trips_through_history() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    persist_plan_pending(&state, &pending_plan("turn:plan")).expect("persist pending plan");

    let history = read_history(&state, "project:plan", "conversation:plan").expect("history");
    assert_eq!(history.plan_decisions.len(), 1);
    let decision = &history.plan_decisions[0];
    assert_eq!(decision.status, "pending");
    assert_eq!(decision.plan, "# Plan\n\n1. Do the work");
    assert_eq!(decision.runtime_operation_id, "turn:runtime:plan");
    assert_eq!(decision.activity_id, "activity:plan");
    assert_eq!(decision.decided_at_unix_ms, None);

    let duplicate = persist_plan_pending(&state, &pending_plan("turn:plan"));
    assert!(duplicate.is_err(), "one pending plan per proposed plan");
}

#[test]
fn plan_decision_settles_exactly_once_with_exact_correlation() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    persist_plan_pending(&state, &pending_plan("turn:plan")).expect("persist pending plan");

    let mut mismatched = plan_decision_request(LocalCodexChatPlanDecisionKind::Dismissed);
    mismatched.runtime_operation_id = "turn:runtime:other".to_owned();
    assert!(settle_plan_decision(&state, &mismatched, Some(7), None).is_err());

    let settled = settle_plan_decision(
        &state,
        &plan_decision_request(LocalCodexChatPlanDecisionKind::Accepted),
        Some(9),
        Some("turn:chat:conversation:plan:2".to_owned()),
    )
    .expect("settle");
    assert_eq!(settled.status, "accepted");
    assert_eq!(settled.decided_at_unix_ms, Some(9));
    assert_eq!(
        settled.accept_turn_id.as_deref(),
        Some("turn:chat:conversation:plan:2")
    );

    let repeat = settle_plan_decision(
        &state,
        &plan_decision_request(LocalCodexChatPlanDecisionKind::Dismissed),
        Some(11),
        None,
    );
    assert!(repeat.is_err(), "post-settlement decisions fail");

    let history = read_history(&state, "project:plan", "conversation:plan").expect("history");
    assert_eq!(history.plan_decisions[0].status, "accepted");
}

#[test]
fn ordinary_message_settles_pending_plan_as_revised() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    persist_plan_pending(&state, &pending_plan("turn:plan")).expect("persist pending plan");

    let settled =
        settle_pending_plan_for_conversation(&state, "conversation:plan", "revised", Some(13))
            .expect("settle")
            .expect("pending plan");
    assert_eq!(settled.status, "revised");
    assert_eq!(settled.decided_at_unix_ms, Some(13));
    assert!(
        settle_pending_plan_for_conversation(&state, "conversation:plan", "revised", Some(15))
            .expect("settle")
            .is_none(),
        "no second pending plan remains"
    );
}

#[test]
fn restart_keeps_a_pending_plan_queryable() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let path = temp_dir.path().join("db.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(path.clone()));
    persist_plan_pending(&state, &pending_plan("turn:plan")).expect("persist pending plan");
    drop(state);

    let reopened = ServerStateService::new(SqliteBackend::new(path));
    recover_interrupted_chat_state(&reopened).expect("recover");
    let history =
        read_history(&reopened, "project:plan", "conversation:plan").expect("history");
    assert_eq!(history.plan_decisions.len(), 1);
    assert_eq!(history.plan_decisions[0].status, "pending");
}
