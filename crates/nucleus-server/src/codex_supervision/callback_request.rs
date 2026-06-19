//! Codex callback request records.
//!
//! These records describe provider callback waits before any response is
//! admitted or sent. They do not answer callbacks, retain raw provider payloads,
//! cancel provider work, or mutate task state.

use nucleus_agent_protocol::{AgentSessionId, ApprovalScope, UserInputPromptKind};
use nucleus_engine::EngineTaskWorkItemId;
use nucleus_tasks::TaskId;

use super::runtime_instance::{
    CodexAppServerPayloadRetentionPolicy, CodexAppServerRuntimeInstanceRecord,
};

/// Stable id for one Nucleus-owned Codex callback request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerCallbackRequestId(pub String);

/// Provider-native callback id retained beside Nucleus ids.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerProviderCallbackId(pub String);

/// Callback classes supported by the first Codex response gate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackRequestKind {
    Permission {
        scope: ApprovalScope,
        options: Vec<String>,
    },
    UserInput {
        kind: UserInputPromptKind,
        options: Vec<String>,
    },
}

/// Prompt/source ref used to represent a callback without retaining raw text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackPromptRef {
    pub prompt_ref: String,
    pub summary: String,
    pub retention: CodexAppServerCallbackPromptRetentionPolicy,
}

/// Prompt retention policy for callback request records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackPromptRetentionPolicy {
    SummaryAndRefOnly,
    RawPromptAllowed,
}

/// Request record for a future Codex callback response.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackRequest {
    request_id: CodexAppServerCallbackRequestId,
    provider_callback_id: CodexAppServerProviderCallbackId,
    runtime_instance_id: String,
    session_id: AgentSessionId,
    provider_turn_id: Option<String>,
    provider_item_id: Option<String>,
    task_id: TaskId,
    work_item_id: EngineTaskWorkItemId,
    kind: CodexAppServerCallbackRequestKind,
    prompt_ref: CodexAppServerCallbackPromptRef,
    payload_retention: CodexAppServerPayloadRetentionPolicy,
    evidence_refs: Vec<String>,
    response_sent: bool,
    raw_provider_payload_retained: bool,
    task_mutation_permitted: bool,
}

/// Rejection before a callback request can exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackRequestRejection {
    EmptyRuntimeInstanceId,
    EmptyProviderCallbackId,
    EmptySessionId,
    EmptyTaskId,
    EmptyWorkItemId,
    EmptyPromptRef,
    EmptyPromptSummary,
    EmptyOption,
    RawPromptRetentionNotAllowed,
    RawProviderPayloadRetentionNotAllowed,
}

/// Build a callback request record with provider and Nucleus identity.
pub fn codex_callback_request(
    runtime: &CodexAppServerRuntimeInstanceRecord,
    provider_callback_id: CodexAppServerProviderCallbackId,
    session_id: AgentSessionId,
    provider_turn_id: Option<String>,
    provider_item_id: Option<String>,
    task_id: TaskId,
    work_item_id: EngineTaskWorkItemId,
    kind: CodexAppServerCallbackRequestKind,
    prompt_ref: CodexAppServerCallbackPromptRef,
    payload_retention: CodexAppServerPayloadRetentionPolicy,
) -> Result<CodexAppServerCallbackRequest, CodexAppServerCallbackRequestRejection> {
    validate_callback_request(
        runtime,
        &provider_callback_id,
        &session_id,
        &task_id,
        &work_item_id,
        &kind,
        &prompt_ref,
        &payload_retention,
    )?;

    Ok(CodexAppServerCallbackRequest {
        request_id: CodexAppServerCallbackRequestId(format!(
            "codex-callback:{}:{}:{}",
            runtime.runtime_instance_id.0, session_id.0, provider_callback_id.0
        )),
        provider_callback_id,
        runtime_instance_id: runtime.runtime_instance_id.0.clone(),
        session_id,
        provider_turn_id,
        provider_item_id,
        task_id,
        work_item_id,
        kind,
        prompt_ref,
        payload_retention,
        evidence_refs: runtime.evidence_refs.clone(),
        response_sent: false,
        raw_provider_payload_retained: false,
        task_mutation_permitted: false,
    })
}

impl CodexAppServerCallbackRequest {
    pub fn request_id(&self) -> &CodexAppServerCallbackRequestId {
        &self.request_id
    }

    pub fn provider_callback_id(&self) -> &CodexAppServerProviderCallbackId {
        &self.provider_callback_id
    }

    pub fn runtime_instance_id(&self) -> &str {
        &self.runtime_instance_id
    }

    pub fn session_id(&self) -> &AgentSessionId {
        &self.session_id
    }

    pub fn provider_turn_id(&self) -> Option<&str> {
        self.provider_turn_id.as_deref()
    }

    pub fn provider_item_id(&self) -> Option<&str> {
        self.provider_item_id.as_deref()
    }

    pub fn task_id(&self) -> &TaskId {
        &self.task_id
    }

    pub fn work_item_id(&self) -> &EngineTaskWorkItemId {
        &self.work_item_id
    }

    pub fn kind(&self) -> &CodexAppServerCallbackRequestKind {
        &self.kind
    }

    pub fn prompt_ref(&self) -> &CodexAppServerCallbackPromptRef {
        &self.prompt_ref
    }

    pub fn payload_retention(&self) -> &CodexAppServerPayloadRetentionPolicy {
        &self.payload_retention
    }

    pub fn evidence_refs(&self) -> &[String] {
        &self.evidence_refs
    }

    pub fn response_sent(&self) -> bool {
        self.response_sent
    }

    pub fn raw_provider_payload_retained(&self) -> bool {
        self.raw_provider_payload_retained
    }

    pub fn task_mutation_permitted(&self) -> bool {
        self.task_mutation_permitted
    }
}

fn validate_callback_request(
    runtime: &CodexAppServerRuntimeInstanceRecord,
    provider_callback_id: &CodexAppServerProviderCallbackId,
    session_id: &AgentSessionId,
    task_id: &TaskId,
    work_item_id: &EngineTaskWorkItemId,
    kind: &CodexAppServerCallbackRequestKind,
    prompt_ref: &CodexAppServerCallbackPromptRef,
    payload_retention: &CodexAppServerPayloadRetentionPolicy,
) -> Result<(), CodexAppServerCallbackRequestRejection> {
    if runtime.runtime_instance_id.0.is_empty() {
        return Err(CodexAppServerCallbackRequestRejection::EmptyRuntimeInstanceId);
    }
    if provider_callback_id.0.is_empty() {
        return Err(CodexAppServerCallbackRequestRejection::EmptyProviderCallbackId);
    }
    if session_id.0.is_empty() {
        return Err(CodexAppServerCallbackRequestRejection::EmptySessionId);
    }
    if task_id.0.is_empty() {
        return Err(CodexAppServerCallbackRequestRejection::EmptyTaskId);
    }
    if work_item_id.0.is_empty() {
        return Err(CodexAppServerCallbackRequestRejection::EmptyWorkItemId);
    }
    if prompt_ref.prompt_ref.is_empty() {
        return Err(CodexAppServerCallbackRequestRejection::EmptyPromptRef);
    }
    if prompt_ref.summary.is_empty() {
        return Err(CodexAppServerCallbackRequestRejection::EmptyPromptSummary);
    }
    if callback_options(kind)
        .iter()
        .any(|option| option.is_empty())
    {
        return Err(CodexAppServerCallbackRequestRejection::EmptyOption);
    }
    if prompt_ref.retention == CodexAppServerCallbackPromptRetentionPolicy::RawPromptAllowed {
        return Err(CodexAppServerCallbackRequestRejection::RawPromptRetentionNotAllowed);
    }
    if payload_retention == &CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed {
        return Err(CodexAppServerCallbackRequestRejection::RawProviderPayloadRetentionNotAllowed);
    }

    Ok(())
}

fn callback_options(kind: &CodexAppServerCallbackRequestKind) -> &[String] {
    match kind {
        CodexAppServerCallbackRequestKind::Permission { options, .. }
        | CodexAppServerCallbackRequestKind::UserInput { options, .. } => options,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::test_support::{
        callback_prompt_ref, metadata_only, runtime, session_id, task_id, work_item_id,
    };

    #[test]
    fn permission_callback_request_preserves_provider_and_nucleus_identity() {
        let request = codex_callback_request(
            &runtime(),
            CodexAppServerProviderCallbackId("provider-callback:1".to_owned()),
            session_id(),
            Some("turn:provider:1".to_owned()),
            Some("item:provider:1".to_owned()),
            task_id(),
            work_item_id(),
            CodexAppServerCallbackRequestKind::Permission {
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned(), "deny".to_owned()],
            },
            callback_prompt_ref(),
            metadata_only(),
        )
        .expect("callback request");

        assert!(request.request_id().0.contains("provider-callback:1"));
        assert_eq!(
            request.provider_callback_id(),
            &CodexAppServerProviderCallbackId("provider-callback:1".to_owned())
        );
        assert_eq!(
            request.session_id(),
            &AgentSessionId("session:1".to_owned())
        );
        assert_eq!(request.provider_turn_id(), Some("turn:provider:1"));
        assert_eq!(request.provider_item_id(), Some("item:provider:1"));
        assert_eq!(request.task_id(), &TaskId("task:1".to_owned()));
        assert_eq!(
            request.work_item_id(),
            &EngineTaskWorkItemId("work:1".to_owned())
        );
        assert_eq!(
            request.prompt_ref().retention,
            CodexAppServerCallbackPromptRetentionPolicy::SummaryAndRefOnly
        );
        assert_eq!(
            request.payload_retention(),
            &CodexAppServerPayloadRetentionPolicy::MetadataOnly
        );
        assert_eq!(
            request.evidence_refs(),
            &["evidence:codex-schema".to_owned()]
        );
        assert!(!request.response_sent());
        assert!(!request.raw_provider_payload_retained());
        assert!(!request.task_mutation_permitted());
    }

    #[test]
    fn user_input_callback_request_has_distinct_kind_without_raw_payload() {
        let request = codex_callback_request(
            &runtime(),
            CodexAppServerProviderCallbackId("provider-callback:input".to_owned()),
            session_id(),
            None,
            Some("item:provider:input".to_owned()),
            task_id(),
            work_item_id(),
            CodexAppServerCallbackRequestKind::UserInput {
                kind: UserInputPromptKind::SelectOne,
                options: vec!["first".to_owned(), "second".to_owned()],
            },
            callback_prompt_ref(),
            CodexAppServerPayloadRetentionPolicy::EvidenceRefsOnly,
        )
        .expect("callback request");

        assert!(matches!(
            request.kind(),
            CodexAppServerCallbackRequestKind::UserInput {
                kind: UserInputPromptKind::SelectOne,
                ..
            }
        ));
        assert_eq!(
            request.payload_retention(),
            &CodexAppServerPayloadRetentionPolicy::EvidenceRefsOnly
        );
        assert!(!request.raw_provider_payload_retained());
        assert!(!request.response_sent());
    }

    #[test]
    fn callback_request_rejects_unstable_identity_or_raw_retention() {
        let rejection = codex_callback_request(
            &runtime(),
            CodexAppServerProviderCallbackId(String::new()),
            session_id(),
            None,
            None,
            task_id(),
            work_item_id(),
            CodexAppServerCallbackRequestKind::Permission {
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned()],
            },
            callback_prompt_ref(),
            metadata_only(),
        )
        .expect_err("missing provider callback id");

        assert_eq!(
            rejection,
            CodexAppServerCallbackRequestRejection::EmptyProviderCallbackId
        );

        let rejection = codex_callback_request(
            &runtime(),
            CodexAppServerProviderCallbackId("provider-callback:1".to_owned()),
            session_id(),
            None,
            None,
            task_id(),
            work_item_id(),
            CodexAppServerCallbackRequestKind::Permission {
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned()],
            },
            callback_prompt_ref(),
            CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed,
        )
        .expect_err("raw provider payload retention");

        assert_eq!(
            rejection,
            CodexAppServerCallbackRequestRejection::RawProviderPayloadRetentionNotAllowed
        );
    }
}
