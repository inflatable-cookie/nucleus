//! Event-sourced orchestration mechanics for Nucleus.
//!
//! This crate owns host-independent command, event, projection, replay, and
//! receipt vocabulary. It does not own product domain behavior, provider
//! adapters, host transports, process spawning, or UI DTOs.

pub mod commands;
pub mod event_store;
pub mod events;
pub mod host_identity;
pub mod projections;
pub mod runtime_effect_events;
pub mod runtime_effect_replay;
pub mod runtime_effect_retention;
pub mod runtime_effect_storage;
pub mod runtime_effect_subscriptions;
pub mod runtime_effect_transport;

pub use commands::{
    OrchestrationAcceptedCommand, OrchestrationCommandAdmission,
    OrchestrationCommandAdmissionService, OrchestrationCommandDecision, OrchestrationCommandFamily,
    OrchestrationCommandId, OrchestrationCommandRejection, OrchestrationCommandRejectionReason,
};
pub use event_store::{
    decode_orchestration_event_store_record, encode_orchestration_event_store_record,
    EventPayloadSchemaVersion, EventStoreCodecError, EventStoreCursor, EventStreamRef,
    OrchestrationEventStoreRecord, OrchestrationEventStoreRepository,
};
pub use events::{
    decode_orchestration_event_record, encode_orchestration_event_record, OrchestrationEventId,
    OrchestrationEventKind, OrchestrationEventRecord,
};
pub use projections::{CommandAdmissionProjection, OrchestrationProjectionCursor};
