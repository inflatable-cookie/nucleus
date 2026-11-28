use nucleus_core::{PreparedLaunch, Role, profiles::RotationCounts};
use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension, Row, params};

const WINDOW: u32 = 50;

pub(super) const SCHEMA: &str = "
CREATE TABLE profile_assignments (
  sequence INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('worker', 'reviewer')),
  profile_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  instance TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX profile_assignment_role ON profile_assignments (role, sequence);
CREATE TABLE profile_assignment_totals (
  role TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (role, profile_id, group_id)
) STRICT;
CREATE INDEX profile_assignment_group ON profile_assignment_totals (group_id);";

pub(super) const PAUSES: &str = "CREATE TABLE IF NOT EXISTS provider_pauses (
  group_id TEXT PRIMARY KEY, until_ms INTEGER NOT NULL CHECK (until_ms > 0),
  fallback_until_ms INTEGER
) STRICT";

/// A subscription deadline and whether it estimates an unknown provider reset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SubscriptionPause {
    pub until_ms: u64,
    pub fallback: bool,
}

impl super::Store {
    /// Record the stronger evidence or a later deadline of the same kind.
    ///
    /// # Errors
    /// Returns a database error if the deadline could not be recorded.
    pub fn set_subscription_pause(
        &self,
        group: &str,
        pause: SubscriptionPause,
        now: u64,
    ) -> Result<bool, super::StoreError> {
        if pause.until_ms <= now {
            return Ok(false);
        }
        let until = sql_millis(pause.until_ms)?;
        Ok(self.connection.execute(
            "INSERT INTO provider_pauses (group_id,until_ms,fallback_until_ms) VALUES (?1,?2,?3)
             ON CONFLICT(group_id) DO UPDATE SET until_ms=excluded.until_ms, fallback_until_ms=excluded.fallback_until_ms
             WHERE until_ms <= ?4 OR CASE WHEN fallback_until_ms IS until_ms
                 THEN excluded.fallback_until_ms IS NULL OR excluded.until_ms > until_ms
                 ELSE excluded.fallback_until_ms IS NULL AND excluded.until_ms > until_ms END",
            params![group,until,pause.fallback.then_some(until),sql_millis(now)?],
        )? > 0)
    }

    /// Read the effective pause, including the provenance of its exact deadline.
    ///
    /// # Errors
    /// Returns a database error if the deadline cannot be read.
    pub fn subscription_pause(
        &self,
        group: &str,
        now: u64,
    ) -> Result<Option<SubscriptionPause>, super::StoreError> {
        Ok(self.connection.query_row(
            "SELECT until_ms, fallback_until_ms IS until_ms FROM provider_pauses WHERE group_id=?1 AND until_ms>?2",
            params![group,sql_millis(now)?], |row| Ok(SubscriptionPause { until_ms:read_millis(row,0)?,fallback:row.get(1)? })
        ).optional()?)
    }

    /// Groups currently waiting for an estimated reset.
    ///
    /// # Errors
    /// Returns a database error if the groups cannot be read.
    pub fn fallback_pause_groups(&self, now: u64) -> Result<Vec<String>, super::StoreError> {
        Ok(self.connection.prepare("SELECT group_id FROM provider_pauses WHERE fallback_until_ms=until_ms AND until_ms>?1 ORDER BY group_id")?
            .query_map([sql_millis(now)?], |row| row.get(0))?.collect::<Result<_,_>>()?)
    }

    /// Release only the estimated deadline that the operator saw.
    ///
    /// # Errors
    /// Returns a database error if the deadline cannot be cleared.
    pub fn clear_fallback_pause(
        &self,
        group: &str,
        expected: u64,
    ) -> Result<bool, super::StoreError> {
        Ok(self.connection.execute(
            "DELETE FROM provider_pauses WHERE group_id=?1 AND until_ms=?2 AND fallback_until_ms=?2",
            params![group,sql_millis(expected)?],
        )? > 0)
    }
}

pub(super) fn active_pauses(
    connection: &Connection,
    now_ms: u64,
) -> rusqlite::Result<BTreeMap<String, u64>> {
    connection
        .prepare("SELECT group_id, until_ms FROM provider_pauses WHERE until_ms > ?1")?
        .query_map([sql_millis(now_ms)?], |row| {
            Ok((row.get(0)?, read_millis(row, 1)?))
        })?
        .collect()
}

pub(super) fn active_pause(
    connection: &Connection,
    group: &str,
    now_ms: u64,
) -> rusqlite::Result<Option<u64>> {
    connection
        .query_row(
            "SELECT until_ms FROM provider_pauses WHERE group_id = ?1 AND until_ms > ?2",
            params![group, sql_millis(now_ms)?],
            |row| read_millis(row, 0),
        )
        .optional()
}

pub(super) fn sql_millis(millis: u64) -> rusqlite::Result<i64> {
    i64::try_from(millis).map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

pub(super) fn read_millis(row: &Row<'_>, column: usize) -> rusqlite::Result<u64> {
    let millis = row.get::<_, i64>(column)?;
    u64::try_from(millis).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(column, millis))
}

const fn role_name(role: Role) -> &'static str {
    match role {
        Role::Worker => "worker",
        Role::Reviewer => "reviewer",
    }
}

pub(super) fn record(
    connection: &Connection,
    launch: &PreparedLaunch,
    profile: &str,
    group: &str,
    at: i64,
) -> rusqlite::Result<()> {
    let role = role_name(launch.role);
    connection.execute(
        "INSERT INTO profile_assignments (role, profile_id, group_id, instance, at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![role, profile, group, launch.instance, at],
    )?;
    connection.execute(
        "INSERT INTO profile_assignment_totals (role, profile_id, group_id, count)
         VALUES (?1, ?2, ?3, 1)
         ON CONFLICT (role, profile_id, group_id) DO UPDATE SET count = count + 1",
        params![role, profile, group],
    )?;
    connection.execute(
        "DELETE FROM profile_assignments WHERE role = ?1 AND sequence <= (
           SELECT sequence FROM profile_assignments WHERE role = ?1
           ORDER BY sequence DESC LIMIT 1 OFFSET ?2
         )",
        params![role, WINDOW],
    )?;
    Ok(())
}

pub(super) fn counts(
    connection: &Connection,
    role: Role,
    profile: &str,
    group: &str,
) -> rusqlite::Result<RotationCounts> {
    connection.query_row(
        "SELECT
           (SELECT count(*) FROM (
              SELECT profile_id FROM profile_assignments WHERE role = ?1
              ORDER BY sequence DESC LIMIT ?4
            ) WHERE profile_id = ?2),
           (SELECT count(*) FROM (
              SELECT group_id FROM profile_assignments ORDER BY sequence DESC LIMIT ?4
            ) WHERE group_id = ?3),
           (SELECT COALESCE(sum(count), 0) FROM profile_assignment_totals
            WHERE role = ?1 AND profile_id = ?2),
           (SELECT COALESCE(sum(count), 0) FROM profile_assignment_totals WHERE group_id = ?3)",
        params![role_name(role), profile, group, WINDOW],
        |row| {
            let count = |column| {
                let value = row.get::<_, i64>(column)?;
                u64::try_from(value)
                    .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(column, value))
            };
            Ok(RotationCounts {
                profile_recent: count(0)?,
                group_recent: count(1)?,
                profile_lifetime: count(2)?,
                group_lifetime: count(3)?,
            })
        },
    )
}

/// Recent and total profile assignments, as the board's usage strips read them.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUsage {
    /// The last assignments across roles, by profile, and how many that is.
    pub recent: UsageWindow,
    pub worker: UsageWindow,
    pub reviewer: UsageWindow,
    /// Every recorded assignment, by profile.
    pub totals: BTreeMap<String, u64>,
    /// Every recorded assignment, by subscription group.
    pub group_totals: BTreeMap<String, u64>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct UsageWindow {
    pub counts: BTreeMap<String, u64>,
    /// The same window by subscription group.
    pub groups: BTreeMap<String, u64>,
    pub sample: u64,
}

fn window(connection: &Connection, role: Option<&str>) -> rusqlite::Result<UsageWindow> {
    let statement = if role.is_some() {
        "SELECT profile_id, group_id FROM profile_assignments
         WHERE role = ?2 ORDER BY sequence DESC LIMIT ?1"
    } else {
        "SELECT profile_id, group_id FROM profile_assignments ORDER BY sequence DESC LIMIT ?1"
    };
    let mut query = connection.prepare_cached(statement)?;
    let arguments: &[&dyn rusqlite::ToSql] = if role.is_some() {
        &[&WINDOW, &role]
    } else {
        &[&WINDOW]
    };
    let mut usage = UsageWindow::default();
    for row in query.query_map(arguments, |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (profile, group) = row?;
        *usage.counts.entry(profile).or_default() += 1;
        *usage.groups.entry(group).or_default() += 1;
        usage.sample += 1;
    }
    Ok(usage)
}

/// Read the usage strips' windows and totals from the Spec 053 tables.
pub(super) fn profile_usage(connection: &Connection) -> rusqlite::Result<ProfileUsage> {
    Ok(ProfileUsage {
        recent: window(connection, None)?,
        worker: window(connection, Some("worker"))?,
        reviewer: window(connection, Some("reviewer"))?,
        totals: totals(connection, "profile_id")?,
        group_totals: totals(connection, "group_id")?,
    })
}

fn totals(connection: &Connection, column: &str) -> rusqlite::Result<BTreeMap<String, u64>> {
    let mut query = connection.prepare_cached(&format!(
        "SELECT {column}, sum(count) FROM profile_assignment_totals GROUP BY {column}"
    ))?;
    query
        .query_map([], |row| {
            let count = row.get::<_, i64>(1)?;
            Ok((
                row.get::<_, String>(0)?,
                u64::try_from(count)
                    .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(1, count))?,
            ))
        })?
        .collect()
}
