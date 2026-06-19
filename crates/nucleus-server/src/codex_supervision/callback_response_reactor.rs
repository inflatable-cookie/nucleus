//! Codex callback-response reactor dry-run linkage.
//!
//! This module routes a sanitized callback-response envelope through the
//! generic provider command reactor. It does not write to Codex stdio or mutate
//! task state.

use nucleus_agent_protocol::AdapterCommandStreamState;

use crate::provider_command_reactor::{
    admit_provider_command, provider_command_dispatch_attempt, provider_command_reactor_outcome,
    queue_provider_command, ProviderCommandAdmissionInput, ProviderCommandAdmissionRecord,
    ProviderCommandCapabilityState, ProviderCommandDispatchAttemptRecord, ProviderCommandId,
    ProviderCommandReactorError, ProviderCommandReactorId, ProviderCommandReactorOutcomeRecord,
    ProviderCommandRequester, ProviderQueuedCommandRecord,
};
use crate::provider_service_runtime::{
    ProviderCommandFamily, ProviderCommandLaneId, ProviderReactorReadinessState,
    ProviderRuntimeStreamId, ProviderServiceId,
};

use super::callback_response_envelope::CodexAppServerCallbackResponseEnvelopeRecord;

/// Input for routing a Codex callback response envelope through the reactor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseReactorDryRunInput {
    pub envelope: CodexAppServerCallbackResponseEnvelopeRecord,
    pub reactor_id: ProviderCommandReactorId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub stream_id: Option<ProviderRuntimeStreamId>,
    pub reactor_state: ProviderReactorReadinessState,
    pub command_stream_state: AdapterCommandStreamState,
}

/// Full dry-run path for a Codex callback response envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseReactorDryRunRecord {
    pub envelope_id: String,
    pub provider_callback_id: String,
    pub method: String,
    pub admission: ProviderCommandAdmissionRecord,
    pub queued: ProviderQueuedCommandRecord,
    pub dispatch_attempt: ProviderCommandDispatchAttemptRecord,
    pub outcome: ProviderCommandReactorOutcomeRecord,
    pub live_send_disabled_reason: String,
    pub provider_write_started: bool,
    pub task_mutation_permitted: bool,
}

/// Route a Codex callback response envelope through reactor dry-run records.
pub fn codex_callback_response_reactor_dry_run(
    input: CodexAppServerCallbackResponseReactorDryRunInput,
) -> Result<CodexAppServerCallbackResponseReactorDryRunRecord, ProviderCommandReactorError> {
    let command_id = ProviderCommandId(format!(
        "provider-command:codex-callback-response:{}",
        input.envelope.provider_callback_id
    ));
    let mut evidence_refs = input.envelope.evidence_refs.clone();
    evidence_refs.push(format!("envelope:{}", input.envelope.envelope_id.0));
    evidence_refs.push(format!(
        "provider-callback:{}",
        input.envelope.provider_callback_id
    ));

    let admission = admit_provider_command(ProviderCommandAdmissionInput {
        command_id,
        reactor_id: input.reactor_id,
        service_id: input.service_id,
        command_lane_id: input.command_lane_id,
        stream_id: input.stream_id,
        family: ProviderCommandFamily::RespondToProviderCallback,
        target_ref: Some(input.envelope.provider_callback_id.clone()),
        requester: ProviderCommandRequester::User,
        capability: ProviderCommandCapabilityState::Supported,
        reactor_state: input.reactor_state,
        command_stream_state: input.command_stream_state,
        live_send_requested: false,
        task_mutation_requested: false,
        evidence_refs,
    });
    let queued = queue_provider_command(&admission)?;
    let dispatch_attempt = provider_command_dispatch_attempt(
        &queued,
        vec![
            format!("dry-run:{}", input.envelope.envelope_id.0),
            format!("provider-callback:{}", input.envelope.provider_callback_id),
            "live-send-disabled:provider-command-reactor-gate".to_owned(),
        ],
    )?;
    let outcome = provider_command_reactor_outcome(&dispatch_attempt);

    Ok(CodexAppServerCallbackResponseReactorDryRunRecord {
        envelope_id: input.envelope.envelope_id.0,
        provider_callback_id: input.envelope.provider_callback_id,
        method: input.envelope.method,
        admission,
        queued,
        dispatch_attempt,
        outcome,
        live_send_disabled_reason:
            "live provider send is disabled until the provider command reactor gate closes"
                .to_owned(),
        provider_write_started: false,
        task_mutation_permitted: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_callback_response, codex_callback_request, codex_callback_response_envelope,
        CodexAppServerCallbackPromptRef, CodexAppServerCallbackPromptRetentionPolicy,
        CodexAppServerCallbackRequestKind, CodexAppServerCallbackResponse,
        CodexAppServerCallbackResponseAdmissionInput, CodexAppServerPayloadRetentionPolicy,
        CodexAppServerProviderCallbackId,
    };
    use crate::provider_runtime_orchestration::{
        event_store_record_from_provider_outcome, runtime_receipt_from_provider_outcome,
    };
    use crate::provider_runtime_outcome_from_reactor_outcome;
    use nucleus_agent_protocol::ApprovalScope;
    use nucleus_engine::{EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptStatus};
    use nucleus_orchestration::OrchestrationEventKind;

    #[test]
    fn callback_response_envelope_routes_through_reactor_dry_run_without_provider_send() {
        let dry_run = codex_callback_response_reactor_dry_run(input(envelope())).expect("dry run");
        let runtime_outcome = provider_runtime_outcome_from_reactor_outcome(&dry_run.outcome);
        let receipt = runtime_receipt_from_provider_outcome(&runtime_outcome);
        let event = event_store_record_from_provider_outcome(&runtime_outcome);

        assert_eq!(dry_run.method, "serverRequest/resolved");
        assert_eq!(dry_run.provider_callback_id, "provider-callback:1");
        assert_eq!(
            dry_run.admission.family,
            ProviderCommandFamily::RespondToProviderCallback
        );
        assert_eq!(
            dry_run.queued.family,
            ProviderCommandFamily::RespondToProviderCallback
        );
        assert_eq!(
            dry_run.admission.target_ref.as_deref(),
            Some("provider-callback:1")
        );
        assert!(!dry_run.provider_write_started);
        assert!(!dry_run.dispatch_attempt.live_send_attempted);
        assert!(!dry_run.task_mutation_permitted);
        assert!(dry_run
            .live_send_disabled_reason
            .contains("provider command reactor gate"));
        assert_eq!(
            receipt.family,
            EngineRuntimeReceiptEffectFamily::HarnessProvider
        );
        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::Completed);
        assert_eq!(
            event.kind,
            OrchestrationEventKind::RuntimeObservationAccepted
        );
    }

    #[test]
    fn callback_response_reactor_dry_run_blocks_when_command_lane_is_closed() {
        let mut input = input(envelope());
        input.command_stream_state = AdapterCommandStreamState::Closed;

        let error = codex_callback_response_reactor_dry_run(input).expect_err("blocked");

        assert_eq!(error, ProviderCommandReactorError::AdmissionNotAccepted);
    }

    fn input(
        envelope: CodexAppServerCallbackResponseEnvelopeRecord,
    ) -> CodexAppServerCallbackResponseReactorDryRunInput {
        CodexAppServerCallbackResponseReactorDryRunInput {
            envelope,
            reactor_id: ProviderCommandReactorId("provider-reactor:codex".to_owned()),
            service_id: ProviderServiceId("provider-service:codex".to_owned()),
            command_lane_id: ProviderCommandLaneId("provider-command-lane:codex".to_owned()),
            stream_id: Some(ProviderRuntimeStreamId(
                "provider-event-stream:codex".to_owned(),
            )),
            reactor_state: ProviderReactorReadinessState::ReadyForCommands,
            command_stream_state: AdapterCommandStreamState::Accepting,
        }
    }

    fn envelope() -> CodexAppServerCallbackResponseEnvelopeRecord {
        let runtime = crate::codex_supervision::test_support::runtime();
        let request = codex_callback_request(
            &runtime,
            CodexAppServerProviderCallbackId("provider-callback:1".to_owned()),
            crate::codex_supervision::test_support::session_id(),
            Some("turn:provider:1".to_owned()),
            Some("item:provider:1".to_owned()),
            crate::codex_supervision::test_support::task_id(),
            crate::codex_supervision::test_support::work_item_id(),
            CodexAppServerCallbackRequestKind::Permission {
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned(), "deny".to_owned()],
            },
            CodexAppServerCallbackPromptRef {
                prompt_ref: "callback-prompt:1".to_owned(),
                summary: "callback summary".to_owned(),
                retention: CodexAppServerCallbackPromptRetentionPolicy::SummaryAndRefOnly,
            },
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect("callback request");
        let admission =
            admit_codex_callback_response(CodexAppServerCallbackResponseAdmissionInput {
                request: request.clone(),
                response: CodexAppServerCallbackResponse::Permission {
                    selected_option: "allow".to_owned(),
                },
                response_authority_confirmed: true,
                runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
                raw_payload_policy_confirmed: true,
            });

        codex_callback_response_envelope(&request, &admission).expect("envelope")
    }
}
