//! Type-only Codex app-server lifecycle and fixture-event mapping.

use crate::capabilities::CapabilitySupport;
use crate::events::{
    ApprovalPayload, ApprovalScope, ContentDeltaPayload, DeltaFormat, MessageItemPayload,
    MessageRole, RawProviderPayload, RuntimeDiagnosticPayload, RuntimeEventIdentity,
    RuntimeEventKind, RuntimeEventPayload, RuntimeEventSource, SessionPayload, SessionPayloadKind,
    Severity, ToolCallPayload, ToolCallStatus, TurnPayload, TurnPayloadKind, UserInputPayload,
    UserInputPromptKind,
};
use crate::identity::ProviderDriverKind;
use crate::sessions::{
    AgentSessionId, AgentSessionRecoveryState, AgentTurnId, SessionLifecycleAction,
};
use crate::traits::AdapterRuntimeEvent;

/// Provider-native Codex app-server refs retained beside Nucleus ids.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerProviderRefs {
    pub thread_id: Option<String>,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub request_id: Option<String>,
}

/// Source for one Codex id mapping.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexIdSource {
    Provider,
    Nucleus,
    SyntheticMarked,
    Unavailable,
}

/// Snapshot binding one Nucleus session to Codex app-server identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSessionBinding {
    pub nucleus_session_id: AgentSessionId,
    pub nucleus_turn_id: Option<AgentTurnId>,
    pub provider_refs: CodexAppServerProviderRefs,
    pub thread_id_source: CodexIdSource,
    pub turn_id_source: CodexIdSource,
    pub request_id_source: CodexIdSource,
    pub recovery_state: AgentSessionRecoveryState,
}

/// Mapping from a Nucleus lifecycle action to a Codex app-server method.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexLifecycleActionMapping {
    pub action: SessionLifecycleAction,
    pub provider_method: String,
    pub support: CapabilitySupport,
    pub requires_thread_id: bool,
    pub requires_turn_id: bool,
    pub notes: Option<String>,
}

/// Explicit recovery fallback when Codex resume cannot preserve a thread.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRecoveryFallback {
    pub nucleus_session_id: AgentSessionId,
    pub requested_thread_id: Option<String>,
    pub replacement_thread_id: Option<String>,
    pub reason: String,
    pub recovery_state: AgentSessionRecoveryState,
}

/// Static Codex-shaped event fixture used before live app-server streaming.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerEventFixture {
    pub method: String,
    pub provider_instance_id: String,
    pub nucleus_session_id: AgentSessionId,
    pub provider_refs: CodexAppServerProviderRefs,
    pub sequence: u64,
    pub payload: CodexAppServerFixturePayload,
    pub raw_payload: Option<String>,
}

/// Fixture payloads from the verified Codex app-server method subset.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerFixturePayload {
    ThreadStarted {
        title: Option<String>,
    },
    ThreadResumed,
    TurnStarted,
    TurnCompleted {
        status_detail: Option<String>,
    },
    ItemStarted {
        role: MessageRole,
        text: Option<String>,
    },
    AgentMessageDelta {
        delta: String,
        accumulated: Option<String>,
    },
    ToolCallStarted {
        tool_name: String,
        arguments: Option<String>,
    },
    ApprovalRequest {
        prompt: String,
        scope: ApprovalScope,
        options: Vec<String>,
    },
    UserInputRequest {
        prompt: String,
        kind: UserInputPromptKind,
        options: Vec<String>,
    },
    InterruptionReceipt {
        summary: String,
    },
    Warning {
        message: String,
    },
    Error {
        message: String,
    },
}

/// Result of projecting a static Codex fixture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerFixtureProjection {
    Event(AdapterRuntimeEvent),
    RuntimeReceipt(CodexRuntimeReceiptFixture),
}

/// Server-owned wait state created by a Codex app-server callback.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexServerOwnedWaitState {
    Approval,
    UserInput,
}

/// Receipt fixture for Codex runtime effects that do not become messages.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRuntimeReceiptFixture {
    pub receipt_id: String,
    pub provider_instance_id: String,
    pub nucleus_session_id: AgentSessionId,
    pub provider_refs: CodexAppServerProviderRefs,
    pub status: CodexRuntimeReceiptStatus,
    pub evidence_event_id: Option<String>,
    pub summary: String,
}

/// Provider-runtime receipt status vocabulary needed by Codex fixtures.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexRuntimeReceiptStatus {
    WaitingForApproval,
    WaitingForUserInput,
    Cancelled,
    Completed,
    Failed,
}

/// Explicit fixture mapping failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexFixtureMappingError {
    pub method: String,
    pub reason: String,
}

pub fn codex_app_server_lifecycle_mappings() -> Vec<CodexLifecycleActionMapping> {
    vec![
        CodexLifecycleActionMapping {
            action: SessionLifecycleAction::Create,
            provider_method: "thread/start".to_owned(),
            support: CapabilitySupport::Supported,
            requires_thread_id: false,
            requires_turn_id: false,
            notes: None,
        },
        CodexLifecycleActionMapping {
            action: SessionLifecycleAction::Resume,
            provider_method: "thread/resume".to_owned(),
            support: CapabilitySupport::Supported,
            requires_thread_id: true,
            requires_turn_id: false,
            notes: Some("prefer provider thread id where available".to_owned()),
        },
        CodexLifecycleActionMapping {
            action: SessionLifecycleAction::SendTurn,
            provider_method: "turn/start".to_owned(),
            support: CapabilitySupport::Supported,
            requires_thread_id: true,
            requires_turn_id: false,
            notes: None,
        },
        CodexLifecycleActionMapping {
            action: SessionLifecycleAction::Steer,
            provider_method: "turn/steer".to_owned(),
            support: CapabilitySupport::Supported,
            requires_thread_id: true,
            requires_turn_id: true,
            notes: Some("only while the active turn accepts steering".to_owned()),
        },
        CodexLifecycleActionMapping {
            action: SessionLifecycleAction::Interrupt,
            provider_method: "turn/interrupt".to_owned(),
            support: CapabilitySupport::Supported,
            requires_thread_id: true,
            requires_turn_id: true,
            notes: None,
        },
        CodexLifecycleActionMapping {
            action: SessionLifecycleAction::Rollback,
            provider_method: "thread/rollback".to_owned(),
            support: CapabilitySupport::Partial(
                "provider rollback is lossy transcript rollback, not filesystem rollback"
                    .to_owned(),
            ),
            requires_thread_id: true,
            requires_turn_id: false,
            notes: Some("do not present as checkpoint or SCM rollback".to_owned()),
        },
        CodexLifecycleActionMapping {
            action: SessionLifecycleAction::RespondToApproval,
            provider_method: "server request response".to_owned(),
            support: CapabilitySupport::Supported,
            requires_thread_id: true,
            requires_turn_id: false,
            notes: Some("correlate through app-server request id and item id".to_owned()),
        },
        CodexLifecycleActionMapping {
            action: SessionLifecycleAction::RespondToUserInput,
            provider_method: "server request response".to_owned(),
            support: CapabilitySupport::Partial(
                "item/tool/requestUserInput is experimental in generated schema".to_owned(),
            ),
            requires_thread_id: true,
            requires_turn_id: false,
            notes: Some("correlate through app-server request id and item id".to_owned()),
        },
        CodexLifecycleActionMapping {
            action: SessionLifecycleAction::Close,
            provider_method: "thread/unsubscribe".to_owned(),
            support: CapabilitySupport::Supported,
            requires_thread_id: true,
            requires_turn_id: false,
            notes: Some("unsubscribe is not provider transcript deletion".to_owned()),
        },
        CodexLifecycleActionMapping {
            action: SessionLifecycleAction::Recover,
            provider_method: "thread/resume".to_owned(),
            support: CapabilitySupport::Supported,
            requires_thread_id: true,
            requires_turn_id: false,
            notes: Some("fallback to fresh thread must be recorded explicitly".to_owned()),
        },
    ]
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn refs() -> CodexAppServerProviderRefs {
        CodexAppServerProviderRefs {
            thread_id: Some("thread:provider".to_owned()),
            session_id: Some("session:provider".to_owned()),
            turn_id: Some("turn:provider".to_owned()),
            item_id: Some("item:provider".to_owned()),
            request_id: Some("request:provider".to_owned()),
        }
    }

    fn fixture(method: &str, payload: CodexAppServerFixturePayload) -> CodexAppServerEventFixture {
        CodexAppServerEventFixture {
            method: method.to_owned(),
            provider_instance_id: "adapter:codex-app-server".to_owned(),
            nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
            provider_refs: refs(),
            sequence: 7,
            payload,
            raw_payload: Some(format!("{method}:sanitized-fixture")),
        }
    }

    #[test]
    fn codex_lifecycle_mappings_name_verified_methods() {
        let mappings = codex_app_server_lifecycle_mappings();

        assert!(mappings.iter().any(|mapping| {
            mapping.action == SessionLifecycleAction::Create
                && mapping.provider_method == "thread/start"
        }));
        assert!(mappings.iter().any(|mapping| {
            mapping.action == SessionLifecycleAction::Resume
                && mapping.provider_method == "thread/resume"
                && mapping.requires_thread_id
        }));
        assert!(mappings.iter().any(|mapping| {
            mapping.action == SessionLifecycleAction::Interrupt
                && mapping.provider_method == "turn/interrupt"
                && mapping.requires_turn_id
        }));
    }

    #[test]
    fn codex_session_binding_keeps_nucleus_session_authoritative() {
        let binding = CodexAppServerSessionBinding {
            nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
            nucleus_turn_id: Some(AgentTurnId("turn:nucleus".to_owned())),
            provider_refs: CodexAppServerProviderRefs {
                thread_id: Some("thr_provider".to_owned()),
                session_id: Some("thr_root".to_owned()),
                turn_id: Some("turn_provider".to_owned()),
                item_id: Some("item_provider".to_owned()),
                request_id: Some("request_provider".to_owned()),
            },
            thread_id_source: CodexIdSource::Provider,
            turn_id_source: CodexIdSource::Provider,
            request_id_source: CodexIdSource::Provider,
            recovery_state: AgentSessionRecoveryState::Recoverable,
        };

        assert_eq!(binding.nucleus_session_id.0, "session:nucleus");
        assert_eq!(
            binding.provider_refs.thread_id.as_deref(),
            Some("thr_provider")
        );
        assert_ne!(
            binding.nucleus_session_id.0,
            binding.provider_refs.thread_id.unwrap()
        );
    }

    #[test]
    fn codex_resume_fallback_is_explicit_recovery_state() {
        let fallback = CodexRecoveryFallback {
            nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
            requested_thread_id: Some("thr_old".to_owned()),
            replacement_thread_id: Some("thr_new".to_owned()),
            reason: "thread/resume failed recoverably".to_owned(),
            recovery_state: AgentSessionRecoveryState::RecoveryRequired,
        };

        assert_eq!(fallback.requested_thread_id.as_deref(), Some("thr_old"));
        assert_eq!(fallback.replacement_thread_id.as_deref(), Some("thr_new"));
        assert!(matches!(
            fallback.recovery_state,
            AgentSessionRecoveryState::RecoveryRequired
        ));
    }

    #[test]
    fn codex_fixture_projects_thread_turn_and_delta_events() {
        let thread = project_codex_app_server_fixture(fixture(
            "thread/started",
            CodexAppServerFixturePayload::ThreadStarted {
                title: Some("bootstrap".to_owned()),
            },
        ))
        .expect("thread fixture");
        let turn = project_codex_app_server_fixture(fixture(
            "turn/completed",
            CodexAppServerFixturePayload::TurnCompleted {
                status_detail: Some("completed".to_owned()),
            },
        ))
        .expect("turn fixture");
        let delta = project_codex_app_server_fixture(fixture(
            "item/agentMessage/delta",
            CodexAppServerFixturePayload::AgentMessageDelta {
                delta: "hello".to_owned(),
                accumulated: Some("hello".to_owned()),
            },
        ))
        .expect("delta fixture");

        assert!(matches!(
            thread,
            CodexAppServerFixtureProjection::Event(AdapterRuntimeEvent {
                kind: RuntimeEventKind::Thread,
                ..
            })
        ));
        assert!(matches!(
            turn,
            CodexAppServerFixtureProjection::Event(AdapterRuntimeEvent {
                payload: RuntimeEventPayload::Turn(TurnPayload {
                    kind: TurnPayloadKind::Completed,
                    ..
                }),
                ..
            })
        ));
        assert!(matches!(
            delta,
            CodexAppServerFixtureProjection::Event(AdapterRuntimeEvent {
                payload: RuntimeEventPayload::ContentDelta(ContentDeltaPayload {
                    format: DeltaFormat::Markdown,
                    ..
                }),
                ..
            })
        ));
    }

    #[test]
    fn codex_fixture_projects_server_owned_wait_states() {
        let approval = project_codex_app_server_fixture(fixture(
            "item/commandExecution/requestApproval",
            CodexAppServerFixturePayload::ApprovalRequest {
                prompt: "run command?".to_owned(),
                scope: ApprovalScope::Command,
                options: vec!["approve".to_owned(), "deny".to_owned()],
            },
        ))
        .expect("approval fixture");
        let input = project_codex_app_server_fixture(fixture(
            "item/tool/requestUserInput",
            CodexAppServerFixturePayload::UserInputRequest {
                prompt: "choose".to_owned(),
                kind: UserInputPromptKind::SelectOne,
                options: vec!["a".to_owned(), "b".to_owned()],
            },
        ))
        .expect("user input fixture");

        assert!(matches!(
            approval,
            CodexAppServerFixtureProjection::Event(AdapterRuntimeEvent {
                kind: RuntimeEventKind::PermissionRequest,
                payload: RuntimeEventPayload::Approval(ApprovalPayload {
                    scope: ApprovalScope::Command,
                    ..
                }),
                ..
            })
        ));
        assert!(matches!(
            input,
            CodexAppServerFixtureProjection::Event(AdapterRuntimeEvent {
                kind: RuntimeEventKind::UserInputRequest,
                payload: RuntimeEventPayload::UserInput(UserInputPayload {
                    kind: UserInputPromptKind::SelectOne,
                    ..
                }),
                ..
            })
        ));
    }

    #[test]
    fn codex_fixture_projects_interruption_as_receipt_fixture() {
        let projected = project_codex_app_server_fixture(fixture(
            "turn/interrupt",
            CodexAppServerFixturePayload::InterruptionReceipt {
                summary: "turn interrupted by operator".to_owned(),
            },
        ))
        .expect("interruption fixture");

        assert!(matches!(
            projected,
            CodexAppServerFixtureProjection::RuntimeReceipt(CodexRuntimeReceiptFixture {
                status: CodexRuntimeReceiptStatus::Cancelled,
                ..
            })
        ));
    }

    #[test]
    fn codex_fixture_rejects_unexpected_methods() {
        let error = project_codex_app_server_fixture(fixture(
            "item/unknown",
            CodexAppServerFixturePayload::ToolCallStarted {
                tool_name: "shell".to_owned(),
                arguments: None,
            },
        ))
        .expect_err("unexpected method must fail closed");

        assert_eq!(error.method, "item/unknown");
        assert!(error.reason.contains("item/tool/call"));
    }
}
