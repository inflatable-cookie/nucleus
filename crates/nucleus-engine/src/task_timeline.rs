//! Engine-owned task timeline projection.

use nucleus_orchestration::{
    OrchestrationCommandFamily, OrchestrationEventKind, OrchestrationEventRecord,
    OrchestrationProjectionCursor,
};
use nucleus_tasks::TaskId;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskTimelineEntryId(pub String);

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskTimelineEntryKind {
    TaskCommandAdmitted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskTimelineSummary {
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskTimelineEntry {
    pub entry_id: EngineTaskTimelineEntryId,
    pub task_id: TaskId,
    pub kind: EngineTaskTimelineEntryKind,
    pub source_command_id: String,
    pub source_event_id: String,
    pub source_cursor: OrchestrationProjectionCursor,
    pub summary: EngineTaskTimelineSummary,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskTimelineProjection {
    pub task_id: TaskId,
    pub entries: Vec<EngineTaskTimelineEntry>,
    pub last_cursor: Option<OrchestrationProjectionCursor>,
}

impl EngineTaskTimelineProjection {
    pub fn rebuild<'a>(
        task_id: TaskId,
        events: impl IntoIterator<Item = &'a OrchestrationEventRecord>,
    ) -> Self {
        let mut entries = Vec::new();
        let mut last_cursor = None;

        for event in events {
            if !is_task_timeline_event(&task_id, event) {
                continue;
            }

            last_cursor = Some(event.projection_cursor.clone());
            entries.push(EngineTaskTimelineEntry {
                entry_id: EngineTaskTimelineEntryId(format!(
                    "timeline:{}:{}",
                    task_id.0, event.event_id.0
                )),
                task_id: task_id.clone(),
                kind: EngineTaskTimelineEntryKind::TaskCommandAdmitted,
                source_command_id: event.command_id.0.clone(),
                source_event_id: event.event_id.0.clone(),
                source_cursor: event.projection_cursor.clone(),
                summary: EngineTaskTimelineSummary {
                    text: format!("Task command admitted: {}", event.command_id.0),
                },
            });
        }

        Self {
            task_id,
            entries,
            last_cursor,
        }
    }
}

fn is_task_timeline_event(task_id: &TaskId, event: &OrchestrationEventRecord) -> bool {
    event.kind == OrchestrationEventKind::CommandAdmitted
        && event.family == OrchestrationCommandFamily::Task
        && event.target_ref.as_deref() == Some(task_id.0.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_orchestration::{
        OrchestrationCommandFamily, OrchestrationCommandId, OrchestrationEventId,
    };

    #[test]
    fn task_timeline_projection_rebuilds_task_command_events() {
        let events = vec![
            OrchestrationEventRecord::command_admitted(
                OrchestrationEventId("event:1".to_owned()),
                OrchestrationCommandId("command:start".to_owned()),
                OrchestrationCommandFamily::Task,
                Some("task:1".to_owned()),
            ),
            OrchestrationEventRecord::command_admitted(
                OrchestrationEventId("event:2".to_owned()),
                OrchestrationCommandId("command:project".to_owned()),
                OrchestrationCommandFamily::Project,
                Some("project:1".to_owned()),
            ),
            OrchestrationEventRecord::command_admitted(
                OrchestrationEventId("event:3".to_owned()),
                OrchestrationCommandId("command:other-task".to_owned()),
                OrchestrationCommandFamily::Task,
                Some("task:2".to_owned()),
            ),
        ];

        let projection =
            EngineTaskTimelineProjection::rebuild(TaskId("task:1".to_owned()), &events);
        let replayed = EngineTaskTimelineProjection::rebuild(TaskId("task:1".to_owned()), &events);

        assert_eq!(projection, replayed);
        assert_eq!(projection.entries.len(), 1);
        assert_eq!(projection.entries[0].source_command_id, "command:start");
        assert_eq!(
            projection.last_cursor.expect("cursor").source_event_id,
            "event:1"
        );
    }
}
