use nucleus_local_store::LocalStoreBackend;

use super::selected_task_action_readiness;
use super::LocalControlRequestHandler;
use crate::control_api::{
    SelectedTaskActionReadinessQuery, SelectedTaskOperatorActionGateQuery, ServerControlError,
    ServerQueryResult,
};
use crate::{selected_task_operator_action_gate, SelectedTaskOperatorActionGateInput};

pub(crate) fn selected_task_operator_action_gate_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: SelectedTaskOperatorActionGateQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() || query.task_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "selected task operator action gate query requires project and task ids"
                .to_owned(),
        });
    }

    let readiness = selected_task_action_readiness::selected_task_action_readiness_query(
        handler,
        SelectedTaskActionReadinessQuery {
            project_id: query.project_id,
            task_id: query.task_id,
        },
    )?;
    let ServerQueryResult::SelectedTaskActionReadiness(readiness) = readiness else {
        return Err(ServerControlError::InvalidRequest {
            reason: "selected task action readiness query returned an unexpected result".to_owned(),
        });
    };

    Ok(ServerQueryResult::SelectedTaskOperatorActionGate(
        selected_task_operator_action_gate(SelectedTaskOperatorActionGateInput {
            readiness,
            expected_revision: None,
            actor_ref: Some("client:nucleusd".to_owned()),
        }),
    ))
}
