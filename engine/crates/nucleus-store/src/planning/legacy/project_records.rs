use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, Transaction};
use serde::Deserialize;
use serde_json::Value;

use super::{
    ImportError, Repository, WriteAt, date_ms, decode,
    registry::{ProjectImportReport, Registry},
    valid_key, versions,
};
use crate::planning::{
    Horizon, Lane, LaneDisposition, LaneDocument, Plan, PlanLane, RecordKind, insert, read,
    record_history,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPlan {
    project: String,
    version: u64,
    entries: Vec<LegacyPlanEntry>,
    author: String,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPlanEntry {
    lane: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    horizon: Option<Horizon>,
    #[serde(default)]
    done_when: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyLane {
    key: String,
    title: String,
    aim: String,
    status: LegacyLaneStatus,
    #[serde(default)]
    note: String,
    repositories: Vec<Repository>,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum LegacyLaneStatus {
    Active,
    Paused,
    Done,
    Abandoned,
}

pub(super) fn copy(
    source: &Connection,
    tx: &Transaction<'_>,
    registry: &mut Registry,
    report: &mut ProjectImportReport,
) -> Result<(), ImportError> {
    let mut members = copy_plans(source, tx, registry, report)?;
    let mut documents = versions::Reader::lane_documents(source)?;
    let mut query = source.prepare("SELECT key, data FROM lanes ORDER BY key")?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let key: String = row.get(0)?;
        let raw: Value = decode(row, 1)?;
        let lane: LegacyLane = serde_json::from_value(raw.clone())?;
        if lane.key != key || !valid_key(&key) || lane.repositories.is_empty() {
            return Err(ImportError::ProjectConflict(format!(
                "invalid legacy lane {key}"
            )));
        }
        let mut projects = members.remove(&key).unwrap_or_default();
        for repository in &lane.repositories {
            projects.insert(registry.project_for(&repository.origin)?);
        }
        let revisions = documents.read(&key)?;
        let (version, text) = match revisions.last_key_value() {
            Some((version, raw)) => (
                u64::from(*version),
                raw["text"].as_str().unwrap_or_default(),
            ),
            None => (0, ""),
        };
        let lane_record = Lane {
            key: key.clone(),
            version,
            document: LaneDocument {
                title: lane.title,
                aim: lane.aim,
                document: text.into(),
            },
            disposition: match lane.status {
                LegacyLaneStatus::Active | LegacyLaneStatus::Paused => LaneDisposition::Open,
                LegacyLaneStatus::Done => LaneDisposition::Done { note: lane.note },
                LegacyLaneStatus::Abandoned => LaneDisposition::Dropped { note: lane.note },
            },
        };
        for project in projects {
            collision::<Lane>(tx, RecordKind::Lane, &project, &key)?;
            for revision in revisions.values() {
                if revision["key"].as_str() != Some(&key) {
                    return Err(ImportError::ProjectConflict(format!(
                        "lane document does not belong to {key}"
                    )));
                }
                record_history(
                    tx,
                    RecordKind::Lane,
                    &project,
                    &key,
                    "legacy_version",
                    &revision.to_string(),
                    stamp(revision, &lane.updated_at)?,
                )?;
            }
            let current = stamp(&raw, &lane.updated_at)?;
            record_history(
                tx,
                RecordKind::Lane,
                &project,
                &key,
                "legacy_snapshot",
                &raw.to_string(),
                current,
            )?;
            insert(
                tx,
                RecordKind::Lane,
                &project,
                &key,
                "import",
                &lane_record,
                current,
            )?;
            report.lanes += 1;
            report.lane_versions += revisions.len();
        }
    }
    if let Some((lane, _)) = members.first_key_value() {
        return Err(ImportError::ProjectConflict(format!(
            "a legacy plan names missing lane {lane}"
        )));
    }
    Ok(())
}

fn copy_plans(
    source: &Connection,
    tx: &Transaction<'_>,
    registry: &mut Registry,
    report: &mut ProjectImportReport,
) -> Result<BTreeMap<String, BTreeSet<String>>, ImportError> {
    let mut members = BTreeMap::<String, BTreeSet<String>>::new();
    let mut query = source
        .prepare("SELECT project, version, data FROM project_plans ORDER BY project, version")?;
    let mut rows = query.query([])?;
    let mut current: Option<LegacyPlan> = None;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let version = u64::from(row.get::<_, u32>(1)?);
        let raw: Value = decode(row, 2)?;
        let plan: LegacyPlan = serde_json::from_value(raw.clone())?;
        if plan.project != id || plan.version != version || !valid_key(&id) {
            return Err(ImportError::ProjectConflict(format!(
                "invalid legacy plan {id} version {version}"
            )));
        }
        if current
            .as_ref()
            .is_some_and(|previous| previous.project != id)
            && let Some(previous) = current.take()
        {
            save_plan(tx, previous, report)?;
        }
        if current.is_none() {
            collision::<Plan>(tx, RecordKind::Plan, &id, &id)?;
            registry.historical(&id, &id);
        }
        let mut keys = BTreeSet::new();
        for entry in &plan.entries {
            if !valid_key(&entry.lane) || !keys.insert(&entry.lane) {
                return Err(ImportError::ProjectConflict(format!(
                    "invalid lane {} in plan {id}",
                    entry.lane
                )));
            }
            members
                .entry(entry.lane.clone())
                .or_default()
                .insert(id.clone());
        }
        record_history(
            tx,
            RecordKind::Plan,
            &id,
            &id,
            "legacy_version",
            &raw.to_string(),
            WriteAt {
                actor: &plan.author,
                at_ms: date_ms(&plan.created_at)?,
            },
        )?;
        report.plan_versions += 1;
        current = Some(plan);
    }
    if let Some(plan) = current {
        save_plan(tx, plan, report)?;
    }
    Ok(members)
}

fn save_plan(
    tx: &Transaction<'_>,
    legacy: LegacyPlan,
    report: &mut ProjectImportReport,
) -> Result<(), ImportError> {
    let plan = Plan {
        version: legacy.version,
        lanes: legacy
            .entries
            .into_iter()
            .map(|entry| PlanLane {
                key: entry.lane,
                horizon: entry.horizon.unwrap_or(Horizon::Now),
                done_when: entry.done_when,
                status_note: entry.note,
            })
            .collect(),
    };
    insert(
        tx,
        RecordKind::Plan,
        &legacy.project,
        &legacy.project,
        "import",
        &plan,
        WriteAt {
            actor: &legacy.author,
            at_ms: date_ms(&legacy.created_at)?,
        },
    )?;
    report.plans += 1;
    Ok(())
}

fn collision<T: serde::de::DeserializeOwned>(
    tx: &Transaction<'_>,
    kind: RecordKind,
    project: &str,
    id: &str,
) -> Result<(), ImportError> {
    if read::<T>(tx, kind, project, id)?.is_some() {
        return Err(ImportError::ProjectConflict(format!(
            "{} {id} already exists in {project}",
            kind.as_str()
        )));
    }
    Ok(())
}

fn stamp<'a>(raw: &'a Value, date: &str) -> Result<WriteAt<'a>, ImportError> {
    Ok(WriteAt {
        actor: raw["author"].as_str().unwrap_or("legacy-project-import"),
        at_ms: date_ms(raw["createdAt"].as_str().unwrap_or(date))?,
    })
}
