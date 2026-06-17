//! Codex app-server lifecycle method mappings.

use crate::capabilities::CapabilitySupport;
use crate::sessions::SessionLifecycleAction;

use super::types::CodexLifecycleActionMapping;

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
