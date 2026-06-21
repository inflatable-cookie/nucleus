use super::super::callback_request::CodexAppServerCallbackRequest;

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
