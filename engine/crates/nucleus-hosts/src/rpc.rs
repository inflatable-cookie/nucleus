use std::{net::IpAddr, time::Duration};

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Url, header::HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    net::TcpStream,
    sync::{Mutex, mpsc},
    time,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

use crate::{HostError, T3_RETRY_DELAY};

const DEADLINE: Duration = Duration::from_secs(30);
const MAX_FRAME: usize = 16 * 1024 * 1024;
const MAX_TICKET: usize = 64 * 1024;
const MAX_MESSAGES: usize = 10_000;

// The WebSocket server requires its one-use ticket in the URL. Tungstenite
// traces raw upgrade requests, so do not compile those log statements in.
const _: () = assert!(log::STATIC_MAX_LEVEL as usize <= log::LevelFilter::Debug as usize);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub(crate) enum Reply {
    Value(Value),
    Failure(Value),
}

#[derive(Clone, Copy)]
pub(crate) enum Read {
    One,
    Shell,
    Thread,
}

pub(crate) struct Rpc {
    base: Url,
    bearer: HeaderValue,
    http: Client,
    socket: Mutex<Slot>,
}

struct Slot {
    connection: Option<Connection>,
    retry_at: time::Instant,
}

/// A shell delta that can wake an exact read. It never proves run state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadHint {
    pub thread: String,
    change: Option<Value>,
}

impl ThreadHint {
    fn read(item: &Value) -> Option<Self> {
        match item["kind"].as_str()? {
            "thread.updated" => {
                let thread = &item["thread"];
                Some(Self {
                    thread: thread["id"].as_str()?.into(),
                    change: Some(json!([
                        item["location"],
                        thread["status"],
                        thread["activeRunId"],
                        thread["latestRunId"],
                        thread["latestRunStartedAt"],
                        thread["latestRunCompletedAt"],
                        thread["latestUserMessageAt"],
                        thread["pendingRuntimeRequest"]["id"],
                        thread["pendingBackgroundTasks"].as_array().map(Vec::len),
                        thread["archivedAt"],
                        thread["settledAt"],
                    ])),
                })
            }
            "thread.removed" => Some(Self {
                thread: item["threadId"].as_str()?.into(),
                change: None,
            }),
            _ => None,
        }
    }
}

impl Rpc {
    pub(crate) const fn endpoint(&self) -> &Url {
        &self.base
    }

    pub(crate) fn new(endpoint: &str, bearer: &str) -> Result<Self, HostError> {
        let base = Url::parse(endpoint).map_err(|_| HostError::Configuration)?;
        let loopback = base.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if !matches!(base.scheme(), "http" | "https")
            || !loopback
            || !base.username().is_empty()
            || base.password().is_some()
            || base.path() != "/"
            || base.query().is_some()
            || base.fragment().is_some()
            || bearer.is_empty()
        {
            return Err(HostError::Configuration);
        }
        let mut bearer = HeaderValue::from_str(&format!("Bearer {bearer}"))
            .map_err(|_| HostError::Configuration)?;
        bearer.set_sensitive(true);
        let http = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(DEADLINE)
            .build()
            .map_err(|_| HostError::Configuration)?;
        Ok(Self {
            base,
            bearer,
            http,
            socket: Mutex::new(Slot {
                connection: None,
                retry_at: time::Instant::now(),
            }),
        })
    }

    pub(crate) async fn call(
        &self,
        method: &str,
        payload: impl Serialize + Send,
        read: Read,
    ) -> Result<Reply, HostError> {
        let mut slot = self.socket.lock().await;
        if time::Instant::now() < slot.retry_at {
            return Err(HostError::Deferred {
                until: slot.retry_at,
            });
        }
        let result = async {
            let mut connection = match slot.connection.take() {
                Some(connection) => connection,
                None => Connection {
                    socket: time::timeout(DEADLINE, self.connect())
                        .await
                        .map_err(|_| HostError::Timeout)??,
                    next_id: 0,
                },
            };
            let reply = time::timeout(DEADLINE, connection.call(method, payload, read))
                .await
                .map_err(|_| HostError::Timeout)??;
            slot.connection = Some(connection);
            Ok(reply)
        }
        .await;
        if matches!(result, Err(HostError::Unavailable | HostError::Timeout)) {
            slot.retry_at = time::Instant::now() + T3_RETRY_DELAY;
        }
        result
    }

    pub(crate) async fn watch_threads(
        &self,
        hints: &mpsc::Sender<ThreadHint>,
    ) -> Result<(), HostError> {
        let socket = time::timeout(DEADLINE, self.connect())
            .await
            .map_err(|_| HostError::Timeout)??;
        let mut connection = Connection { socket, next_id: 0 };
        connection.send(json!({"_tag":"Request", "id":"1", "tag":"orchestration.subscribeShell", "headers":[],
            "payload":{"omitIdleSubagents":true,"omitOlderSettled":true}})).await?;
        loop {
            let frames = time::timeout(Duration::from_mins(1), connection.frames())
                .await
                .map_err(|_| HostError::Timeout)??;
            for frame in frames {
                match frame["_tag"].as_str() {
                    Some("Ping") => connection.send(json!({"_tag":"Pong"})).await?,
                    Some("Pong") => {}
                    Some("Chunk") if frame["requestId"] == "1" || frame["requestId"] == 1 => {
                        connection
                            .send(json!({"_tag":"Ack","requestId":"1"}))
                            .await?;
                        for item in frame["values"].as_array().ok_or(HostError::Protocol)? {
                            if let Some(hint) = ThreadHint::read(item) {
                                hints.try_send(hint).map_err(|_| HostError::Uncertain)?;
                            }
                        }
                    }
                    _ => return Err(HostError::Protocol),
                }
            }
        }
    }

    async fn connect(&self) -> Result<Socket, HostError> {
        #[derive(Deserialize)]
        struct Ticket {
            ticket: String,
        }
        let url = self
            .base
            .join("api/auth/websocket-ticket/rpc")
            .map_err(|_| HostError::Configuration)?;
        let mut response = self
            .http
            .post(url)
            .header(reqwest::header::AUTHORIZATION, self.bearer.clone())
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|_| HostError::Unavailable)?;
        let mut data = Vec::new();
        while let Some(bytes) = response.chunk().await.map_err(|_| HostError::Unavailable)? {
            if data.len() + bytes.len() > MAX_TICKET {
                return Err(HostError::Protocol);
            }
            data.extend_from_slice(&bytes);
        }
        let ticket: Ticket = serde_json::from_slice(&data).map_err(|_| HostError::Protocol)?;
        if ticket.ticket.is_empty() {
            return Err(HostError::Protocol);
        }
        let mut url = self.base.join("ws").map_err(|_| HostError::Configuration)?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|()| HostError::Configuration)?;
        url.query_pairs_mut()
            .append_pair("wsTicket", &ticket.ticket)
            .append_pair("orchestrationProtocol", "2");
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME))
            .max_frame_size(Some(MAX_FRAME));
        let (socket, _) = connect_async_with_config(url.as_str(), Some(config), false)
            .await
            .map_err(|_| HostError::Unavailable)?;
        Ok(socket)
    }
}

struct Connection {
    socket: Socket,
    next_id: u64,
}

impl Connection {
    async fn frames(&mut self) -> Result<Vec<Value>, HostError> {
        let message = self
            .socket
            .next()
            .await
            .ok_or(HostError::Unavailable)?
            .map_err(|_| HostError::Unavailable)?;
        let Message::Text(text) = message else {
            return match message {
                Message::Ping(_) | Message::Pong(_) => Ok(Vec::new()),
                _ => Err(HostError::Unavailable),
            };
        };
        let value = serde_json::from_str(&text).map_err(|_| HostError::Protocol)?;
        Ok(match value {
            Value::Array(frames) => frames,
            frame => vec![frame],
        })
    }

    async fn call(
        &mut self,
        method: &str,
        payload: impl Serialize + Send,
        read: Read,
    ) -> Result<Reply, HostError> {
        #[derive(Serialize)]
        struct Request<'a, P> {
            #[serde(rename = "_tag")]
            kind: &'static str,
            id: &'a str,
            tag: &'a str,
            payload: P,
            headers: [(); 0],
        }
        self.next_id = self.next_id.checked_add(1).ok_or(HostError::Protocol)?;
        let id = self.next_id.to_string();
        self.send(Request {
            kind: "Request",
            id: &id,
            tag: method,
            payload,
            headers: [],
        })
        .await?;
        let mut snapshot = None;
        for _ in 0..MAX_MESSAGES {
            for frame in self.frames().await? {
                let tag = frame["_tag"].as_str().ok_or(HostError::Protocol)?;
                if tag == "Ping" {
                    self.send(json!({"_tag":"Pong"})).await?;
                    continue;
                }
                if tag == "Pong" {
                    continue;
                }
                if frame["requestId"].as_str() != Some(&id)
                    && frame["requestId"].as_u64() != Some(self.next_id)
                {
                    if frame["requestId"].is_null() {
                        return Err(HostError::Protocol);
                    }
                    continue;
                }
                match tag {
                    "Exit" if frame["exit"]["_tag"] == "Failure" => {
                        return Ok(Reply::Failure(frame["exit"]["cause"].clone()));
                    }
                    "Exit" if frame["exit"]["_tag"] == "Success" && matches!(read, Read::One) => {
                        return Ok(Reply::Value(frame["exit"]["value"].clone()));
                    }
                    "Chunk" if matches!(read, Read::Shell | Read::Thread) => {
                        self.send(json!({"_tag":"Ack","requestId":id})).await?;
                        let items = frame["values"].as_array().ok_or(HostError::Protocol)?;
                        for item in items {
                            match item["kind"].as_str() {
                                // Shell can emit repository metadata before synchronization.
                                // Project and thread authority comes from the unmarked snapshot.
                                Some("snapshot")
                                    if matches!(read, Read::Shell)
                                        && item["resolvedRepositoryIdentityRoots"]
                                            .as_array()
                                            .is_some_and(|roots| {
                                                roots.iter().all(Value::is_string)
                                            }) => {}
                                Some("snapshot")
                                    if snapshot.is_none()
                                        && item
                                            .get("resolvedRepositoryIdentityRoots")
                                            .is_none() =>
                                {
                                    snapshot = Some(item.clone());
                                }
                                Some("synchronized") => {
                                    self.send(json!({"_tag":"Interrupt","requestId":id}))
                                        .await?;
                                    return snapshot.map(Reply::Value).ok_or(HostError::Protocol);
                                }
                                _ => return Err(HostError::Protocol),
                            }
                        }
                    }
                    _ => return Err(HostError::Protocol),
                }
            }
        }
        Err(HostError::Protocol)
    }

    async fn send(&mut self, frame: impl Serialize + Send) -> Result<(), HostError> {
        let text = serde_json::to_string(&frame).map_err(|_| HostError::Protocol)?;
        if text.len() > MAX_FRAME {
            return Err(HostError::Protocol);
        }
        self.socket
            .send(Message::Text(text.into()))
            .await
            .map_err(|_| HostError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn shell_hints_ignore_transcript_updates_but_keep_lifecycle_changes() {
        let running = json!({"kind":"thread.updated","location":"active","thread":{
            "id":"fixture","status":"running","activeRunId":"run","visibleItemCount":1
        }});
        let mut revised = running.clone();
        revised["thread"]["visibleItemCount"] = json!(2);
        revised["thread"]["updatedAt"] = json!("2026-11-23T20:00:00Z");
        assert_eq!(ThreadHint::read(&running), ThreadHint::read(&revised));
        revised["thread"]["pendingRuntimeRequest"] = json!({"id":"permission"});
        assert_ne!(ThreadHint::read(&running), ThreadHint::read(&revised));
        revised["thread"]["pendingRuntimeRequest"] = Value::Null;
        revised["thread"]["activeRunId"] = Value::Null;
        revised["thread"]["status"] = json!("completed");
        assert_ne!(ThreadHint::read(&running), ThreadHint::read(&revised));
    }

    #[tokio::test]
    async fn a_transport_failure_defers_other_rpc_calls() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listen");
        let address = listener.local_addr().expect("endpoint");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("request");
            let mut request = [0; 1024];
            assert!(stream.read(&mut request).await.expect("ticket request") > 0);
            stream
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                .await
                .expect("reply");
        });
        let rpc = Rpc::new(&format!("http://{address}"), "fixture").expect("client");
        assert!(matches!(
            rpc.call("server.getConfig", json!({}), Read::One).await,
            Err(HostError::Unavailable)
        ));
        assert!(
            matches!(rpc.call("server.getConfig", json!({}), Read::One).await,
            Err(HostError::Deferred { until }) if until > time::Instant::now())
        );
        server.await.expect("server");
    }
}
