use std::cell::RefCell;

use longhorn_command::{
    CommandAdmissionEngine, CommandAvailability, CommandAvailabilityProjectionError,
    CommandAvailabilitySnapshot, CommandAvailabilitySource, CommandCapabilitySnapshot,
    CommandCapabilitySource, CommandContextRevision, CommandContextSnapshot, CommandContextSource,
    CommandDefinition, CommandDiagnostic, CommandEvidence, CommandExecutionRequest,
    CommandExecutionResult, CommandExecutorOutcome, CommandRegistry, CommandSourceFailure,
};
use longhorn_core::{CommandCapabilityId, CommandContextId, CommandEvidenceCode};

use super::catalogue::{build_registry, NucleusCommandRoute};

mod availability;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NucleusCommandContext {
    Global,
    Workspace,
    Project,
    Panel,
    AgentChat,
    Editor,
    Forge,
}

impl NucleusCommandContext {
    fn path(self) -> &'static [&'static str] {
        match self {
            Self::Global => &["global"],
            Self::Workspace => &["global", "workspace"],
            Self::Project => &["global", "workspace", "project"],
            Self::Panel => &["global", "workspace", "project", "panel"],
            Self::AgentChat => &["global", "workspace", "project", "panel", "agent-chat"],
            Self::Editor => &["global", "workspace", "project", "panel", "editor"],
            Self::Forge => &["global", "workspace", "project", "panel", "forge"],
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NucleusCommandCapability {
    Shell,
    Projects,
    Threads,
    Panels,
    Editor,
    Forge,
    AgentTurns,
}

impl NucleusCommandCapability {
    pub(crate) const ALL: [Self; 7] = [
        Self::Shell,
        Self::Projects,
        Self::Threads,
        Self::Panels,
        Self::Editor,
        Self::Forge,
        Self::AgentTurns,
    ];

    const fn as_str(self) -> &'static str {
        match self {
            Self::Shell => "nucleus:shell",
            Self::Projects => "nucleus:projects",
            Self::Threads => "nucleus:threads",
            Self::Panels => "nucleus:panels",
            Self::Editor => "nucleus:editor",
            Self::Forge => "nucleus:forge",
            Self::AgentTurns => "nucleus:agent-turns",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NucleusCommandState {
    pub(crate) context_revision: u64,
    pub(crate) context: NucleusCommandContext,
    pub(crate) capabilities: Vec<NucleusCommandCapability>,
    pub(crate) has_selected_project: bool,
    pub(crate) has_active_thread: bool,
    pub(crate) has_active_panel: bool,
    pub(crate) has_open_editor_file: bool,
    pub(crate) editor_dirty: bool,
    pub(crate) forge_refreshable: bool,
    pub(crate) turn_running: bool,
}

impl NucleusCommandState {
    pub(crate) fn new(context_revision: u64, context: NucleusCommandContext) -> Self {
        Self {
            context_revision,
            context,
            capabilities: NucleusCommandCapability::ALL.to_vec(),
            has_selected_project: false,
            has_active_thread: false,
            has_active_panel: false,
            has_open_editor_file: false,
            editor_dirty: false,
            forge_refreshable: false,
            turn_running: false,
        }
    }

    fn context_snapshot(&self) -> CommandContextSnapshot {
        CommandContextSnapshot::new(
            CommandContextRevision::new(self.context_revision),
            self.context
                .path()
                .iter()
                .map(|value| CommandContextId::new(*value).expect("static command context id"))
                .collect(),
        )
        .expect("static Nucleus command context path")
    }

    fn capability_snapshot(&self) -> CommandCapabilitySnapshot {
        CommandCapabilitySnapshot::new(self.capabilities.iter().map(|capability| {
            CommandCapabilityId::new(capability.as_str()).expect("static command capability id")
        }))
        .expect("bounded Nucleus command capability set")
    }
}

pub(crate) trait NucleusCommandStateSource {
    fn current_state(&mut self) -> Result<NucleusCommandState, CommandSourceFailure>;
}

pub(crate) trait NucleusCommandExecutor {
    fn execute(&mut self, route: NucleusCommandRoute) -> CommandExecutorOutcome;
}

pub(crate) struct NucleusCommandService {
    registry: CommandRegistry,
}

impl NucleusCommandService {
    pub(crate) fn new() -> Result<Self, String> {
        Ok(Self {
            registry: build_registry()?,
        })
    }

    pub(crate) const fn registry(&self) -> &CommandRegistry {
        &self.registry
    }

    pub(crate) fn project_availability(
        &self,
        source: &mut impl NucleusCommandStateSource,
    ) -> Result<CommandAvailabilitySnapshot, CommandAvailabilityProjectionError> {
        let cache = RefCell::new(StateCache::new(source));
        let mut contexts = ContextPort { cache: &cache };
        let mut capabilities = CapabilityPort { cache: &cache };
        let mut availability = AvailabilityPort { cache: &cache };
        CommandAdmissionEngine::new(&self.registry).project_availability(
            &mut contexts,
            &mut capabilities,
            &mut availability,
        )
    }

    pub(crate) fn execute(
        &self,
        request: CommandExecutionRequest,
        source: &mut impl NucleusCommandStateSource,
        executor: &mut impl NucleusCommandExecutor,
    ) -> CommandExecutionResult {
        let cache = RefCell::new(StateCache::new(source));
        let mut contexts = ContextPort { cache: &cache };
        let mut capabilities = CapabilityPort { cache: &cache };
        let mut availability = AvailabilityPort { cache: &cache };
        let admitted = match CommandAdmissionEngine::new(&self.registry).admit(
            request,
            &mut contexts,
            &mut capabilities,
            &mut availability,
        ) {
            Ok(admitted) => admitted,
            Err(result) => return result,
        };
        let outcome = NucleusCommandRoute::from_route(admitted.route().as_str()).map_or_else(
            || CommandExecutorOutcome::Failed {
                evidence: Some(evidence(
                    "nucleus:unmapped-command-route",
                    "The admitted command route is not mapped to a Nucleus executor.",
                )),
            },
            |route| executor.execute(route),
        );
        CommandAdmissionEngine::complete(&admitted, outcome)
    }
}

struct StateCache<'source> {
    source: &'source mut dyn NucleusCommandStateSource,
    state: Option<Result<NucleusCommandState, CommandSourceFailure>>,
}

impl<'source> StateCache<'source> {
    fn new(source: &'source mut dyn NucleusCommandStateSource) -> Self {
        Self {
            source,
            state: None,
        }
    }

    fn current(&mut self) -> Result<NucleusCommandState, CommandSourceFailure> {
        if self.state.is_none() {
            self.state = Some(self.source.current_state());
        }
        self.state
            .as_ref()
            .expect("command state cache initialized")
            .clone()
    }
}

struct ContextPort<'cache, 'source> {
    cache: &'cache RefCell<StateCache<'source>>,
}

impl CommandContextSource for ContextPort<'_, '_> {
    fn current_context(&mut self) -> Result<CommandContextSnapshot, CommandSourceFailure> {
        self.cache
            .borrow_mut()
            .current()
            .map(|state| state.context_snapshot())
    }
}

struct CapabilityPort<'cache, 'source> {
    cache: &'cache RefCell<StateCache<'source>>,
}

impl CommandCapabilitySource for CapabilityPort<'_, '_> {
    fn current_capabilities(&mut self) -> Result<CommandCapabilitySnapshot, CommandSourceFailure> {
        self.cache
            .borrow_mut()
            .current()
            .map(|state| state.capability_snapshot())
    }
}

struct AvailabilityPort<'cache, 'source> {
    cache: &'cache RefCell<StateCache<'source>>,
}

impl CommandAvailabilitySource for AvailabilityPort<'_, '_> {
    fn availability(
        &mut self,
        command: &CommandDefinition,
        _context: &CommandContextSnapshot,
        _capabilities: &CommandCapabilitySnapshot,
    ) -> Result<CommandAvailability, CommandSourceFailure> {
        let state = self.cache.borrow_mut().current()?;
        let Some(route) = NucleusCommandRoute::from_route(command.route.as_str()) else {
            return Err(CommandSourceFailure::new(evidence(
                "nucleus:unmapped-command-route",
                "The registered command route is not mapped to Nucleus product availability.",
            )));
        };
        Ok(state.availability(route))
    }
}

fn evidence(code: &str, detail: &str) -> CommandEvidence {
    CommandEvidence::new(
        CommandEvidenceCode::new(code).expect("static command evidence code"),
        Some(CommandDiagnostic::new(detail).expect("static command diagnostic")),
    )
}
