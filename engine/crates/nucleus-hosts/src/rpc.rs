use std::{
    collections::VecDeque,
    net::IpAddr,
    path::Path,
    sync::{
        Arc, Mutex as SyncMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use longhorn_redact::{RedactionRules, Redactor};
use reqwest::{Client, Url, header::HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    net::TcpStream,
    sync::{Mutex, Notify, mpsc, watch},
    time,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

use crate::{
    HostError, ParentSendError, ProfileCatalog, T3_RETRY_DELAY,
    admission::Admission,
    catalog::CatalogRevision,
    runtime::ServerRuntime,
    thread_snapshots::{ThreadRead, ThreadSnapshots},
    traffic::Traffic,
};

const DEADLINE: Duration = Duration::from_secs(30);
const MAX_RETRY: Duration = Duration::from_mins(4);
const MAX_FRAME: usize = 16 * 1024 * 1024;
const MAX_TICKET: usize = 64 * 1024;
const MAX_MESSAGES: usize = 10_000;

// The upgrade URL carries a one-use ticket and preview frames can carry board
// pairing links. Keep Tungstenite's raw request and frame traces compiled out.
const _: () = assert!(log::STATIC_MAX_LEVEL as usize <= log::LevelFilter::Debug as usize);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone)]
pub(crate) enum Reply {
    Value(Value),
    Failure(Value),
}

pub(crate) enum ThreadReply {
    Snapshot(Value),
    Missing,
    Closed { row: Value, sequence: Option<u64> },
}

#[derive(Clone)]
pub(crate) struct ThreadFence {
    pub(crate) row: Option<Arc<Value>>,
    revision: (u64, Option<u64>),
    row_revision: Option<(u64, bool)>,
}

impl ThreadFence {
    pub(crate) fn covers(&self, sequence: u64) -> bool {
        self.row_revision.is_some_and(|(revision, initial)| {
            if initial {
                sequence <= revision
            } else {
                sequence == revision
            }
        })
    }

    pub(crate) fn matches(&self, current: &Self) -> bool {
        match (&self.row, &current.row) {
            (Some(before), Some(after)) => Arc::ptr_eq(before, after),
            (None, None) => self.revision == current.revision,
            _ => false,
        }
    }
}

pub(crate) struct ThreadObservation {
    pub(crate) reply: ThreadReply,
    pub(crate) fence: ThreadFence,
}

#[derive(Clone, Copy)]
pub(crate) enum Read {
    One,
    Background,
    Shell,
    Thread(ThreadRead),
}

pub(crate) struct Rpc {
    base: Url,
    bearer: HeaderValue,
    http: Client,
    socket: SyncMutex<Option<Connection>>,
    retry: SyncMutex<Retry>,
    pub(crate) traffic: Traffic,
    shell_managed: AtomicBool,
    shell_epoch: AtomicU64,
    pub(crate) shell_changed: Notify,
    snapshots: SyncMutex<Option<ThreadSnapshots>>,
    recent_effects: SyncMutex<VecDeque<String>>,
    admission: Admission,
    catalog: SyncMutex<CatalogRevision>,
    catalog_refresh: Mutex<()>,
    catalog_changes: watch::Sender<()>,
}

struct Retry {
    until: time::Instant,
    delay: Duration,
}

struct InterruptedCall<'a>(Option<&'a Rpc>);

impl Drop for InterruptedCall<'_> {
    fn drop(&mut self) {
        if let Some(rpc) = self.0 {
            rpc.traffic.record("requests.cancelled");
            rpc.defer();
        }
    }
}

/// A shell delta that can wake an exact read. It never proves run state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadHint {
    pub thread: String,
    change: Option<Value>,
    closed: bool,
    running: bool,
    identity: Option<crate::PlannerIdentity>,
    inbox_synchronized: bool,
    parent_thread: Option<String>,
}

impl ThreadHint {
    /// The first shell synchronization of a new Inbox host connection.
    #[must_use]
    pub const fn inbox_synchronized(&self) -> bool {
        self.inbox_synchronized
    }

    #[cfg(feature = "loopback-fixture")]
    #[doc(hidden)]
    #[must_use]
    pub fn fixture(item: &Value) -> Option<Self> {
        Self::read(item)
    }

    /// Attached child updates can change whether a task row should be visible.
    #[must_use]
    pub fn parent_thread(&self) -> Option<&str> {
        self.parent_thread.as_deref()
    }

    /// A closure can revoke existing planner authority. It cannot grant it.
    #[must_use]
    pub const fn closed(&self) -> bool {
        self.closed
    }

    /// Positive activity can postpone a routine refresh. Idle and missing
    /// shells cannot establish that a run ended.
    #[must_use]
    pub const fn running(&self) -> bool {
        self.running && !self.closed
    }

    /// A run change is a reason to check delivery again.
    #[must_use]
    pub fn has_delivery_change(&self, prior: Option<&Self>) -> bool {
        if self.closed {
            return prior.is_none_or(|prior| !prior.closed);
        }
        self.change.as_ref().is_some_and(|current| {
            (current[2].is_string() || current[3].is_string())
                && prior
                    .and_then(|hint| hint.change.as_ref())
                    .is_none_or(|prior| (1..=8).any(|field| current[field] != prior[field]))
        })
    }

    /// An event can invalidate a prior authority proof. It cannot grant one.
    #[must_use]
    pub fn is_identity_change(&self, prior: Option<&crate::PlannerIdentity>) -> bool {
        self.closed
            || self
                .identity
                .as_ref()
                .is_some_and(|observed| prior.is_none_or(|prior| !observed.same_role(prior)))
    }

    fn read(item: &Value) -> Option<Self> {
        match item["kind"].as_str()? {
            "thread.updated" => {
                let thread = &item["thread"];
                let id = thread["id"].as_str()?;
                Some(Self {
                    thread: id.into(),
                    closed: !thread["archivedAt"].is_null() || !thread["deletedAt"].is_null(),
                    running: thread["status"] == "running"
                        && thread["activeRunId"].as_str().is_some(),
                    identity: serde_json::from_value(thread.clone()).ok(),
                    inbox_synchronized: false,
                    parent_thread: crate::thread_snapshots::ShellCustody(thread)
                        .parent()
                        .map(str::to_owned),
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
                        thread["settledOverride"],
                        thread["snoozedUntil"],
                    ])),
                })
            }
            "thread.removed" => Some(Self {
                thread: item["threadId"].as_str()?.into(),
                change: None,
                closed: true,
                running: false,
                identity: None,
                inbox_synchronized: false,
                parent_thread: None,
            }),
            _ => None,
        }
    }
}

impl Rpc {
    pub(crate) fn failure_detail(&self, cause: &Value) -> String {
        let secret = self
            .bearer
            .to_str()
            .ok()
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::to_owned);
        let redactor = Redactor::new(secret, RedactionRules::common());
        let mut error = cause
            .get(0)
            .and_then(|item| item.get("error"))
            .unwrap_or(cause);
        let mut parts = Vec::new();
        for _ in 0..4 {
            for field in ["_tag", "name", "message"] {
                if let Some(text) = error[field].as_str() {
                    parts.push(
                        redactor
                            .redact(text)
                            .text
                            .chars()
                            .take(180)
                            .collect::<String>(),
                    );
                }
            }
            let Some(nested) = error.get("cause").filter(|value| value.is_object()) else {
                break;
            };
            error = nested;
        }
        if parts.is_empty() {
            "unrecognized T3 failure shape".into()
        } else {
            parts.join(": ")
        }
    }

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
            socket: SyncMutex::new(None),
            retry: SyncMutex::new(Retry {
                until: time::Instant::now(),
                delay: T3_RETRY_DELAY,
            }),
            traffic: Traffic::default(),
            shell_managed: AtomicBool::new(false),
            shell_epoch: AtomicU64::new(0),
            shell_changed: Notify::new(),
            snapshots: SyncMutex::new(None),
            recent_effects: SyncMutex::new(VecDeque::new()),
            admission: Admission::default(),
            catalog: SyncMutex::new(CatalogRevision::default()),
            catalog_refresh: Mutex::new(()),
            catalog_changes: watch::channel(()).0,
        })
    }

    pub(crate) fn retry_at(&self) -> Option<time::Instant> {
        let at = self.retry.lock().expect("host retry").until;
        (at > time::Instant::now()).then_some(at)
    }

    fn defer(&self) {
        let mut retry = self.retry.lock().expect("host retry");
        let now = time::Instant::now();
        if retry.until <= now {
            let jitter = crate::clock_ms().unwrap_or_default() % 997;
            retry.until = now + retry.delay + Duration::from_millis(jitter);
            retry.delay = (retry.delay * 2).min(MAX_RETRY);
        }
    }

    pub(crate) async fn profile_catalog(&self) -> Result<Arc<ProfileCatalog>, HostError> {
        let _refresh = self.catalog_refresh.lock().await;
        let epoch = {
            let state = self.catalog.lock().expect("provider catalog");
            if let Some(catalog) = state.current() {
                return Ok(catalog);
            }
            state.epoch
        };
        let Reply::Value(config) = self.call("server.getConfig", json!({}), Read::One).await?
        else {
            return Err(HostError::Protocol);
        };
        let catalog = ProfileCatalog::parse(config)?;
        let mut state = self.catalog.lock().expect("provider catalog");
        if state.epoch == epoch && state.replace(Some(catalog)) {
            self.catalog_changes.send_replace(());
        }
        state.current().ok_or(HostError::Uncertain)
    }

    pub(crate) fn invalidate_catalog(&self) {
        if self.catalog.lock().expect("provider catalog").invalidate() {
            self.catalog_changes.send_replace(());
        }
    }

    pub(crate) fn board_catalog(&self) -> Value {
        self.catalog.lock().expect("provider catalog").board_view()
    }

    pub(crate) fn catalog_changes(&self) -> watch::Receiver<()> {
        self.catalog_changes.subscribe()
    }

    pub(crate) async fn call(
        &self,
        method: &'static str,
        payload: impl Serialize + Send,
        read: Read,
    ) -> Result<Reply, HostError> {
        self.call_guarded(method, payload, read, || Ok(true)).await
    }

    pub(crate) async fn call_guarded(
        &self,
        method: &'static str,
        payload: impl Serialize + Send,
        read: Read,
        check: impl FnOnce() -> Result<bool, HostError> + Send,
    ) -> Result<Reply, HostError> {
        self.check_retry()?;
        let _admission = self
            .admission
            .enter(!matches!(read, Read::Background))
            .await?;
        Box::pin(self.call_locked(method, payload, read, check)).await
    }

    pub(crate) async fn write_guarded(
        &self,
        method: &'static str,
        payload: Value,
        class: Read,
        check: impl FnOnce() -> Result<(), HostError> + Send,
    ) -> Result<Reply, ParentSendError> {
        let mut reached_send = false;
        self.call_guarded(method, payload, class, || {
            check()?;
            reached_send = true;
            Ok(true)
        })
        .await
        .map_err(|error| {
            if reached_send {
                ParentSendError::Unknown(error)
            } else {
                ParentSendError::NotSent(error)
            }
        })
    }

    async fn call_locked(
        &self,
        method: &'static str,
        payload: impl Serialize + Send,
        read: Read,
        check: impl FnOnce() -> Result<bool, HostError> + Send,
    ) -> Result<Reply, HostError> {
        self.check_retry()?;
        let writes_thread = matches!(
            method,
            "orchestration.dispatchCommand" | "orchestration.launchThread"
        );
        let thread_args = if writes_thread || matches!(read, Read::Thread(_)) {
            serde_json::to_value(&payload).map_err(|_| HostError::Protocol)?
        } else {
            Value::Null
        };
        let threads = [
            thread_args["threadId"].as_str(),
            thread_args["parentThreadId"].as_str(),
            thread_args["childThreadId"].as_str(),
            thread_args.pointer("/thread/id").and_then(Value::as_str),
        ];
        let target = threads.into_iter().flatten().next();
        let socket = self.socket.lock().expect("request socket").take();
        let mut socket = match socket {
            Some(socket) => socket,
            None => Connection {
                socket: self
                    .open()
                    .await
                    .inspect_err(|error| self.record_timeout(method, target, *error))?,
                next_id: 0,
            },
        };
        match self.check_retry().and_then(|()| check()) {
            Ok(true) => {}
            outcome => {
                *self.socket.lock().expect("request socket") = Some(socket);
                return outcome.map(|_| Reply::Value(Value::Null));
            }
        }
        if writes_thread
            && let Some(shell) = self.snapshots.lock().expect("thread snapshots").as_mut()
        {
            for id in threads.into_iter().flatten() {
                shell.forget(id);
            }
        }
        self.traffic.record(method);
        if matches!(read, Read::Thread(policy) if policy.terminal()) {
            self.traffic.record("threadReads.terminal");
        }
        let mut in_flight = InterruptedCall(Some(self));
        let result = time::timeout(DEADLINE, socket.call(method, payload, read))
            .await
            .unwrap_or(Err(HostError::Timeout));
        in_flight.0 = None;
        if matches!(read, Read::Thread(_))
            && let Ok(Reply::Value(value)) = &result
            && value.pointer("/projection/thread").is_some_and(closed_row)
        {
            self.traffic.record("threadReads.archivedOrDeleted");
            if matches!(read, Read::Thread(policy) if policy.terminal()) {
                self.traffic.record("threadReads.terminalArchivedOrDeleted");
            }
        }
        match result {
            Ok(_) => {
                *self.socket.lock().expect("request socket") = Some(socket);
                self.retry.lock().expect("host retry").delay = T3_RETRY_DELAY;
            }
            Err(error) => {
                self.record_timeout(method, target, error);
                if matches!(
                    error,
                    HostError::Unavailable | HostError::Timeout | HostError::Protocol
                ) {
                    self.defer();
                }
            }
        }
        result
    }

    pub(crate) fn record_timeout(
        &self,
        method: &'static str,
        thread: Option<&str>,
        error: HostError,
    ) {
        if !matches!(error, HostError::Timeout) {
            return;
        }
        self.traffic.record("timeouts");
        if method == "orchestration.subscribeThread" {
            self.traffic.record("threadReads.timeouts");
        }
        let thread = thread.map_or("-", |id| {
            if id.len() <= 256
                && id
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || b":.-_%".contains(&ch))
            {
                id
            } else {
                "<redacted>"
            }
        });
        eprintln!("T3 {method} timed out (thread {thread})");
    }

    pub(crate) fn stream_failed(&self, method: &'static str, error: HostError) {
        self.record_timeout(method, None, error);
        if matches!(
            error,
            HostError::Unavailable | HostError::Timeout | HostError::Protocol
        ) {
            self.defer();
        }
    }

    pub(crate) async fn thread(
        &self,
        id: &str,
        policy: ThreadRead,
    ) -> Result<ThreadReply, HostError> {
        Ok(self.observe_thread(id, policy).await?.reply)
    }

    pub(crate) async fn observe_thread(
        &self,
        id: &str,
        policy: ThreadRead,
    ) -> Result<ThreadObservation, HostError> {
        let _admission = self
            .admission
            .enter(matches!(policy, ThreadRead::Exact) || policy.terminal())
            .await?;
        let before = {
            let mut snapshots = self.snapshots.lock().expect("thread snapshots");
            let fence = self.fence_at(id, snapshots.as_ref());
            if let Some(shell) = snapshots.as_mut() {
                if let Some(row) = fence.row.as_deref().filter(|row| closed_row(row)) {
                    let reply = ThreadReply::Closed {
                        row: row.clone(),
                        sequence: shell.revision(),
                    };
                    return Ok(ThreadObservation { reply, fence });
                }
                if !matches!(policy, ThreadRead::Exact)
                    && let Some(reply) = shell.get(id)
                {
                    return Ok(ThreadObservation {
                        reply: ThreadReply::Snapshot(reply),
                        fence,
                    });
                }
            }
            fence
        };
        self.check_thread_read(before.row.as_deref(), policy)?;
        let reply = Box::pin(self.call_locked(
            "orchestration.subscribeThread",
            json!({"threadId":id,"requestCompletionMarker":true,"acceptBoundedSnapshot":true,
                "acceptCompactTurnItems":true,"acceptDedupedBodies":true}),
            Read::Thread(policy),
            || {
                self.check_thread_read(self.thread_row(id).as_deref(), policy)
                    .map(|()| true)
            },
        ))
        .await?;
        let mut snapshots = self.snapshots.lock().expect("thread snapshots");
        let fence = self.fence_at(id, snapshots.as_ref());
        let same_marker = before.matches(&fence);
        let row = fence.row.as_deref();
        let reply = match reply {
            Reply::Value(value) => {
                let updated = value
                    .pointer("/projection/thread/updatedAt")
                    .and_then(Value::as_str);
                let expected = row.and_then(|row| row["updatedAt"].as_str());
                if (!same_marker && (expected.is_none() || updated != expected))
                    || matches!((updated.and_then(parse_native_time), expected.and_then(parse_native_time)),
                        (Some(updated), Some(expected)) if updated < expected)
                {
                    return Err(HostError::Uncertain);
                }
                if let Some(marker) = &fence.row
                    && let Some(shell) = snapshots.as_mut()
                {
                    shell.keep(id, marker, &value, policy);
                }
                ThreadReply::Snapshot(value)
            }
            Reply::Failure(cause) if crate::projection::missing_thread(&cause, id) => {
                if !same_marker || row.is_some() {
                    return Err(HostError::Uncertain);
                }
                ThreadReply::Missing
            }
            Reply::Failure(cause) => {
                eprintln!(
                    "{id}: T3 orchestration.subscribeThread: {:?}",
                    self.failure_detail(&cause)
                );
                return Err(HostError::Uncertain);
            }
        };
        Ok(ThreadObservation { reply, fence })
    }

    fn check_thread_read(&self, row: Option<&Value>, policy: ThreadRead) -> Result<(), HostError> {
        if row.is_some_and(closed_row)
            || (row.is_none()
                && self.uses_held_shell()
                && matches!(policy, ThreadRead::Terminal | ThreadRead::Inbox))
        {
            return Err(HostError::Uncertain);
        }
        Ok(())
    }

    pub(crate) fn use_held_shell(&self) {
        self.shell_managed.store(true, Ordering::Release);
    }

    pub(crate) fn uses_held_shell(&self) -> bool {
        self.shell_managed.load(Ordering::Acquire)
    }

    pub(crate) fn clear_shell(&self) {
        let mut view = self.snapshots.lock().expect("thread snapshots");
        *view = None;
        self.shell_epoch.fetch_add(1, Ordering::Relaxed);
        self.shell_changed.notify_one();
    }

    pub(crate) fn fence_at(&self, id: &str, shell: Option<&ThreadSnapshots>) -> ThreadFence {
        ThreadFence {
            row: shell.and_then(|shell| shell.marker(id)),
            row_revision: shell.and_then(|shell| shell.row_revision(id)),
            revision: (
                self.shell_epoch.load(Ordering::Relaxed),
                shell.and_then(ThreadSnapshots::revision),
            ),
        }
    }

    pub(crate) fn thread_row_with_revision(&self, id: &str) -> (Option<Arc<Value>>, Option<u64>) {
        self.with_shell(|shell| {
            shell.map_or((None, None), |shell| {
                (
                    shell.marker(id),
                    shell.row_revision(id).map(|(revision, _)| revision),
                )
            })
        })
    }

    pub(crate) fn row_children(
        &self,
        parent: &str,
        roles: &[&str],
    ) -> crate::task_row::RowChildren {
        use crate::task_row::RowChildren;
        self.with_shell(|shell| {
            shell.map_or(RowChildren::Unknown, |shell| {
                shell.row_children(parent, roles)
            })
        })
    }

    pub(crate) fn same_thread(&self, id: &str, fence: &ThreadFence) -> bool {
        self.with_shell(|shell| {
            (shell.is_some() || !self.uses_held_shell()) && self.fence_at(id, shell).matches(fence)
        })
    }

    pub(crate) fn claim_effect(&self, key: &str) -> bool {
        let mut effects = self.recent_effects.lock().expect("host effects");
        if effects.iter().any(|prior| prior == key) {
            return false;
        }
        if effects.len() == 64 {
            effects.pop_front();
        }
        effects.push_back(key.into());
        true
    }

    pub(crate) fn with_shell<T>(&self, read: impl FnOnce(Option<&ThreadSnapshots>) -> T) -> T {
        read(self.snapshots.lock().expect("thread snapshots").as_ref())
    }

    pub(crate) fn thread_row(&self, id: &str) -> Option<Arc<Value>> {
        self.with_shell(|shell| shell?.marker(id))
    }

    #[cfg(any(test, feature = "loopback-fixture"))]
    pub(crate) fn fixture_shell(&self, item: &Value) {
        self.fixture_shell_in(item, "fixture:same-server");
    }

    #[cfg(any(test, feature = "loopback-fixture"))]
    pub(crate) fn fixture_shell_in(&self, item: &Value, scope: &str) {
        let mut snapshots = self.snapshots.lock().expect("thread snapshots");
        if item["kind"] == "snapshot" {
            let mut shell = ThreadSnapshots::read(item).expect("fixture shell must be valid");
            shell.archive_scope = Some(scope.to_owned());
            *snapshots = Some(shell);
        } else {
            snapshots.as_mut().expect("fixture snapshot").update(item);
        }
    }

    pub(crate) async fn shell(&self, payload: Value) -> Result<Value, HostError> {
        if let Some(shell) = self.snapshots.lock().expect("thread snapshots").as_ref() {
            return Ok(shell.snapshot());
        }
        if self.uses_held_shell() {
            self.check_retry()?;
            return Err(HostError::Uncertain);
        }
        // Short-lived management commands have no service subscription.
        match self
            .call("orchestration.subscribeShell", payload, Read::Shell)
            .await?
        {
            Reply::Value(snapshot) => Ok(snapshot),
            Reply::Failure(_) => Err(HostError::Protocol),
        }
    }

    fn check_retry(&self) -> Result<(), HostError> {
        match self.retry_at() {
            Some(until) => Err(HostError::Deferred { until }),
            None => Ok(()),
        }
    }

    async fn archive_scope(
        &self,
        descriptor: Option<&Path>,
        opened_runtime: Option<&str>,
    ) -> Result<Option<String>, HostError> {
        if let Some(path) = descriptor {
            if let Some(runtime) = ServerRuntime::read(path, &self.base)
                && opened_runtime == Some(runtime.identity().as_str())
                && runtime.still_current(None).await
            {
                return Ok(Some(format!("t3:{}:{}", self.base, runtime.identity())));
            }
            // A descriptor may be temporarily unavailable while T3 starts.
            // Keep existing receipts until a synchronized runtime can qualify them.
            return Ok(None);
        }
        // Without a descriptor, a receipt can only use this continuously held stream.
        let mut bytes = [0; 16];
        getrandom::fill(&mut bytes).map_err(|_| HostError::Uncertain)?;
        Ok(Some(format!("shell:{:032x}", u128::from_ne_bytes(bytes))))
    }

    #[expect(
        clippy::too_many_lines,
        reason = "keep shell synchronization and its ordered deltas together"
    )]
    pub(crate) async fn watch_threads(
        &self,
        hints: &mpsc::Sender<ThreadHint>,
        inbox_thread: Option<&str>,
        runtime_descriptor: Option<&Path>,
    ) -> Result<(), HostError> {
        let opened_runtime = runtime_descriptor
            .and_then(|path| ServerRuntime::read(path, &self.base))
            .map(|server| server.identity());
        let admission = self.admission.enter(false).await?;
        let socket = self.open().await?;
        let mut connection = Connection { socket, next_id: 0 };
        self.check_retry()?;
        self.traffic.record("orchestration.subscribeShell");
        connection.send(json!({"_tag":"Request", "id":"1", "tag":"orchestration.subscribeShell", "headers":[],
            "payload":{"requestCompletionMarker":true}})).await?;
        drop(admission);
        let mut initial_snapshots = None;
        let expires = time::Instant::now() + Duration::from_mins(15);
        let synchronize_by = time::Instant::now() + DEADLINE;
        let mut synchronized = false;
        loop {
            if synchronized && time::Instant::now() >= expires {
                return Ok(());
            }
            let due = if synchronized {
                expires.min(time::Instant::now() + Duration::from_mins(5))
            } else {
                synchronize_by
            };
            let frames = match time::timeout_at(due, connection.frames()).await {
                Ok(result) => result?,
                Err(_) if synchronized && due == expires => return Ok(()),
                Err(_) => return Err(HostError::Timeout),
            };
            for frame in frames {
                match frame["_tag"].as_str() {
                    Some("Ping") => connection.send(json!({"_tag":"Pong"})).await?,
                    Some("Pong") => {}
                    Some("Chunk") if frame["requestId"] == "1" || frame["requestId"] == 1 => {
                        connection
                            .send(json!({"_tag":"Ack","requestId":"1"}))
                            .await?;
                        for item in frame["values"].as_array().ok_or(HostError::Protocol)? {
                            match item["kind"].as_str() {
                                Some("snapshot")
                                    if item.get("resolvedRepositoryIdentityRoots").is_none() =>
                                {
                                    if synchronized || initial_snapshots.is_some() {
                                        return Err(HostError::Protocol);
                                    }
                                    initial_snapshots = Some(
                                        ThreadSnapshots::read(item).ok_or(HostError::Protocol)?,
                                    );
                                }
                                Some("synchronized") => {
                                    if synchronized {
                                        continue;
                                    }
                                    let mut shell =
                                        initial_snapshots.take().ok_or(HostError::Protocol)?;
                                    shell.archive_scope = self
                                        .archive_scope(
                                            runtime_descriptor,
                                            opened_runtime.as_deref(),
                                        )
                                        .await?;
                                    *self.snapshots.lock().expect("thread snapshots") = Some(shell);
                                    synchronized = true;
                                }
                                Some("snapshot") => {}
                                Some("snapshot-required") => return Err(HostError::Uncertain),
                                Some(
                                    "thread.updated" | "thread.removed" | "project.updated"
                                    | "project.removed",
                                ) => {
                                    let applied = if let Some(shell) = initial_snapshots.as_mut() {
                                        update_shell(shell, item, inbox_thread)
                                    } else {
                                        self.snapshots
                                            .lock()
                                            .expect("thread snapshots")
                                            .as_mut()
                                            .is_some_and(|shell| {
                                                update_shell(shell, item, inbox_thread)
                                            })
                                    };
                                    if !applied {
                                        continue;
                                    }
                                }
                                _ => return Err(HostError::Protocol),
                            }
                            if item["kind"] == "synchronized"
                                && let Some(thread) = inbox_thread
                            {
                                hints
                                    .try_send(ThreadHint {
                                        thread: thread.into(),
                                        change: None,
                                        closed: false,
                                        running: false,
                                        identity: None,
                                        inbox_synchronized: true,
                                        parent_thread: None,
                                    })
                                    .map_err(|_| HostError::Uncertain)?;
                            }
                            self.shell_changed.notify_one();
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

    /// Follow the server config stream and publish the board theme inputs
    /// whenever a config event changes them.
    pub(crate) async fn watch_theme(
        &self,
        theme: &tokio::sync::watch::Sender<Option<Value>>,
    ) -> Result<(), HostError> {
        let admission = self.admission.enter(false).await?;
        let socket = self.open().await?;
        let mut connection = Connection { socket, next_id: 0 };
        self.check_retry()?;
        self.traffic.record("subscribeServerConfig");
        connection
            .send(
                json!({"_tag":"Request", "id":"1", "tag":"subscribeServerConfig", "headers":[],
            "payload":{"environmentThemes":true,"workspaceSnapshotsOnDemand":true}}),
            )
            .await?;
        drop(admission);
        let mut tracker = crate::theme::ThemeTracker::default();
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
                        let mut changed = false;
                        for item in frame["values"].as_array().ok_or(HostError::Protocol)? {
                            if self.catalog.lock().expect("provider catalog").apply(item) {
                                self.catalog_changes.send_replace(());
                            }
                            changed |= tracker.apply(item);
                        }
                        if changed {
                            let next = tracker.snapshot();
                            theme.send_if_modified(|current| {
                                let modified = current.as_ref() != Some(&next);
                                if modified {
                                    *current = Some(next);
                                }
                                modified
                            });
                        }
                    }
                    _ => return Err(HostError::Protocol),
                }
            }
        }
    }

    async fn open(&self) -> Result<Socket, HostError> {
        self.check_retry()?;
        let result = time::timeout(DEADLINE, self.connect())
            .await
            .unwrap_or(Err(HostError::Timeout));
        if matches!(
            result,
            Err(HostError::Unavailable | HostError::Timeout | HostError::Protocol)
        ) {
            self.defer();
        }
        result
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
        self.traffic.record("auth.websocketTicket");
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
        self.traffic.record("websocket.upgrade");
        let (socket, _) = connect_async_with_config(url.as_str(), Some(config), false)
            .await
            .map_err(|_| HostError::Unavailable)?;
        Ok(socket)
    }
}

fn update_shell(shell: &mut ThreadSnapshots, item: &Value, inbox: Option<&str>) -> bool {
    let duplicate_inbox = inbox.is_some_and(|id| {
        item["kind"] == "thread.updated"
            && item["thread"]["id"] == id
            && shell
                .marker(id)
                .is_some_and(|prior| *prior == item["thread"])
    });
    shell.update(item) && !duplicate_inbox
}

pub(crate) fn closed_row(row: &Value) -> bool {
    !row["archivedAt"].is_null() || !row["deletedAt"].is_null()
}

fn parse_native_time(value: &str) -> Option<::time::OffsetDateTime> {
    ::time::OffsetDateTime::parse(value, &::time::format_description::well_known::Rfc3339).ok()
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
                    "Exit"
                        if frame["exit"]["_tag"] == "Success"
                            && matches!(read, Read::One | Read::Background) =>
                    {
                        return Ok(Reply::Value(frame["exit"]["value"].clone()));
                    }
                    "Chunk" if matches!(read, Read::Shell | Read::Thread(_)) => {
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
        assert!(!ThreadHint::read(&revised).expect("completed hint").closed());
        revised["thread"]["archivedAt"] = json!("2026-11-23T20:00:01Z");
        assert!(ThreadHint::read(&revised).expect("archived hint").closed());
    }

    #[test]
    fn a_thread_move_revokes_authority_but_activity_does_not() {
        let mut update = json!({"kind":"thread.updated","location":"active","thread":{
            "id":"planner","projectId":"project","providerInstanceId":"fixture",
            "status":"running","activeRunId":"turn"
        }});
        let prior = ThreadHint::read(&update).expect("planner event");
        assert!(prior.running());
        update["thread"]["status"] = json!("idle");
        let idle = ThreadHint::read(&update).expect("idle event");
        assert!(!idle.running());
        assert!(!idle.is_identity_change(prior.identity.as_ref()));
        update["thread"]["projectId"] = json!("moved");
        let moved = ThreadHint::read(&update).expect("project move");
        assert!(moved.is_identity_change(prior.identity.as_ref()));
    }

    #[tokio::test]
    async fn a_transport_failure_defers_other_rpc_calls() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listen");
        let address = listener.local_addr().expect("endpoint");
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.expect("request");
                let mut request = [0; 1024];
                assert!(stream.read(&mut request).await.expect("ticket request") > 0);
                stream
                    .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                    .await
                    .expect("reply");
            }
        });
        let rpc = Rpc::new(&format!("http://{address}"), "fixture").expect("client");
        assert!(matches!(
            rpc.call("server.getConfig", json!({}), Read::One).await,
            Err(HostError::Unavailable)
        ));
        let due = rpc.retry_at().expect("one shared deadline");
        let (hints, _) = mpsc::channel(1);
        let theme = tokio::sync::watch::channel(None).0;
        assert!(
            matches!(rpc.watch_threads(&hints, None, None).await, Err(HostError::Deferred { until }) if until == due)
        );
        assert!(
            matches!(rpc.watch_theme(&theme).await, Err(HostError::Deferred { until }) if until == due)
        );
        assert!(
            matches!(rpc.thread("row", ThreadRead::Observation).await, Err(HostError::Deferred { until }) if until == due)
        );
        assert!(
            matches!(rpc.call("orchestration.dispatchCommand", json!({}), Read::One).await, Err(HostError::Deferred { until }) if until == due)
        );
        assert_eq!(
            rpc.traffic.totals().into_iter().collect::<Vec<_>>(),
            [("auth.websocketTicket", 1)]
        );

        rpc.retry.lock().expect("host retry").until = time::Instant::now();
        assert!(matches!(
            rpc.call("server.getConfig", json!({}), Read::One).await,
            Err(HostError::Unavailable)
        ));
        assert_eq!(rpc.traffic.totals()["auth.websocketTicket"], 2);
        assert!(rpc.retry_at().expect("second deadline") > time::Instant::now() + T3_RETRY_DELAY);
        server.await.expect("server");
    }
}
