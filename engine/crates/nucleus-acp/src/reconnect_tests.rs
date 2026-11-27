use std::{
    convert::Infallible,
    future::Future,
    pin::pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    extract::State,
    response::sse::{Event, Sse},
    routing::get,
};
use futures_util::{Stream, stream};
use nucleus_core::acp::{Binding, InboxBinding, SessionBinding};
use serde_json::json;
use tokio::{
    net::TcpListener,
    sync::{Mutex, Notify, mpsc},
    task::JoinHandle,
};

use crate::{client::ServiceClient, inbox, presentation::Presentation, task_prompt};

#[derive(Clone)]
struct Fixture {
    changes: Arc<Mutex<Option<mpsc::UnboundedReceiver<()>>>>,
    state: usize,
    attached: Arc<Notify>,
}

async fn events(
    State(fixture): State<Fixture>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let receiver = fixture.changes.lock().await.take().unwrap();
    fixture.attached.notify_one();
    Sse::new(stream::unfold(
        (true, receiver),
        |(first, mut receiver)| async move {
            if !first {
                receiver.recv().await?;
            }
            Some((
                Ok(Event::default()
                    .event(if first { "refresh" } else { "invalidate" })
                    .data("{}")),
                (false, receiver),
            ))
        },
    ))
}

async fn server(
    listener: TcpListener,
    state: usize,
) -> (mpsc::UnboundedSender<()>, Arc<Notify>, JoinHandle<()>) {
    let (send, receive) = mpsc::unbounded_channel();
    let attached = Arc::new(Notify::new());
    let fixture = Fixture {
        attached: Arc::clone(&attached),
        changes: Arc::new(Mutex::new(Some(receive))),
        state,
    };
    let app = Router::new()
        .route("/v1/tasks/fixture/events", get(events))
        .route("/v1/acp/inbox/events", get(events))
        .route("/v1/tasks/fixture", get(async |State(f): State<Fixture>| ([(axum::http::header::CONNECTION, "close")], Json(json!({
            "identity":{"id":"fixture","reference":"fixture","repository":"example/fixture","base":"main","entry":"brief"},
            "phase":"working", "lifecycle":{"steps":[{"key":"working","label":"Working","state":"current","tone":"accent"}],"admittedAtMs":0,"transcript":{"cards":[],"completedReviews":0,"merged":false,"externalAcceptances":[]}},
            "parentHold":"hold", "activeChild":false,
            "reference":format!("fixture#{}", f.state)
        })))))
        .route("/v1/acp/inbox", get(async |State(f): State<Fixture>| ([(axum::http::header::CONNECTION, "close")], Json(json!({"pending":[{"field":format!("field{}", f.state),"question":"Continue?","choices":[{"id":"yes","label":"Yes"}],"offer":true}]})))))
        .with_state(fixture);
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (send, attached, handle)
}

async fn run_reconnect(inbox_session: bool) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = listener.local_addr().unwrap();
    let (stream, attached, server_task) = server(listener, 1).await;
    let binding = if inbox_session {
        SessionBinding::Inbox(InboxBinding {
            session_id: "fixture".into(),
            endpoint,
            inbox_credential: [5; 32],
        })
    } else {
        SessionBinding::Task(Binding {
            session_id: "fixture".into(),
            task_id: "fixture".into(),
            endpoint,
            credential: [5; 32],
            command_credential: None,
            scratch_dir: None,
        })
    };
    let mut client = ServiceClient::new(&binding).unwrap();
    let (output, mut frames) = mpsc::unbounded_channel();
    let polls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&polls);
    let turn = tokio::spawn(async move {
        let view = Mutex::new(Presentation::default());
        let future = async {
            if inbox_session {
                let (answers, receive) = mpsc::unbounded_channel();
                let replies = inbox::Replies {
                    cards: Mutex::default(),
                    answers,
                };
                inbox::follow(&client, &output, "fixture", &replies, receive, None)
                    .await
                    .unwrap();
            } else {
                task_prompt(
                    &mut client,
                    &view,
                    &output,
                    "fixture",
                    true,
                    "hold",
                    std::path::Path::new("/"),
                )
                .await
                .unwrap();
            }
        };
        let mut future = pin!(future);
        std::future::poll_fn(|cx| {
            count.fetch_add(1, Ordering::SeqCst);
            future.as_mut().poll(cx)
        })
        .await
    });
    // Wait until the first snapshot was presented, then close the stream and listener.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = frames.recv().await.unwrap();
            if inbox_session && frame["method"] == "elicitation/create" {
                break;
            }
            if !inbox_session && frame.to_string().contains("fixture#1") {
                break;
            }
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), attached.notified())
        .await
        .unwrap();
    drop(stream);
    server_task.abort();
    let _ = server_task.await;
    // Allow the closed stream to be observed and the reconnect delay to begin.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let before = polls.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        polls.load(Ordering::SeqCst),
        before,
        "turn spun during reconnect delay"
    );
    let listener = TcpListener::bind(endpoint).await.unwrap();
    let (_stream, _attached, server_task) = server(listener, 2).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = frames.recv().await.unwrap();
            if inbox_session && frame.to_string().contains("field2") {
                break;
            }
            if !inbox_session && frame.to_string().contains("fixture#2") {
                break;
            }
        }
    })
    .await
    .unwrap();
    turn.abort();
    server_task.abort();
}

#[tokio::test]
async fn held_turn_reconnects_without_spinning() {
    run_reconnect(false).await;
}

#[tokio::test]
async fn inbox_reconnects_without_spinning() {
    run_reconnect(true).await;
}
