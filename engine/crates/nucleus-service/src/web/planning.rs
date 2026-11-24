use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State, rejection::JsonRejection},
    http::StatusCode,
    routing::{get, post, put},
};
use nucleus_core::Authority;
use nucleus_store::planning::{
    Decision, DecisionAnswerInput, DecisionInput, History, Horizon, Item, ItemContent, ItemKind,
    ItemState, Lane, LaneDisposition, LaneDocument, MAX_TEXT_BYTES, Plan, RecordKind,
};
use serde::{Deserialize, Serialize};

use super::{Api, ApiError, ControllerScope, Summary, body};
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
        .route("/v1/planning/items/{id}/promote", post(promote_current))
        .nest("/v1/planning/{project}", project_routes())
}

/// Every planning record route for one project. The controller API and the
/// paired board mount the same handlers, so authority checks stay in one place.
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

pub(super) fn lane_routes() -> Router<Api> {
    Router::new()
        .route("/plan", get(plan).put(set_plan))
        .route("/lanes/{key}", put(put_lane))
        .route("/lanes/{key}/status", post(lane_status))
        .layer(DefaultBodyLimit::max(PLANNING_BODY_LIMIT))
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
    Path(project): Path<String>,
) -> Result<Json<PlanView>, ApiError> {
    let state = api
        .service
        .planning_state_in_scope(&project, &scope)
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
    Path(project): Path<String>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<Plan>, JsonRejection>,
) -> Result<Json<Plan>, ApiError> {
    let input = body(input)?;
    let mut state = api
        .service
        .planning_state_in_scope(&project, &scope)
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
    Path((project, key)): Path<(String, String)>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<LaneInput>, JsonRejection>,
) -> Result<Json<Lane>, ApiError> {
    let input = body(input)?;
    let mut state = api
        .service
        .planning_state_in_scope(&project, &scope)
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
    Path((project, key)): Path<(String, String)>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<LaneDisposition>, JsonRejection>,
) -> Result<Json<Lane>, ApiError> {
    let input = body(input)?;
    let mut state = api
        .service
        .planning_state_in_scope(&project, &scope)
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
    Path(project): Path<String>,
) -> Result<Json<Vec<Item>>, ApiError> {
    let state = api
        .service
        .planning_state_in_scope(&project, &scope)
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
    Path(project): Path<String>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<ItemInput>, JsonRejection>,
) -> Result<(StatusCode, Json<Item>), ApiError> {
    let input = body(input)?;
    let mut state = api
        .service
        .planning_state_in_scope(&project, &scope)
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
    Path((project, id)): Path<(String, String)>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<ItemContent>, JsonRejection>,
) -> Result<Json<Item>, ApiError> {
    let input = body(input)?;
    let mut state = api
        .service
        .planning_state_in_scope(&project, &scope)
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
    Path((project, id)): Path<(String, String)>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<Park>, JsonRejection>,
) -> Result<Json<Item>, ApiError> {
    let Park { reason, revisit_at } = body(input)?;
    let mut state = api
        .service
        .planning_state_in_scope(&project, &scope)
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
    Path((project, id)): Path<(String, String)>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<DropItem>, JsonRejection>,
) -> Result<Json<Item>, ApiError> {
    let DropItem { reason } = body(input)?;
    let mut state = api
        .service
        .planning_state_in_scope(&project, &scope)
        .await?;
    Ok(Json(
        state
            .store
            .set_item_state(&project, &id, ItemState::Dropped { reason }, stamp(&caller))
            .map_err(ServiceError::from)?,
    ))
}

async fn promote(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    Path((project, id)): Path<(String, String)>,
    Extension(caller): Extension<Authority>,
) -> Result<(StatusCode, Json<Summary>), ApiError> {
    promote_in_scope(api, Some(&project), &id, &caller, &scope).await
}

async fn promote_current(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    Path(id): Path<String>,
    Extension(caller): Extension<Authority>,
) -> Result<(StatusCode, Json<Summary>), ApiError> {
    promote_in_scope(api, None, &id, &caller, &scope).await
}

async fn promote_in_scope(
    api: Api,
    project: Option<&str>,
    id: &str,
    caller: &Authority,
    scope: &ControllerScope,
) -> Result<(StatusCode, Json<Summary>), ApiError> {
    let (created, row) = api
        .service
        .promote_planning_item(project, id, caller, scope)
        .await?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(Summary::new(&row, None))))
}

async fn add_task(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    project: Option<Path<String>>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<TaskAdmission>, JsonRejection>,
) -> Result<(StatusCode, Json<Summary>), ApiError> {
    let project = project.as_ref().map(|Path(project)| project.as_str());
    let task = api
        .service
        .add_planned_task(project, body(input)?, &caller, &scope)
        .await?;
    Ok((StatusCode::CREATED, Json(Summary::new(&task, None))))
}

#[derive(Deserialize)]
struct DecisionQuery {
    #[serde(default)]
    pending: bool,
}

async fn decisions(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    Path(project): Path<String>,
    Query(query): Query<DecisionQuery>,
) -> Result<Json<Vec<Decision>>, ApiError> {
    let state = api
        .service
        .planning_state_in_scope(&project, &scope)
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
    Path(project): Path<String>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<DecisionInput>, JsonRejection>,
) -> Result<(StatusCode, Json<Decision>), ApiError> {
    let decision = api
        .service
        .add_decision_in_scope(&project, body(input)?, &caller, &scope)
        .await?;
    Ok((StatusCode::CREATED, Json(decision)))
}

async fn answer_decision(
    State(api): State<Api>,
    Path((project, id)): Path<(String, String)>,
    Extension(caller): Extension<Authority>,
    input: Result<Json<DecisionAnswerInput>, JsonRejection>,
) -> Result<Json<Decision>, ApiError> {
    Ok(Json(
        api.service
            .answer_decision(&project, &id, body(input)?, &caller)
            .await?,
    ))
}

async fn history(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    Path((project, kind, id)): Path<(String, RecordKind, String)>,
) -> Result<Json<Vec<History>>, ApiError> {
    let state = api
        .service
        .planning_state_in_scope(&project, &scope)
        .await?;
    Ok(Json(
        state
            .store
            .planning_history(&project, kind, &id)
            .map_err(ServiceError::from)?,
    ))
}
