//! Durable provider executor dispatch admission records.
//!
//! These records gate a selected durable executor command before any executor
//! call can happen. Admission remains execution-free and authority-free.

mod blockers;
mod helpers;
mod record_builder;
#[cfg(test)]
mod tests;
mod types;

pub use record_builder::durable_provider_executor_dispatch_admission;
pub use types::{
    DurableProviderExecutorDispatchAdmissionBlocker, DurableProviderExecutorDispatchAdmissionId,
    DurableProviderExecutorDispatchAdmissionInput, DurableProviderExecutorDispatchAdmissionRecord,
    DurableProviderExecutorDispatchAdmissionStatus,
};
