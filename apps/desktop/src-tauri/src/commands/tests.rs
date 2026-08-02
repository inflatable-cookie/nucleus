use std::collections::BTreeSet;

use longhorn_command::{
    CommandAvailabilityState, CommandEvidence, CommandExecutionOutcome, CommandExecutionRequest,
    CommandExecutorOutcome, CommandRegistryGeneration, CommandSourceFailure, CommandSurface,
};
use longhorn_core::{CommandEvidenceCode, CommandId, CommandRequestId};
use serde_json::Value;

use super::{
    NucleusCommandCapability, NucleusCommandContext, NucleusCommandExecutor, NucleusCommandRoute,
    NucleusCommandService, NucleusCommandState, NucleusCommandStateSource,
};

struct StateSource {
    state: Result<NucleusCommandState, CommandSourceFailure>,
    calls: usize,
}

impl StateSource {
    fn new(state: NucleusCommandState) -> Self {
        Self {
            state: Ok(state),
            calls: 0,
        }
    }
}

impl NucleusCommandStateSource for StateSource {
    fn current_state(&mut self) -> Result<NucleusCommandState, CommandSourceFailure> {
        self.calls += 1;
        self.state.clone()
    }
}

struct RecordingExecutor {
    outcome: CommandExecutorOutcome,
    routes: Vec<NucleusCommandRoute>,
}

impl RecordingExecutor {
    fn succeeded() -> Self {
        Self {
            outcome: CommandExecutorOutcome::Succeeded { evidence: None },
            routes: Vec::new(),
        }
    }
}

impl NucleusCommandExecutor for RecordingExecutor {
    fn execute(&mut self, route: NucleusCommandRoute) -> CommandExecutorOutcome {
        self.routes.push(route);
        self.outcome.clone()
    }
}

#[test]
fn catalogue_covers_the_initial_product_inventory_without_transport_identity() {
    let _all_contexts = [
        NucleusCommandContext::Global,
        NucleusCommandContext::Workspace,
        NucleusCommandContext::Project,
        NucleusCommandContext::Panel,
        NucleusCommandContext::AgentChat,
        NucleusCommandContext::Editor,
        NucleusCommandContext::Forge,
    ];
    let service = NucleusCommandService::new().expect("command service");
    let registry = service.registry();
    assert_eq!(registry.commands().len(), 27);
    let ids = registry
        .commands()
        .map(|command| command.id.as_str())
        .collect::<BTreeSet<_>>();
    for expected in [
        "nucleus:shell.show-command-palette",
        "nucleus:shell.open-settings",
        "nucleus:project.create",
        "nucleus:sidebar.show-threads",
        "nucleus:thread.rename-active",
        "nucleus:panel.open-agent-chat",
        "nucleus:panel.close-active",
        "nucleus:editor.quick-open",
        "nucleus:editor.save",
        "nucleus:forge.refresh",
        "nucleus:agent.cancel-turn",
    ] {
        assert!(ids.contains(expected), "missing {expected}");
    }
    for command in registry.commands() {
        assert_ne!(command.id.as_str(), command.route.as_str());
        assert!(command.route.as_str().starts_with("nucleus.route."));
        assert!(!command.route.as_str().contains("tauri"));
        assert!(!command.route.as_str().contains("control-envelope"));
    }
    let save_hits = registry
        .search(CommandSurface::Palette, "save")
        .expect("search");
    assert_eq!(save_hits[0].record.id.as_str(), "nucleus:editor.save");
}

#[test]
fn stale_projection_cannot_authorize_a_now_clean_editor() {
    let service = NucleusCommandService::new().expect("command service");
    let mut state = NucleusCommandState::new(8, NucleusCommandContext::Editor);
    state.has_selected_project = true;
    state.has_active_panel = true;
    state.has_open_editor_file = true;
    state.editor_dirty = true;
    let mut source = StateSource::new(state);
    let projected = service
        .project_availability(&mut source)
        .expect("availability");
    let save_id = CommandId::new("nucleus:editor.save").expect("command id");
    assert_eq!(
        projected.command(&save_id).expect("save").state(),
        CommandAvailabilityState::Available
    );

    let current = source.state.as_mut().expect("state");
    current.context_revision = 9;
    current.editor_dirty = false;
    let mut executor = RecordingExecutor::succeeded();
    let result = service.execute(
        request(&service, "request:clean-save", "nucleus:editor.save"),
        &mut source,
        &mut executor,
    );
    assert!(matches!(
        result.outcome(),
        CommandExecutionOutcome::Unavailable { .. }
    ));
    assert_eq!(source.calls, 2);
    assert!(executor.routes.is_empty());
}

#[test]
fn admitted_command_resolves_to_one_typed_product_route() {
    let service = NucleusCommandService::new().expect("command service");
    let mut state = NucleusCommandState::new(4, NucleusCommandContext::AgentChat);
    state.has_selected_project = true;
    state.has_active_panel = true;
    state.has_active_thread = true;
    state.turn_running = true;
    let mut source = StateSource::new(state);
    let mut executor = RecordingExecutor::succeeded();
    let result = service.execute(
        request(&service, "request:cancel-turn", "nucleus:agent.cancel-turn"),
        &mut source,
        &mut executor,
    );
    assert!(matches!(
        result.outcome(),
        CommandExecutionOutcome::Succeeded { .. }
    ));
    assert_eq!(source.calls, 1);
    assert_eq!(executor.routes, vec![NucleusCommandRoute::CancelAgentTurn]);

    executor.outcome = CommandExecutorOutcome::Unauthorized {
        evidence: Some(CommandEvidence::new(
            CommandEvidenceCode::new("nucleus:operator-denied").expect("evidence code"),
            None,
        )),
    };
    let denied = service.execute(
        request(
            &service,
            "request:cancel-denied",
            "nucleus:agent.cancel-turn",
        ),
        &mut source,
        &mut executor,
    );
    assert!(matches!(
        denied.outcome(),
        CommandExecutionOutcome::Unauthorized { .. }
    ));
}

#[test]
fn stale_unknown_invalid_and_missing_capability_requests_never_execute() {
    let service = NucleusCommandService::new().expect("command service");
    let mut state = NucleusCommandState::new(1, NucleusCommandContext::Editor);
    state.has_selected_project = true;
    state.has_active_panel = true;
    state.has_open_editor_file = true;
    state.editor_dirty = true;
    let mut source = StateSource::new(state);
    let mut executor = RecordingExecutor::succeeded();

    let mut stale = request(&service, "request:stale", "nucleus:editor.save");
    stale.registry_generation = CommandRegistryGeneration::new(0);
    assert!(matches!(
        service.execute(stale, &mut source, &mut executor).outcome(),
        CommandExecutionOutcome::StaleRegistry { .. }
    ));
    assert_eq!(source.calls, 0);

    assert!(matches!(
        service
            .execute(
                request(&service, "request:unknown", "nucleus:missing"),
                &mut source,
                &mut executor,
            )
            .outcome(),
        CommandExecutionOutcome::UnknownCommand
    ));
    assert_eq!(source.calls, 0);

    let mut invalid = request(&service, "request:invalid", "nucleus:editor.save");
    invalid.arguments = serde_json::json!({"path": "unbounded"});
    assert!(matches!(
        service
            .execute(invalid, &mut source, &mut executor)
            .outcome(),
        CommandExecutionOutcome::InvalidArguments { .. }
    ));
    assert_eq!(source.calls, 0);

    source
        .state
        .as_mut()
        .expect("state")
        .capabilities
        .retain(|capability| *capability != NucleusCommandCapability::Editor);
    assert!(matches!(
        service
            .execute(
                request(
                    &service,
                    "request:missing-capability",
                    "nucleus:editor.save",
                ),
                &mut source,
                &mut executor,
            )
            .outcome(),
        CommandExecutionOutcome::Unavailable { .. }
    ));
    assert_eq!(source.calls, 1);
    assert!(executor.routes.is_empty());
}

fn request(
    service: &NucleusCommandService,
    request_id: &str,
    command_id: &str,
) -> CommandExecutionRequest {
    CommandExecutionRequest {
        request_id: CommandRequestId::new(request_id).expect("request id"),
        registry_generation: service.registry().generation(),
        command_id: CommandId::new(command_id).expect("command id"),
        arguments: Value::Null,
    }
}
