use serde::{Deserialize, Serialize};

use nucleus_engine::{EngineRunFleetEntry, EngineRunLifecycleState, EngineRunStateCount};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlOrchestrationRunSummaryDto {
    pub run_id: String,
    pub state: String,
    pub provider_instance: String,
    pub provider_model: String,
    pub orchestrator_designation: Option<String>,
    #[ts(as = "u64")]
    pub updated_at: u64,
    pub has_closeout: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlOrchestrationRunStateCountDto {
    pub state: String,
    #[ts(as = "u32")]
    pub count: usize,
}

impl From<&EngineRunFleetEntry> for ControlOrchestrationRunSummaryDto {
    fn from(run: &EngineRunFleetEntry) -> Self {
        Self {
            run_id: run.run_id.clone(),
            state: state_dto(&run.state),
            provider_instance: run.provider_instance.clone(),
            provider_model: run.provider_model.clone(),
            orchestrator_designation: run.orchestrator_designation.clone(),
            updated_at: run.updated_at,
            has_closeout: run.has_closeout,
        }
    }
}

impl From<&EngineRunStateCount> for ControlOrchestrationRunStateCountDto {
    fn from(count: &EngineRunStateCount) -> Self {
        Self {
            state: state_dto(&count.state),
            count: count.count,
        }
    }
}

fn state_dto(state: &EngineRunLifecycleState) -> String {
    match state {
        EngineRunLifecycleState::Proposed => "proposed",
        EngineRunLifecycleState::Dispatched => "dispatched",
        EngineRunLifecycleState::Running => "running",
        EngineRunLifecycleState::Delivered => "delivered",
        EngineRunLifecycleState::Accepted => "accepted",
        EngineRunLifecycleState::Rejected => "rejected",
        EngineRunLifecycleState::Failed => "failed",
        EngineRunLifecycleState::Cancelled => "cancelled",
    }
    .to_owned()
}
