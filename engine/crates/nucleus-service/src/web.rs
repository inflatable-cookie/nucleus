use std::{convert::Infallible, sync::Arc};

use axum::{
    Extension, Json, Router,
    extract::{
        DefaultBodyLimit, FromRequestParts, Path, Query, Request, State, rejection::JsonRejection,
    },
    http::{
        HeaderMap, Method, StatusCode,
        header::{AUTHORIZATION, HOST, ORIGIN},
        request::Parts,
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
    Report, Task, Verdict, WaitReason,
};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::Value;
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{
    CommandOutcome, Preflight, Service, ServiceError, State as EngineState,
    acp::{MintedSession, SessionAccess, WriteAccess},
    now_ms,
    presentation::{HistoryEvent, RunView},
};

mod board;
mod inbox;
mod planning;
mod settings;
pub use board::{router_with_board, router_with_board_and_t3_callers};
pub(crate) use settings::{CachedHost, RuntimeSettings};

#[cfg(test)]
mod tests;

#[derive(Clone)]
struct Api {
    service: Arc<Service>,
    controllers: Arc<[ControllerEntry]>,
    t3_caller_key: Option<[u8; 32]>,
}

/// A controller key and the identity authenticated by that key.
#[derive(Clone)]
pub struct Controller {
    pub credential: [u8; 32],
    pub authority: Authority,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub(crate) struct ControllerScope(Option<String>);

impl ControllerScope {
    pub(crate) fn actor(&self) -> Option<&str> {
        self.0.as_deref()
    }

    pub(crate) fn require(
        &self,
        state: &EngineState,
        project_id: &str,
    ) -> Result<(), ServiceError> {
        if self
            .actor()
            .is_none_or(|actor| state.live_planner_project(actor) == Some(project_id))
        {
            Ok(())
        } else {
            Err(ServiceError::ControllerProject)
        }
    }

    pub(crate) fn task(
        &self,
        state: &EngineState,
        identity: &Identity,
    ) -> Result<(), ServiceError> {
        if self.0.is_some() {
            let (id, _, repo) = state
                .settings
                .project_for_origin(&identity.repository)
                .ok_or(ServiceError::ControllerProject)?;
            self.require(state, id)?;
            if repo.base != identity.base {
                return Err(ServiceError::ControllerProject);
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
struct ControllerEntry {
    controller: Controller,
    scope: ControllerScope,
}

impl ControllerEntry {
    fn t3(actor: &str, credential: [u8; 32]) -> Self {
        Self {
            controller: Controller {
                credential,
                authority: Authority::Planner {
                    actor: actor.into(),
                },
            },
            scope: ControllerScope(Some(actor.into())),
        }
    }

    fn digest(&self) -> [u8; 32] {
        self.controller.digest()
    }

    fn extend(&self, request: &mut Request) {
        request
            .extensions_mut()
            .insert(self.controller.authority.clone());
        request.extensions_mut().insert(self.scope.clone());
        request
            .extensions_mut()
            .insert(ControllerDigest(self.digest()));
    }
}

impl Controller {
    fn digest(&self) -> [u8; 32] {
        let (role, actor): (&[u8], &str) = match &self.authority {
            Authority::Operator { actor } => (b"operator", actor),
            Authority::Planner { actor } => (b"planner", actor),
        };
        Sha256::new()
            .chain_update(self.credential)
            .chain_update(role)
            .chain_update(actor.as_bytes())
            .finalize()
            .into()
    }
}

#[derive(Clone)]
struct ControllerDigest([u8; 32]);

/// Bind the engine's JSON API and its revision stream. Task commands and
/// callbacks use separate credentials. Serve on the configured loopback address.
pub fn router(service: Arc<Service>, controllers: impl IntoIterator<Item = Controller>) -> Router {
    router_with_t3_callers(service, controllers, None)
}

/// Bind the API with the machine-local T3 CLI credential alongside the operator key.
pub fn router_with_t3_callers(
    service: Arc<Service>,
    controllers: impl IntoIterator<Item = Controller>,
    t3_caller_key: Option<[u8; 32]>,
) -> Router {
    routes(service, controllers, None, t3_caller_key)
}

fn routes(
    service: Arc<Service>,
    controllers: impl IntoIterator<Item = Controller>,
    board: Option<board::Board>,
    t3_caller_key: Option<[u8; 32]>,
) -> Router {
    let carriers = controllers
        .into_iter()
        .filter(|controller| {
            service.project.is_some() || matches!(controller.authority, Authority::Operator { .. })
        })
        .map(|controller| ControllerEntry {
            controller,
            scope: ControllerScope::default(),
        })
        .collect();
    let api = Api {
        service,
        controllers: carriers,
        t3_caller_key,
    };
    let controller = Router::new()
        .route("/v1/tasks", get(list).post(admit))
        .route("/v1/tasks/{id}/acp", post(bind_acp))
        .route("/v1/tasks/{id}/next", get(next))
        .route("/v1/health", get(settings::health))
        .route("/v1/settings", get(settings::all))
        .route(
            "/v1/settings/{domain}",
            get(settings::get).put(settings::put),
        )
        .route("/v1/settings/projects/reassign", post(settings::reassign))
        .route("/v1/events", get(events))
        .merge(planning::routes())
        .route_layer(middleware::from_fn_with_state(api.clone(), authorize));
    let tasks = Router::new()
        .route("/v1/tasks/{id}", get(detail))
        .route("/v1/tasks/{id}/history", get(history))
        .route("/v1/tasks/{id}/commands", post(command))
        .route("/v1/tasks/{id}/events", get(task_events))
        .route_layer(middleware::from_fn_with_state(api.clone(), authorize_task));
    let mut routes = controller
        .merge(tasks)
        .merge(inbox::routes())
        .route("/v1/runs/{task}/{instance}/report", post(report));
    if let Some(board) = board {
        routes = routes.merge(board.routes(&api));
    }
    routes
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
    let caller =
        request_controller(&api, &supplied, request.headers()).ok_or(ApiError::Unauthorized)?;
    reauthorize_known(&api, &caller.scope, request.method()).await?;
    caller.extend(&mut request);
    Ok(next.run(request).await)
}

fn controller<'a>(api: &'a Api, supplied: &[u8; 32]) -> Option<&'a ControllerEntry> {
    let mut matches = api
        .controllers
        .iter()
        .filter(|caller| bool::from(caller.controller.credential.ct_eq(supplied)));
    let caller = matches.next()?;
    matches.next().is_none().then_some(caller)
}

fn request_controller(
    api: &Api,
    supplied: &[u8; 32],
    headers: &HeaderMap,
) -> Option<ControllerEntry> {
    let mut callers = headers.get_all("x-nucleus-t3-caller").iter();
    let Some(actor) = callers.next() else {
        return controller(api, supplied).cloned();
    };
    let actor = actor.to_str().ok()?;
    let key = api.t3_caller_key?;
    if callers.next().is_some()
        || api.service.project.is_some()
        || actor.is_empty()
        || actor.len() > 240
        || actor.trim() != actor
        || !bool::from(key.ct_eq(supplied))
    {
        return None;
    }
    Some(ControllerEntry::t3(actor, key))
}

async fn reauthorize_known(
    api: &Api,
    scope: &ControllerScope,
    method: &Method,
) -> Result<(), ServiceError> {
    if !method.is_safe()
        && let Some(actor) = scope.actor()
    {
        let mut state = api.service.state.lock().await;
        if state.settings.planner_route(actor).is_some()
            && state.live_planner_project(actor).is_none()
        {
            return Err(api.service.request_enrollment(&mut state, actor));
        }
    }
    Ok(())
}

async fn controller_for_digest(api: &Api, digest: &[u8; 32]) -> Option<ControllerEntry> {
    if let Some(caller) = api
        .controllers
        .iter()
        .find(|caller| bool::from(caller.digest().ct_eq(digest)))
    {
        return controller(api, &caller.controller.credential).cloned();
    }
    let key = api.t3_caller_key?;
    let state = api.service.state.lock().await;
    state
        .settings
        .projects
        .as_ref()?
        .projects
        .values()
        .flat_map(|project| &project.repositories)
        .flat_map(|repo| repo.planner_threads.iter().map(String::as_str))
        .map(|actor| ControllerEntry::t3(actor, key))
        .find(|caller| bool::from(caller.digest().ct_eq(digest)))
}

#[derive(Clone)]
struct SessionCredential {
    key: [u8; 32],
    controller: [u8; 32],
}

#[derive(Clone)]
struct TaskPath(String);

impl FromRequestParts<Api> for TaskPath {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, api: &Api) -> Result<Self, ApiError> {
        if let Some(task) = parts.extensions.get::<Self>() {
            return Ok(task.clone());
        }
        let Path(selector) = Path::<String>::from_request_parts(parts, api)
            .await
            .map_err(|_| ApiError::Invalid)?;
        if !selector.contains('#') {
            return Ok(Self(selector));
        }
        let scope = parts
            .extensions
            .get::<ControllerScope>()
            .ok_or(ApiError::Unauthorized)?;
        Ok(Self(
            api.service.resolve_task_reference(&selector, scope).await?,
        ))
    }
}

async fn authorize_task(
    State(api): State<Api>,
    Path(selector): Path<String>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let supplied = credential(request.headers())?;
    if let Some(caller) = request_controller(&api, &supplied, request.headers()) {
        reauthorize_known(&api, &caller.scope, request.method()).await?;
        caller.extend(&mut request);
        return Ok(next.run(request).await);
    }
    let access = if request.method() == Method::POST {
        SessionAccess::Write
    } else {
        SessionAccess::Read
    };
    let (id, digest) = api
        .service
        .acp_credential(&selector, &supplied, access)
        .await
        .ok_or(ApiError::Unauthorized)?;
    let scope = if matches!(access, SessionAccess::Write) {
        let caller = controller_for_digest(&api, &digest)
            .await
            .ok_or(ApiError::Unauthorized)?;
        caller.extend(&mut request);
        request.extensions_mut().insert(WriteAccess {
            credential: supplied,
            controller: digest,
        });
        caller.scope
    } else {
        // Pilot readers are task-scoped independently of the current
        // controller roster. Registry planner readers also carry project scope.
        let scope = if api.service.project.is_some() || digest == [0; 32] {
            ControllerScope::default()
        } else {
            controller_for_digest(&api, &digest)
                .await
                .ok_or(ApiError::Unauthorized)?
                .scope
        };
        request.extensions_mut().insert(scope.clone());
        request.extensions_mut().insert(SessionCredential {
            key: supplied,
            controller: digest,
        });
        scope
    };
    if selector.contains('#') {
        // A task session proves its bound ID. Resolve the selector in its
        // controller's scope before handing that ID to the route.
        let resolved = api
            .service
            .resolve_task_reference(&selector, &scope)
            .await
            .map_err(|_| ApiError::Unauthorized)?;
        if resolved != id {
            return Err(ApiError::Unauthorized);
        }
    }
    request.extensions_mut().insert(TaskPath(id));
    Ok(next.run(request).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindOptions {
    #[serde(default)]
    read_only: bool,
}

async fn bind_acp(
    State(api): State<Api>,
    TaskPath(id): TaskPath,
    Extension(ControllerDigest(controller)): Extension<ControllerDigest>,
    Extension(authority): Extension<Authority>,
    Extension(scope): Extension<ControllerScope>,
    Query(options): Query<BindOptions>,
) -> Result<Json<MintedSession>, ApiError> {
    Ok(Json(
        api.service
            .bind_acp(&id, controller, &authority, &scope, options.read_only)
            .await?,
    ))
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
    repository: Option<String>,
    id: String,
    reference: String,
    brief: String,
}

async fn admit(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    Extension(scope): Extension<ControllerScope>,
    input: Result<Json<Admission>, JsonRejection>,
) -> Result<(StatusCode, Json<Summary>), ApiError> {
    let input = body(input)?;
    let task = api
        .service
        .admit_in_scope(
            input.repository.as_deref(),
            input.id,
            input.reference,
            input.brief,
            &authority,
            &scope,
        )
        .await?;
    Ok((StatusCode::CREATED, Json(Summary::new(&task, None))))
}

async fn list(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
) -> Result<Json<Vec<Summary>>, ApiError> {
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
            .filter(|row| api.service.task_scope(row.task.identity()).is_ok())
            .filter(|row| scope.task(&state, row.task.identity()).is_ok())
            .map(|row| Summary::read(row, &state))
            .collect(),
    ))
}

async fn detail(
    State(api): State<Api>,
    TaskPath(id): TaskPath,
    Extension(scope): Extension<ControllerScope>,
) -> Result<Json<Detail>, ApiError> {
    let state = api.service.state.lock().await;
    let row = api.service.lookup(&state, &id)?;
    scope.task(&state, row.task.identity())?;
    let task = &row.task;
    let summary = Summary::read(&row, &state);
    let run = RunView::read(&row, state.activity.get(&id), &state.store);
    Ok(Json(Detail {
        summary,
        brief: task.brief().clone(),
        operator_inbox: api.service.uses_operator_inbox(),
        source: state.store.task_source(&id).map_err(ServiceError::from)?,
        pull_request: task.pull_request().cloned(),
        verdict: task.verdict().cloned(),
        run,
    }))
}

async fn next(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    Extension(scope): Extension<ControllerScope>,
    TaskPath(id): TaskPath,
) -> Result<Json<NextView>, ApiError> {
    let state = api.service.state.lock().await;
    let row = api.service.lookup(&state, &id)?;
    scope.task(&state, row.task.identity())?;
    let task = &row.task;
    let summary = Summary::read(&row, &state);
    Ok(Json(NextView {
        version: row.version,
        phase: summary.phase,
        wait: summary.wait,
        next_check_at: summary.next_check_at,
        question: summary.question,
        commands: command_options(
            task,
            &authority,
            &state.command_observation(&row),
            &state,
            api.service.uses_operator_inbox(),
        ),
    }))
}

fn command_options(
    task: &Task,
    authority: &Authority,
    observation: &Observation,
    state: &EngineState,
    inbox_enabled: bool,
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
    if let Some(question) = task.question()
        && task.operator_decline().is_none()
        && !(inbox_enabled && task.operator_question().is_some())
    {
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
    let check = |command| match state.preflight(&mut task.clone(), authority, observation, command)
    {
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

async fn command(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    Extension(scope): Extension<ControllerScope>,
    TaskPath(id): TaskPath,
    session: Option<Extension<WriteAccess>>,
    input: Result<Json<Command>, JsonRejection>,
) -> Result<Response, ApiError> {
    let command = body(input)?;
    let outcome = api
        .service
        .command_with_session(&id, &authority, command, session.as_deref(), &scope)
        .await?;
    match outcome {
        CommandOutcome::Applied(row) => Ok(Json(Summary::new(&row, None)).into_response()),
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
    TaskPath(id): TaskPath,
    Extension(scope): Extension<ControllerScope>,
    Query(page): Query<Page>,
) -> Result<Json<Vec<HistoryEvent>>, ApiError> {
    Ok(Json(
        api.service
            .history_in_scope(&id, page.before, page.limit.unwrap_or(30), &scope)
            .await?
            .into_iter()
            .map(HistoryEvent::from)
            .collect(),
    ))
}

async fn events(
    State(api): State<Api>,
    Extension(project): Extension<ControllerScope>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    invalidations(api.service, None, project)
}

async fn task_events(
    State(api): State<Api>,
    TaskPath(id): TaskPath,
    Extension(project): Extension<ControllerScope>,
    credential: Option<Extension<SessionCredential>>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    {
        let state = api.service.state.lock().await;
        let row = api.service.lookup(&state, &id)?;
        project.task(&state, row.task.identity())?;
    }
    Ok(invalidations(
        api.service,
        Some((id, credential.map(|Extension(key)| key))),
        project,
    ))
}

async fn task_visible(service: &Service, project: &ControllerScope, task: &str) -> bool {
    if project.0.is_none() {
        return true;
    }
    let state = service.state.lock().await;
    service
        .lookup(&state, task)
        .is_ok_and(|row| project.task(&state, row.task.identity()).is_ok())
}

fn invalidations(
    service: Arc<Service>,
    scope: Option<(String, Option<SessionCredential>)>,
    project: ControllerScope,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    Sse::new(invalidation_events(service, scope, project)).keep_alive(KeepAlive::default())
}

fn invalidation_events(
    service: Arc<Service>,
    scope: Option<(String, Option<SessionCredential>)>,
    project: ControllerScope,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let projects = service.project_changes.subscribe();
    stream::unfold(
        (service.changes(), projects, service, scope, project, true),
        |(mut receiver, mut projects, service, scope, project, first)| async move {
            let event = if first {
                Event::default().event("refresh").data("{}")
            } else {
                loop {
                    let change = tokio::select! {
                        result = receiver.recv() => result,
                        Ok(()) = projects.changed() => break Event::default().event("refresh").data("{}"),
                    };
                    match change {
                        Ok(change)
                            if scope
                                .as_ref()
                                .is_none_or(|(task, _)| *task == change.task_id)
                                && task_visible(&service, &project, &change.task_id).await =>
                        {
                            break Event::default()
                                .event("invalidate")
                                .json_data(change)
                                .ok()?;
                        }
                        Ok(_) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            break Event::default().event("refresh").data("{}");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                    }
                }
            };
            if let Some((id, credential)) = &scope {
                if !task_visible(&service, &project, id).await {
                    return None;
                }
                if let Some(credential) = credential
                    && service.acp_reader(id, &credential.key).await != Some(credential.controller)
                {
                    return None;
                }
            }
            Some((
                Ok(event),
                (receiver, projects, service, scope, project, false),
            ))
        },
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    identity: Identity,
    title: String,
    number: Option<i64>,
    reference: String,
    version: i64,
    phase: Phase,
    wait: Option<WaitReason>,
    next_check_at: Option<u64>,
    question: Option<Question>,
    hold: Option<Hold>,
}

impl Summary {
    fn read(row: &nucleus_store::TaskRow, state: &EngineState) -> Self {
        let task = &row.task;
        let id = &task.identity().id;
        let mut view = Self::new(row, state.waits.get(id).map(|(reason, _)| *reason));
        if view.wait.is_some() && task.operator_decline().is_none() {
            view.next_check_at = state.schedule.due(id).map(|due| {
                let delay = due.saturating_duration_since(tokio::time::Instant::now());
                now_ms().saturating_add(u64::try_from(delay.as_millis()).unwrap_or(u64::MAX))
            });
        }
        view
    }

    fn new(row: &nucleus_store::TaskRow, wait: Option<WaitReason>) -> Self {
        let task = &row.task;
        Self {
            identity: task.identity().clone(),
            title: crate::titles::brief(task),
            number: row.number,
            reference: row.reference().into_owned(),
            version: row.version,
            phase: task.phase(),
            next_check_at: None,
            wait: if task.run().is_some_and(nucleus_core::Run::revoked) {
                Some(WaitReason::Stopping)
            } else if task.phase() == Phase::Done {
                None
            } else if task.hold().is_some() {
                Some(WaitReason::Hold)
            } else if task.operator_decline().is_some() {
                Some(WaitReason::OperatorDeclined)
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
    operator_inbox: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<nucleus_store::planning::ItemSource>,
    pull_request: Option<PullRequest>,
    verdict: Option<Verdict>,
    run: Option<RunView>,
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
    SettingsOperator,
    BoardUnavailable,
    BoardOperator,
    Service(ServiceError),
}

impl From<ServiceError> for ApiError {
    fn from(error: ServiceError) -> Self {
        Self::Service(error)
    }
}

impl From<nucleus_store::StorageError> for ApiError {
    fn from(error: nucleus_store::StorageError) -> Self {
        ServiceError::from(error).into()
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
            Self::SettingsOperator => (
                StatusCode::FORBIDDEN,
                "settings writes require an operator".into(),
            ),
            Self::BoardUnavailable => (StatusCode::SERVICE_UNAVAILABLE, "board unavailable".into()),
            Self::BoardOperator => (
                StatusCode::FORBIDDEN,
                "revoking board sessions requires an operator".into(),
            ),
            Self::Service(error) => {
                let status = match error {
                    ServiceError::Missing
                    | ServiceError::TaskReferenceMissing
                    | ServiceError::Store(nucleus_store::StoreError::PlanningMissing) => {
                        StatusCode::NOT_FOUND
                    }
                    ServiceError::Input
                    | ServiceError::TaskReferenceAmbiguous
                    | ServiceError::TaskReferenceNeedsRepository
                    | ServiceError::Store(nucleus_store::StoreError::PlanningInput)
                    | ServiceError::Project
                    | ServiceError::Settings(
                        nucleus_store::StorageError::InvalidSettings(_)
                        | nucleus_store::StorageError::MissingVolume
                        | nucleus_store::StorageError::BargePlacement { .. }
                        | nucleus_store::StorageError::OutsideVolume
                        | nucleus_store::StorageError::Layout
                        | nucleus_store::StorageError::ConfinedDirectory(_),
                    ) => StatusCode::BAD_REQUEST,
                    ServiceError::QuestionPlanner
                    | ServiceError::ControllerProject
                    | ServiceError::PlannerEnrollmentRefused(_)
                    | ServiceError::PlannerAuthorityRefused
                    | ServiceError::AnswerInInbox
                    | ServiceError::DecisionOperator => StatusCode::FORBIDDEN,
                    ServiceError::AcpUnauthorized => StatusCode::UNAUTHORIZED,
                    ServiceError::Settings(nucleus_store::StorageError::SettingsConflict)
                    | ServiceError::Core(_)
                    | ServiceError::EffectInProgress
                    | ServiceError::Store(
                        nucleus_store::StoreError::StaleTask
                        | nucleus_store::StoreError::NumbersNeedSeed
                        | nucleus_store::StoreError::PlanningConflict,
                    ) => StatusCode::CONFLICT,
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
