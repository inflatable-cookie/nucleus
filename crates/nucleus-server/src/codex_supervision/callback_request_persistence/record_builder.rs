use super::super::callback_request::CodexAppServerCallbackRequestKind;
use super::types::{
    CodexAppServerCallbackRequestPersistenceInput, CodexAppServerCallbackRequestPersistenceRecord,
    CodexAppServerCallbackRequestPersistenceWaitState,
};
use super::CALLBACK_REQUEST_PREFIX;

pub(super) fn persistence_record_from_input(
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
