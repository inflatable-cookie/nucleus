use nucleus_core::{PreparedLaunch, Role, profiles::RotationCounts};
use rusqlite::{Connection, params};

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
