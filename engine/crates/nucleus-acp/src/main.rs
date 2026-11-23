//! The model-free Nucleus ACP agent. Stdio is reserved for ACP frames.

mod client;
mod presentation;

use std::{collections::BTreeMap, env, io, path::PathBuf, sync::Arc, time::Duration};

use client::{Failure, ServiceClient};
use nucleus_core::{Answer, Command};
use presentation::{Presentation, message};
use regex::Regex;
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
    sessions: BTreeMap<String, Session>,
    model: &'static str,
    structured: bool,
    ignore: Option<Regex>,
    hold: Option<Regex>,
}

struct Session {
    client: Option<ServiceClient>,
    view: Arc<Mutex<Presentation>>,
    structured: bool,
    prompted: bool,
    turn: Option<Turn>,
}

struct Turn {
    id: Value,
    job: JoinHandle<()>,
}

impl Drop for Turn {
    fn drop(&mut self) {
        self.job.abort();
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
    let (output, mut frames) = mpsc::unbounded_channel();
    let writer = tokio::spawn(async move {
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
        sessions: BTreeMap::new(),
        model: MODELS[0],
        structured: env::var("NUCLEUS_ACP_TEXT_FALLBACK").as_deref() != Ok("1"),
        ignore: pattern("NUCLEUS_ACP_IGNORE_PATTERN")?,
        hold: pattern("NUCLEUS_ACP_HOLD_PATTERN")?,
    };
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if !line.trim().is_empty() {
            agent.receive(&line).await;
        }
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
            .or_else(|| env::current_dir().ok())
            .ok_or(Failure::Binding)?;
        let (session_id, client) = match client::binding(&cwd) {
            Ok(binding) => {
                if loading && params["sessionId"] != binding.session_id {
                    return Err(Failure::Binding);
                }
                (
                    binding.session_id.clone(),
                    Some(ServiceClient::new(&binding)?),
                )
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
            let (detail, history) = attach(client).await?;
            view.update(detail, history, structured)
        } else {
            Vec::new()
        };
        self.sessions.insert(
            session_id.clone(),
            Session {
                client,
                view: Arc::new(Mutex::new(view)),
                structured,
                prompted: loading,
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
        let Some(client) = session.client.clone() else {
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
        let prompt = prompt_text(&params["prompt"]);
        let opening = !std::mem::replace(&mut session.prompted, true);
        if self
            .ignore
            .as_ref()
            .is_some_and(|pattern| pattern.is_match(prompt.trim()))
        {
            stop(&self.output, id, "end_turn");
            return;
        }
        let command = if opening
            || self
                .hold
                .as_ref()
                .is_some_and(|pattern| pattern.is_match(prompt.trim()))
        {
            None
        } else {
            let Some(command) = parse_command(operator_text(&prompt)) else {
                error(
                    &self.output,
                    id,
                    -32602,
                    "Use a task command such as move, answer, cancel, amend, hold or release.",
                );
                return;
            };
            Some(command)
        };
        let view = Arc::clone(&session.view);
        let structured = session.structured;
        let output = self.output.clone();
        let session_id = session_id.to_owned();
        let request = id.clone();
        let job = tokio::spawn(async move {
            if let Some(command) = command {
                match client.command(&command).await {
                    Ok(true) => {}
                    Ok(false) => notify(
                        &output,
                        &session_id,
                        message("Nucleus is checking the evidence for that command."),
                    ),
                    Err(failure) => {
                        error(&output, &request, -32000, &failure.to_string());
                        return;
                    }
                }
            }
            if let Err(failure) = follow(&client, &view, &output, &session_id, structured).await {
                error(&output, &request, -32000, &failure.to_string());
                return;
            }
            stop(&output, &request, "end_turn");
        });
        session.turn = Some(Turn {
            id: id.clone(),
            job,
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

async fn attach(client: &ServiceClient) -> Result<(client::Detail, Vec<client::Event>), Failure> {
    for delay in [0, 1, 2, 4, 8, 15] {
        if delay > 0 {
            tokio::time::sleep(Duration::from_secs(delay)).await;
        }
        match snapshot(client, 0).await {
            Err(Failure::Unavailable) => {}
            result => return result,
        }
    }
    Err(Failure::Unavailable)
}

async fn snapshot(
    client: &ServiceClient,
    cursor: i64,
) -> Result<(client::Detail, Vec<client::Event>), Failure> {
    let history = client.history(cursor).await?;
    let detail = client.detail().await?;
    Ok((detail, history))
}

async fn follow(
    client: &ServiceClient,
    view: &Mutex<Presentation>,
    output: &Output,
    session: &str,
    structured: bool,
) -> Result<(), Failure> {
    let mut delay = 1;
    loop {
        let result = async {
            let mut stream = client.stream().await?;
            loop {
                stream.next().await?;
                let cursor = view.lock().await.cursor;
                let (detail, history) = snapshot(client, cursor).await?;
                let finished = detail.phase.is_terminal();
                for update in view.lock().await.update(detail, history, structured) {
                    notify(output, session, update);
                }
                if finished {
                    return Ok(());
                }
                delay = 1;
            }
        }
        .await;
        match result {
            Err(Failure::Unavailable) => {
                tokio::time::sleep(Duration::from_secs(delay)).await;
                delay = (delay * 2).min(30);
            }
            result => return result,
        }
    }
}

fn parse_command(text: &str) -> Option<Command> {
    let (verb, rest) = text
        .split_once(char::is_whitespace)
        .map_or((text, ""), |(verb, rest)| (verb, rest.trim()));
    match verb {
        "cancel" if rest.is_empty() => Some(Command::Cancel),
        "release" if rest.is_empty() => Some(Command::Release),
        "move" => serde_json::from_value(json!(rest)).ok().map(Command::Move),
        "hold" if !rest.is_empty() => Some(Command::Hold(rest.into())),
        "amend" if !rest.is_empty() => Some(Command::Amend(rest.into())),
        "answer" if rest == "retry" => Some(Command::Answer(Answer::Retry)),
        "answer" => {
            let (kind, body) = rest.split_once(char::is_whitespace)?;
            let body = body.trim();
            match kind {
                "work" if !body.is_empty() => Some(Command::Answer(Answer::Work(body.into()))),
                "accept" => {
                    let (head, reason) = body.split_once(char::is_whitespace)?;
                    Some(Command::Answer(Answer::Accept {
                        head: head.parse().ok()?,
                        reason: reason.trim().into(),
                    }))
                }
                _ => None,
            }
        }
        _ => None,
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

fn pattern(key: &str) -> io::Result<Option<Regex>> {
    env::var(key)
        .ok()
        .map(|value| {
            Regex::new(&value).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "Invalid ACP prompt pattern.")
            })
        })
        .transpose()
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
