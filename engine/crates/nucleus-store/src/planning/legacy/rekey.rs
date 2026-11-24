use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::Value;

use super::{
    ImportError, Item, ItemRecord, WriteAt, date_ms, decode, insert_imported_item, record_history,
    registry::{ProjectImportReport, Registry, old_key},
    walk_items,
};

pub(super) fn copy_items(
    source: &Connection,
    tx: &Transaction<'_>,
    registry: &mut Registry,
    report: &mut ProjectImportReport,
) -> Result<(), ImportError> {
    tx.pragma_update(None, "defer_foreign_keys", true)?;
    walk_items(source, |id, legacy, raw, revisions| {
        legacy.validate(id)?;
        let mut memberships = BTreeMap::<String, BTreeSet<String>>::new();
        for repo in &legacy.repositories {
            let project = registry.project_for(&repo.origin)?;
            memberships
                .entry(project)
                .or_default()
                .insert(repo.origin.to_ascii_lowercase());
        }
        for (project, origins) in memberships {
            let mut seen = BTreeSet::new();
            let links = legacy
                .targets
                .iter()
                .filter(|target| {
                    target.kind == "task"
                        && !target.reference.trim().is_empty()
                        && target.repository.as_ref().is_none_or(|repo| {
                            registry.origins.get(&repo.to_ascii_lowercase()) == Some(&project)
                        })
                        && seen.insert(&target.reference)
                })
                .map(|target| target.reference.clone())
                .collect();
            let mut item = legacy.item(links);
            let previous: BTreeSet<_> = origins
                .iter()
                .map(|origin| old_key(origin))
                .chain([project.clone()])
                .collect();
            item.repositories = origins.into_iter().collect();
            if migrate_item(tx, &project, &mut item, raw, &previous, report)? {
                continue;
            }
            insert_imported_item(
                tx,
                &project,
                legacy,
                &item,
                raw,
                revisions,
                &mut report.items,
            )?;
        }
        Ok(())
    })
}

fn migrate_item(
    tx: &Transaction<'_>,
    project: &str,
    item: &mut Item,
    raw: &Value,
    previous: &BTreeSet<String>,
    report: &mut ProjectImportReport,
) -> Result<bool, ImportError> {
    let id = item.id.as_str();
    let conflict =
        |detail: &str| ImportError::ProjectConflict(format!("item {id} in {project}: {detail}"));
    let mut copies = Vec::new();
    let mut title = None;
    let mut body = None;
    let mut lanes = None;
    let mut state = None;
    let mut task_sources = 0;
    for scope in previous {
        let Some((current, baseline)) = read_imported(tx, scope, id, raw)? else {
            continue;
        };
        for link in current.task_links {
            if !item.task_links.contains(&link) {
                item.task_links.push(link);
            }
        }
        merge_edit(&mut title, current.content.title, &baseline.content.title)
            .map_err(|()| conflict("different title edits"))?;
        merge_edit(&mut body, current.content.body, &baseline.content.body)
            .map_err(|()| conflict("different body edits"))?;
        merge_edit(&mut lanes, current.content.lanes, &baseline.content.lanes)
            .map_err(|()| conflict("different lane edits"))?;
        merge_edit(&mut state, current.state, &baseline.state)
            .map_err(|()| conflict("different disposition edits or promotions"))?;
        task_sources += tx.query_row(
            "SELECT count(*) FROM planning_task_sources WHERE project = ?1 AND item_id = ?2",
            params![scope, id],
            |row| row.get::<_, u32>(0),
        )?;
        copies.push(scope.as_str());
    }
    if copies.is_empty() {
        return Ok(false);
    }
    if task_sources > 1 {
        return Err(conflict(
            "multiple Rust tasks already name this item as their source",
        ));
    }
    if let Some(title) = title {
        item.content.title = title;
    }
    if let Some(body) = body {
        item.content.body = body;
    }
    if let Some(lanes) = lanes {
        item.content.lanes = lanes;
    }
    if let Some(state) = state {
        item.state = state;
    }
    let snapshot = serde_json::to_string(item)?;
    if copies.contains(&project) {
        tx.execute(
            "UPDATE planning_items SET snapshot = ?3 WHERE project = ?1 AND id = ?2",
            params![project, id, snapshot],
        )?;
    } else {
        tx.execute(
            "INSERT INTO planning_items (project, id, snapshot) VALUES (?1, ?2, ?3)",
            params![project, id, snapshot],
        )?;
        report.rekeyed_items += 1;
    }
    report.coalesced_items += copies.len() - 1;
    for scope in copies.into_iter().filter(|scope| *scope != project) {
        tx.execute(
            "UPDATE planning_task_sources SET project = ?1 WHERE project = ?2 AND item_id = ?3",
            params![project, scope, id],
        )?;
        tx.execute(
            "UPDATE planning_history SET project = ?1 WHERE project = ?2 AND id = ?3 AND kind = 'item'",
            params![project, scope, id],
        )?;
        tx.execute(
            "DELETE FROM planning_items WHERE project = ?1 AND id = ?2",
            params![scope, id],
        )?;
    }
    let date = raw["updatedAt"]
        .as_str()
        .or_else(|| raw["createdAt"].as_str())
        .or_else(|| raw["closedAt"].as_str())
        .or_else(|| raw["filedAt"].as_str());
    let stamp = WriteAt {
        actor: "legacy-project-import",
        at_ms: date.map(date_ms).transpose()?.unwrap_or_default(),
    };
    record_history(
        tx,
        ItemRecord,
        project,
        id,
        "project_import",
        &snapshot,
        stamp,
    )?;
    Ok(true)
}

fn read_imported(
    tx: &Transaction<'_>,
    scope: &str,
    id: &str,
    raw: &Value,
) -> Result<Option<(Item, Item)>, ImportError> {
    let conflict =
        |detail: &str| ImportError::ProjectConflict(format!("item {id} in {scope}: {detail}"));
    let Some(current) = tx
        .query_row(
            "SELECT snapshot FROM planning_items WHERE project = ?1 AND id = ?2",
            params![scope, id],
            |row| decode::<Item>(row, 0),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let saved = |action: &str| {
        tx.query_row(
            "SELECT snapshot FROM planning_history
                 WHERE project = ?1 AND id = ?2 AND kind = 'item' AND action = ?3
                 ORDER BY sequence LIMIT 1",
            params![scope, id, action],
            |row| decode::<Value>(row, 0),
        )
        .optional()
    };
    if saved("legacy_snapshot")?.as_ref() != Some(raw) {
        return Err(conflict("different import source or unrelated item"));
    }
    let baseline = saved("import")?.ok_or_else(|| conflict("missing import baseline"))?;
    let baseline: Item = serde_json::from_value(baseline)?;
    if current.kind != baseline.kind || current.author != baseline.author || current.id != id {
        return Err(conflict("item identity changed"));
    }
    Ok(Some((current, baseline)))
}

fn merge_edit<T: Eq>(saved: &mut Option<T>, current: T, baseline: &T) -> Result<(), ()> {
    if &current == baseline {
        return Ok(());
    }
    if saved.as_ref().is_some_and(|prior| prior != &current) {
        return Err(());
    }
    *saved = Some(current);
    Ok(())
}

// Native records under an old generated project key follow the same container.
// A user-owned record at the destination is a conflict, even if its body matches.
pub(super) fn remaining(
    tx: &Transaction<'_>,
    aliases: &BTreeMap<String, String>,
) -> Result<(), ImportError> {
    for (from, to) in aliases {
        for (table, kind) in [
            ("planning_plans", "plan"),
            ("planning_lanes", "lane"),
            ("planning_items", "item"),
            ("planning_decisions", "decision"),
        ] {
            let collision: Option<String> = tx.query_row(
                &format!("SELECT src.id FROM {table} src JOIN {table} dest
                          ON dest.project = ?2 AND dest.id = CASE WHEN ?3 = 'plan' THEN ?2 ELSE src.id END
                          WHERE src.project = ?1 LIMIT 1"),
                params![from, to, kind], |row| row.get(0),
            ).optional()?;
            if let Some(id) = collision {
                return Err(ImportError::ProjectConflict(format!(
                    "{kind} {id} exists in both {from} and {to}"
                )));
            }
            tx.execute(
                &format!("UPDATE {table} SET project = ?2,
                    id = CASE WHEN ?3 = 'plan' THEN ?2 ELSE id END,
                    snapshot = CASE WHEN ?3 = 'decision' THEN json_set(snapshot, '$.projectId', ?2) ELSE snapshot END
                    WHERE project = ?1"),
                params![from, to, kind],
            )?;
        }
        tx.execute(
            "UPDATE planning_history SET project = ?2, id = CASE WHEN kind = 'plan' THEN ?2 ELSE id END
             WHERE project = ?1",
            params![from, to],
        )?;
        tx.execute(
            "UPDATE planning_task_sources SET project = ?2 WHERE project = ?1",
            params![from, to],
        )?;
    }
    Ok(())
}
