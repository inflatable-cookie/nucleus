//! The model-free Nucleus ACP agent. Stdio is reserved for ACP frames.

mod client;
mod inbox;
mod presentation;

use std::{collections::BTreeMap, env, io, path::PathBuf, sync::Arc, time::Duration};

use client::{Failure, ServiceClient};
use nucleus_core::acp::SessionBinding;
use presentation::Presentation;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter},
    sync::{Mutex, mpsc},
    task::JoinHandle,
};

const MODELS: [&str; 2] = ["nucleus", "nucleus-quiet"];
type Output = mpsc::UnboundedSender<Value>;

struct Agent {
    output: Output,
    launch_cwd: Option<PathBuf>,
    sessions: BTreeMap<String, Session>,
    model: &'static str,
    structured: bool,
}

struct Session {
    client: Option<ServiceClient>,
    cwd: PathBuf,
    view: Arc<Mutex<Presentation>>,
    structured: bool,
    turn: Option<Turn>,
}

struct Turn {
    id: Value,
    job: JoinHandle<()>,
    replies: Option<Arc<inbox::Replies>>,
}

impl Drop for Turn {
    fn drop(&mut self) {
        self.job.abort();
    }
}

/// Serve the Nucleus ACP protocol on standard input and output.
///
/// # Errors
/// Returns an error when startup, binding validation or stdio fails.
pub async fn run() -> io::Result<()> {
    let launch_cwd = env::current_dir().ok();
    if let Some(workspace) = &launch_cwd
        && let Ok(SessionBinding::Task(binding)) = client::binding(workspace)
        && let Some(scratch) = binding.scratch_dir
    {
        client::enter_scratch(workspace, &scratch).map_err(io::Error::other)?;
    }
    let (output, mut frames) = mpsc::unbounded_channel();
    let mut writer = tokio::spawn(async move {
        let mut stdout = BufWriter::new(tokio::io::stdout());
        while let Some(frame) = frames.recv().await {
            let mut bytes = serde_json::to_vec(&frame).map_err(io::Error::other)?;
            bytes.push(b'\n');
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
        Ok::<_, io::Error>(())
    });
    let mut agent = Agent {
        output,
        launch_cwd,
        sessions: BTreeMap::new(),
        model: MODELS[0],
        structured: env::var("NUCLEUS_ACP_TEXT_FALLBACK").as_deref() != Ok("1"),
    };
    let input = async {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Some(line) = lines.next_line().await? {
            if !line.trim().is_empty() {
                agent.receive(&line).await;
            }
        }
        Ok::<_, io::Error>(())
    };
    tokio::select! {
        biased;
        written = &mut writer => return written.map_err(io::Error::other)?,
        read = input => read?,
    }
    drop(agent);
    writer.await.map_err(io::Error::other)?
}

impl Agent {
    async fn receive(&mut self, line: &str) {
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            error(&self.output, &Value::Null, -32700, "Invalid JSON.");
            return;
        };
        let method = frame["method"].as_str();
        if frame["jsonrpc"] == "2.0"
            && method.is_none()
            && let Some(session_id) = inbox::response_session(&frame)
        {
            if let Some(replies) = self
                .sessions
                .get(session_id)
                .and_then(|session| session.turn.as_ref())
                .and_then(|turn| turn.replies.as_ref())
            {
                replies.receive(&frame).await;
            }
            return;
        }
        if frame["jsonrpc"] != "2.0"
            || method.is_none()
            || frame
                .get("id")
                .is_some_and(|id| !id.is_string() && !id.is_number() && !id.is_null())
        {
            error(&self.output, &Value::Null, -32600, "Invalid ACP request.");
            return;
        }
        let method = method.expect("checked method");
        let params = &frame["params"];
        let session_id = params["sessionId"].as_str().unwrap_or_default();
        if method == "session/cancel" {
            if let Some(session) = self.sessions.get_mut(session_id)
                && let Some(mut turn) = session.turn.take()
            {
                turn.job.abort();
                if (&mut turn.job)
                    .await
                    .is_err_and(|error| error.is_cancelled())
                {
                    stop(&self.output, &turn.id, "cancelled");
                }
            }
            return;
        }
        let Some(id) = frame.get("id") else {
            return;
        };
        match method {
            "initialize" => self.initialize(id, params),
            "authenticate" => result(&self.output, id, json!({})),
            "session/new" | "session/load" => {
                if let Err(failure) = self.open(id, params, method == "session/load").await {
                    error(&self.output, id, -32000, &failure.to_string());
                }
            }
            "session/set_model" => {
                if let Some(model) = MODELS.into_iter().find(|model| params["modelId"] == *model) {
                    self.model = model;
                    result(&self.output, id, json!({}));
                } else {
                    error(&self.output, id, -32602, "Unknown Nucleus model label.");
                }
            }
            "session/prompt" => self.prompt(id, session_id, params),
            _ => error(&self.output, id, -32601, "ACP method is unavailable."),
        }
    }

    fn initialize(&mut self, id: &Value, params: &Value) {
        self.structured &= structured(&params["clientCapabilities"]) && structured(params);
        result(
            &self.output,
            id,
            json!({
                "protocolVersion":1,
                "agentCapabilities":{"loadSession":true},
                "agentInfo":{"name":"nucleus","title":"Nucleus","version":env!("CARGO_PKG_VERSION")},
                "authMethods":[]
            }),
        );
    }

    async fn open(&mut self, id: &Value, params: &Value, loading: bool) -> Result<(), Failure> {
        let cwd = params["cwd"]
            .as_str()
            .map(PathBuf::from)
            .or_else(|| self.launch_cwd.clone())
            .ok_or(Failure::Binding)?;
        let (session_id, client) = match client::binding(&cwd) {
            Ok(binding) => {
                if loading && params["sessionId"] != binding.id() {
                    return Err(Failure::Binding);
                }
                (binding.id().to_owned(), Some(ServiceClient::new(&binding)?))
            }
            Err(Failure::Missing) if !loading => {
                let mut random = [0; 16];
                getrandom::fill(&mut random).map_err(|_| Failure::Binding)?;
                (format!("unbound-{}", hex::encode(random)), None)
            }
            Err(error) => return Err(error),
        };
        if self
            .sessions
            .get(&session_id)
            .is_some_and(Session::in_flight)
        {
            return Err(Failure::Refused(
                "This session already has a prompt in progress.".into(),
            ));
        }
        let structured = self.structured && structured(params);
        let mut view = Presentation::default();
        let updates = if let Some(client) = &client {
            if client.is_inbox() {
                client.inbox().await?;
                Vec::new()
            } else {
                let detail = attach(client).await?;
                view.update(&detail, structured, false)
            }
        } else {
            Vec::new()
        };
        self.sessions.insert(
            session_id.clone(),
            Session {
                client,
                cwd,
                view: Arc::new(Mutex::new(view)),
                structured,
                turn: None,
            },
        );
        result(
            &self.output,
            id,
            json!({
                "sessionId":session_id,
                "models":{"currentModelId":self.model,"availableModels":[
                    {"modelId":"nucleus","name":"Nucleus"},{"modelId":"nucleus-quiet","name":"Nucleus Quiet"}
                ]}
            }),
        );
        for update in updates {
            notify(&self.output, &session_id, update);
        }
        Ok(())
    }

    fn prompt(&mut self, id: &Value, session_id: &str, params: &Value) {
        let Some(session) = self.sessions.get_mut(session_id) else {
            error(&self.output, id, -32602, "The Nucleus session is unknown.");
            return;
        };
        let Some(mut client) = session.client.clone() else {
            error(
                &self.output,
                id,
                -32000,
                "Open a task with a binding minted by Nucleus.",
            );
            return;
        };
        if session.in_flight() {
            error(
                &self.output,
                id,
                -32602,
                "This session already has a prompt in progress.",
            );
            return;
        }
        if client.is_inbox() {
            let ui = prompt_text(&params["prompt"]) == "ui";
            session.turn = Some(inbox::prompt(client, &self.output, session_id, id, ui));
            return;
        }
        let prompt = prompt_text(&params["prompt"]);
        let view = Arc::clone(&session.view);
        let structured = session.structured;
        let cwd = session.cwd.clone();
        let output = self.output.clone();
        let session_id = session_id.to_owned();
        let request = id.clone();
        let job = tokio::spawn(async move {
            if let Err(failure) = task_prompt(
                &mut client,
                &view,
                &output,
                &session_id,
                structured,
                operator_text(&prompt),
                &cwd,
            )
            .await
            {
                error(&output, &request, -32000, &failure.to_string());
                return;
            }
            stop(&output, &request, "end_turn");
        });
        session.turn = Some(Turn {
            id: id.clone(),
            job,
            replies: None,
        });
    }
}

impl Session {
    fn in_flight(&self) -> bool {
        self.turn
            .as_ref()
            .is_some_and(|turn| !turn.job.is_finished())
    }
}

async fn attach(client: &ServiceClient) -> Result<client::Detail, Failure> {
    for delay in [0, 1, 2, 4, 8, 15] {
        if delay > 0 {
            tokio::time::sleep(Duration::from_secs(delay)).await;
        }
        match client.detail().await {
            Err(Failure::Unavailable) => {}
            result => return result,
        }
    }
    Err(Failure::Unavailable)
}

async fn task_prompt(
    client: &mut ServiceClient,
    view: &Mutex<Presentation>,
    output: &Output,
    session: &str,
    structured: bool,
    prompt: &str,
    cwd: &std::path::Path,
) -> Result<(), Failure> {
    // T3 ACP supplies text without authenticated author metadata. Its only
    // special text is a read-only hold bound to a recorded preparation.
    if matches!(client.renew_task_reader(cwd, session), Ok(false)) {
        return Ok(());
    }
    let detail = client.detail().await?;
    let hold = !detail.phase.is_terminal() && detail.parent_hold.as_deref() == Some(prompt);
    let updates = {
        let mut view = view.lock().await;
        let replay = !std::mem::replace(&mut view.prompt_seen, true);
        view.update(&detail, structured, replay)
    };
    for update in updates {
        notify(output, session, update);
    }
    if !hold {
        return Ok(());
    }
    let mut delay = 1;
    loop {
        let result = async {
            let mut stream = client.stream().await?;
            loop {
                stream.next().await?;
                let detail = client.detail().await?;
                let hold = !detail.phase.is_terminal()
                    && (detail.parent_hold.as_deref() == Some(prompt) || detail.active_child);
                for update in view.lock().await.update(&detail, structured, false) {
                    notify(output, session, update);
                }
                if !hold {
                    return Ok(());
                }
                delay = 1;
            }
        }
        .await;
        match result {
            Err(error @ (Failure::Unavailable | Failure::Unauthorized | Failure::Refused(_))) => {
                if matches!(error, Failure::Unauthorized)
                    && matches!(client.renew_task_reader(cwd, session), Ok(false))
                {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_secs(delay)).await;
                delay = (delay * 2).min(30);
            }
            result => return result,
        }
    }
}

fn prompt_text(prompt: &Value) -> String {
    if let Some(text) = prompt.as_str() {
        return text.to_owned();
    }
    prompt
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn operator_text(text: &str) -> &str {
    text.rsplit_once("</user_request>")
        .and_then(|(before, _)| before.rsplit_once("<user_request>"))
        .map_or(text, |(_, request)| request)
        .trim()
}

fn structured(params: &Value) -> bool {
    ["structuredUpdates", "plan", "toolCalls"]
        .iter()
        .all(|key| params[*key] != false)
        && params["_meta"]["structuredUpdates"] != false
}

fn notify(output: &Output, session: &str, update: Value) {
    let mut frame =
        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session}});
    frame["params"]["update"] = update;
    let _ = output.send(frame);
}

fn result(output: &Output, id: &Value, value: Value) {
    let mut frame = json!({"jsonrpc":"2.0","id":id});
    frame["result"] = value;
    let _ = output.send(frame);
}

fn error(output: &Output, id: &Value, code: i32, message: &str) {
    let _ = output.send(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}));
}

fn stop(output: &Output, id: &Value, reason: &str) {
    result(output, id, json!({"stopReason":reason}));
}
