//! Storage-facing envelope for orchestration event records.

use serde::{Deserialize, Serialize};

use crate::commands::OrchestrationCommandId;
use crate::events::{OrchestrationEventId, OrchestrationEventKind, OrchestrationEventRecord};
use crate::projections::OrchestrationProjectionCursor;

/// Stream identity for ordered orchestration events.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EventStreamRef(pub String);

/// Backend-independent event cursor.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EventStoreCursor(pub String);

/// Payload schema version for event-store decoding.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EventPayloadSchemaVersion(pub u16);

/// Event-store envelope persisted by host storage adapters.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OrchestrationEventStoreRecord {
    pub event_id: OrchestrationEventId,
    pub stream_ref: EventStreamRef,
    pub cursor: EventStoreCursor,
    pub command_id: OrchestrationCommandId,
    pub kind: OrchestrationEventKind,
    pub target_ref: Option<String>,
    pub payload_schema_version: EventPayloadSchemaVersion,
    pub projection_cursor: OrchestrationProjectionCursor,
    pub payload: OrchestrationEventRecord,
}

pub trait OrchestrationEventStoreRepository {
    type Error;

    fn append_event(&self, record: OrchestrationEventStoreRecord) -> Result<(), Self::Error>;

    fn list_events(&self) -> Result<Vec<OrchestrationEventStoreRecord>, Self::Error>;
}

impl OrchestrationEventStoreRecord {
    pub const CURRENT_PAYLOAD_SCHEMA_VERSION: EventPayloadSchemaVersion =
        EventPayloadSchemaVersion(1);

    pub fn from_event(stream_ref: EventStreamRef, payload: OrchestrationEventRecord) -> Self {
        let cursor = EventStoreCursor(payload.event_id.0.clone());

        Self {
            event_id: payload.event_id.clone(),
            stream_ref,
            cursor,
            command_id: payload.command_id.clone(),
            kind: payload.kind.clone(),
            target_ref: payload.target_ref.clone(),
            payload_schema_version: Self::CURRENT_PAYLOAD_SCHEMA_VERSION,
            projection_cursor: payload.projection_cursor.clone(),
            payload,
        }
    }

    pub fn into_payload(self) -> OrchestrationEventRecord {
        self.payload
    }

    fn validate(&self) -> Result<(), EventStoreCodecError> {
        if self.event_id != self.payload.event_id {
            return Err(EventStoreCodecError::EnvelopeMismatch(
                "event id does not match payload".to_owned(),
            ));
        }
        if self.command_id != self.payload.command_id {
            return Err(EventStoreCodecError::EnvelopeMismatch(
                "command id does not match payload".to_owned(),
            ));
        }
        if self.kind != self.payload.kind {
            return Err(EventStoreCodecError::EnvelopeMismatch(
                "event kind does not match payload".to_owned(),
            ));
        }
        if self.target_ref != self.payload.target_ref {
            return Err(EventStoreCodecError::EnvelopeMismatch(
                "target ref does not match payload".to_owned(),
            ));
        }
        if self.projection_cursor != self.payload.projection_cursor {
            return Err(EventStoreCodecError::EnvelopeMismatch(
                "projection cursor does not match payload".to_owned(),
            ));
        }

        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EventStoreCodecError {
    Json(String),
    EnvelopeMismatch(String),
}

impl std::fmt::Display for EventStoreCodecError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(error) => write!(formatter, "event-store json codec error: {error}"),
            Self::EnvelopeMismatch(reason) => {
                write!(formatter, "event-store envelope mismatch: {reason}")
            }
        }
    }
}

impl std::error::Error for EventStoreCodecError {}

pub fn encode_orchestration_event_store_record(
    record: &OrchestrationEventStoreRecord,
) -> Result<Vec<u8>, EventStoreCodecError> {
    record.validate()?;
    serde_json::to_vec(record).map_err(|error| EventStoreCodecError::Json(error.to_string()))
}

pub fn decode_orchestration_event_store_record(
    bytes: &[u8],
) -> Result<OrchestrationEventStoreRecord, EventStoreCodecError> {
    let record: OrchestrationEventStoreRecord = serde_json::from_slice(bytes)
        .map_err(|error| EventStoreCodecError::Json(error.to_string()))?;
    record.validate()?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        OrchestrationCommandFamily, OrchestrationCommandId, OrchestrationEventId,
        OrchestrationEventRecord,
    };

    #[test]
    fn event_store_record_round_trips_with_envelope_fields() {
        let payload = OrchestrationEventRecord::command_admitted(
            OrchestrationEventId("event:1".to_owned()),
            OrchestrationCommandId("command:1".to_owned()),
            OrchestrationCommandFamily::Task,
            Some("task:1".to_owned()),
        );
        let record = OrchestrationEventStoreRecord::from_event(
            EventStreamRef("stream:task:task:1".to_owned()),
            payload.clone(),
        );

        let bytes = encode_orchestration_event_store_record(&record).expect("encode");
        let decoded = decode_orchestration_event_store_record(&bytes).expect("decode");

        assert_eq!(decoded, record);
        assert_eq!(decoded.payload_schema_version, EventPayloadSchemaVersion(1));
        assert_eq!(decoded.cursor, EventStoreCursor("event:1".to_owned()));
        assert_eq!(decoded.into_payload(), payload);
    }

    #[test]
    fn event_store_record_rejects_envelope_payload_mismatch() {
        let payload = OrchestrationEventRecord::command_admitted(
            OrchestrationEventId("event:1".to_owned()),
            OrchestrationCommandId("command:1".to_owned()),
            OrchestrationCommandFamily::Task,
            Some("task:1".to_owned()),
        );
        let mut record = OrchestrationEventStoreRecord::from_event(
            EventStreamRef("stream:task:1".to_owned()),
            payload,
        );
        record.command_id = OrchestrationCommandId("command:other".to_owned());

        let error = encode_orchestration_event_store_record(&record).expect_err("reject mismatch");

        assert!(matches!(error, EventStoreCodecError::EnvelopeMismatch(_)));
    }

    #[test]
    fn event_store_record_rejects_malformed_json() {
        let error = decode_orchestration_event_store_record(b"{not-json").expect_err("reject json");

        assert!(matches!(error, EventStoreCodecError::Json(_)));
    }
}
