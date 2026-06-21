use nucleus_local_store::{LocalStoreError, LocalStoreRecordPayload, LocalStoreResult};
use serde::{Deserialize, Serialize};

use super::types::{
    CodexAppServerCallbackRequestPersistenceRecord,
    CodexAppServerCallbackRequestPersistenceWaitState,
};

pub(super) fn encode_callback_request_record(
    record: &CodexAppServerCallbackRequestPersistenceRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(&CallbackRequestRecordDto::from_record(record)).map_err(json_error)
}

pub(super) fn decode_callback_request_record(
    bytes: &[u8],
) -> LocalStoreResult<CodexAppServerCallbackRequestPersistenceRecord> {
    let dto: CallbackRequestRecordDto = serde_json::from_slice(bytes).map_err(json_error)?;
    Ok(dto.into_record())
}

pub(super) fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
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
