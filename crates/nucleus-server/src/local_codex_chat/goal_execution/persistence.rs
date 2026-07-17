//! Split from the goal_execution god file; behavior unchanged.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use super::{dispatch::*, outcome::*, rules::*, run_loop::*};
#[allow(unused_imports)]
use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation,
};

use super::super::goal_run::GoalRunPlan;
use super::super::mandates::{expire_workflow_mandate, read_workflow_mandate, WorkflowMandateStatus};
use crate::ServerStateService;

pub(super) fn update_execution<B>(
    state: &ServerStateService<B>,
    execution: &mut GoalRunExecutionRecord,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let previous = RevisionId(execution.revision_id.clone());
    let next = execution
        .revision_id
        .rsplit_once(':')
        .and_then(|(_, value)| value.parse::<u64>().ok())
        .unwrap_or(0)
        + 1;
    execution.revision_id = format!("rev:{}:{next}", execution.plan_id);
    persist_execution(state, execution, RevisionExpectation::Exact(previous))
}

pub(super) fn stop_execution<B>(
    state: &ServerStateService<B>,
    plan: &GoalRunPlan,
    execution: &mut GoalRunExecutionRecord,
    reason: String,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    execution.status = GoalRunExecutionStatus::Stopped;
    execution.terminal_reason = Some(reason);
    update_execution(state, execution)?;
    expire_for_execution(state, plan, execution)
}

pub(super) fn persist_execution<B>(
    state: &ServerStateService<B>,
    execution: &GoalRunExecutionRecord,
    expectation: RevisionExpectation,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let bytes = serde_json::to_vec(execution).map_err(|error| error.to_string())?;
    state
        .agent_sessions()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(format!("{EXECUTION_PREFIX}{}", execution.plan_id)),
                revision_id: RevisionId(execution.revision_id.clone()),
                domain: PersistenceDomain::AgentSessions,
                kind: PersistenceRecordKind::AgentSession,
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes,
                },
            },
            expectation,
        )
        .map(|_| ())
        .map_err(|error| format!("goal run execution persistence failed: {error:?}"))
}

pub(super) fn read_execution<B>(
    state: &ServerStateService<B>,
    plan_id: &str,
) -> Result<Option<GoalRunExecutionRecord>, String>
where
    B: LocalStoreBackend,
{
    state
        .agent_sessions()
        .get(&PersistenceRecordId(format!("{EXECUTION_PREFIX}{plan_id}")))
        .map_err(|error| format!("goal run execution lookup failed: {error:?}"))?
        .map(|record| {
            serde_json::from_slice(&record.payload.bytes).map_err(|error| error.to_string())
        })
        .transpose()
}

pub(super) fn expire_for_execution<B>(
    state: &ServerStateService<B>,
    plan: &GoalRunPlan,
    execution: &GoalRunExecutionRecord,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let mandate = read_workflow_mandate(state, &plan.mandate_id)?;
    if mandate.status != WorkflowMandateStatus::Active {
        return Ok(());
    }
    expire_workflow_mandate(
        state,
        &plan.mandate_id,
        &plan.mandate_revision,
        execution
            .terminal_reason
            .as_deref()
            .unwrap_or("Goal run reached a terminal execution outcome."),
        vec![execution.execution_id.clone()],
    )
    .map(|_| ())
}

pub(super) fn now_epoch_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "system clock is before the Unix epoch".to_owned())
}
