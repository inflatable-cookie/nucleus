//! Event envelope and append-only identity vocabulary.

use serde::{Deserialize, Serialize};

use crate::commands::{OrchestrationCommandFamily, OrchestrationCommandId};
use crate::projections::OrchestrationProjectionCursor;

/// Stable orchestration event id.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OrchestrationEventId(pub String);

/// Orchestration event kind.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrationEventKind {
    CommandAdmitted,
}

/// First event-journal payload for orchestration events.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OrchestrationEventRecord {
    pub event_id: OrchestrationEventId,
    pub kind: OrchestrationEventKind,
    pub command_id: OrchestrationCommandId,
    pub family: OrchestrationCommandFamily,
    pub target_ref: Option<String>,
    pub projection_cursor: OrchestrationProjectionCursor,
}

impl OrchestrationEventRecord {
    pub fn command_admitted(
        event_id: OrchestrationEventId,
        command_id: OrchestrationCommandId,
        family: OrchestrationCommandFamily,
        target_ref: Option<String>,
    ) -> Self {
        let projection_cursor = OrchestrationProjectionCursor {
            projection_id: "projection:command-admission".to_owned(),
            source_event_id: event_id.0.clone(),
        };

        Self {
            event_id,
            kind: OrchestrationEventKind::CommandAdmitted,
            command_id,
            family,
            target_ref,
            projection_cursor,
        }
    }
}

pub fn encode_orchestration_event_record(
    record: &OrchestrationEventRecord,
) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(record)
}

pub fn decode_orchestration_event_record(
    bytes: &[u8],
) -> Result<OrchestrationEventRecord, serde_json::Error> {
    serde_json::from_slice(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_admitted_event_round_trips_with_projection_cursor() {
        let record = OrchestrationEventRecord::command_admitted(
            OrchestrationEventId("event:command:1".to_owned()),
            OrchestrationCommandId("command:1".to_owned()),
            OrchestrationCommandFamily::Task,
            Some("task:1".to_owned()),
        );

        let bytes = encode_orchestration_event_record(&record).expect("encode event");
        let decoded = decode_orchestration_event_record(&bytes).expect("decode event");

        assert_eq!(decoded, record);
        assert_eq!(decoded.projection_cursor.source_event_id, "event:command:1");
    }
}
