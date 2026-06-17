use nucleus_orchestration::{
    OrchestrationAcceptedCommand, OrchestrationCommandAdmission,
    OrchestrationCommandAdmissionService, OrchestrationCommandDecision, OrchestrationCommandFamily,
    OrchestrationCommandId, OrchestrationCommandRejectionReason,
};

use crate::commands::{ServerCommand, ServerCommandKind, TaskCommand};
use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};

pub(crate) enum CommandAdmissionOutcome {
    NotOrchestrated,
    Accepted(OrchestrationAcceptedCommand),
    Rejected(ServerCommandReceiptStatus),
}

pub(crate) fn admit_state_command(command: &ServerCommand) -> CommandAdmissionOutcome {
    let admission = match orchestration_admission_from_command(command) {
        Some(admission) => admission,
        None => return CommandAdmissionOutcome::NotOrchestrated,
    };

    match OrchestrationCommandAdmissionService::new().admit(admission) {
        OrchestrationCommandDecision::Accepted(accepted) => {
            CommandAdmissionOutcome::Accepted(accepted)
        }
        OrchestrationCommandDecision::Rejected(rejection) => CommandAdmissionOutcome::Rejected(
            ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
                reason: orchestration_rejection_reason(rejection.reason),
            }),
        ),
    }
}

fn orchestration_admission_from_command(
    command: &ServerCommand,
) -> Option<OrchestrationCommandAdmission> {
    match &command.kind {
        ServerCommandKind::Task(task_command) => Some(OrchestrationCommandAdmission {
            command_id: OrchestrationCommandId(command.id.0.clone()),
            family: OrchestrationCommandFamily::Task,
            target_ref: task_command_target_ref(task_command),
            summary: Some("task command admission".to_owned()),
        }),
        _ => None,
    }
}

fn task_command_target_ref(command: &TaskCommand) -> Option<String> {
    match command {
        TaskCommand::Create(command) => Some(command.project_id.0.clone()),
        TaskCommand::Update(command) => Some(command.task_id.0.clone()),
        TaskCommand::Start(command) => Some(command.task_id.0.clone()),
        TaskCommand::Block { task_id, .. } => Some(task_id.0.clone()),
        TaskCommand::Complete(command) => Some(command.task_id.0.clone()),
        TaskCommand::Archive(command) => Some(command.task_id.0.clone()),
    }
}

fn orchestration_rejection_reason(reason: OrchestrationCommandRejectionReason) -> String {
    match reason {
        OrchestrationCommandRejectionReason::MissingTargetRef => {
            "orchestration admission requires a target ref".to_owned()
        }
        OrchestrationCommandRejectionReason::EmptyCommandId => {
            "orchestration admission requires a command id".to_owned()
        }
        OrchestrationCommandRejectionReason::UnsupportedFamily => {
            "orchestration admission rejected unsupported command family".to_owned()
        }
        OrchestrationCommandRejectionReason::Custom(reason) => reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{TaskTransitionCommand, TaskUpdateChanges, TaskUpdateCommand};
    use crate::{ClientId, ServerCommandId};
    use nucleus_tasks::TaskId;

    #[test]
    fn task_update_command_passes_orchestration_admission() {
        let command = ServerCommand {
            id: ServerCommandId("command:task:update".to_owned()),
            client_id: ClientId("client:1".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Update(TaskUpdateCommand {
                task_id: TaskId("task:1".to_owned()),
                expected_revision: None,
                changes: TaskUpdateChanges::default(),
            })),
        };

        assert!(matches!(
            admit_state_command(&command),
            CommandAdmissionOutcome::Accepted(_)
        ));
    }

    #[test]
    fn task_transition_command_passes_orchestration_admission() {
        let command = ServerCommand {
            id: ServerCommandId("command:task:start".to_owned()),
            client_id: ClientId("client:1".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Start(TaskTransitionCommand {
                task_id: TaskId("task:1".to_owned()),
                expected_revision: None,
            })),
        };

        assert!(matches!(
            admit_state_command(&command),
            CommandAdmissionOutcome::Accepted(_)
        ));
    }
}
