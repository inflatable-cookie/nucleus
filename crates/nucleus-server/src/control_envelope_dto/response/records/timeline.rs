use serde::{Deserialize, Serialize};

/// Serializable task timeline entry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskTimelineEntryDto {
    pub entry_id: String,
    pub task_id: String,
    pub kind: String,
    pub source_command_id: String,
    pub source_event_id: String,
    pub source_projection_id: String,
    pub summary: String,
}
impl From<&nucleus_engine::EngineTaskTimelineEntry> for ControlTaskTimelineEntryDto {
    fn from(entry: &nucleus_engine::EngineTaskTimelineEntry) -> Self {
        Self {
            entry_id: entry.entry_id.0.clone(),
            task_id: entry.task_id.0.clone(),
            kind: match entry.kind {
                nucleus_engine::EngineTaskTimelineEntryKind::TaskCommandAdmitted => {
                    "task_command_admitted".to_owned()
                }
            },
            source_command_id: entry.source_command_id.clone(),
            source_event_id: entry.source_event_id.clone(),
            source_projection_id: entry.source_cursor.projection_id.clone(),
            summary: entry.summary.text.clone(),
        }
    }
}
