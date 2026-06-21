//! Compile-only Codex app-server supervision boundary.
//!
//! These records describe whether Nucleus may consider starting a Codex
//! app-server process. They do not spawn Codex, open stdio, probe auth, read
//! provider payloads, or ingest live events.

mod callback_request;
mod callback_request_persistence;
mod callback_response_admission;
mod callback_response_durable_linkage;
mod callback_response_envelope;
mod callback_response_execution_policy;
mod callback_response_execution_receipt_linkage;
mod callback_response_executor_admission;
mod callback_response_outcome;
mod callback_response_reactor;
mod decode_outcome_persistence;
mod event_store_linkage;
mod exports;
mod handshake;
mod idempotency;
mod interruption_admission;
mod interruption_envelope;
mod interruption_execution_policy;
mod interruption_execution_receipt_linkage;
mod interruption_executor_admission;
mod interruption_outcome;
mod interruption_outcome_persistence;
mod interruption_request;
mod live_executor_outcome;
mod live_executor_outcome_persistence;
mod live_ingestion;
mod live_send_preflight;
mod live_send_smoke_boundary;
mod live_spawn_smoke_evidence;
mod live_spawn_smoke_request;
mod live_spawn_smoke_runner;
mod readiness;
mod recovery_admission;
mod recovery_envelope;
mod recovery_execution_policy;
mod recovery_execution_receipt_linkage;
mod recovery_executor_admission;
mod recovery_need;
mod recovery_outcome;
mod recovery_outcome_persistence;
mod runtime_instance;
mod runtime_observation_event_identity;
mod runtime_observation_event_store_persistence;
mod runtime_observation_ingestion_cursor;
mod runtime_observation_replay_projection;
mod session_binding;
mod spawn_intent;
mod stdio_frame_ingestion_persistence;
mod stdio_frames;
mod task_backed_live_execution_policy;
mod task_work_live_executor_admission;
mod task_work_live_executor_receipt_linkage;
#[cfg(test)]
pub(crate) mod test_support;
mod transport_executor_authority;
mod transport_receipts;
mod turn_start_admission;
mod turn_start_envelope;
mod turn_start_executor_smoke_boundary;
mod turn_start_live_send_receipts;
mod turn_start_outcome;
mod turn_start_reactor;
mod turn_start_request;
mod turn_start_send_command;
mod turn_start_send_receipts;
mod turn_start_stdio_execution_envelope;
mod turn_start_subscription;
mod turn_start_transport_execution_persistence;

pub use exports::*;

#[cfg(test)]
mod tests;
