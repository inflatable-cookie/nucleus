use super::projection::{project_task_agent_work_units, EngineTaskAgentWorkUnitProjection};
use super::types::EngineTaskAgentWorkUnitSourceRecord;

/// Engine-level diagnostics for task-agent work-unit source records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskAgentWorkUnitDiagnostics {
    pub projections: Vec<EngineTaskAgentWorkUnitProjection>,
    pub source_count: usize,
    pub source_status: String,
    pub provider_execution_available: bool,
}

pub fn task_agent_work_unit_diagnostics(
    records: &[EngineTaskAgentWorkUnitSourceRecord],
) -> EngineTaskAgentWorkUnitDiagnostics {
    EngineTaskAgentWorkUnitDiagnostics {
        projections: project_task_agent_work_units(records),
        source_count: records.len(),
        source_status: if records.is_empty() {
            "empty".to_owned()
        } else {
            "records".to_owned()
        },
        provider_execution_available: false,
    }
}
