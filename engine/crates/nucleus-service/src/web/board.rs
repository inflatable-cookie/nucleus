mod sessions;

use std::{
    collections::HashMap,
    convert::Infallible,
    fs, io,
    net::SocketAddr,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{Request, State},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, COOKIE, SET_COOKIE},
    },
    middleware::{self, Next},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use futures_util::{Stream, StreamExt, stream};
use nucleus_core::Authority;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    sync::watch,
    time::{Instant, sleep_until},
};

use super::{
    Api, ApiError, Controller, ControllerScope, authorize, credential, invalidation_events, routes,
    settings,
};
use crate::{Service, now_ms};
use sessions::{IDLE, SessionStore};

const COOKIE_NAME: &str = "nucleus_engine_board";
const COOKIE_SCOPE: &str = "/api/engine";
const LINK_TTL: Duration = Duration::from_mins(2);
const MAX_GRANTS: usize = 64;
const PAGE_POLICY: HeaderValue = HeaderValue::from_static(
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
);

/// Serve the local board and its paired browser API beside the controller API.
///
/// # Errors
/// Returns an error if the built HTML or JavaScript cannot be read.
pub fn router_with_board(
    service: Arc<Service>,
    controllers: impl IntoIterator<Item = Controller>,
    assets: &Path,
) -> io::Result<Router> {
    router_with_board_and_t3_callers(service, controllers, assets, None)
}

/// Serve the paired board and authenticate local T3 callers.
///
/// # Errors
/// Returns an error if the built board files cannot be read.
pub fn router_with_board_and_t3_callers(
    service: Arc<Service>,
    controllers: impl IntoIterator<Item = Controller>,
    assets: &Path,
    t3_caller_key: Option<[u8; 32]>,
) -> io::Result<Router> {
    let board = Board {
        html: fs::read(assets.join("index.html"))?.into(),
        app: fs::read(assets.join("app.js"))?.into(),
        grants: Arc::new(Mutex::new(Grants {
            links: HashMap::new(),
            sessions: SessionStore::open(service.storage.database().clone(), now_ms())?,
        })),
        revocations: watch::channel(()).0,
    };
    service
        .board
        .set(board.clone())
        .map_err(|_| io::Error::other("the board is already configured"))?;
    Ok(routes(service, controllers, Some(board), t3_caller_key))
}

#[derive(Clone)]
pub(crate) struct Board {
    html: Bytes,
    app: Bytes,
    grants: Arc<Mutex<Grants>>,
    revocations: watch::Sender<()>,
}

struct Grants {
    links: HashMap<[u8; 32], Grant>,
    sessions: SessionStore,
}

#[derive(Clone)]
struct Grant {
    authority: Authority,
    scope: ControllerScope,
    expires: Instant,
}

#[derive(Clone)]
pub(super) struct BrowserSession {
    id: [u8; 32],
    scope: ControllerScope,
    expires: Instant,
    revoked: watch::Receiver<()>,
}

impl Board {
    pub(crate) fn inbox_link(&self, endpoint: SocketAddr) -> Option<String> {
        self.link(
            endpoint,
            Authority::Operator {
                actor: "operator via T3 Inbox (attested)".into(),
            },
            ControllerScope::default(),
        )
        .ok()
    }

    fn link(
        &self,
        endpoint: SocketAddr,
        authority: Authority,
        scope: ControllerScope,
    ) -> Result<String, ApiError> {
        let key = random_key()?;
        let now = Instant::now();
        let mut grants = self.grants.lock().map_err(|_| ApiError::BoardUnavailable)?;
        grants.links.retain(|_, grant| grant.expires > now);
        if grants.links.len() >= MAX_GRANTS {
            return Err(ApiError::BoardUnavailable);
        }
        grants.links.insert(
            key,
            Grant {
                authority,
                scope,
                expires: now + LINK_TTL,
            },
        );
        Ok(format!("http://{endpoint}/#token={}", hex::encode(key)))
    }

    pub(super) fn routes(self, api: &Api) -> Router<Api> {
        let board = Router::new()
            .route("/api/engine/session", get(session))
            .route("/api/engine/theme", get(theme))
            .route("/api/engine/profiles/catalog", get(profile_catalog))
            .route("/api/engine/profiles/usage", get(profile_usage))
            .route(
                "/api/engine/profiles/pauses/{group}/clear",
                post(settings::clear_fallback_pause),
            )
            .route("/api/engine/tasks", get(super::list).post(super::admit))
            .route("/api/engine/tasks/{id}", get(super::detail))
            .route("/api/engine/tasks/{id}/next", get(super::next))
            .route("/api/engine/tasks/{id}/history", get(super::history))
            .route("/api/engine/tasks/{id}/commands", post(super::command))
            .route("/api/engine/events", get(events))
            .route("/api/engine/settings", get(settings::all))
            .merge(super::github_accounts::routes(
                "/api/engine/settings/github-accounts",
            ))
            .nest(
                "/api/engine/planning/{project}",
                super::planning::project_routes(),
            )
            .route(
                "/api/engine/settings/projects/{project}/clear-planner",
                post(settings::clear_planner),
            )
            .route(
                "/api/engine/settings/projects/reassign",
                post(settings::reassign),
            )
            .route(
                "/api/engine/settings/projects/{project}/removal",
                get(settings::preview_project_removal).post(settings::remove_project),
            )
            .route(
                "/api/engine/settings/{domain}",
                get(settings::get).put(settings::put),
            )
            .route_layer(middleware::from_fn_with_state(
                (api.clone(), self.clone()),
                authorize_browser,
            ));
        board
            .route("/api/engine/pair", post(pair))
            .route(
                "/v1/board/link",
                post(issue).route_layer(middleware::from_fn_with_state(api.clone(), authorize)),
            )
            .route(
                "/v1/board/revoke",
                post(revoke).route_layer(middleware::from_fn_with_state(api.clone(), authorize)),
            )
            .route("/", get(page))
            .route("/settings", get(page))
            .route("/app.js", get(javascript))
            .layer(middleware::from_fn(headers))
            .layer(Extension(self))
    }
}

async fn page(Extension(board): Extension<Board>) -> impl IntoResponse {
    (
        [
            (
                CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (CONTENT_SECURITY_POLICY, PAGE_POLICY),
        ],
        board.html,
    )
}

async fn javascript(Extension(board): Extension<Board>) -> impl IntoResponse {
    (
        [(CONTENT_TYPE, "text/javascript; charset=utf-8")],
        board.app,
    )
}

async fn session(
    Extension(authority): Extension<Authority>,
    Extension(session): Extension<BrowserSession>,
) -> Json<Value> {
    Json(json!({
        "id": hex::encode(session.id),
        "canEditSettings": matches!(authority, Authority::Operator { .. }),
        "planningProjects": Value::Null,
    }))
}

/// The cached theme inputs. A board read never calls the host.
async fn theme(State(api): State<Api>) -> Json<Value> {
    let theme = api.service.theme.borrow().clone();
    Json(json!({"theme": theme}))
}

async fn profile_catalog(State(api): State<Api>) -> Json<Value> {
    Json(api.service.host.board_catalog())
}

async fn profile_usage(State(api): State<Api>) -> Result<Json<Value>, ApiError> {
    let state = api.service.state.lock().await;
    let usage = state
        .store
        .profile_usage()
        .map_err(crate::ServiceError::from)?;
    let now = now_ms();
    let limited_groups = state
        .store
        .active_provider_pauses(now)
        .map_err(crate::ServiceError::from)?;
    let mut view = json!(usage);
    view["limitedGroups"] = json!(limited_groups);
    let fallback = state
        .store
        .fallback_pause_groups(now)
        .map_err(crate::ServiceError::from)?;
    if !fallback.is_empty() {
        view["fallbackGroups"] = json!(fallback);
    }
    Ok(Json(view))
}

async fn headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().extend([
        (CACHE_CONTROL, HeaderValue::from_static("no-store")),
        (
            axum::http::header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ),
        (
            axum::http::header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ),
        (
            axum::http::header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ),
    ]);
    response
}

async fn issue(
    State(api): State<Api>,
    Extension(board): Extension<Board>,
    Extension(authority): Extension<Authority>,
    Extension(scope): Extension<ControllerScope>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "url": board.link(api.service.callback, authority, scope)?
    })))
}

async fn pair(
    Extension(board): Extension<Board>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    browser_request(&headers)?;
    let link = credential(&headers)?;
    let session = random_key()?;
    let now = Instant::now();
    let mut grants = board
        .grants
        .lock()
        .map_err(|_| ApiError::BoardUnavailable)?;
    let grant = grants
        .links
        .remove(&link)
        .filter(|grant| grant.expires > now)
        .ok_or(ApiError::Unauthorized)?;
    let evicted = grants
        .sessions
        .insert(&session, grant.authority, grant.scope, now_ms(), MAX_GRANTS)
        .map_err(|_| ApiError::BoardUnavailable)?;
    if evicted > 0 {
        // An evicted session must not keep its open event stream. Streams that
        // are still paired reconnect with their cookies.
        board.revocations.send_replace(());
    }
    Ok((
        StatusCode::NO_CONTENT,
        [(SET_COOKIE, session_cookie(&session)?)],
    ))
}

fn session_cookie(session: &[u8; 32]) -> Result<HeaderValue, ApiError> {
    let mut cookie = HeaderValue::from_str(&format!(
        "{COOKIE_NAME}={}; Path={COOKIE_SCOPE}; Max-Age={}; HttpOnly; SameSite=Strict",
        hex::encode(session),
        IDLE.as_secs()
    ))
    .map_err(|_| ApiError::BoardUnavailable)?;
    cookie.set_sensitive(true);
    Ok(cookie)
}

async fn revoke(
    Extension(board): Extension<Board>,
    Extension(authority): Extension<Authority>,
) -> Result<Json<Value>, ApiError> {
    if !matches!(authority, Authority::Operator { .. }) {
        return Err(ApiError::BoardOperator);
    }
    let mut grants = board
        .grants
        .lock()
        .map_err(|_| ApiError::BoardUnavailable)?;
    let revoked = grants
        .sessions
        .revoke(now_ms())
        .map_err(|_| ApiError::BoardUnavailable)?;
    let links = grants.links.len();
    grants.links.clear();
    board.revocations.send_replace(());
    Ok(Json(json!({"revoked": revoked + links})))
}

async fn authorize_browser(
    State((api, board)): State<(Api, Board)>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    browser_request(request.headers())?;
    let cookie = request
        .headers()
        .get(COOKIE)
        .and_then(|header| header.to_str().ok())
        .and_then(|header| {
            header
                .split(';')
                .filter_map(|part| part.trim().split_once('='))
                .find_map(|(name, value)| (name == COOKIE_NAME).then_some(value))
        })
        .ok_or(ApiError::Unauthorized)?;
    let mut key = [0; 32];
    hex::decode_to_slice(cookie, &mut key).map_err(|_| ApiError::Unauthorized)?;
    let now = now_ms();
    let (session, refresh, revoked) = {
        let mut grants = board
            .grants
            .lock()
            .map_err(|_| ApiError::BoardUnavailable)?;
        let (session, refresh) = grants
            .sessions
            .authenticate(&key, now)
            .map_err(|_| ApiError::BoardUnavailable)?
            .ok_or(ApiError::Unauthorized)?;
        (session, refresh, board.revocations.subscribe())
    };
    request.extensions_mut().insert(session.authority);
    let scope = session.scope.for_request();
    super::reauthorize_controller(&api, &scope).await?;
    request.extensions_mut().insert(scope.clone());
    request.extensions_mut().insert(BrowserSession {
        // A public cache key, distinct from the cookie and its stored digest.
        id: Sha256::new()
            .chain_update(b"board session")
            .chain_update(key)
            .finalize()
            .into(),
        scope,
        expires: Instant::now()
            + IDLE.min(Duration::from_millis(
                session.expires_at.saturating_sub(now),
            )),
        revoked,
    });
    let mut response = next.run(request).await;
    if refresh {
        response
            .headers_mut()
            .insert(SET_COOKIE, session_cookie(&key)?);
    }
    Ok(response)
}

fn browser_request(headers: &HeaderMap) -> Result<(), ApiError> {
    // Browsers cannot send this header cross-origin without a successful preflight.
    if headers
        .get("x-nucleus-board")
        .is_some_and(|value| value == "1")
    {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

fn random_key() -> Result<[u8; 32], ApiError> {
    let mut key = [0; 32];
    getrandom::fill(&mut key).map_err(|_| ApiError::BoardUnavailable)?;
    Ok(key)
}

async fn events(
    State(api): State<Api>,
    Extension(session): Extension<BrowserSession>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let changes = [
        ("settings", &api.service.settings_changes),
        ("storage", &api.service.storage_changes),
        ("planning", &api.service.planning_changes),
        ("decisions", &api.service.decision_changes),
        ("profile-usage", &api.service.profile_usage_changes),
    ];
    let changes = stream::select_all(changes.map(|(name, sender)| {
        Box::pin(stream::unfold(
            sender.subscribe(),
            move |mut changes| async move {
                changes.changed().await.ok()?;
                Some((Ok(Event::default().event(name).data("{}")), changes))
            },
        ))
    }));
    let mut theme = api.service.theme.subscribe();
    theme.mark_unchanged();
    let theme = stream::unfold(theme, |mut changes| async {
        changes.changed().await.ok()?;
        Some((Ok(Event::default().event("theme").data("{}")), changes))
    });
    let catalog = stream::unfold(api.service.host.catalog_changes(), |mut changes| async {
        changes.changed().await.ok()?;
        Some((Ok(Event::default().event("catalog").data("{}")), changes))
    });
    let changes = stream::select(
        invalidation_events(api.service, None, session.scope),
        stream::select(changes, stream::select(theme, catalog)),
    )
    .take_until(async move {
        let mut revoked = session.revoked;
        tokio::select! {
            _ = revoked.changed() => {},
            () = sleep_until(session.expires) => {},
        }
    });
    Sse::new(changes).keep_alive(KeepAlive::default())
}
