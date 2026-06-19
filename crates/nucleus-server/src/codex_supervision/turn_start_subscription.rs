//! Codex stdio write and subscription state records.
//!
//! These records describe provider-send write/subscription state. They do not
//! write bytes, read streams, retain raw payloads, answer callbacks, or mutate
//! task state.

use super::turn_start_send_command::CodexAppServerTurnStartSendCommandRecord;

/// Stable id for one stdio write state record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerStdioWriteStateId(pub String);

/// Stable id for one subscription state record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerSubscriptionStateId(pub String);

/// Stdio write state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerStdioWriteState {
    Queued,
    Written,
    Blocked(String),
    Failed(String),
}

/// Subscription lifecycle state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerSubscriptionState {
    Pending,
    Open,
    Closed,
    Blocked(String),
    Failed(String),
    RecoveryRequired(String),
}

/// Sanitized stdio write state record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerStdioWriteStateRecord {
    pub write_id: CodexAppServerStdioWriteStateId,
    pub command_id: String,
    pub envelope_id: String,
    pub request_id: String,
    pub method: String,
    pub state: CodexAppServerStdioWriteState,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
}

/// Sanitized subscription state record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSubscriptionStateRecord {
    pub subscription_id: CodexAppServerSubscriptionStateId,
    pub command_id: String,
    pub envelope_id: String,
    pub request_id: String,
    pub state: CodexAppServerSubscriptionState,
    pub evidence_refs: Vec<String>,
    pub raw_stream_retained: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub task_mutation_permitted: bool,
}

/// Build a sanitized stdio write state record from a provider-send command.
pub fn codex_stdio_write_state_from_send_command(
    command: &CodexAppServerTurnStartSendCommandRecord,
    state: CodexAppServerStdioWriteState,
) -> CodexAppServerStdioWriteStateRecord {
    CodexAppServerStdioWriteStateRecord {
        write_id: CodexAppServerStdioWriteStateId(format!(
            "codex-stdio-write:{}",
            command.command_id.0
        )),
        command_id: command.command_id.0.clone(),
        envelope_id: command.envelope_id.clone(),
        request_id: command.request_id.clone(),
        method: command.method.clone(),
        state,
        evidence_refs: command.evidence_refs.clone(),
        raw_payload_retained: false,
        raw_stream_retained: false,
    }
}

/// Build a sanitized subscription state record from a provider-send command.
pub fn codex_subscription_state_from_send_command(
    command: &CodexAppServerTurnStartSendCommandRecord,
    state: CodexAppServerSubscriptionState,
) -> CodexAppServerSubscriptionStateRecord {
    CodexAppServerSubscriptionStateRecord {
        subscription_id: CodexAppServerSubscriptionStateId(format!(
            "codex-subscription:{}",
            command.command_id.0
        )),
        command_id: command.command_id.0.clone(),
        envelope_id: command.envelope_id.clone(),
        request_id: command.request_id.clone(),
        state,
        evidence_refs: command.evidence_refs.clone(),
        raw_stream_retained: false,
        callback_response_permitted: false,
        cancellation_permitted: false,
        task_mutation_permitted: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        CodexAppServerPayloadRetentionPolicy, CodexAppServerTurnStartSendCommandId,
        CodexAppServerTurnStartSendCommandRecord, CodexAppServerTurnStartWriteTarget,
    };

    fn command() -> CodexAppServerTurnStartSendCommandRecord {
        CodexAppServerTurnStartSendCommandRecord {
            command_id: CodexAppServerTurnStartSendCommandId("send:1".to_owned()),
            envelope_id: "envelope:1".to_owned(),
            request_id: "request:1".to_owned(),
            method: "turn/start".to_owned(),
            write_target: CodexAppServerTurnStartWriteTarget::Stdio,
            payload_retention: CodexAppServerPayloadRetentionPolicy::MetadataOnly,
            evidence_refs: vec!["evidence:send".to_owned()],
            raw_payload_retained: false,
            provider_write_started: false,
            callback_response_permitted: false,
            cancellation_permitted: false,
            task_mutation_permitted: false,
        }
    }

    #[test]
    fn stdio_write_state_records_refs_without_raw_streams() {
        let record = codex_stdio_write_state_from_send_command(
            &command(),
            CodexAppServerStdioWriteState::Queued,
        );

        assert_eq!(record.command_id, "send:1");
        assert_eq!(record.method, "turn/start");
        assert_eq!(record.evidence_refs, vec!["evidence:send".to_owned()]);
        assert!(!record.raw_payload_retained);
        assert!(!record.raw_stream_retained);
    }

    #[test]
    fn subscription_state_blocks_callback_cancellation_and_task_mutation() {
        let record = codex_subscription_state_from_send_command(
            &command(),
            CodexAppServerSubscriptionState::Open,
        );

        assert_eq!(record.command_id, "send:1");
        assert!(!record.raw_stream_retained);
        assert!(!record.callback_response_permitted);
        assert!(!record.cancellation_permitted);
        assert!(!record.task_mutation_permitted);
    }
}
