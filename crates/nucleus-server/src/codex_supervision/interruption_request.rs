//! Codex interruption request records.
//!
//! These records describe provider interruption intent before admission or
//! send. They do not interrupt Codex, retain raw payloads, recover sessions, or
//! mutate task state.

use nucleus_agent_protocol::AgentSessionId;
use nucleus_engine::EngineTaskWorkItemId;
use nucleus_tasks::TaskId;

use super::runtime_instance::{
    CodexAppServerPayloadRetentionPolicy, CodexAppServerRuntimeInstanceRecord,
};

/// Stable id for one Nucleus-owned Codex interruption request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerInterruptionRequestId(pub String);

/// Nucleus-side source ref for one interruption request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerInterruptionRequestRef(pub String);

/// Provider work target requested for interruption.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionTarget {
    ActiveTurn {
        provider_turn_id: String,
        provider_request_id: Option<String>,
    },
}

/// Reason/source ref used to request interruption without retaining raw text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerInterruptionReasonRef {
    pub reason_ref: String,
    pub summary: String,
    pub retention: CodexAppServerInterruptionReasonRetentionPolicy,
}

/// Reason retention policy for interruption request records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionReasonRetentionPolicy {
    SummaryAndRefOnly,
    RawReasonAllowed,
}

/// Request record for a future Codex provider interruption.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerInterruptionRequest {
    request_id: CodexAppServerInterruptionRequestId,
    request_ref: CodexAppServerInterruptionRequestRef,
    runtime_instance_id: String,
    session_id: AgentSessionId,
    target: CodexAppServerInterruptionTarget,
    task_id: TaskId,
    work_item_id: EngineTaskWorkItemId,
    reason_ref: CodexAppServerInterruptionReasonRef,
    payload_retention: CodexAppServerPayloadRetentionPolicy,
    evidence_refs: Vec<String>,
    provider_send_started: bool,
    raw_provider_payload_retained: bool,
    recovery_implied: bool,
    task_mutation_permitted: bool,
}

/// Rejection before an interruption request can exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionRequestRejection {
    EmptyRuntimeInstanceId,
    EmptyRequestRef,
    EmptySessionId,
    EmptyProviderTurnId,
    EmptyProviderRequestId,
    EmptyTaskId,
    EmptyWorkItemId,
    EmptyReasonRef,
    EmptyReasonSummary,
    RawReasonRetentionNotAllowed,
    RawProviderPayloadRetentionNotAllowed,
}

/// Build an interruption request record with provider and Nucleus identity.
pub fn codex_interruption_request(
    runtime: &CodexAppServerRuntimeInstanceRecord,
    request_ref: CodexAppServerInterruptionRequestRef,
    session_id: AgentSessionId,
    target: CodexAppServerInterruptionTarget,
    task_id: TaskId,
    work_item_id: EngineTaskWorkItemId,
    reason_ref: CodexAppServerInterruptionReasonRef,
    payload_retention: CodexAppServerPayloadRetentionPolicy,
) -> Result<CodexAppServerInterruptionRequest, CodexAppServerInterruptionRequestRejection> {
    validate_interruption_request(
        runtime,
        &request_ref,
        &session_id,
        &target,
        &task_id,
        &work_item_id,
        &reason_ref,
        &payload_retention,
    )?;

    Ok(CodexAppServerInterruptionRequest {
        request_id: CodexAppServerInterruptionRequestId(format!(
            "codex-interruption:{}:{}:{}:{}",
            runtime.runtime_instance_id.0,
            session_id.0,
            request_ref.0,
            target_identity(&target)
        )),
        request_ref,
        runtime_instance_id: runtime.runtime_instance_id.0.clone(),
        session_id,
        target,
        task_id,
        work_item_id,
        reason_ref,
        payload_retention,
        evidence_refs: runtime.evidence_refs.clone(),
        provider_send_started: false,
        raw_provider_payload_retained: false,
        recovery_implied: false,
        task_mutation_permitted: false,
    })
}

impl CodexAppServerInterruptionRequest {
    pub fn request_id(&self) -> &CodexAppServerInterruptionRequestId {
        &self.request_id
    }

    pub fn request_ref(&self) -> &CodexAppServerInterruptionRequestRef {
        &self.request_ref
    }

    pub fn runtime_instance_id(&self) -> &str {
        &self.runtime_instance_id
    }

    pub fn session_id(&self) -> &AgentSessionId {
        &self.session_id
    }

    pub fn target(&self) -> &CodexAppServerInterruptionTarget {
        &self.target
    }

    pub fn task_id(&self) -> &TaskId {
        &self.task_id
    }

    pub fn work_item_id(&self) -> &EngineTaskWorkItemId {
        &self.work_item_id
    }

    pub fn reason_ref(&self) -> &CodexAppServerInterruptionReasonRef {
        &self.reason_ref
    }

    pub fn payload_retention(&self) -> &CodexAppServerPayloadRetentionPolicy {
        &self.payload_retention
    }

    pub fn evidence_refs(&self) -> &[String] {
        &self.evidence_refs
    }

    pub fn provider_send_started(&self) -> bool {
        self.provider_send_started
    }

    pub fn raw_provider_payload_retained(&self) -> bool {
        self.raw_provider_payload_retained
    }

    pub fn recovery_implied(&self) -> bool {
        self.recovery_implied
    }

    pub fn task_mutation_permitted(&self) -> bool {
        self.task_mutation_permitted
    }
}

fn validate_interruption_request(
    runtime: &CodexAppServerRuntimeInstanceRecord,
    request_ref: &CodexAppServerInterruptionRequestRef,
    session_id: &AgentSessionId,
    target: &CodexAppServerInterruptionTarget,
    task_id: &TaskId,
    work_item_id: &EngineTaskWorkItemId,
    reason_ref: &CodexAppServerInterruptionReasonRef,
    payload_retention: &CodexAppServerPayloadRetentionPolicy,
) -> Result<(), CodexAppServerInterruptionRequestRejection> {
    if runtime.runtime_instance_id.0.is_empty() {
        return Err(CodexAppServerInterruptionRequestRejection::EmptyRuntimeInstanceId);
    }
    if request_ref.0.is_empty() {
        return Err(CodexAppServerInterruptionRequestRejection::EmptyRequestRef);
    }
    if session_id.0.is_empty() {
        return Err(CodexAppServerInterruptionRequestRejection::EmptySessionId);
    }
    validate_target(target)?;
    if task_id.0.is_empty() {
        return Err(CodexAppServerInterruptionRequestRejection::EmptyTaskId);
    }
    if work_item_id.0.is_empty() {
        return Err(CodexAppServerInterruptionRequestRejection::EmptyWorkItemId);
    }
    if reason_ref.reason_ref.is_empty() {
        return Err(CodexAppServerInterruptionRequestRejection::EmptyReasonRef);
    }
    if reason_ref.summary.is_empty() {
        return Err(CodexAppServerInterruptionRequestRejection::EmptyReasonSummary);
    }
    if reason_ref.retention == CodexAppServerInterruptionReasonRetentionPolicy::RawReasonAllowed {
        return Err(CodexAppServerInterruptionRequestRejection::RawReasonRetentionNotAllowed);
    }
    if payload_retention == &CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed {
        return Err(
            CodexAppServerInterruptionRequestRejection::RawProviderPayloadRetentionNotAllowed,
        );
    }

    Ok(())
}

fn validate_target(
    target: &CodexAppServerInterruptionTarget,
) -> Result<(), CodexAppServerInterruptionRequestRejection> {
    match target {
        CodexAppServerInterruptionTarget::ActiveTurn {
            provider_turn_id,
            provider_request_id,
        } => {
            if provider_turn_id.is_empty() {
                return Err(CodexAppServerInterruptionRequestRejection::EmptyProviderTurnId);
            }
            if provider_request_id.as_deref() == Some("") {
                return Err(CodexAppServerInterruptionRequestRejection::EmptyProviderRequestId);
            }
        }
    }

    Ok(())
}

fn target_identity(target: &CodexAppServerInterruptionTarget) -> String {
    match target {
        CodexAppServerInterruptionTarget::ActiveTurn {
            provider_turn_id,
            provider_request_id,
        } => format!(
            "turn:{}:request:{}",
            provider_turn_id,
            provider_request_id.as_deref().unwrap_or("unknown")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        codex_runtime_instance_from_supervision_request, CodexAppServerBinary,
        CodexAppServerRuntimeInstanceRecord, CodexAppServerRuntimeInstanceState,
        CodexAppServerSchemaEvidenceRef, CodexAppServerSupervisionLimits,
        CodexAppServerSupervisionRequest,
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

    fn reason_ref() -> CodexAppServerInterruptionReasonRef {
        CodexAppServerInterruptionReasonRef {
            reason_ref: "interruption-reason:1".to_owned(),
            summary: "operator stopped the active turn".to_owned(),
            retention: CodexAppServerInterruptionReasonRetentionPolicy::SummaryAndRefOnly,
        }
    }

    fn target() -> CodexAppServerInterruptionTarget {
        CodexAppServerInterruptionTarget::ActiveTurn {
            provider_turn_id: "turn:provider:1".to_owned(),
            provider_request_id: Some("request:provider:1".to_owned()),
        }
    }

    #[test]
    fn interruption_request_preserves_provider_and_nucleus_identity_without_send() {
        let request = codex_interruption_request(
            &runtime(),
            CodexAppServerInterruptionRequestRef("interrupt:1".to_owned()),
            AgentSessionId("session:1".to_owned()),
            target(),
            TaskId("task:1".to_owned()),
            EngineTaskWorkItemId("work:1".to_owned()),
            reason_ref(),
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect("interruption request");

        assert!(request.request_id().0.contains("interrupt:1"));
        assert_eq!(
            request.request_ref(),
            &CodexAppServerInterruptionRequestRef("interrupt:1".to_owned())
        );
        assert_eq!(
            request.session_id(),
            &AgentSessionId("session:1".to_owned())
        );
        assert_eq!(request.task_id(), &TaskId("task:1".to_owned()));
        assert_eq!(
            request.work_item_id(),
            &EngineTaskWorkItemId("work:1".to_owned())
        );
        assert!(matches!(
            request.target(),
            CodexAppServerInterruptionTarget::ActiveTurn {
                provider_turn_id,
                provider_request_id: Some(provider_request_id),
            } if provider_turn_id == "turn:provider:1"
                && provider_request_id == "request:provider:1"
        ));
        assert_eq!(
            request.reason_ref().retention,
            CodexAppServerInterruptionReasonRetentionPolicy::SummaryAndRefOnly
        );
        assert_eq!(
            request.payload_retention(),
            &CodexAppServerPayloadRetentionPolicy::MetadataOnly
        );
        assert_eq!(
            request.evidence_refs(),
            &["evidence:codex-schema".to_owned()]
        );
        assert!(!request.provider_send_started());
        assert!(!request.raw_provider_payload_retained());
        assert!(!request.recovery_implied());
        assert!(!request.task_mutation_permitted());
    }

    #[test]
    fn interruption_request_rejects_unstable_target_or_raw_retention() {
        let rejection = codex_interruption_request(
            &runtime(),
            CodexAppServerInterruptionRequestRef("interrupt:1".to_owned()),
            AgentSessionId("session:1".to_owned()),
            CodexAppServerInterruptionTarget::ActiveTurn {
                provider_turn_id: String::new(),
                provider_request_id: None,
            },
            TaskId("task:1".to_owned()),
            EngineTaskWorkItemId("work:1".to_owned()),
            reason_ref(),
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect_err("missing turn id");

        assert_eq!(
            rejection,
            CodexAppServerInterruptionRequestRejection::EmptyProviderTurnId
        );

        let rejection = codex_interruption_request(
            &runtime(),
            CodexAppServerInterruptionRequestRef("interrupt:1".to_owned()),
            AgentSessionId("session:1".to_owned()),
            target(),
            TaskId("task:1".to_owned()),
            EngineTaskWorkItemId("work:1".to_owned()),
            reason_ref(),
            CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed,
        )
        .expect_err("raw payload retention");

        assert_eq!(
            rejection,
            CodexAppServerInterruptionRequestRejection::RawProviderPayloadRetentionNotAllowed
        );
    }
}
