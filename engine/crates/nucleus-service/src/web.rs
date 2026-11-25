use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{
        DefaultBodyLimit, FromRequest, FromRequestParts, Path, Query, Request, State,
        rejection::JsonRejection,
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
    routing::{get, post, put},
};
use futures_util::{Stream, TryStreamExt, stream};
use nucleus_core::{
    Answer, Authority, Brief, Command, Hold, Identity, Observation, Phase, PullRequest, Question,
    Report, ReportAcceptance, ReportDelivery, ReportTask, Task, Verdict, WaitReason,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{
    CommandOutcome, DependencyCommand, DependencyEdits, DependencyStatus, MAX_BRIEF_BYTES,
    Preflight, Service, ServiceError, State as EngineState,
    acp::{MintedSession, SessionAccess, WriteAccess},
    now_ms,
    presentation::{HistoryEvent, RunView},
};

mod board;
mod github_accounts;
mod inbox;
mod planning;
mod settings;
pub(crate) use board::Board;
pub use board::{router_with_board, router_with_board_and_t3_callers};
pub(crate) use settings::{CachedHost, ProjectMatchError, RuntimeSettings};

const DEFAULT_BODY_LIMIT: usize = 64 * 1024;
// A JSON escape can use six bytes for one brief byte. The ordinary limit covers metadata.
const BRIEF_BODY_LIMIT: usize = 6 * MAX_BRIEF_BYTES + DEFAULT_BODY_LIMIT;

#[cfg(test)]
pub(crate) mod tests;

#[derive(Clone)]
struct Api {
    finished_cards: Arc<tokio::sync::Mutex<HashMap<String, FinishedCard>>>,
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
#[serde(transparent)]
pub(crate) struct ControllerScope {
    actor: Option<String>,
    #[serde(skip)]
    enrollment_deadline: Option<tokio::time::Instant>,
}

impl ControllerScope {
    fn for_request(mut self) -> Self {
        self.enrollment_deadline =
            Some(tokio::time::Instant::now() + std::time::Duration::from_secs(3));
        self
    }

    /// Recheck admission after the exact proof finishes. Each check releases its locks before waiting.
    pub(super) async fn with_enrollment<T, F: Future<Output = Result<T, ServiceError>>>(
        &self,
        mut check: impl FnMut() -> F,
    ) -> Result<T, ServiceError> {
        let Some(deadline) = self.enrollment_deadline else {
            return check().await;
        };
        loop {
            let mut finished = match check().await {
                Err(ServiceError::PlannerEnrollmentPending(receiver)) => receiver,
                result => return result,
            };
            // The last sender drops when the worker publishes the result or the binding is invalidated.
            if tokio::time::Instant::now() >= deadline
                || tokio::time::timeout_at(deadline, finished.changed())
                    .await
                    .is_err()
            {
                return Err(ServiceError::PlannerEnrollmentPending(finished));
            }
        }
    }

    pub(crate) fn actor(&self) -> Option<&str> {
        self.actor.as_deref()
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
        if self.actor.is_some() {
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
            scope: ControllerScope {
                actor: Some(actor.into()),
                ..Default::default()
            }
            .for_request(),
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
        finished_cards: Arc::default(),
        service,
        controllers: carriers,
        t3_caller_key,
    };
    let controller = Router::new()
        .route("/v1/tasks", get(list).post(admit))
        .route("/v1/tasks/{id}/acp", post(bind_acp))
        .route("/v1/tasks/{id}/acp/refresh", post(refresh_acp))
        .route("/v1/tasks/{id}/next", get(next))
        .route("/v1/health", get(settings::health))
        .route("/v1/settings", get(settings::all))
        .merge(github_accounts::routes("/v1/settings/github-accounts"))
        .route(
            "/v1/settings/{domain}",
            get(settings::get).put(settings::put),
        )
        .route(
            "/v1/settings/projects/{project}/clear-planner",
            post(settings::clear_planner),
        )
        .route("/v1/settings/projects/reassign", post(settings::reassign))
        .route(
            "/v1/settings/projects/{project}/removal",
            get(settings::preview_project_removal).post(settings::remove_project),
        )
        .route(
            "/v1/settings/profiles/pauses/{group}",
            put(settings::pause_group),
        )
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
        .route("/v1/planning/claim", post(claim_planner))
        .route("/v1/planning/tell", post(tell))
        .merge(inbox::routes())
        .merge(planning::report_lane_routes())
        .route("/v1/runs/{task}/{instance}/report", post(report));
    if let Some(board) = board {
        routes = routes.merge(board.routes(&api));
    }
    routes
        .layer(DefaultBodyLimit::max(DEFAULT_BODY_LIMIT))
        .layer(middleware::from_fn_with_state(
            api.clone(),
            authorize_address,
        ))
        .with_state(api)
}

async fn claim_planner(
    State(api): State<Api>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let supplied = credential(&headers)?;
    let caller = request_controller(&api, &supplied, &headers).ok_or(ApiError::Unauthorized)?;
    tokio::spawn(async move { api.service.claim_planner(&caller.scope).await })
        .await
        .map_err(|_| ServiceError::Input)??;
    Ok(Json(json!({"claimed": true})))
}

async fn tell(
    State(api): State<Api>,
    headers: HeaderMap,
    input: Result<Json<crate::tell::TellRequest>, JsonRejection>,
) -> Result<Json<crate::tell::TellResponse>, ApiError> {
    let supplied = credential(&headers)?;
    let caller = request_controller(&api, &supplied, &headers).ok_or(ApiError::Unauthorized)?;
    let input = body(input)?;
    Ok(Json(api.service.tell(&caller.scope, &input).await?))
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
    reauthorize_known(&api, &caller.scope).await?;
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

async fn reauthorize_known(api: &Api, scope: &ControllerScope) -> Result<(), ServiceError> {
    let Some(actor) = scope.actor() else {
        return Ok(());
    };
    {
        let state = api.service.state.lock().await;
        if state.live_planner_project(actor).is_some()
            || state.settings.planner_route(actor).is_none()
        {
            return Ok(());
        }
    }
    scope
        .with_enrollment(|| async {
            let mut state = api.service.state.lock().await;
            api.service
                .planning_planner_project(&mut state, actor, None)
                .map(|_| ())
        })
        .await
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
        reauthorize_known(&api, &caller.scope).await?;
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

async fn refresh_acp(
    State(api): State<Api>,
    TaskPath(id): TaskPath,
    Extension(authority): Extension<Authority>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !matches!(authority, Authority::Operator { .. }) {
        return Err(ApiError::Unauthorized);
    }
    Ok(Json(
        json!({"queued":api.service.queue_acp_refresh(&id).await?}),
    ))
}

fn run_api_error(error: ServiceError) -> ApiError {
    match error {
        ServiceError::Missing
        | ServiceError::Project
        | ServiceError::Core(nucleus_core::CommandError::InvalidReportCredential) => {
            ApiError::Unauthorized
        }
        error => error.into(),
    }
}

async fn report(
    State(api): State<Api>,
    Path((task, instance)): Path<(String, String)>,
    headers: HeaderMap,
    report: Result<Json<Report>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let credential = credential(&headers)?;
    let report = body(report)?;
    api.service
        .report(&task, &instance, &credential, report)
        .await
        .map_err(run_api_error)?;
    Ok(StatusCode::NO_CONTENT)
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
    request: Request,
) -> Result<(StatusCode, Json<Summary>), ApiError> {
    let input: Admission = brief_json(request, &api).await?;
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
    Ok((
        StatusCode::CREATED,
        Json(summary_after(&api.service, &task, &scope, &authority).await?),
    ))
}

async fn list(
    State(api): State<Api>,
    Extension(scope): Extension<ControllerScope>,
    Extension(authority): Extension<Authority>,
) -> Result<Json<Vec<Summary<Arc<Card>>>>, ApiError> {
    api.service
        .storage
        .database()
        .verify()
        .map_err(ServiceError::from)?;
    let state = api.service.state.lock().await;
    let tasks = state.store.list().map_err(ServiceError::from)?;
    let revisions = state
        .store
        .finished_card_revisions()
        .map_err(ServiceError::from)?;
    let by_id = tasks
        .iter()
        .map(|row| (row.task.identity().id.as_str(), row))
        .collect();
    let mut cache = api.finished_cards.lock().await;
    cache.retain(|id, _| revisions.contains_key(id));
    let mut result = Vec::new();
    for row in &tasks {
        let identity = row.task.identity();
        if api.service.task_scope(identity).is_err() || scope.task(&state, identity).is_err() {
            continue;
        }
        let id = identity.id.as_str();
        if let Some(&revision) = revisions.get(id)
            && state.wait_detail(id).is_none()
            && state.wait_reason(id).is_none()
        {
            let entry = match cache.entry(identity.id.clone()) {
                std::collections::hash_map::Entry::Occupied(entry)
                    if entry.get().revision == revision
                        && entry.get().card.version == row.version =>
                {
                    entry.into_mut()
                }
                entry => entry
                    .insert_entry(FinishedCard {
                        revision,
                        card: Arc::new(Card::read(row, &state, false, None)?),
                        dependencies: state.store.dependencies(id).map_err(ServiceError::from)?,
                    })
                    .into_mut(),
            };
            result.push(Summary {
                card: Arc::clone(&entry.card),
                dependency_status: DependencyStatus::finished(
                    &state,
                    &scope,
                    &entry.dependencies,
                    &by_id,
                )?,
                dependency_edits: DependencyEdits::unavailable(),
            });
        } else {
            let summary = Summary::read(row, &state, &scope, Some(&authority), None)?;
            result.push(Summary {
                card: Arc::new(summary.card),
                dependency_status: summary.dependency_status,
                dependency_edits: summary.dependency_edits,
            });
        }
    }
    Ok(Json(result))
}

async fn detail(
    State(api): State<Api>,
    TaskPath(id): TaskPath,
    Extension(scope): Extension<ControllerScope>,
    authority: Option<Extension<Authority>>,
    credential: Option<Extension<SessionCredential>>,
) -> Result<Json<Detail>, ApiError> {
    let state = api.service.state.lock().await;
    let row = api.service.lookup(&state, &id)?;
    scope.task(&state, row.task.identity())?;
    let task = &row.task;
    let activity = state.activity.get(&id);
    let transcript = credential
        .as_ref()
        .map(|_| crate::presentation::TranscriptRequest {
            activity: crate::presentation::run_activity(&row, activity)
                .map(|activity| activity.label.as_str()),
        });
    let summary = Summary::read(&row, &state, &scope, authority.as_deref(), transcript)?;
    let run = RunView::read(&row, activity, summary.card.lifecycle.review_round);
    let (parent_hold, active_child) = if credential.is_some() {
        api.service.acp_turn_view(&state, &row)?
    } else {
        (None, false)
    };
    // The native host supports a plan that is updated across role turns.
    let plan_scope_id =
        (credential.is_some() && api.service.acp_provider().is_some()).then_some("task-lifecycle");
    Ok(Json(Detail {
        created_at_ms: summary.card.created_at_ms,
        summary,
        brief: task.brief().clone(),
        operator_inbox: api.service.uses_operator_inbox(),
        plan_scope_id,
        parent_hold,
        active_child,
        source: state.store.task_source(&id).map_err(ServiceError::from)?,
        pull_request: task.pull_request().cloned(),
        verdict: task.verdict().cloned(),
        report: task.report_task().map(ReportView::from),
        critical_review_fallbacks: state
            .store
            .critical_review_fallbacks(&id)
            .map_err(ServiceError::from)?,
        allowance: state.allowance_view(task).map_err(ServiceError::from)?,
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
    let summary = Summary::read(&row, &state, &scope, Some(&authority), None)?;
    let dependency_edits = summary.dependency_edits;
    let mut commands = command_options(
        task,
        &authority,
        &state.command_observation(&row),
        &state,
        api.service.uses_operator_inbox(),
    );
    for (name, available) in [
        ("set_dependencies", dependency_edits.set_dependencies),
        (
            "set_prerequisite_wait",
            dependency_edits.set_prerequisite_wait,
        ),
    ] {
        commands.push(CommandView {
            name,
            preflight: if available {
                CommandReadiness::Ready
            } else {
                CommandReadiness::Unavailable
            },
            phase: None,
        });
    }
    if summary.dependency_status.blocking {
        for command in &mut commands {
            if command.name == "complete"
                || matches!(
                    command.phase,
                    Some(Phase::Merging | Phase::Closing | Phase::Done)
                )
            {
                command.preflight = CommandReadiness::Unavailable;
            }
        }
    }
    Ok(Json(NextView {
        version: row.version,
        phase: summary.card.phase,
        state_label: summary.card.state_label,
        state_since_ms: summary.card.state_since_ms,
        wait: summary.card.wait,
        wait_detail: summary.card.wait_detail,
        attention: summary.card.attention,
        next_check_at: summary.card.next_check_at,
        answer_form: task
            .question()
            .filter(|_| commands.iter().any(|command| command.name == "answer"))
            .map(Question::answer_form),
        question: summary.card.question,
        critical_review_fallbacks: state
            .store
            .critical_review_fallbacks(&id)
            .map_err(ServiceError::from)?,
        allowance: state.allowance_view(task).map_err(ServiceError::from)?,
        dependency_status: summary.dependency_status,
        dependency_edits,
        commands,
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
            Question::Work { .. } | Question::Repair(_) => Answer::Work("Continue work".into()),
            Question::Retry { .. } => Answer::Retry,
            Question::Allowance { .. } => Answer::Extend,
            Question::Accept { head } => Answer::Accept {
                head: head.clone(),
                reason: "Accept verified source".into(),
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
    if matches!(
        task.phase(),
        Phase::ReportReady | Phase::Blocked | Phase::Error
    ) {
        commands.push((
            "move_work",
            Command::MoveWork {
                instruction: "Return report to work".into(),
            },
        ));
    }
    if task.phase() == Phase::ReportReady
        && let Some(delivery) = task
            .report_task()
            .and_then(|report| report.delivery.as_ref())
    {
        // The real command rechecks the caller's version, forge and participant custody.
        commands.push((
            "complete",
            Command::Complete {
                version: 0,
                artifact: delivery.artifact.clone(),
                reason: "Accept report".into(),
            },
        ));
    }
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
            preflight: check(if phase == Phase::Working && task.report_task().is_none() {
                Command::MoveWork {
                    instruction: "Continue work".into(),
                }
            } else {
                Command::Move(phase)
            }),
            phase: Some(phase),
        })
        .chain(commands.into_iter().map(|(name, command)| CommandView {
            name,
            preflight: match check(command) {
                CommandReadiness::Ready if name == "complete" => CommandReadiness::Pending,
                availability => availability,
            },
            phase: None,
        }))
        .collect()
}

#[derive(Deserialize)]
#[serde(untagged)]
enum TaskCommand {
    Lifecycle(Command),
    Dependency(DependencyCommand),
}

async fn command(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    Extension(scope): Extension<ControllerScope>,
    TaskPath(id): TaskPath,
    session: Option<Extension<WriteAccess>>,
    mut request: Request,
) -> Result<Response, ApiError> {
    // Measure the raw body, including JSON escapes and whitespace, during the same extraction.
    let size = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&size);
    let incoming = std::mem::take(request.body_mut());
    *request.body_mut() = Body::from_stream(incoming.into_data_stream().inspect_ok(move |chunk| {
        counted.fetch_add(chunk.len(), Ordering::Relaxed);
    }));
    let input: TaskCommand = brief_json(request, &api).await?;
    if size.load(Ordering::Relaxed) > DEFAULT_BODY_LIMIT
        && !matches!(&input, TaskCommand::Lifecycle(Command::Amend(_)))
    {
        return Err(ApiError::Invalid);
    }
    let outcome = match input {
        TaskCommand::Lifecycle(command) => {
            api.service
                .command_with_session(&id, &authority, command, session.as_deref(), &scope)
                .await?
        }
        TaskCommand::Dependency(command) => CommandOutcome::Applied(Box::new(
            api.service
                .command_dependencies_in_scope(&id, &authority, command, session.as_deref(), &scope)
                .await?,
        )),
    };
    match outcome {
        CommandOutcome::Applied(row) => {
            Ok(Json(summary_after(&api.service, &row, &scope, &authority).await?).into_response())
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
    if project.actor().is_none() {
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

async fn acp_hold_expiry(service: &Service, scope: Option<&(String, Option<SessionCredential>)>) {
    if let Some((id, Some(_))) = scope {
        let state = service.state.lock().await;
        let deadline = service.lookup(&state, id).ok().and_then(|row| {
            (state.role_observation(&row.task) != Some(nucleus_core::RunState::Running))
                .then(|| crate::acp::run_hold_deadline(&row))
                .flatten()
        });
        drop(state);
        if let Some(delay) = deadline
            .and_then(|until| until.checked_sub(now_ms()))
            .filter(|&delay| delay > 0)
        {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            return;
        }
    }
    std::future::pending::<()>().await;
}

fn invalidation_events(
    service: Arc<Service>,
    scope: Option<(String, Option<SessionCredential>)>,
    project: ControllerScope,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let projects = service.project_changes.subscribe();
    let settings = service.settings_changes.subscribe();
    stream::unfold(
        (
            service.changes(),
            projects,
            settings,
            service,
            scope,
            project,
            true,
        ),
        |(mut receiver, mut projects, mut settings, service, scope, project, first)| async move {
            let event = if first {
                Event::default().event("refresh").data("{}")
            } else {
                loop {
                    let change = tokio::select! {
                        result = receiver.recv() => result,
                        () = acp_hold_expiry(&service, scope.as_ref()) => break Event::default().event("refresh").data("{}"),
                        Ok(()) = projects.changed() => break Event::default().event("refresh").data("{}"),
                        Ok(()) = settings.changed(), if scope.is_some() => {
                            break Event::default().event("refresh").data("{}");
                        }
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
                (receiver, projects, settings, service, scope, project, false),
            ))
        },
    )
}

async fn summary_after(
    service: &Service,
    row: &nucleus_store::TaskRow,
    scope: &ControllerScope,
    authority: &Authority,
) -> Result<Summary, ServiceError> {
    let state = service.state.lock().await;
    let row = service.lookup(&state, &row.task.identity().id)?;
    scope.task(&state, row.task.identity())?;
    Summary::read(&row, &state, scope, Some(authority), None)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary<C = Card> {
    #[serde(flatten)]
    card: C,
    dependency_status: DependencyStatus,
    dependency_edits: DependencyEdits,
}

struct FinishedCard {
    revision: (i64, Option<i64>),
    card: Arc<Card>,
    dependencies: nucleus_store::Dependencies,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Card {
    identity: Identity,
    title: String,
    number: Option<i64>,
    reference: String,
    version: i64,
    phase: Phase,
    state_label: String,
    state_since_ms: Option<u64>,
    latest_event_at_ms: Option<u64>,
    #[serde(skip)]
    created_at_ms: Option<u64>,
    wait: Option<WaitReason>,
    wait_detail: Option<String>,
    attention: crate::attention::TaskAttention,
    lifecycle: nucleus_core::acp::lifecycle::Lifecycle,
    next_check_at: Option<u64>,
    question: Option<Question>,
    hold: Option<Hold>,
}

impl Summary {
    fn read(
        row: &nucleus_store::TaskRow,
        state: &EngineState,
        scope: &ControllerScope,
        authority: Option<&Authority>,
        transcript: Option<crate::presentation::TranscriptRequest<'_>>,
    ) -> Result<Self, ServiceError> {
        let dependency_status = DependencyStatus::read(state, row, scope)?;
        let dependency_edits =
            DependencyEdits::read(state, &row.task, authority, &dependency_status);
        Ok(Self {
            card: Card::read(row, state, dependency_status.blocking, transcript)?,
            dependency_status,
            dependency_edits,
        })
    }
}

impl Card {
    fn read(
        row: &nucleus_store::TaskRow,
        state: &EngineState,
        dependencies_block: bool,
        transcript: Option<crate::presentation::TranscriptRequest<'_>>,
    ) -> Result<Self, ServiceError> {
        let task = &row.task;
        let id = &task.identity().id;
        let wait = state.wait_reason(id);
        let wait = if dependencies_block && task.run().is_none() {
            Some(WaitReason::Prerequisite)
        } else {
            wait.filter(|wait| *wait != WaitReason::Prerequisite || dependencies_block)
        };
        let times = state.store.board_times(id)?;
        let created_at_ms = times.admitted;
        let fixed = crate::titles::task_label_from_facts(task);
        let state_since_ms = times
            .since
            .filter(|_| fixed.is_some() || state.waits.get(id).is_some_and(|wait| wait.timed));
        let state_label = match fixed {
            Some(label) => label,
            None => crate::titles::task_state_label(
                task,
                state.effective_wait(task)?,
                state.wait_detail(id),
            ),
        };
        let archive_detail = match state.wait_detail(id) {
            Some(crate::WaitDetail::Archive(message)) if task.phase() == Phase::Done => {
                Some(message.as_str())
            }
            _ => None,
        };
        let wait = match wait {
            _ if archive_detail.is_some() => Some(WaitReason::Stopping),
            Some(WaitReason::ExternalMergeBlocked) if task.hold().is_none() => wait,
            Some(WaitReason::WorkspaceUnknown | WaitReason::WorkspaceBlocked) => wait,
            Some(WaitReason::HostObservationBlocked) if !task.phase().is_terminal() => wait,
            _ if task.run().is_some_and(nucleus_core::Run::revoked) => Some(WaitReason::Stopping),
            _ if task.phase() == Phase::Done => None,
            _ if task.hold().is_some() => Some(WaitReason::Hold),
            _ if task.operator_decline().is_some() => Some(WaitReason::OperatorDeclined),
            _ if task.question().is_some() => Some(WaitReason::Question),
            _ => wait,
        };
        let wait_detail = archive_detail.or_else(|| {
            if wait != state.wait_reason(id)
                || task.hold().is_some()
                || (task.question().is_some() && wait != Some(WaitReason::ExternalMergeBlocked))
            {
                return None;
            }
            match state.wait_detail(id)? {
                crate::WaitDetail::BeforeSend(message) => *message,
                crate::WaitDetail::ConfirmingDelivery(message)
                | crate::WaitDetail::Observation(message) => Some(*message),
                crate::WaitDetail::OperatorSnoozed { message, .. }
                | crate::WaitDetail::Blocked(message) => Some(message.as_str()),
                crate::WaitDetail::Archive(_) => None,
            }
        });
        let next_check_at = state
            .schedule
            .due(id)
            .filter(|_| wait.is_some() && task.operator_decline().is_none())
            .map(|due| {
                let delay = due.saturating_duration_since(tokio::time::Instant::now());
                now_ms().saturating_add(u64::try_from(delay.as_millis()).unwrap_or(u64::MAX))
            });
        Ok(Self {
            identity: task.identity().clone(),
            title: crate::titles::brief(task),
            number: row.number,
            reference: row.reference().into_owned(),
            version: row.version,
            phase: task.phase(),
            attention: state.task_attention(row)?,
            lifecycle: crate::presentation::task_lifecycle(
                task,
                &state.store,
                wait_detail.unwrap_or(&state_label),
                wait,
                created_at_ms,
                transcript,
            )?,
            state_label,
            state_since_ms,
            latest_event_at_ms: times.latest_event,
            created_at_ms,
            next_check_at,
            wait,
            wait_detail: wait_detail.map(str::to_owned),
            question: task.question().cloned(),
            hold: task.hold().cloned(),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Detail {
    #[serde(flatten)]
    summary: Summary,
    created_at_ms: Option<u64>,
    brief: Brief,
    operator_inbox: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    plan_scope_id: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_hold: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    active_child: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<nucleus_store::planning::ItemSource>,
    pull_request: Option<PullRequest>,
    verdict: Option<Verdict>,
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<ReportView>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    critical_review_fallbacks: Vec<nucleus_store::CriticalReviewFallback>,
    allowance: nucleus_store::AllowanceView,
    run: Option<RunView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportView {
    project: String,
    lane: String,
    planning_base: nucleus_core::Head,
    delivery: Option<ReportDelivery>,
    failure: Option<String>,
    acceptance: Option<ReportAcceptance>,
}

impl From<&ReportTask> for ReportView {
    fn from(report: &ReportTask) -> Self {
        Self {
            project: report.project.clone(),
            lane: report.lane.clone(),
            planning_base: report.planning_base.clone(),
            delivery: report.delivery.clone(),
            failure: report.failure.clone(),
            acceptance: report.acceptance.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NextView {
    version: i64,
    phase: Phase,
    state_label: String,
    state_since_ms: Option<u64>,
    wait: Option<WaitReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wait_detail: Option<String>,
    attention: crate::attention::TaskAttention,
    next_check_at: Option<u64>,
    question: Option<Question>,
    #[serde(skip_serializing_if = "Option::is_none")]
    answer_form: Option<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    critical_review_fallbacks: Vec<nucleus_store::CriticalReviewFallback>,
    dependency_status: DependencyStatus,
    dependency_edits: DependencyEdits,
    allowance: nucleus_store::AllowanceView,
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
    BriefBodyTooLarge,
    SettingsOperator,
    GitHubAccountsOperator,
    ProjectOpenTasks,
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
            Self::BriefBodyTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("request exceeds the {BRIEF_BODY_LIMIT}-byte brief JSON body limit"),
            ),
            Self::SettingsOperator => (
                StatusCode::FORBIDDEN,
                "settings writes require an operator".into(),
            ),
            Self::GitHubAccountsOperator => (
                StatusCode::FORBIDDEN,
                "GitHub account settings require an operator".into(),
            ),
            Self::ProjectOpenTasks => (
                StatusCode::CONFLICT,
                "Finish or cancel the project's open tasks before removing it.".into(),
            ),
            Self::BoardUnavailable => (StatusCode::SERVICE_UNAVAILABLE, "board unavailable".into()),
            Self::BoardOperator => (
                StatusCode::FORBIDDEN,
                "revoking board sessions requires an operator".into(),
            ),
            Self::Service(error) => {
                let status = match error {
                    ServiceError::Missing
                    | ServiceError::TellUnknownProject(_)
                    | ServiceError::TaskReferenceMissing
                    | ServiceError::Store(nucleus_store::StoreError::PlanningMissing) => {
                        StatusCode::NOT_FOUND
                    }
                    ServiceError::Input
                    | ServiceError::TellReply
                    | ServiceError::TellInput
                    | ServiceError::TellAmbiguousProject(_)
                    | ServiceError::TellArchivedProject(_)
                    | ServiceError::ReportInput(_)
                    | ServiceError::ComplexityRequired
                    | ServiceError::LeadComplexity
                    | ServiceError::BriefTooLarge { .. }
                    | ServiceError::BriefPolicy(_)
                    | ServiceError::DependencyInput(_)
                    | ServiceError::TaskReferenceAmbiguous
                    | ServiceError::TaskReferenceNeedsRepository
                    | ServiceError::Store(
                        nucleus_store::StoreError::PlanningInput
                        | nucleus_store::StoreError::DuplicateDecisionOptionLabel,
                    )
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
                    | ServiceError::TellPlannerRequired
                    | ServiceError::ControllerProject
                    | ServiceError::PlannerEnrollmentRefused(_)
                    | ServiceError::PlannerAuthorityRefused
                    | ServiceError::AnswerInInbox
                    | ServiceError::DecisionOperator => StatusCode::FORBIDDEN,
                    ServiceError::AcpUnauthorized => StatusCode::UNAUTHORIZED,
                    ServiceError::Store(nucleus_store::StoreError::TellRateLimit(_)) => {
                        StatusCode::TOO_MANY_REQUESTS
                    }
                    ServiceError::Settings(nucleus_store::StorageError::SettingsConflict)
                    | ServiceError::Core(_)
                    | ServiceError::EffectInProgress
                    | ServiceError::ReportOpenPullRequest
                    | ServiceError::ReportWorkerBusy
                    | ServiceError::DependencyEdit(_)
                    | ServiceError::Store(
                        nucleus_store::StoreError::StaleTask
                        | nucleus_store::StoreError::DependencyCycle
                        | nucleus_store::StoreError::AllowanceNotExhausted
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

async fn brief_json<T: serde::de::DeserializeOwned>(
    mut request: Request,
    api: &Api,
) -> Result<T, ApiError> {
    DefaultBodyLimit::max(BRIEF_BODY_LIMIT).apply(&mut request);
    let input = Json::<T>::from_request(request, api).await;
    if input
        .as_ref()
        .is_err_and(|error| error.status() == StatusCode::PAYLOAD_TOO_LARGE)
    {
        return Err(ApiError::BriefBodyTooLarge);
    }
    body(input)
}
