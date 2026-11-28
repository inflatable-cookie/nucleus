use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, FromRequestParts, Path, Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, request::Parts},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use nucleus_core::{
    Authority, ReportArtifact,
    profiles::{BriefPolicy, Complexity},
};
use nucleus_store::planning::{
    Decision, DecisionAnswerInput, DecisionInput, History, Horizon, Item, ItemContent,
    ItemDisposition, ItemKind, ItemState, ItemWithTimes, Lane, LaneDisposition, LaneDocument,
    MAX_TEXT_BYTES, Plan, RecordKind,
};
use serde::{Deserialize, Serialize};

use super::{Api, ApiError, ControllerScope, Summary, body, credential, run_api_error};
use crate::{
    ServiceError,
    planning::{ItemPromotion, TaskAdmission, new_id, stamp},
};

// A JSON string can use six bytes to escape one input byte.
const PLANNING_BODY_LIMIT: usize = 6 * MAX_TEXT_BYTES + 64 * 1024;

pub(super) fn routes() -> Router<Api> {
    Router::new()
        .route(
            "/v1/planning/tasks",
            post(add_task).layer(DefaultBodyLimit::max(PLANNING_BODY_LIMIT)),
        )
        .route("/v1/planning/items/{id}/promote", post(promote))
        .nest("/v1/planning/{project}", project_routes())
        // A separate prefix keeps unqualified record paths out of the project namespace.
        .nest("/v1/planning-current", project_routes())
}

/// GET and PUT are bound to one run and its one durable delivery lane.
pub(super) fn report_lane_routes() -> Router<Api> {
    Router::new().route(
        "/v1/runs/{task}/{instance}/lanes/{project}/{key}",
        get(run_lane)
            .put(put_run_lane)
            .layer(DefaultBodyLimit::max(PLANNING_BODY_LIMIT)),
    )
}

#[derive(Serialize)]
struct ReportLane {
    #[serde(flatten)]
    lane: Lane,
    artifact: ReportArtifact,
}

impl From<Lane> for ReportLane {
    fn from(lane: Lane) -> Self {
        Self {
            artifact: lane.artifact(),
            lane,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportLaneEdit {
    version: u64,
    document: String,
}

async fn run_lane(
    State(api): State<Api>,
    Path((task, instance, project, key)): Path<(String, String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<ReportLane>, ApiError> {
    let credential = credential(&headers)?;
    let lane = api
        .service
        .report_lane(&task, &instance, &credential, &project, &key, None)
        .await
        .map_err(run_api_error)?;
    Ok(Json(lane.into()))
}

async fn put_run_lane(
    State(api): State<Api>,
    Path((task, instance, project, key)): Path<(String, String, String, String)>,
    headers: HeaderMap,
    input: Result<Json<ReportLaneEdit>, JsonRejection>,
) -> Result<Json<ReportLane>, ApiError> {
    let credential = credential(&headers)?;
    let input = body(input)?;
    let lane = api
        .service
        .report_lane(
            &task,
            &instance,
            &credential,
            &project,
            &key,
            Some((input.version, input.document)),
        )
        .await
        .map_err(run_api_error)?;
    Ok(Json(lane.into()))
}

/// The controller API and the paired board mount the same planning handlers.
pub(super) fn project_routes() -> Router<Api> {
    lane_routes()
        .route("/items", get(items).post(add_item))
        .route("/items/{id}", put(edit_item))
        .route("/items/{id}/park", post(park_item))
        .route("/items/{id}/drop", post(drop_item))
        .route("/items/{id}/reopen", post(reopen_item))
        .route("/items/{id}/assess", post(assess_item))
        .route("/items/{id}/promote", post(promote))
        .route("/tasks", post(add_task))
        .route("/decisions", get(decisions).post(add_decision))
        .route("/decisions/{id}/answer", post(answer_decision))
        .route("/history/{kind}/{id}", get(history))
        .layer(DefaultBodyLimit::max(PLANNING_BODY_LIMIT))
}

fn lane_routes() -> Router<Api> {
    Router::new()
        .route("/plan", get(plan).put(set_plan))
        .route("/lanes/{key}", put(put_lane))
        .route("/lanes/{key}/status", post(lane_status))
        .layer(DefaultBodyLimit::max(PLANNING_BODY_LIMIT))
}

#[derive(Deserialize)]
struct ProjectSelector {
    project: Option<String>,
}

impl FromRequestParts<Api> for ProjectSelector {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, api: &Api) -> Result<Self, ApiError> {
        let path = Option::<Path<Self>>::from_request_parts(parts, api)
            .await
            .map_err(|_| ApiError::Invalid)?;
        if let Some(Path(selector)) = path
            && selector.project.is_some()
        {
            return Ok(selector);
        }
        let Query(selector) = Query::<Self>::from_request_parts(parts, api)
            .await
            .map_err(|_| ApiError::Invalid)?;
        Ok(selector)
    }
}

#[derive(Deserialize)]
struct LanePath {
    key: String,
}

#[derive(Deserialize)]
struct RecordPath {
    id: String,
}

#[derive(Deserialize)]
struct HistoryPath {
    kind: RecordKind,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanView {
    #[serde(flatten)]
    plan: Plan,
    documents: Vec<Lane>,
    idle: bool,
}

async fn plan(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
) -> Result<Json<PlanView>, ApiError> {
    let (state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    let plan = state.store.plan(&project).map_err(ServiceError::from)?;
    let idle = !plan.lanes.iter().any(|entry| entry.horizon == Horizon::Now);
    let documents = state.store.lanes(&project).map_err(ServiceError::from)?;
    Ok(Json(PlanView {
        plan,
        documents,
        idle,
    }))
}

async fn set_plan(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Extension(caller): Extension<Authority>,
    input: Result<Json<Plan>, JsonRejection>,
) -> Result<Json<Plan>, ApiError> {
    let input = body(input)?;
    let (mut state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    let saved = state
        .store
        .set_plan(&project, input, stamp(&caller))
        .map_err(ServiceError::from)?;
    api.service.planning_changes.send_replace(());
    Ok(Json(saved))
}

#[derive(Deserialize)]
struct LaneInput {
    version: u64,
    #[serde(flatten)]
    document: LaneDocument,
}

async fn put_lane(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Path(LanePath { key }): Path<LanePath>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<LaneInput>, JsonRejection>,
) -> Result<Json<Lane>, ApiError> {
    let input = body(input)?;
    let (mut state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    let saved = state
        .store
        .put_lane(
            &project,
            &key,
            input.version,
            input.document,
            stamp(&caller),
        )
        .map_err(ServiceError::from)?;
    api.service.planning_changes.send_replace(());
    Ok(Json(saved))
}

async fn lane_status(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Path(LanePath { key }): Path<LanePath>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<LaneDisposition>, JsonRejection>,
) -> Result<Json<Lane>, ApiError> {
    let input = body(input)?;
    let (mut state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    let saved = state
        .store
        .set_lane_status(&project, &key, input, stamp(&caller))
        .map_err(ServiceError::from)?;
    api.service.planning_changes.send_replace(());
    Ok(Json(saved))
}

async fn items(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    session: Option<Extension<super::board::BrowserSession>>,
    ProjectSelector { project }: ProjectSelector,
) -> Result<Response, ApiError> {
    let (state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    let store = &state.store;
    if session.is_some() {
        let projects = state.settings.projects.as_ref();
        let items: Vec<BoardItem> = store
            .items_with_times(&project)
            .map_err(ServiceError::from)?
            .into_iter()
            .map(|item| {
                let author_label = item_author_label(&api, projects, &project, &item.item);
                BoardItem::new(item, author_label)
            })
            .collect();
        Ok(Json(items).into_response())
    } else {
        let projects = state.settings.projects.as_ref();
        let items: Vec<LabeledItem<Item>> = store
            .items(&project)
            .map_err(ServiceError::from)?
            .into_iter()
            .map(|item| {
                let author_label = item_author_label(&api, projects, &project, &item);
                LabeledItem { item, author_label }
            })
            .collect();
        Ok(Json(items).into_response())
    }
}

#[derive(Deserialize)]
struct ItemInput {
    kind: ItemKind,
    #[serde(flatten)]
    content: ItemContent,
}

async fn add_item(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Extension(caller): Extension<Authority>,
    input: Result<Json<ItemInput>, JsonRejection>,
) -> Result<Response, ApiError> {
    let input = body(input)?;
    let (mut state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    let actor = stamp(&caller).actor;
    let author_project_id = state
        .settings
        .projects
        .as_ref()
        .and_then(|projects| projects.projects.get(&project))
        .filter(|project_settings| is_claimed_planner(project_settings, actor))
        .map(|_| project.clone());
    let item = state
        .store
        .add_item_with_author_project(
            &project,
            new_id("i")?,
            input.kind,
            input.content,
            author_project_id,
            stamp(&caller),
        )
        .map_err(ServiceError::from)?;
    let author_label = item_author_label(&api, state.settings.projects.as_ref(), &project, &item);
    api.service.planning_changes.send_replace(());
    Ok((
        StatusCode::CREATED,
        Json(LabeledItem { item, author_label }),
    )
        .into_response())
}

/// A board item with the complexity its brief declares, read by the same brief
/// policy admission uses. Only a lead's body is its task brief.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardItem {
    #[serde(flatten)]
    item: ItemWithTimes,
    author_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    complexity: Option<Complexity>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LabeledItem<T> {
    #[serde(flatten)]
    item: T,
    author_label: String,
}

impl BoardItem {
    fn new(item: ItemWithTimes, author_label: String) -> Self {
        let complexity = (item.item.kind == ItemKind::Lead)
            .then(|| BriefPolicy::submitted(&item.item.content.body).ok())
            .flatten()
            .and_then(|policy| policy.complexity);
        Self {
            item,
            author_label,
            complexity,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardHistory {
    #[serde(flatten)]
    history: History,
    actor_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    recipient_label: Option<String>,
}

fn is_claimed_planner(project: &nucleus_store::ProjectSettings, actor: &str) -> bool {
    project
        .claimed_planner_threads
        .iter()
        .any(|thread| thread == actor)
        || project
            .planner_claim
            .as_ref()
            .is_some_and(|claim| claim.thread == actor || claim.replaced.as_deref() == Some(actor))
}

fn is_operator_actor(actor: &str) -> bool {
    actor.eq_ignore_ascii_case("operator")
        || actor.eq_ignore_ascii_case("nucleus:operator")
        || actor.eq_ignore_ascii_case("fixture-operator")
        || actor.to_ascii_lowercase().starts_with("operator via ")
}

fn actor_label(
    api: &Api,
    projects: Option<&nucleus_store::Projects>,
    project_id: &str,
    actor: &str,
) -> String {
    if is_operator_actor(actor) {
        return "Operator".into();
    }
    if let Some(project) = projects.and_then(|projects| {
        projects
            .projects
            .get(project_id)
            .filter(|project| is_claimed_planner(project, actor))
            .or_else(|| {
                projects
                    .projects
                    .values()
                    .find(|project| is_claimed_planner(project, actor))
            })
    }) {
        return format!("{} planner", project.name);
    }
    api.service
        .host
        .cached_thread_title(actor)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| "Agent thread".into())
}

fn history_recipient_label(
    api: &Api,
    projects: Option<&nucleus_store::Projects>,
    project_id: &str,
    history: &History,
) -> Option<String> {
    let recipient = history.snapshot.get("recipient")?.as_str()?;
    Some(if recipient == "new planner thread" {
        recipient.to_owned()
    } else {
        actor_label(api, projects, project_id, recipient)
    })
}

fn item_author_label(
    api: &Api,
    projects: Option<&nucleus_store::Projects>,
    project_id: &str,
    item: &Item,
) -> String {
    item.author_project_id
        .as_deref()
        .and_then(|project_id| projects?.projects.get(project_id))
        .map_or_else(
            || actor_label(api, projects, project_id, &item.author),
            |project| format!("{} planner", project.name),
        )
}

#[derive(Deserialize)]
struct ItemEdit {
    version: Option<i64>,
    #[serde(flatten)]
    content: ItemContent,
}

async fn edit_item(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    session: Option<Extension<super::board::BrowserSession>>,
    ProjectSelector { project }: ProjectSelector,
    Path(RecordPath { id }): Path<RecordPath>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<ItemEdit>, JsonRejection>,
) -> Result<Response, ApiError> {
    let input = body(input)?;
    if session.is_some() && input.version.is_none_or(|version| version <= 0) {
        return Err(ApiError::Invalid);
    }
    let (mut state, resolved) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    if session.is_some() && project.as_deref() != Some(resolved.as_str()) {
        return Err(ServiceError::Project.into());
    }
    let saved = state
        .store
        .edit_item(&resolved, &id, input.content, input.version, stamp(&caller))
        .map_err(ServiceError::from)?;
    api.service.planning_changes.send_replace(());
    Ok(if input.version.is_some() {
        let author_label = item_author_label(
            &api,
            state.settings.projects.as_ref(),
            &resolved,
            &saved.item,
        );
        Json(LabeledItem {
            item: saved,
            author_label,
        })
        .into_response()
    } else {
        let author_label = item_author_label(
            &api,
            state.settings.projects.as_ref(),
            &resolved,
            &saved.item,
        );
        Json(LabeledItem {
            item: saved.item,
            author_label,
        })
        .into_response()
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Park {
    reason: String,
    revisit_at: Option<String>,
}

async fn park_item(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Path(RecordPath { id }): Path<RecordPath>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<Park>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Park { reason, revisit_at } = body(input)?;
    let (mut state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    let saved = state
        .store
        .set_item_state(
            &project,
            &id,
            ItemState::Parked { reason, revisit_at },
            stamp(&caller),
        )
        .map_err(ServiceError::from)?;
    let author_label = item_author_label(&api, state.settings.projects.as_ref(), &project, &saved);
    api.service.planning_changes.send_replace(());
    Ok(Json(LabeledItem {
        item: saved,
        author_label,
    })
    .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DropItem {
    #[serde(default)]
    disposition: ItemDisposition,
    reason: Option<String>,
}

async fn drop_item(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Path(RecordPath { id }): Path<RecordPath>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<DropItem>, JsonRejection>,
) -> Result<Response, ApiError> {
    let DropItem {
        reason,
        disposition,
    } = body(input)?;
    let (mut state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    let saved = state
        .store
        .set_item_state(
            &project,
            &id,
            ItemState::Dropped {
                reason,
                disposition,
            },
            stamp(&caller),
        )
        .map_err(ServiceError::from)?;
    let author_label = item_author_label(&api, state.settings.projects.as_ref(), &project, &saved);
    api.service.planning_changes.send_replace(());
    Ok(Json(LabeledItem {
        item: saved,
        author_label,
    })
    .into_response())
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReopenItem {
    note: Option<String>,
    version: Option<i64>,
}

async fn reopen_item(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Path(RecordPath { id }): Path<RecordPath>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<ReopenItem>, JsonRejection>,
) -> Result<Response, ApiError> {
    let input = body(input)?;
    let (mut state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    let saved = state
        .store
        .reopen_item(
            &project,
            &id,
            input.version,
            input.note.as_deref(),
            stamp(&caller),
        )
        .map_err(ServiceError::from)?;
    let author_label = item_author_label(
        &api,
        state.settings.projects.as_ref(),
        &project,
        &saved.item,
    );
    api.service.planning_changes.send_replace(());
    Ok(Json(LabeledItem {
        item: saved,
        author_label,
    })
    .into_response())
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct AssessItem {
    version: Option<i64>,
}

async fn assess_item(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    session: Option<Extension<super::board::BrowserSession>>,
    ProjectSelector { project }: ProjectSelector,
    Path(RecordPath { id }): Path<RecordPath>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<AssessItem>, JsonRejection>,
) -> Result<Response, ApiError> {
    let input = body(input)?;
    if session.is_some() && input.version.is_none_or(|version| version <= 0) {
        return Err(ApiError::Invalid);
    }
    let saved = api
        .service
        .assess_planning_item(project.as_deref(), &id, input.version, &caller, &scope)
        .await?;
    let (state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    let author_label = item_author_label(
        &api,
        state.settings.projects.as_ref(),
        &project,
        &saved.item,
    );
    api.service.planning_changes.send_replace(());
    Ok(Json(LabeledItem {
        item: saved,
        author_label,
    })
    .into_response())
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Promotion {
    repository: Option<String>,
    complexity: Option<Complexity>,
    /// The item version the caller saw; a later change refuses the promotion.
    version: Option<i64>,
}

async fn promote(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Path(RecordPath { id }): Path<RecordPath>,
    Extension(caller): Extension<Authority>,
    input: Result<Option<Json<Promotion>>, JsonRejection>,
) -> Result<(StatusCode, Json<Summary>), ApiError> {
    let Promotion {
        repository,
        complexity,
        version,
    } = input
        .map_err(|_| ApiError::Invalid)?
        .map(|Json(input)| input)
        .unwrap_or_default();
    let (created, row) = api
        .service
        .promote_planning_item(
            project.as_deref(),
            &id,
            ItemPromotion {
                repository: repository.as_deref(),
                complexity,
                version,
            },
            &caller,
            &scope,
        )
        .await?;
    api.service.planning_changes.send_replace(());
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((
        status,
        Json(super::summary_after(&api.service, &row, &scope, &caller).await?),
    ))
}

async fn add_task(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Extension(caller): Extension<Authority>,
    input: Result<Json<TaskAdmission>, JsonRejection>,
) -> Result<(StatusCode, Json<Summary>), ApiError> {
    let task = api
        .service
        .add_planned_task(project.as_deref(), body(input)?, &caller, &scope)
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(super::summary_after(&api.service, &task, &scope, &caller).await?),
    ))
}

#[derive(Deserialize)]
struct DecisionQuery {
    #[serde(default)]
    pending: bool,
}

async fn decisions(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Query(query): Query<DecisionQuery>,
) -> Result<Json<Vec<LabeledItem<Decision>>>, ApiError> {
    let (state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    Ok(Json(
        state
            .store
            .decisions(&project, query.pending)
            .map_err(ServiceError::from)?
            .into_iter()
            .map(|item| {
                let author_label = actor_label(
                    &api,
                    state.settings.projects.as_ref(),
                    &project,
                    &item.author,
                );
                LabeledItem { item, author_label }
            })
            .collect(),
    ))
}

async fn add_decision(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Extension(caller): Extension<Authority>,
    input: Result<Json<DecisionInput>, JsonRejection>,
) -> Result<(StatusCode, Json<Decision>), ApiError> {
    let decision = api
        .service
        .add_decision_in_scope(project.as_deref(), body(input)?, &caller, &scope)
        .await?;
    Ok((StatusCode::CREATED, Json(decision)))
}

async fn answer_decision(
    State(api): State<Api>,
    ProjectSelector { project }: ProjectSelector,
    Path(RecordPath { id }): Path<RecordPath>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<DecisionAnswerInput>, JsonRejection>,
) -> Result<Json<Decision>, ApiError> {
    let input = body(input)?;
    // Operators use an explicit project for decisions.
    let project = project.ok_or(ServiceError::Project)?;
    Ok(Json(
        api.service
            .answer_decision(&project, &id, input, &caller)
            .await?,
    ))
}

async fn history(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Path(HistoryPath { kind, id }): Path<HistoryPath>,
) -> Result<Response, ApiError> {
    let (state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    let history = state
        .store
        .planning_history(&project, kind, &id)
        .map_err(ServiceError::from)?;
    let projects = state.settings.projects.as_ref();
    let history: Vec<BoardHistory> = history
        .into_iter()
        .map(|history| BoardHistory {
            actor_label: actor_label(&api, projects, &project, &history.actor),
            recipient_label: history_recipient_label(&api, projects, &project, &history),
            history,
        })
        .collect();
    Ok(Json(history).into_response())
}
