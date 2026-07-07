//! Selected-task route admission proof.

mod builder;
#[cfg(test)]
mod tests;
mod types;

pub use builder::{
    selected_task_completion_route_admission, selected_task_rework_delegation_route_admission,
    selected_task_route_admission,
};
pub use types::*;
