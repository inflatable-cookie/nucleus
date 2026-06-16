//! Read-only event replay query service skeleton.
//!
//! This service queries stored event metadata through the server state facade.
//! It does not implement live subscriptions, event fanout, transcript storage,
//! artifact payload resolution, secret resolution, scheduling, or runtime
//! execution.

use std::time::SystemTime;

use nucleus_core::PersistenceRecordId;
use nucleus_local_store::{LocalStoreBackend, LocalStoreError, LocalStoreRecord};

use crate::state::ServerStateService;

/// Read-only replay query.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerEventReplayQuery {
    pub scope: ServerEventReplayQueryScope,
    pub limit: Option<usize>,
    pub include_runtime_effect_metadata: bool,
}

/// Replay query scope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerEventReplayQueryScope {
    AllEvents,
    EventsAfter(PersistenceRecordId),
    TimeWindow(ServerEventReplayWindow),
}

/// Future time-window replay shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerEventReplayWindow {
    pub started_at: Option<SystemTime>,
    pub ended_at: Option<SystemTime>,
}

/// Replay query response.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerEventReplayResponse {
    pub status: ServerEventReplayStatus,
    pub event_records: Vec<LocalStoreRecord>,
    pub runtime_effect_metadata_records: Vec<LocalStoreRecord>,
    pub next_cursor: Option<PersistenceRecordId>,
}

/// Replay response status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerEventReplayStatus {
    Complete,
    Partial { reason: String },
    Unsupported { reason: String },
}

/// Replay query error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerEventReplayError {
    Store(LocalStoreError),
}

impl From<LocalStoreError> for ServerEventReplayError {
    fn from(error: LocalStoreError) -> Self {
        Self::Store(error)
    }
}

/// Read-only server event replay service.
#[derive(Clone, Debug)]
pub struct ServerEventReplayService<B> {
    state: ServerStateService<B>,
}

impl<B> ServerEventReplayService<B>
where
    B: LocalStoreBackend,
{
    /// Create a replay service from server-owned state access.
    pub fn new(state: ServerStateService<B>) -> Self {
        Self { state }
    }

    /// Query stored event metadata without resolving payload refs.
    pub fn query(
        &self,
        query: ServerEventReplayQuery,
    ) -> Result<ServerEventReplayResponse, ServerEventReplayError> {
        if matches!(query.scope, ServerEventReplayQueryScope::TimeWindow(_)) {
            return Ok(ServerEventReplayResponse {
                status: ServerEventReplayStatus::Unsupported {
                    reason: "time-window replay needs indexed event timestamps".to_owned(),
                },
                event_records: Vec::new(),
                runtime_effect_metadata_records: Vec::new(),
                next_cursor: None,
            });
        }

        let mut event_records = self.state.event_journal().list()?;
        if let ServerEventReplayQueryScope::EventsAfter(cursor) = &query.scope {
            event_records.retain(|record| record.id.0 > cursor.0);
        }

        let mut status = ServerEventReplayStatus::Complete;
        let mut next_cursor = event_records.last().map(|record| record.id.clone());
        if let Some(limit) = query.limit {
            if event_records.len() > limit {
                event_records.truncate(limit);
                next_cursor = event_records.last().map(|record| record.id.clone());
                status = ServerEventReplayStatus::Partial {
                    reason: "query limit reached".to_owned(),
                };
            }
        }

        let runtime_effect_metadata_records = if query.include_runtime_effect_metadata {
            self.state.runtime_effects().list()?
        } else {
            Vec::new()
        };

        Ok(ServerEventReplayResponse {
            status,
            event_records,
            runtime_effect_metadata_records,
            next_cursor,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
    use nucleus_local_store::{fixture_record, RevisionExpectation, SqliteBackend};

    fn store_records(path: &std::path::Path) {
        let state = ServerStateService::new(SqliteBackend::new(path));
        state
            .event_journal()
            .put(
                fixture_record(
                    PersistenceDomain::EventJournal,
                    PersistenceRecordKind::Event,
                    "event:1",
                    "rev:1",
                ),
                RevisionExpectation::MustNotExist,
            )
            .expect("event 1");
        state
            .event_journal()
            .put(
                fixture_record(
                    PersistenceDomain::EventJournal,
                    PersistenceRecordKind::Event,
                    "event:2",
                    "rev:1",
                ),
                RevisionExpectation::MustNotExist,
            )
            .expect("event 2");
        state
            .runtime_effects()
            .put(
                fixture_record(
                    PersistenceDomain::RuntimeEffects,
                    PersistenceRecordKind::RuntimeEffect,
                    "effect:1",
                    "rev:1",
                ),
                RevisionExpectation::MustNotExist,
            )
            .expect("runtime effect");
    }

    #[test]
    fn replay_query_survives_store_restart() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db_path = temp_dir.path().join("nucleus.sqlite");
        store_records(&db_path);

        let reopened =
            ServerEventReplayService::new(ServerStateService::new(SqliteBackend::new(db_path)));
        let response = reopened
            .query(ServerEventReplayQuery {
                scope: ServerEventReplayQueryScope::AllEvents,
                limit: None,
                include_runtime_effect_metadata: true,
            })
            .expect("replay query");

        assert_eq!(response.status, ServerEventReplayStatus::Complete);
        assert_eq!(response.event_records.len(), 2);
        assert_eq!(response.runtime_effect_metadata_records.len(), 1);
    }

    #[test]
    fn replay_query_supports_cursor_and_limit_without_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db_path = temp_dir.path().join("nucleus.sqlite");
        store_records(&db_path);

        let replay =
            ServerEventReplayService::new(ServerStateService::new(SqliteBackend::new(db_path)));
        let response = replay
            .query(ServerEventReplayQuery {
                scope: ServerEventReplayQueryScope::EventsAfter(PersistenceRecordId(
                    "event:0".to_owned(),
                )),
                limit: Some(1),
                include_runtime_effect_metadata: false,
            })
            .expect("cursor replay");

        assert!(matches!(
            response.status,
            ServerEventReplayStatus::Partial { .. }
        ));
        assert_eq!(response.event_records.len(), 1);
        assert_eq!(
            response.next_cursor,
            Some(PersistenceRecordId("event:1".to_owned()))
        );
    }

    #[test]
    fn time_window_replay_is_named_but_unsupported_until_timestamps_are_indexed() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db_path = temp_dir.path().join("nucleus.sqlite");
        let replay =
            ServerEventReplayService::new(ServerStateService::new(SqliteBackend::new(db_path)));

        let response = replay
            .query(ServerEventReplayQuery {
                scope: ServerEventReplayQueryScope::TimeWindow(ServerEventReplayWindow {
                    started_at: None,
                    ended_at: None,
                }),
                limit: None,
                include_runtime_effect_metadata: false,
            })
            .expect("unsupported replay query");

        assert!(matches!(
            response.status,
            ServerEventReplayStatus::Unsupported { .. }
        ));
        assert!(response.event_records.is_empty());
    }
}
