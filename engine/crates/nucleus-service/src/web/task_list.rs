use std::{
    collections::{HashMap, hash_map::Entry},
    sync::Arc,
};

use axum::{Extension, Json, extract::State};
use nucleus_core::{Authority, Phase};
use nucleus_store::{Dependencies, TaskRow};
use serde::Serialize;

use super::{Api, ApiError, Card, CardInputs, ControllerScope, EngineState, Summary};
use crate::{DependencyEdits, DependencyStatus, ServiceError};

#[derive(Serialize)]
pub(super) struct ListedTask {
    #[serde(flatten)]
    summary: Summary<Arc<Card>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    lanes: Vec<String>,
}

type Revision = (i64, Option<i64>);

pub(super) struct ListCard {
    version: i64,
    number: Option<i64>,
    papercut_title: Option<String>,
    revision: Revision,
    brief_lanes: Vec<String>,
    dependencies: Dependencies,
    rendered: Option<(CardInputs, Arc<Card>)>,
}

impl ListCard {
    fn read(row: &TaskRow, state: &EngineState, revision: Revision) -> Result<Self, ServiceError> {
        let task = &row.task;
        Ok(Self {
            version: row.version,
            number: row.number,
            papercut_title: task.papercut_title.clone(),
            revision,
            brief_lanes: nucleus_core::profiles::BriefPolicy::parse(&task.brief().text)
                .map(|policy| policy.lanes().to_vec())
                .unwrap_or_default(),
            dependencies: state.store.dependencies(&task.identity().id)?,
            rendered: None,
        })
    }

    fn matches(&self, row: &TaskRow, revision: Revision) -> bool {
        self.version == row.version
            && self.number == row.number
            && self.papercut_title == row.task.papercut_title
            && self.revision == revision
    }

    fn blocked(&self, row: &TaskRow, state: &EngineState) -> Result<bool, ServiceError> {
        Ok(!matches!(
            row.task.phase(),
            Phase::Done | Phase::Cancelled | Phase::Closing
        ) && (!self.dependencies.before_dispatch.is_empty()
            || self
                .dependencies
                .wait
                .as_ref()
                .is_some_and(|wait| wait.released_at_ms.is_none()))
            && state.store.dependency_blocked(&row.task.identity().id)?)
    }

    fn card(
        &mut self,
        row: &TaskRow,
        state: &EngineState,
        blocking: bool,
    ) -> Result<Arc<Card>, ServiceError> {
        let inputs = CardInputs::read(row, state, blocking)?;
        if let Some((prior, card)) = &self.rendered
            && *prior == inputs
        {
            return Ok(Arc::clone(card));
        }
        let card = Arc::new(Card::read(row, state, &inputs, None)?);
        self.rendered = Some((inputs, Arc::clone(&card)));
        Ok(card)
    }
}

pub(super) async fn list(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    Extension(authority): Extension<Authority>,
) -> Result<Json<Vec<ListedTask>>, ApiError> {
    api.service
        .storage
        .database()
        .verify()
        .map_err(ServiceError::from)?;
    let state = api.service.state.lock_for_list().await;
    let listing = state.store.list().map_err(ServiceError::from)?;
    let revisions = state.store.card_revisions().map_err(ServiceError::from)?;
    let rows: HashMap<_, _> = listing
        .readable
        .iter()
        .map(|row| (row.task.identity().id.as_str(), row))
        .collect();
    let mut sources = HashMap::<String, Vec<(String, String)>>::new();
    for (id, project, lane) in state.store.source_lanes().map_err(ServiceError::from)? {
        sources.entry(id).or_default().push((project, lane));
    }
    let mut cache = api.list_cards.lock().await;
    cache.retain(|id, _| rows.contains_key(id.as_str()));
    let mut result = Vec::new();
    for row in &listing.readable {
        let task = &row.task;
        let identity = task.identity();
        if api.service.task_scope(identity).is_err() || scope.task(&state, identity).is_err() {
            continue;
        }
        let id = &identity.id;
        let revision = *revisions.get(id).ok_or(ServiceError::Missing)?;
        let entry = match cache.entry(id.clone()) {
            Entry::Occupied(entry) if entry.get().matches(row, revision) => entry.into_mut(),
            entry => entry
                .insert_entry(ListCard::read(row, &state, revision)?)
                .into_mut(),
        };

        // The prerequisite phases, scope and planner's edit rights can change
        // without a new dependent version or journal event.
        let blocking = entry.blocked(row, &state)?;
        let dependency_status = DependencyStatus::listed(
            &state,
            &scope,
            &entry.dependencies,
            blocking,
            &rows,
            &listing.unreadable,
        )?;
        let dependency_edits =
            DependencyEdits::read(&state, task, Some(&authority), &dependency_status);
        let card = entry.card(row, &state, blocking)?;
        result.push(ListedTask {
            lanes: task_lanes(&state, row, sources.remove(id), &entry.brief_lanes),
            summary: Summary {
                next_check_at: card.next_check_at(row, &state),
                card,
                dependency_status,
                dependency_edits,
            },
        });
    }
    for damaged in listing.unreadable {
        if api.service.task_scope(&damaged.identity).is_ok()
            && scope.task(&state, &damaged.identity).is_ok()
        {
            result.push(ListedTask {
                lanes: Vec::new(),
                summary: Summary {
                    card: Arc::new(Card::unreadable(damaged)),
                    next_check_at: None,
                    dependency_status: DependencyStatus::default(),
                    dependency_edits: DependencyEdits::unavailable(),
                },
            });
        }
    }
    Ok(Json(result))
}

fn task_lanes(
    state: &EngineState,
    row: &TaskRow,
    source_lanes: Option<Vec<(String, String)>>,
    brief_lanes: &[String],
) -> Vec<String> {
    let task = &row.task;
    let project = state
        .settings
        .project_for_origin(&task.identity().repository)
        .map(|(id, _, _)| id);
    let mut lanes = brief_lanes.to_vec();
    lanes.extend(
        source_lanes
            .into_iter()
            .flatten()
            .filter_map(|(owner, lane)| (Some(owner.as_str()) == project).then_some(lane)),
    );
    if let Some(report) = task.report_task()
        && Some(report.project.as_str()) == project
    {
        lanes.push(report.lane.clone());
    }
    lanes.sort_unstable();
    lanes.dedup();
    lanes
}
