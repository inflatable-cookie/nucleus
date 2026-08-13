//! Server-command decoding into the command DTO.
//!
//! Split from the commands god file; behavior unchanged.

use nucleus_core::RevisionId;
use nucleus_tasks::TaskId;

use super::super::ControlApiCodecError;
use super::goal_authoring::goal_command_dto;
use super::memory_proposal_review::memory_proposal_review_dto;
use super::project_lifecycle::project_command_dto;
use super::read_only::read_only_command_dto;
use super::task_authoring::{task_create_dto, task_update_dto};
use super::types::{
    ControlCommandDto, ControlDelegationActionDto, ControlForgePullRequestCreationScopeDto,
    ControlForgePullRequestProviderDto, ControlForgePullRequestTextSourceDto,
    ControlRunTransitionActionDto, ControlTaskCommandActionDto,
};
use crate::commands::{
    RunCommand, RunDeliveryExecutionCommand, RunDispatchExecutionCommand, RunProposeCommand,
    RunTransitionCommand, ServerCommand, ServerCommandKind, TaskCommand, TaskSeedPromotionCommand,
};
use crate::ids::ServerCommandId;

impl TryFrom<&ServerCommand> for ControlCommandDto {
    type Error = ControlApiCodecError;

    fn try_from(command: &ServerCommand) -> Result<Self, Self::Error> {
        match &command.kind {
            ServerCommandKind::Project(project_command) => {
                project_command_dto(&command.id, project_command)
            }
            ServerCommandKind::Task(task_command) => task_command_dto(&command.id, task_command),
            ServerCommandKind::Goal(goal_command) => goal_command_dto(&command.id, goal_command),
            ServerCommandKind::ReadOnlyCommand(read_only_command) => {
                Ok(read_only_command_dto(&command.id, read_only_command))
            }
            ServerCommandKind::MemoryProposalReview(review_command) => {
                Ok(memory_proposal_review_dto(&command.id, review_command))
            }
            ServerCommandKind::Run(RunCommand::Propose(run_propose_command)) => {
                Ok(run_propose_dto(&command.id, run_propose_command))
            }
            ServerCommandKind::Run(RunCommand::Accept(run_transition_command))
            | ServerCommandKind::Run(RunCommand::Reject(run_transition_command)) => {
                Ok(run_transition_dto(
                    &command.id,
                    run_transition_command,
                    matches!(command.kind, ServerCommandKind::Run(RunCommand::Accept(_))),
                ))
            }
            ServerCommandKind::RunDispatchExecution(dispatch_command) => {
                Ok(run_dispatch_execution_dto(&command.id, dispatch_command))
            }
            ServerCommandKind::RunDeliveryExecution(delivery_command) => {
                Ok(run_delivery_execution_dto(&command.id, delivery_command))
            }
            ServerCommandKind::OrchestratorDesignation(
                crate::commands::OrchestratorDesignationCommand::Designate(designate_command),
            ) => Ok(designate_orchestrator_dto(&command.id, designate_command)),
            ServerCommandKind::OrchestratorDesignation(
                crate::commands::OrchestratorDesignationCommand::Revoke(revoke_command),
            ) => Ok(revoke_orchestrator_dto(&command.id, revoke_command)),
            _ => Err(ControlApiCodecError::unsupported(
                "command shape is not supported by the first command DTO",
            )),
        }
    }
}

fn designate_orchestrator_dto(
    command_id: &ServerCommandId,
    command: &crate::commands::OrchestratorDesignateCommand,
) -> ControlCommandDto {
    ControlCommandDto::DesignateOrchestrator {
        command_id: command_id.0.clone(),
        designation_id: command.designation_id.clone(),
        project_id: command.project_id.0.clone(),
        orchestrator_provider_instance: command.orchestrator_provider_instance.clone(),
        allowed_worker_provider_instances: command.allowed_worker_provider_instances.clone(),
        allowed_worker_models: command.allowed_worker_models.clone(),
        concurrent_run_budget: command.concurrent_run_budget,
        per_run_token_budget: command.per_run_token_budget,
        per_run_time_budget_seconds: command.per_run_time_budget_seconds,
        allowed_actions: command
            .allowed_actions
            .iter()
            .map(|action| match action {
                nucleus_engine::EngineDelegationAction::Delegate => {
                    ControlDelegationActionDto::Delegate
                }
                nucleus_engine::EngineDelegationAction::RunStatus => {
                    ControlDelegationActionDto::RunStatus
                }
                nucleus_engine::EngineDelegationAction::CancelRun => {
                    ControlDelegationActionDto::CancelRun
                }
                nucleus_engine::EngineDelegationAction::AcceptDelivery => {
                    ControlDelegationActionDto::AcceptDelivery
                }
                nucleus_engine::EngineDelegationAction::RejectDelivery => {
                    ControlDelegationActionDto::RejectDelivery
                }
            })
            .collect(),
        steering_permitted: command.steering_permitted,
        expected_revision: command
            .expected_revision
            .as_ref()
            .map(|revision| revision.0.clone()),
    }
}

fn revoke_orchestrator_dto(
    command_id: &ServerCommandId,
    command: &crate::commands::OrchestratorRevokeDesignationCommand,
) -> ControlCommandDto {
    ControlCommandDto::RevokeOrchestrator {
        command_id: command_id.0.clone(),
        designation_id: command.designation_id.clone(),
        expected_revision: command
            .expected_revision
            .as_ref()
            .map(|revision| revision.0.clone()),
    }
}

fn run_propose_dto(command_id: &ServerCommandId, command: &RunProposeCommand) -> ControlCommandDto {
    ControlCommandDto::RunPropose {
        command_id: command_id.0.clone(),
        run_id: command.run_id.0.clone(),
        project_id: command.project_id.0.clone(),
        objective_scope: command.objective_scope.clone(),
        acceptance: command.acceptance.clone(),
        stop_conditions: command.stop_conditions.clone(),
        worktree_ref: command.worktree_ref.clone(),
        provider_instance: command.provider_instance.clone(),
        provider_model: command.provider_model.clone(),
        orchestrator_designation: command.orchestrator_designation.clone(),
        token_budget: command.token_budget,
        time_budget_seconds: command.time_budget_seconds,
    }
}

fn run_dispatch_execution_dto(
    command_id: &ServerCommandId,
    command: &RunDispatchExecutionCommand,
) -> ControlCommandDto {
    ControlCommandDto::RunDispatchExecution {
        command_id: command_id.0.clone(),
        run_id: command.run_id.0.clone(),
        expected_revision: command
            .expected_revision
            .as_ref()
            .map(|revision| revision.0.clone()),
        operator_ref: command.operator_ref.clone(),
    }
}

fn run_delivery_execution_dto(
    command_id: &ServerCommandId,
    command: &RunDeliveryExecutionCommand,
) -> ControlCommandDto {
    ControlCommandDto::RunDeliveryExecution {
        command_id: command_id.0.clone(),
        run_id: command.run_id.0.clone(),
        closeout_summary: command.closeout_summary.clone(),
        closeout_evidence_refs: command.closeout_evidence_refs.clone(),
        closeout_diff_ref: command.closeout_diff_ref.clone(),
        operator_ref: command.operator_ref.clone(),
        commit_message: command.commit_message.clone(),
        remote_target: command.remote_target.clone(),
        pull_request_creation: command
            .pull_request_creation
            .as_ref()
            .map(forge_pull_request_creation_scope_dto),
        idempotency_key: command.idempotency_key.clone(),
        expected_revision: command
            .expected_revision
            .as_ref()
            .map(|revision| revision.0.clone()),
    }
}

fn run_transition_dto(
    command_id: &ServerCommandId,
    command: &RunTransitionCommand,
    accepted: bool,
) -> ControlCommandDto {
    ControlCommandDto::RunTransition {
        command_id: command_id.0.clone(),
        run_id: command.run_id.0.clone(),
        action: if accepted {
            ControlRunTransitionActionDto::Accept
        } else {
            ControlRunTransitionActionDto::Reject
        },
        expected_revision: command
            .expected_revision
            .as_ref()
            .map(|revision| revision.0.clone()),
        reason: command.reason.clone(),
    }
}

fn forge_pull_request_creation_scope_dto(
    scope: &crate::ForgePullRequestCreationScope,
) -> ControlForgePullRequestCreationScopeDto {
    ControlForgePullRequestCreationScopeDto {
        forge_provider: match scope.forge_provider {
            crate::ForgePullRequestProvider::GitHub => {
                ControlForgePullRequestProviderDto::GitHub
            }
            crate::ForgePullRequestProvider::GitLab => {
                ControlForgePullRequestProviderDto::GitLab
            }
            crate::ForgePullRequestProvider::GenericForge => {
                ControlForgePullRequestProviderDto::GenericForge
            }
        },
        base_branch: scope.base_branch.clone(),
        head_branch: scope.head_branch.clone(),
        title_source: text_source_dto(scope.title_source.clone()),
        body_source: text_source_dto(scope.body_source.clone()),
    }
}

fn text_source_dto(source: crate::ForgePullRequestTextSource) -> ControlForgePullRequestTextSourceDto {
    match source {
        crate::ForgePullRequestTextSource::OperatorProvided => {
            ControlForgePullRequestTextSourceDto::OperatorProvided
        }
        crate::ForgePullRequestTextSource::AgentSuggested => {
            ControlForgePullRequestTextSourceDto::AgentSuggested
        }
        crate::ForgePullRequestTextSource::GeneratedFromEvidence => {
            ControlForgePullRequestTextSourceDto::GeneratedFromEvidence
        }
    }
}

fn task_command_dto(
    command_id: &ServerCommandId,
    task_command: &TaskCommand,
) -> Result<ControlCommandDto, ControlApiCodecError> {
    let dto = match task_command {
        TaskCommand::Start(command) => transition_command_dto(
            command_id,
            ControlTaskCommandActionDto::Start,
            &command.task_id,
            &command.expected_revision,
            None,
        ),
        TaskCommand::Block {
            task_id,
            reason,
            expected_revision,
        } => transition_command_dto(
            command_id,
            ControlTaskCommandActionDto::Block,
            task_id,
            expected_revision,
            Some(reason.clone()),
        ),
        TaskCommand::Complete(command) => transition_command_dto(
            command_id,
            ControlTaskCommandActionDto::Complete,
            &command.task_id,
            &command.expected_revision,
            None,
        ),
        TaskCommand::Archive(command) => transition_command_dto(
            command_id,
            ControlTaskCommandActionDto::Archive,
            &command.task_id,
            &command.expected_revision,
            None,
        ),
        TaskCommand::Create(command) => task_create_dto(command_id, command),
        TaskCommand::PromoteSeed(command) => task_seed_promotion_dto(command_id, command),
        TaskCommand::Update(command) => task_update_dto(command_id, command),
        TaskCommand::Delegate(_) => {
            return Err(ControlApiCodecError::unsupported(
                "task delegation command DTO is not defined yet",
            ));
        }
    };

    Ok(dto)
}

fn task_seed_promotion_dto(
    command_id: &ServerCommandId,
    command: &TaskSeedPromotionCommand,
) -> ControlCommandDto {
    ControlCommandDto::TaskSeedPromotion {
        command_id: command_id.0.clone(),
        project_id: command.project_id.0.clone(),
        seed_id: command.seed_id.0.clone(),
        expected_seed_revision: command
            .expected_seed_revision
            .as_ref()
            .map(|revision| revision.0.clone()),
        destination_task_id: command
            .destination_task_id
            .as_ref()
            .map(|task_id| task_id.0.clone()),
    }
}

fn transition_command_dto(
    command_id: &ServerCommandId,
    action: ControlTaskCommandActionDto,
    task_id: &TaskId,
    expected_revision: &Option<RevisionId>,
    reason: Option<String>,
) -> ControlCommandDto {
    ControlCommandDto::Task {
        command_id: command_id.0.clone(),
        action,
        task_id: task_id.0.clone(),
        expected_revision: expected_revision
            .as_ref()
            .map(|revision| revision.0.clone()),
        reason,
    }
}
