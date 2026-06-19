//! Codex turn-start request records.
//!
//! These records describe the next provider command before any provider send.
//! They do not start turns, answer callbacks, cancel work, resume sessions, or
//! mutate task state.

use nucleus_agent_protocol::AgentSessionId;
use nucleus_engine::EngineTaskWorkItemId;
use nucleus_tasks::TaskId;

use super::runtime_instance::{
    CodexAppServerPayloadRetentionPolicy, CodexAppServerRuntimeInstanceRecord,
};

/// Stable id for one Nucleus-owned Codex turn-start request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTurnStartRequestId(pub String);

/// Prompt/source ref used to start a turn without retaining raw prompt text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartPromptRef {
    pub prompt_ref: String,
    pub summary: String,
    pub retention: CodexAppServerTurnStartPromptRetentionPolicy,
}

/// Prompt retention policy for turn-start request records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartPromptRetentionPolicy {
    SummaryAndRefOnly,
    RawPromptAllowed,
}

/// Request record for a future Codex turn-start command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartRequest {
    request_id: CodexAppServerTurnStartRequestId,
    runtime_instance_id: String,
    session_id: AgentSessionId,
    task_id: TaskId,
    work_item_id: EngineTaskWorkItemId,
    prompt_ref: CodexAppServerTurnStartPromptRef,
    payload_retention: CodexAppServerPayloadRetentionPolicy,
    evidence_refs: Vec<String>,
    task_mutation_permitted: bool,
}

/// Rejection before a turn-start request can exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartRequestRejection {
    EmptyRuntimeInstanceId,
    EmptySessionId,
    EmptyTaskId,
    EmptyWorkItemId,
    EmptyPromptRef,
    EmptyPromptSummary,
    RawPromptRetentionNotAllowed,
    RawProviderPayloadRetentionNotAllowed,
}

/// Build a turn-start request record with Nucleus-owned identity only.
pub fn codex_turn_start_request(
    runtime: &CodexAppServerRuntimeInstanceRecord,
    session_id: AgentSessionId,
    task_id: TaskId,
    work_item_id: EngineTaskWorkItemId,
    prompt_ref: CodexAppServerTurnStartPromptRef,
    payload_retention: CodexAppServerPayloadRetentionPolicy,
) -> Result<CodexAppServerTurnStartRequest, CodexAppServerTurnStartRequestRejection> {
    validate_turn_start_request(
        runtime,
        &session_id,
        &task_id,
        &work_item_id,
        &prompt_ref,
        &payload_retention,
    )?;

    Ok(CodexAppServerTurnStartRequest {
        request_id: CodexAppServerTurnStartRequestId(format!(
            "codex-turn-start:{}:{}:{}",
            runtime.runtime_instance_id.0, session_id.0, work_item_id.0
        )),
        runtime_instance_id: runtime.runtime_instance_id.0.clone(),
        session_id,
        task_id,
        work_item_id,
        prompt_ref,
        payload_retention,
        evidence_refs: runtime.evidence_refs.clone(),
        task_mutation_permitted: false,
    })
}

impl CodexAppServerTurnStartRequest {
    pub fn request_id(&self) -> &CodexAppServerTurnStartRequestId {
        &self.request_id
    }

    pub fn runtime_instance_id(&self) -> &str {
        &self.runtime_instance_id
    }

    pub fn session_id(&self) -> &AgentSessionId {
        &self.session_id
    }

    pub fn task_id(&self) -> &TaskId {
        &self.task_id
    }

    pub fn work_item_id(&self) -> &EngineTaskWorkItemId {
        &self.work_item_id
    }

    pub fn prompt_ref(&self) -> &CodexAppServerTurnStartPromptRef {
        &self.prompt_ref
    }

    pub fn payload_retention(&self) -> &CodexAppServerPayloadRetentionPolicy {
        &self.payload_retention
    }

    pub fn evidence_refs(&self) -> &[String] {
        &self.evidence_refs
    }

    pub fn task_mutation_permitted(&self) -> bool {
        self.task_mutation_permitted
    }
}

fn validate_turn_start_request(
    runtime: &CodexAppServerRuntimeInstanceRecord,
    session_id: &AgentSessionId,
    task_id: &TaskId,
    work_item_id: &EngineTaskWorkItemId,
    prompt_ref: &CodexAppServerTurnStartPromptRef,
    payload_retention: &CodexAppServerPayloadRetentionPolicy,
) -> Result<(), CodexAppServerTurnStartRequestRejection> {
    if runtime.runtime_instance_id.0.is_empty() {
        return Err(CodexAppServerTurnStartRequestRejection::EmptyRuntimeInstanceId);
    }
    if session_id.0.is_empty() {
        return Err(CodexAppServerTurnStartRequestRejection::EmptySessionId);
    }
    if task_id.0.is_empty() {
        return Err(CodexAppServerTurnStartRequestRejection::EmptyTaskId);
    }
    if work_item_id.0.is_empty() {
        return Err(CodexAppServerTurnStartRequestRejection::EmptyWorkItemId);
    }
    if prompt_ref.prompt_ref.is_empty() {
        return Err(CodexAppServerTurnStartRequestRejection::EmptyPromptRef);
    }
    if prompt_ref.summary.is_empty() {
        return Err(CodexAppServerTurnStartRequestRejection::EmptyPromptSummary);
    }
    if prompt_ref.retention == CodexAppServerTurnStartPromptRetentionPolicy::RawPromptAllowed {
        return Err(CodexAppServerTurnStartRequestRejection::RawPromptRetentionNotAllowed);
    }
    if payload_retention == &CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed {
        return Err(CodexAppServerTurnStartRequestRejection::RawProviderPayloadRetentionNotAllowed);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        codex_runtime_instance_from_supervision_request, CodexAppServerBinary,
        CodexAppServerRuntimeInstanceState, CodexAppServerSchemaEvidenceRef,
        CodexAppServerSupervisionLimits, CodexAppServerSupervisionRequest,
    };
    use crate::host_authority::EngineHostId;
    use nucleus_agent_protocol::{
        AdapterIdentity, AuthenticationPreflight, ProviderDriverKind, TransportFamily,
        VersionDiscovery,
    };
    use nucleus_projects::ProjectId;

    fn runtime() -> CodexAppServerRuntimeInstanceRecord {
        codex_runtime_instance_from_supervision_request(
            &CodexAppServerSupervisionRequest {
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
            },
            CodexAppServerRuntimeInstanceState::ReadyForSpawn,
        )
    }

    fn prompt_ref() -> CodexAppServerTurnStartPromptRef {
        CodexAppServerTurnStartPromptRef {
            prompt_ref: "prompt:task:1".to_owned(),
            summary: "implement focused request records".to_owned(),
            retention: CodexAppServerTurnStartPromptRetentionPolicy::SummaryAndRefOnly,
        }
    }

    #[test]
    fn turn_start_request_uses_nucleus_identity_before_provider_send() {
        let request = codex_turn_start_request(
            &runtime(),
            AgentSessionId("session:1".to_owned()),
            TaskId("task:1".to_owned()),
            EngineTaskWorkItemId("work:1".to_owned()),
            prompt_ref(),
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect("turn-start request");

        assert!(request.request_id().0.contains("session:1"));
        assert_eq!(
            request.session_id(),
            &AgentSessionId("session:1".to_owned())
        );
        assert_eq!(request.task_id(), &TaskId("task:1".to_owned()));
        assert_eq!(
            request.work_item_id(),
            &EngineTaskWorkItemId("work:1".to_owned())
        );
        assert_eq!(
            request.prompt_ref().retention,
            CodexAppServerTurnStartPromptRetentionPolicy::SummaryAndRefOnly
        );
        assert!(!request.task_mutation_permitted());
        assert_eq!(
            request.evidence_refs(),
            &["evidence:codex-schema".to_owned()]
        );
    }

    #[test]
    fn turn_start_request_rejects_missing_identity() {
        let rejection = codex_turn_start_request(
            &runtime(),
            AgentSessionId(String::new()),
            TaskId("task:1".to_owned()),
            EngineTaskWorkItemId("work:1".to_owned()),
            prompt_ref(),
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect_err("missing session rejected");

        assert_eq!(
            rejection,
            CodexAppServerTurnStartRequestRejection::EmptySessionId
        );
    }

    #[test]
    fn turn_start_request_rejects_raw_prompt_or_provider_payload_retention() {
        let mut raw_prompt = prompt_ref();
        raw_prompt.retention = CodexAppServerTurnStartPromptRetentionPolicy::RawPromptAllowed;
        assert_eq!(
            codex_turn_start_request(
                &runtime(),
                AgentSessionId("session:1".to_owned()),
                TaskId("task:1".to_owned()),
                EngineTaskWorkItemId("work:1".to_owned()),
                raw_prompt,
                CodexAppServerPayloadRetentionPolicy::MetadataOnly,
            )
            .expect_err("raw prompt rejected"),
            CodexAppServerTurnStartRequestRejection::RawPromptRetentionNotAllowed
        );

        assert_eq!(
            codex_turn_start_request(
                &runtime(),
                AgentSessionId("session:1".to_owned()),
                TaskId("task:1".to_owned()),
                EngineTaskWorkItemId("work:1".to_owned()),
                prompt_ref(),
                CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed,
            )
            .expect_err("raw provider payload rejected"),
            CodexAppServerTurnStartRequestRejection::RawProviderPayloadRetentionNotAllowed
        );
    }
}
