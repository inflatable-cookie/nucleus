//! Runtime observation replay projection.
//!
//! This module rebuilds read-only observation progress from persisted
//! event-store and event-persistence records. It does not replay provider I/O,
//! answer callbacks, or mutate task state.

use nucleus_orchestration::{OrchestrationEventKind, OrchestrationEventStoreRecord};

use super::runtime_observation_event_store_persistence::{
    CodexRuntimeObservationEventStorePersistenceRecord,
    CodexRuntimeObservationEventStorePersistenceStatus,
};

/// Read-only projection rebuilt from runtime observation events.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CodexRuntimeObservationReplayProjection {
    pub accepted_event_count: usize,
    pub persisted_observation_count: usize,
    pub session_progress_refs: Vec<String>,
    pub wait_state_refs: Vec<String>,
    pub terminal_state_refs: Vec<String>,
    pub unsupported_observation_refs: Vec<String>,
    pub repair_need_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub last_event_id: Option<String>,
    pub provider_io_executed: bool,
    pub task_mutation_permitted: bool,
}

/// Rebuild runtime observation projection from persisted records.
pub fn rebuild_codex_runtime_observation_replay_projection(
    events: &[OrchestrationEventStoreRecord],
    persistence_records: &[CodexRuntimeObservationEventStorePersistenceRecord],
) -> CodexRuntimeObservationReplayProjection {
    let mut projection = CodexRuntimeObservationReplayProjection::default();

    let mut sorted_events = events.to_vec();
    sorted_events.sort_by(|left, right| left.event_id.0.cmp(&right.event_id.0));
    for event in sorted_events {
        if event.kind != OrchestrationEventKind::RuntimeObservationAccepted {
            continue;
        }
        projection.accepted_event_count += 1;
        if let Some(target_ref) = event.target_ref {
            push_unique(&mut projection.session_progress_refs, target_ref);
        }
        projection.last_event_id = Some(event.event_id.0);
    }

    let mut sorted_records = persistence_records.to_vec();
    sorted_records.sort_by(|left, right| left.persistence_id.cmp(&right.persistence_id));
    projection.persisted_observation_count = sorted_records.len();
    for record in sorted_records {
        for evidence_ref in &record.evidence_refs {
            push_unique(&mut projection.evidence_refs, evidence_ref.clone());
        }

        match record.status {
            CodexRuntimeObservationEventStorePersistenceStatus::Persisted
            | CodexRuntimeObservationEventStorePersistenceStatus::DuplicateNoop => {
                classify_progress(&mut projection, &record);
            }
            CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly => {
                if record.observation_kind.contains("UnsupportedObservation") {
                    push_unique(
                        &mut projection.unsupported_observation_refs,
                        record.identity_id.clone(),
                    );
                }
                push_unique(&mut projection.repair_need_refs, record.identity_id.clone());
            }
            CodexRuntimeObservationEventStorePersistenceStatus::Blocked => {
                push_unique(&mut projection.repair_need_refs, record.identity_id.clone());
            }
        }
    }

    projection.provider_io_executed = false;
    projection.task_mutation_permitted = false;
    projection
}

fn classify_progress(
    projection: &mut CodexRuntimeObservationReplayProjection,
    record: &CodexRuntimeObservationEventStorePersistenceRecord,
) {
    let method = record.method.as_deref().unwrap_or_default();
    if method.contains("completed") || method.contains("failed") || method.contains("terminal") {
        push_unique(
            &mut projection.terminal_state_refs,
            record.identity_id.clone(),
        );
    }
    if method.contains("callback") || method.contains("wait") || method.contains("permission") {
        push_unique(&mut projection.wait_state_refs, record.identity_id.clone());
    }
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_orchestration::{
        EventStreamRef, OrchestrationCommandId, OrchestrationEventId, OrchestrationEventRecord,
    };

    #[test]
    fn runtime_observation_replay_projection_is_deterministic() {
        let events = vec![event("event:2", "binding:2"), event("event:1", "binding:1")];
        let records = vec![
            persistence_record("persistence:2", "identity:2", Some("provider/callback")),
            persistence_record("persistence:1", "identity:1", Some("turn/completed")),
        ];

        let first = rebuild_codex_runtime_observation_replay_projection(&events, &records);
        let second = rebuild_codex_runtime_observation_replay_projection(&events, &records);

        assert_eq!(first, second);
        assert_eq!(first.accepted_event_count, 2);
        assert_eq!(first.last_event_id, Some("event:2".to_owned()));
        assert_eq!(first.session_progress_refs, vec!["binding:1", "binding:2"]);
        assert_eq!(first.terminal_state_refs, vec!["identity:1"]);
        assert_eq!(first.wait_state_refs, vec!["identity:2"]);
        assert!(!first.provider_io_executed);
        assert!(!first.task_mutation_permitted);
    }

    #[test]
    fn runtime_observation_replay_projection_keeps_unsupported_visible() {
        let mut unsupported =
            persistence_record("persistence:unsupported", "identity:unsupported", None);
        unsupported.status = CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly;
        unsupported.observation_kind = "UnsupportedObservation".to_owned();

        let projection = rebuild_codex_runtime_observation_replay_projection(&[], &[unsupported]);

        assert_eq!(
            projection.unsupported_observation_refs,
            vec!["identity:unsupported"]
        );
        assert_eq!(projection.repair_need_refs, vec!["identity:unsupported"]);
    }

    #[test]
    fn runtime_observation_replay_projection_rebuilds_repair_needs_read_only() {
        let mut blocked = persistence_record("persistence:blocked", "identity:blocked", None);
        blocked.status = CodexRuntimeObservationEventStorePersistenceStatus::Blocked;
        blocked.evidence_refs = vec!["evidence:blocked".to_owned()];

        let projection = rebuild_codex_runtime_observation_replay_projection(&[], &[blocked]);

        assert_eq!(projection.repair_need_refs, vec!["identity:blocked"]);
        assert_eq!(projection.evidence_refs, vec!["evidence:blocked"]);
        assert!(!projection.provider_io_executed);
        assert!(!projection.task_mutation_permitted);
    }

    fn event(event_id: &str, target_ref: &str) -> OrchestrationEventStoreRecord {
        let payload = OrchestrationEventRecord::runtime_observation_accepted(
            OrchestrationEventId(event_id.to_owned()),
            OrchestrationCommandId(format!("command:{event_id}")),
            Some(target_ref.to_owned()),
        );
        OrchestrationEventStoreRecord::from_event(
            EventStreamRef(format!("stream:{target_ref}")),
            payload,
        )
    }

    fn persistence_record(
        persistence_id: &str,
        identity_id: &str,
        method: Option<&str>,
    ) -> CodexRuntimeObservationEventStorePersistenceRecord {
        CodexRuntimeObservationEventStorePersistenceRecord {
            persistence_id: persistence_id.to_owned(),
            identity_id: identity_id.to_owned(),
            event_id: Some(format!("event:{identity_id}")),
            command_id: format!("command:{identity_id}"),
            stream_ref: "stream:runtime-session:codex:1".to_owned(),
            target_ref: "provider-session-binding:1".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            runtime_session_ref: "runtime-session:codex:1".to_owned(),
            binding_id: "provider-session-binding:1".to_owned(),
            frame_source_id: format!("frame:{identity_id}"),
            decode_outcome_id: format!("decode:{identity_id}"),
            method: method.map(str::to_owned),
            observation_kind: "CanonicalRuntimeEvent".to_owned(),
            status: CodexRuntimeObservationEventStorePersistenceStatus::Persisted,
            repair_hint: None,
            evidence_refs: vec![format!("evidence:{identity_id}")],
            event_store_record: None,
            replay_runs_provider_work: false,
            raw_provider_material_retained: false,
            provider_io_executed: false,
            task_mutation_permitted: false,
        }
    }
}
