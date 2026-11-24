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

pub(super) const PROVIDER_PAUSES: &str = "
CREATE TABLE IF NOT EXISTS provider_pauses (
  group_id TEXT PRIMARY KEY,
  until_ms INTEGER NOT NULL CHECK (until_ms > 0)
) STRICT";

pub(super) fn record_pause(
    connection: &Connection,
    group: &str,
    until_ms: u64,
    now_ms: u64,
) -> rusqlite::Result<()> {
    if until_ms > now_ms {
        connection.execute(
            "INSERT INTO provider_pauses (group_id, until_ms) VALUES (?1, ?2)
             ON CONFLICT (group_id) DO UPDATE SET until_ms = excluded.until_ms
             WHERE excluded.until_ms > provider_pauses.until_ms",
            params![group, sql_millis(until_ms)?],
        )?;
    }
    Ok(())
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
