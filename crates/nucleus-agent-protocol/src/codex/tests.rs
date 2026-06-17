use super::*;
use crate::events::{
    ApprovalPayload, ApprovalScope, ContentDeltaPayload, DeltaFormat, RuntimeEventKind,
    RuntimeEventPayload, TurnPayload, TurnPayloadKind, UserInputPayload, UserInputPromptKind,
};
use crate::sessions::{
    AgentSessionId, AgentSessionRecoveryState, AgentTurnId, SessionLifecycleAction,
};
use crate::traits::AdapterRuntimeEvent;

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
