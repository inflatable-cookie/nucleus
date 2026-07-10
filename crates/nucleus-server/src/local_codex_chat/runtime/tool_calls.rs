use serde_json::{json, Value};

use super::super::task_authoring::{TaskAuthoringReceipt, TaskToolOutcome};
use super::super::task_workflow::TaskWorkflowReceipt;

pub(super) struct ToolCallResponse {
    pub response: Value,
    pub receipt: Option<TaskAuthoringReceipt>,
    pub workflow_receipt: Option<TaskWorkflowReceipt>,
}

pub(super) fn prepare_tool_call_response<F>(
    value: &Value,
    active_turn_id: &str,
    task_tool: &mut F,
) -> Option<Result<ToolCallResponse, String>>
where
    F: FnMut(&str, &str, &str, Value) -> Result<TaskToolOutcome, String>,
{
    if value.get("method").and_then(Value::as_str) != Some("item/tool/call") {
        return None;
    }
    let id = value.get("id").cloned()?;
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let call_id = params
        .get("callId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tool = params
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let outcome = if turn_id != active_turn_id {
        Err("dynamic tool call belongs to another turn".to_owned())
    } else if call_id.is_empty() {
        Err("dynamic tool call did not include a call id".to_owned())
    } else {
        task_tool(
            tool,
            turn_id,
            call_id,
            params.get("arguments").cloned().unwrap_or(Value::Null),
        )
    };

    Some(match outcome {
        Ok(outcome) => Ok(ToolCallResponse {
            response: json!({
                "id": id,
                "result": {
                    "success": true,
                    "contentItems": [{ "type": "inputText", "text": outcome.text }]
                }
            }),
            receipt: outcome.receipt,
            workflow_receipt: outcome.workflow_receipt,
        }),
        Err(error) => Ok(ToolCallResponse {
            response: json!({
                "id": id,
                "result": {
                    "success": false,
                    "contentItems": [{ "type": "inputText", "text": error }]
                }
            }),
            receipt: None,
            workflow_receipt: None,
        }),
    })
}

pub(super) fn consolidate_task_receipts(
    receipts: Vec<TaskAuthoringReceipt>,
) -> Vec<TaskAuthoringReceipt> {
    let created = receipts
        .iter()
        .flat_map(|receipt| receipt.created.clone())
        .collect::<Vec<_>>();
    let updated = receipts
        .iter()
        .flat_map(|receipt| receipt.updated.clone())
        .collect::<Vec<_>>();
    let goals_created = receipts
        .iter()
        .flat_map(|receipt| receipt.goals_created.clone())
        .collect::<Vec<_>>();
    let goals_updated = receipts
        .into_iter()
        .flat_map(|receipt| receipt.goals_updated)
        .collect::<Vec<_>>();
    if created.is_empty()
        && updated.is_empty()
        && goals_created.is_empty()
        && goals_updated.is_empty()
    {
        Vec::new()
    } else {
        vec![TaskAuthoringReceipt {
            created,
            updated,
            goals_created,
            goals_updated,
        }]
    }
}
