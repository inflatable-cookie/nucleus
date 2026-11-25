use std::borrow::Cow;

use nucleus_core::Identity;
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::{Store, StoreError, TaskRow};

pub(super) const SCHEMA: &str = "
CREATE TABLE task_number_counters (
  repository TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL CHECK (next_number > 0),
  legacy_next INTEGER NOT NULL CHECK (legacy_next BETWEEN 1 AND next_number)
) STRICT;
CREATE TABLE task_numbers (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  repository TEXT NOT NULL REFERENCES task_number_counters(repository),
  number INTEGER NOT NULL CHECK (number > 0),
  UNIQUE (repository, number)
) STRICT";

impl TaskRow {
    /// The public task reference, with the legacy display value for unseeded rows.
    #[must_use]
    pub fn reference(&self) -> Cow<'_, str> {
        let identity = self.task.identity();
        self.number.map_or_else(
            || Cow::Borrowed(identity.reference.as_str()),
            |number| Cow::Owned(reference(&identity.repository, number)),
        )
    }
}

pub(super) fn reference(repository: &str, number: i64) -> String {
    let repository = repository
        .rsplit_once('/')
        .map_or(repository, |(_, name)| name);
    format!("{repository}#{number}")
}

impl Store {
    /// Find task IDs by their assigned number and repository slug or full origin.
    /// Omitting the repository searches all numbered repositories.
    ///
    /// # Errors
    /// Returns an error if the numbering table cannot be read.
    pub fn numbered_task_ids(
        &self,
        repository: Option<&str>,
        number: i64,
    ) -> Result<Vec<String>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT task_id FROM task_numbers
             WHERE number = ?1 AND repository IN (
                 SELECT repository FROM task_number_counters
                 WHERE ?2 IS NULL OR repository = lower(?2)
                 OR (instr(?2, '/') = 0 AND substr(repository, -length(?2) - 1) = '/' || lower(?2))
             )",
        )?;
        let rows = query.query_map(params![number, repository], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

pub(super) fn reserve(tx: &Transaction<'_>, identity: &Identity) -> Result<i64, StoreError> {
    let repository = identity.repository.to_ascii_lowercase();
    let (next, legacy_next) = if let Some(counter) = counter(tx, &repository)? {
        counter
    } else {
        let has_tasks = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM tasks WHERE lower(repository) = ?1)",
            [&repository],
            |row| row.get::<_, bool>(0),
        )?;
        if has_tasks {
            return Err(StoreError::NumbersNeedSeed);
        }
        (1, 1)
    };
    write_counter(tx, &repository, successor(next)?, legacy_next)?;
    Ok(next)
}

pub(super) fn assign(
    tx: &Transaction<'_>,
    task: &str,
    repository: &str,
    number: i64,
) -> Result<(), StoreError> {
    tx.execute(
        "INSERT INTO task_numbers (task_id, repository, number) VALUES (?1, lower(?2), ?3)",
        params![task, repository, number],
    )?;
    Ok(())
}

fn counter(connection: &Connection, repository: &str) -> Result<Option<(i64, i64)>, StoreError> {
    Ok(connection
        .query_row(
            "SELECT next_number, legacy_next FROM task_number_counters WHERE repository = ?1",
            [repository],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

fn write_counter(
    tx: &Transaction<'_>,
    repository: &str,
    next: i64,
    legacy_next: i64,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO task_number_counters (repository, next_number, legacy_next) VALUES (?1, ?2, ?3)
         ON CONFLICT (repository) DO UPDATE
         SET next_number = excluded.next_number, legacy_next = excluded.legacy_next",
        params![repository, next, legacy_next],
    )?;
    Ok(())
}

fn successor(number: i64) -> Result<i64, StoreError> {
    number.checked_add(1).ok_or(StoreError::NumberExhausted)
}
