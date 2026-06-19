//! Codex turn-start reactor dry-run linkage.
//!
//! This module routes a sanitized turn-start envelope through the generic
//! provider command reactor. It does not write to Codex stdio or mutate task
//! state.

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

use super::turn_start_envelope::CodexAppServerTurnStartEnvelopeRecord;

/// Input for routing a Codex turn-start envelope through the reactor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartReactorDryRunInput {
    pub envelope: CodexAppServerTurnStartEnvelopeRecord,
    pub reactor_id: ProviderCommandReactorId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub stream_id: Option<ProviderRuntimeStreamId>,
    pub reactor_state: ProviderReactorReadinessState,
    pub command_stream_state: AdapterCommandStreamState,
}

/// Full dry-run path for a Codex turn-start envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartReactorDryRunRecord {
    pub envelope_id: String,
    pub method: String,
    pub admission: ProviderCommandAdmissionRecord,
    pub queued: ProviderQueuedCommandRecord,
    pub dispatch_attempt: ProviderCommandDispatchAttemptRecord,
    pub outcome: ProviderCommandReactorOutcomeRecord,
    pub live_send_disabled_reason: String,
    pub provider_write_started: bool,
    pub task_mutation_permitted: bool,
}

/// Route a Codex turn-start envelope through reactor dry-run records.
pub fn codex_turn_start_reactor_dry_run(
    input: CodexAppServerTurnStartReactorDryRunInput,
) -> Result<CodexAppServerTurnStartReactorDryRunRecord, ProviderCommandReactorError> {
    let command_id = ProviderCommandId(format!(
        "provider-command:codex-turn-start:{}",
        input.envelope.envelope_id.0
    ));
    let mut evidence_refs = input.envelope.evidence_refs.clone();
    evidence_refs.push(format!("envelope:{}", input.envelope.envelope_id.0));

    let admission = admit_provider_command(ProviderCommandAdmissionInput {
        command_id,
        reactor_id: input.reactor_id,
        service_id: input.service_id,
        command_lane_id: input.command_lane_id,
        stream_id: input.stream_id,
        family: ProviderCommandFamily::StartTurn,
        target_ref: Some(input.envelope.session_id.clone()),
        requester: ProviderCommandRequester::TaskAgent,
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
            "live-send-disabled:provider-command-reactor-gate".to_owned(),
        ],
    )?;
    let outcome = provider_command_reactor_outcome(&dispatch_attempt);

    Ok(CodexAppServerTurnStartReactorDryRunRecord {
        envelope_id: input.envelope.envelope_id.0,
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
        admit_codex_turn_start, codex_turn_start_envelope, codex_turn_start_request,
        CodexAppServerTurnStartAdmissionInput, CodexAppServerTurnStartDeferredPolicy,
        CodexAppServerTurnStartPromptRef, CodexAppServerTurnStartPromptRetentionPolicy,
    };
    use crate::provider_runtime_orchestration::{
        event_store_record_from_provider_outcome, runtime_receipt_from_provider_outcome,
    };
    use crate::{
        provider_runtime_outcome_from_reactor_outcome, CodexAppServerPayloadRetentionPolicy,
    };
    use nucleus_engine::{EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptStatus};
    use nucleus_orchestration::OrchestrationEventKind;

    #[test]
    fn turn_start_envelope_routes_through_reactor_dry_run_without_provider_send() {
        let dry_run = codex_turn_start_reactor_dry_run(input(envelope())).expect("dry run");
        let runtime_outcome = provider_runtime_outcome_from_reactor_outcome(&dry_run.outcome);
        let receipt = runtime_receipt_from_provider_outcome(&runtime_outcome);
        let event = event_store_record_from_provider_outcome(&runtime_outcome);

        assert_eq!(dry_run.method, "turn/start");
        assert_eq!(dry_run.admission.family, ProviderCommandFamily::StartTurn);
        assert_eq!(dry_run.queued.family, ProviderCommandFamily::StartTurn);
        assert_eq!(
            dry_run.dispatch_attempt.mode,
            crate::ProviderCommandDispatchMode::DryRunOnly
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
    fn turn_start_reactor_dry_run_blocks_when_reactor_is_not_ready() {
        let mut input = input(envelope());
        input.reactor_state = ProviderReactorReadinessState::Blocked;

        let error = codex_turn_start_reactor_dry_run(input).expect_err("blocked");

        assert_eq!(error, ProviderCommandReactorError::AdmissionNotAccepted);
    }

    fn input(
        envelope: CodexAppServerTurnStartEnvelopeRecord,
    ) -> CodexAppServerTurnStartReactorDryRunInput {
        CodexAppServerTurnStartReactorDryRunInput {
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

    fn envelope() -> CodexAppServerTurnStartEnvelopeRecord {
        let runtime = crate::codex_supervision::test_support::runtime();
        let request = codex_turn_start_request(
            &runtime,
            crate::codex_supervision::test_support::session_id(),
            crate::codex_supervision::test_support::task_id(),
            crate::codex_supervision::test_support::work_item_id(),
            CodexAppServerTurnStartPromptRef {
                prompt_ref: "prompt:1".to_owned(),
                summary: "turn prompt summary".to_owned(),
                retention: CodexAppServerTurnStartPromptRetentionPolicy::SummaryAndRefOnly,
            },
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect("turn request");
        let admission = admit_codex_turn_start(CodexAppServerTurnStartAdmissionInput {
            request: request.clone(),
            runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
            task_work_ready: true,
            assignment_ready: true,
            callback_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            cancellation_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            raw_payload_policy_confirmed: true,
        });

        codex_turn_start_envelope(&request, &admission).expect("envelope")
    }
}
