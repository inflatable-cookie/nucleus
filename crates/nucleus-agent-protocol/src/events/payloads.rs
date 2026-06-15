//! Canonical runtime event payload types.

/// Canonical payload carried by a runtime event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEventPayload {
    Session(SessionPayload),
    Thread(SessionPayload),
    Turn(TurnPayload),
    MessageItem(MessageItemPayload),
    Reasoning(ReasoningPayload),
    ContentDelta(ContentDeltaPayload),
    ToolCall(ToolCallPayload),
    CommandExecution(CommandExecutionPayload),
    FileChange(FileChangePayload),
    Approval(ApprovalPayload),
    UserInput(UserInputPayload),
    TokenUsage(TokenUsagePayload),
    Warning(RuntimeDiagnosticPayload),
    Error(RuntimeDiagnosticPayload),
    ProviderExtension(ProviderExtensionPayload),
}

/// Where an event payload came from.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEventSource {
    Live,
    Replay,
    Projection,
}

/// Raw provider payload retained for diagnostics.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RawProviderPayload {
    pub format: String,
    pub body: String,
}

/// Session or thread payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionPayload {
    pub kind: SessionPayloadKind,
    pub title: Option<String>,
    pub source: RuntimeEventSource,
    pub raw_provider_payload: Option<RawProviderPayload>,
}

/// Session or thread event kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionPayloadKind {
    Started,
    Configured,
    StateChanged,
    MetadataUpdated,
    Exited,
}

/// Turn payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnPayload {
    pub kind: TurnPayloadKind,
    pub status_detail: Option<String>,
    pub source: RuntimeEventSource,
    pub raw_provider_payload: Option<RawProviderPayload>,
}

/// Turn event kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TurnPayloadKind {
    Started,
    Completed,
    Aborted,
    Failed,
}

/// Message item payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageItemPayload {
    pub role: MessageRole,
    pub text: Option<String>,
    pub source: RuntimeEventSource,
    pub raw_provider_payload: Option<RawProviderPayload>,
}

/// Canonical message role.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MessageRole {
    User,
    Assistant,
    Tool,
    System,
    ProviderSpecific(String),
}

/// Reasoning or plan update payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReasoningPayload {
    pub summary: Option<String>,
    pub details: Option<String>,
    pub source: RuntimeEventSource,
    pub raw_provider_payload: Option<RawProviderPayload>,
}

/// Streaming content delta payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContentDeltaPayload {
    pub format: DeltaFormat,
    pub delta: String,
    pub accumulated: Option<String>,
    pub source: RuntimeEventSource,
    pub raw_provider_payload: Option<RawProviderPayload>,
}

/// Delta content format.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeltaFormat {
    Text,
    Markdown,
    Json,
    ProviderSpecific(String),
}

/// Tool call payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolCallPayload {
    pub tool_name: String,
    pub status: ToolCallStatus,
    pub arguments: Option<String>,
    pub result: Option<String>,
    pub source: RuntimeEventSource,
    pub raw_provider_payload: Option<RawProviderPayload>,
}

/// Tool call status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolCallStatus {
    Started,
    Updated,
    Completed,
    Failed,
}

/// Command execution payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandExecutionPayload {
    pub command: String,
    pub status: CommandStatus,
    pub output: Option<String>,
    pub exit_code: Option<i32>,
    pub source: RuntimeEventSource,
    pub raw_provider_payload: Option<RawProviderPayload>,
}

/// Command execution status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandStatus {
    Started,
    Updated,
    Completed,
    Failed,
    Cancelled,
}

/// File change payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileChangePayload {
    pub path: String,
    pub kind: FileChangeKind,
    pub source: RuntimeEventSource,
    pub raw_provider_payload: Option<RawProviderPayload>,
}

/// File change kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FileChangeKind {
    Created,
    Modified,
    Deleted,
    Renamed,
    Unknown,
}

/// Approval request payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovalPayload {
    pub prompt: String,
    pub scope: ApprovalScope,
    pub options: Vec<String>,
    pub source: RuntimeEventSource,
    pub raw_provider_payload: Option<RawProviderPayload>,
}

/// Approval request scope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ApprovalScope {
    Command,
    FileChange,
    ToolCall,
    ProviderSpecific(String),
}

/// Structured user-input request payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserInputPayload {
    pub prompt: String,
    pub kind: UserInputPromptKind,
    pub options: Vec<String>,
    pub source: RuntimeEventSource,
    pub raw_provider_payload: Option<RawProviderPayload>,
}

/// User-input prompt kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UserInputPromptKind {
    Text,
    SelectOne,
    SelectMany,
    Editor,
    ProviderSpecific(String),
}

/// Token usage payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenUsagePayload {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub source: RuntimeEventSource,
    pub raw_provider_payload: Option<RawProviderPayload>,
}

/// Warning or error payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeDiagnosticPayload {
    pub severity: Severity,
    pub message: String,
    pub source: RuntimeEventSource,
    pub raw_provider_payload: Option<RawProviderPayload>,
}

/// Diagnostic severity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Severity {
    Warning,
    Error,
}

/// Provider-specific extension event payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderExtensionPayload {
    pub name: String,
    pub method: Option<String>,
    pub body: Option<String>,
    pub source: RuntimeEventSource,
    pub raw_provider_payload: Option<RawProviderPayload>,
}
