//! Codex app-server wait-state routing records.
//!
//! These records describe server-owned waits created from decoded Codex
//! callbacks. They do not answer provider callbacks, mutate UI state, or imply
//! task acceptance.

use nucleus_agent_protocol::{
    AdapterRuntimeEvent, ApprovalPayload, RuntimeEventKind, RuntimeEventPayload, UserInputPayload,
};
use nucleus_engine::{
    runtime_receipt_from_codex_fixture, EngineRuntimeReceiptRecord, EngineRuntimeReceiptStatus,
};

use crate::codex_supervision::{CodexAppServerLiveIngestion, CodexAppServerLiveProjection};

/// Server-owned wait produced by a Codex callback event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexWaitStateRecord {
    pub wait_id: String,
    pub kind: CodexWaitStateKind,
    pub status: CodexWaitStateStatus,
    pub provider_instance_id: String,
    pub nucleus_session_id: String,
    pub provider_session_id: Option<String>,
    pub provider_turn_id: Option<String>,
    pub provider_item_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub evidence_event_id: String,
    pub prompt: String,
    pub options: Vec<String>,
}

/// Supported Codex wait classes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexWaitStateKind {
    Approval,
    UserInput,
}

/// Local lifecycle for a server-owned wait.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexWaitStateStatus {
    Waiting,
    Cancelled,
    TimedOut,
}

/// Routing result for one live Codex ingestion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexWaitStateRouting {
    pub wait_state: Option<CodexWaitStateRecord>,
    pub runtime_receipt: Option<EngineRuntimeReceiptRecord>,
}

/// Terminal wait outcome converted to a receipt-like control record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexWaitStateTerminalRouting {
    pub wait_state: CodexWaitStateRecord,
    pub runtime_receipt: EngineRuntimeReceiptRecord,
}

/// Convert an accepted live Codex callback into a server-owned wait state.
pub fn route_codex_wait_state_from_ingestion(
    ingestion: &CodexAppServerLiveIngestion,
) -> CodexWaitStateRouting {
    let Some(CodexAppServerLiveProjection::Event(event)) = &ingestion.projection else {
        return CodexWaitStateRouting {
            wait_state: None,
            runtime_receipt: None,
        };
    };

    match (&event.kind, &event.payload) {
        (RuntimeEventKind::PermissionRequest, RuntimeEventPayload::Approval(approval_payload)) => {
            route_approval_wait(event, approval_payload)
        }
        (
            RuntimeEventKind::UserInputRequest,
            RuntimeEventPayload::UserInput(user_input_payload),
        ) => route_user_input_wait(event, user_input_payload),
        _ => CodexWaitStateRouting {
            wait_state: None,
            runtime_receipt: None,
        },
    }
}

/// Mark a wait as cancelled without changing the evidence event identity.
pub fn cancel_codex_wait_state(wait_state: &CodexWaitStateRecord) -> CodexWaitStateTerminalRouting {
    terminal_wait_state(wait_state, CodexWaitStateStatus::Cancelled)
}

/// Mark a wait as timed out without changing the evidence event identity.
pub fn time_out_codex_wait_state(
    wait_state: &CodexWaitStateRecord,
) -> CodexWaitStateTerminalRouting {
    terminal_wait_state(wait_state, CodexWaitStateStatus::TimedOut)
}

fn route_approval_wait(
    event: &AdapterRuntimeEvent,
    payload: &ApprovalPayload,
) -> CodexWaitStateRouting {
    let wait_state = wait_state_from_event(
        event,
        CodexWaitStateKind::Approval,
        payload.prompt.clone(),
        payload.options.clone(),
    );
    let runtime_receipt =
        runtime_receipt_from_codex_fixture(&nucleus_agent_protocol::CodexRuntimeReceiptFixture {
            receipt_id: receipt_id(&wait_state, "waiting"),
            provider_instance_id: wait_state.provider_instance_id.clone(),
            nucleus_session_id: nucleus_agent_protocol::AgentSessionId(
                wait_state.nucleus_session_id.clone(),
            ),
            provider_refs: provider_refs(&wait_state),
            status: nucleus_agent_protocol::CodexRuntimeReceiptStatus::WaitingForApproval,
            evidence_event_id: Some(wait_state.evidence_event_id.clone()),
            summary: "waiting for operator approval".to_owned(),
        });

    CodexWaitStateRouting {
        wait_state: Some(wait_state),
        runtime_receipt: Some(runtime_receipt),
    }
}

fn route_user_input_wait(
    event: &AdapterRuntimeEvent,
    payload: &UserInputPayload,
) -> CodexWaitStateRouting {
    let wait_state = wait_state_from_event(
        event,
        CodexWaitStateKind::UserInput,
        payload.prompt.clone(),
        payload.options.clone(),
    );
    let runtime_receipt =
        runtime_receipt_from_codex_fixture(&nucleus_agent_protocol::CodexRuntimeReceiptFixture {
            receipt_id: receipt_id(&wait_state, "waiting"),
            provider_instance_id: wait_state.provider_instance_id.clone(),
            nucleus_session_id: nucleus_agent_protocol::AgentSessionId(
                wait_state.nucleus_session_id.clone(),
            ),
            provider_refs: provider_refs(&wait_state),
            status: nucleus_agent_protocol::CodexRuntimeReceiptStatus::WaitingForUserInput,
            evidence_event_id: Some(wait_state.evidence_event_id.clone()),
            summary: "waiting for structured user input".to_owned(),
        });

    CodexWaitStateRouting {
        wait_state: Some(wait_state),
        runtime_receipt: Some(runtime_receipt),
    }
}

fn terminal_wait_state(
    wait_state: &CodexWaitStateRecord,
    status: CodexWaitStateStatus,
) -> CodexWaitStateTerminalRouting {
    let mut terminal_wait = wait_state.clone();
    terminal_wait.status = status;
    let receipt_status = match terminal_wait.status {
        CodexWaitStateStatus::Waiting => EngineRuntimeReceiptStatus::Unknown,
        CodexWaitStateStatus::Cancelled => EngineRuntimeReceiptStatus::Cancelled,
        CodexWaitStateStatus::TimedOut => EngineRuntimeReceiptStatus::TimedOut,
    };
    let mut runtime_receipt =
        runtime_receipt_from_codex_fixture(&nucleus_agent_protocol::CodexRuntimeReceiptFixture {
            receipt_id: receipt_id(
                &terminal_wait,
                terminal_receipt_suffix(&terminal_wait.status),
            ),
            provider_instance_id: terminal_wait.provider_instance_id.clone(),
            nucleus_session_id: nucleus_agent_protocol::AgentSessionId(
                terminal_wait.nucleus_session_id.clone(),
            ),
            provider_refs: provider_refs(&terminal_wait),
            status: nucleus_agent_protocol::CodexRuntimeReceiptStatus::Failed,
            evidence_event_id: Some(terminal_wait.evidence_event_id.clone()),
            summary: terminal_summary(&terminal_wait.status),
        });
    runtime_receipt.status = receipt_status;

    CodexWaitStateTerminalRouting {
        wait_state: terminal_wait,
        runtime_receipt,
    }
}

fn wait_state_from_event(
    event: &AdapterRuntimeEvent,
    kind: CodexWaitStateKind,
    prompt: String,
    options: Vec<String>,
) -> CodexWaitStateRecord {
    CodexWaitStateRecord {
        wait_id: format!("wait:{}", event.identity.nucleus_event_id),
        kind,
        status: CodexWaitStateStatus::Waiting,
        provider_instance_id: event.identity.provider_instance_id.clone(),
        nucleus_session_id: event.identity.nucleus_session_id.clone(),
        provider_session_id: event.identity.provider_session_id.clone(),
        provider_turn_id: event.identity.provider_turn_id.clone(),
        provider_item_id: event.identity.provider_item_id.clone(),
        provider_request_id: event.identity.provider_request_id.clone(),
        evidence_event_id: event.identity.nucleus_event_id.clone(),
        prompt,
        options,
    }
}

fn receipt_id(wait_state: &CodexWaitStateRecord, suffix: &str) -> String {
    format!("receipt:{}:{suffix}", wait_state.wait_id)
}

fn terminal_receipt_suffix(status: &CodexWaitStateStatus) -> &'static str {
    match status {
        CodexWaitStateStatus::Waiting => "waiting",
        CodexWaitStateStatus::Cancelled => "cancelled",
        CodexWaitStateStatus::TimedOut => "timed-out",
    }
}

fn terminal_summary(status: &CodexWaitStateStatus) -> String {
    match status {
        CodexWaitStateStatus::Waiting => "waiting for operator response".to_owned(),
        CodexWaitStateStatus::Cancelled => {
            "wait state cancelled before provider response".to_owned()
        }
        CodexWaitStateStatus::TimedOut => {
            "wait state timed out before provider response".to_owned()
        }
    }
}

fn provider_refs(
    wait_state: &CodexWaitStateRecord,
) -> nucleus_agent_protocol::CodexAppServerProviderRefs {
    nucleus_agent_protocol::CodexAppServerProviderRefs {
        thread_id: wait_state.provider_session_id.clone(),
        session_id: wait_state.provider_session_id.clone(),
        turn_id: wait_state.provider_turn_id.clone(),
        item_id: wait_state.provider_item_id.clone(),
        request_id: wait_state.provider_request_id.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::{
        AgentSessionId, ApprovalScope, CodexAppServerEventFixture, CodexAppServerFixturePayload,
        CodexAppServerProviderRefs, UserInputPromptKind,
    };
    use nucleus_engine::EngineRuntimeReceiptRef;

    use crate::codex_supervision::{ingest_codex_app_server_live_frame, CodexAppServerLiveFrame};

    fn frame(method: &str, payload: CodexAppServerFixturePayload) -> CodexAppServerLiveFrame {
        CodexAppServerLiveFrame {
            fixture: CodexAppServerEventFixture {
                method: method.to_owned(),
                provider_instance_id: "codex:local-default".to_owned(),
                nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
                provider_refs: CodexAppServerProviderRefs {
                    thread_id: Some("thread:provider".to_owned()),
                    session_id: Some("session:provider".to_owned()),
                    turn_id: Some("turn:provider".to_owned()),
                    item_id: Some("item:provider".to_owned()),
                    request_id: Some("request:provider".to_owned()),
                },
                sequence: 17,
                payload,
                raw_payload: None,
            },
            transport_sequence: 31,
        }
    }

    #[test]
    fn approval_callback_becomes_server_owned_wait_state_and_receipt() {
        let ingestion = ingest_codex_app_server_live_frame(frame(
            "item/commandExecution/requestApproval",
            CodexAppServerFixturePayload::ApprovalRequest {
                prompt: "run command?".to_owned(),
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned(), "deny".to_owned()],
            },
        ));

        let routing = route_codex_wait_state_from_ingestion(&ingestion);
        let wait_state = routing.wait_state.expect("wait state");
        let receipt = routing.runtime_receipt.expect("runtime receipt");

        assert_eq!(wait_state.kind, CodexWaitStateKind::Approval);
        assert_eq!(wait_state.status, CodexWaitStateStatus::Waiting);
        assert_eq!(
            wait_state.provider_request_id.as_deref(),
            Some("request:provider")
        );
        assert_eq!(
            receipt.status,
            EngineRuntimeReceiptStatus::WaitingForApproval
        );
        assert_eq!(
            receipt.evidence_refs,
            vec![EngineRuntimeReceiptRef::EventId(
                wait_state.evidence_event_id.clone()
            )]
        );
    }

    #[test]
    fn user_input_callback_becomes_distinct_wait_state() {
        let ingestion = ingest_codex_app_server_live_frame(frame(
            "item/tool/requestUserInput",
            CodexAppServerFixturePayload::UserInputRequest {
                prompt: "choose".to_owned(),
                kind: UserInputPromptKind::SelectOne,
                options: vec!["a".to_owned(), "b".to_owned()],
            },
        ));

        let routing = route_codex_wait_state_from_ingestion(&ingestion);

        assert!(matches!(
            routing.wait_state,
            Some(CodexWaitStateRecord {
                kind: CodexWaitStateKind::UserInput,
                ..
            })
        ));
        assert!(matches!(
            routing.runtime_receipt,
            Some(EngineRuntimeReceiptRecord {
                status: EngineRuntimeReceiptStatus::WaitingForUserInput,
                ..
            })
        ));
    }

    #[test]
    fn non_wait_events_do_not_create_wait_state() {
        let ingestion = ingest_codex_app_server_live_frame(frame(
            "item/agentMessage/delta",
            CodexAppServerFixturePayload::AgentMessageDelta {
                delta: "hello".to_owned(),
                accumulated: Some("hello".to_owned()),
            },
        ));

        let routing = route_codex_wait_state_from_ingestion(&ingestion);

        assert!(routing.wait_state.is_none());
        assert!(routing.runtime_receipt.is_none());
    }

    #[test]
    fn wait_state_cancel_and_timeout_preserve_evidence_identity() {
        let ingestion = ingest_codex_app_server_live_frame(frame(
            "item/commandExecution/requestApproval",
            CodexAppServerFixturePayload::ApprovalRequest {
                prompt: "run command?".to_owned(),
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned(), "deny".to_owned()],
            },
        ));
        let wait_state = route_codex_wait_state_from_ingestion(&ingestion)
            .wait_state
            .expect("wait state");

        let cancelled = cancel_codex_wait_state(&wait_state);
        let timed_out = time_out_codex_wait_state(&wait_state);

        assert_eq!(
            cancelled.wait_state.evidence_event_id,
            wait_state.evidence_event_id
        );
        assert_eq!(
            cancelled.runtime_receipt.status,
            EngineRuntimeReceiptStatus::Cancelled
        );
        assert_eq!(
            timed_out.wait_state.evidence_event_id,
            wait_state.evidence_event_id
        );
        assert_eq!(
            timed_out.runtime_receipt.status,
            EngineRuntimeReceiptStatus::TimedOut
        );
    }
}
