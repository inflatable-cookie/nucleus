//! Static Codex app-server fixture projection.

use crate::events::{
    ApprovalPayload, ApprovalScope, ContentDeltaPayload, DeltaFormat, MessageItemPayload,
    MessageRole, RawProviderPayload, RuntimeDiagnosticPayload, RuntimeEventIdentity,
    RuntimeEventKind, RuntimeEventPayload, RuntimeEventSource, SessionPayload, SessionPayloadKind,
    Severity, ToolCallPayload, ToolCallStatus, TurnPayload, TurnPayloadKind, UserInputPayload,
    UserInputPromptKind,
};
use crate::identity::ProviderDriverKind;
use crate::traits::AdapterRuntimeEvent;

use super::types::{
    CodexAppServerEventFixture, CodexAppServerFixturePayload, CodexAppServerFixtureProjection,
    CodexFixtureMappingError, CodexRuntimeReceiptFixture, CodexRuntimeReceiptStatus,
};

pub fn project_codex_app_server_fixture(
    fixture: CodexAppServerEventFixture,
) -> Result<CodexAppServerFixtureProjection, CodexFixtureMappingError> {
    validate_fixture_method(&fixture)?;

    let projection = match fixture.payload.clone() {
        CodexAppServerFixturePayload::ThreadStarted { title } => thread_event(
            &fixture,
            SessionPayloadKind::Started,
            title,
            "thread started",
        ),
        CodexAppServerFixturePayload::ThreadResumed => thread_event(
            &fixture,
            SessionPayloadKind::StateChanged,
            None,
            "thread resumed",
        ),
        CodexAppServerFixturePayload::TurnStarted => {
            turn_event(&fixture, TurnPayloadKind::Started, None, "turn started")
        }
        CodexAppServerFixturePayload::TurnCompleted { status_detail } => turn_event(
            &fixture,
            TurnPayloadKind::Completed,
            status_detail,
            "turn completed",
        ),
        CodexAppServerFixturePayload::ItemStarted { role, text } => {
            message_item_event(&fixture, role, text, "item started")
        }
        CodexAppServerFixturePayload::AgentMessageDelta { delta, accumulated } => {
            content_delta_event(&fixture, delta, accumulated)
        }
        CodexAppServerFixturePayload::ToolCallStarted {
            tool_name,
            arguments,
        } => tool_call_event(&fixture, tool_name, arguments),
        CodexAppServerFixturePayload::ApprovalRequest {
            prompt,
            scope,
            options,
        } => approval_event(&fixture, prompt, scope, options),
        CodexAppServerFixturePayload::UserInputRequest {
            prompt,
            kind,
            options,
        } => user_input_event(&fixture, prompt, kind, options),
        CodexAppServerFixturePayload::InterruptionReceipt { summary } => {
            return Ok(CodexAppServerFixtureProjection::RuntimeReceipt(
                interruption_receipt_fixture(&fixture, summary),
            ));
        }
        CodexAppServerFixturePayload::Warning { message } => diagnostic_event(
            &fixture,
            RuntimeEventKind::RuntimeWarning,
            RuntimeEventPayload::Warning(RuntimeDiagnosticPayload {
                severity: Severity::Warning,
                message,
                source: RuntimeEventSource::Replay,
                raw_provider_payload: raw_payload(&fixture, "warning"),
            }),
        ),
        CodexAppServerFixturePayload::Error { message } => diagnostic_event(
            &fixture,
            RuntimeEventKind::RuntimeError,
            RuntimeEventPayload::Error(RuntimeDiagnosticPayload {
                severity: Severity::Error,
                message,
                source: RuntimeEventSource::Replay,
                raw_provider_payload: raw_payload(&fixture, "error"),
            }),
        ),
    };

    Ok(CodexAppServerFixtureProjection::Event(projection))
}

fn validate_fixture_method(
    fixture: &CodexAppServerEventFixture,
) -> Result<(), CodexFixtureMappingError> {
    let expected = match &fixture.payload {
        CodexAppServerFixturePayload::ThreadStarted { .. } => "thread/started",
        CodexAppServerFixturePayload::ThreadResumed => "thread/status/changed",
        CodexAppServerFixturePayload::TurnStarted => "turn/started",
        CodexAppServerFixturePayload::TurnCompleted { .. } => "turn/completed",
        CodexAppServerFixturePayload::ItemStarted { .. } => "item/started",
        CodexAppServerFixturePayload::AgentMessageDelta { .. } => "item/agentMessage/delta",
        CodexAppServerFixturePayload::ToolCallStarted { .. } => "item/tool/call",
        CodexAppServerFixturePayload::ApprovalRequest {
            scope: ApprovalScope::Command,
            ..
        } => "item/commandExecution/requestApproval",
        CodexAppServerFixturePayload::ApprovalRequest {
            scope: ApprovalScope::FileChange,
            ..
        } => "item/fileChange/requestApproval",
        CodexAppServerFixturePayload::ApprovalRequest { .. } => "item/permissions/requestApproval",
        CodexAppServerFixturePayload::UserInputRequest { .. } => "item/tool/requestUserInput",
        CodexAppServerFixturePayload::InterruptionReceipt { .. } => "turn/interrupt",
        CodexAppServerFixturePayload::Warning { .. } => "warning",
        CodexAppServerFixturePayload::Error { .. } => "error",
    };

    if fixture.method == expected {
        Ok(())
    } else {
        Err(CodexFixtureMappingError {
            method: fixture.method.clone(),
            reason: format!("expected Codex app-server method {expected}"),
        })
    }
}

fn thread_event(
    fixture: &CodexAppServerEventFixture,
    kind: SessionPayloadKind,
    title: Option<String>,
    raw_label: &str,
) -> AdapterRuntimeEvent {
    canonical_event(
        fixture,
        RuntimeEventKind::Thread,
        RuntimeEventPayload::Thread(SessionPayload {
            kind,
            title,
            source: RuntimeEventSource::Replay,
            raw_provider_payload: raw_payload(fixture, raw_label),
        }),
    )
}

fn turn_event(
    fixture: &CodexAppServerEventFixture,
    kind: TurnPayloadKind,
    status_detail: Option<String>,
    raw_label: &str,
) -> AdapterRuntimeEvent {
    canonical_event(
        fixture,
        RuntimeEventKind::Turn,
        RuntimeEventPayload::Turn(TurnPayload {
            kind,
            status_detail,
            source: RuntimeEventSource::Replay,
            raw_provider_payload: raw_payload(fixture, raw_label),
        }),
    )
}

fn message_item_event(
    fixture: &CodexAppServerEventFixture,
    role: MessageRole,
    text: Option<String>,
    raw_label: &str,
) -> AdapterRuntimeEvent {
    canonical_event(
        fixture,
        RuntimeEventKind::MessageItem,
        RuntimeEventPayload::MessageItem(MessageItemPayload {
            role,
            text,
            source: RuntimeEventSource::Replay,
            raw_provider_payload: raw_payload(fixture, raw_label),
        }),
    )
}

fn content_delta_event(
    fixture: &CodexAppServerEventFixture,
    delta: String,
    accumulated: Option<String>,
) -> AdapterRuntimeEvent {
    canonical_event(
        fixture,
        RuntimeEventKind::ContentDelta,
        RuntimeEventPayload::ContentDelta(ContentDeltaPayload {
            format: DeltaFormat::Markdown,
            delta,
            accumulated,
            source: RuntimeEventSource::Replay,
            raw_provider_payload: raw_payload(fixture, "agent message delta"),
        }),
    )
}

fn tool_call_event(
    fixture: &CodexAppServerEventFixture,
    tool_name: String,
    arguments: Option<String>,
) -> AdapterRuntimeEvent {
    canonical_event(
        fixture,
        RuntimeEventKind::ToolCall,
        RuntimeEventPayload::ToolCall(ToolCallPayload {
            tool_name,
            status: ToolCallStatus::Started,
            arguments,
            result: None,
            source: RuntimeEventSource::Replay,
            raw_provider_payload: raw_payload(fixture, "tool call started"),
        }),
    )
}

fn approval_event(
    fixture: &CodexAppServerEventFixture,
    prompt: String,
    scope: ApprovalScope,
    options: Vec<String>,
) -> AdapterRuntimeEvent {
    canonical_event(
        fixture,
        RuntimeEventKind::PermissionRequest,
        RuntimeEventPayload::Approval(ApprovalPayload {
            prompt,
            scope,
            options,
            source: RuntimeEventSource::Replay,
            raw_provider_payload: raw_payload(fixture, "approval request"),
        }),
    )
}

fn user_input_event(
    fixture: &CodexAppServerEventFixture,
    prompt: String,
    kind: UserInputPromptKind,
    options: Vec<String>,
) -> AdapterRuntimeEvent {
    canonical_event(
        fixture,
        RuntimeEventKind::UserInputRequest,
        RuntimeEventPayload::UserInput(UserInputPayload {
            prompt,
            kind,
            options,
            source: RuntimeEventSource::Replay,
            raw_provider_payload: raw_payload(fixture, "user input request"),
        }),
    )
}

fn diagnostic_event(
    fixture: &CodexAppServerEventFixture,
    kind: RuntimeEventKind,
    payload: RuntimeEventPayload,
) -> AdapterRuntimeEvent {
    canonical_event(fixture, kind, payload)
}

fn canonical_event(
    fixture: &CodexAppServerEventFixture,
    kind: RuntimeEventKind,
    payload: RuntimeEventPayload,
) -> AdapterRuntimeEvent {
    AdapterRuntimeEvent {
        identity: runtime_event_identity(fixture),
        kind,
        payload,
    }
}

fn runtime_event_identity(fixture: &CodexAppServerEventFixture) -> RuntimeEventIdentity {
    RuntimeEventIdentity {
        nucleus_event_id: format!(
            "event:{}:{}",
            fixture.nucleus_session_id.0, fixture.sequence
        ),
        provider_driver_kind: ProviderDriverKind::Codex,
        provider_instance_id: fixture.provider_instance_id.clone(),
        provider_session_id: fixture.provider_refs.session_id.clone(),
        nucleus_session_id: fixture.nucleus_session_id.0.clone(),
        provider_message_id: fixture.provider_refs.item_id.clone(),
        nucleus_message_id: fixture
            .provider_refs
            .item_id
            .as_ref()
            .map(|item_id| format!("message:{}:{item_id}", fixture.nucleus_session_id.0)),
        turn_id: fixture
            .provider_refs
            .turn_id
            .as_ref()
            .map(|turn_id| format!("turn:{}:{turn_id}", fixture.nucleus_session_id.0)),
        item_id: fixture
            .provider_refs
            .item_id
            .as_ref()
            .map(|item_id| format!("item:{}:{item_id}", fixture.nucleus_session_id.0)),
        request_id: fixture
            .provider_refs
            .request_id
            .as_ref()
            .map(|request_id| format!("request:{}:{request_id}", fixture.nucleus_session_id.0)),
        provider_turn_id: fixture.provider_refs.turn_id.clone(),
        provider_item_id: fixture.provider_refs.item_id.clone(),
        provider_request_id: fixture.provider_refs.request_id.clone(),
        event_sequence: fixture.sequence,
        parent_event_id: None,
        synthetic: true,
    }
}

fn raw_payload(
    fixture: &CodexAppServerEventFixture,
    fallback_label: &str,
) -> Option<RawProviderPayload> {
    Some(RawProviderPayload {
        format: "codex-app-server.fixture.v1".to_owned(),
        body: fixture
            .raw_payload
            .clone()
            .unwrap_or_else(|| format!("{}:{fallback_label}", fixture.method)),
    })
}

fn interruption_receipt_fixture(
    fixture: &CodexAppServerEventFixture,
    summary: String,
) -> CodexRuntimeReceiptFixture {
    CodexRuntimeReceiptFixture {
        receipt_id: format!(
            "receipt:{}:{}",
            fixture.nucleus_session_id.0, fixture.sequence
        ),
        provider_instance_id: fixture.provider_instance_id.clone(),
        nucleus_session_id: fixture.nucleus_session_id.clone(),
        provider_refs: fixture.provider_refs.clone(),
        status: CodexRuntimeReceiptStatus::Cancelled,
        evidence_event_id: Some(format!(
            "event:{}:{}",
            fixture.nucleus_session_id.0, fixture.sequence
        )),
        summary,
    }
}
