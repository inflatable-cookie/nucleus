//! Provider command reactor records.
//!
//! These records describe command admission, queueing, dispatch attempts, and
//! outcomes before live provider send exists. They do not write to provider
//! transports or mutate task state.

mod admission;
mod dispatch;
mod outcome;
#[cfg(test)]
mod tests;
mod types;

pub use admission::admit_provider_command;
pub use dispatch::{provider_command_dispatch_attempt, queue_provider_command};
pub use outcome::{
    provider_command_reactor_outcome, provider_runtime_outcome_from_reactor_outcome,
};
pub use types::{
    ProviderCommandAdmissionBlocker, ProviderCommandAdmissionId, ProviderCommandAdmissionInput,
    ProviderCommandAdmissionRecord, ProviderCommandAdmissionStatus, ProviderCommandCapabilityState,
    ProviderCommandDispatchAttemptId, ProviderCommandDispatchAttemptRecord,
    ProviderCommandDispatchAttemptStatus, ProviderCommandDispatchMode, ProviderCommandId,
    ProviderCommandQueueEntryId, ProviderCommandQueueState, ProviderCommandReactorError,
    ProviderCommandReactorId, ProviderCommandReactorOutcomeId, ProviderCommandReactorOutcomeRecord,
    ProviderCommandReactorOutcomeStatus, ProviderCommandRequester, ProviderQueuedCommandRecord,
};
