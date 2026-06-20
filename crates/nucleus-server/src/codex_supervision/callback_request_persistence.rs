//! Codex callback request persistence.
//!
//! This module stores sanitized callback wait-state records. It does not retain
//! raw callback material, answer callbacks, perform provider I/O, or mutate
//! task state.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerStateService;

use super::callback_request::{
    CodexAppServerCallbackPromptRetentionPolicy, CodexAppServerCallbackRequest,
    CodexAppServerCallbackRequestKind,
};
use super::runtime_instance::CodexAppServerPayloadRetentionPolicy;

const CALLBACK_REQUEST_PREFIX: &str = "codex-callback-request:";

/// Input for persisting one sanitized provider callback request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackRequestPersistenceInput {
    pub request: CodexAppServerCallbackRequest,
    pub runtime_receipt_refs: Vec<String>,
}

/// Durable sanitized callback request record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackRequestPersistenceRecord {
    pub persistence_id: String,
    pub request_id: String,
    pub provider_callback_id: String,
    pub runtime_instance_id: String,
    pub session_id: String,
    pub provider_turn_id: Option<String>,
    pub provider_item_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub callback_kind: String,
    pub wait_state: CodexAppServerCallbackRequestPersistenceWaitState,
    pub prompt_ref: String,
    pub prompt_summary: String,
    pub options: Vec<String>,
    pub runtime_receipt_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub callback_answering_authority: bool,
    pub response_sent: bool,
    pub raw_callback_material_retained: bool,
    pub raw_provider_payload_retained: bool,
    pub provider_io_executed: bool,
    pub task_mutation_permitted: bool,
}

/// Callback wait state retained after reopen.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackRequestPersistenceWaitState {
    WaitingForApproval,
    WaitingForUserInput,
}

/// Persist one sanitized Codex callback request record.
pub fn persist_codex_callback_request<B>(
    state: &ServerStateService<B>,
    input: CodexAppServerCallbackRequestPersistenceInput,
) -> LocalStoreResult<CodexAppServerCallbackRequestPersistenceRecord>
where
    B: LocalStoreBackend,
{
    validate_request_for_persistence(&input.request, &input.runtime_receipt_refs)?;
    let record = persistence_record_from_input(input);

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.persistence_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.persistence_id)),
            payload: json_payload(encode_callback_request_record(&record)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

/// Read persisted sanitized Codex callback request records.
pub fn read_codex_callback_request_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CodexAppServerCallbackRequestPersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(CALLBACK_REQUEST_PREFIX))
        .map(|record| decode_callback_request_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.persistence_id.cmp(&right.persistence_id));
    Ok(records)
}

fn validate_request_for_persistence(
    request: &CodexAppServerCallbackRequest,
    runtime_receipt_refs: &[String],
) -> LocalStoreResult<()> {
    if request.request_id().0.trim().is_empty()
        || request.provider_callback_id().0.trim().is_empty()
        || request.runtime_instance_id().trim().is_empty()
        || request.session_id().0.trim().is_empty()
        || request.task_id().0.trim().is_empty()
        || request.work_item_id().0.trim().is_empty()
        || request.prompt_ref().prompt_ref.trim().is_empty()
        || request.prompt_ref().summary.trim().is_empty()
        || request.evidence_refs().is_empty()
    {
        return invalid(
            "callback request persistence requires provider, task, prompt, and evidence identity",
        );
    }
    if request.prompt_ref().retention
        != CodexAppServerCallbackPromptRetentionPolicy::SummaryAndRefOnly
    {
        return invalid("callback request persistence cannot retain raw callback prompts");
    }
    if request.payload_retention()
        == &CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed
    {
        return invalid("callback request persistence cannot retain raw provider payloads");
    }
    if request.raw_provider_payload_retained()
        || request.response_sent()
        || request.task_mutation_permitted()
    {
        return invalid("callback request persistence requires unsent inspect-only request state");
    }
    if request
        .evidence_refs()
        .iter()
        .any(|value| value.trim().is_empty())
        || runtime_receipt_refs
            .iter()
            .any(|value| value.trim().is_empty())
    {
        return invalid("callback request persistence refs cannot be empty");
    }

    Ok(())
}

fn persistence_record_from_input(
    input: CodexAppServerCallbackRequestPersistenceInput,
) -> CodexAppServerCallbackRequestPersistenceRecord {
    let (callback_kind, wait_state, options) = callback_kind_parts(input.request.kind());

    CodexAppServerCallbackRequestPersistenceRecord {
        persistence_id: format!(
            "{}{}",
            CALLBACK_REQUEST_PREFIX,
            input.request.request_id().0
        ),
        request_id: input.request.request_id().0.clone(),
        provider_callback_id: input.request.provider_callback_id().0.clone(),
        runtime_instance_id: input.request.runtime_instance_id().to_owned(),
        session_id: input.request.session_id().0.clone(),
        provider_turn_id: input.request.provider_turn_id().map(ToOwned::to_owned),
        provider_item_id: input.request.provider_item_id().map(ToOwned::to_owned),
        task_id: input.request.task_id().0.clone(),
        work_item_id: input.request.work_item_id().0.clone(),
        callback_kind,
        wait_state,
        prompt_ref: input.request.prompt_ref().prompt_ref.clone(),
        prompt_summary: input.request.prompt_ref().summary.clone(),
        options,
        runtime_receipt_refs: input.runtime_receipt_refs,
        evidence_refs: input.request.evidence_refs().to_vec(),
        callback_answering_authority: false,
        response_sent: false,
        raw_callback_material_retained: false,
        raw_provider_payload_retained: false,
        provider_io_executed: false,
        task_mutation_permitted: false,
    }
}

fn callback_kind_parts(
    kind: &CodexAppServerCallbackRequestKind,
) -> (
    String,
    CodexAppServerCallbackRequestPersistenceWaitState,
    Vec<String>,
) {
    match kind {
        CodexAppServerCallbackRequestKind::Permission { scope, options } => (
            format!("permission:{scope:?}"),
            CodexAppServerCallbackRequestPersistenceWaitState::WaitingForApproval,
            options.clone(),
        ),
        CodexAppServerCallbackRequestKind::UserInput { kind, options } => (
            format!("user_input:{kind:?}"),
            CodexAppServerCallbackRequestPersistenceWaitState::WaitingForUserInput,
            options.clone(),
        ),
    }
}

fn encode_callback_request_record(
    record: &CodexAppServerCallbackRequestPersistenceRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(&CallbackRequestRecordDto::from_record(record)).map_err(json_error)
}

fn decode_callback_request_record(
    bytes: &[u8],
) -> LocalStoreResult<CodexAppServerCallbackRequestPersistenceRecord> {
    let dto: CallbackRequestRecordDto = serde_json::from_slice(bytes).map_err(json_error)?;
    Ok(dto.into_record())
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn invalid<T>(reason: impl Into<String>) -> LocalStoreResult<T> {
    Err(LocalStoreError::InvalidRecord {
        reason: reason.into(),
    })
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CallbackRequestRecordDto {
    persistence_id: String,
    request_id: String,
    provider_callback_id: String,
    runtime_instance_id: String,
    session_id: String,
    provider_turn_id: Option<String>,
    provider_item_id: Option<String>,
    task_id: String,
    work_item_id: String,
    callback_kind: String,
    wait_state: WaitStateDto,
    prompt_ref: String,
    prompt_summary: String,
    options: Vec<String>,
    runtime_receipt_refs: Vec<String>,
    evidence_refs: Vec<String>,
    callback_answering_authority: bool,
    response_sent: bool,
    raw_callback_material_retained: bool,
    raw_provider_payload_retained: bool,
    provider_io_executed: bool,
    task_mutation_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum WaitStateDto {
    WaitingForApproval,
    WaitingForUserInput,
}

impl CallbackRequestRecordDto {
    fn from_record(record: &CodexAppServerCallbackRequestPersistenceRecord) -> Self {
        Self {
            persistence_id: record.persistence_id.clone(),
            request_id: record.request_id.clone(),
            provider_callback_id: record.provider_callback_id.clone(),
            runtime_instance_id: record.runtime_instance_id.clone(),
            session_id: record.session_id.clone(),
            provider_turn_id: record.provider_turn_id.clone(),
            provider_item_id: record.provider_item_id.clone(),
            task_id: record.task_id.clone(),
            work_item_id: record.work_item_id.clone(),
            callback_kind: record.callback_kind.clone(),
            wait_state: WaitStateDto::from_wait_state(&record.wait_state),
            prompt_ref: record.prompt_ref.clone(),
            prompt_summary: record.prompt_summary.clone(),
            options: record.options.clone(),
            runtime_receipt_refs: record.runtime_receipt_refs.clone(),
            evidence_refs: record.evidence_refs.clone(),
            callback_answering_authority: record.callback_answering_authority,
            response_sent: record.response_sent,
            raw_callback_material_retained: record.raw_callback_material_retained,
            raw_provider_payload_retained: record.raw_provider_payload_retained,
            provider_io_executed: record.provider_io_executed,
            task_mutation_permitted: record.task_mutation_permitted,
        }
    }

    fn into_record(self) -> CodexAppServerCallbackRequestPersistenceRecord {
        CodexAppServerCallbackRequestPersistenceRecord {
            persistence_id: self.persistence_id,
            request_id: self.request_id,
            provider_callback_id: self.provider_callback_id,
            runtime_instance_id: self.runtime_instance_id,
            session_id: self.session_id,
            provider_turn_id: self.provider_turn_id,
            provider_item_id: self.provider_item_id,
            task_id: self.task_id,
            work_item_id: self.work_item_id,
            callback_kind: self.callback_kind,
            wait_state: self.wait_state.into_wait_state(),
            prompt_ref: self.prompt_ref,
            prompt_summary: self.prompt_summary,
            options: self.options,
            runtime_receipt_refs: self.runtime_receipt_refs,
            evidence_refs: self.evidence_refs,
            callback_answering_authority: self.callback_answering_authority,
            response_sent: self.response_sent,
            raw_callback_material_retained: self.raw_callback_material_retained,
            raw_provider_payload_retained: self.raw_provider_payload_retained,
            provider_io_executed: self.provider_io_executed,
            task_mutation_permitted: self.task_mutation_permitted,
        }
    }
}

impl WaitStateDto {
    fn from_wait_state(state: &CodexAppServerCallbackRequestPersistenceWaitState) -> Self {
        match state {
            CodexAppServerCallbackRequestPersistenceWaitState::WaitingForApproval => {
                Self::WaitingForApproval
            }
            CodexAppServerCallbackRequestPersistenceWaitState::WaitingForUserInput => {
                Self::WaitingForUserInput
            }
        }
    }

    fn into_wait_state(self) -> CodexAppServerCallbackRequestPersistenceWaitState {
        match self {
            Self::WaitingForApproval => {
                CodexAppServerCallbackRequestPersistenceWaitState::WaitingForApproval
            }
            Self::WaitingForUserInput => {
                CodexAppServerCallbackRequestPersistenceWaitState::WaitingForUserInput
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        codex_callback_request, test_support, CodexAppServerCallbackPromptRetentionPolicy,
        CodexAppServerCallbackRequestKind, CodexAppServerProviderCallbackId,
    };
    use crate::ServerStateService;
    use nucleus_agent_protocol::{AgentSessionId, ApprovalScope, UserInputPromptKind};
    use nucleus_engine::EngineTaskWorkItemId;
    use nucleus_local_store::SqliteBackend;
    use nucleus_tasks::TaskId;

    #[test]
    fn callback_request_persistence_survives_reopen_with_wait_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));
        let request = permission_request();
        let persisted = persist_codex_callback_request(
            &state,
            CodexAppServerCallbackRequestPersistenceInput {
                request,
                runtime_receipt_refs: vec!["receipt:runtime:1".to_owned()],
            },
        )
        .expect("persist callback request");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records =
            read_codex_callback_request_records(&reopened).expect("read callback requests");

        assert_eq!(records, vec![persisted.clone()]);
        assert_eq!(
            records[0].wait_state,
            CodexAppServerCallbackRequestPersistenceWaitState::WaitingForApproval
        );
        assert_eq!(records[0].provider_callback_id, "provider-callback:1");
        assert_eq!(records[0].task_id, "task:1");
        assert_eq!(records[0].work_item_id, "work:1");
        assert!(!records[0].callback_answering_authority);
        assert!(!records[0].response_sent);
        assert!(!records[0].raw_callback_material_retained);
        assert!(!records[0].raw_provider_payload_retained);
        assert!(!records[0].provider_io_executed);
        assert!(!records[0].task_mutation_permitted);
    }

    #[test]
    fn callback_request_persistence_preserves_user_input_wait_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let request = codex_callback_request(
            &test_support::runtime(),
            CodexAppServerProviderCallbackId("provider-callback:input".to_owned()),
            test_support::session_id(),
            None,
            Some("item:provider:input".to_owned()),
            test_support::task_id(),
            test_support::work_item_id(),
            CodexAppServerCallbackRequestKind::UserInput {
                kind: UserInputPromptKind::SelectOne,
                options: vec!["first".to_owned(), "second".to_owned()],
            },
            test_support::callback_prompt_ref(),
            test_support::metadata_only(),
        )
        .expect("user input request");

        let persisted = persist_codex_callback_request(
            &state,
            CodexAppServerCallbackRequestPersistenceInput {
                request,
                runtime_receipt_refs: Vec::new(),
            },
        )
        .expect("persist callback request");

        assert_eq!(
            persisted.wait_state,
            CodexAppServerCallbackRequestPersistenceWaitState::WaitingForUserInput
        );
        assert_eq!(persisted.options, vec!["first", "second"]);
    }

    #[test]
    fn callback_request_persistence_blocks_missing_provider_or_task_identity() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

        let missing_provider = codex_callback_request(
            &test_support::runtime(),
            CodexAppServerProviderCallbackId(String::new()),
            test_support::session_id(),
            None,
            None,
            test_support::task_id(),
            test_support::work_item_id(),
            CodexAppServerCallbackRequestKind::Permission {
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned()],
            },
            test_support::callback_prompt_ref(),
            test_support::metadata_only(),
        )
        .expect_err("missing provider identity blocked before persistence");
        assert!(matches!(
            missing_provider,
            super::super::callback_request::CodexAppServerCallbackRequestRejection::EmptyProviderCallbackId
        ));

        let missing_task = codex_callback_request(
            &test_support::runtime(),
            CodexAppServerProviderCallbackId("provider-callback:missing-task".to_owned()),
            AgentSessionId("session:1".to_owned()),
            None,
            None,
            TaskId(String::new()),
            EngineTaskWorkItemId("work:1".to_owned()),
            CodexAppServerCallbackRequestKind::Permission {
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned()],
            },
            test_support::callback_prompt_ref(),
            test_support::metadata_only(),
        )
        .expect_err("missing task identity blocked before persistence");
        assert!(matches!(
            missing_task,
            super::super::callback_request::CodexAppServerCallbackRequestRejection::EmptyTaskId
        ));

        assert!(read_codex_callback_request_records(&state)
            .expect("read callback records")
            .is_empty());
    }

    #[test]
    fn callback_request_persistence_rejects_raw_callback_material() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut prompt_ref = test_support::callback_prompt_ref();
        prompt_ref.retention = CodexAppServerCallbackPromptRetentionPolicy::RawPromptAllowed;
        let rejected = codex_callback_request(
            &test_support::runtime(),
            CodexAppServerProviderCallbackId("provider-callback:raw".to_owned()),
            test_support::session_id(),
            None,
            None,
            test_support::task_id(),
            test_support::work_item_id(),
            CodexAppServerCallbackRequestKind::Permission {
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned()],
            },
            prompt_ref,
            test_support::metadata_only(),
        )
        .expect_err("raw prompt blocked before persistence");

        assert!(matches!(
            rejected,
            super::super::callback_request::CodexAppServerCallbackRequestRejection::RawPromptRetentionNotAllowed
        ));
        assert!(read_codex_callback_request_records(&state)
            .expect("read callback records")
            .is_empty());
    }

    #[test]
    fn callback_request_persistence_payload_excludes_raw_material_terms() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        persist_codex_callback_request(
            &state,
            CodexAppServerCallbackRequestPersistenceInput {
                request: permission_request(),
                runtime_receipt_refs: vec!["receipt:runtime:1".to_owned()],
            },
        )
        .expect("persist callback request");

        let json = String::from_utf8(
            state.artifact_metadata().list().expect("metadata")[0]
                .payload
                .bytes
                .clone(),
        )
        .expect("json");

        for forbidden in ["raw_prompt", "secret-value", "raw_provider_payload\":true"] {
            assert!(
                !json.contains(forbidden),
                "callback persistence leaked {forbidden}"
            );
        }
    }

    fn permission_request() -> CodexAppServerCallbackRequest {
        codex_callback_request(
            &test_support::runtime(),
            CodexAppServerProviderCallbackId("provider-callback:1".to_owned()),
            test_support::session_id(),
            Some("turn:provider:1".to_owned()),
            Some("item:provider:1".to_owned()),
            test_support::task_id(),
            test_support::work_item_id(),
            CodexAppServerCallbackRequestKind::Permission {
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned(), "deny".to_owned()],
            },
            test_support::callback_prompt_ref(),
            test_support::metadata_only(),
        )
        .expect("permission request")
    }
}
