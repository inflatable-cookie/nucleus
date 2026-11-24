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
use tokio::time::{Instant, sleep_until};

use super::{
    Api, ApiError, Controller, authorize, credential, invalidation_events, routes, settings,
};
use crate::Service;

const COOKIE_NAME: &str = "nucleus_engine_board";
const COOKIE_SCOPE: &str = "/api/engine";
const LINK_TTL: Duration = Duration::from_mins(2);
const SESSION_TTL: Duration = Duration::from_hours(8);
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
    let board = Board {
        html: fs::read(assets.join("index.html"))?.into(),
        app: fs::read(assets.join("app.js"))?.into(),
        grants: Arc::default(),
    };
    Ok(routes(service, controllers, Some(board)))
}

#[derive(Clone)]
pub(super) struct Board {
    html: Bytes,
    app: Bytes,
    grants: Arc<Mutex<Grants>>,
}

#[derive(Default)]
struct Grants {
    links: HashMap<[u8; 32], Grant>,
    sessions: HashMap<[u8; 32], Grant>,
}

#[derive(Clone)]
struct Grant {
    authority: Authority,
    expires: Instant,
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
    grants.sessions.retain(|_, grant| grant.expires > now);
    if grants.sessions.len() >= MAX_GRANTS {
        return Err(ApiError::BoardUnavailable);
    }
    let grant = grants
        .links
        .remove(&link)
        .filter(|grant| grant.expires > now)
        .ok_or(ApiError::Unauthorized)?;
    grants.sessions.insert(
        session,
        Grant {
            authority: grant.authority,
            expires: now + SESSION_TTL,
        },
    );
    let mut cookie = HeaderValue::from_str(&format!(
        "{COOKIE_NAME}={}; Path={COOKIE_SCOPE}; Max-Age={}; HttpOnly; SameSite=Strict",
        hex::encode(session),
        SESSION_TTL.as_secs()
    ))
    .map_err(|_| ApiError::BoardUnavailable)?;
    cookie.set_sensitive(true);
    Ok((StatusCode::NO_CONTENT, [(SET_COOKIE, cookie)]))
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
    let grant = board
        .grants
        .lock()
        .map_err(|_| ApiError::BoardUnavailable)?
        .sessions
        .get(&key)
        .filter(|grant| grant.expires > Instant::now())
        .cloned()
        .ok_or(ApiError::Unauthorized)?;
    request.extensions_mut().insert(grant.authority.clone());
    request.extensions_mut().insert(grant);
    Ok(next.run(request).await)
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
    Extension(grant): Extension<Grant>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let settings = stream::unfold(
        api.service.settings_changes.subscribe(),
        |mut changes| async {
            changes.changed().await.ok()?;
            Some((Ok(Event::default().event("settings").data("{}")), changes))
        },
    );
    let changes = stream::select(invalidation_events(api.service, None), settings)
        .take_until(sleep_until(grant.expires));
    Sse::new(changes).keep_alive(KeepAlive::default())
}
