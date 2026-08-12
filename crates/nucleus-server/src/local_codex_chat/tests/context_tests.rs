//! Context folding tests: active task and selected goal enrichment,
//! split from the tests god file; behavior unchanged.

use super::*;

use crate::{
    seed_local_project, seed_local_task, LocalProjectSeed, LocalTaskSeed,
};
use nucleus_planning::GoalStatus;
use nucleus_projects::ProjectId;

use super::super::routing::focused_context_message;

#[test]
fn active_task_enriches_provider_input_without_rewriting_operator_message() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    seed_local_task(&state, LocalTaskSeed::nucleus_local_bootstrap()).expect("seed task");
    let operator_message = "What should we do next?";

    let provider_message = focused_context_message(
        &state,
        "project:nucleus-local",
        None,
        Some("task:nucleus-local:bootstrap"),
        operator_message,
    )
    .expect("active task context");

    assert!(provider_message.contains("Review Nucleus task workflow"));
    assert!(provider_message.ends_with(operator_message));
    assert_eq!(operator_message, "What should we do next?");
}

#[test]
fn selected_goal_resolves_current_context_without_granting_run_authority() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let state = ServerStateService::new(backend.clone());
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    let mut handler = LocalControlRequestHandler::new(backend, None);
    let command_id = "command:goal-context";
    accepted(
        &mut handler,
        ServerControlRequest {
            id: crate::ServerControlRequestId(format!("request:{command_id}")),
            client_id: crate::ClientId("client:test".to_owned()),
            kind: crate::control_api::ServerControlRequestKind::Command(crate::ServerCommand {
                id: crate::ServerCommandId(command_id.to_owned()),
                client_id: crate::ClientId("client:test".to_owned()),
                kind: crate::ServerCommandKind::Goal(crate::commands::GoalCommand::Create(
                    crate::commands::GoalCreateCommand {
                        project_id: ProjectId("project:nucleus-local".to_owned()),
                        title: "Selected goal".to_owned(),
                        desired_outcome: "Goal context reaches chat.".to_owned(),
                        scope: "Context only".to_owned(),
                        status: GoalStatus::Ready,
                        owner_refs: vec!["operator:test".to_owned()],
                        ordered_task_refs: Vec::new(),
                        planning_artifact_refs: Vec::new(),
                        provenance_refs: vec!["conversation:test".to_owned()],
                        stop_conditions: vec!["Stop before execution".to_owned()],
                        evidence_refs: Vec::new(),
                        current_next_task_ref: None,
                        next_action: Some("Shape tasks".to_owned()),
                    },
                )),
            }),
        },
    )
    .expect("create goal");

    let provider_message = focused_context_message(
        &state,
        "project:nucleus-local",
        Some("goal:command:goal-context"),
        None,
        "What next?",
    )
    .expect("goal context");

    assert!(provider_message.contains("Selected goal"));
    assert!(provider_message.contains("Goal context reaches chat."));
    assert!(provider_message.contains("not a mandate"));
    assert!(provider_message.ends_with("What next?"));
    assert!(state.runtime_effects().list().expect("effects").is_empty());
}
