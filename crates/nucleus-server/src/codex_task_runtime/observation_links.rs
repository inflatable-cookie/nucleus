//! Reference-only Codex observation links for task work items.
//!
//! These records connect accepted runtime observation evidence to a task work
//! item. They do not mutate task or work-item state.

use super::{CodexTaskRuntimeRequestId, CodexTaskRuntimeRequestRecord};
use crate::codex_supervision::{
    CodexAppServerObservationEventLink, CodexAppServerObservationEventLinkStatus,
};
use nucleus_engine::EngineTaskWorkItemId;
use nucleus_tasks::TaskId;

/// Reference-only link from a Codex observation to the owning task work item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeObservationLink {
    pub link_id: String,
    pub request_id: CodexTaskRuntimeRequestId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub source_id: String,
    pub binding_id: String,
    pub event_store_event_id: Option<String>,
    pub receipt_id: Option<String>,
    pub evidence_refs: Vec<String>,
    pub status: CodexTaskRuntimeObservationLinkStatus,
    pub permits_task_state_mutation: bool,
    pub summary: String,
}

/// Task-work link status derived from the observation event link.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexTaskRuntimeObservationLinkStatus {
    Linked,
    ReceiptOnly,
    NotLinked(String),
}

/// Link an observation event/receipt record to a task runtime request.
pub fn link_codex_observation_to_task_runtime(
    request: &CodexTaskRuntimeRequestRecord,
    observation: &CodexAppServerObservationEventLink,
) -> CodexTaskRuntimeObservationLink {
    let event_store_event_id = observation
        .event_store_record
        .as_ref()
        .map(|record| record.event_id.0.clone());
    let receipt_id = observation
        .receipt_id
        .as_ref()
        .map(|receipt_id| receipt_id.0.clone());
    let mut evidence_refs = vec![observation.source_id.clone()];
    if let Some(event_id) = &event_store_event_id {
        evidence_refs.push(event_id.clone());
    }
    if let Some(receipt_id) = &receipt_id {
        evidence_refs.push(receipt_id.clone());
    }

    let status = match &observation.status {
        CodexAppServerObservationEventLinkStatus::Linked => {
            CodexTaskRuntimeObservationLinkStatus::Linked
        }
        CodexAppServerObservationEventLinkStatus::ReceiptOnly => {
            CodexTaskRuntimeObservationLinkStatus::ReceiptOnly
        }
        CodexAppServerObservationEventLinkStatus::NotLinked(reason) => {
            CodexTaskRuntimeObservationLinkStatus::NotLinked(reason.clone())
        }
    };

    CodexTaskRuntimeObservationLink {
        link_id: format!(
            "codex-task-observation-link:{}:{}",
            request.work_item_id.0, observation.source_id
        ),
        request_id: request.request_id.clone(),
        task_id: request.task_id.clone(),
        work_item_id: request.work_item_id.clone(),
        source_id: observation.source_id.clone(),
        binding_id: observation.binding_id.clone(),
        event_store_event_id,
        receipt_id,
        evidence_refs,
        status,
        permits_task_state_mutation: false,
        summary: task_observation_summary(observation),
    }
}

fn task_observation_summary(observation: &CodexAppServerObservationEventLink) -> String {
    match &observation.status {
        CodexAppServerObservationEventLinkStatus::Linked => {
            "Codex observation linked to task work evidence".to_owned()
        }
        CodexAppServerObservationEventLinkStatus::ReceiptOnly => {
            "Codex runtime receipt linked to task work evidence".to_owned()
        }
        CodexAppServerObservationEventLinkStatus::NotLinked(reason) => {
            format!("Codex observation not linked: {reason}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        accept_codex_ingestion_source, codex_ingestion_source_from_live_frame,
        codex_session_binding_from_live_frame, link_codex_observation_to_event_store,
        CodexAppServerFrameAcceptanceContext, CodexAppServerFrameAcceptanceStatus,
        CodexAppServerLiveFrame, CodexAppServerObservationKind,
    };
    use crate::ids::ServerEventId;
    use nucleus_agent_protocol::{
        AdapterIdentity, AgentSessionId, AuthenticationPreflight, CodexAppServerEventFixture,
        CodexAppServerFixturePayload, CodexAppServerProviderRefs, ProviderDriverKind,
        TransportFamily, VersionDiscovery,
    };
    use nucleus_command_policy::CommandRequestId;
    use nucleus_engine::{EngineTaskAgentWorkUnitSourceId, EngineTaskWorkItemId};
    use nucleus_projects::ProjectId;

    fn request() -> CodexTaskRuntimeRequestRecord {
        CodexTaskRuntimeRequestRecord {
            request_id: CodexTaskRuntimeRequestId("codex-task-runtime:1".to_owned()),
            project_id: ProjectId("project:1".to_owned()),
            task_id: TaskId("task:1".to_owned()),
            work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
            source_id: EngineTaskAgentWorkUnitSourceId("source:1".to_owned()),
            adapter: AdapterIdentity {
                adapter_id: "adapter:codex".to_owned(),
                provider_driver_kind: ProviderDriverKind::Codex,
                provider_instance_id: "provider:codex".to_owned(),
                provider_name: "OpenAI Codex".to_owned(),
                harness_name: "codex app-server".to_owned(),
                transport_family: TransportFamily::StructuredAppServerRuntime,
                version_discovery: VersionDiscovery::Unsupported,
                authentication_preflight: AuthenticationPreflight::Unsupported,
            },
            command_request_id: CommandRequestId("command:delegate".to_owned()),
            event_id: ServerEventId("event:task-runtime-request".to_owned()),
            nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
            codex_refs: super::super::CodexTaskRuntimeProviderRefs {
                provider_session_id: Some("session:provider".to_owned()),
                provider_thread_id: Some("thread:provider".to_owned()),
                provider_turn_id: Some("turn:provider".to_owned()),
                provider_item_id: None,
                provider_request_id: None,
            },
            summary: "admit task work unit to Codex runtime".to_owned(),
        }
    }

    fn accepted_observation() -> CodexAppServerObservationEventLink {
        let frame = CodexAppServerLiveFrame {
            fixture: CodexAppServerEventFixture {
                method: "turn/completed".to_owned(),
                provider_instance_id: "provider:codex".to_owned(),
                nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
                provider_refs: CodexAppServerProviderRefs {
                    thread_id: Some("thread:provider".to_owned()),
                    session_id: Some("session:provider".to_owned()),
                    turn_id: Some("turn:provider".to_owned()),
                    item_id: None,
                    request_id: None,
                },
                sequence: 1,
                payload: CodexAppServerFixturePayload::TurnCompleted {
                    status_detail: Some("completed".to_owned()),
                },
                raw_payload: None,
            },
            transport_sequence: 1,
        };
        let binding = codex_session_binding_from_live_frame(&frame);
        let source = codex_ingestion_source_from_live_frame(&binding, &frame);
        let acceptance = accept_codex_ingestion_source(
            &source,
            CodexAppServerObservationKind::CanonicalRuntimeEvent,
            &CodexAppServerFrameAcceptanceContext::default(),
        );
        link_codex_observation_to_event_store(&acceptance, None)
    }

    #[test]
    fn task_observation_link_is_reference_only() {
        let link = link_codex_observation_to_task_runtime(&request(), &accepted_observation());

        assert_eq!(link.task_id, TaskId("task:1".to_owned()));
        assert_eq!(link.work_item_id, EngineTaskWorkItemId("work:1".to_owned()));
        assert!(matches!(
            link.status,
            CodexTaskRuntimeObservationLinkStatus::Linked
        ));
        assert!(link.event_store_event_id.is_some());
        assert!(!link.permits_task_state_mutation);
        assert!(link
            .evidence_refs
            .iter()
            .any(|value| value.starts_with("event:")));
    }

    #[test]
    fn not_linked_observation_stays_visible_without_task_mutation() {
        let mut observation = accepted_observation();
        observation.status = CodexAppServerObservationEventLinkStatus::NotLinked(
            "observation status is Duplicate".to_owned(),
        );
        observation.event_store_record = None;

        let link = link_codex_observation_to_task_runtime(&request(), &observation);

        assert!(matches!(
            link.status,
            CodexTaskRuntimeObservationLinkStatus::NotLinked(_)
        ));
        assert!(link.event_store_event_id.is_none());
        assert!(!link.permits_task_state_mutation);
        assert!(link.summary.contains("not linked"));
    }

    #[test]
    fn duplicate_acceptance_can_be_linked_as_not_linked_evidence() {
        let mut observation = accepted_observation();
        observation.status = CodexAppServerObservationEventLinkStatus::NotLinked(format!(
            "observation status is {:?}",
            CodexAppServerFrameAcceptanceStatus::Duplicate
        ));
        observation.event_store_record = None;

        let link = link_codex_observation_to_task_runtime(&request(), &observation);

        assert_eq!(link.evidence_refs[0], observation.source_id);
        assert!(!link.permits_task_state_mutation);
    }
}
