use std::{convert::Infallible, sync::Arc};

use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, Query, Request, State, rejection::JsonRejection},
    http::{
        HeaderMap, StatusCode,
        header::{AUTHORIZATION, HOST, ORIGIN},
    },
    middleware::{self, Next},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use futures_util::{Stream, stream};
use nucleus_core::{
    Answer, Authority, Brief, Command, Hold, Identity, Observation, Phase, PullRequest, Question,
    Report, Role, Task, Verdict, WaitReason,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use crate::{
    CommandOutcome, Preflight, Service, ServiceError, State as EngineState, now_ms, preflight,
};

#[cfg(test)]
mod tests;

#[derive(Clone)]
struct Api {
    service: Arc<Service>,
    controllers: Arc<[Controller]>,
}

/// A controller key and the identity authenticated by that key.
pub struct Controller {
    pub credential: [u8; 32],
    pub authority: Authority,
}

/// Bind the engine's JSON API and its revision stream. Task commands and
/// callbacks use separate credentials. Serve on the configured loopback address.
pub fn router(service: Arc<Service>, controllers: impl IntoIterator<Item = Controller>) -> Router {
    let api = Api {
        service,
        controllers: controllers.into_iter().collect(),
    };
    let controller = Router::new()
        .route("/v1/tasks", get(list).post(admit))
        .route("/v1/tasks/{id}", get(detail))
        .route("/v1/tasks/{id}/next", get(next))
        .route("/v1/tasks/{id}/history", get(history))
        .route("/v1/tasks/{id}/commands", post(command))
        .route("/v1/settings", get(settings))
        .route("/v1/events", get(events))
        .route_layer(middleware::from_fn_with_state(api.clone(), authorize));
    controller
        .route("/v1/runs/{task}/{instance}/report", post(report))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn_with_state(
            api.clone(),
            authorize_address,
        ))
        .with_state(api)
}

async fn authorize_address(
    State(api): State<Api>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let mut hosts = request.headers().get_all(HOST).iter();
    let host = hosts
        .next()
        .and_then(|host| host.to_str().ok())
        .ok_or(ApiError::Address)?;
    let address = api.service.callback;
    if hosts.next().is_some()
        || (host != address.to_string() && host != format!("localhost:{}", address.port()))
    {
        return Err(ApiError::Address);
    }
    let mut origins = request.headers().get_all(ORIGIN).iter();
    if let Some(origin) = origins.next()
        && (origins.next().is_some() || origin != &format!("http://{host}"))
    {
        return Err(ApiError::Address);
    }
    Ok(next.run(request).await)
}

async fn authorize(
    State(api): State<Api>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let supplied = credential(request.headers())?;
    let mut matches = api
        .controllers
        .iter()
        .filter(|caller| bool::from(caller.credential.ct_eq(&supplied)));
    let caller = matches.next().ok_or(ApiError::Unauthorized)?;
    if matches.next().is_some() {
        return Err(ApiError::Unauthorized);
    }
    request.extensions_mut().insert(caller.authority.clone());
    Ok(next.run(request).await)
}

async fn report(
    State(api): State<Api>,
    Path((task, instance)): Path<(String, String)>,
    headers: HeaderMap,
    report: Result<Json<Report>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let credential = credential(&headers)?;
    let report = body(report)?;
    match api
        .service
        .report(&task, &instance, &credential, report)
        .await
    {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(
            ServiceError::Missing
            | ServiceError::Project
            | ServiceError::Core(nucleus_core::CommandError::InvalidReportCredential),
        ) => Err(ApiError::Unauthorized),
        Err(error) => Err(error.into()),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Admission {
    id: String,
    reference: String,
    brief: String,
}

async fn admit(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    input: Result<Json<Admission>, JsonRejection>,
) -> Result<(StatusCode, Json<Summary>), ApiError> {
    let input = body(input)?;
    let task = api
        .service
        .admit(input.id, input.reference, input.brief, &authority)
        .await?;
    Ok((StatusCode::CREATED, Json(Summary::new(&task, 1, None))))
}

async fn list(State(api): State<Api>) -> Result<Json<Vec<Summary>>, ApiError> {
    api.service
        .storage
        .database()
        .verify()
        .map_err(ServiceError::from)?;
    let state = api.service.state.lock().await;
    let tasks = state.store.list().map_err(ServiceError::from)?;
    Ok(Json(
        tasks
            .iter()
            .filter(|row| api.service.project.scope(row.task.identity()).is_ok())
            .map(|row| Summary::read(&row.task, row.version, &state))
            .collect(),
    ))
}

async fn detail(State(api): State<Api>, Path(id): Path<String>) -> Result<Json<Detail>, ApiError> {
    let state = api.service.state.lock().await;
    let row = api.service.lookup(&state, &id)?;
    let task = &row.task;
    let summary = Summary::read(task, row.version, &state);
    let run = task.run().map(|run| {
        let launch = run.launch();
        RunView {
            role: launch.role,
            thread: launch.thread.clone(),
            instance: launch.instance.clone(),
            purpose: purpose(task, launch.role),
            reserved_at: launch.started_at,
            last_send_at: run.last_send_at_ms(),
            review_head: launch.review_head.clone(),
            reported: run.report().is_some(),
            revoked: run.revoked(),
        }
    });
    Ok(Json(Detail {
        summary,
        brief: task.brief().clone(),
        pull_request: task.pull_request().cloned(),
        verdict: task.verdict().cloned(),
        run,
    }))
}

async fn next(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    Path(id): Path<String>,
) -> Result<Json<NextView>, ApiError> {
    let state = api.service.state.lock().await;
    let row = api.service.lookup(&state, &id)?;
    let task = &row.task;
    let summary = Summary::read(task, row.version, &state);
    Ok(Json(NextView {
        version: row.version,
        phase: summary.phase,
        wait: summary.wait,
        next_check_at: summary.next_check_at,
        question: summary.question,
        commands: command_options(task, &authority, &state.command_observation(&row)),
    }))
}

fn command_options(
    task: &Task,
    authority: &Authority,
    observation: &Observation,
) -> Vec<CommandView> {
    let mut commands = vec![
        ("cancel", Command::Cancel),
        ("amend", Command::Amend(task.brief().text.clone())),
        if task.hold().is_some() {
            ("release", Command::Release)
        } else {
            ("hold", Command::Hold(String::new()))
        },
    ];
    if let Some(question) = task.question() {
        let answer = match question {
            Question::Work { .. } | Question::Repair(_) => Answer::Work(String::new()),
            Question::Retry { .. } => Answer::Retry,
            Question::Accept { head } => Answer::Accept {
                head: head.clone(),
                reason: String::new(),
            },
        };
        commands.push(("answer", Command::Answer(answer)));
    }
    let check = |command| match preflight(&mut task.clone(), authority, observation, command) {
        Ok(Preflight::Ready) => CommandReadiness::Ready,
        Ok(Preflight::Pending) => CommandReadiness::Pending,
        Err(_) => CommandReadiness::Unavailable,
    };
    let moves = [
        Phase::Queued,
        Phase::Working,
        Phase::Reviewing,
        Phase::Merging,
        Phase::Closing,
        Phase::Done,
        Phase::Cancelled,
    ];
    moves
        .into_iter()
        .map(|phase| CommandView {
            name: "move",
            preflight: check(Command::Move(phase)),
            phase: Some(phase),
        })
        .chain(commands.into_iter().map(|(name, command)| CommandView {
            name,
            preflight: check(command),
            phase: None,
        }))
        .collect()
}

fn purpose(task: &Task, role: Role) -> String {
    match role {
        Role::Worker => task
            .brief()
            .text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map_or_else(
                || "Implement the brief".into(),
                |line| line.chars().take(100).collect(),
            ),
        Role::Reviewer => "Review the exact PR head".into(),
    }
}

async fn command(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    Path(id): Path<String>,
    input: Result<Json<Command>, JsonRejection>,
) -> Result<Response, ApiError> {
    match api.service.command(&id, &authority, body(input)?).await? {
        CommandOutcome::Applied(row) => {
            Ok(Json(Summary::new(&row.task, row.version, None)).into_response())
        }
        CommandOutcome::Pending { version } => Ok((
            StatusCode::ACCEPTED,
            Json(json!({"status": "pending", "version": version})),
        )
            .into_response()),
    }
}

#[derive(Deserialize)]
struct Page {
    before: Option<i64>,
    limit: Option<u32>,
}

async fn history(
    State(api): State<Api>,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> Result<Json<Vec<nucleus_store::Event>>, ApiError> {
    Ok(Json(
        api.service
            .history(&id, page.before, page.limit.unwrap_or(30))
            .await?,
    ))
}

async fn settings(State(api): State<Api>) -> Json<Value> {
    let storage = &api.service.storage;
    let project = &api.service.project;
    Json(json!({
        "enabled": true,
        "storage": {
            "workRoot": storage.work().path(),
            "scratchRoot": storage.scratch().path(),
        },
        "roles": { "worker": project.worker, "reviewer": project.reviewer },
    }))
}

async fn events(State(api): State<Api>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    Sse::new(stream::unfold(
        (api.service.changes(), true),
        |(mut receiver, first)| async move {
            let event = if first {
                Event::default().event("refresh").data("{}")
            } else {
                match receiver.recv().await {
                    Ok(change) => Event::default()
                        .event("invalidate")
                        .json_data(change)
                        .ok()?,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        Event::default().event("refresh").data("{}")
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                }
            };
            Some((Ok(event), (receiver, false)))
        },
    ))
    .keep_alive(KeepAlive::default())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    identity: Identity,
    version: i64,
    phase: Phase,
    wait: Option<WaitReason>,
    next_check_at: Option<u64>,
    question: Option<Question>,
    hold: Option<Hold>,
}

impl Summary {
    fn read(task: &Task, version: i64, state: &EngineState) -> Self {
        let id = &task.identity().id;
        let mut view = Self::new(task, version, state.waits.get(id).copied());
        if view.wait.is_some() {
            view.next_check_at = state.schedule.due(id).map(|due| {
                let delay = due.saturating_duration_since(tokio::time::Instant::now());
                now_ms().saturating_add(u64::try_from(delay.as_millis()).unwrap_or(u64::MAX))
            });
        }
        view
    }

    fn new(task: &Task, version: i64, wait: Option<WaitReason>) -> Self {
        Self {
            identity: task.identity().clone(),
            version,
            phase: task.phase(),
            next_check_at: None,
            wait: if task.run().is_some_and(nucleus_core::Run::revoked) {
                Some(WaitReason::Stopping)
            } else if task.hold().is_some() {
                Some(WaitReason::Hold)
            } else if task.question().is_some() {
                Some(WaitReason::Question)
            } else {
                wait
            },
            question: task.question().cloned(),
            hold: task.hold().cloned(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Detail {
    #[serde(flatten)]
    summary: Summary,
    brief: Brief,
    pull_request: Option<PullRequest>,
    verdict: Option<Verdict>,
    run: Option<RunView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunView {
    role: Role,
    thread: String,
    instance: String,
    purpose: String,
    reserved_at: u64,
    last_send_at: Option<u64>,
    review_head: Option<nucleus_core::Head>,
    reported: bool,
    revoked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NextView {
    version: i64,
    phase: Phase,
    wait: Option<WaitReason>,
    next_check_at: Option<u64>,
    question: Option<Question>,
    commands: Vec<CommandView>,
}

#[derive(Serialize)]
struct CommandView {
    name: &'static str,
    preflight: CommandReadiness,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<Phase>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum CommandReadiness {
    Ready,
    Pending,
    Unavailable,
}

enum ApiError {
    Unauthorized,
    Address,
    Invalid,
    Service(ServiceError),
}

impl From<ServiceError> for ApiError {
    fn from(error: ServiceError) -> Self {
        Self::Service(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "authentication failed".into()),
            Self::Address => (
                StatusCode::FORBIDDEN,
                "request must use the engine's loopback address and origin".into(),
            ),
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid request".into()),
            Self::Service(error) => {
                let status = match error {
                    ServiceError::Missing => StatusCode::NOT_FOUND,
                    ServiceError::Input | ServiceError::Project => StatusCode::BAD_REQUEST,
                    ServiceError::QuestionPlanner => StatusCode::FORBIDDEN,
                    ServiceError::Core(_)
                    | ServiceError::Store(nucleus_store::StoreError::StaleTask) => {
                        StatusCode::CONFLICT
                    }
                    _ => StatusCode::SERVICE_UNAVAILABLE,
                };
                (status, error.to_string())
            }
        };
        (status, Json(json!({"error": message}))).into_response()
    }
}

fn credential(headers: &HeaderMap) -> Result<[u8; 32], ApiError> {
    let value = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized)?;
    let mut decoded = [0; 32];
    hex::decode_to_slice(value, &mut decoded).map_err(|_| ApiError::Unauthorized)?;
    Ok(decoded)
}

fn body<T>(input: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    input
        .map(|Json(value)| value)
        .map_err(|_| ApiError::Invalid)
}
