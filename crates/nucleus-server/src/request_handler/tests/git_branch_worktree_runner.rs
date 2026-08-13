use nucleus_engine::EngineRuntimeReceiptRef;

use super::*;
use crate::commands::GitBranchWorktreeRunnerEffectConfirmationCommand;
use crate::provider_git_branch_worktree_runner_authority::{
    read_git_branch_worktree_runner_operator_effect_intent_by_confirmation,
};
use crate::read_runtime_receipts;

fn confirmation_command() -> ServerCommand {
    ServerCommand {
        id: ServerCommandId("command:confirm-run-1".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerCommandKind::GitBranchWorktreeRunner(
            GitBranchWorktreeRunnerEffectConfirmationCommand {
                run_id: nucleus_engine::EngineRunId("run:1".to_owned()),
                handoff_id: "git-branch-worktree-execution-handoff:handoff:1".to_owned(),
                branch_ref: "run/run-1".to_owned(),
                worktree_location_ref: "../nucleus-wt/run-1".to_owned(),
                operator_ref: "operator:tom".to_owned(),
                idempotency_key: "confirm:run-1".to_owned(),
            },
        ),
    }
}

#[test]
fn handler_records_durable_operator_effect_intent_with_event_and_receipt() {
    let (_temp_dir, mut handler) = handler(None);

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:confirm".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(confirmation_command()),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Command(ServerCommandReceipt {
            status: ServerCommandReceiptStatus::AcceptedForStateMutation,
            ..
        })
    ));

    // Contract-018 admission event with the dedicated family.
    let events = handler.state().event_journal().list().expect("events");
    assert_eq!(events.len(), 1);
    let event_store_record =
        decode_orchestration_event_store_record(&events[0].payload.bytes).expect("decode event");
    let event = event_store_record.into_payload();
    assert_eq!(event.kind, OrchestrationEventKind::CommandAdmitted);
    assert_eq!(event.family, OrchestrationCommandFamily::GitBranchWorktreeRunner);
    assert_eq!(event.command_id.0, "command:confirm-run-1");
    assert_eq!(event.target_ref.as_deref(), Some("run:1"));

    // Durable operator effect intent: confirmed, isolated-worktree only.
    let record =
        read_git_branch_worktree_runner_operator_effect_intent_by_confirmation(
            handler.state(),
            "operator-confirmation:git-branch-worktree-runner:confirm:run-1",
        )
        .expect("read intent")
        .expect("intent record");
    assert_eq!(record.run_id, "run:1");
    assert_eq!(record.handoff_id, "git-branch-worktree-execution-handoff:handoff:1");
    assert_eq!(record.branch_ref, "run/run-1");
    assert_eq!(record.worktree_location_ref, "../nucleus-wt/run-1");
    assert!(record.allow_isolated_worktree_creation);
    assert!(!record.allow_primary_tree_checkout);
    assert_eq!(record.operator_ref, "operator:tom");

    // Contract-020 runtime receipt for the confirmation effect.
    let receipts = read_runtime_receipts(handler.state()).expect("receipts");
    assert_eq!(receipts.len(), 1);
    assert_eq!(
        receipts[0].command_ref,
        Some(EngineRuntimeReceiptRef::CommandId(
            "command:confirm-run-1".to_owned()
        ))
    );
    assert_eq!(
        receipts[0].effect_ref,
        Some(EngineRuntimeReceiptRef::Custom(
            "git-branch-worktree-runner:operator-effect-intent:confirmed:run:1".to_owned()
        ))
    );
}

#[test]
fn handler_replays_repeat_confirmation_without_duplicate_receipt() {
    let (_temp_dir, mut handler) = handler(None);

    let first = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:confirm".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(confirmation_command()),
    });
    assert_eq!(first.status, ServerControlResponseStatus::Accepted);

    let mut repeat = confirmation_command();
    repeat.id = ServerCommandId("command:confirm-run-1-repeat".to_owned());
    let second = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:confirm-repeat".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(repeat),
    });
    assert_eq!(second.status, ServerControlResponseStatus::Accepted);

    let records = handler.state().artifact_metadata().list().expect("records");
    assert_eq!(records.len(), 1);
    let receipts = read_runtime_receipts(handler.state()).expect("receipts");
    assert_eq!(receipts.len(), 1);
}

#[test]
fn handler_rejects_same_idempotency_key_bound_to_different_target() {
    let (_temp_dir, mut handler) = handler(None);

    let first = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:confirm".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(confirmation_command()),
    });
    assert_eq!(first.status, ServerControlResponseStatus::Accepted);

    let mut conflicting = confirmation_command();
    conflicting.id = ServerCommandId("command:confirm-run-1-conflict".to_owned());
    let ServerCommandKind::GitBranchWorktreeRunner(command) = &mut conflicting.kind else {
        unreachable!("confirmation command");
    };
    command.worktree_location_ref = "../nucleus-wt/run-other".to_owned();

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:confirm-conflict".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(conflicting),
    });
    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Command(ServerCommandReceipt {
            status: ServerCommandReceiptStatus::Rejected(ServerControlError::Conflict { .. }),
            ..
        })
    ));
}

#[test]
fn handler_rejects_confirmation_with_missing_target_refs() {
    let (_temp_dir, mut handler) = handler(None);

    let mut incomplete = confirmation_command();
    incomplete.id = ServerCommandId("command:confirm-run-1-incomplete".to_owned());
    let ServerCommandKind::GitBranchWorktreeRunner(command) = &mut incomplete.kind else {
        unreachable!("confirmation command");
    };
    command.branch_ref = String::new();

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:confirm-incomplete".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(incomplete),
    });
    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Command(ServerCommandReceipt {
            status: ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
                ..
            }),
            ..
        })
    ));
    assert!(read_git_branch_worktree_runner_operator_effect_intent_by_confirmation(
        handler.state(),
        "operator-confirmation:git-branch-worktree-runner:confirm:run-1",
    )
    .expect("read intent")
    .is_none());
}
