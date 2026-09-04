//! Split from the local_codex_chat persistence god file; behavior unchanged.

#[allow(unused_imports)]
use super::*;

use nucleus_agent_protocol::AgentActivityEvent;
use nucleus_local_store::LocalStoreBackend;
use swallowtail_runtime::{
    ActivityActor, ActivityAssistantPhase, ActivityContentChangeKind, ActivityContentStream,
    ActivityCorrelation, ActivityDisclosure, ActivityKind, ActivityLifecyclePhase, ActivityStatus,
    TaskListItemPriority, TaskListItemStatus,
};

use super::super::subagent_directory::{operation_id_string, project_subagent_snapshot};

pub fn project_activity(
    conversation_id: &str,
    turn_id: &str,
    turn_ordinal: u64,
    event: AgentActivityEvent,
) -> StoredChatActivity {
    let observation = event.observation;
    let activity_key = observation.key();
    let (correlation_kind, correlation_id) = match observation.correlation() {
        Some(ActivityCorrelation::Callback(id)) => {
            (Some("callback".to_owned()), Some(id.as_str().to_owned()))
        }
        Some(ActivityCorrelation::DirectToolCall(id)) => (
            Some("direct_tool_call".to_owned()),
            Some(id.as_str().to_owned()),
        ),
        Some(ActivityCorrelation::ProviderRequest(id)) => (
            Some("provider_request".to_owned()),
            Some(id.as_provider_value().to_owned()),
        ),
        None => (None, None),
    };
    let content = observation.content();
    let (actor_kind, actor_id) = match observation.actor() {
        ActivityActor::Primary => ("primary".to_owned(), None),
        ActivityActor::Subagent(id) => ("subagent".to_owned(), Some(id.as_str().to_owned())),
    };

    StoredChatActivity {
        conversation_id: conversation_id.to_owned(),
        turn_id: turn_id.to_owned(),
        turn_ordinal,
        runtime_operation_id: operation_id_string(activity_key.operation_id()),
        activity_id: activity_key.activity_id().as_str().to_owned(),
        sequence: event.sequence,
        kind: activity_kind(observation.kind()).to_owned(),
        kind_namespace: match observation.kind() {
            ActivityKind::Unknown(namespace) => Some(namespace.as_str().to_owned()),
            _ => None,
        },
        lifecycle: activity_lifecycle(observation.phase()).to_owned(),
        status: activity_status(observation.status()).to_owned(),
        assistant_phase: observation
            .assistant_phase()
            .map(activity_assistant_phase)
            .map(str::to_owned),
        disclosure: activity_disclosure(observation.disclosure()).to_owned(),
        label: observation.label().map(|label| label.as_str().to_owned()),
        correlation_kind,
        correlation_id,
        content_change: content.map(|content| activity_content_change(content.change()).to_owned()),
        content_stream: content.map(|content| activity_content_stream(content.stream()).to_owned()),
        content: content.map(|content| content.content().as_str().to_owned()),
        actor_kind,
        actor_id,
        task_list: observation.task_list().map(|snapshot| {
            snapshot
                .items()
                .map(|item| StoredChatTaskListItem {
                    content: item.content().as_str().to_owned(),
                    status: match item.status() {
                        TaskListItemStatus::Pending => "pending",
                        TaskListItemStatus::InProgress => "in_progress",
                        TaskListItemStatus::Completed => "completed",
                    }
                    .to_owned(),
                    priority: item
                        .priority()
                        .map(|priority| match priority {
                            TaskListItemPriority::High => "high",
                            TaskListItemPriority::Medium => "medium",
                            TaskListItemPriority::Low => "low",
                        })
                        .map(str::to_owned),
                })
                .collect()
        }),
        subagents: observation
            .subagents()
            .map(project_subagent_snapshot)
            .collect(),
    }
}

pub fn persist_activity<B>(
    state: &ServerStateService<B>,
    activity: &StoredChatActivity,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let record_id = activity_record_id(activity);
    put_json(
        state,
        record_id.clone(),
        activity,
        RevisionId(format!("rev:{}:observed", record_id.0)),
        RevisionExpectation::Any,
    )
}

fn activity_record_id(activity: &StoredChatActivity) -> PersistenceRecordId {
    let mut identity = blake3::Hasher::new();
    identity.update(activity.runtime_operation_id.as_bytes());
    identity.update(&[0]);
    identity.update(activity.activity_id.as_bytes());
    PersistenceRecordId(format!("{ACTIVITY_PREFIX}{}", identity.finalize().to_hex()))
}

fn activity_kind(kind: &ActivityKind) -> &'static str {
    match kind {
        ActivityKind::AssistantMessage => "assistant_message",
        ActivityKind::ReasoningSummary => "reasoning_summary",
        ActivityKind::Plan => "plan",
        ActivityKind::CommandExecution => "command_execution",
        ActivityKind::FileChange => "file_change",
        ActivityKind::ProviderOwnedTool => "provider_owned_tool",
        ActivityKind::ConsumerOwnedTool => "consumer_owned_tool",
        ActivityKind::ExternalSearch => "external_search",
        ActivityKind::ImageView => "image_view",
        ActivityKind::SubagentOrCollaboration => "subagent_or_collaboration",
        ActivityKind::ReviewTransition => "review_transition",
        ActivityKind::ContextCompaction => "context_compaction",
        ActivityKind::Task => "task",
        ActivityKind::Hook => "hook",
        ActivityKind::HostWatcher => "host_watcher",
        ActivityKind::WarningOrError => "warning_or_error",
        ActivityKind::Unknown(_) => "unknown",
    }
}

fn activity_lifecycle(lifecycle: ActivityLifecyclePhase) -> &'static str {
    match lifecycle {
        ActivityLifecyclePhase::Started => "started",
        ActivityLifecyclePhase::Updated => "updated",
        ActivityLifecyclePhase::Completed => "completed",
    }
}

fn activity_status(status: ActivityStatus) -> &'static str {
    match status {
        ActivityStatus::Pending => "pending",
        ActivityStatus::InProgress => "in_progress",
        ActivityStatus::Completed => "completed",
        ActivityStatus::Failed => "failed",
        ActivityStatus::Cancelled => "cancelled",
    }
}

fn activity_assistant_phase(phase: ActivityAssistantPhase) -> &'static str {
    match phase {
        ActivityAssistantPhase::ProviderUnspecified => "provider_unspecified",
        ActivityAssistantPhase::Intermediate => "intermediate",
        ActivityAssistantPhase::Final => "final",
    }
}

fn activity_disclosure(disclosure: ActivityDisclosure) -> &'static str {
    match disclosure {
        ActivityDisclosure::ProviderDisplayContent => "provider_display_content",
        ActivityDisclosure::AdapterNormalizedSummary => "adapter_normalized_summary",
        ActivityDisclosure::IdentityAndLifecycleOnly => "identity_and_lifecycle_only",
        ActivityDisclosure::Unavailable => "unavailable",
    }
}

fn activity_content_change(change: ActivityContentChangeKind) -> &'static str {
    match change {
        ActivityContentChangeKind::Delta => "delta",
        ActivityContentChangeKind::ReplacementSnapshot => "replacement_snapshot",
    }
}

fn activity_content_stream(stream: ActivityContentStream) -> &'static str {
    match stream {
        ActivityContentStream::IntermediateAssistantText => "intermediate_assistant_text",
        ActivityContentStream::FinalAnswerText => "final_answer_text",
        ActivityContentStream::ReasoningSummaryText => "reasoning_summary_text",
        ActivityContentStream::PlanText => "plan_text",
        ActivityContentStream::CommandOutput => "command_output",
        ActivityContentStream::FileChangeOutput => "file_change_output",
        ActivityContentStream::ProviderToolDisplay => "provider_tool_display",
        ActivityContentStream::NormalizedSummary => "normalized_summary",
    }
}
