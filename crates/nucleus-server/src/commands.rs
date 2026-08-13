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
    Run(RunCommand),
    Goal(GoalCommand),
    Workspace(WorkspaceCommand),
    AgentSession(AgentSessionCommand),
    Steward(NativeStewardCommandRequest),
    MemoryProposalReview(MemoryProposalReviewCommand),
    ReadOnlyCommand(ReadOnlyCommand),
    ConfigureModelRoute(ModelRoute),
    GitBranchWorktreeRunner(GitBranchWorktreeRunnerEffectConfirmationCommand),
    GitBranchWorktreeRunnerDelivery(GitBranchWorktreeRunnerDeliveryEffectConfirmationCommand),
    RunDispatchExecution(RunDispatchExecutionCommand),
    RunDeliveryExecution(RunDeliveryExecutionCommand),
}

/// Operator confirmation that one run dispatch may create its isolated
/// worktree through the branch/worktree runner authority chain.
///
/// First git mutation on the control surface: this command records a durable
/// operator effect intent (admission family `GitBranchWorktreeRunner`); the
/// gated `git worktree add` execution path runs only when the authority chain
/// reaches `ReadyForRunner` from this intent plus an admitted handoff and
/// approved target refs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeRunnerEffectConfirmationCommand {
    /// Run dispatch this confirmation binds.
    pub run_id: nucleus_engine::EngineRunId,
    /// Admitted execution handoff record id being confirmed.
    pub handoff_id: String,
    /// Exact target branch ref (`run/<run-slug>`).
    pub branch_ref: String,
    /// Exact target worktree location (`../<repo>-wt/<slug>`).
    pub worktree_location_ref: String,
    /// Operator identity recording the intent.
    pub operator_ref: String,
    /// Idempotency key; repeats replay the same durable confirmation.
    pub idempotency_key: String,
}

/// Operator confirmation for one delivery's local commit and push of the
/// run's own branch. This is distinct from dispatch-time worktree creation.
/// When `pull_request_creation` carries an operator-confirmed scope, the same
/// confirmation admits per-delivery pull-request creation for that branch on
/// top of the confirmed remote.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeRunnerDeliveryEffectConfirmationCommand {
    pub run_id: nucleus_engine::EngineRunId,
    pub handoff_id: String,
    pub branch_ref: String,
    pub worktree_location_ref: String,
    pub commit_message: String,
    pub remote_target: String,
    pub pull_request_creation: Option<crate::ForgePullRequestCreationScope>,
    pub operator_ref: String,
    pub idempotency_key: String,
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

/// Orchestration run lifecycle commands (contract 033 Run Record Rule).
/// Every transition is a command; invalid transitions are rejected.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunCommand {
    Propose(RunProposeCommand),
    Dispatch(RunDispatchCommand),
    MarkRunning(RunTransitionCommand),
    Deliver(RunDeliverCommand),
    Accept(RunTransitionCommand),
    Reject(RunTransitionCommand),
    Fail(RunTransitionCommand),
    Cancel(RunTransitionCommand),
}

/// Propose a run record: objective, worktree, provider, budget envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunProposeCommand {
    pub run_id: nucleus_engine::EngineRunId,
    pub project_id: ProjectId,
    pub objective_scope: String,
    pub acceptance: Vec<String>,
    pub stop_conditions: Vec<String>,
    pub worktree_ref: Option<String>,
    pub provider_instance: String,
    pub provider_model: String,
    pub orchestrator_designation: Option<String>,
    pub token_budget: Option<u64>,
    pub time_budget_seconds: Option<u64>,
}

/// Dispatch transitions `proposed -> dispatched` and binds the worker
/// operation identity when the spawn side knows it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunDispatchCommand {
    pub run_id: nucleus_engine::EngineRunId,
    pub operation_id: Option<String>,
    pub conversation_id: Option<String>,
    pub worktree_ref: Option<String>,
    /// Fork point of the run branch (primary repo HEAD at dispatch); the
    /// delivery review diff is computed against this ref.
    pub base_ref: Option<String>,
    pub expected_revision: Option<RevisionId>,
}

/// Operator-confirmed run dispatch execution: create the isolated worktree
/// through the branch/worktree runner authority chain (durable
/// `GitBranchWorktreeRunnerOperatorEffectIntent::Confirmed` written first,
/// gated `git worktree add` second — never a bare spawn), register the
/// worktree as a project resource, and transition the run
/// `proposed -> dispatched` binding the deterministic run conversation
/// (`conversation:run:<run_id>`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunDispatchExecutionCommand {
    pub run_id: nucleus_engine::EngineRunId,
    pub expected_revision: Option<RevisionId>,
    pub operator_ref: String,
}

/// Complete one worker run through the delivery pipeline.
///
/// The server records closeout evidence, writes the per-delivery operator
/// intent, then invokes the gated branch/worktree runner for commit and (when
/// configured) push before transitioning the run to `delivered`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunDeliveryExecutionCommand {
    pub run_id: nucleus_engine::EngineRunId,
    pub closeout_summary: String,
    pub closeout_evidence_refs: Vec<String>,
    pub closeout_diff_ref: Option<String>,
    pub operator_ref: String,
    pub commit_message: String,
    /// Empty means the project has no configured remote; the local commit is
    /// still a deliverable branch.
    pub remote_target: String,
    /// Operator-confirmed per-delivery PR-creation scope on top of the
    /// confirmed remote. `None` keeps the delivery branch-only (no forge
    /// call); `Some` admits exactly one pull-request open for the run's own
    /// pushed branch through the forge pull-request runner authority chain.
    pub pull_request_creation: Option<crate::ForgePullRequestCreationScope>,
    pub idempotency_key: String,
    pub expected_revision: Option<RevisionId>,
}

/// One lifecycle transition with optional reason. `operation_id` binds the
/// observed worker operation identity and is only honored on `MarkRunning`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunTransitionCommand {
    pub run_id: nucleus_engine::EngineRunId,
    pub operation_id: Option<String>,
    pub expected_revision: Option<RevisionId>,
    pub reason: Option<String>,
}

/// Deliver transitions `running -> delivered`; carries the closeout.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunDeliverCommand {
    pub run_id: nucleus_engine::EngineRunId,
    pub closeout_summary: String,
    pub closeout_evidence_refs: Vec<String>,
    pub closeout_diff_ref: Option<String>,
    pub expected_revision: Option<RevisionId>,
}

/// Workspace layout commands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspaceCommand {
    Save(WorkspaceLayout),
    Activate(WorkspaceLayoutId),
    Archive(WorkspaceLayoutId),
}

/// Agent sessions routed through adapter instances.
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
