//! Engine-owned orchestration run command service.
//!
//! The run aggregate (contract 033 Run Record Rule) rides the contract-018
//! spine: commands mutate the durable run record, the spine event journal
//! records each admitted command, and runtime receipts record each transition
//! as effect evidence.

mod helpers;
mod model;
mod service;

#[cfg(test)]
mod tests;

pub use model::{
    decode_run_storage_record, encode_run_storage_payload, encode_run_storage_record,
    EngineRunBudgetEnvelope, EngineRunCloseout, EngineRunCommand, EngineRunCommandError,
    EngineRunCommandOutcome, EngineRunDeliverCommand, EngineRunDispatchCommand, EngineRunId,
    EngineRunLifecycleState, EngineRunObjective, EngineRunProposeCommand, EngineRunRecord,
    EngineRunRecordCodecError, EngineRunRepository, EngineRunStorageRecord,
    EngineRunTransitionCommand, EngineRunTransitionRecord,
};
pub use service::EngineRunCommandService;
