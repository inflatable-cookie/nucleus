//! Provider runtime outcome linkage to orchestration receipts and events.
//!
//! These records make provider service outcomes inspectable through existing
//! receipt and event vocabulary. They do not project provider observations into
//! task state.

use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};
use nucleus_orchestration::{
    EventStreamRef, OrchestrationCommandId, OrchestrationEventId, OrchestrationEventRecord,
    OrchestrationEventStoreRecord,
};

use crate::provider_service_runtime::{
    ProviderCommandFamily, ProviderCommandLaneId, ProviderRuntimeStreamId, ProviderServiceId,
};

/// Stable id for one provider runtime outcome.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderRuntimeOutcomeId(pub String);

/// Provider service outcome ready for receipt/event linkage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRuntimeOutcomeRecord {
    pub outcome_id: ProviderRuntimeOutcomeId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub stream_id: Option<ProviderRuntimeStreamId>,
    pub command_family: ProviderCommandFamily,
    pub status: ProviderRuntimeOutcomeStatus,
    pub evidence_refs: Vec<String>,
    pub summary: String,
    pub task_mutation_permitted: bool,
}

/// Provider runtime outcome status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderRuntimeOutcomeStatus {
    Accepted,
    Queued,
    InProgress,
    Completed,
    Blocked(String),
    Failed(String),
    RecoveryRequired(String),
    Unsupported(String),
}

/// Projection readiness for provider runtime observations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRuntimeProjectionReadiness {
    pub service_id: ProviderServiceId,
    pub outcome_id: ProviderRuntimeOutcomeId,
    pub gaps: Vec<ProviderRuntimeProjectionGap>,
    pub task_mutation_allowed: bool,
}

/// Missing rule before provider observations can affect task state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderRuntimeProjectionGap {
    TaskMutationGateNotSelected,
    ProviderObservationProjectionNotDefined,
    TaskWorkItemLinkRequired,
    HumanReviewPolicyRequired,
}

/// Build a runtime receipt for a provider service outcome.
pub fn runtime_receipt_from_provider_outcome(
    outcome: &ProviderRuntimeOutcomeRecord,
) -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!("receipt:{}", outcome.outcome_id.0)),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: receipt_status(&outcome.status),
        command_ref: Some(EngineRuntimeReceiptRef::Custom(
            outcome.command_lane_id.0.clone(),
        )),
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(
            outcome.service_id.0.clone(),
        )),
        evidence_refs: outcome
            .evidence_refs
            .iter()
            .map(|value| EngineRuntimeReceiptRef::Custom(value.clone()))
            .collect(),
        artifact_refs: outcome
            .stream_id
            .iter()
            .map(|value| EngineRuntimeReceiptRef::Custom(value.0.clone()))
            .collect(),
        summary: Some(outcome.summary.clone()),
    }
}

/// Build a replay-safe runtime observation event for a provider outcome.
pub fn event_store_record_from_provider_outcome(
    outcome: &ProviderRuntimeOutcomeRecord,
) -> OrchestrationEventStoreRecord {
    let event = OrchestrationEventRecord::runtime_observation_accepted(
        OrchestrationEventId(format!("event:provider-runtime:{}", outcome.outcome_id.0)),
        OrchestrationCommandId(format!(
            "command:provider-runtime:{}",
            outcome.command_lane_id.0
        )),
        Some(outcome.service_id.0.clone()),
    );

    OrchestrationEventStoreRecord::from_event(
        EventStreamRef(format!("stream:provider-runtime:{}", outcome.service_id.0)),
        event,
    )
}

/// Report current projection gaps before task mutation is allowed.
pub fn provider_runtime_projection_readiness(
    outcome: &ProviderRuntimeOutcomeRecord,
) -> ProviderRuntimeProjectionReadiness {
    ProviderRuntimeProjectionReadiness {
        service_id: outcome.service_id.clone(),
        outcome_id: outcome.outcome_id.clone(),
        gaps: vec![
            ProviderRuntimeProjectionGap::TaskMutationGateNotSelected,
            ProviderRuntimeProjectionGap::ProviderObservationProjectionNotDefined,
            ProviderRuntimeProjectionGap::TaskWorkItemLinkRequired,
            ProviderRuntimeProjectionGap::HumanReviewPolicyRequired,
        ],
        task_mutation_allowed: false,
    }
}

fn receipt_status(status: &ProviderRuntimeOutcomeStatus) -> EngineRuntimeReceiptStatus {
    match status {
        ProviderRuntimeOutcomeStatus::Accepted => EngineRuntimeReceiptStatus::Accepted,
        ProviderRuntimeOutcomeStatus::Queued => EngineRuntimeReceiptStatus::Queued,
        ProviderRuntimeOutcomeStatus::InProgress => EngineRuntimeReceiptStatus::InProgress,
        ProviderRuntimeOutcomeStatus::Completed => EngineRuntimeReceiptStatus::Completed,
        ProviderRuntimeOutcomeStatus::Blocked(_) => EngineRuntimeReceiptStatus::Blocked,
        ProviderRuntimeOutcomeStatus::Failed(_) => EngineRuntimeReceiptStatus::Failed,
        ProviderRuntimeOutcomeStatus::RecoveryRequired(_) => {
            EngineRuntimeReceiptStatus::RecoveryRequired
        }
        ProviderRuntimeOutcomeStatus::Unsupported(_) => EngineRuntimeReceiptStatus::Blocked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_orchestration::OrchestrationEventKind;

    #[test]
    fn provider_outcome_maps_to_harness_provider_receipt_without_task_mutation() {
        let outcome = provider_outcome(ProviderRuntimeOutcomeStatus::Completed);

        let receipt = runtime_receipt_from_provider_outcome(&outcome);

        assert_eq!(
            receipt.family,
            EngineRuntimeReceiptEffectFamily::HarnessProvider
        );
        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::Completed);
        assert_eq!(
            receipt.command_ref,
            Some(EngineRuntimeReceiptRef::Custom(
                "provider-command-lane:codex".to_owned()
            ))
        );
        assert_eq!(
            receipt.effect_ref,
            Some(EngineRuntimeReceiptRef::Custom(
                "provider-service:codex".to_owned()
            ))
        );
        assert!(!outcome.task_mutation_permitted);
    }

    #[test]
    fn provider_outcome_maps_to_runtime_observation_event() {
        let outcome = provider_outcome(ProviderRuntimeOutcomeStatus::InProgress);

        let event = event_store_record_from_provider_outcome(&outcome);

        assert_eq!(
            event.kind,
            OrchestrationEventKind::RuntimeObservationAccepted
        );
        assert_eq!(
            event.stream_ref,
            EventStreamRef("stream:provider-runtime:provider-service:codex".to_owned())
        );
        assert_eq!(event.target_ref, Some("provider-service:codex".to_owned()));
    }

    #[test]
    fn provider_runtime_projection_keeps_task_mutation_blocked() {
        let outcome = provider_outcome(ProviderRuntimeOutcomeStatus::Completed);

        let readiness = provider_runtime_projection_readiness(&outcome);

        assert!(!readiness.task_mutation_allowed);
        assert!(readiness
            .gaps
            .contains(&ProviderRuntimeProjectionGap::TaskMutationGateNotSelected));
        assert!(readiness
            .gaps
            .contains(&ProviderRuntimeProjectionGap::HumanReviewPolicyRequired));
    }

    fn provider_outcome(status: ProviderRuntimeOutcomeStatus) -> ProviderRuntimeOutcomeRecord {
        ProviderRuntimeOutcomeRecord {
            outcome_id: ProviderRuntimeOutcomeId("provider-outcome:1".to_owned()),
            service_id: ProviderServiceId("provider-service:codex".to_owned()),
            command_lane_id: ProviderCommandLaneId("provider-command-lane:codex".to_owned()),
            stream_id: Some(ProviderRuntimeStreamId(
                "provider-event-stream:codex".to_owned(),
            )),
            command_family: ProviderCommandFamily::StartTurn,
            status,
            evidence_refs: vec!["evidence:provider-outcome".to_owned()],
            summary: "provider turn completed".to_owned(),
            task_mutation_permitted: false,
        }
    }
}
