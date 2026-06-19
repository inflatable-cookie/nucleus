//! Projection cursor and deterministic read-model vocabulary.

use serde::{Deserialize, Serialize};

use crate::commands::OrchestrationCommandFamily;
use crate::events::{OrchestrationEventKind, OrchestrationEventRecord};

/// Cursor for a projection advanced by an orchestration event.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OrchestrationProjectionCursor {
    pub projection_id: String,
    pub source_event_id: String,
}

/// Projection over admitted commands.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommandAdmissionProjection {
    pub admitted_total: usize,
    pub task_commands: usize,
    pub last_cursor: Option<OrchestrationProjectionCursor>,
}

impl CommandAdmissionProjection {
    pub fn rebuild<'a>(events: impl IntoIterator<Item = &'a OrchestrationEventRecord>) -> Self {
        let mut projection = Self::default();

        for event in events {
            if event.kind != OrchestrationEventKind::CommandAdmitted {
                continue;
            }

            projection.admitted_total += 1;
            if event.family == OrchestrationCommandFamily::Task {
                projection.task_commands += 1;
            }
            projection.last_cursor = Some(event.projection_cursor.clone());
        }

        projection
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        OrchestrationCommandFamily, OrchestrationCommandId, OrchestrationEventId,
        OrchestrationEventRecord,
    };

    #[test]
    fn command_admission_projection_rebuilds_from_events() {
        let events = vec![
            OrchestrationEventRecord::command_admitted(
                OrchestrationEventId("event:1".to_owned()),
                OrchestrationCommandId("command:1".to_owned()),
                OrchestrationCommandFamily::Task,
                Some("task:1".to_owned()),
            ),
            OrchestrationEventRecord::command_admitted(
                OrchestrationEventId("event:2".to_owned()),
                OrchestrationCommandId("command:2".to_owned()),
                OrchestrationCommandFamily::Project,
                Some("project:1".to_owned()),
            ),
            OrchestrationEventRecord::runtime_observation_accepted(
                OrchestrationEventId("event:runtime:1".to_owned()),
                OrchestrationCommandId("command:runtime:1".to_owned()),
                Some("binding:1".to_owned()),
            ),
        ];

        let projection = CommandAdmissionProjection::rebuild(&events);

        assert_eq!(projection.admitted_total, 2);
        assert_eq!(projection.task_commands, 1);
        assert_eq!(
            projection.last_cursor,
            Some(OrchestrationProjectionCursor {
                projection_id: "projection:command-admission".to_owned(),
                source_event_id: "event:2".to_owned(),
            })
        );
    }
}
