use nucleus_agent_protocol::{
    AdapterIdentity, AgentSessionId, AgentSessionRecoveryState, AuthenticationPreflight,
    CodexAppServerProviderRefs, ProviderDriverKind, TransportFamily, VersionDiscovery,
};
use nucleus_engine::EngineTaskWorkItemId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::host_authority::EngineHostId;

use super::{
    codex_runtime_instance_from_supervision_request, CodexAppServerBinary,
    CodexAppServerBindingConfidence, CodexAppServerBindingStatus, CodexAppServerCallbackPromptRef,
    CodexAppServerCallbackPromptRetentionPolicy, CodexAppServerInterruptionReasonRef,
    CodexAppServerInterruptionReasonRetentionPolicy, CodexAppServerInterruptionTarget,
    CodexAppServerPayloadRetentionPolicy, CodexAppServerRuntimeInstanceRecord,
    CodexAppServerRuntimeInstanceState, CodexAppServerSchemaEvidenceRef,
    CodexAppServerSessionBindingId, CodexAppServerSessionBindingRecord,
    CodexAppServerSupervisionLimits, CodexAppServerSupervisionRequest,
};

pub fn runtime() -> CodexAppServerRuntimeInstanceRecord {
    codex_runtime_instance_from_supervision_request(
        &supervision_request(),
        CodexAppServerRuntimeInstanceState::ReadyForSpawn,
    )
}

pub fn supervision_request() -> CodexAppServerSupervisionRequest {
    CodexAppServerSupervisionRequest {
        project_id: ProjectId("project:1".to_owned()),
        execution_host_id: EngineHostId("host:local".to_owned()),
        adapter: AdapterIdentity {
            adapter_id: "codex-app-server".to_owned(),
            provider_driver_kind: ProviderDriverKind::Codex,
            provider_instance_id: "codex:local-default".to_owned(),
            provider_name: "OpenAI Codex".to_owned(),
            harness_name: "Codex app-server".to_owned(),
            transport_family: TransportFamily::StructuredAppServerRuntime,
            version_discovery: VersionDiscovery::Command("codex --version".to_owned()),
            authentication_preflight: AuthenticationPreflight::Command(
                "codex doctor --json".to_owned(),
            ),
        },
        binary: CodexAppServerBinary {
            command: "codex".to_owned(),
            version_label: Some("codex-cli 0.140.0".to_owned()),
            available: true,
        },
        schema_evidence: CodexAppServerSchemaEvidenceRef {
            evidence_ref: "evidence:codex-schema".to_owned(),
            codex_version: "codex-cli 0.140.0".to_owned(),
            generated_json_schema: true,
            generated_ts_bindings: true,
        },
        supervision_limits: CodexAppServerSupervisionLimits {
            max_sessions: 1,
            allow_raw_provider_payload_storage: false,
            allow_live_spawn: true,
        },
    }
}

pub fn callback_prompt_ref() -> CodexAppServerCallbackPromptRef {
    CodexAppServerCallbackPromptRef {
        prompt_ref: "callback-prompt:1".to_owned(),
        summary: "callback summary".to_owned(),
        retention: CodexAppServerCallbackPromptRetentionPolicy::SummaryAndRefOnly,
    }
}

pub fn interruption_reason_ref() -> CodexAppServerInterruptionReasonRef {
    CodexAppServerInterruptionReasonRef {
        reason_ref: "interruption-reason:1".to_owned(),
        summary: "operator stopped the active turn".to_owned(),
        retention: CodexAppServerInterruptionReasonRetentionPolicy::SummaryAndRefOnly,
    }
}

pub fn interruption_target() -> CodexAppServerInterruptionTarget {
    CodexAppServerInterruptionTarget::ActiveTurn {
        provider_turn_id: "turn:provider:1".to_owned(),
        provider_request_id: Some("request:provider:1".to_owned()),
    }
}

pub fn session_id() -> AgentSessionId {
    AgentSessionId("session:1".to_owned())
}

pub fn session_binding() -> CodexAppServerSessionBindingRecord {
    CodexAppServerSessionBindingRecord {
        binding_id: CodexAppServerSessionBindingId(
            "codex-binding:codex:local-default:session:1:thread:provider:1".to_owned(),
        ),
        adapter_instance_id: "codex:local-default".to_owned(),
        nucleus_session_id: session_id(),
        provider_refs: CodexAppServerProviderRefs {
            thread_id: Some("thread:provider:1".to_owned()),
            session_id: Some("session:provider:1".to_owned()),
            turn_id: Some("turn:provider:1".to_owned()),
            item_id: Some("item:provider:1".to_owned()),
            request_id: Some("request:provider:1".to_owned()),
        },
        confidence: CodexAppServerBindingConfidence::ProviderThreadAndSession,
        status: CodexAppServerBindingStatus::Active,
        recovery_state: AgentSessionRecoveryState::Recoverable,
        evidence_ref: "evidence:binding".to_owned(),
        latest_ingestion_source_id: None,
    }
}

pub fn task_id() -> TaskId {
    TaskId("task:1".to_owned())
}

pub fn work_item_id() -> EngineTaskWorkItemId {
    EngineTaskWorkItemId("work:1".to_owned())
}

pub fn metadata_only() -> CodexAppServerPayloadRetentionPolicy {
    CodexAppServerPayloadRetentionPolicy::MetadataOnly
}
