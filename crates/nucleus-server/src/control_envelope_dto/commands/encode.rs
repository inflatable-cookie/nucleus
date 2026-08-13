//! Command DTO encoding into server command kinds.
//!
//! Split from the commands god file; behavior unchanged.

use nucleus_core::RevisionId;
use nucleus_tasks::TaskId;

use super::super::ControlApiCodecError;
use super::goal_authoring::{goal_create_kind, goal_update_kind};
use super::memory_proposal_review::memory_proposal_review_action;
use super::project_lifecycle::{
    project_create_kind, project_lifecycle_kind, project_resource_kind,
};
use super::read_only::read_only_command_kind;
use super::task_authoring::{task_create_kind, task_update_kind};
use super::types::{
    ControlCommandDto, ControlForgePullRequestCreationScopeDto,
    ControlForgePullRequestProviderDto, ControlForgePullRequestTextSourceDto,
    ControlTaskCommandActionDto,
};
use crate::commands::{
    RunCommand, RunDeliveryExecutionCommand, RunDispatchExecutionCommand, RunProposeCommand,
    ServerCommandKind, TaskCommand, TaskSeedPromotionCommand, TaskTransitionCommand,
};
use crate::ids::ServerCommandId;
use crate::memory_proposal_review_command::MemoryProposalReviewCommand;

impl ControlCommandDto {
    pub(crate) fn try_into_server_kind(
        self,
    ) -> Result<(ServerCommandId, ServerCommandKind), ControlApiCodecError> {
        match self {
            Self::ProjectCreate {
                command_id,
                display_name,
                transient,
                actor_ref,
                authority_host_ref,
                idempotency_key,
            } => Ok(project_create_kind(
                command_id,
                display_name,
                transient,
                actor_ref,
                authority_host_ref,
                idempotency_key,
            )),
            Self::ProjectLifecycle {
                command_id,
                project_id,
                action,
                expected_revision,
                display_name,
                actor_ref,
                authority_host_ref,
                idempotency_key,
            } => project_lifecycle_kind(
                command_id,
                project_id,
                action,
                expected_revision,
                display_name,
                actor_ref,
                authority_host_ref,
                idempotency_key,
            ),
            Self::ProjectResource {
                command_id,
                project_id,
                action,
                expected_revision,
                resource_id,
                locator,
                display_name,
                role,
                set_as_default,
                sync_policy,
                actor_ref,
                authority_host_ref,
                idempotency_key,
            } => project_resource_kind(
                command_id,
                project_id,
                action,
                expected_revision,
                resource_id,
                locator,
                display_name,
                role,
                set_as_default,
                sync_policy,
                actor_ref,
                authority_host_ref,
                idempotency_key,
            ),
            Self::Task {
                command_id,
                action,
                task_id,
                expected_revision,
                reason,
            } => transition_kind(command_id, action, task_id, expected_revision, reason),
            Self::TaskCreate {
                command_id,
                project_id,
                title,
                description,
                acceptance_criteria,
                importance,
                action_type,
                activity,
                agent_ready,
                required_context_refs,
                allowed_actions,
                stop_conditions,
                validation_commands,
            } => task_create_kind(
                command_id,
                project_id,
                title,
                description,
                acceptance_criteria,
                importance,
                action_type,
                activity,
                agent_ready,
                required_context_refs,
                allowed_actions,
                stop_conditions,
                validation_commands,
            ),
            Self::TaskUpdate {
                command_id,
                task_id,
                expected_revision,
                title,
                description,
                acceptance_criteria,
                importance,
                action_type,
                activity,
                agent_ready,
                required_context_refs,
                allowed_actions,
                stop_conditions,
                validation_commands,
            } => task_update_kind(
                command_id,
                task_id,
                expected_revision,
                title,
                description,
                acceptance_criteria,
                importance,
                action_type,
                activity,
                agent_ready,
                required_context_refs,
                allowed_actions,
                stop_conditions,
                validation_commands,
            ),
            Self::GoalCreate {
                command_id,
                project_id,
                title,
                desired_outcome,
                scope,
                status,
                owner_refs,
                ordered_task_refs,
                planning_artifact_refs,
                provenance_refs,
                stop_conditions,
                evidence_refs,
                current_next_task_ref,
                next_action,
            } => goal_create_kind(
                command_id,
                project_id,
                title,
                desired_outcome,
                scope,
                status,
                owner_refs,
                ordered_task_refs,
                planning_artifact_refs,
                provenance_refs,
                stop_conditions,
                evidence_refs,
                current_next_task_ref,
                next_action,
            ),
            Self::GoalUpdate {
                command_id,
                goal_id,
                expected_revision,
                title,
                desired_outcome,
                scope,
                owner_refs,
                ordered_task_refs,
                planning_artifact_refs,
                provenance_refs,
                stop_conditions,
                evidence_refs,
                current_next_task_ref,
                clear_current_next_task_ref,
                next_action,
                clear_next_action,
            } => goal_update_kind(
                command_id,
                goal_id,
                expected_revision,
                title,
                desired_outcome,
                scope,
                owner_refs,
                ordered_task_refs,
                planning_artifact_refs,
                provenance_refs,
                stop_conditions,
                evidence_refs,
                current_next_task_ref,
                clear_current_next_task_ref,
                next_action,
                clear_next_action,
            ),
            Self::TaskSeedPromotion {
                command_id,
                project_id,
                seed_id,
                expected_seed_revision,
                destination_task_id,
            } => Ok((
                ServerCommandId(command_id),
                ServerCommandKind::Task(TaskCommand::PromoteSeed(TaskSeedPromotionCommand {
                    project_id: nucleus_projects::ProjectId(project_id),
                    seed_id: nucleus_engine::EngineTaskSeedId(seed_id),
                    expected_seed_revision: expected_seed_revision.map(RevisionId),
                    destination_task_id: destination_task_id.map(TaskId),
                })),
            )),
            Self::MemoryProposalReview {
                command_id,
                action,
                proposal_id,
                expected_revision,
                reviewer_ref,
                note,
            } => Ok((
                ServerCommandId(command_id.clone()),
                ServerCommandKind::MemoryProposalReview(MemoryProposalReviewCommand {
                    command_id,
                    proposal_id,
                    expected_revision: RevisionId(expected_revision),
                    action: memory_proposal_review_action(action),
                    reviewer_ref,
                    note,
                }),
            )),
            Self::RunPropose {
                command_id,
                run_id,
                project_id,
                objective_scope,
                acceptance,
                stop_conditions,
                worktree_ref,
                provider_instance,
                provider_model,
                orchestrator_designation,
                token_budget,
                time_budget_seconds,
            } => Ok((
                ServerCommandId(command_id),
                ServerCommandKind::Run(RunCommand::Propose(RunProposeCommand {
                    run_id: nucleus_engine::EngineRunId(run_id),
                    project_id: nucleus_projects::ProjectId(project_id),
                    objective_scope,
                    acceptance,
                    stop_conditions,
                    worktree_ref,
                    provider_instance,
                    provider_model,
                    orchestrator_designation,
                    token_budget,
                    time_budget_seconds,
                })),
            )),
            Self::RunDispatchExecution {
                command_id,
                run_id,
                expected_revision,
                operator_ref,
            } => Ok((
                ServerCommandId(command_id),
                ServerCommandKind::RunDispatchExecution(RunDispatchExecutionCommand {
                    run_id: nucleus_engine::EngineRunId(run_id),
                    expected_revision: expected_revision.map(RevisionId),
                    operator_ref,
                }),
            )),
            Self::RunDeliveryExecution {
                command_id,
                run_id,
                closeout_summary,
                closeout_evidence_refs,
                closeout_diff_ref,
                operator_ref,
                commit_message,
                remote_target,
                pull_request_creation,
                idempotency_key,
                expected_revision,
            } => Ok((
                ServerCommandId(command_id),
                ServerCommandKind::RunDeliveryExecution(RunDeliveryExecutionCommand {
                    run_id: nucleus_engine::EngineRunId(run_id),
                    closeout_summary,
                    closeout_evidence_refs,
                    closeout_diff_ref,
                    operator_ref,
                    commit_message,
                    remote_target,
                    pull_request_creation: pull_request_creation
                        .map(forge_pull_request_creation_scope),
                    idempotency_key,
                    expected_revision: expected_revision.map(RevisionId),
                }),
            )),
            Self::ReadOnlyCommand {
                command_id,
                project_id,
                execution_host_id,
                executable,
                argv,
                working_directory,
                timeout_ms,
                stdout_limit_bytes,
                stderr_limit_bytes,
                command_display,
            } => read_only_command_kind(
                command_id,
                project_id,
                execution_host_id,
                executable,
                argv,
                working_directory,
                timeout_ms,
                stdout_limit_bytes,
                stderr_limit_bytes,
                command_display,
            ),
        }
    }
}

fn transition_kind(
    command_id: String,
    action: ControlTaskCommandActionDto,
    task_id: String,
    expected_revision: Option<String>,
    reason: Option<String>,
) -> Result<(ServerCommandId, ServerCommandKind), ControlApiCodecError> {
    let command_id = ServerCommandId(command_id);
    let task_id = TaskId(task_id);
    let expected_revision = expected_revision.map(RevisionId);
    let kind = match action {
        ControlTaskCommandActionDto::Start => {
            reject_reason("start", reason)?;
            TaskCommand::Start(TaskTransitionCommand {
                task_id,
                expected_revision,
            })
        }
        ControlTaskCommandActionDto::Block => TaskCommand::Block {
            task_id,
            reason: required_reason(reason)?,
            expected_revision,
        },
        ControlTaskCommandActionDto::Complete => {
            reject_reason("complete", reason)?;
            TaskCommand::Complete(TaskTransitionCommand {
                task_id,
                expected_revision,
            })
        }
        ControlTaskCommandActionDto::Archive => {
            reject_reason("archive", reason)?;
            TaskCommand::Archive(TaskTransitionCommand {
                task_id,
                expected_revision,
            })
        }
    };

    Ok((command_id, ServerCommandKind::Task(kind)))
}

fn required_reason(reason: Option<String>) -> Result<String, ControlApiCodecError> {
    match reason {
        Some(reason) if !reason.trim().is_empty() => Ok(reason),
        _ => Err(ControlApiCodecError::malformed(
            "block task command requires a reason",
        )),
    }
}

fn reject_reason(action: &str, reason: Option<String>) -> Result<(), ControlApiCodecError> {
    if reason.is_some() {
        return Err(ControlApiCodecError::malformed(format!(
            "{action} task command does not accept a reason"
        )));
    }
    Ok(())
}

fn forge_pull_request_creation_scope(
    scope: ControlForgePullRequestCreationScopeDto,
) -> crate::ForgePullRequestCreationScope {
    crate::ForgePullRequestCreationScope {
        forge_provider: match scope.forge_provider {
            ControlForgePullRequestProviderDto::GitHub => crate::ForgePullRequestProvider::GitHub,
            ControlForgePullRequestProviderDto::GitLab => crate::ForgePullRequestProvider::GitLab,
            ControlForgePullRequestProviderDto::GenericForge => {
                crate::ForgePullRequestProvider::GenericForge
            }
        },
        base_branch: scope.base_branch,
        head_branch: scope.head_branch,
        title_source: text_source(scope.title_source),
        body_source: text_source(scope.body_source),
    }
}

fn text_source(source: ControlForgePullRequestTextSourceDto) -> crate::ForgePullRequestTextSource {
    match source {
        ControlForgePullRequestTextSourceDto::OperatorProvided => {
            crate::ForgePullRequestTextSource::OperatorProvided
        }
        ControlForgePullRequestTextSourceDto::AgentSuggested => {
            crate::ForgePullRequestTextSource::AgentSuggested
        }
        ControlForgePullRequestTextSourceDto::GeneratedFromEvidence => {
            crate::ForgePullRequestTextSource::GeneratedFromEvidence
        }
    }
}
