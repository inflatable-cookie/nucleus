mod sessions;

use std::{
    collections::HashMap,
    convert::Infallible,
    fs, io,
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
    Ok(routes(service, controllers, Some(board), t3_caller_key))
}

#[derive(Clone)]
pub(super) struct Board {
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
struct BrowserSession {
    scope: ControllerScope,
    expires: Instant,
    revoked: watch::Receiver<()>,
}

impl Board {
    pub(super) fn routes(self, api: &Api) -> Router<Api> {
        let board = Router::new()
            .route("/api/engine/session", get(session))
            .route("/api/engine/tasks", get(super::list).post(super::admit))
            .route("/api/engine/tasks/{id}", get(super::detail))
            .route("/api/engine/tasks/{id}/next", get(super::next))
            .route("/api/engine/tasks/{id}/history", get(super::history))
            .route("/api/engine/tasks/{id}/commands", post(super::command))
            .route("/api/engine/events", get(events))
            .route("/api/engine/settings", get(settings::all))
            .nest(
                "/api/engine/planning/{project}",
                super::planning::lane_routes(),
            )
            .route(
                "/api/engine/settings/{domain}",
                get(settings::get).put(settings::put),
            )
            .route_layer(middleware::from_fn_with_state(
                self.clone(),
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

async fn session(Extension(authority): Extension<Authority>) -> Json<Value> {
    Json(json!({"canEditSettings": matches!(authority, Authority::Operator { .. })}))
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
    let key = random_key()?;
    let now = Instant::now();
    let mut grants = board
        .grants
        .lock()
        .map_err(|_| ApiError::BoardUnavailable)?;
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
    Ok(Json(json!({
        "url": format!("http://{}/#token={}", api.service.callback, hex::encode(key))
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
    grants
        .sessions
        .insert(&session, grant.authority, grant.scope, now_ms(), MAX_GRANTS)
        .map_err(|_| ApiError::BoardUnavailable)?;
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
    State(board): State<Board>,
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
    request.extensions_mut().insert(session.scope.clone());
    request.extensions_mut().insert(BrowserSession {
        scope: session.scope,
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
    let settings = stream::unfold(
        api.service.settings_changes.subscribe(),
        |mut changes| async {
            changes.changed().await.ok()?;
            Some((Ok(Event::default().event("settings").data("{}")), changes))
        },
    );
    let changes = stream::select(
        invalidation_events(api.service, None, session.scope),
        settings,
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
