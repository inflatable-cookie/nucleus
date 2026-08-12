//! Workflow mandate creation: operator-message authority validation, scope
//! freeze, and the durable active mandate write.
//!
//! Split from the mandates god file; behavior unchanged.

use nucleus_local_store::{LocalStoreBackend, RevisionExpectation};

use super::store::{now_epoch_seconds, put_mandate, require_nonempty};
use super::types::{
    WorkflowMandate, WorkflowMandateAdmission, WorkflowMandateScope, WorkflowMandateStatus,
    WorkflowMandateTaskSnapshot,
};
use super::super::goal_inspection::goal_record;
use super::super::persistence::{
    current_turn, read_message, read_session, ChatMessageRole,
};
use super::super::task_inspection::active_task;
use crate::ServerStateService;

const MAX_GOAL_TASKS: usize = 50;

pub fn create_workflow_mandate<B>(
    state: &ServerStateService<B>,
    admission: WorkflowMandateAdmission,
) -> Result<WorkflowMandate, String>
where
    B: LocalStoreBackend,
{
    require_nonempty("mandate id", &admission.mandate_id)?;
    require_nonempty("idempotency key", &admission.idempotency_key)?;
    let excerpt = admission.operator_message_excerpt.trim();
    require_nonempty("operator message excerpt", excerpt)?;

    let now = now_epoch_seconds()?;
    if admission.expires_at_epoch_seconds <= now {
        return Err("goal mandate expiry must be in the future".to_owned());
    }
    let session = read_session(state, &admission.conversation_id)?
        .ok_or_else(|| "goal mandate conversation has no durable chat session".to_owned())?;
    if session.project_id != admission.project_id {
        return Err("goal mandate conversation belongs to another project".to_owned());
    }
    let turn = current_turn(state, &admission.conversation_id)?;
    if turn.status != "started" {
        return Err("goal mandate source must be the current in-progress operator turn".to_owned());
    }
    let message = read_message(state, &admission.operator_message_id)?;
    if message.conversation_id != admission.conversation_id
        || message.turn_id != turn.turn_id
        || message.role != ChatMessageRole::User
    {
        return Err("goal mandate must cite the current canonical operator message".to_owned());
    }
    if !message.text.contains(excerpt) {
        return Err(
            "goal mandate excerpt does not occur exactly in the operator message".to_owned(),
        );
    }

    let ordered_task_snapshot = match &admission.scope {
        WorkflowMandateScope::Goal {
            goal_id,
            goal_revision,
        } => {
            let goal = goal_record(state, &admission.project_id, goal_id)?;
            if goal.revision_id != *goal_revision {
                return Err("goal mandate cites a stale Goal revision".to_owned());
            }
            if goal.ordered_task_refs.len() > MAX_GOAL_TASKS {
                return Err(format!(
                    "goal mandate accepts at most {MAX_GOAL_TASKS} ordered tasks"
                ));
            }
            goal.ordered_task_refs
                .iter()
                .map(|task_id| {
                    active_task(state, &admission.project_id, task_id).map(|task| {
                        WorkflowMandateTaskSnapshot {
                            task_id: task.task_id,
                            revision_id: task.revision_id,
                        }
                    })
                })
                .collect::<Result<Vec<_>, _>>()?
        }
        WorkflowMandateScope::Task {
            task_id,
            task_revision,
        } => {
            let task = active_task(state, &admission.project_id, task_id)?;
            if task.revision_id != *task_revision {
                return Err("task mandate cites a stale task revision".to_owned());
            }
            vec![WorkflowMandateTaskSnapshot {
                task_id: task.task_id,
                revision_id: task.revision_id,
            }]
        }
    };
    let revision_id = format!("rev:{}:active", admission.mandate_id);
    let mandate = WorkflowMandate {
        mandate_id: admission.mandate_id,
        conversation_id: admission.conversation_id,
        source_turn_id: turn.turn_id,
        operator_message_id: admission.operator_message_id,
        operator_message_excerpt: excerpt.to_owned(),
        project_id: admission.project_id,
        scope: admission.scope,
        ordered_task_snapshot,
        idempotency_key: admission.idempotency_key,
        status: WorkflowMandateStatus::Active,
        created_at_epoch_seconds: now,
        expires_at_epoch_seconds: admission.expires_at_epoch_seconds,
        terminal_reason: None,
        outcome_refs: Vec::new(),
        revision_id,
    };
    put_mandate(state, &mandate, RevisionExpectation::MustNotExist)?;
    Ok(mandate)
}
