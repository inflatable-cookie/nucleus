use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, FromRequestParts, Path, Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, request::Parts},
    routing::{get, post, put},
};
use nucleus_core::{Authority, ReportArtifact, profiles::Complexity};
use nucleus_store::planning::{
    Decision, DecisionAnswerInput, DecisionInput, History, Horizon, Item, ItemContent, ItemKind,
    ItemState, Lane, LaneDisposition, LaneDocument, MAX_TEXT_BYTES, Plan, RecordKind,
};
use serde::{Deserialize, Serialize};

use super::{Api, ApiError, ControllerScope, Summary, body, credential, run_api_error};
use crate::{
    ServiceError,
    planning::{TaskAdmission, new_id, stamp},
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
    api.service.settings_changes.send_replace(());
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
    api.service.settings_changes.send_replace(());
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
    api.service.settings_changes.send_replace(());
    Ok(Json(saved))
}

async fn items(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
) -> Result<Json<Vec<Item>>, ApiError> {
    let (state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    Ok(Json(
        state.store.items(&project).map_err(ServiceError::from)?,
    ))
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
) -> Result<(StatusCode, Json<Item>), ApiError> {
    let input = body(input)?;
    let (mut state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    let item = state
        .store
        .add_item(
            &project,
            new_id("i")?,
            input.kind,
            input.content,
            stamp(&caller),
        )
        .map_err(ServiceError::from)?;
    Ok((StatusCode::CREATED, Json(item)))
}

async fn edit_item(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Path(RecordPath { id }): Path<RecordPath>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<ItemContent>, JsonRejection>,
) -> Result<Json<Item>, ApiError> {
    let input = body(input)?;
    let (mut state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    Ok(Json(
        state
            .store
            .edit_item(&project, &id, input, stamp(&caller))
            .map_err(ServiceError::from)?,
    ))
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
) -> Result<Json<Item>, ApiError> {
    let Park { reason, revisit_at } = body(input)?;
    let (mut state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    Ok(Json(
        state
            .store
            .set_item_state(
                &project,
                &id,
                ItemState::Parked { reason, revisit_at },
                stamp(&caller),
            )
            .map_err(ServiceError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DropItem {
    reason: Option<String>,
}

async fn drop_item(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Path(RecordPath { id }): Path<RecordPath>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<DropItem>, JsonRejection>,
) -> Result<Json<Item>, ApiError> {
    let DropItem { reason } = body(input)?;
    let (mut state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    Ok(Json(
        state
            .store
            .set_item_state(&project, &id, ItemState::Dropped { reason }, stamp(&caller))
            .map_err(ServiceError::from)?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Promotion {
    complexity: Option<Complexity>,
}

async fn promote(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    ProjectSelector { project }: ProjectSelector,
    Path(RecordPath { id }): Path<RecordPath>,
    Extension(caller): Extension<Authority>,
    input: Result<Option<Json<Promotion>>, JsonRejection>,
) -> Result<(StatusCode, Json<Summary>), ApiError> {
    let complexity = input
        .map_err(|_| ApiError::Invalid)?
        .and_then(|Json(input)| input.complexity);
    let (created, row) = api
        .service
        .promote_planning_item(project.as_deref(), &id, complexity, &caller, &scope)
        .await?;
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
) -> Result<Json<Vec<Decision>>, ApiError> {
    let (state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    Ok(Json(
        state
            .store
            .decisions(&project, query.pending)
            .map_err(ServiceError::from)?,
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
) -> Result<Json<Vec<History>>, ApiError> {
    let (state, project) = api
        .service
        .planning_state_in_scope(project.as_deref(), &scope)
        .await?;
    Ok(Json(
        state
            .store
            .planning_history(&project, kind, &id)
            .map_err(ServiceError::from)?,
    ))
}
