use nucleus_agent_protocol::AgentActivityEvent;
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation,
};
use serde::{Deserialize, Serialize};
use swallowtail_runtime::{
    ActivityActor, ActivityAssistantPhase, ActivityContentChangeKind, ActivityContentStream,
    ActivityCorrelation, ActivityDisclosure, ActivityKind, ActivityLifecyclePhase,
    ActivityOperationId, ActivityStatus, CallbackOperationId, HarnessUserInputChoiceMode,
    HarnessUserInputQuestionKind, HarnessUserInputRequest, HarnessUserInputResponse,
    SubagentParent, SubagentStatus, TaskListItemPriority, TaskListItemStatus,
};

use super::{LocalCodexChatHarnessMode, TaskAuthoringReceipt, TaskWorkflowReceipt};
use crate::ServerStateService;

const SESSION_PREFIX: &str = "product-chat-session:";
const TURN_PREFIX: &str = "product-chat-turn:";
const MESSAGE_PREFIX: &str = "product-chat-message:";
const ACTIVITY_PREFIX: &str = "product-chat-activity:";
const QUESTION_PREFIX: &str = "product-chat-question:";
const THREAD_METADATA_PREFIX: &str = "product-chat-thread-metadata:";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatSession {
    pub conversation_id: String,
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub session_id: String,
    pub provider_thread_id: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub harness_mode: LocalCodexChatHarnessMode,
    #[serde(default)]
    pub adapter_id: String,
    #[serde(default)]
    pub provider_instance_id: String,
    pub turn_count: u64,
    #[serde(default)]
    pub task_toolset_version: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatTurn {
    pub conversation_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub ordinal: u64,
    pub status: String,
    #[serde(default)]
    pub provider_turn_id: Option<String>,
    #[serde(default)]
    pub failure_reason: Option<String>,
    #[serde(default)]
    pub selected_goal_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ChatTurnFailureStatus {
    Cancelled,
    TimedOut,
    Failed,
}

impl ChatTurnFailureStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed_out",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatMessage {
    pub message_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub role: ChatMessageRole,
    pub text: String,
    pub sequence: u64,
    #[serde(default)]
    pub task_receipts: Vec<TaskAuthoringReceipt>,
    #[serde(default)]
    pub workflow_receipts: Vec<TaskWorkflowReceipt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatActivity {
    pub conversation_id: String,
    pub turn_id: String,
    pub turn_ordinal: u64,
    pub runtime_operation_id: String,
    pub activity_id: String,
    pub sequence: u64,
    pub kind: String,
    pub kind_namespace: Option<String>,
    pub lifecycle: String,
    pub status: String,
    pub assistant_phase: Option<String>,
    pub disclosure: String,
    pub label: Option<String>,
    pub correlation_kind: Option<String>,
    pub correlation_id: Option<String>,
    pub content_change: Option<String>,
    pub content_stream: Option<String>,
    pub content: Option<String>,
    #[serde(default = "primary_actor_kind")]
    pub actor_kind: String,
    #[serde(default)]
    pub actor_id: Option<String>,
    #[serde(default)]
    pub task_list: Option<Vec<StoredChatTaskListItem>>,
    #[serde(default)]
    pub subagents: Vec<StoredChatSubagent>,
}

fn primary_actor_kind() -> String {
    "primary".to_owned()
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatTaskListItem {
    pub content: String,
    pub status: String,
    pub priority: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatSubagent {
    pub subagent_id: String,
    pub parent_kind: String,
    pub parent_id: Option<String>,
    pub status: String,
    pub label: Option<String>,
    pub description: Option<String>,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub background: Option<bool>,
    pub originating_activity_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatQuestionExchange {
    pub conversation_id: String,
    pub turn_id: String,
    pub callback_id: String,
    pub runtime_operation_id: String,
    pub event_sequence: u64,
    pub provider_request_ref: Option<String>,
    pub deadline_ticks: Option<u64>,
    pub auto_resolution_ms: Option<u64>,
    pub status: String,
    pub questions: Vec<StoredChatQuestion>,
    #[serde(default)]
    pub answers: Vec<StoredChatQuestionAnswer>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatQuestion {
    pub question_id: String,
    pub header: String,
    pub prompt: String,
    pub kind: String,
    pub allow_other: bool,
    pub options: Vec<StoredChatQuestionOption>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatQuestionOption {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatQuestionAnswer {
    pub question_id: String,
    pub selected_option_ids: Vec<String>,
    pub text: Option<String>,
    pub skipped: bool,
    pub redacted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatMessageRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatHistory {
    pub conversation_id: String,
    pub project_id: String,
    pub session_id: Option<String>,
    pub thread_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub harness_mode: Option<LocalCodexChatHarnessMode>,
    pub turns: Vec<LocalCodexChatHistoryTurn>,
    pub messages: Vec<StoredChatMessage>,
    pub activities: Vec<StoredChatActivity>,
    pub questions: Vec<StoredChatQuestionExchange>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatHistoryTurn {
    pub turn_id: String,
    pub ordinal: u64,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatThreadSummary {
    pub conversation_id: String,
    pub project_id: String,
    pub session_id: String,
    pub thread_id: String,
    pub title: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub harness_mode: LocalCodexChatHarnessMode,
    pub turn_count: u64,
    pub status: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct NativeProofEvidenceSummary {
    pub schema_version: u32,
    pub expected_terminal_classes: Vec<String>,
    pub total_turns: u64,
    pub active_turns: u64,
    pub completed_turns: u64,
    pub cancelled_turns: u64,
    pub timed_out_turns: u64,
    pub failed_turns: u64,
    pub unexpected_turns: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct StoredChatThreadMetadata {
    conversation_id: String,
    title: String,
}

pub fn read_session<B>(
    state: &ServerStateService<B>,
    conversation_id: &str,
) -> Result<Option<StoredChatSession>, String>
where
    B: LocalStoreBackend,
{
    state
        .agent_sessions()
        .get(&session_record_id(conversation_id))
        .map_err(storage_error)?
        .map(|record| decode(&record.payload.bytes))
        .transpose()
}

pub fn read_history<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    conversation_id: &str,
) -> Result<LocalCodexChatHistory, String>
where
    B: LocalStoreBackend,
{
    let session =
        read_session(state, conversation_id)?.filter(|session| session.project_id == project_id);
    let mut turns = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(TURN_PREFIX))
        .map(|record| decode::<StoredChatTurn>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    turns.retain(|turn| turn.conversation_id == conversation_id);
    turns.sort_by_key(|turn| turn.ordinal);
    let mut messages = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(MESSAGE_PREFIX))
        .map(|record| decode::<StoredChatMessage>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    messages.retain(|message| message.conversation_id == conversation_id);
    messages.sort_by_key(|message| message.sequence);
    let mut activities = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(ACTIVITY_PREFIX))
        .map(|record| decode::<StoredChatActivity>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    activities.retain(|activity| activity.conversation_id == conversation_id);
    activities.sort_by_key(|activity| (activity.turn_ordinal, activity.sequence));
    let mut questions = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(QUESTION_PREFIX))
        .map(|record| decode::<StoredChatQuestionExchange>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    questions.retain(|question| question.conversation_id == conversation_id);
    questions.sort_by_key(|question| question.event_sequence);

    Ok(LocalCodexChatHistory {
        conversation_id: conversation_id.to_owned(),
        project_id: project_id.to_owned(),
        session_id: session.as_ref().map(|session| session.session_id.clone()),
        thread_id: session
            .as_ref()
            .map(|session| session.provider_thread_id.clone()),
        model: session.as_ref().map(|session| session.model.clone()),
        reasoning_effort: session
            .as_ref()
            .and_then(|session| session.reasoning_effort.clone()),
        harness_mode: session.as_ref().map(|session| session.harness_mode),
        turns: turns
            .into_iter()
            .map(|turn| LocalCodexChatHistoryTurn {
                turn_id: turn.turn_id,
                ordinal: turn.ordinal,
                status: turn.status,
            })
            .collect(),
        messages,
        activities,
        questions,
    })
}

pub fn project_question(
    conversation_id: &str,
    turn_id: &str,
    request: &nucleus_agent_protocol::AgentUserInputRequest,
) -> Result<StoredChatQuestionExchange, String> {
    let questions = request
        .questions()
        .ok_or_else(|| "Agent Chat callback is not typed user input".to_owned())?;
    let runtime_operation_id = match request.callback.operation_id() {
        CallbackOperationId::Turn(id) => format!("turn:{}", id.as_str()),
        CallbackOperationId::Run(id) => format!("run:{}", id.as_str()),
    };
    Ok(StoredChatQuestionExchange {
        conversation_id: conversation_id.to_owned(),
        turn_id: turn_id.to_owned(),
        callback_id: request.callback.callback_id().as_str().to_owned(),
        runtime_operation_id,
        event_sequence: request.callback.event_sequence(),
        provider_request_ref: request
            .callback
            .provider_request_ref()
            .map(|reference| reference.as_provider_value().to_owned()),
        deadline_ticks: request
            .callback
            .deadline()
            .map(|deadline| deadline.instant().ticks()),
        auto_resolution_ms: questions.auto_resolution_ms(),
        status: "pending".to_owned(),
        questions: project_questions(questions),
        answers: Vec::new(),
    })
}

pub fn persist_question_pending<B>(
    state: &ServerStateService<B>,
    exchange: &StoredChatQuestionExchange,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let record_id = question_record_id(&exchange.turn_id, &exchange.callback_id);
    put_json(
        state,
        record_id.clone(),
        exchange,
        RevisionId(format!("rev:{}:pending", record_id.0)),
        RevisionExpectation::MustNotExist,
    )
}

pub fn persist_question_answer<B>(
    state: &ServerStateService<B>,
    turn_id: &str,
    callback_id: &str,
    request: &HarnessUserInputRequest,
    response: &HarnessUserInputResponse,
) -> Result<StoredChatQuestionExchange, String>
where
    B: LocalStoreBackend,
{
    let record_id = question_record_id(turn_id, callback_id);
    let record = state
        .agent_sessions()
        .get(&record_id)
        .map_err(storage_error)?
        .ok_or_else(|| "Agent Chat question record is missing".to_owned())?;
    let mut exchange = decode::<StoredChatQuestionExchange>(&record.payload.bytes)?;
    if exchange.status != "pending" {
        return Err("Agent Chat question is already resolved".to_owned());
    }
    exchange.status = "answered".to_owned();
    exchange.answers = project_answers(request, response);
    put_json(
        state,
        record_id.clone(),
        &exchange,
        RevisionId(format!("rev:{}:answered", record_id.0)),
        RevisionExpectation::Exact(record.revision_id),
    )?;
    Ok(exchange)
}

pub fn settle_pending_questions_for_turn<B>(
    state: &ServerStateService<B>,
    turn_id: &str,
    status: &str,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let records = state.agent_sessions().list().map_err(storage_error)?;
    for record in records
        .into_iter()
        .filter(|record| record.id.0.starts_with(QUESTION_PREFIX))
    {
        let mut exchange = decode::<StoredChatQuestionExchange>(&record.payload.bytes)?;
        if exchange.turn_id != turn_id || exchange.status != "pending" {
            continue;
        }
        exchange.status = status.to_owned();
        put_json(
            state,
            record.id.clone(),
            &exchange,
            RevisionId(format!("rev:{}:{status}", record.id.0)),
            RevisionExpectation::Exact(record.revision_id),
        )?;
    }
    Ok(())
}

pub fn recover_interrupted_chat_state<B>(state: &ServerStateService<B>) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let records = state.agent_sessions().list().map_err(storage_error)?;
    let interrupted_turns = records
        .iter()
        .filter(|record| record.id.0.starts_with(TURN_PREFIX))
        .map(|record| decode::<StoredChatTurn>(&record.payload.bytes).map(|turn| (record, turn)))
        .collect::<Result<Vec<_>, _>>()?;
    for (record, mut turn) in interrupted_turns {
        if turn.status != "started" {
            continue;
        }
        turn.status = "failed".to_owned();
        turn.failure_reason = Some("Agent Chat runtime restarted during the turn".to_owned());
        put_json(
            state,
            record.id.clone(),
            &turn,
            RevisionId(format!("rev:{}:restart", record.id.0)),
            RevisionExpectation::Exact(record.revision_id.clone()),
        )?;
        settle_pending_questions_for_turn(state, &turn.turn_id, "abandoned")?;
    }
    Ok(())
}

fn project_questions(request: &HarnessUserInputRequest) -> Vec<StoredChatQuestion> {
    request
        .questions()
        .map(|question| {
            let (kind, allow_other) = match question.kind() {
                HarnessUserInputQuestionKind::Choice {
                    mode: HarnessUserInputChoiceMode::Single,
                    allow_other,
                } => ("single_choice", allow_other),
                HarnessUserInputQuestionKind::Choice {
                    mode: HarnessUserInputChoiceMode::Multiple,
                    allow_other,
                } => ("multiple_choice", allow_other),
                HarnessUserInputQuestionKind::Text { secret: false } => ("text", false),
                HarnessUserInputQuestionKind::Text { secret: true } => ("secret_text", false),
            };
            StoredChatQuestion {
                question_id: question.id().as_str().to_owned(),
                header: question.header().as_str().to_owned(),
                prompt: question.prompt().as_str().to_owned(),
                kind: kind.to_owned(),
                allow_other,
                options: question
                    .options()
                    .map(|option| StoredChatQuestionOption {
                        value: option.id().as_str().to_owned(),
                        label: option.label().as_str().to_owned(),
                        description: option
                            .description()
                            .map(|description| description.as_str().to_owned()),
                    })
                    .collect(),
            }
        })
        .collect()
}

fn project_answers(
    request: &HarnessUserInputRequest,
    response: &HarnessUserInputResponse,
) -> Vec<StoredChatQuestionAnswer> {
    response
        .answers()
        .map(|answer| {
            let secret = request
                .questions()
                .find(|question| question.id() == answer.question_id())
                .is_some_and(|question| {
                    matches!(
                        question.kind(),
                        HarnessUserInputQuestionKind::Text { secret: true }
                    )
                });
            StoredChatQuestionAnswer {
                question_id: answer.question_id().as_str().to_owned(),
                selected_option_ids: answer
                    .selected_options()
                    .map(|id| id.as_str().to_owned())
                    .collect(),
                text: if secret {
                    None
                } else {
                    answer.text().map(|text| text.as_str().to_owned())
                },
                skipped: answer.is_skipped(),
                redacted: secret && answer.text().is_some(),
            }
        })
        .collect()
}

fn question_record_id(turn_id: &str, callback_id: &str) -> PersistenceRecordId {
    let identity = blake3::hash(callback_id.as_bytes()).to_hex();
    PersistenceRecordId(format!("{QUESTION_PREFIX}{turn_id}:{identity}"))
}

pub fn project_activity(
    conversation_id: &str,
    turn_id: &str,
    turn_ordinal: u64,
    event: AgentActivityEvent,
) -> StoredChatActivity {
    let observation = event.observation;
    let (runtime_kind, runtime_id) = match observation.operation_id() {
        ActivityOperationId::Run(id) => ("run", id.as_str()),
        ActivityOperationId::Turn(id) => ("turn", id.as_str()),
    };
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
        runtime_operation_id: format!("{runtime_kind}:{runtime_id}"),
        activity_id: observation.activity_id().as_str().to_owned(),
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
            .map(|snapshot| {
                let (parent_kind, parent_id) = match snapshot.parent() {
                    SubagentParent::Operation => ("operation".to_owned(), None),
                    SubagentParent::Subagent(id) => {
                        ("subagent".to_owned(), Some(id.as_str().to_owned()))
                    }
                    SubagentParent::Unknown => ("unknown".to_owned(), None),
                };
                StoredChatSubagent {
                    subagent_id: snapshot.id().as_str().to_owned(),
                    parent_kind,
                    parent_id,
                    status: match snapshot.status() {
                        SubagentStatus::Unknown => "unknown",
                        SubagentStatus::Pending => "pending",
                        SubagentStatus::Running => "running",
                        SubagentStatus::Waiting => "waiting",
                        SubagentStatus::Completed => "completed",
                        SubagentStatus::Failed => "failed",
                        SubagentStatus::Interrupted => "interrupted",
                        SubagentStatus::Shutdown => "shutdown",
                    }
                    .to_owned(),
                    label: snapshot.label().map(|label| label.as_str().to_owned()),
                    description: snapshot
                        .description()
                        .map(|description| description.as_str().to_owned()),
                    model: snapshot.model().map(|model| model.as_str().to_owned()),
                    reasoning: snapshot
                        .reasoning()
                        .map(|reasoning| reasoning.as_str().to_owned()),
                    background: snapshot.background(),
                    originating_activity_ref: snapshot
                        .originating_activity()
                        .map(|reference| reference.as_provider_value().to_owned()),
                }
            })
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
    let identity = blake3::hash(activity.activity_id.as_bytes()).to_hex();
    let record_id = PersistenceRecordId(format!(
        "{ACTIVITY_PREFIX}{}:{}:{identity}",
        activity.turn_id, activity.sequence
    ));
    put_json(
        state,
        record_id.clone(),
        activity,
        RevisionId(format!("rev:{}:observed", record_id.0)),
        RevisionExpectation::Any,
    )
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

pub fn list_threads<B>(
    state: &ServerStateService<B>,
) -> Result<Vec<LocalCodexChatThreadSummary>, String>
where
    B: LocalStoreBackend,
{
    let records = state.agent_sessions().list().map_err(storage_error)?;
    let sessions = records
        .iter()
        .filter(|record| record.id.0.starts_with(SESSION_PREFIX))
        .map(|record| decode::<StoredChatSession>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    let turns = records
        .iter()
        .filter(|record| record.id.0.starts_with(TURN_PREFIX))
        .map(|record| decode::<StoredChatTurn>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    let messages = records
        .iter()
        .filter(|record| record.id.0.starts_with(MESSAGE_PREFIX))
        .map(|record| decode::<StoredChatMessage>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    let thread_metadata = records
        .iter()
        .filter(|record| record.id.0.starts_with(THREAD_METADATA_PREFIX))
        .map(|record| decode::<StoredChatThreadMetadata>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;

    let mut summaries = sessions
        .into_iter()
        .map(|session| {
            let status = turns
                .iter()
                .filter(|turn| turn.conversation_id == session.conversation_id)
                .max_by_key(|turn| turn.ordinal)
                .map(|turn| turn.status.clone())
                .unwrap_or_else(|| "ready".to_owned());
            let title = thread_metadata
                .iter()
                .find(|metadata| metadata.conversation_id == session.conversation_id)
                .map(|metadata| metadata.title.clone())
                .or_else(|| {
                    messages
                        .iter()
                        .filter(|message| {
                            message.conversation_id == session.conversation_id
                                && message.role == ChatMessageRole::User
                        })
                        .min_by_key(|message| message.sequence)
                        .map(|message| compact_thread_title(&message.text))
                })
                .unwrap_or_else(|| "New conversation".to_owned());

            LocalCodexChatThreadSummary {
                conversation_id: session.conversation_id,
                project_id: session.project_id,
                session_id: session.session_id,
                thread_id: session.provider_thread_id,
                title,
                model: session.model,
                reasoning_effort: session.reasoning_effort,
                harness_mode: session.harness_mode,
                turn_count: session.turn_count,
                status,
            }
        })
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| {
        left.project_id
            .cmp(&right.project_id)
            .then_with(|| left.conversation_id.cmp(&right.conversation_id))
    });
    Ok(summaries)
}

pub fn read_native_proof_evidence<B>(
    state: &ServerStateService<B>,
) -> Result<NativeProofEvidenceSummary, String>
where
    B: LocalStoreBackend,
{
    let turns = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(TURN_PREFIX))
        .map(|record| decode::<StoredChatTurn>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    let mut summary = NativeProofEvidenceSummary {
        schema_version: 1,
        expected_terminal_classes: ["completed", "cancelled", "timed_out", "failed"]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        total_turns: turns.len() as u64,
        active_turns: 0,
        completed_turns: 0,
        cancelled_turns: 0,
        timed_out_turns: 0,
        failed_turns: 0,
        unexpected_turns: 0,
    };
    for turn in turns {
        match turn.status.as_str() {
            "started" => summary.active_turns += 1,
            "completed" => summary.completed_turns += 1,
            "cancelled" => summary.cancelled_turns += 1,
            "timed_out" => summary.timed_out_turns += 1,
            "failed" => summary.failed_turns += 1,
            _ => summary.unexpected_turns += 1,
        }
    }
    Ok(summary)
}

pub fn rename_thread<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    conversation_id: &str,
    title: &str,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let session = read_session(state, conversation_id)?
        .filter(|session| session.project_id == project_id)
        .ok_or_else(|| format!("chat thread not found: {conversation_id}"))?;
    let title = title.trim();
    if title.is_empty() {
        return Err("chat thread title must not be empty".to_owned());
    }
    if title.chars().count() > 80 {
        return Err("chat thread title must not exceed 80 characters".to_owned());
    }

    let metadata = StoredChatThreadMetadata {
        conversation_id: session.conversation_id,
        title: title.to_owned(),
    };
    let revision_hash = blake3::hash(title.as_bytes()).to_hex();
    put_json(
        state,
        thread_metadata_record_id(conversation_id),
        &metadata,
        RevisionId(format!(
            "rev:{THREAD_METADATA_PREFIX}{conversation_id}:{revision_hash}"
        )),
        RevisionExpectation::Any,
    )
}

fn compact_thread_title(message: &str) -> String {
    const MAX_CHARS: usize = 80;
    let compact = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= MAX_CHARS {
        return compact;
    }
    let mut title = compact.chars().take(MAX_CHARS - 1).collect::<String>();
    title.push('…');
    title
}

pub fn canonical_turn_id(conversation_id: &str, ordinal: u64) -> String {
    format!("turn:chat:{conversation_id}:{ordinal}")
}

pub fn operator_message_id(turn_id: &str) -> String {
    format!("message:{turn_id}:user")
}

pub fn persist_turn_start<B>(
    state: &ServerStateService<B>,
    session: StoredChatSession,
    turn_id: &str,
    user_message: &str,
    selected_goal_id: Option<String>,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let ordinal = session.turn_count;
    persist_session(state, &session)?;
    put_json(
        state,
        PersistenceRecordId(format!("{TURN_PREFIX}{turn_id}")),
        &StoredChatTurn {
            conversation_id: session.conversation_id.clone(),
            session_id: session.session_id,
            turn_id: turn_id.to_owned(),
            ordinal,
            status: "started".to_owned(),
            provider_turn_id: None,
            failure_reason: None,
            selected_goal_id,
        },
        RevisionId(format!("rev:{TURN_PREFIX}{turn_id}")),
        RevisionExpectation::MustNotExist,
    )?;
    let first_sequence = (ordinal.saturating_sub(1)) * 2;
    persist_message(
        state,
        StoredChatMessage {
            message_id: operator_message_id(turn_id),
            conversation_id: session.conversation_id.clone(),
            turn_id: turn_id.to_owned(),
            role: ChatMessageRole::User,
            text: user_message.to_owned(),
            sequence: first_sequence,
            task_receipts: Vec::new(),
            workflow_receipts: Vec::new(),
        },
    )
}

pub fn persist_session<B>(
    state: &ServerStateService<B>,
    session: &StoredChatSession,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    put_json(
        state,
        session_record_id(&session.conversation_id),
        session,
        RevisionId(format!(
            "rev:{}:{}",
            session_record_id(&session.conversation_id).0,
            session.turn_count
        )),
        RevisionExpectation::Any,
    )
}

pub fn persist_turn_completion<B>(
    state: &ServerStateService<B>,
    turn_id: &str,
    provider_turn_id: &str,
    assistant_message: &str,
    task_receipts: &[TaskAuthoringReceipt],
    workflow_receipts: &[TaskWorkflowReceipt],
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let (mut turn, revision) = read_turn(state, turn_id)?;
    if turn.status != "started" {
        return Err(format!("chat turn is not awaiting completion: {turn_id}"));
    }
    turn.status = "completed".to_owned();
    turn.provider_turn_id = Some(provider_turn_id.to_owned());
    put_json(
        state,
        PersistenceRecordId(format!("{TURN_PREFIX}{turn_id}")),
        &turn,
        RevisionId(format!("rev:{TURN_PREFIX}{turn_id}:completed")),
        RevisionExpectation::Exact(revision),
    )?;
    let first_sequence = (turn.ordinal.saturating_sub(1)) * 2;
    persist_message(
        state,
        StoredChatMessage {
            message_id: format!("message:{turn_id}:assistant"),
            conversation_id: turn.conversation_id,
            turn_id: turn_id.to_owned(),
            role: ChatMessageRole::Assistant,
            text: assistant_message.to_owned(),
            sequence: first_sequence + 1,
            task_receipts: task_receipts.to_vec(),
            workflow_receipts: workflow_receipts.to_vec(),
        },
    )
}

pub fn persist_turn_failure<B>(
    state: &ServerStateService<B>,
    turn_id: &str,
    status: ChatTurnFailureStatus,
    reason: &str,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let (mut turn, revision) = read_turn(state, turn_id)?;
    if turn.status != "started" {
        return Err(format!("chat turn is not awaiting failure: {turn_id}"));
    }
    turn.status = status.as_str().to_owned();
    turn.failure_reason = Some(reason.chars().take(500).collect());
    put_json(
        state,
        PersistenceRecordId(format!("{TURN_PREFIX}{turn_id}")),
        &turn,
        RevisionId(format!("rev:{TURN_PREFIX}{turn_id}:{}", status.as_str())),
        RevisionExpectation::Exact(revision),
    )
}

pub(crate) fn read_message<B>(
    state: &ServerStateService<B>,
    message_id: &str,
) -> Result<StoredChatMessage, String>
where
    B: LocalStoreBackend,
{
    let record = state
        .agent_sessions()
        .get(&PersistenceRecordId(format!(
            "{MESSAGE_PREFIX}{message_id}"
        )))
        .map_err(storage_error)?
        .ok_or_else(|| format!("chat message not found: {message_id}"))?;
    decode(&record.payload.bytes)
}

pub(crate) fn current_turn<B>(
    state: &ServerStateService<B>,
    conversation_id: &str,
) -> Result<StoredChatTurn, String>
where
    B: LocalStoreBackend,
{
    state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(TURN_PREFIX))
        .map(|record| decode::<StoredChatTurn>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|turn| turn.conversation_id == conversation_id)
        .max_by_key(|turn| turn.ordinal)
        .ok_or_else(|| format!("conversation has no persisted turn: {conversation_id}"))
}

pub(crate) fn project_has_active_turn<B>(
    state: &ServerStateService<B>,
    project_id: &str,
) -> Result<bool, String>
where
    B: LocalStoreBackend,
{
    let conversation_ids = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(SESSION_PREFIX))
        .map(|record| decode::<StoredChatSession>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|session| session.project_id == project_id)
        .map(|session| session.conversation_id)
        .collect::<std::collections::HashSet<_>>();
    if conversation_ids.is_empty() {
        return Ok(false);
    }

    state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(TURN_PREFIX))
        .map(|record| decode::<StoredChatTurn>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()
        .map(|turns| {
            turns.into_iter().any(|turn| {
                turn.status == "started" && conversation_ids.contains(&turn.conversation_id)
            })
        })
}

fn read_turn<B>(
    state: &ServerStateService<B>,
    turn_id: &str,
) -> Result<(StoredChatTurn, RevisionId), String>
where
    B: LocalStoreBackend,
{
    let record = state
        .agent_sessions()
        .get(&PersistenceRecordId(format!("{TURN_PREFIX}{turn_id}")))
        .map_err(storage_error)?
        .ok_or_else(|| format!("chat turn not found: {turn_id}"))?;
    Ok((decode(&record.payload.bytes)?, record.revision_id))
}

fn persist_message<B>(
    state: &ServerStateService<B>,
    message: StoredChatMessage,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    put_json(
        state,
        PersistenceRecordId(format!("{MESSAGE_PREFIX}{}", message.message_id)),
        &message,
        RevisionId(format!("rev:{MESSAGE_PREFIX}{}", message.message_id)),
        RevisionExpectation::MustNotExist,
    )
}

fn put_json<B, T>(
    state: &ServerStateService<B>,
    id: PersistenceRecordId,
    value: &T,
    revision_id: RevisionId,
    expectation: RevisionExpectation,
) -> Result<(), String>
where
    B: LocalStoreBackend,
    T: Serialize,
{
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    state
        .agent_sessions()
        .put(
            LocalStoreRecord {
                revision_id,
                id,
                domain: PersistenceDomain::AgentSessions,
                kind: PersistenceRecordKind::AgentSession,
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes,
                },
            },
            expectation,
        )
        .map(|_| ())
        .map_err(storage_error)
}

fn session_record_id(conversation_id: &str) -> PersistenceRecordId {
    PersistenceRecordId(format!("{SESSION_PREFIX}{conversation_id}"))
}

fn thread_metadata_record_id(conversation_id: &str) -> PersistenceRecordId {
    PersistenceRecordId(format!("{THREAD_METADATA_PREFIX}{conversation_id}"))
}

fn decode<T>(bytes: &[u8]) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_slice(bytes).map_err(|error| error.to_string())
}

fn storage_error(error: impl std::fmt::Debug) -> String {
    format!("chat persistence failed: {error:?}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::AgentActivityEvent;
    use nucleus_local_store::SqliteBackend;
    use swallowtail_runtime::{
        ActivityContent, ActivityContentChangeKind, ActivityContentStream, ActivityContentUpdate,
        ActivityId, ActivityLabel, ActivityObservation, OperationContent, RuntimeRunId, SubagentId,
        SubagentParent, SubagentSnapshot, TaskListItem, TaskListSnapshot,
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

    #[test]
    fn completed_chat_turn_survives_reopen_in_display_order() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let path = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(path.clone()));
        let session = StoredChatSession {
            conversation_id: "project:1:panel:chat".to_owned(),
            project_id: "project:1".to_owned(),
            resource_id: None,
            session_id: "session:1".to_owned(),
            provider_thread_id: "thread:1".to_owned(),
            model: "gpt-5.4-mini".to_owned(),
            reasoning_effort: Some("low".to_owned()),
            harness_mode: LocalCodexChatHarnessMode::Normal,
            adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            turn_count: 1,
            task_toolset_version: 1,
        };

        persist_turn_start(&state, session, "turn:1", "Hello", None).expect("start");
        persist_turn_completion(
            &state,
            "turn:1",
            "provider-turn:1",
            "Hi there",
            &[],
            &[TaskWorkflowReceipt {
                status: super::super::TaskWorkflowReceiptStatus::ReviewReady,
                scope_kind: "task".to_owned(),
                project_id: "project:1".to_owned(),
                goal_id: None,
                task_id: Some("task:1".to_owned()),
                title: "Task 1".to_owned(),
                current_task_id: Some("task:1".to_owned()),
                current_position: 1,
                total_tasks: 1,
                summary: "Ready for review".to_owned(),
                mandate_id: "mandate:1".to_owned(),
                plan_id: Some("plan:1".to_owned()),
                work_item_refs: vec!["work:1".to_owned()],
                runtime_receipt_refs: vec!["receipt:1".to_owned()],
            }],
        )
        .expect("complete");
        let reopened = ServerStateService::new(SqliteBackend::new(path.clone()));
        let history =
            read_history(&reopened, "project:1", "project:1:panel:chat").expect("read history");

        assert_eq!(history.turns.len(), 1);
        assert_eq!(history.turns[0].status, "completed");
        assert_eq!(history.messages.len(), 2);
        assert_eq!(history.messages[0].role, ChatMessageRole::User);
        assert_eq!(history.messages[1].text, "Hi there");
        assert_eq!(history.messages[1].workflow_receipts.len(), 1);
        assert_eq!(
            history.messages[1].workflow_receipts[0].task_id.as_deref(),
            Some("task:1")
        );
        assert_eq!(history.thread_id.as_deref(), Some("thread:1"));

        let threads = list_threads(&reopened).expect("list threads");
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].conversation_id, "project:1:panel:chat");
        assert_eq!(threads[0].title, "Hello");
        assert_eq!(threads[0].status, "completed");

        rename_thread(
            &reopened,
            "project:1",
            "project:1:panel:chat",
            "Named thread",
        )
        .expect("rename thread");
        let reopened_after_rename = ServerStateService::new(SqliteBackend::new(path));
        let renamed_threads = list_threads(&reopened_after_rename).expect("list renamed threads");
        assert_eq!(renamed_threads[0].title, "Named thread");
    }

    #[test]
    fn thread_rename_rejects_empty_titles_and_cross_project_access() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        let session = StoredChatSession {
            conversation_id: "conversation:rename".to_owned(),
            project_id: "project:1".to_owned(),
            resource_id: None,
            session_id: "session:1".to_owned(),
            provider_thread_id: "thread:1".to_owned(),
            model: "model".to_owned(),
            reasoning_effort: None,
            harness_mode: LocalCodexChatHarnessMode::Normal,
            adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            turn_count: 1,
            task_toolset_version: 5,
        };
        persist_turn_start(&state, session, "turn:rename", "Original title", None).expect("start");

        assert_eq!(
            rename_thread(&state, "project:1", "conversation:rename", "   "),
            Err("chat thread title must not be empty".to_owned()),
        );
        assert_eq!(
            rename_thread(&state, "project:2", "conversation:rename", "Wrong project"),
            Err("chat thread not found: conversation:rename".to_owned()),
        );
    }

    #[test]
    fn native_proof_evidence_counts_terminal_truth_without_sensitive_material() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        for (ordinal, status) in ["started", "completed", "cancelled", "timed_out", "failed"]
            .into_iter()
            .enumerate()
        {
            let conversation_id = format!("conversation:{ordinal}");
            let turn_id = format!("turn:{ordinal}");
            persist_turn_start(
                &state,
                StoredChatSession {
                    conversation_id,
                    project_id: "project:sensitive".to_owned(),
                    resource_id: None,
                    session_id: format!("session:{ordinal}"),
                    provider_thread_id: format!("provider-secret-{ordinal}"),
                    model: "model".to_owned(),
                    reasoning_effort: None,
                    harness_mode: LocalCodexChatHarnessMode::Normal,
                    adapter_id: "codex-app-server".to_owned(),
                    provider_instance_id: "codex:local-default".to_owned(),
                    turn_count: 1,
                    task_toolset_version: 5,
                },
                &turn_id,
                "prompt-secret-material",
                None,
            )
            .expect("start turn");
            match status {
                "started" => {}
                "completed" => persist_turn_completion(
                    &state,
                    &turn_id,
                    "provider-turn-secret",
                    "assistant-secret-material",
                    &[],
                    &[],
                )
                .expect("complete turn"),
                "cancelled" => persist_turn_failure(
                    &state,
                    &turn_id,
                    ChatTurnFailureStatus::Cancelled,
                    "cancel-secret-material",
                )
                .expect("cancel turn"),
                "timed_out" => persist_turn_failure(
                    &state,
                    &turn_id,
                    ChatTurnFailureStatus::TimedOut,
                    "timeout-secret-material",
                )
                .expect("time out turn"),
                "failed" => persist_turn_failure(
                    &state,
                    &turn_id,
                    ChatTurnFailureStatus::Failed,
                    "failure-secret-material",
                )
                .expect("fail turn"),
                _ => unreachable!(),
            }
        }

        let evidence = read_native_proof_evidence(&state).expect("proof evidence");
        assert_eq!(evidence.total_turns, 5);
        assert_eq!(evidence.active_turns, 1);
        assert_eq!(evidence.completed_turns, 1);
        assert_eq!(evidence.cancelled_turns, 1);
        assert_eq!(evidence.timed_out_turns, 1);
        assert_eq!(evidence.failed_turns, 1);
        assert_eq!(evidence.unexpected_turns, 0);
        let json = serde_json::to_string(&evidence).expect("evidence JSON");
        for forbidden in [
            "prompt-secret",
            "assistant-secret",
            "provider-secret",
            "cancel-secret",
            "timeout-secret",
            "failure-secret",
            "project:sensitive",
        ] {
            assert!(!json.contains(forbidden));
        }
    }

    #[test]
    fn failed_turn_retains_one_operator_message_without_assistant_copy() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        let session = StoredChatSession {
            conversation_id: "conversation:1".to_owned(),
            project_id: "project:1".to_owned(),
            resource_id: None,
            session_id: "session:1".to_owned(),
            provider_thread_id: "thread:1".to_owned(),
            model: "model".to_owned(),
            reasoning_effort: None,
            harness_mode: LocalCodexChatHarnessMode::Normal,
            adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            turn_count: 1,
            task_toolset_version: 4,
        };
        persist_turn_start(&state, session, "turn:1", "Run the goal", None).expect("start");
        persist_turn_failure(
            &state,
            "turn:1",
            ChatTurnFailureStatus::Failed,
            "provider unavailable",
        )
        .expect("fail");

        let history = read_history(&state, "project:1", "conversation:1").expect("history");
        assert_eq!(history.turns[0].status, "failed");
        assert_eq!(history.messages.len(), 1);
        assert_eq!(history.messages[0].role, ChatMessageRole::User);
        assert_eq!(
            current_turn(&state, "conversation:1").expect("turn").status,
            "failed"
        );
    }

    #[test]
    fn active_turn_lookup_is_project_scoped_and_terminal_aware() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        let session = StoredChatSession {
            conversation_id: "conversation:active".to_owned(),
            project_id: "project:active".to_owned(),
            resource_id: None,
            session_id: "session:active".to_owned(),
            provider_thread_id: "thread:active".to_owned(),
            model: "model".to_owned(),
            reasoning_effort: None,
            harness_mode: LocalCodexChatHarnessMode::Normal,
            adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            turn_count: 1,
            task_toolset_version: 5,
        };

        persist_turn_start(&state, session, "turn:active", "Hello", None).expect("start");
        assert!(project_has_active_turn(&state, "project:active").expect("active lookup"));
        assert!(!project_has_active_turn(&state, "project:other").expect("other lookup"));

        persist_turn_failure(
            &state,
            "turn:active",
            ChatTurnFailureStatus::Cancelled,
            "stopped",
        )
        .expect("finish");
        assert!(!project_has_active_turn(&state, "project:active").expect("terminal lookup"));
    }

    #[test]
    fn legacy_chat_session_without_toolset_version_requires_migration() {
        let session: StoredChatSession = serde_json::from_value(serde_json::json!({
            "conversation_id": "conversation:legacy",
            "project_id": "project:1",
            "session_id": "session:1",
            "provider_thread_id": "thread:legacy",
            "model": "gpt-5.4-mini",
            "reasoning_effort": "low",
            "turn_count": 2
        }))
        .expect("legacy session");

        assert_eq!(session.task_toolset_version, 0);
        assert_eq!(session.harness_mode, LocalCodexChatHarnessMode::Normal);
    }

    #[test]
    fn restart_abandons_pending_questions_and_fails_the_interrupted_turn() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let path = temp_dir.path().join("db.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(path.clone()));
        let session = StoredChatSession {
            conversation_id: "conversation:restart".to_owned(),
            project_id: "project:restart".to_owned(),
            resource_id: None,
            session_id: "session:restart".to_owned(),
            provider_thread_id: "thread:restart".to_owned(),
            model: "gpt-5.4-mini".to_owned(),
            reasoning_effort: Some("low".to_owned()),
            harness_mode: LocalCodexChatHarnessMode::Normal,
            adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            turn_count: 1,
            task_toolset_version: 5,
        };
        persist_turn_start(&state, session, "turn:restart", "Ask a question", None).expect("turn");
        persist_question_pending(
            &state,
            &StoredChatQuestionExchange {
                conversation_id: "conversation:restart".to_owned(),
                turn_id: "turn:restart".to_owned(),
                callback_id: "callback:restart".to_owned(),
                runtime_operation_id: "turn:runtime:restart".to_owned(),
                event_sequence: 3,
                provider_request_ref: None,
                deadline_ticks: None,
                auto_resolution_ms: None,
                status: "pending".to_owned(),
                questions: vec![StoredChatQuestion {
                    question_id: "question:restart".to_owned(),
                    header: "Continue".to_owned(),
                    prompt: "Continue?".to_owned(),
                    kind: "single_choice".to_owned(),
                    allow_other: false,
                    options: vec![StoredChatQuestionOption {
                        value: "yes".to_owned(),
                        label: "Yes".to_owned(),
                        description: None,
                    }],
                }],
                answers: Vec::new(),
            },
        )
        .expect("question");
        drop(state);

        let reopened = ServerStateService::new(SqliteBackend::new(path));
        recover_interrupted_chat_state(&reopened).expect("recover");
        let history =
            read_history(&reopened, "project:restart", "conversation:restart").expect("history");
        assert_eq!(history.turns[0].status, "failed");
        assert_eq!(history.questions[0].status, "abandoned");
    }
}
