use nucleus_local_store::LocalStoreBackend;

use super::selected_task_operator_action_gate;
use super::LocalControlRequestHandler;
use crate::control_api::{
    SelectedTaskCommandAdmissionQuery, SelectedTaskOperatorActionGateQuery, ServerControlError,
    ServerQueryResult,
};
use crate::{
    selected_task_command_admission, SelectedTaskCommandAdmissionInput,
    SelectedTaskCommandOperatorIntent,
};

pub(crate) fn selected_task_command_admission_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: SelectedTaskCommandAdmissionQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty()
        || query.task_id.0.trim().is_empty()
        || query.operator_ref.trim().is_empty()
    {
        return Err(ServerControlError::InvalidRequest {
            reason: "selected task command admission query requires project id, task id, and operator ref"
                .to_owned(),
        });
    }

    let gate = selected_task_operator_action_gate::selected_task_operator_action_gate_query(
        handler,
        SelectedTaskOperatorActionGateQuery {
            project_id: query.project_id,
            task_id: query.task_id,
        },
    )?;
    let ServerQueryResult::SelectedTaskOperatorActionGate(gate) = gate else {
        return Err(ServerControlError::InvalidRequest {
            reason: "selected task operator action gate query returned an unexpected result"
                .to_owned(),
        });
    };

    Ok(ServerQueryResult::SelectedTaskCommandAdmission(
        selected_task_command_admission(SelectedTaskCommandAdmissionInput {
            gate,
            intent: SelectedTaskCommandOperatorIntent {
                family: query.family,
                expected_revision: query.expected_revision,
                reason: query.reason,
                operator_ref: query.operator_ref,
            },
        }),
    ))
}
