use std::{convert::Infallible, sync::Arc};

use axum::{
    Json, Router,
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{
        Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use futures_util::{Stream, stream};
use nucleus_core::acp::{InboxAnswer, InboxSnapshot};

use super::{Api, ApiError, body, credential};
use crate::Service;

pub(super) fn routes() -> Router<Api> {
    Router::new()
        .route("/v1/acp/inbox", get(snapshot))
        .route("/v1/acp/inbox/events", get(events))
        .route("/v1/acp/inbox/answer", post(answer))
}

async fn snapshot(
    State(api): State<Api>,
    headers: HeaderMap,
) -> Result<Json<InboxSnapshot>, ApiError> {
    Ok(Json(
        api.service.inbox_snapshot(&credential(&headers)?).await?,
    ))
}

async fn answer(
    State(api): State<Api>,
    headers: HeaderMap,
    input: Result<Json<InboxAnswer>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    api.service
        .answer_inbox(&credential(&headers)?, body(input)?)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn events(
    State(api): State<Api>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let key = credential(&headers)?;
    inbox_events(api.service, key)
}

fn inbox_events(
    service: Arc<Service>,
    key: [u8; 32],
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let receiver = service.inbox_session(&key)?.changes();
    Ok(Sse::new(stream::unfold(
        (receiver, service, true),
        move |(mut receiver, service, first)| async move {
            if !first {
                receiver.changed().await.ok()?;
            }
            service.inbox_session(&key).ok()?;
            let event = Event::default()
                .event(if first { "refresh" } else { "invalidate" })
                .data("{}");
            Some((Ok(event), (receiver, service, false)))
        },
    ))
    .keep_alive(KeepAlive::default()))
}
