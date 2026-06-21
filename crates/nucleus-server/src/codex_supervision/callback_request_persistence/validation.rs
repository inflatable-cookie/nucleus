use nucleus_local_store::{LocalStoreError, LocalStoreResult};

use super::super::callback_request::{
    CodexAppServerCallbackPromptRetentionPolicy, CodexAppServerCallbackRequest,
};
use super::super::runtime_instance::CodexAppServerPayloadRetentionPolicy;

pub(super) fn validate_request_for_persistence(
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

fn invalid<T>(reason: impl Into<String>) -> LocalStoreResult<T> {
    Err(LocalStoreError::InvalidRecord {
        reason: reason.into(),
    })
}
