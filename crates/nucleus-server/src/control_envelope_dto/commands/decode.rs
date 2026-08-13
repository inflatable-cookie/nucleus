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
use super::types::{ControlCommandDto, ControlTaskCommandActionDto};
use crate::commands::{
    RunCommand, RunDeliveryExecutionCommand, RunDispatchExecutionCommand, RunProposeCommand,
    ServerCommand, ServerCommandKind, TaskCommand, TaskSeedPromotionCommand,
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
            ServerCommandKind::RunDispatchExecution(dispatch_command) => {
                Ok(run_dispatch_execution_dto(&command.id, dispatch_command))
            }
            ServerCommandKind::RunDeliveryExecution(delivery_command) => {
                Ok(run_delivery_execution_dto(&command.id, delivery_command))
            }
            _ => Err(ControlApiCodecError::unsupported(
                "command shape is not supported by the first command DTO",
            )),
        }
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
        idempotency_key: command.idempotency_key.clone(),
        expected_revision: command
            .expected_revision
            .as_ref()
            .map(|revision| revision.0.clone()),
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
