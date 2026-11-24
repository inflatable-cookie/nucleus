use std::{borrow::Cow, collections::BTreeMap};

use nucleus_core::Identity;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

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

/// The next available numbers read from a fenced legacy snapshot.
#[derive(Debug)]
pub struct TaskNumberSeed {
    pub(crate) floors: BTreeMap<String, i64>,
    pub(crate) all_repositories: bool,
}

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

    /// Seed the allocator from a fenced legacy copy and number preexisting tasks.
    /// Replays preserve every number already assigned. This transaction writes
    /// only allocator tables. The execution state and callback digest live in
    /// the task row.
    ///
    /// # Errors
    /// Returns an error if the legacy range overlaps a Rust number or the transaction fails.
    pub fn seed_task_numbers(&mut self, seed: &TaskNumberSeed) -> Result<(), StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut floors = seed.floors.clone();
        if seed.all_repositories {
            let mut query = tx.prepare("SELECT DISTINCT lower(repository) FROM tasks")?;
            let rows = query.query_map([], |row| row.get::<_, String>(0))?;
            for repository in rows {
                floors.entry(repository?).or_insert(1);
            }
        }
        for (repository, floor) in floors {
            backfill(&tx, &repository, floor)?;
        }
        tx.commit()?;
        Ok(())
    }
}

fn backfill(tx: &Transaction<'_>, repository: &str, floor: i64) -> Result<(), StoreError> {
    let (next, legacy_next) = counter(tx, repository)?.unwrap_or((1, 1));
    if floor > legacy_next
        && tx.query_row(
            "SELECT EXISTS (
               SELECT 1 FROM task_numbers
               WHERE repository = ?1 AND number >= ?2 AND number < ?3
             )",
            params![repository, legacy_next, floor],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Err(StoreError::NumberOverlap);
    }
    let mut next = next.max(floor);
    write_counter(tx, repository, next, legacy_next.max(floor))?;
    let unnumbered = {
        let mut query = tx.prepare(
            "SELECT tasks.id FROM tasks WHERE lower(tasks.repository) = ?1
             AND NOT EXISTS (SELECT 1 FROM task_numbers WHERE task_id = tasks.id)
             ORDER BY (SELECT min(sequence) FROM events WHERE task_id = tasks.id), tasks.id",
        )?;
        let rows = query.query_map([repository], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for task in unnumbered {
        assign(tx, &task, repository, next)?;
        next = successor(next)?;
    }
    write_counter(tx, repository, next, legacy_next.max(floor))?;
    Ok(())
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
