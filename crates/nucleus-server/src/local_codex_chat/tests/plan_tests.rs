//! Plan draft accumulation and plan decision settlement tests, split from
//! the tests god file; behavior unchanged.

use super::*;

use super::super::persistence::{persist_plan_pending, read_history};
use super::super::turn::PlanDraftAccumulator;

#[test]
fn plan_draft_accumulates_deltas_and_keeps_the_latest_plan_identity() {
    let activity = |operation: &str,
                    activity_id: &str,
                    sequence: u64,
                    change: Option<&str>,
                    content: Option<&str>| {
        StoredChatActivity {
            conversation_id: "conversation:plan".to_owned(),
            turn_id: "turn:plan".to_owned(),
            turn_ordinal: 1,
            runtime_operation_id: operation.to_owned(),
            activity_id: activity_id.to_owned(),
            sequence,
            kind: "plan".to_owned(),
            kind_namespace: None,
            lifecycle: "updated".to_owned(),
            status: "in_progress".to_owned(),
            assistant_phase: None,
            disclosure: "provider_display_content".to_owned(),
            label: None,
            correlation_kind: None,
            correlation_id: None,
            content_change: change.map(str::to_owned),
            content_stream: Some("plan_text".to_owned()),
            content: content.map(str::to_owned),
            actor_kind: "primary".to_owned(),
            actor_id: None,
            task_list: None,
            subagents: Vec::new(),
        }
    };
    let mut draft = PlanDraftAccumulator::default();
    draft.observe(&activity(
        "run:one",
        "plan:1",
        1,
        Some("delta"),
        Some("# Plan"),
    ));
    draft.observe(&activity(
        "run:one",
        "plan:1",
        2,
        Some("delta"),
        Some("\n\n1. Step"),
    ));
    draft.observe(&activity(
        "run:one",
        "plan:1",
        3,
        Some("replacement_snapshot"),
        Some("# Plan\n\n1. Replaced"),
    ));
    let mut non_plan = activity("run:one", "tool:1", 4, Some("delta"), Some("noise"));
    non_plan.kind = "command_execution".to_owned();
    draft.observe(&non_plan);
    draft.observe(&activity(
        "run:two",
        "plan:2",
        5,
        Some("delta"),
        Some("# Later"),
    ));

    assert_eq!(
        draft.finish(),
        Some((
            "run:two".to_owned(),
            "plan:2".to_owned(),
            "# Later".to_owned()
        ))
    );
}

#[test]
fn plan_decision_settles_without_provider_work_and_rejects_repeats() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    persist_legacy_session(&state, "plan-decision", 5);
    let conversation_id = "project:nucleus-local:panel:plan-decision";
    persist_plan_pending(
        &state,
        &StoredChatPlanDecision {
            conversation_id: conversation_id.to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            turn_id: "turn:plan-decision".to_owned(),
            turn_ordinal: 1,
            runtime_operation_id: "turn:runtime:plan-decision".to_owned(),
            activity_id: "activity:plan".to_owned(),
            plan: "# Plan\n\n1. Do the work".to_owned(),
            status: "pending".to_owned(),
            decided_at_unix_ms: None,
            accept_turn_id: None,
        },
    )
    .expect("pending plan");

    let mut service = LocalCodexChatService::default();
    let request = LocalCodexChatPlanDecisionRequest {
        project_id: "project:nucleus-local".to_owned(),
        conversation_id: conversation_id.to_owned(),
        turn_id: "turn:plan-decision".to_owned(),
        runtime_operation_id: "turn:runtime:plan-decision".to_owned(),
        activity_id: "activity:plan".to_owned(),
        decision: LocalCodexChatPlanDecisionKind::Dismissed,
    };

    let mut stale = request.clone();
    stale.activity_id = "activity:other".to_owned();
    assert_eq!(
        service
            .decide_plan(&state, stale)
            .expect_err("stale correlation"),
        "Agent Chat plan correlation does not match"
    );

    let reply = service
        .decide_plan(&state, request.clone())
        .expect("dismiss");
    assert_eq!(reply.decision.status, "dismissed");
    assert!(reply.decision.decided_at_unix_ms.is_some());
    assert_eq!(reply.follow_up, None);

    assert_eq!(
        service.decide_plan(&state, request).expect_err("repeat"),
        "Agent Chat plan is stale or already decided"
    );

    let history = read_history(&state, "project:nucleus-local", conversation_id).expect("history");
    assert_eq!(history.plan_decisions.len(), 1);
    assert_eq!(history.plan_decisions[0].status, "dismissed");
    assert_eq!(history.plan_decisions[0].plan, "# Plan\n\n1. Do the work");
}

#[test]
fn plan_decision_requires_a_known_conversation() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut service = LocalCodexChatService::default();
    let request = LocalCodexChatPlanDecisionRequest {
        project_id: "project:nucleus-local".to_owned(),
        conversation_id: "project:nucleus-local:panel:missing".to_owned(),
        turn_id: "turn:missing".to_owned(),
        runtime_operation_id: "turn:runtime:missing".to_owned(),
        activity_id: "activity:plan".to_owned(),
        decision: LocalCodexChatPlanDecisionKind::Dismissed,
    };
    assert!(service.decide_plan(&state, request).is_err());
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn live_plan_decision_dismiss_settles_without_follow_up() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let path = temp_dir.path().join("nucleus.sqlite");
    let (state, project_id) = transient_chat_project(&path, "plan-dismiss-live");
    let conversation_id = format!("{project_id}:panel:plan-dismiss-live");
    let mut service = LocalCodexChatService::default();

    let reply = plan_send(
        &mut service,
        &state,
        &project_id,
        &conversation_id,
        "Plan how to make a cup of tea, then present the final plan.",
    );
    let pending =
        pending_plan_or_retry(&mut service, &state, &project_id, &conversation_id, &reply);
    assert_eq!(pending.status, "pending");
    assert!(!pending.plan.trim().is_empty());
    assert!(pending.decided_at_unix_ms.is_none());
    assert!(pending.accept_turn_id.is_none());

    let decision_request = LocalCodexChatPlanDecisionRequest {
        project_id: project_id.clone(),
        conversation_id: conversation_id.clone(),
        turn_id: pending.turn_id.clone(),
        runtime_operation_id: pending.runtime_operation_id.clone(),
        activity_id: pending.activity_id.clone(),
        decision: LocalCodexChatPlanDecisionKind::Dismissed,
    };

    let settled = service
        .decide_plan(&state, decision_request.clone())
        .expect("dismiss pending plan");
    assert_eq!(settled.decision.status, "dismissed");
    assert!(settled.decision.decided_at_unix_ms.is_some());
    assert_eq!(settled.follow_up, None);

    // Exactly-once settle: a second decision on the same correlation fails.
    assert_eq!(
        service
            .decide_plan(&state, decision_request)
            .expect_err("repeat settle"),
        "Agent Chat plan is stale or already decided"
    );

    // Dismiss leaves no follow-up turn: the plan turn is the only turn.
    let history = read_history(&state, &project_id, &conversation_id).expect("history");
    assert_eq!(history.turns.len(), 1);
    assert_eq!(history.turns[0].status, "completed");
    assert_eq!(history.plan_decisions.len(), 1);
    assert_eq!(history.plan_decisions[0].status, "dismissed");
    assert_eq!(history.plan_decisions[0].plan, pending.plan);

    // A fresh state service over the same sqlite file still shows the settled
    // decision.
    let reopened = ServerStateService::new(SqliteBackend::new(path));
    let history = read_history(&reopened, &project_id, &conversation_id).expect("reopened history");
    assert_eq!(history.plan_decisions.len(), 1);
    assert_eq!(history.plan_decisions[0].status, "dismissed");
    assert_eq!(history.plan_decisions[0].plan, pending.plan);
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn live_plan_decision_accept_drives_normal_mode_follow_up() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let path = temp_dir.path().join("nucleus.sqlite");
    let (state, project_id) = transient_chat_project(&path, "plan-accept-live");
    let conversation_id = format!("{project_id}:panel:plan-accept-live");
    let mut service = LocalCodexChatService::default();

    let reply = plan_send(
        &mut service,
        &state,
        &project_id,
        &conversation_id,
        "Plan how to make a cup of tea, then present the final plan.",
    );
    let pending =
        pending_plan_or_retry(&mut service, &state, &project_id, &conversation_id, &reply);
    assert_eq!(pending.status, "pending");

    let settled = service
        .decide_plan(
            &state,
            LocalCodexChatPlanDecisionRequest {
                project_id: project_id.clone(),
                conversation_id: conversation_id.clone(),
                turn_id: pending.turn_id.clone(),
                runtime_operation_id: pending.runtime_operation_id.clone(),
                activity_id: pending.activity_id.clone(),
                decision: LocalCodexChatPlanDecisionKind::Accepted,
            },
        )
        .expect("accept pending plan");
    assert_eq!(settled.decision.status, "accepted");
    assert_eq!(settled.decision.plan, pending.plan);
    let accept_turn_id = settled
        .decision
        .accept_turn_id
        .as_deref()
        .expect("accept records accept_turn_id");

    // Acceptance drives a completed follow-up turn in Normal harness mode; the
    // route change opens a fresh Normal session per the route-mismatch rule.
    let follow_up = settled.follow_up.expect("accept drives a follow-up turn");
    assert_eq!(follow_up.harness_mode, LocalCodexChatHarnessMode::Normal);
    assert_eq!(follow_up.timeline_turn_id, accept_turn_id);

    let history = read_history(&state, &project_id, &conversation_id).expect("history");
    assert_eq!(history.turns.len(), 2);
    assert!(history.turns.iter().all(|turn| turn.status == "completed"));
    assert_eq!(history.plan_decisions.len(), 1);
    assert_eq!(history.plan_decisions[0].status, "accepted");
    assert_eq!(
        history.plan_decisions[0].accept_turn_id.as_deref(),
        Some(accept_turn_id)
    );

    // A fresh state service over the same sqlite file shows both turns and
    // the settled decision.
    let reopened = ServerStateService::new(SqliteBackend::new(path));
    let history = read_history(&reopened, &project_id, &conversation_id).expect("reopened history");
    assert_eq!(history.turns.len(), 2);
    assert!(history.turns.iter().all(|turn| turn.status == "completed"));
    assert_eq!(history.plan_decisions.len(), 1);
    assert_eq!(history.plan_decisions[0].status, "accepted");
    assert_eq!(
        history.plan_decisions[0].accept_turn_id.as_deref(),
        Some(accept_turn_id)
    );
}
