//! Server command envelope types.

use nucleus_agent_protocol::{AdapterIdentity, AgentSessionId, ModelRoute};
use nucleus_core::RevisionId;
use nucleus_native_harness::NativeStewardCommandRequest;
use nucleus_planning::{GoalStatus, PlanningGoalId};
use nucleus_projects::{
    ManagementProjectionSyncPolicy, ProjectId, ProjectResourceId, ProjectResourceRole,
};
use nucleus_tasks::{
    AcceptanceCriterion, AgentReadiness, TaskActionType, TaskActivityState, TaskId, TaskImportance,
};
use nucleus_workspaces::{WorkspaceLayout, WorkspaceLayoutId};

use crate::ids::{ClientId, ServerCommandId};
use crate::memory_proposal_review_command::MemoryProposalReviewCommand;

/// Command sent by a control-plane client to the server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerCommand {
    pub id: ServerCommandId,
    pub client_id: ClientId,
    pub kind: ServerCommandKind,
}

/// Top-level command categories.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerCommandKind {
    Project(ProjectCommand),
    Task(TaskCommand),
    Goal(GoalCommand),
    Workspace(WorkspaceCommand),
    AgentSession(AgentSessionCommand),
    Steward(NativeStewardCommandRequest),
    MemoryProposalReview(MemoryProposalReviewCommand),
    ReadOnlyCommand(ReadOnlyCommand),
    ConfigureModelRoute(ModelRoute),
}

/// Goal authoring commands. Lifecycle execution is intentionally absent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GoalCommand {
    Create(GoalCreateCommand),
    Update(GoalUpdateCommand),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalCreateCommand {
    pub project_id: ProjectId,
    pub title: String,
    pub desired_outcome: String,
    pub scope: String,
    pub status: GoalStatus,
    pub owner_refs: Vec<String>,
    pub ordered_task_refs: Vec<TaskId>,
    pub planning_artifact_refs: Vec<String>,
    pub provenance_refs: Vec<String>,
    pub stop_conditions: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub current_next_task_ref: Option<TaskId>,
    pub next_action: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalUpdateCommand {
    pub goal_id: PlanningGoalId,
    pub expected_revision: RevisionId,
    pub changes: GoalUpdateChanges,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GoalUpdateChanges {
    pub title: Option<String>,
    pub desired_outcome: Option<String>,
    pub scope: Option<String>,
    pub owner_refs: Option<Vec<String>>,
    pub ordered_task_refs: Option<Vec<TaskId>>,
    pub planning_artifact_refs: Option<Vec<String>>,
    pub provenance_refs: Option<Vec<String>>,
    pub stop_conditions: Option<Vec<String>>,
    pub evidence_refs: Option<Vec<String>>,
    pub current_next_task_ref: Option<Option<TaskId>>,
    pub next_action: Option<Option<String>>,
}

/// Narrow local read-only command execution request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadOnlyCommand {
    pub project_id: ProjectId,
    pub execution_host_id: crate::EngineHostId,
    pub executable: String,
    pub argv: Vec<String>,
    pub working_directory: std::path::PathBuf,
    pub timeout_ms: u64,
    pub stdout_limit_bytes: usize,
    pub stderr_limit_bytes: usize,
    pub command_display: Option<String>,
}

/// Project state commands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectCommand {
    Create(ProjectCreateCommand),
    Lifecycle(ProjectLifecycleCommand),
    Resource(ProjectResourceCommand),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectCreateCommand {
    pub display_name: String,
    pub transient: bool,
    pub actor_ref: String,
    pub authority_host_ref: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectLifecycleCommand {
    pub project_id: ProjectId,
    pub expected_revision: RevisionId,
    pub actor_ref: String,
    pub authority_host_ref: String,
    pub idempotency_key: String,
    pub action: ProjectLifecycleAction,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectLifecycleAction {
    Rename { display_name: String },
    Park,
    Archive,
    Restore,
    Delete,
    Promote { display_name: Option<String> },
    ExpireTransient,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectResourceCommand {
    pub project_id: ProjectId,
    pub expected_revision: RevisionId,
    pub actor_ref: String,
    pub authority_host_ref: String,
    pub idempotency_key: String,
    pub action: ProjectResourceAction,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectResourceAction {
    Attach {
        locator: std::path::PathBuf,
    },
    Update {
        resource_id: ProjectResourceId,
        display_name: Option<String>,
        role: Option<ProjectResourceRole>,
        set_as_default: Option<bool>,
    },
    Repair {
        resource_id: ProjectResourceId,
        locator: std::path::PathBuf,
    },
    Remove {
        resource_id: ProjectResourceId,
    },
    SetManagementProjection {
        resource_id: ProjectResourceId,
        sync_policy: ManagementProjectionSyncPolicy,
    },
    ClearManagementProjection,
}

/// Task state commands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskCommand {
    Create(TaskCreateCommand),
    PromoteSeed(TaskSeedPromotionCommand),
    Update(TaskUpdateCommand),
    Delegate(TaskDelegationCommand),
    Start(TaskTransitionCommand),
    Block {
        task_id: TaskId,
        reason: String,
        expected_revision: Option<RevisionId>,
    },
    Complete(TaskTransitionCommand),
    Archive(TaskTransitionCommand),
}

/// Promote one reviewed planning task seed into one task-domain record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskSeedPromotionCommand {
    pub project_id: ProjectId,
    pub seed_id: nucleus_engine::EngineTaskSeedId,
    pub expected_seed_revision: Option<RevisionId>,
    pub destination_task_id: Option<TaskId>,
}

/// Task create command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskCreateCommand {
    pub project_id: ProjectId,
    pub title: String,
    pub description: Option<String>,
    pub acceptance_criteria: Vec<AcceptanceCriterion>,
    pub importance: TaskImportance,
    pub action_type: TaskActionType,
    pub activity: TaskActivityState,
    pub agent_readiness: AgentReadiness,
}

/// Task update command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskUpdateCommand {
    pub task_id: TaskId,
    pub expected_revision: Option<RevisionId>,
    pub changes: TaskUpdateChanges,
}

/// Operator-controlled task delegation command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskDelegationCommand {
    pub task_id: TaskId,
    pub expected_revision: Option<RevisionId>,
    pub adapter_id: String,
    pub provider_instance_id: String,
    pub idempotency_key: String,
}

/// Replacement-by-field update values for editable task fields.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TaskUpdateChanges {
    pub title: Option<String>,
    pub description: Option<Option<String>>,
    pub acceptance_criteria: Option<Vec<AcceptanceCriterion>>,
    pub importance: Option<TaskImportance>,
    pub action_type: Option<TaskActionType>,
    pub activity: Option<TaskActivityState>,
    pub agent_readiness: Option<AgentReadiness>,
}

/// Task activity transition command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskTransitionCommand {
    pub task_id: TaskId,
    pub expected_revision: Option<RevisionId>,
}

/// Workspace layout commands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspaceCommand {
    Save(WorkspaceLayout),
    Activate(WorkspaceLayoutId),
    Archive(WorkspaceLayoutId),
}

/// Agent session commands routed through adapter instances.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentSessionCommand {
    RegisterAdapter(AdapterIdentity),
    StartSession {
        adapter_id: String,
        project_id: ProjectId,
    },
    CancelActiveTurn {
        session_id: AgentSessionId,
    },
    CloseSession {
        session_id: AgentSessionId,
    },
}
