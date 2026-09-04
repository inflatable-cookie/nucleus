//! Split from the local_codex_chat persistence god file; behavior unchanged.

use super::*;

use nucleus_agent_protocol::AgentActivityEvent;
use nucleus_local_store::SqliteBackend;
use swallowtail_core::ProviderActivityRef;
use swallowtail_runtime::{
    ActivityActor, ActivityContent, ActivityContentChangeKind, ActivityContentStream,
    ActivityContentUpdate, ActivityDisclosure, ActivityId, ActivityKind, ActivityLabel,
    ActivityLifecyclePhase, ActivityObservation, ActivityOperationId, ActivityStatus,
    OperationContent, RuntimeRunId, SubagentId, SubagentParent, SubagentSnapshot, SubagentStatus,
    TaskListItem, TaskListItemPriority, TaskListItemStatus, TaskListSnapshot,
};

#[test]
fn activity_projection_preserves_portable_reasoning_summary_evidence() {
    let observation = ActivityObservation::new(
        ActivityId::new("reasoning:1").expect("activity id"),
        ActivityOperationId::Run(RuntimeRunId::new("run:1").expect("run id")),
        ActivityKind::ReasoningSummary,
        ActivityLifecyclePhase::Updated,
        ActivityStatus::InProgress,
        None,
        ActivityDisclosure::ProviderDisplayContent,
    )
    .expect("observation")
    .with_label(ActivityLabel::new("Reasoning summary").expect("label"))
    .expect("label is valid")
    .with_content(ActivityContentUpdate::new(
        ActivityContentChangeKind::Delta,
        ActivityContentStream::ReasoningSummaryText,
        ActivityContent::new(
            OperationContent::new("Checking the workspace").expect("content"),
            128,
        )
        .expect("bounded content"),
    ))
    .expect("content is valid");

    let activity = project_activity(
        "conversation:1",
        "turn:1",
        1,
        AgentActivityEvent::new(7, observation),
    );

    assert_eq!(activity.kind, "reasoning_summary");
    assert_eq!(activity.kind_namespace, None);
    assert_eq!(activity.lifecycle, "updated");
    assert_eq!(activity.status, "in_progress");
    assert_eq!(activity.label.as_deref(), Some("Reasoning summary"));
    assert_eq!(activity.content_change.as_deref(), Some("delta"));
    assert_eq!(
        activity.content_stream.as_deref(),
        Some("reasoning_summary_text")
    );
    assert_eq!(activity.content.as_deref(), Some("Checking the workspace"));
    assert_eq!(activity.runtime_operation_id, "run:run:1");
    assert_eq!(activity.sequence, 7);

    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    persist_activity(&state, &activity).expect("persist activity");
    let history =
        read_history(&state, "project:1", "conversation:1").expect("read activity history");
    assert_eq!(history.activities, vec![activity]);
}

#[test]
fn activity_projection_preserves_host_watcher_kind() {
    let observation = ActivityObservation::new(
        ActivityId::new("watcher:1").expect("activity id"),
        ActivityOperationId::Run(RuntimeRunId::new("run:1").expect("run id")),
        ActivityKind::HostWatcher,
        ActivityLifecyclePhase::Updated,
        ActivityStatus::InProgress,
        None,
        ActivityDisclosure::IdentityAndLifecycleOnly,
    )
    .expect("observation");

    let activity = project_activity(
        "conversation:1",
        "turn:1",
        1,
        AgentActivityEvent::new(8, observation),
    );

    assert_eq!(activity.kind, "host_watcher");
    assert_eq!(activity.kind_namespace, None);
}

#[test]
fn activity_projection_upserts_by_portable_key_and_separates_operations() {
    let observation = |operation: &str,
                       phase: ActivityLifecyclePhase,
                       status: ActivityStatus| {
        ActivityObservation::new(
            ActivityId::new("provider-item:shared").expect("activity id"),
            ActivityOperationId::Run(
                RuntimeRunId::new(operation).expect("runtime operation id"),
            ),
            ActivityKind::CommandExecution,
            phase,
            status,
            None,
            ActivityDisclosure::IdentityAndLifecycleOnly,
        )
        .expect("activity observation")
        .with_provider_activity_ref(
            ProviderActivityRef::new("provider-item:shared").expect("provider activity ref"),
        )
    };
    let first_started = project_activity(
        "conversation:1",
        "turn:1",
        1,
        AgentActivityEvent::new(
            1,
            observation(
                "operation:one",
                ActivityLifecyclePhase::Started,
                ActivityStatus::InProgress,
            ),
        ),
    );
    let first_completed = project_activity(
        "conversation:1",
        "turn:1",
        1,
        AgentActivityEvent::new(
            2,
            observation(
                "operation:one",
                ActivityLifecyclePhase::Completed,
                ActivityStatus::Completed,
            ),
        ),
    );
    let second_started = project_activity(
        "conversation:1",
        "turn:1",
        1,
        AgentActivityEvent::new(
            3,
            observation(
                "operation:two",
                ActivityLifecyclePhase::Started,
                ActivityStatus::InProgress,
            ),
        ),
    );

    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    persist_activity(&state, &first_started).expect("persist first start");
    persist_activity(&state, &first_completed).expect("upsert first completion");
    persist_activity(&state, &second_started).expect("persist second operation");

    let history =
        read_history(&state, "project:1", "conversation:1").expect("read activity history");
    assert_eq!(history.activities.len(), 2);
    assert_eq!(history.activities[0], first_completed);
    assert_eq!(history.activities[1], second_started);
    assert_eq!(
        history.activities[0].activity_id,
        history.activities[1].activity_id
    );
    assert_ne!(
        history.activities[0].runtime_operation_id,
        history.activities[1].runtime_operation_id
    );
}

#[test]
fn activity_projection_preserves_task_list_actor_and_subagent_structure() {
    let child_id = SubagentId::new("child-1").expect("child id");
    let plan_observation = ActivityObservation::new(
        ActivityId::new("plan:1").expect("activity id"),
        ActivityOperationId::Run(RuntimeRunId::new("run:1").expect("run id")),
        ActivityKind::Plan,
        ActivityLifecyclePhase::Updated,
        ActivityStatus::InProgress,
        None,
        ActivityDisclosure::ProviderDisplayContent,
    )
    .expect("observation")
    .with_task_list(
        TaskListSnapshot::new(
            [
                TaskListItem::new(
                    OperationContent::new("Inspect").expect("content"),
                    TaskListItemStatus::Completed,
                )
                .with_priority(TaskListItemPriority::High),
                TaskListItem::new(
                    OperationContent::new("Apply").expect("content"),
                    TaskListItemStatus::InProgress,
                ),
            ],
            4,
            1024,
        )
        .expect("task list"),
    )
    .expect("task list accepted")
    .with_actor(ActivityActor::Subagent(child_id.clone()));

    let plan_activity = project_activity(
        "conversation:1",
        "turn:1",
        1,
        AgentActivityEvent::new(9, plan_observation),
    );

    assert_eq!(plan_activity.actor_kind, "subagent");
    assert_eq!(plan_activity.actor_id.as_deref(), Some("child-1"));
    assert_eq!(
        plan_activity.task_list.as_ref().expect("task list")[0].status,
        "completed"
    );
    assert_eq!(
        plan_activity.task_list.as_ref().expect("task list")[0]
            .priority
            .as_deref(),
        Some("high")
    );

    let collaboration_observation = ActivityObservation::new(
        ActivityId::new("collaboration:1").expect("activity id"),
        ActivityOperationId::Run(RuntimeRunId::new("run:1").expect("run id")),
        ActivityKind::SubagentOrCollaboration,
        ActivityLifecyclePhase::Updated,
        ActivityStatus::InProgress,
        None,
        ActivityDisclosure::ProviderDisplayContent,
    )
    .expect("observation")
    .with_subagents([SubagentSnapshot::new(
        child_id,
        SubagentParent::Unknown,
        SubagentStatus::Running,
    )])
    .expect("subagent");
    let collaboration_activity = project_activity(
        "conversation:1",
        "turn:1",
        2,
        AgentActivityEvent::new(10, collaboration_observation),
    );

    assert_eq!(collaboration_activity.subagents[0].parent_kind, "unknown");
    assert_eq!(collaboration_activity.subagents[0].status, "running");

    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    persist_activity(&state, &plan_activity).expect("persist plan activity");
    persist_activity(&state, &collaboration_activity).expect("persist collaboration activity");
    let history =
        read_history(&state, "project:1", "conversation:1").expect("read activity history");
    assert_eq!(
        history.activities,
        vec![plan_activity, collaboration_activity]
    );
}
