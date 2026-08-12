//! Goal run plan persistence: durable plan records under the plan prefix.
//!
//! Split from the goal_run god file; behavior unchanged.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation,
};

use super::types::GoalRunPlan;
use crate::ServerStateService;

const PLAN_PREFIX: &str = "goal-run-plan:";

pub fn read_goal_run_plan<B>(
    state: &ServerStateService<B>,
    plan_id: &str,
) -> Result<Option<GoalRunPlan>, String>
where
    B: LocalStoreBackend,
{
    state
        .agent_sessions()
        .get(&PersistenceRecordId(format!("{PLAN_PREFIX}{plan_id}")))
        .map_err(storage_error)?
        .map(|record| {
            serde_json::from_slice(&record.payload.bytes).map_err(|error| error.to_string())
        })
        .transpose()
}

pub(super) fn persist_plan<B>(
    state: &ServerStateService<B>,
    plan: &GoalRunPlan,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let bytes = serde_json::to_vec(plan).map_err(|error| error.to_string())?;
    state
        .agent_sessions()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(format!("{PLAN_PREFIX}{}", plan.plan_id)),
                revision_id: RevisionId(plan.revision_id.clone()),
                domain: PersistenceDomain::AgentSessions,
                kind: PersistenceRecordKind::AgentSession,
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes,
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .map(|_| ())
        .map_err(storage_error)
}

fn storage_error(error: impl std::fmt::Debug) -> String {
    format!("goal run persistence failed: {error:?}")
}
