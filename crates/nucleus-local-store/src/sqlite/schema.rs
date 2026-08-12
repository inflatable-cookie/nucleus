//! SQLite schema: first-slice table creation and the seq insertion-order
//! migration.
//!
//! Split from the sqlite god file; behavior unchanged.

use rusqlite::Connection;

use super::table::{sqlite_error, ALL_TABLES};
use crate::errors::LocalStoreResult;

pub(super) fn initialize_schema(connection: &Connection) -> LocalStoreResult<()> {
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS task_history (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS shared_memory (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS planning (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS deep_research (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, revision_id TEXT NOT NULL, media_type TEXT, payload BLOB NOT NULL, seq INTEGER);
            CREATE TABLE IF NOT EXISTS workspace_layouts (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS adapter_instances (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS agent_sessions (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS model_routes (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS event_journal (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS command_evidence (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS artifact_metadata (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS runtime_effects (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            ",
        )
        .map_err(sqlite_error)?;
    migrate_missing_seq_columns(connection)
}

/// Add the `seq` insertion-order column to tables created before it existed
/// and backfill from rowid so historical order is preserved once.
fn migrate_missing_seq_columns(connection: &Connection) -> LocalStoreResult<()> {
    for table in ALL_TABLES {
        let has_seq = {
            let mut statement = connection
                .prepare(&format!("PRAGMA table_info({table})"))
                .map_err(sqlite_error)?;
            let mut has_seq = false;
            let mut rows = statement.query([]).map_err(sqlite_error)?;
            while let Some(row) = rows.next().map_err(sqlite_error)? {
                let name: String = row.get(1).map_err(sqlite_error)?;
                if name == "seq" {
                    has_seq = true;
                }
            }
            has_seq
        };
        if !has_seq {
            connection
                .execute_batch(&format!("ALTER TABLE {table} ADD COLUMN seq INTEGER"))
                .map_err(sqlite_error)?;
        }
        connection
            .execute(
                &format!("UPDATE {table} SET seq = rowid WHERE seq IS NULL"),
                [],
            )
            .map_err(sqlite_error)?;
    }
    Ok(())
}
