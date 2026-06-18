//! Task-backed agent work-unit source model.

mod admission;
mod diagnostics;
mod projection;
mod types;

#[cfg(test)]
mod tests;

pub use admission::admit_task_agent_work_unit;
pub use diagnostics::{task_agent_work_unit_diagnostics, EngineTaskAgentWorkUnitDiagnostics};
pub use projection::{
    project_task_agent_work_units, EngineTaskAgentWorkUnitProjection,
    EngineTaskAgentWorkUnitProjectionIssue,
};
pub use types::{
    EngineTaskAgentWorkUnitAdmissionRecord, EngineTaskAgentWorkUnitReviewStatus,
    EngineTaskAgentWorkUnitRuntimeStatus, EngineTaskAgentWorkUnitSourceCursor,
    EngineTaskAgentWorkUnitSourceId, EngineTaskAgentWorkUnitSourceRecord,
};
