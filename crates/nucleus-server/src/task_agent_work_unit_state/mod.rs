//! Persistence helpers for task-backed agent work-unit source records.
//!
//! Source facts are stored in task history as sanitized JSON. Raw provider
//! payloads, terminal streams, stdout, and stderr are rejected at this boundary.

mod codec;
mod persistence;
mod transitions;
mod validation;

#[cfg(test)]
mod tests;

pub use persistence::{
    read_task_agent_work_unit_source_records, write_task_agent_work_unit_source_record,
};
