//! Goal run admission and inspection: mandate-backed serial task execution
//! plans over the ordered task snapshot.
//!
//! Module index over the goal run surface: wire types, inspection, admission,
//! and the durable plan store.

mod admit;
mod inspect;
mod plan_store;
mod types;
#[cfg(test)]
pub(super) mod tests;

pub use admit::admit_goal_run;
pub use inspect::inspect_goal_run;
pub use plan_store::read_goal_run_plan;
pub use types::{
    GoalRunAdmissionRequest, GoalRunBlocker, GoalRunInspection, GoalRunOutcome, GoalRunPlan,
    GoalRunPlanTask, GoalRunRoute, GoalRunTaskInspection,
};
